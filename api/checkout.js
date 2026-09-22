// api/checkout.js — NOWPayments crypto checkout
// Creates a payment invoice for PenScribe Premium ($39/month)

export default async function handler(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // A01 — Validate email input
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Valid email required' });
  }

  // Sanitize email
  const cleanEmail = email.toLowerCase().trim().slice(0, 254);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  const planId = process.env.NOWPAYMENTS_PLAN_ID;
  const appUrl = process.env.APP_URL || 'https://securereport-pro.vercel.app';
  const isSandbox = process.env.NOWPAYMENTS_MODE === 'sandbox';
  const baseUrl = isSandbox
    ? 'https://api-sandbox.nowpayments.io/v1'
    : 'https://api.nowpayments.io/v1';

  if (!apiKey || !planId) {
    console.error('[PenScribe] Missing NOWPayments env vars');
    return res.status(500).json({ error: 'Payment service not configured' });
  }

  try {
    // Create NOWPayments subscription invoice
    const response = await fetch(`${baseUrl}/subscription`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plan_id: planId,
        email: cleanEmail,
        success_url: `${appUrl}/success?email=${encodeURIComponent(cleanEmail)}`,
        cancel_url: `${appUrl}/app`,
        partially_paid_url: `${appUrl}/success?email=${encodeURIComponent(cleanEmail)}&partial=true`,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[PenScribe] NOWPayments error:', data);
      return res.status(response.status).json({
        error: data?.message || 'Payment service error'
      });
    }

    // Return checkout URL to redirect user
    return res.status(200).json({
      checkout_url: data.pay_url || data.invoice_url,
      subscription_id: data.id,
    });

  } catch (err) {
    console.error('[PenScribe] Checkout error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
