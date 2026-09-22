// api/send-link.js — Sends magic link email via Resend

import crypto from 'crypto';

export default async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, trigger } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });

  const cleanEmail = email.toLowerCase().trim();
  const resendKey = process.env.RESEND_API_KEY;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const appUrl = process.env.APP_URL || 'https://securereport-pro.vercel.app';

  if (!resendKey || !kvUrl || !kvToken) {
    return res.status(500).json({ error: 'Service not configured' });
  }

  // Generate secure token
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 15 * 60 * 1000; // 15 minutes

  // Store token in Upstash Redis
  await fetch(`${kvUrl}/set/${encodeURIComponent(`token:${token}`)}/${encodeURIComponent(JSON.stringify({ email: cleanEmail, expires }))}`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });

  // Set token expiry (15 mins = 900 seconds)
  await fetch(`${kvUrl}/expire/${encodeURIComponent(`token:${token}`)}/900`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });

  const magicLink = `${appUrl}/api/verify?token=${token}`;
  const isPayment = trigger === 'payment_success';

  // Send email via Resend
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'PenScribe <onboarding@resend.dev>',
      to: cleanEmail,
      subject: isPayment
        ? '✅ Your PenScribe Premium Access is Ready'
        : '🔐 Your PenScribe Login Link',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="background:#0a0b14;color:#e8eaf6;font-family:monospace;padding:40px 20px;margin:0">
  <div style="max-width:480px;margin:0 auto">
    <div style="margin-bottom:28px">
      <span style="color:#00e5ff;font-size:18px;font-weight:700">Pen</span>
      <span style="color:#ffffff;font-size:18px;font-weight:700">Scribe</span>
      <span style="display:inline-block;width:8px;height:3px;background:#bf5af2;border-radius:1px;margin-left:2px;vertical-align:middle"></span>
    </div>
    ${isPayment ? `
    <h1 style="color:#00e5ff;font-size:20px;margin-bottom:8px">Payment confirmed ✅</h1>
    <p style="color:#6b7299;font-size:14px;margin-bottom:28px">
      Your PenScribe Premium subscription is now active. Click below to access your account.
    </p>` : `
    <h1 style="color:#ffffff;font-size:20px;margin-bottom:8px">Your login link</h1>
    <p style="color:#6b7299;font-size:14px;margin-bottom:28px">
      Click the button below to sign in to PenScribe. This link expires in 15 minutes.
    </p>`}
    <a href="${magicLink}"
       style="display:inline-block;background:#00e5ff;color:#0a0b14;font-family:monospace;font-size:14px;font-weight:700;padding:14px 32px;border-radius:6px;text-decoration:none;margin-bottom:28px">
      ${isPayment ? 'Access PenScribe Premium →' : 'Sign in to PenScribe →'}
    </a>
    <p style="color:#6b7299;font-size:12px;border-top:1px solid #1e2240;padding-top:20px">
      Link expires in 15 minutes. If you didn't request this, ignore this email.<br><br>
      © 2026 PenScribe · No scan data is ever stored.
    </p>
  </div>
</body>
</html>`,
    }),
  });

  if (!emailRes.ok) {
    const err = await emailRes.json();
    console.error('[PenScribe] Email error:', err);
    return res.status(500).json({ error: 'Failed to send email' });
  }

  return res.status(200).json({ sent: true });
}
