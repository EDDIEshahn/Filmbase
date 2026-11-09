const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadConfig } = require('./lib/config');
const { createStore } = require('./lib/store');
const auth = require('./lib/auth');
const { QUALITIES, getPlan, planList } = require('./lib/plans');
const { createProvider, normalizePhone, detectNetwork, verifyWebhookHash } = require('./lib/payments');
const { serveRange } = require('./lib/streaming');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
};
const DAY_MS = 86400000;
const SUB_DAYS = 30;
const SESSION_DAYS = 7;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function createApp(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = createStore(config.dataFile);
  const db = store.data;
  const provider = createProvider(config);
  const mediaRoot = path.resolve(config.mediaDir);
  fs.mkdirSync(mediaRoot, { recursive: true });

  // Seed the first admin account from environment variables, if none exists.
  if (config.adminEmail && config.adminPassword && !db.users.some(u => u.role === 'admin')) {
    db.users.push({
      id: crypto.randomUUID(),
      email: config.adminEmail.trim().toLowerCase(),
      name: 'Admin',
      role: 'admin',
      passwordHash: auth.hashPassword(config.adminPassword),
      subscription: null,
      createdAt: new Date().toISOString()
    });
    store.save();
  }

  // ---------- HTTP helpers ----------
  const send = (res, status, body, headers = {}) => {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      ...headers
    });
    res.end(json);
  };

  const readBody = req => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1e6) {
        reject(httpError(413, 'Request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });

  const cookieOf = req => {
    const m = /(?:^|;\s*)fb_session=([^;]+)/.exec(req.headers.cookie || '');
    return m ? m[1] : null;
  };

  const currentUser = req => {
    const payload = auth.verifyToken(cookieOf(req), config.secret);
    if (!payload) return null;
    return db.users.find(u => u.id === payload.uid) || null;
  };
  const requireUser = req => {
    const user = currentUser(req);
    if (!user) throw httpError(401, 'Sign in required');
    return user;
  };
  const requireAdmin = req => {
    const user = requireUser(req);
    if (user.role !== 'admin') throw httpError(403, 'Admins only');
    return user;
  };

  const activeSub = user => (
    user.subscription && new Date(user.subscription.expiresAt) > new Date() ? user.subscription : null
  );
  const publicUser = user => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    subscription: activeSub(user)
  });

  const setSession = (res, user, status) => {
    const token = auth.signToken({ uid: user.id }, config.secret, SESSION_DAYS * 86400);
    const cookie = `fb_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${config.secureCookies ? '; Secure' : ''}`;
    send(res, status, { user: publicUser(user) }, { 'Set-Cookie': cookie });
  };

  // ---------- Titles ----------
  const publicTitle = t => ({
    id: t.id,
    title: t.title,
    year: t.year,
    genre: t.genre,
    desc: t.desc,
    color: t.color,
    license: t.license,
    qualities: QUALITIES.filter(q => t.sources[q])
  });

  // Media paths must stay inside the media folder.
  const resolveMedia = rel => {
    const full = path.resolve(mediaRoot, String(rel));
    if (!full.startsWith(mediaRoot + path.sep) || !fs.existsSync(full)) return null;
    return full;
  };

  const validateTitle = b => {
    const title = String(b.title || '').trim();
    const year = parseInt(b.year, 10);
    if (!title) throw httpError(400, 'Title is required');
    if (!(year >= 1888 && year <= new Date().getFullYear() + 1)) throw httpError(400, 'Enter a valid year');

    const sources = {};
    for (const [q, rel] of Object.entries(b.sources || {})) {
      const quality = parseInt(q, 10);
      if (!QUALITIES.includes(quality)) throw httpError(400, `Unsupported quality ${q}`);
      const full = resolveMedia(rel);
      if (!full) throw httpError(400, `Media file for ${quality}p was not found in the media folder`);
      sources[quality] = path.relative(mediaRoot, full);
    }

    const published = !!b.published;
    const license = String(b.license || '').trim();
    if (published && (!license || Object.keys(sources).length === 0)) {
      throw httpError(400, 'Publishing needs a license/rights note and at least one media file');
    }

    return {
      title,
      year,
      genre: String(b.genre || '').trim() || 'General',
      desc: String(b.desc || '').trim(),
      color: /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#333333',
      license,
      sources,
      published
    };
  };

  // ---------- Payments ----------
  const activate = (user, plan) => {
    const current = activeSub(user);
    const base = current ? new Date(current.expiresAt).getTime() : Date.now();
    user.subscription = { planId: plan.id, expiresAt: new Date(base + SUB_DAYS * DAY_MS).toISOString() };
  };

  const markFailed = (payment, reason) => {
    payment.status = 'failed';
    payment.failureReason = reason;
    store.save();
  };

  const handleCheckout = async (req, res) => {
    const user = requireUser(req);
    const body = await readBody(req);
    const plan = getPlan(body.planId);
    if (!plan) throw httpError(400, 'Unknown plan');
    const phone = normalizePhone(body.phone);
    if (!phone) throw httpError(400, 'Enter a valid number, e.g. 0770000000');
    const network = detectNetwork(phone);
    if (!network) throw httpError(400, 'Only MTN and Airtel Uganda numbers are supported');

    const payment = {
      ref: 'FB-' + crypto.randomBytes(8).toString('hex'),
      userId: user.id,
      planId: plan.id,
      amount: plan.priceUGX,
      currency: 'UGX',
      phone,
      network,
      status: 'pending',
      failureReason: null,
      providerId: null,
      createdAt: new Date().toISOString(),
      paidAt: null
    };
    db.payments.push(payment);
    store.save();

    try {
      await provider.charge({
        ref: payment.ref,
        amount: payment.amount,
        currency: 'UGX',
        email: user.email,
        name: user.name,
        phone,
        network
      });
    } catch (err) {
      markFailed(payment, err.message);
      throw httpError(502, 'Payment could not be started. Please try again.');
    }

    send(res, 201, {
      ref: payment.ref,
      status: 'pending',
      message: 'Approve the payment prompt on your phone to activate your plan.'
    });
  };

  const handleWebhook = async (req, res) => {
    if (!verifyWebhookHash(req.headers, config)) throw httpError(401, 'Invalid webhook signature');
    const body = await readBody(req);
    if (body.event !== 'charge.completed') return send(res, 200, { ignored: true });

    const d = body.data || {};
    const payment = db.payments.find(p => p.ref === d.tx_ref);
    if (!payment) throw httpError(404, 'Unknown payment reference');
    if (payment.status === 'paid') return send(res, 200, { ok: true, duplicate: true });

    let tx = d;
    if (provider.mode === 'live') {
      tx = await provider.verify(d.id);
      if (!tx) throw httpError(503, 'Verification pending, retry later');
    }

    if (tx.status !== 'successful') {
      markFailed(payment, `Provider status: ${tx.status}`);
      return send(res, 200, { ok: false });
    }
    if (tx.currency !== 'UGX' || Number(tx.amount) < payment.amount || (tx.tx_ref && tx.tx_ref !== payment.ref)) {
      markFailed(payment, 'Amount, currency or reference mismatch');
      return send(res, 200, { ok: false });
    }

    const user = db.users.find(u => u.id === payment.userId);
    const plan = getPlan(payment.planId);
    payment.status = 'paid';
    payment.paidAt = new Date().toISOString();
    payment.providerId = String(d.id ?? '');
    activate(user, plan);
    store.save();
    send(res, 200, { ok: true });
  };

  // ---------- Static files ----------
  const serveStatic = (res, p) => {
    let rel = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    let decoded;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      throw httpError(400, 'Bad path');
    }
    const file = path.join(PUBLIC_DIR, decoded);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw httpError(404, 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  };

  // ---------- Router ----------
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;

    if (!p.startsWith('/api/')) return serveStatic(res, p);

    if (m === 'GET' && p === '/api/health') {
      return send(res, 200, { ok: true, paymentMode: provider.mode });
    }
    if (m === 'GET' && p === '/api/plans') {
      return send(res, 200, { plans: planList(), qualities: QUALITIES });
    }

    // Auth
    if (m === 'POST' && p === '/api/auth/register') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const name = String(b.name || '').trim();
      const password = String(b.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, 'Enter a valid email');
      if (name.length < 2) throw httpError(400, 'Enter your name');
      if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
      if (db.users.some(u => u.email === email)) throw httpError(409, 'Email already registered');
      const user = {
        id: crypto.randomUUID(),
        email,
        name,
        role: 'user',
        passwordHash: auth.hashPassword(password),
        subscription: null,
        createdAt: new Date().toISOString()
      };
      db.users.push(user);
      store.save();
      return setSession(res, user, 201);
    }
    if (m === 'POST' && p === '/api/auth/login') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const user = db.users.find(u => u.email === email);
      if (!user || !auth.verifyPassword(String(b.password || ''), user.passwordHash)) {
        throw httpError(401, 'Wrong email or password');
      }
      return setSession(res, user, 200);
    }
    if (m === 'POST' && p === '/api/auth/logout') {
      return send(res, 200, { ok: true }, {
        'Set-Cookie': 'fb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      });
    }
    if (m === 'GET' && p === '/api/auth/me') {
      return send(res, 200, { user: publicUser(requireUser(req)) });
    }

    // Catalog
    if (m === 'GET' && p === '/api/titles') {
      return send(res, 200, { titles: db.titles.filter(t => t.published).map(publicTitle) });
    }
    const titleMatch = p.match(/^\/api\/titles\/([^/]+)$/);
    if (m === 'GET' && titleMatch) {
      const t = db.titles.find(x => x.id === titleMatch[1] && x.published);
      if (!t) throw httpError(404, 'Title not found');
      return send(res, 200, { title: publicTitle(t) });
    }

    // Subscriptions and payments
    if (m === 'POST' && p === '/api/subscriptions/checkout') return handleCheckout(req, res);
    if (m === 'GET' && p === '/api/subscriptions/status') {
      const user = requireUser(req);
      const sub = activeSub(user);
      return send(res, 200, { subscription: sub, plan: sub ? getPlan(sub.planId) : null });
    }
    const payMatch = p.match(/^\/api\/payments\/([^/]+)$/);
    if (m === 'GET' && payMatch) {
      const user = requireUser(req);
      const pay = db.payments.find(x => x.ref === payMatch[1] && x.userId === user.id);
      if (!pay) throw httpError(404, 'Payment not found');
      return send(res, 200, {
        ref: pay.ref,
        status: pay.status,
        planId: pay.planId,
        failureReason: pay.failureReason
      });
    }
    if (m === 'POST' && p === '/api/payments/webhook') return handleWebhook(req, res);

    // Streaming
    const streamMatch = p.match(/^\/api\/stream\/([^/]+)$/);
    if (m === 'GET' && streamMatch) {
      const user = requireUser(req);
      const sub = activeSub(user);
      if (!sub) throw httpError(402, 'Subscription required to stream');
      const title = db.titles.find(t => t.id === streamMatch[1] && t.published);
      if (!title) throw httpError(404, 'Title not found');

      const plan = getPlan(sub.planId);
      const requested = parseInt(url.searchParams.get('q') || String(plan.maxQuality), 10);
      if (!QUALITIES.includes(requested)) throw httpError(400, 'Invalid quality');
      if (requested > plan.maxQuality) {
        throw httpError(403, `Your ${plan.name} plan streams up to ${plan.maxQuality}p. Upgrade to unlock ${requested}p.`);
      }
      const q = QUALITIES.filter(x => x <= requested && title.sources[x]).pop();
      if (!q) throw httpError(404, 'No source available at this quality');
      const file = resolveMedia(title.sources[q]);
      if (!file) throw httpError(404, 'Media file missing');
      return serveRange(req, res, file, { 'X-Quality': String(q) });
    }

    // Admin
    if (p === '/api/admin/titles') {
      requireAdmin(req);
      if (m === 'GET') return send(res, 200, { titles: db.titles });
      if (m === 'POST') {
        const b = await readBody(req);
        const t = { id: crypto.randomUUID(), ...validateTitle(b), createdAt: new Date().toISOString() };
        db.titles.push(t);
        store.save();
        return send(res, 201, { title: t });
      }
    }
    const adminTitle = p.match(/^\/api\/admin\/titles\/([^/]+)$/);
    if (adminTitle && m === 'PATCH') {
      requireAdmin(req);
      const t = db.titles.find(x => x.id === adminTitle[1]);
      if (!t) throw httpError(404, 'Title not found');
      const b = await readBody(req);
      Object.assign(t, validateTitle({ ...t, ...b }), { updatedAt: new Date().toISOString() });
      store.save();
      return send(res, 200, { title: t });
    }
    if (m === 'GET' && p === '/api/admin/payments') {
      requireAdmin(req);
      return send(res, 200, { payments: db.payments });
    }

    throw httpError(404, 'Not found');
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (res.headersSent) return res.end();
      if (!err.status) console.error(err);
      send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' });
    });
  });

  return { server, store, config, provider };
}

module.exports = { createApp };

if (require.main === module) {
  const app = createApp();
  app.server.listen(app.config.port, () => {
    console.log(`FILMBASE running at http://localhost:${app.config.port} (payments: ${app.provider.mode})`);
  });
}
