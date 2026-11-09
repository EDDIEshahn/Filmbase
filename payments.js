const crypto = require('crypto');

const FLW_BASE = 'https://api.flutterwave.com/v3';

// Accepts 07XXXXXXXX, 2567XXXXXXXX, +2567XXXXXXXX (spaces and dashes ignored).
// Returns 2567XXXXXXXX or null.
function normalizePhone(input) {
  let s = String(input || '').replace(/[\s\-()+]/g, '');
  if (/^07\d{8}$/.test(s)) s = '256' + s.slice(1);
  return /^2567\d{8}$/.test(s) ? s : null;
}

// Operator prefixes for Uganda. Verify against current operator allocations before launch.
function detectNetwork(msisdn) {
  const prefix = msisdn.slice(3, 5); // the two digits after 256
  if (['77', '78', '76'].includes(prefix)) return 'MTN';
  if (['70', '75', '74'].includes(prefix)) return 'AIRTEL';
  return null;
}

// Sandbox provider: no real money moves. Payments stay pending until a
// signed webhook marks them paid, which lets you test the full flow.
// Live provider: Flutterwave mobile money charge for UGX.
function createProvider(config) {
  if (config.paymentMode !== 'live') {
    return {
      mode: 'sandbox',
      async charge() { return { status: 'pending' }; },
      async verify() { return null; }
    };
  }

  const headers = {
    Authorization: `Bearer ${config.flwSecretKey}`,
    'Content-Type': 'application/json'
  };

  return {
    mode: 'live',
    async charge(tx) {
      const res = await fetch(`${FLW_BASE}/charges?type=mobile_money_uganda`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tx_ref: tx.ref,
          amount: tx.amount,
          currency: 'UGX',
          email: tx.email,
          phone_number: tx.phone,
          fullname: tx.name,
          network: tx.network
        })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'success') {
        throw new Error(body.message || 'Charge request failed');
      }
      return body;
    },
    // Re-check the transaction with the provider instead of trusting the webhook body.
    async verify(transactionId) {
      const res = await fetch(`${FLW_BASE}/transactions/${transactionId}/verify`, { headers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'success') return null;
      return body.data;
    }
  };
}

// Flutterwave sends the secret hash you configured in the "verif-hash" header.
// Fails closed: if no hash is configured, every webhook is rejected.
function verifyWebhookHash(headers, config) {
  const got = String(headers['verif-hash'] || '');
  const want = config.flwWebhookHash || '';
  if (!got || !want) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { normalizePhone, detectNetwork, createProvider, verifyWebhookHash };
