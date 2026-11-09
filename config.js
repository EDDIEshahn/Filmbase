const path = require('path');
const crypto = require('crypto');

function loadConfig() {
  const env = process.env;
  const paymentMode = env.PAYMENT_MODE || 'sandbox';

  if (paymentMode !== 'sandbox' && paymentMode !== 'live') {
    throw new Error('PAYMENT_MODE must be "sandbox" or "live"');
  }

  const config = {
    port: parseInt(env.PORT || '3000', 10),
    secret: env.FB_SECRET || crypto.randomBytes(32).toString('hex'),
    dataFile: env.FB_DATA_FILE || path.join(__dirname, '..', 'data', 'db.json'),
    mediaDir: env.FB_MEDIA_DIR || path.join(__dirname, '..', 'media'),
    paymentMode,
    flwSecretKey: env.FLW_SECRET_KEY || '',
    flwWebhookHash: env.FLW_WEBHOOK_HASH || '',
    secureCookies: env.NODE_ENV === 'production',
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || ''
  };

  if (!env.FB_SECRET) {
    console.warn('FB_SECRET is not set. Using a random secret; users will be signed out on restart.');
  }
  if (paymentMode === 'live' && (!config.flwSecretKey || !config.flwWebhookHash)) {
    throw new Error('PAYMENT_MODE=live requires FLW_SECRET_KEY and FLW_WEBHOOK_HASH');
  }
  return config;
}

module.exports = { loadConfig };
