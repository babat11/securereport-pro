// api/verify.js — Validates magic link token and sets session

export default async function handler(req, res) {
  const { token } = req.query;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const appUrl = process.env.APP_URL || 'https://securereport-pro.vercel.app';

  if (!token) {
    return res.redirect(`${appUrl}/login?error=missing_token`);
  }

  if (!kvUrl || !kvToken) {
    return res.redirect(`${appUrl}/login?error=server_error`);
  }

  try {
    // Get token from Redis
    const tokenRes = await fetch(
      `${kvUrl}/get/${encodeURIComponent(`token:${token}`)}`,
      { headers: { Authorization: `Bearer ${kvToken}` } }
    );
    const tokenData = await tokenRes.json();

    if (!tokenData.result) {
      return res.redirect(`${appUrl}/login?error=invalid_token`);
    }

    const { email, expires } = JSON.parse(tokenData.result);

    // Check expiry
    if (Date.now() > expires) {
      return res.redirect(`${appUrl}/login?error=expired_token`);
    }

    // Get user data from Redis
    const userRes = await fetch(
      `${kvUrl}/get/${encodeURIComponent(`user:${email}`)}`,
      { headers: { Authorization: `Bearer ${kvToken}` } }
    );
    const userData = await userRes.json();
    const user = userData.result ? JSON.parse(userData.result) : null;

    // Delete used token (one-time use)
    await fetch(
      `${kvUrl}/del/${encodeURIComponent(`token:${token}`)}`,
      { headers: { Authorization: `Bearer ${kvToken}` } }
    );

    if (!user || user.status !== 'active') {
      return res.redirect(`${appUrl}/login?error=no_subscription`);
    }

    // Create session token
    const sessionToken = Buffer.from(JSON.stringify({
      email: user.email,
      tier: user.tier,
      status: user.status,
      exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    })).toString('base64');

    // Set secure session cookie
    res.setHeader('Set-Cookie', [
      `ps_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}`,
    ]);

    // Redirect to app with session
    return res.redirect(`${appUrl}/app?verified=true`);

  } catch (err) {
    console.error('[PenScribe] Verify error:', err.message);
    return res.redirect(`${appUrl}/login?error=server_error`);
  }
}
