const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');

const ADMIN = { email: 'admin@filmbase.test', password: 'admin-pass-123' };
const HASH = 'test-webhook-hash';
let app;
let base;
let adminCookie;
let titleId;
let draftId;
let uniq = 0;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'filmbase-test-'));
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir);
  fs.writeFileSync(path.join(mediaDir, 'demo-480.mp4'), Buffer.alloc(5000, 1));
  fs.writeFileSync(path.join(mediaDir, 'demo-720.mp4'), Buffer.alloc(9000, 2));

  app = createApp({
    dataFile: path.join(dir, 'db.json'),
    mediaDir,
    secret: 'test-secret',
    paymentMode: 'sandbox',
    flwWebhookHash: HASH,
    secureCookies: false,
    adminEmail: ADMIN.email,
    adminPassword: ADMIN.password
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.server.closeAllConnections();
  return new Promise(resolve => app.server.close(resolve));
});

async function api(p, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual'
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

const sessionOf = r => {
  const m = /fb_session=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  return m ? `fb_session=${m[1]}` : null;
};

async function newUser() {
  const email = `viewer${++uniq}@test.dev`;
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email, name: 'Test Viewer', password: 'password123' }
  });
  assert.equal(r.status, 201);
  return { cookie: sessionOf(r), email };
}

async function subscribe(cookie, planId, amountOverride) {
  const plans = (await api('/api/plans')).json.plans;
  const plan = plans.find(p => p.id === planId);
  const co = await api('/api/subscriptions/checkout', {
    method: 'POST',
    body: { planId, phone: '0770000000' },
    cookie
  });
  assert.equal(co.status, 201, co.text);
  const wh = await api('/api/payments/webhook', {
    method: 'POST',
    headers: { 'verif-hash': HASH },
    body: {
      event: 'charge.completed',
      data: {
        tx_ref: co.json.ref,
        status: 'successful',
        amount: amountOverride ?? plan.priceUGX,
        currency: 'UGX',
        id: Math.floor(Math.random() * 1e9)
      }
    }
  });
  assert.equal(wh.status, 200);
  return co.json.ref;
}

test('admin signs in and creates titles', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(login.status, 200);
  adminCookie = sessionOf(login);

  const pub = await api('/api/admin/titles', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      title: 'Demo Film', year: 1927, genre: 'Drama', desc: 'Test title', color: '#7b2d26',
      license: 'Public domain (test)', published: true,
      sources: { 480: 'demo-480.mp4', 720: 'demo-720.mp4' }
    }
  });
  assert.equal(pub.status, 201, pub.text);
  titleId = pub.json.title.id;

  const draft = await api('/api/admin/titles', {
    method: 'POST',
    cookie: adminCookie,
    body: { title: 'Draft Film', year: 1930, sources: { 480: 'demo-480.mp4' } }
  });
  assert.equal(draft.status, 201);
  draftId = draft.json.title.id;
});

test('catalog lists only published titles', async () => {
  const list = await api('/api/titles');
  const ids = list.json.titles.map(t => t.id);
  assert.ok(ids.includes(titleId));
  assert.ok(!ids.includes(draftId));
  assert.equal((await api('/api/titles/' + draftId)).status, 404);
});

test('publishing requires a license note', async () => {
  const r = await api('/api/admin/titles', {
    method: 'POST',
    cookie: adminCookie,
    body: { title: 'No License', year: 1940, published: true, sources: { 480: 'demo-480.mp4' } }
  });
  assert.equal(r.status, 400);
});

test('media paths cannot escape the media folder', async () => {
  const r = await api('/api/admin/titles', {
    method: 'POST',
    cookie: adminCookie,
    body: { title: 'Bad Path', year: 1940, sources: { 480: '../../etc/passwd' } }
  });
  assert.equal(r.status, 400);
});

test('registration, duplicate email, login and session', async () => {
  const bad = await api('/api/auth/register', {
    method: 'POST', body: { email: 'x@test.dev', name: 'Xy', password: 'short' }
  });
  assert.equal(bad.status, 400);

  const user = await newUser();
  assert.ok(user.cookie);

  const dup = await api('/api/auth/register', {
    method: 'POST', body: { email: user.email, name: 'Dup', password: 'password123' }
  });
  assert.equal(dup.status, 409);

  const wrong = await api('/api/auth/login', {
    method: 'POST', body: { email: user.email, password: 'nope-nope' }
  });
  assert.equal(wrong.status, 401);

  const ok = await api('/api/auth/login', {
    method: 'POST', body: { email: user.email, password: 'password123' }
  });
  assert.equal(ok.status, 200);

  const me = await api('/api/auth/me', { cookie: user.cookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, user.email);
  assert.equal((await api('/api/auth/me')).status, 401);
});

test('non-admins cannot use admin routes', async () => {
  const user = await newUser();
  assert.equal((await api('/api/admin/titles')).status, 401);
  assert.equal((await api('/api/admin/titles', { cookie: user.cookie })).status, 403);
  assert.equal((await api('/api/admin/payments', { cookie: user.cookie })).status, 403);
});

test('streaming requires sign-in and an active subscription', async () => {
  assert.equal((await api('/api/stream/' + titleId)).status, 401);
  const user = await newUser();
  const r = await api('/api/stream/' + titleId, { cookie: user.cookie });
  assert.equal(r.status, 402);
});

test('checkout rejects non-MTN/Airtel numbers and unknown plans', async () => {
  const user = await newUser();
  const badPhone = await api('/api/subscriptions/checkout', {
    method: 'POST', body: { planId: 'basic', phone: '0212345678' }, cookie: user.cookie
  });
  assert.equal(badPhone.status, 400);

  const badPlan = await api('/api/subscriptions/checkout', {
    method: 'POST', body: { planId: '__proto__', phone: '0770000000' }, cookie: user.cookie
  });
  assert.equal(badPlan.status, 400);
});

test('checkout requires sign-in', async () => {
  const r = await api('/api/subscriptions/checkout', {
    method: 'POST', body: { planId: 'basic', phone: '0770000000' }
  });
  assert.equal(r.status, 401);
});

test('webhook rejects missing or wrong signature', async () => {
  const body = { event: 'charge.completed', data: { tx_ref: 'FB-x', status: 'successful' } };
  assert.equal((await api('/api/payments/webhook', { method: 'POST', body })).status, 401);
  assert.equal((await api('/api/payments/webhook', {
    method: 'POST', body, headers: { 'verif-hash': 'wrong' }
  })).status, 401);
});

test('underpaid webhook marks payment failed and does not activate', async () => {
  const user = await newUser();
  const co = await api('/api/subscriptions/checkout', {
    method: 'POST', body: { planId: 'basic', phone: '0770000000' }, cookie: user.cookie
  });
  assert.equal(co.status, 201);

  const wh = await api('/api/payments/webhook', {
    method: 'POST',
    headers: { 'verif-hash': HASH },
    body: { event: 'charge.completed', data: { tx_ref: co.json.ref, status: 'successful', amount: 100, currency: 'UGX', id: 1 } }
  });
  assert.equal(wh.json.ok, false);

  const status = await api('/api/payments/' + co.json.ref, { cookie: user.cookie });
  assert.equal(status.json.status, 'failed');
  const me = await api('/api/auth/me', { cookie: user.cookie });
  assert.equal(me.json.user.subscription, null);
});

test('valid webhook activates subscription and is idempotent', async () => {
  const user = await newUser();
  const ref = await subscribe(user.cookie, 'standard');

  const status = await api('/api/payments/' + ref, { cookie: user.cookie });
  assert.equal(status.json.status, 'paid');
  const me = await api('/api/auth/me', { cookie: user.cookie });
  assert.equal(me.json.user.subscription.planId, 'standard');

  const again = await api('/api/payments/webhook', {
    method: 'POST',
    headers: { 'verif-hash': HASH },
    body: { event: 'charge.completed', data: { tx_ref: ref, status: 'successful', amount: 10000, currency: 'UGX', id: 2 } }
  });
  assert.equal(again.json.duplicate, true);
});

test('a user cannot view another user\'s payment', async () => {
  const owner = await newUser();
  const other = await newUser();
  const co = await api('/api/subscriptions/checkout', {
    method: 'POST', body: { planId: 'basic', phone: '0770000000' }, cookie: owner.cookie
  });
  const r = await api('/api/payments/' + co.json.ref, { cookie: other.cookie });
  assert.equal(r.status, 404);
});

test('standard subscriber streams the best source with range support', async () => {
  const user = await newUser();
  await subscribe(user.cookie, 'standard');

  const full = await api('/api/stream/' + titleId, { cookie: user.cookie });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('x-quality'), '720');
  assert.equal(full.headers.get('content-length'), '9000');

  const part = await api('/api/stream/' + titleId, {
    cookie: user.cookie, headers: { Range: 'bytes=0-99' }
  });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-99/9000');
  assert.equal(part.headers.get('content-length'), '100');
});

test('basic plan is capped at 480p', async () => {
  const user = await newUser();
  await subscribe(user.cookie, 'basic');

  const blocked = await api('/api/stream/' + titleId + '?q=720', { cookie: user.cookie });
  assert.equal(blocked.status, 403);

  const ok = await api('/api/stream/' + titleId, { cookie: user.cookie });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('x-quality'), '480');
  assert.equal(ok.headers.get('content-length'), '5000');
});

test('premium request above the available sources uses the best one available', async () => {
  const user = await newUser();
  await subscribe(user.cookie, 'premium');

  const r = await api('/api/stream/' + titleId + '?q=1080', { cookie: user.cookie });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-quality'), '720');

  const bad = await api('/api/stream/' + titleId + '?q=999', { cookie: user.cookie });
  assert.equal(bad.status, 400);
});

test('admin can unpublish a title and it disappears from the catalog', async () => {
  const r = await api('/api/admin/titles/' + titleId, {
    method: 'PATCH', cookie: adminCookie, body: { published: false }
  });
  assert.equal(r.status, 200);
  const list = await api('/api/titles');
  assert.ok(!list.json.titles.some(t => t.id === titleId));

  await api('/api/admin/titles/' + titleId, {
    method: 'PATCH', cookie: adminCookie, body: { published: true }
  });
});

test('serves the site and admin pages', async () => {
  const home = await api('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /FILMBASE/);
  const admin = await api('/admin');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /Add a title/);
  assert.equal((await api('/../package.json')).status, 404);
});
