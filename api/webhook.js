// api/webhook.js — NOWPayments IPN webhook handler
// Receives payment events and updates user status in Upstash Redis

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const appUrl = process.env.APP_URL || 'https://securereport-pro.vercel.app';

  // A08 — Verify IPN signature to ensure request is from NOWPayments
  const signature = req.headers['x-nowpayments-sig'];
  if (ipnSecret && signature) {
    const sortedBody = JSON.stringify(
      Object.keys(req.body).sort().reduce((acc, key) => {
        acc[key] = req.body[key];
        return acc;
      }, {})
    );
    const expectedSig = crypto
      .createHmac('sha512', ipnSecret)
      .update(sortedBody)
      .digest('hex');

    if (signature !== expectedSig) {
      console.error('[PenScribe] Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const event = req.body;
  const paymentStatus = event.payment_status;
  const email = event.order_description || event.email || '';
  const subscriptionId = event.subscription_id || event.id || '';

  console.log('[PenScribe] Webhook received:', paymentStatus, email);

  if (!email || !kvUrl || !kvToken) {
    return res.status(400).json({ error: 'Missing data' });
  }

  // Helper: set value in Upstash Redis
  async function kvSet(key, value) {
    await fetch(`${kvUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
  }

  // Helper: get value from Upstash Redis
  async function kvGet(key) {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  }

  try {
    const userKey = `user:${email}`;

    if (paymentStatus === 'finished' || paymentStatus === 'confirmed') {
      // Payment successful — activate premium
      await kvSet(userKey, {
        email,
        tier: 'premium',
        status: 'active',
        subscriptionId,
        activatedAt: Date.now(),
        nextBillingDate: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      // Send magic link email
      await fetch(`${appUrl}/api/send-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, trigger: 'payment_success' }),
      });

      console.log('[PenScribe] Premium activated:', email);
    }

    if (paymentStatus === 'expired' || paymentStatus === 'failed') {
      const user = await kvGet(userKey);
      await kvSet(userKey, { ...user, status: 'payment_failed' });
      console.log('[PenScribe] Payment failed:', email);
    }

    if (paymentStatus === 'refunded') {
      const user = await kvGet(userKey);
      await kvSet(userKey, { ...user, tier: 'free', status: 'refunded' });
      console.log('[PenScribe] Refunded:', email);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[PenScribe] Webhook error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}
