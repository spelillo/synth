// Vercel Serverless Function — proxies chat requests to Groq.
// Replaces the local proxy-server.py when Synth is deployed.
//
// Set GROQ_API_KEY in your Vercel project's Environment Variables
// (Project Settings -> Environment Variables). Never commit a real
// key into this file.

import { getVerifiedUserId } from './_supabaseAuth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  // This forwards to a metered third-party API paid for by the site, so it
  // can no longer be left open to anyone who finds the URL — only a
  // signed-in Synth user can use it.
  const userId = await getVerifiedUserId(req);
  if (!userId) {
    res.status(401).json({ error: { message: 'Sign in required to use the AI assistant' } });
    return;
  }

  if (!Array.isArray(req.body?.messages)) {
    res.status(400).json({ error: { message: 'Request body must include a messages array' } });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'GROQ_API_KEY is not configured on the server' } });
    return;
  }

  try {
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(req.body)
    });

    const data = await groqResponse.text();
    res.status(groqResponse.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
}
