const $ = id => document.getElementById(id);
const state = { me: null, plans: [], qualities: [], titles: [], current: null };
let authMode = 'login';
let selectedPlan = 'standard';

const fmt = n => 'UGX ' + Number(n).toLocaleString('en-US');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), 2800);
}

function go(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  $(view).classList.remove('hidden');
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-go]').forEach(el => {
  el.onclick = () => go(el.dataset.go);
});

// ---------- Account ----------
async function refreshMe() {
  try {
    state.me = (await api('/api/auth/me')).user;
  } catch {
    state.me = null;
  }
  $('accountBtn').textContent = state.me ? state.me.name.split(' ')[0] : 'Sign in';
  renderAccount();
  renderPlans();
  renderPlayer();
}

function renderAccount() {
  const me = state.me;
  $('authBox').classList.toggle('hidden', !!me);
  $('profileBox').classList.toggle('hidden', !me);
  if (!me) return;
  $('pName').textContent = me.name;
  $('pEmail').textContent = me.email;
  const sub = me.subscription;
  if (sub) {
    const plan = state.plans.find(p => p.id === sub.planId);
    $('pSub').textContent = `${plan ? plan.name : sub.planId} plan · streams up to ${plan ? plan.maxQuality : '?'}p · active until ${new Date(sub.expiresAt).toLocaleDateString()}`;
  } else {
    $('pSub').textContent = 'No active subscription.';
  }
  $('chooseBtn').classList.toggle('hidden', !!sub);
  $('adminLink').classList.toggle('hidden', me.role !== 'admin');
}

function setAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === 'login';
  $('tabLogin').classList.toggle('active', isLogin);
  $('tabReg').classList.toggle('active', !isLogin);
  $('nameLabel').classList.toggle('hidden', isLogin);
  $('authTitle').textContent = isLogin ? 'Sign in' : 'Create account';
  $('authBtn').textContent = isLogin ? 'Sign in' : 'Create account';
  $('password').autocomplete = isLogin ? 'current-password' : 'new-password';
  $('authStatus').textContent = '';
}
$('tabLogin').onclick = () => setAuthMode('login');
$('tabReg').onclick = () => setAuthMode('register');

$('authBtn').onclick = async () => {
  const body = { email: $('email').value.trim(), password: $('password').value };
  if (authMode === 'register') body.name = $('name').value.trim();
  $('authStatus').className = 'status';
  try {
    const data = await api(authMode === 'login' ? '/api/auth/login' : '/api/auth/register', { body });
    $('password').value = '';
    toast('Welcome, ' + data.user.name.split(' ')[0]);
    await refreshMe();
    go('catalog');
  } catch (e) {
    $('authStatus').className = 'status err';
    $('authStatus').textContent = e.message;
  }
};

$('logoutBtn').onclick = async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state.me = null;
  toast('Signed out');
  await refreshMe();
};

// ---------- Catalog ----------
async function loadTitles() {
  try {
    state.titles = (await api('/api/titles')).titles;
  } catch (e) {
    toast('Could not load titles: ' + e.message);
  }
  renderGrid();
}

function renderGrid() {
  const q = $('search').value.trim().toLowerCase();
  const list = state.titles.filter(t =>
    !q || [t.title, t.genre, String(t.year)].some(x => x.toLowerCase().includes(q)));
  $('count').textContent = `${list.length} title(s)`;
  $('grid').innerHTML = '';
  if (!list.length) {
    $('grid').innerHTML = '<p class="muted">No titles yet.</p>';
    return;
  }
  list.forEach(t => {
    const tile = document.createElement('div');
    tile.className = 'card-tile';
    tile.innerHTML = `<div class="poster" style="background:${esc(t.color)}">${esc(t.title)}</div>
      <div class="meta">${esc(t.year)} · ${esc(t.genre)}</div>`;
    tile.onclick = () => openTitle(t.id);
    $('grid').appendChild(tile);
  });
}
$('search').oninput = renderGrid;

// ---------- Title & player ----------
function maxAllowed() {
  const sub = state.me && state.me.subscription;
  if (!sub) return 0;
  const plan = state.plans.find(p => p.id === sub.planId);
  return plan ? plan.maxQuality : 0;
}

async function openTitle(id) {
  try {
    state.current = (await api('/api/titles/' + encodeURIComponent(id))).title;
  } catch (e) {
    toast(e.message);
    return;
  }
  const t = state.current;
  $('tTitle').textContent = t.title;
  $('tMeta').textContent = `${t.year} · ${t.genre}`;
  $('tDesc').textContent = t.desc;
  $('tLicense').textContent = t.license ? 'Licensed: ' + t.license : '';
  go('title');
  renderPlayer();
}

function renderPlayer() {
  const t = state.current;
  if (!t) return;
  const box = $('playerBox');
  const select = $('quality');

  if (!state.me) {
    box.innerHTML = '<div class="locked">Sign in to watch.</div>';
    select.innerHTML = '';
    $('qNote').textContent = '';
    return;
  }
  if (!state.me.subscription) {
    box.innerHTML = '<div class="locked">Subscribe to stream this title.</div>';
    select.innerHTML = '';
    $('qNote').textContent = '';
    return;
  }

  const max = maxAllowed();
  const options = t.qualities.filter(q => q <= max);
  select.innerHTML = options.map(q => `<option value="${q}">${q}p</option>`).join('');
  if (!options.length) {
    box.innerHTML = '<div class="locked">No playable source for this title on your plan.</div>';
    return;
  }
  select.value = String(options[options.length - 1]);
  $('qNote').textContent = `Your plan streams up to ${max}p.`;
  setSource();
}

function setSource() {
  const t = state.current;
  const q = $('quality').value;
  $('playerBox').innerHTML = `<video class="player" controls playsinline preload="metadata" src="/api/stream/${encodeURIComponent(t.id)}?q=${q}"></video>`;
  const video = $('playerBox').querySelector('video');
  video.onerror = () => {
    $('playerBox').innerHTML = '<div class="locked">Playback unavailable. Check your subscription and try again.</div>';
  };
}
$('quality').onchange = setSource;

// ---------- Plans & checkout ----------
async function loadPlans() {
  const data = await api('/api/plans');
  state.plans = data.plans;
  state.qualities = data.qualities;
  renderPlans();
}

function renderPlans() {
  const grid = $('planGrid');
  grid.innerHTML = '';
  const activeId = state.me && state.me.subscription && state.me.subscription.planId;
  state.plans.forEach(p => {
    const d = document.createElement('div');
    d.className = 'plan' + (selectedPlan === p.id ? ' sel' : '') + (activeId === p.id ? ' active' : '');
    d.innerHTML = `
      <h3>${esc(p.name)}${activeId === p.id ? ' ✓' : ''}</h3>
      <div class="price">${fmt(p.priceUGX)} <small>/ 30 days</small></div>
      <ul><li>Streams up to ${p.maxQuality}p</li><li>${p.screens} screen(s)</li></ul>`;
    d.onclick = () => {
      selectedPlan = p.id;
      $('checkout').classList.remove('hidden');
      $('coPlan').textContent = p.name;
      $('coAmount').textContent = fmt(p.priceUGX);
      renderPlans();
    };
    grid.appendChild(d);
  });
}

$('payBtn').onclick = async () => {
  if (!state.me) {
    toast('Sign in first');
    go('account');
    return;
  }
  const status = $('payStatus');
  status.className = 'status';
  status.textContent = 'Sending the payment prompt to your phone…';
  $('payBtn').disabled = true;
  try {
    const { ref, message } = await api('/api/subscriptions/checkout', {
      body: { planId: selectedPlan, phone: $('phone').value }
    });
    status.textContent = message;
    await waitForPayment(ref);
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
  } finally {
    $('payBtn').disabled = false;
  }
};

async function waitForPayment(ref) {
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const p = await api('/api/payments/' + encodeURIComponent(ref));
    if (p.status === 'paid') {
      $('payStatus').className = 'status ok';
      $('payStatus').textContent = 'Payment received. Your plan is active.';
      await refreshMe();
      return;
    }
    if (p.status === 'failed') {
      $('payStatus').className = 'status err';
      $('payStatus').textContent = 'Payment failed: ' + (p.failureReason || 'please try again');
      return;
    }
  }
  $('payStatus').textContent = 'Still waiting for confirmation. Your plan activates automatically once the payment completes.';
}

// ---------- Init ----------
(async () => {
  try { await loadPlans(); } catch (e) { toast('Could not load plans'); }
  await refreshMe();
  await loadTitles();
})();
