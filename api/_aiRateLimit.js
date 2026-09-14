// Shared helper: enforces the AI chat rate limit described in
// AI_RATE_LIMIT_SPEC.md. Not itself a route — no default export, so Vercel
// doesn't turn it into an endpoint, only bundles it for api/chat.js.

import { createClient } from '@supabase/supabase-js';

let cachedClient;

function getSupabaseAdmin() {
  if (cachedClient !== undefined) return cachedClient;
  cachedClient = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;
  return cachedClient;
}

const BURST_LIMIT = 15;
const BURST_WINDOW_MINUTES = 5;
const DAILY_LIMIT_FREE = 60;
const DAILY_LIMIT_PREMIUM = 300;

// Checks both limits and, if the request is allowed, records it in the same
// call — callers should treat a rejected result as "don't forward to Groq."
// Known, accepted gap: the check-then-insert isn't atomic, so two requests
// landing within milliseconds of each other could both slip through and
// overshoot the limit by one. Not worth a transaction/advisory lock at this
// traffic level — see AI_RATE_LIMIT_SPEC.md.
export async function checkAndRecordAiUsage(userId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) return { allowed: true }; // fail open if Supabase isn't configured — chat still works, just unmetered

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_premium')
    .eq('id', userId)
    .maybeSingle();
  const dailyLimit = profile?.is_premium ? DAILY_LIMIT_PREMIUM : DAILY_LIMIT_FREE;

  const now = Date.now();
  const burstSince = new Date(now - BURST_WINDOW_MINUTES * 60_000).toISOString();
  const daySince = new Date(now - 24 * 60 * 60_000).toISOString();

  const { count: burstCount } = await supabase
    .from('ai_usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', burstSince);
  if (burstCount >= BURST_LIMIT) {
    return { allowed: false, message: "You're sending messages faster than the assistant can keep up. Wait a few minutes and try again." };
  }

  const { count: dailyCount } = await supabase
    .from('ai_usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', daySince);
  if (dailyCount >= dailyLimit) {
    return {
      allowed: false,
      message: profile?.is_premium
        ? "You've used today's AI messages. It resets on a rolling basis, so try again in a bit."
        : "You've used today's AI messages. Go Premium for a lot more room, or come back tomorrow."
    };
  }

  await supabase.from('ai_usage_events').insert({ user_id: userId });
  return { allowed: true };
}
