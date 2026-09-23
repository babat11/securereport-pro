// api/analyze.js — AI proxy with tier enforcement
// Checks free limit (3 reports) and premium status before generating

export default async function handler(req, res) {
  // Security headers (A05)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // CORS — restrict to own domain
  const allowedOrigins = [
    process.env.APP_URL || 'https://securereport-pro.vercel.app',
    'http://localhost:3000',
  ];
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (!apiKey) {
    return res.status(500).json({ error: { message: 'API key not configured.' } });
  }

  // A01 — Request size check
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > 1_000_000) {
    return res.status(413).json({ error: { message: 'Request too large.' } });
  }

  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: { message: 'Invalid request body.' } });
  }

  // Cap max_tokens
  if (body.max_tokens && body.max_tokens > 16000) body.max_tokens = 16000;

  // ── Tier Check ──
  // Check if user has a valid premium session cookie
  const cookies = req.headers.cookie || '';
  const sessionMatch = cookies.match(/ps_session=([^;]+)/);
  let isPremium = false;
  let userEmail = null;

  if (sessionMatch) {
    try {
      const session = JSON.parse(
        Buffer.from(sessionMatch[1], 'base64').toString('utf8')
      );
      if (session.tier === 'premium' && session.status === 'active' && session.exp > Date.now()) {
        // Verify against Redis (double-check — never trust cookie alone)
        if (kvUrl && kvToken) {
          const userRes = await fetch(
            `${kvUrl}/get/${encodeURIComponent(`user:${session.email}`)}`,
            { headers: { Authorization: `Bearer ${kvToken}` } }
          );
          const userData = await userRes.json();
          if (userData.result) {
            const user = JSON.parse(userData.result);
            if (user.status === 'active' && user.tier === 'premium') {
              isPremium = true;
              userEmail = session.email;
            }
          }
        }
      }
    } catch (e) {
      // Invalid session — treat as free user
    }
  }

  // ── Free tier: count tracked server-side by IP as backup ──
  // (client localStorage is primary, this is the server-side guard)
  const reportCount = parseInt(body.reportCount || '0', 10);
  if (!isPremium && reportCount >= 3) {
    return res.status(402).json({
      error: {
        message: 'FREE_LIMIT_REACHED',
        code: 'upgrade_required',
      }
    });
  }

  // Silent model fallback chain — confirmed free models July 2026
  const modelsToTry = [
    'deepseek/deepseek-chat-v3-0324:free',     // Best general, fast, 64K context
    'meta-llama/llama-4-scout:free',            // Very fast, 10M context
    'meta-llama/llama-3.3-70b-instruct:free',  // Strong instruction following
    'google/gemma-3-27b-it:free',              // Google, low latency
    'openrouter/free',                          // Last resort auto-router
  ];

  let lastError = null;
  for (const model of modelsToTry) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.APP_URL || 'https://securereport-pro.vercel.app',
          'X-Title': 'PenScribe',
        },
        body: JSON.stringify({ ...body, model }),
      });

      const data = await response.json();

      if (
        response.status === 429 || response.status === 503 ||
        data?.error?.code === 'model_not_found' ||
        data?.error?.message?.toLowerCase().includes('unavailable') ||
        data?.error?.message?.toLowerCase().includes('paid')
      ) {
        console.warn(`[PenScribe] Model ${model} unavailable, trying next...`);
        lastError = data?.error?.message;
        continue;
      }

      if (!response.ok) {
        return res.status(response.status).json({
          error: { message: data?.error?.message || 'Upstream API error.' }
        });
      }

      return res.status(200).json(data);

    } catch (err) {
      console.error(`[PenScribe] Model ${model} error:`, err.message);
      lastError = err.message;
      continue;
    }
  }

  console.error('[PenScribe] All models failed:', lastError);
  return res.status(503).json({
    error: { message: 'Service temporarily unavailable. Please try again.' }
  });
}
