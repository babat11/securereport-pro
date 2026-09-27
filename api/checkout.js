// api/checkout.js — NOWPayments crypto checkout
const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const cleanEmail = email.toLowerCase().trim().slice(0, 254);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  const appUrl = (process.env.APP_URL || 'https://securereport-pro.vercel.app').replace(/\/$/, '');

  if (!apiKey) {
    console.error('[PenScribe] Missing NOWPAYMENTS_API_KEY');
    return res.status(500).json({ error: 'Payment service not configured' });
  }

  const payload = JSON.stringify({
    price_amount: 39,
    price_currency: 'usd',
    order_description: `PenScribe Premium — ${cleanEmail}`,
    ipn_callback_url: `${appUrl}/api/webhook`,
    success_url: `${appUrl}/success?email=${encodeURIComponent(cleanEmail)}`,
    cancel_url: `${appUrl}/app`,
  });

  // Use native https module — no dependency on fetch or node-fetch
  const result = await new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.nowpayments.io',
      path: '/v1/invoice',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const reqHttp = https.request(options, (resHttp) => {
      let data = '';
      resHttp.on('data', chunk => data += chunk);
      resHttp.on('end', () => {
        try {
          resolve({ status: resHttp.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: resHttp.statusCode, body: { message: data } });
        }
      });
    });

    reqHttp.on('error', reject);
    reqHttp.write(payload);
    reqHttp.end();
  });

  if (result.status !== 200 && result.status !== 201) {
    console.error('[PenScribe] NOWPayments error:', result.body);
    return res.status(result.status).json({
      error: result.body?.message || 'Payment service error'
    });
  }

  return res.status(200).json({
    checkout_url: result.body.invoice_url,
    invoice_id: result.body.id,
  });
};
