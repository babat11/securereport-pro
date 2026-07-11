export default async function handler(req, res) {
  // A05 — Security Headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // A05 — CORS: restrict to your own domain only (not wildcard)
  const allowedOrigins = [
    'https://securereport-pro.vercel.app',
    'http://localhost:3000', // dev only
  ];
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method Not Allowed' } });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'API key not configured on server.' } });
  }

  // A01 — Request size validation: reject oversized payloads (max 1MB)
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > 1_000_000) {
    return res.status(413).json({ error: { message: 'Request too large.' } });
  }

  // A01 — Validate request body structure before forwarding
  const body = req.body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return res.status(400).json({ error: { message: 'Invalid request body.' } });
  }

  // A01 — Model whitelist: only Qwen3-Coder accepted from client
  // Silent fallback to openrouter/free handled server-side if Qwen3 unavailable
  const ALLOWED_MODELS = [
    'qwen/qwen3-coder:free',
    'qwen/qwen3-coder',
  ];
  const requestedModel = body.model || 'qwen/qwen3-coder:free';
  if (!ALLOWED_MODELS.includes(requestedModel)) {
    return res.status(400).json({ error: { message: 'Model not permitted.' } });
  }

  // Silent fallback — try Qwen3-Coder first, fall back to openrouter/free
  // Users never see which model ran — consistent experience guaranteed
  const modelsToTry = [
    'qwen/qwen3-coder:free',
    'openrouter/free', // silent fallback — never exposed to UI
  ];

  // A01 — Cap max_tokens to prevent abuse
  if (body.max_tokens && body.max_tokens > 16000) {
    body.max_tokens = 16000;
  }

  // Try each model in order — silent fallback, user never knows
  let lastError = null;
  for (const model of modelsToTry) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://securereport-pro.vercel.app',
          'X-Title': 'SecureReport Pro',
        },
        body: JSON.stringify({ ...body, model }),
      });

      const data = await response.json();

      // If model unavailable or rate limited, try next
      if (response.status === 429 || response.status === 503 ||
          data?.error?.code === 'model_not_found' ||
          data?.error?.message?.toLowerCase().includes('unavailable')) {
        console.warn(`[SecureReport] Model ${model} unavailable, trying fallback...`);
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
      console.error(`[SecureReport] Model ${model} error:`, err.message);
      lastError = err.message;
      continue;
    }
  }

  // All models failed
  console.error('[SecureReport] All models failed. Last error:', lastError);
  return res.status(503).json({ error: { message: 'Service temporarily unavailable. Please try again.' } });
}
