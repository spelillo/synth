// Vercel Serverless Function — proxies chat requests to Groq.
// Replaces the local proxy-server.py when Synth is deployed.
//
// Set GROQ_API_KEY in your Vercel project's Environment Variables
// (Project Settings -> Environment Variables). Never commit a real
// key into this file.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
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
