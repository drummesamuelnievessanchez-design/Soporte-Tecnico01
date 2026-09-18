// Soporte360 V17 · interfaz profesional + optimización de renderizado y sincronización
const DB_KEY = 'soporte360_db_v1';

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const now = () => new Date().toLocaleString('es-EC');
const money = n => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(Number(n || 0));
const uid = (p = 'ID') => p + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 5).toUpperCase();
const clone = obj => JSON.parse(JSON.stringify(obj));
const esc = (s = '') => String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const svgIcon = (name, cls = 'ui-icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const debounce = (fn, wait = 120) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
};

const defaults = {
  company: { ruc: '', name: 'Soporte360', legal: '', phone: '', address: '', email: '', logo: '', primary: '#2563eb', secondary: '#0f172a', taxRate: 15, serviceClause: '' },
  cash: { open: false, opening: 0, openedAt: null, closedAt: null, lastClosedTotal: 0, movements: [] },
  clients: [],
  devices: [],
  products: [],
  sales: [],
  proformas: []
};

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(DB_KEY) || '{}');
    return {
      ...clone(defaults),
      ...raw,
      company: { ...clone(defaults.company), ...(raw.company || {}) },
      cash: { ...clone(defaults.cash), ...(raw.cash || {}), movements: Array.isArray(raw.cash?.movements) ? raw.cash.movements : [] },
      clients: Array.isArray(raw.clients) ? raw.clients : [],
      devices: Array.isArray(raw.devices) ? raw.devices : [],
      products: Array.isArray(raw.products) ? raw.products : [],
      sales: Array.isArray(raw.sales) ? raw.sales : [],
      proformas: Array.isArray(raw.proformas) ? raw.proformas : []
    };
  } catch (e) {
    return clone(defaults);
  }
}

let db = load();
let saleCart = [];
let repairCart = [];
let proformaCart = [];
let activeRepairDeviceId = '';
let activeProformaForSaleId = '';
let logoDraftUrl = '';

// ===== SINCRONIZACIÓN EN LA NUBE (SUPABASE) =====
let cloudClient = null;
let cloudUser = null;
let cloudSyncChain = Promise.resolve();
let cloudSyncTimer = null;
let cloudPendingSnapshot = null;
let cloudReady = false;
let workspaceOwnerId = null;
let cloudRole = 'owner';
const isOwner = () => true;

function cloudConfigIsValid() {
  const cfg = window.SUPABASE_CONFIG || {};
  return Boolean(
    cfg.url && cfg.anonKey &&
    !String(cfg.url).includes('PEGA_AQUI') &&
    !String(cfg.anonKey).includes('PEGA_AQUI')
  );
}

function normalizeDb(raw = {}) {
  return {
    ...clone(defaults),
    ...(raw || {}),
    company: { ...clone(defaults.company), ...((raw || {}).company || {}) },
    cash: {
      ...clone(defaults.cash),
      ...((raw || {}).cash || {}),
      movements: Array.isArray((raw || {}).cash?.movements) ? (raw || {}).cash.movements : []
    },
    clients: Array.isArray((raw || {}).clients) ? (raw || {}).clients : [],
    devices: Array.isArray((raw || {}).devices) ? (raw || {}).devices : [],
    products: Array.isArray((raw || {}).products) ? (raw || {}).products : [],
    sales: Array.isArray((raw || {}).sales) ? (raw || {}).sales : [],
    proformas: Array.isArray((raw || {}).proformas) ? (raw || {}).proformas : []
  };
}

function setCloudStatus(type, text) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.className = 'cloud-status ' + type;
  const label = String(text || '').replace(/^☁\s*/, '');
  el.innerHTML = `${svgIcon('cloud')}<span>${esc(label)}</span>`;
}

function setAuthMessage(text = '', type = '') {
  const el = document.getElementById('authMessage');
  if (!el) return;
  el.textContent = text;
  el.className = 'auth-message' + (type ? ' ' + type : '');
}

function showAuthOverlay() {
  document.getElementById('authOverlay')?.classList.remove('hidden');
  const logout = document.getElementById('logoutBtn');
  if (logout) logout.style.display = 'none';
}

function hideAuthOverlay() {
  document.getElementById('authOverlay')?.classList.add('hidden');
  const logout = document.getElementById('logoutBtn');
  if (logout) logout.style.display = '';
}


async function resolveMembership(user) {
  workspaceOwnerId = user.id;
  cloudRole = 'owner';
}

function applyRoleAccess() {
  // Versión sin módulo de trabajadores: el usuario autenticado administra su propio negocio.
}

async function pushCloudSnapshot(snapshot, userId) {
  if (!cloudClient || !userId) return;
  setCloudStatus('syncing', '☁ Guardando…');
  const { error } = await cloudClient
    .from('app_state')
    .upsert({ user_id: userId, data: snapshot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) {
    console.error('Error guardando en Supabase:', error);
    setCloudStatus('error', '☁ Error al guardar');
    return;
  }
  if (cloudUser && (workspaceOwnerId || cloudUser.id) === userId) setCloudStatus('online', '☁ Guardado');
}

function queueCloudSync() {
  if (!cloudReady || !cloudUser || !cloudClient) return;
  // V16: agrupa cambios rápidos y sincroniza solo el estado más reciente.
  cloudPendingSnapshot = clone(db);
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    const snapshot = cloudPendingSnapshot;
    cloudPendingSnapshot = null;
    const userId = workspaceOwnerId || cloudUser?.id;
    if (!snapshot || !userId) return;
    cloudSyncChain = cloudSyncChain
      .catch(() => {})
      .then(() => pushCloudSnapshot(snapshot, userId));
  }, 280);
}

async function loadCloudState(user) {
  setCloudStatus('syncing', '☁ Cargando…');
  const { data, error } = await cloudClient
    .from('app_state')
    .select('data')
    .eq('user_id', workspaceOwnerId || user.id)
    .maybeSingle();

  if (error) throw error;

  if (data?.data && typeof data.data === 'object' && Object.keys(data.data).length) {
    db = normalizeDb(data.data);
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } else {
    // Primera conexión: migra automáticamente lo que ya estaba guardado en este navegador.
    await pushCloudSnapshot(clone(db), workspaceOwnerId || user.id);
  }

  cloudReady = true;
  renderAll();
  setCloudStatus('online', '☁ Guardado');
}

async function activateCloudUser(user) {
  if (!user) return;
  if (cloudUser?.id === user.id && cloudReady) return;
  cloudUser = user;
  cloudReady = false;
  hideAuthOverlay();
  try {
    await resolveMembership(user);
    await loadCloudState(user);
    applyRoleAccess();
    setAuthMessage('');
  } catch (err) {
    console.error(err);
    cloudReady = false;
    setCloudStatus('error', '☁ Error de acceso');
    showAuthOverlay();
    setAuthMessage(err.message || 'No se pudo cargar la base de datos.', 'error');
  }
}

async function initCloud() {
  showAuthOverlay();

  if (!cloudConfigIsValid() || !window.supabase?.createClient) {
    document.getElementById('cloudConfigWarning').style.display = 'block';
    document.querySelectorAll('#authForm input, #authForm button').forEach(el => el.disabled = true);
    setCloudStatus('error', '☁ Falta configurar');
    setAuthMessage('Configura supabase-config.js y vuelve a subirlo a GitHub.', 'error');
    return;
  }

  const cfg = window.SUPABASE_CONFIG;
  cloudClient = window.supabase.createClient(cfg.url, cfg.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  try {
    const { data, error } = await cloudClient.auth.getSession();
    if (error) throw error;
    if (data.session?.user) {
      await activateCloudUser(data.session.user);
    } else {
      setCloudStatus('offline', '☁ Inicia sesión');
    }
  } catch (err) {
    console.error(err);
    setCloudStatus('error', '☁ Error de conexión');
    setAuthMessage('No se pudo conectar con Supabase. Revisa URL, clave pública e internet.', 'error');
  }

  cloudClient.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      if (session?.user) {
        await activateCloudUser(session.user);
      } else {
        cloudUser = null;
        cloudReady = false;
        showAuthOverlay();
        setCloudStatus('offline', '☁ Inicia sesión');
      }
    }, 0);
  });
}

function getActiveView() {
  return document.querySelector('.view.active')?.id?.replace('view-', '') || 'dashboard';
}

function renderShell() {
  applyTheme();
  const badge = document.getElementById('cashBadge');
  if (badge) {
    badge.textContent = db.cash.open ? `Caja abierta · ${money(cashBalance())}` : 'Caja cerrada';
    badge.className = 'cash-badge ' + (db.cash.open ? 'open' : 'closed');
  }
  const quick = document.getElementById('quickOpenCash');
  if (quick) quick.textContent = db.cash.open ? 'Ver caja' : 'Abrir caja';
  applyRoleAccess();
}

function renderView(view = getActiveView()) {
  renderShell();
  switch (view) {
    case 'dashboard': renderDashboard(); break;
    case 'caja': renderCash(); break;
    case 'clientes': renderClients(document.getElementById('clientSearch')?.value || ''); break;
    case 'equipos': renderDevices(document.getElementById('deviceSearch')?.value || ''); break;
    case 'reparaciones':
      renderRepairOrderOptions();
      renderRepairWorkspace();
      break;
    case 'productos': renderProducts(document.getElementById('productSearch')?.value || ''); break;
    case 'inventario': renderInventory(); break;
    case 'inventario-equipos': renderMachineInventory(); break;
    case 'ventas': renderSaleCart(); break;
    case 'proformas': renderProformaCart(); renderProformas(); break;
    case 'cuentas-cobrar': renderReceivables(); break;
    case 'facturas': renderInvoices(); break;
    case 'configuracion': renderCompany(); break;
  }
}

function save(render = true) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  if (render) renderView();
  queueCloudSync();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

const viewMeta = {
  dashboard: ['Panel principal', 'Resumen general del negocio'],
  caja: ['Caja', 'Apertura, movimientos y cierre'],
  clientes: ['Clientes', 'Registro y administración de clientes'],
  equipos: ['Equipos', 'Recepción y seguimiento de equipos'],
  reparaciones: ['Factura de reparación', 'Productos, repuestos y facturación técnica'],
  productos: ['Productos', 'Registro y edición de productos'],
  inventario: ['Inventario', 'Existencias, valoración y stock disponible'],
  'inventario-equipos': ['Inventario de equipos', 'Historial y estado de máquinas ingresadas'],
  ventas: ['Ventas', 'Venta directa de productos'],
  proformas: ['Proformas', 'Cotizaciones sin afectar stock ni caja'],
  'cuentas-cobrar': ['Cuentas por cobrar', 'Abonos y saldos pendientes'],
  facturas: ['Facturas', 'Historial de ventas y reparaciones'],
  configuracion: ['Configuración', 'Empresa, logo y colores']
};

function openGroupForView(v) {
  const item = document.querySelector(`.nav-item[data-view="${v}"]`);
  const group = item?.closest('.nav-group');
  if (!group || document.body.classList.contains('sidebar-collapsed')) return;
  group.classList.add('open');
  group.querySelector('.nav-group-toggle')?.setAttribute('aria-expanded', 'true');
  saveSidebarGroups();
}

function showView(v) {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  openGroupForView(v);
  document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
  const target = document.getElementById('view-' + v);
  if (!target) return;
  target.classList.add('active');
  document.getElementById('pageTitle').textContent = viewMeta[v][0];
  document.getElementById('pageSubtitle').textContent = viewMeta[v][1];
  renderView(v);
}

document.querySelectorAll('.nav-item').forEach(b => b.onclick = () => showView(b.dataset.view));

const SIDEBAR_GROUPS_KEY = 'soporte360_sidebar_groups_v14';
function saveSidebarGroups() {
  if (document.body.classList.contains('sidebar-collapsed')) return;
  const state = {};
  document.querySelectorAll('.nav-group').forEach(g => state[g.dataset.group] = g.classList.contains('open'));
  localStorage.setItem(SIDEBAR_GROUPS_KEY, JSON.stringify(state));
}
function restoreSidebarGroups() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SIDEBAR_GROUPS_KEY) || 'null'); } catch (_) {}
  document.querySelectorAll('.nav-group').forEach(g => {
    const shouldOpen = saved && Object.prototype.hasOwnProperty.call(saved, g.dataset.group)
      ? !!saved[g.dataset.group]
      : g.dataset.group === 'gestion';
    g.classList.toggle('open', shouldOpen);
    g.querySelector('.nav-group-toggle')?.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  });
}
restoreSidebarGroups();
document.querySelectorAll('.nav-group-toggle').forEach(btn => {
  btn.onclick = () => {
    const group = btn.closest('.nav-group');
    if (!group) return;
    const willOpen = !group.classList.contains('open');
    group.classList.toggle('open', willOpen);
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    saveSidebarGroups();
  };
});

document.getElementById('todayLabel').textContent = new Date().toLocaleDateString('es-EC', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
document.getElementById('quickOpenCash').onclick = () => { showView('caja'); window.scrollTo({ top: 0, behavior: 'smooth' }); };

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const btn = document.getElementById('sidebarToggle');
  btn.textContent = collapsed ? '›' : '‹';
  btn.title = collapsed ? 'Ampliar menú' : 'Minimizar menú';
  localStorage.setItem('soporte360_sidebar_collapsed', collapsed ? '1' : '0');
  if (!collapsed) {
    const activeView = document.querySelector('.nav-item.active')?.dataset.view;
    if (activeView) openGroupForView(activeView);
  }
}
document.getElementById('sidebarToggle').onclick = () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
setSidebarCollapsed(localStorage.getItem('soporte360_sidebar_collapsed') === '1');


function applyTheme() {
  document.documentElement.style.setProperty('--primary', db.company.primary || '#2563eb');
  document.documentElement.style.setProperty('--secondary', db.company.secondary || '#0f172a');
  document.getElementById('brandName').textContent = db.company.name || 'Soporte360';
  const box = document.getElementById('brandLogo');
  box.innerHTML = db.company.logo ? `<img src="${db.company.logo}" alt="logo">` : esc((db.company.name || 'S').charAt(0).toUpperCase());
}

function isSaleToday(s) {
  if (s.dateKey) return s.dateKey === today();
  const local = new Date().toLocaleDateString('es-EC');
  return String(s.date || '').startsWith(local);
}

function saleTypeLabel(s) {
  return s.source === 'repair' ? 'Reparación' : 'Venta';
}


function salePaidAmount(s) {
  if (!s) return 0;
  const stored = Number(s.amountPaid);
  if (Number.isFinite(stored)) return Math.max(0, stored);
  if (Array.isArray(s.payments) && s.payments.length) {
    return Math.max(0, s.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0));
  }
  // Compatibilidad: las facturas anteriores a V13 se consideran pagadas.
  return Math.max(0, Number(s.total || 0));
}

function saleBalanceAmount(s) {
  return Math.max(0, Number(s?.total || 0) - salePaidAmount(s));
}

function salePaymentStatus(s) {
  return saleBalanceAmount(s) > 0.004 ? 'Pendiente' : 'Pagado';
}

function salePaymentLabel(s) {
  const methods = Array.isArray(s?.payments) ? [...new Set(s.payments.map(p => p.method).filter(Boolean))] : [];
  if (methods.length) return methods.join(' + ');
  return s?.payment || '-';
}

function saleCollectedToday(s) {
  if (Array.isArray(s?.payments) && s.payments.length) {
    return s.payments.filter(p => p.dateKey === today()).reduce((sum, p) => sum + Number(p.amount || 0), 0);
  }
  // Compatibilidad con comprobantes creados antes de V13.
  return isSaleToday(s) ? salePaidAmount(s) : 0;
}

function makePaymentRecord(amount, method, note = '') {
  return {
    id: uid('ABO'),
    date: now(),
    dateKey: today(),
    amount: Number(amount || 0),
    method: method || 'Efectivo',
    note
  };
}

function setCheckoutPaymentUi(prefix, total) {
  const mode = document.getElementById(prefix + 'PaymentMode');
  const amount = document.getElementById(prefix + 'AmountPaid');
  const hint = document.getElementById(prefix + 'PaymentHint');
  if (!mode || !amount || !hint) return;
  total = Math.max(0, Number(total || 0));
  if (mode.value === 'full') {
    amount.disabled = true;
    amount.value = total.toFixed(2);
  } else {
    amount.disabled = false;
    const current = Number(amount.value || 0);
    if (current > total) amount.value = total.toFixed(2);
  }
  const paid = mode.value === 'full' ? total : Math.max(0, Number(amount.value || 0));
  const balance = Math.max(0, total - paid);
  hint.innerHTML = mode.value === 'full'
    ? `Se registrará <strong>${money(total)}</strong> en caja y la factura quedará pagada.`
    : `Abono: <strong>${money(paid)}</strong> · Saldo pendiente: <strong>${money(balance)}</strong>`;
}

function getCheckoutPayment(prefix, total) {
  const mode = document.getElementById(prefix + 'PaymentMode')?.value || 'full';
  const amountEl = document.getElementById(prefix + 'AmountPaid');
  const paid = mode === 'full' ? Number(total || 0) : Number(amountEl?.value || 0);
  if (!Number.isFinite(paid) || paid < 0) return { error: 'Ingrese un monto recibido válido' };
  if (paid > Number(total || 0) + 0.004) return { error: 'El monto recibido no puede superar el total' };
  return {
    paid: Math.max(0, paid),
    balance: Math.max(0, Number(total || 0) - paid),
    status: Math.max(0, Number(total || 0) - paid) > 0.004 ? 'Pendiente' : 'Pagado'
  };
}

function currentTaxRate() {
  const rate = Number(db.company.taxRate);
  return Number.isFinite(rate) && rate >= 0 ? rate : 0;
}

function splitIncludedTax(gross, rate = currentTaxRate()) {
  gross = Number(gross || 0);
  rate = Number(rate || 0);
  if (rate <= 0) return { subtotal: gross, tax: 0, total: gross, taxRate: 0 };
  const subtotal = gross / (1 + rate / 100);
  const tax = gross - subtotal;
  return { subtotal, tax, total: gross, taxRate: rate };
}

function deviceIsRepaired(d) {
  return d.status === 'Reparado' || d.status === 'Entregado';
}

function addDaysToDateKey(dateKey, days) {
  const [y, m, day] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !day) return '';
  const d = new Date(y, m - 1, day);
  d.setDate(d.getDate() + Math.max(0, Number(days || 0)));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function warrantyLabel(d) {
  const days = Math.max(0, Number(d?.warrantyDays || 0));
  if (!days) return 'Sin garantía registrada';
  if (d?.warrantyStart && d?.warrantyUntil) return `${days} días · ${d.warrantyStart} al ${d.warrantyUntil}`;
  return `${days} días · inicia al finalizar la reparación`;
}

function getClientEmail(clientId, fallback = '') {
  return db.clients.find(c => c.id === clientId)?.email || fallback || '';
}

function renderDashboard() {
  const todaySales = db.sales.filter(isSaleToday);
  const readyDelivery = db.devices.filter(d => d.status === 'Reparado');
  const lowStock = db.products.filter(p => Number(p.stock) <= Number(p.min));
  document.getElementById('statSales').textContent = money(db.sales.reduce((sum, s) => sum + saleCollectedToday(s), 0));
  document.getElementById('statTodayDocs').textContent = todaySales.length;
  document.getElementById('statClients').textContent = db.clients.length;
  document.getElementById('statDevices').textContent = db.devices.length;
  document.getElementById('statPendingDevices').textContent = db.devices.filter(d => !deviceIsRepaired(d)).length;
  document.getElementById('statReadyDelivery').textContent = readyDelivery.length;
  document.getElementById('statRepairedDevices').textContent = db.devices.filter(deviceIsRepaired).length;
  document.getElementById('statLowStock').textContent = lowStock.length;

  document.getElementById('dashboardCash').innerHTML = db.cash.open
    ? `<div class="cash-box"><span class="status good">ABIERTA</span><strong>${money(cashBalance())}</strong><div class="muted">Apertura: ${money(db.cash.opening)} · ${esc(db.cash.openedAt || '')}</div></div>`
    : `<div class="cash-box"><span class="status bad">CERRADA</span><strong>${money(0)}</strong><div class="muted">Debe abrir caja antes de registrar cobros.</div></div>`;

  document.getElementById('recentDevices').innerHTML = db.devices.slice(-5).reverse().map(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    return `<div class="list-item"><div><strong>${esc(d.order)} · ${esc(d.brand)} ${esc(d.model)}</strong><div class="muted">${esc(c?.name || 'Cliente')}</div></div><span class="status">${esc(d.status)}</span></div>`;
  }).join('') || '<div class="empty">No hay equipos registrados.</div>';

  const attentionDevices = db.devices.filter(d => d.status === 'Esperando aprobación' || d.status === 'Reparado').slice().reverse().slice(0, 5);
  const alerts = [
    ...attentionDevices.map(d => {
      const c = db.clients.find(x => x.id === d.clientId);
      return `<div class="dashboard-alert-item"><div><strong>${esc(d.order)} · ${esc(deviceTypeLabel(d))}</strong><span>${esc(c?.name || 'Cliente')} · ${esc(d.status)}</span></div><button class="mini" onclick="showView('equipos');editDevice('${d.id}')">Ver</button></div>`;
    }),
    ...lowStock.slice(0, 5).map(p => `<div class="dashboard-alert-item"><div><strong>${esc(p.code)} · ${esc(p.name)}</strong><span>Stock ${Number(p.stock || 0)} · mínimo ${Number(p.min || 0)}</span></div><button class="mini" onclick="showView('productos');editProduct('${p.id}')">Ver</button></div>`)
  ];
  document.getElementById('dashboardAlerts').innerHTML = alerts.join('') || '<div class="empty">No hay alertas pendientes.</div>';

  document.getElementById('recentSales').innerHTML = db.sales.slice(-5).reverse().map(s => `
    <tr><td>${esc(s.number)}</td><td><span class="status ${s.source === 'repair' ? 'warn' : 'good'}">${saleTypeLabel(s)}</span></td><td>${esc(s.clientName)}</td><td>${esc(s.date)}</td><td><strong>${money(s.total)}</strong></td></tr>
  `).join('') || '<tr><td colspan="5" class="empty">No hay comprobantes.</td></tr>';
}

function cashBalance() {
  return Number(db.cash.opening || 0) + db.cash.movements.reduce((a, m) => a + (m.type === 'ingreso' ? Number(m.amount) : -Number(m.amount)), 0);
}

function renderCash() {
  const badge = document.getElementById('cashBadge');
  badge.textContent = db.cash.open ? `Caja abierta · ${money(cashBalance())}` : 'Caja cerrada';
  badge.className = 'cash-badge ' + (db.cash.open ? 'open' : 'closed');
  document.getElementById('quickOpenCash').textContent = db.cash.open ? 'Ver caja' : 'Abrir caja';

  document.getElementById('cashStatusPanel').innerHTML = db.cash.open
    ? `<div class="cash-box"><span class="status good">CAJA ABIERTA</span><strong>${money(cashBalance())}</strong><p class="muted">Abierta: ${esc(db.cash.openedAt || '')} · Base: ${money(db.cash.opening)}</p><button class="btn danger" onclick="closeCash()">Cerrar caja</button></div>`
    : `<form id="openCashForm" class="form-grid"><label class="full">Monto inicial<input id="openingAmount" type="number" min="0" step="0.01" value="0" required></label><button class="btn primary full" type="submit">Abrir caja</button></form>`;

  if (!db.cash.open) {
    document.getElementById('openCashForm').onsubmit = e => {
      e.preventDefault();
      db.cash.open = true;
      db.cash.opening = Number(document.getElementById('openingAmount').value || 0);
      db.cash.openedAt = now();
      db.cash.closedAt = null;
      db.cash.movements = [];
      save();
      toast('Caja abierta correctamente');
    };
  }

  document.getElementById('cashMovements').innerHTML = db.cash.movements.slice().reverse().map(m => `
    <tr><td>${esc(m.date)}</td><td><span class="status ${m.type === 'ingreso' ? 'good' : 'bad'}">${esc(m.type)}</span></td><td>${esc(m.concept)}</td><td>${money(m.amount)}</td></tr>
  `).join('') || '<tr><td colspan="4" class="empty">Sin movimientos.</td></tr>';
}

window.closeCash = function () {
  if (!confirm('¿Cerrar la caja actual?')) return;
  const total = cashBalance();
  db.cash.open = false;
  db.cash.closedAt = now();
  db.cash.lastClosedTotal = total;
  save();
  toast('Caja cerrada. Total: ' + money(total));
};

document.getElementById('movementForm').onsubmit = e => {
  e.preventDefault();
  if (!db.cash.open) return toast('Primero debe abrir la caja');
  const amount = Number(document.getElementById('movementAmount').value || 0);
  const concept = document.getElementById('movementConcept').value.trim();
  if (amount <= 0 || !concept) return toast('Ingrese monto y concepto');
  db.cash.movements.push({ id: uid('MOV'), date: now(), type: document.getElementById('movementType').value, amount, concept });
  e.target.reset();
  save();
  toast('Movimiento registrado');
};

function normalizeSearchText(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function clientDisplayText(client) {
  if (!client) return '';
  const cedula = client.cedula || '';
  const name = client.name || '';
  const phone = client.phone || '';
  return [cedula, name, phone].filter(Boolean).join(' — ');
}

function closeClientSuggestions(suggestionsId) {
  const box = document.getElementById(suggestionsId);
  if (!box) return;
  box.innerHTML = '';
  box.classList.remove('open');
  const input = box.closest('.client-autocomplete')?.querySelector('.search-select-input');
  if (input) input.setAttribute('aria-expanded', 'false');
}

function setActiveClientSuggestion(box, index) {
  const items = [...box.querySelectorAll('.client-suggestion')];
  if (!items.length) return -1;
  const next = Math.max(0, Math.min(index, items.length - 1));
  items.forEach((item, i) => {
    item.classList.toggle('active', i === next);
    item.setAttribute('aria-selected', i === next ? 'true' : 'false');
  });
  items[next].scrollIntoView({ block: 'nearest' });
  box.dataset.activeIndex = String(next);
  return next;
}

function renderClientSuggestions(searchId, hiddenId, suggestionsId) {
  const input = document.getElementById(searchId);
  const hidden = document.getElementById(hiddenId);
  const box = document.getElementById(suggestionsId);
  if (!input || !hidden || !box) return;

  const q = normalizeSearchText(input.value);
  const selected = db.clients.find(c => c.id === hidden.value);
  if (selected && normalizeSearchText(input.value) === normalizeSearchText(clientDisplayText(selected))) {
    closeClientSuggestions(suggestionsId);
    return;
  }

  // Si el usuario vuelve a escribir después de seleccionar, se invalida la selección
  // hasta que elija nuevamente una coincidencia.
  hidden.value = '';
  if (!q) {
    closeClientSuggestions(suggestionsId);
    return;
  }

  const matches = db.clients
    .filter(c => normalizeSearchText(`${c.cedula || ''} ${c.name || ''}`).includes(q))
    .slice(0, 10);

  box.dataset.activeIndex = '-1';
  if (!matches.length) {
    box.innerHTML = '<div class="client-suggestion-empty">No se encontraron clientes por cédula o nombre.</div>';
    box.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    return;
  }

  box.innerHTML = matches.map(c => `
    <button type="button" class="client-suggestion" role="option" aria-selected="false" data-client-id="${esc(c.id)}">
      <strong>${esc(c.cedula || 'Sin cédula')} — ${esc(c.name || 'Sin nombre')}</strong>
      <span>${esc(c.phone || 'Sin teléfono')}</span>
    </button>
  `).join('');
  box.classList.add('open');
  input.setAttribute('aria-expanded', 'true');
}

function selectClientFromSearch(searchId, hiddenId, suggestionsId, clientId) {
  const client = db.clients.find(c => c.id === clientId);
  if (!client) return;
  document.getElementById(hiddenId).value = client.id;
  document.getElementById(searchId).value = clientDisplayText(client);
  closeClientSuggestions(suggestionsId);
}

function setupClientAutocomplete(searchId, hiddenId, suggestionsId) {
  const input = document.getElementById(searchId);
  const hidden = document.getElementById(hiddenId);
  const box = document.getElementById(suggestionsId);
  if (!input || !hidden || !box) return;

  const renderSuggestionsDebounced = debounce(() => renderClientSuggestions(searchId, hiddenId, suggestionsId), 90);
  input.addEventListener('input', renderSuggestionsDebounced);
  input.addEventListener('focus', () => {
    if (input.value.trim() && !hidden.value) renderClientSuggestions(searchId, hiddenId, suggestionsId);
  });
  input.addEventListener('keydown', e => {
    if (!box.classList.contains('open')) {
      if (e.key === 'ArrowDown' && input.value.trim()) {
        renderClientSuggestions(searchId, hiddenId, suggestionsId);
        setActiveClientSuggestion(box, 0);
        e.preventDefault();
      }
      return;
    }

    const items = [...box.querySelectorAll('.client-suggestion')];
    if (!items.length) {
      if (e.key === 'Escape') closeClientSuggestions(suggestionsId);
      return;
    }

    let active = Number(box.dataset.activeIndex ?? -1);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = active < items.length - 1 ? active + 1 : 0;
      setActiveClientSuggestion(box, active);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = active > 0 ? active - 1 : items.length - 1;
      setActiveClientSuggestion(box, active);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      selectClientFromSearch(searchId, hiddenId, suggestionsId, items[active].dataset.clientId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeClientSuggestions(suggestionsId);
    }
  });
  box.addEventListener('mousedown', e => {
    const item = e.target.closest('.client-suggestion');
    if (!item) return;
    e.preventDefault();
    selectClientFromSearch(searchId, hiddenId, suggestionsId, item.dataset.clientId);
  });
}

function refreshClientSelectors() {
  [['deviceClientSearch','deviceClient','deviceClientSuggestions'],['saleClientSearch','saleClient','saleClientSuggestions'],['proformaClientSearch','proformaClient','proformaClientSuggestions']].forEach(([searchId, hiddenId, suggestionsId]) => {
    const hidden = document.getElementById(hiddenId);
    const input = document.getElementById(searchId);
    if (!hidden || !input) return;
    const selected = db.clients.find(c => c.id === hidden.value);
    if (hidden.value && !selected) {
      hidden.value = '';
      input.value = '';
    }
    closeClientSuggestions(suggestionsId);
  });
}

function renderClients(filter = '') {
  const q = filter.toLowerCase();
  document.getElementById('clientsTable').innerHTML = db.clients.filter(c => [c.cedula, c.name, c.phone, c.email, c.address].join(' ').toLowerCase().includes(q)).map(c => `
    <tr><td>${esc(c.cedula)}</td><td><strong>${esc(c.name)}</strong></td><td>${esc(c.phone)}</td><td>${esc(c.email || '-')}</td><td>${esc(c.address)}</td><td><div class="action-row"><button class="mini primary-mini" onclick="openClientHistory('${c.id}')">Historial</button><button class="mini" onclick="editClient('${c.id}')">Editar</button></div></td></tr>
  `).join('') || '<tr><td colspan="6" class="empty">No hay clientes.</td></tr>';
  refreshClientSelectors();
}

document.getElementById('clientSearch').oninput = debounce(e => renderClients(e.target.value), 120);
setupClientAutocomplete('deviceClientSearch', 'deviceClient', 'deviceClientSuggestions');
setupClientAutocomplete('saleClientSearch', 'saleClient', 'saleClientSuggestions');
setupClientAutocomplete('proformaClientSearch', 'proformaClient', 'proformaClientSuggestions');
document.addEventListener('mousedown', e => {
  if (!e.target.closest('.client-autocomplete')) {
    closeClientSuggestions('deviceClientSuggestions');
    closeClientSuggestions('saleClientSuggestions');
    closeClientSuggestions('proformaClientSuggestions');
  }
});
document.getElementById('clientForm').onsubmit = e => {
  e.preventDefault();
  const id = document.getElementById('clientId').value;
  const cedula = document.getElementById('clientCedula').value.trim();
  const duplicate = db.clients.find(c => c.cedula === cedula && c.id !== id);
  if (duplicate) return toast('Ya existe un cliente con esa cédula/RUC');
  const obj = {
    id: id || uid('CLI'),
    cedula,
    name: document.getElementById('clientName').value.trim(),
    phone: document.getElementById('clientPhone').value.trim(),
    email: document.getElementById('clientEmail').value.trim(),
    address: document.getElementById('clientAddress').value.trim()
  };
  if (id) db.clients = db.clients.map(c => c.id === id ? obj : c); else db.clients.push(obj);
  e.target.reset();
  document.getElementById('clientId').value = '';
  save();
  toast('Cliente guardado');
};

window.editClient = id => {
  const c = db.clients.find(x => x.id === id);
  if (!c) return;
  showView('clientes');
  document.getElementById('clientId').value = c.id;
  document.getElementById('clientCedula').value = c.cedula;
  document.getElementById('clientName').value = c.name;
  document.getElementById('clientPhone').value = c.phone;
  document.getElementById('clientEmail').value = c.email || '';
  document.getElementById('clientAddress').value = c.address;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function closeClientHistoryModal() {
  const modal = document.getElementById('clientHistoryModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

document.querySelectorAll('[data-close-client-history]').forEach(el => el.onclick = closeClientHistoryModal);

window.openClientHistory = id => {
  const c = db.clients.find(x => x.id === id);
  if (!c) return;
  const devices = db.devices.filter(d => d.clientId === id).slice().reverse();
  const sales = db.sales.filter(s => s.clientId === id).slice().reverse();
  const total = sales.reduce((sum, s) => sum + Number(s.total || 0), 0);
  const deviceRows = devices.map(d => `<tr>
    <td><strong>${esc(d.order)}</strong><br><span class="muted">${esc(d.date || '')}</span></td>
    <td>${esc(deviceTypeLabel(d))}<br><span class="muted">${esc(d.brand || '')} ${esc(d.model || '')}</span></td>
    <td>${esc(d.serial || '-')}</td>
    <td><span class="status ${deviceIsRepaired(d) ? 'good' : 'warn'}">${esc(d.status || '')}</span></td>
    <td>${esc(warrantyLabel(d))}</td>
    <td><button class="mini" onclick="printWorkOrder('${d.id}')">Orden</button></td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">Este cliente no tiene equipos registrados.</td></tr>';
  const saleRows = sales.map(s => `<tr>
    <td><strong>${esc(s.number)}</strong></td><td>${esc(saleTypeLabel(s))}</td><td>${esc(s.date || '')}</td><td>${esc(salePaymentLabel(s))}</td><td><strong>${money(s.total)}</strong><br><span class="muted">Saldo: ${money(saleBalanceAmount(s))}</span></td><td><button class="mini" onclick="printInvoice('${s.id}','a4')">Imprimir</button></td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">Este cliente no tiene facturas registradas.</td></tr>';
  document.getElementById('clientHistoryContent').innerHTML = `
    <div class="history-head"><div><span class="history-kicker">HISTORIAL DEL CLIENTE</span><h2>${esc(c.name)}</h2><p>${esc(c.cedula)} · ${esc(c.phone || '-')} · ${esc(c.email || '-')}</p></div></div>
    <div class="history-summary-grid">
      <div class="history-stat"><span>Equipos</span><strong>${devices.length}</strong></div>
      <div class="history-stat"><span>Facturas</span><strong>${sales.length}</strong></div>
      <div class="history-stat"><span>Total facturado</span><strong>${money(total)}</strong></div>
    </div>
    <section class="history-section"><h3>Equipos y reparaciones</h3><div class="table-wrap"><table><thead><tr><th>Orden</th><th>Equipo</th><th>Serie</th><th>Estado</th><th>Garantía</th><th></th></tr></thead><tbody>${deviceRows}</tbody></table></div></section>
    <section class="history-section"><h3>Compras y facturas</h3><div class="table-wrap"><table><thead><tr><th>Comprobante</th><th>Tipo</th><th>Fecha</th><th>Pago</th><th>Total</th><th></th></tr></thead><tbody>${saleRows}</tbody></table></div></section>`;
  const modal = document.getElementById('clientHistoryModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
};

function deviceTypeLabel(d) {
  return d?.type === 'Otro' ? (d.customType || 'Otro') : (d?.type || '');
}

function toggleCustomDeviceType() {
  const isOther = document.getElementById('deviceType').value === 'Otro';
  const wrap = document.getElementById('deviceCustomTypeWrap');
  wrap.classList.toggle('visible', isOther);
  document.getElementById('deviceCustomType').required = isOther;
  if (!isOther) document.getElementById('deviceCustomType').value = '';
}
document.getElementById('deviceType').onchange = toggleCustomDeviceType;
toggleCustomDeviceType();

function nextOrderNumber() {
  const nums = db.devices.map(d => Number(String(d.order || '').replace(/\D/g, '')) || 0);
  return 'OT-' + String(Math.max(0, ...nums) + 1).padStart(6, '0');
}

function renderDevices(filter = '') {
  const q = filter.toLowerCase();
  const statusFilter = document.getElementById('deviceStatusFilter')?.value || 'all';
  const filtered = db.devices.filter(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    const matchesText = [d.order, c?.name, c?.cedula, d.type, d.customType, d.brand, d.model, d.serial, d.damage, d.status].join(' ').toLowerCase().includes(q);
    const matchesStatus = statusFilter === 'all' || (statusFilter === 'pending' ? !deviceIsRepaired(d) : d.status === statusFilter);
    return matchesText && matchesStatus;
  });
  document.getElementById('deviceCountAll').textContent = db.devices.length;
  document.getElementById('deviceCountPending').textContent = db.devices.filter(d => !deviceIsRepaired(d)).length;
  document.getElementById('deviceCountRepaired').textContent = db.devices.filter(d => d.status === 'Reparado').length;
  document.getElementById('deviceCountDelivered').textContent = db.devices.filter(d => d.status === 'Entregado').length;

  document.getElementById('devicesTable').innerHTML = filtered.map(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    const alreadyInvoiced = !!d.repairSaleId;
    const invoiceButton = alreadyInvoiced ? `<button class="mini good-mini" onclick="printInvoice('${d.repairSaleId}')">Factura</button>${isOwner() ? `<button class="mini danger" onclick="deleteInvoice('${d.repairSaleId}', true)">Eliminar factura</button>` : ''}` : '';
    const repairButton = !alreadyInvoiced ? `<button class="mini primary-mini repair-invoice-action" onclick="openRepair('${d.id}')">Factura de reparación</button>` : '';
    const deliveredButton = d.status === 'Reparado' ? `<button class="mini" onclick="markDelivered('${d.id}')">Entregado</button>` : '';
    return `<tr>
      <td><strong>${esc(d.order)}</strong><br><span class="muted">${esc(d.date || '')}</span></td>
      <td>${esc(c?.name || '')}</td>
      <td>${esc(deviceTypeLabel(d))}<br><span class="muted">${esc(d.brand)} ${esc(d.model)}</span></td>
      <td>${esc(d.serial || '-')}</td>
      <td>${esc(d.damage)}</td>
      <td><span class="status ${d.status === 'Reparado' || d.status === 'Entregado' ? 'good' : ''}">${esc(d.status)}</span></td>
      <td><div class="action-row">${invoiceButton}${deliveredButton}<button class="mini" onclick="editDevice('${d.id}')">Editar</button><button class="mini" onclick="printWorkOrder('${d.id}')">Orden</button>${repairButton}${isOwner() ? `<button class="mini danger" onclick="deleteDevice('${d.id}')">Eliminar equipo</button>` : ''}</div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No hay equipos.</td></tr>';

}

document.getElementById('deviceSearch').oninput = debounce(e => renderDevices(e.target.value), 120);
document.getElementById('deviceStatusFilter').onchange = () => renderDevices(document.getElementById('deviceSearch').value || '');
document.getElementById('deviceForm').onsubmit = e => {
  e.preventDefault();
  const shouldPrint = e.submitter?.id === 'savePrintDeviceBtn';
  const id = document.getElementById('deviceId').value;
  const prev = db.devices.find(d => d.id === id);
  if (!document.getElementById('deviceClient').value) return toast('Busque y seleccione un cliente por nombre o cédula');
  if (document.getElementById('deviceType').value === 'Otro' && !document.getElementById('deviceCustomType').value.trim()) return toast('Escribe el nombre del otro equipo');
  const warrantyDays = Math.max(0, Number(document.getElementById('deviceWarrantyDays').value || 0));
  const warrantyStart = prev?.warrantyStart || '';
  const obj = {
    ...(prev || {}),
    id: id || uid('EQ'),
    order: prev?.order || nextOrderNumber(),
    clientId: document.getElementById('deviceClient').value,
    type: document.getElementById('deviceType').value,
    customType: document.getElementById('deviceType').value === 'Otro' ? document.getElementById('deviceCustomType').value.trim() : '',
    brand: document.getElementById('deviceBrand').value.trim(),
    model: document.getElementById('deviceModel').value.trim(),
    serial: document.getElementById('deviceSerial').value.trim(),
    damage: document.getElementById('deviceDamage').value.trim(),
    notes: document.getElementById('deviceNotes').value.trim(),
    status: document.getElementById('deviceStatus').value,
    warrantyDays,
    warrantyNotes: document.getElementById('deviceWarrantyNotes').value.trim(),
    warrantyStart,
    warrantyUntil: warrantyStart && warrantyDays ? addDaysToDateKey(warrantyStart, warrantyDays) : '',
    date: prev?.date || now()
  };
  if (id) db.devices = db.devices.map(d => d.id === id ? obj : d); else db.devices.push(obj);
  const savedId = obj.id;
  e.target.reset();
  document.getElementById('deviceId').value = '';
  document.getElementById('deviceCustomType').value = '';
  document.getElementById('deviceWarrantyPeriod').value = '';
  toggleCustomDeviceType();
  save();
  if (shouldPrint) printWorkOrder(savedId);
  toast(shouldPrint ? 'Equipo guardado. Orden lista para imprimir' : 'Equipo guardado');
};

window.editDevice = id => {
  const d = db.devices.find(x => x.id === id);
  if (!d) return;
  showView('equipos');
  const map = {
    deviceId: 'id', deviceClient: 'clientId', deviceType: 'type', deviceBrand: 'brand', deviceModel: 'model', deviceSerial: 'serial', deviceDamage: 'damage', deviceNotes: 'notes', deviceStatus: 'status'
  };
  Object.entries(map).forEach(([el, prop]) => document.getElementById(el).value = d[prop] ?? '');
  const selectedClient = db.clients.find(c => c.id === d.clientId);
  document.getElementById('deviceClientSearch').value = clientDisplayText(selectedClient);
  closeClientSuggestions('deviceClientSuggestions');
  document.getElementById('deviceCustomType').value = d.customType || '';
  document.getElementById('deviceWarrantyDays').value = Number(d.warrantyDays || 0);
  document.getElementById('deviceWarrantyNotes').value = d.warrantyNotes || '';
  document.getElementById('deviceWarrantyPeriod').value = d.warrantyStart && d.warrantyUntil ? `${d.warrantyStart} al ${d.warrantyUntil}` : '';
  toggleCustomDeviceType();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.markDelivered = id => {
  const d = db.devices.find(x => x.id === id);
  if (!d) return;
  d.status = 'Entregado';
  d.deliveredAt = now();
  save();
  toast('Equipo marcado como entregado');
};

window.deleteDevice = id => {
  if (!isOwner()) return toast('Solo el propietario puede eliminar equipos');
  const d = db.devices.find(x => x.id === id);
  if (!d) return;
  if (d.repairSaleId) return toast('Primero elimina la factura de reparación vinculada.');
  if (!confirm(`¿Eliminar definitivamente la orden ${d.order}?`)) return;
  db.devices = db.devices.filter(x => x.id !== id);
  if (activeRepairDeviceId === id) { activeRepairDeviceId = ''; repairCart = []; }
  save();
  toast('Equipo eliminado');
};

function renderRepairOrderOptions() {
  const select = document.getElementById('repairOrderSelect');
  const current = activeRepairDeviceId || select.value;
  const q = (document.getElementById('repairOrderSearch')?.value || '').toLowerCase();
  const rows = db.devices.slice().reverse().filter(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    return !q || [d.order,c?.name,c?.cedula,deviceTypeLabel(d),d.brand,d.model,d.serial].join(' ').toLowerCase().includes(q);
  });
  select.innerHTML = '<option value="">Seleccione una orden...</option>' + rows.map(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    const tag = d.repairSaleId ? ' · FACTURADA' : '';
    return `<option value="${d.id}" ${d.id === current ? 'selected' : ''}>${esc(d.order)} · ${esc(c?.cedula || '')} · ${esc(c?.name || '')} · ${esc(deviceTypeLabel(d))}${tag}</option>`;
  }).join('');
  if (current && db.devices.some(d => d.id === current)) select.value = current;
}

function productDisplayText(product) {
  if (!product) return '';
  return [product.code || '', product.name || ''].filter(Boolean).join(' — ');
}

function closeProductSuggestions(suggestionsId) {
  const box = document.getElementById(suggestionsId);
  if (!box) return;
  box.innerHTML = '';
  box.classList.remove('open');
  const input = box.closest('.product-autocomplete')?.querySelector('.search-select-input');
  if (input) input.setAttribute('aria-expanded', 'false');
}

function setActiveProductSuggestion(box, index) {
  const items = [...box.querySelectorAll('.product-suggestion')];
  if (!items.length) return -1;
  const next = Math.max(0, Math.min(index, items.length - 1));
  items.forEach((item, i) => {
    item.classList.toggle('active', i === next);
    item.setAttribute('aria-selected', i === next ? 'true' : 'false');
  });
  items[next].scrollIntoView({ block: 'nearest' });
  box.dataset.activeIndex = String(next);
  return next;
}

function updateProductPreview(hiddenId, previewId) {
  const hidden = document.getElementById(hiddenId);
  const preview = document.getElementById(previewId);
  if (!hidden || !preview) return;
  const p = db.products.find(x => x.id === hidden.value);
  preview.innerHTML = p
    ? `<strong>${esc(p.code || '-')} — ${esc(p.name)}</strong> · Categoría: <strong>${esc(p.category || '-')}</strong> · Precio: <strong>${money(p.price)}</strong> · Stock disponible: <strong>${Number(p.stock || 0)}</strong>${p.brand ? ` · Marca: ${esc(p.brand)}` : ''}`
    : 'Busca y selecciona un producto para ver código, precio y stock disponible.';
}

function renderProductSuggestions(searchId, hiddenId, suggestionsId, previewId) {
  const input = document.getElementById(searchId);
  const hidden = document.getElementById(hiddenId);
  const box = document.getElementById(suggestionsId);
  if (!input || !hidden || !box) return;

  const q = normalizeSearchText(input.value);
  const selected = db.products.find(p => p.id === hidden.value);
  if (selected && normalizeSearchText(input.value) === normalizeSearchText(productDisplayText(selected))) {
    closeProductSuggestions(suggestionsId);
    updateProductPreview(hiddenId, previewId);
    return;
  }

  hidden.value = '';
  updateProductPreview(hiddenId, previewId);
  if (!q) {
    closeProductSuggestions(suggestionsId);
    return;
  }

  const matches = db.products
    .filter(p => Number(p.stock) > 0 && normalizeSearchText(`${p.code || ''} ${p.name || ''} ${p.category || ''} ${p.brand || ''}`).includes(q))
    .slice(0, 12);

  box.dataset.activeIndex = '-1';
  if (!matches.length) {
    box.innerHTML = '<div class="product-suggestion-empty">No se encontraron productos disponibles.</div>';
    box.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    return;
  }

  box.innerHTML = matches.map(p => `
    <button type="button" class="product-suggestion" role="option" aria-selected="false" data-product-id="${esc(p.id)}">
      <strong>${esc(p.code || 'Sin código')} — ${esc(p.name || 'Sin nombre')}</strong>
      <span>${esc(p.category || 'Sin categoría')} · Stock: ${Number(p.stock || 0)} · ${money(p.price)}</span>
    </button>
  `).join('');
  box.classList.add('open');
  input.setAttribute('aria-expanded', 'true');
}

function selectProductFromSearch(searchId, hiddenId, suggestionsId, previewId, productId) {
  const product = db.products.find(p => p.id === productId);
  if (!product) return;
  document.getElementById(hiddenId).value = product.id;
  document.getElementById(searchId).value = productDisplayText(product);
  closeProductSuggestions(suggestionsId);
  updateProductPreview(hiddenId, previewId);
}

function setupProductAutocomplete(searchId, hiddenId, suggestionsId, previewId) {
  const input = document.getElementById(searchId);
  const hidden = document.getElementById(hiddenId);
  const box = document.getElementById(suggestionsId);
  if (!input || !hidden || !box) return;

  const renderSuggestionsDebounced = debounce(() => renderProductSuggestions(searchId, hiddenId, suggestionsId, previewId), 90);
  input.addEventListener('input', renderSuggestionsDebounced);
  input.addEventListener('focus', () => {
    if (input.value.trim() && !hidden.value) renderProductSuggestions(searchId, hiddenId, suggestionsId, previewId);
  });
  input.addEventListener('keydown', e => {
    if (!box.classList.contains('open')) {
      if (e.key === 'ArrowDown' && input.value.trim()) {
        renderProductSuggestions(searchId, hiddenId, suggestionsId, previewId);
        setActiveProductSuggestion(box, 0);
        e.preventDefault();
      }
      return;
    }

    const items = [...box.querySelectorAll('.product-suggestion')];
    if (!items.length) {
      if (e.key === 'Escape') closeProductSuggestions(suggestionsId);
      return;
    }

    let active = Number(box.dataset.activeIndex ?? -1);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = active < items.length - 1 ? active + 1 : 0;
      setActiveProductSuggestion(box, active);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = active > 0 ? active - 1 : items.length - 1;
      setActiveProductSuggestion(box, active);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      selectProductFromSearch(searchId, hiddenId, suggestionsId, previewId, items[active].dataset.productId);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeProductSuggestions(suggestionsId);
    }
  });
  box.addEventListener('mousedown', e => {
    const item = e.target.closest('.product-suggestion');
    if (!item) return;
    e.preventDefault();
    selectProductFromSearch(searchId, hiddenId, suggestionsId, previewId, item.dataset.productId);
  });
}

function refreshProductAutocomplete(searchId, hiddenId, suggestionsId, previewId) {
  const hidden = document.getElementById(hiddenId);
  const input = document.getElementById(searchId);
  if (!hidden || !input) return;
  const selected = db.products.find(p => p.id === hidden.value && Number(p.stock) > 0);
  if (hidden.value && !selected) {
    hidden.value = '';
    input.value = '';
  } else if (selected && !input.value.trim()) {
    input.value = productDisplayText(selected);
  }
  closeProductSuggestions(suggestionsId);
  updateProductPreview(hiddenId, previewId);
}

setupProductAutocomplete('saleProductSearch', 'saleProduct', 'saleProductSuggestions', 'saleProductPreview');
setupProductAutocomplete('repairProductSearch', 'repairProduct', 'repairProductSuggestions', 'repairProductPreview');
setupProductAutocomplete('proformaProductSearch', 'proformaProduct', 'proformaProductSuggestions', 'proformaProductPreview');

document.addEventListener('mousedown', e => {
  if (!e.target.closest('.product-autocomplete')) {
    closeProductSuggestions('saleProductSuggestions');
    closeProductSuggestions('repairProductSuggestions');
    closeProductSuggestions('proformaProductSuggestions');
  }
});

document.getElementById('repairOrderSearch').oninput = debounce(renderRepairOrderOptions, 120);

document.getElementById('loadRepairOrderBtn').onclick = () => {
  const id = document.getElementById('repairOrderSelect').value;
  if (!id) return toast('Seleccione una orden');
  loadRepairOrder(id, true);
};

document.getElementById('repairOrderSelect').onchange = e => {
  if (!e.target.value) {
    activeRepairDeviceId = '';
    repairCart = [];
    renderRepairWorkspace();
    return;
  }
  loadRepairOrder(e.target.value, false);
};

window.openRepair = id => {
  showView('reparaciones');
  renderRepairOrderOptions();
  loadRepairOrder(id, false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

document.getElementById('backToDevicesBtn').onclick = () => {
  showView('equipos');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function loadRepairOrder(id, scroll = false) {
  const d = db.devices.find(x => x.id === id);
  if (!d) return toast('Orden no encontrada');
  if (activeRepairDeviceId !== id) repairCart = [];
  activeRepairDeviceId = id;
  document.getElementById('repairOrderSelect').value = id;
  renderRepairWorkspace();
  if (scroll) setTimeout(() => document.getElementById('repairPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
}

function renderRepairWorkspace() {
  const d = db.devices.find(x => x.id === activeRepairDeviceId);
  const summary = document.getElementById('repairOrderSummary');
  const label = document.getElementById('repairStatusLabel');
  const finish = document.getElementById('finishRepairBtn');

  if (!d) {
    summary.className = 'repair-summary empty';
    summary.textContent = 'Seleccione una orden para comenzar.';
    label.className = 'status warn';
    label.textContent = 'Seleccione una orden';
    finish.disabled = true;
    renderRepairCart();
    return;
  }

  const c = db.clients.find(x => x.id === d.clientId);
  summary.className = 'repair-summary';
  summary.innerHTML = `<div class="repair-summary-grid">
    <div class="repair-summary-item"><span>Orden</span><strong>${esc(d.order)}</strong></div>
    <div class="repair-summary-item"><span>Cliente</span><strong>${esc(c?.name || '')}</strong></div>
    <div class="repair-summary-item"><span>Equipo</span><strong>${esc(deviceTypeLabel(d))} · ${esc(d.brand)} ${esc(d.model)}</strong></div>
    <div class="repair-summary-item"><span>Daño</span><strong>${esc(d.damage)}</strong></div>
  </div>`;

  if (d.repairSaleId) {
    label.className = 'status good';
    label.textContent = 'Reparación facturada';
    finish.disabled = true;
    finish.textContent = 'Esta reparación ya fue facturada';
  } else {
    label.className = 'status warn';
    label.textContent = d.status || 'En reparación';
    finish.disabled = false;
    finish.textContent = '✓ Marcar reparado y generar factura';
  }
  renderRepairCart();
}

document.getElementById('addRepairProductBtn').onclick = () => {
  const d = db.devices.find(x => x.id === activeRepairDeviceId);
  if (!d) return toast('Primero seleccione una orden');
  if (d.repairSaleId) return toast('Esta reparación ya fue facturada');
  const id = document.getElementById('repairProduct').value;
  const qty = Number(document.getElementById('repairQty').value || 1);
  const p = db.products.find(x => x.id === id);
  if (!p) return toast('Seleccione un producto');
  if (qty <= 0) return toast('Ingrese una cantidad válida');
  const inCart = repairCart.filter(i => i.type === 'product' && i.productId === id).reduce((a, i) => a + Number(i.qty), 0);
  if (qty + inCart > Number(p.stock)) return toast('Stock insuficiente');
  repairCart.push({ type: 'product', productId: p.id, code: p.code, name: p.name, qty, price: Number(p.price) });
  document.getElementById('repairQty').value = 1;
  document.getElementById('repairProduct').value = '';
  document.getElementById('repairProductSearch').value = '';
  closeProductSuggestions('repairProductSuggestions');
  updateProductPreview('repairProduct', 'repairProductPreview');
  renderRepairCart();
};

window.removeRepairCart = idx => {
  repairCart.splice(idx, 1);
  renderRepairCart();
};


function renderRepairCart() {
  const gross = repairCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const parts = splitIncludedTax(gross);
  const subtotal = parts.subtotal;
  const total = parts.total;
  const taxRate = parts.taxRate;
  document.getElementById('repairCartList').innerHTML = repairCart.map((i, idx) => `
    <div class="cart-item"><div><strong>${svgIcon(i.type === 'service' ? 'tools' : 'box', 'item-inline-icon')}${esc(i.name)}</strong><div class="muted">${i.type !== 'service' ? `${esc(i.code || '')} · ` : ''}${i.qty} × ${money(i.price)}</div></div><div class="cart-item-price"><strong>${money(i.qty * i.price)}</strong><button class="mini danger" onclick="removeRepairCart(${idx})">×</button></div></div>
  `).join('') || '<div class="empty">Aún no se han agregado productos a la reparación.</div>';
  document.getElementById('repairSubtotal').textContent = money(subtotal);
  document.getElementById('repairTax').textContent = money(parts.tax);
  document.getElementById('repairTaxLabel').textContent = `IVA incluido (${taxRate}%)`;
  document.getElementById('repairTotal').textContent = money(total);
  setCheckoutPaymentUi('repair', total);
}

document.getElementById('finishRepairBtn').onclick = () => {
  if (!db.cash.open) return toast('Debe abrir la caja antes de cobrar la reparación');
  const d = db.devices.find(x => x.id === activeRepairDeviceId);
  if (!d) return toast('Seleccione una orden');
  if (d.repairSaleId) return toast('Esta reparación ya tiene factura');
  if (!repairCart.length) return toast('Agregue al menos un producto a la reparación');

  for (const i of repairCart.filter(i => i.type === 'product')) {
    const p = db.products.find(x => x.id === i.productId);
    if (!p || Number(p.stock) < Number(i.qty)) return toast('Stock insuficiente para ' + i.name);
  }

  const c = db.clients.find(x => x.id === d.clientId);
  if (!c) return toast('El equipo no tiene un cliente válido');

  const gross = repairCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const parts = splitIncludedTax(gross);
  const { subtotal, taxRate, tax, total } = parts;
  const paymentInfo = getCheckoutPayment('repair', total);
  if (paymentInfo.error) return toast(paymentInfo.error);
  const initialPayment = paymentInfo.paid > 0 ? makePaymentRecord(paymentInfo.paid, document.getElementById('repairPaymentMethod').value, 'Pago inicial') : null;
  const sale = {
    id: uid('VTA'),
    number: nextInvoiceNumber(),
    source: 'repair',
    order: d.order,
    deviceId: d.id,
    date: now(),
    dateKey: today(),
    clientId: c.id,
    clientName: c.name,
    clientCedula: c.cedula,
    clientPhone: c.phone,
    clientEmail: c.email || '',
    taxIncluded: true,
    payment: document.getElementById('repairPaymentMethod').value,
    items: clone(repairCart),
    subtotal, taxRate, tax, total,
    amountPaid: paymentInfo.paid,
    balance: paymentInfo.balance,
    paymentStatus: paymentInfo.status,
    payments: initialPayment ? [initialPayment] : []
  };

  sale.items.filter(i => i.type === 'product').forEach(i => {
    const p = db.products.find(x => x.id === i.productId);
    p.stock -= Number(i.qty);
  });

  db.sales.push(sale);
  d.status = 'Reparado';
  d.repairedAt = now();
  d.repairSaleId = sale.id;
  d.warrantyStart = Number(d.warrantyDays || 0) > 0 ? today() : '';
  d.warrantyUntil = d.warrantyStart ? addDaysToDateKey(d.warrantyStart, d.warrantyDays) : '';
  if (paymentInfo.paid > 0) {
    db.cash.movements.push({ id: uid('MOV'), saleId: sale.id, paymentId: initialPayment?.id || '', date: now(), type: 'ingreso', amount: paymentInfo.paid, concept: `Reparación ${d.order} · ${sale.number}` });
  }

  repairCart = [];
  document.getElementById('repairPaymentMode').value = 'full';
  save();
  renderRepairCart();
  printInvoice(sale.id);
  toast(paymentInfo.balance > 0 ? `Reparación facturada · Saldo pendiente ${money(paymentInfo.balance)}` : 'Reparación finalizada y pagada');
};

window.printWorkOrder = id => {
  const d = db.devices.find(x => x.id === id);
  if (!d) return;
  const c = db.clients.find(x => x.id === d.clientId);
  const logo = db.company.logo ? `<img src="${db.company.logo}" class="doc-logo">` : '';
  const body = `
    <div class="doc-head"><div>${logo}</div><div class="doc-company"><h1>${esc(db.company.name)}</h1><p>${esc(db.company.legal || '')}<br>RUC: ${esc(db.company.ruc || '-')} · Tel: ${esc(db.company.phone || '-')}<br>${esc(db.company.address || '')}</p></div><div class="doc-number"><span>ORDEN DE SERVICIO</span><strong>${esc(d.order)}</strong></div></div>
    <div class="doc-card-grid"><div class="doc-card"><span>CLIENTE</span><b>${esc(c?.name || '')}</b><small>${esc(c?.cedula || '')} · ${esc(c?.phone || '')}</small></div><div class="doc-card"><span>RECEPCIÓN</span><b>${esc(d.date || '')}</b><small>Estado: ${esc(d.status)}</small></div></div>
    <div class="doc-section"><h3>Datos del equipo</h3><table><tbody><tr><th>Tipo</th><td>${esc(deviceTypeLabel(d))}</td><th>Marca</th><td>${esc(d.brand)}</td></tr><tr><th>Modelo</th><td>${esc(d.model)}</td><th>Serie</th><td>${esc(d.serial || '-')}</td></tr></tbody></table></div>
    <div class="doc-section"><h3>Daño reportado</h3><p>${esc(d.damage)}</p></div>
    <div class="doc-section"><h3>Observaciones</h3><p>${esc(d.notes || 'Sin observaciones.')}</p></div>
    <div class="doc-section"><h3>Garantía de reparación</h3><p><strong>${esc(warrantyLabel(d))}</strong>${d.warrantyNotes ? `<br>${esc(d.warrantyNotes)}` : ''}</p></div>
    ${db.company.serviceClause ? `<div class="doc-section doc-terms"><h3>Cláusulas / condiciones de servicio</h3><p>${esc(db.company.serviceClause).replace(/\n/g, '<br>')}</p></div>` : ''}
    <div class="signatures"><div>____________________________<br>Firma del cliente</div><div>____________________________<br>Recepción / técnico</div></div>
  `;
  printHtml(`Orden ${d.order}`, body, 'order');
};

function renderProducts(filter = '') {
  const q = filter.toLowerCase();
  document.getElementById('productsTable').innerHTML = db.products.filter(p => [p.code, p.name, p.category, p.brand].join(' ').toLowerCase().includes(q)).map(p => `
    <tr><td>${esc(p.code)}</td><td><strong>${esc(p.name)}</strong><br><span class="muted">${esc(p.category || '')}</span></td><td>${money(p.cost)}</td><td>${money(p.price)}</td><td>${p.stock}</td><td><span class="status ${Number(p.stock) <= Number(p.min) ? 'bad' : 'good'}">${Number(p.stock) <= Number(p.min) ? 'Stock bajo' : 'Disponible'}</span></td><td><button class="mini" onclick="editProduct('${p.id}')">Editar</button></td></tr>
  `).join('') || '<tr><td colspan="7" class="empty">No hay productos.</td></tr>';

  refreshProductAutocomplete('saleProductSearch', 'saleProduct', 'saleProductSuggestions', 'saleProductPreview');
  refreshProductAutocomplete('repairProductSearch', 'repairProduct', 'repairProductSuggestions', 'repairProductPreview');
  refreshProductAutocomplete('proformaProductSearch', 'proformaProduct', 'proformaProductSuggestions', 'proformaProductPreview');
}

function renderInventory() {
  const q = (document.getElementById('inventorySearch')?.value || '').toLowerCase();
  const f = document.getElementById('inventoryFilter')?.value || 'all';
  const rows = db.products.filter(p => {
    const match = [p.code, p.name, p.category, p.brand].join(' ').toLowerCase().includes(q);
    const stock = Number(p.stock || 0), min = Number(p.min || 0);
    const state = f === 'all' || (f === 'available' && stock > 0) || (f === 'low' && stock <= min) || (f === 'zero' && stock <= 0);
    return match && state;
  });
  const units = db.products.reduce((a,p)=>a+Number(p.stock||0),0);
  const costValue = db.products.reduce((a,p)=>a+Number(p.stock||0)*Number(p.cost||0),0);
  const saleValue = db.products.reduce((a,p)=>a+Number(p.stock||0)*Number(p.price||0),0);
  document.getElementById('inventoryUnits').textContent = units;
  document.getElementById('inventoryCostValue').textContent = money(costValue);
  document.getElementById('inventorySaleValue').textContent = money(saleValue);
  document.getElementById('inventoryLow').textContent = db.products.filter(p=>Number(p.stock||0)<=Number(p.min||0)).length;
  document.getElementById('inventoryTable').innerHTML = rows.map(p => {
    const stock=Number(p.stock||0), min=Number(p.min||0);
    const cls = stock<=0 ? 'bad' : stock<=min ? 'warn' : 'good';
    const label = stock<=0 ? 'Sin stock' : stock<=min ? 'Stock bajo' : 'Disponible';
    return `<tr><td>${esc(p.code)}</td><td><strong>${esc(p.name)}</strong></td><td>${esc(p.category||'-')}</td><td>${esc(p.brand||'-')}</td><td>${money(p.cost)}</td><td>${money(p.price)}</td><td><strong>${stock}</strong></td><td><span class="status ${cls}">${label}</span></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No hay productos para mostrar.</td></tr>';
}

document.getElementById('inventorySearch').oninput = debounce(renderInventory, 120);
document.getElementById('inventoryFilter').onchange = renderInventory;

document.getElementById('productSearch').oninput = debounce(e => renderProducts(e.target.value), 120);
document.getElementById('productForm').onsubmit = e => {
  e.preventDefault();
  const id = document.getElementById('productId').value;
  const code = document.getElementById('productCode').value.trim();
  const duplicateCode = db.products.find(p => p.id !== id && String(p.code || '').trim().toLowerCase() === code.toLowerCase());
  if (duplicateCode) return toast(`El código ${code} ya está registrado en ${duplicateCode.name}`);
  const obj = {
    id: id || uid('PROD'),
    code,
    name: document.getElementById('productName').value.trim(),
    category: document.getElementById('productCategory').value.trim(),
    brand: document.getElementById('productBrand').value.trim(),
    cost: Number(document.getElementById('productCost').value || 0),
    price: Number(document.getElementById('productPrice').value || 0),
    stock: Number(document.getElementById('productStock').value || 0),
    min: Number(document.getElementById('productMin').value || 0)
  };
  if (id) db.products = db.products.map(p => p.id === id ? obj : p); else db.products.push(obj);
  e.target.reset();
  document.getElementById('productId').value = '';
  document.getElementById('productMin').value = 2;
  save();
  toast('Producto guardado');
};

window.editProduct = id => {
  const p = db.products.find(x => x.id === id);
  if (!p) return;
  showView('productos');
  const map = { productId: 'id', productCode: 'code', productName: 'name', productCategory: 'category', productBrand: 'brand', productCost: 'cost', productPrice: 'price', productStock: 'stock', productMin: 'min' };
  Object.entries(map).forEach(([el, prop]) => document.getElementById(el).value = p[prop] ?? '');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function renderSaleCart() {
  const gross = saleCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const parts = splitIncludedTax(gross);
  const subtotal = parts.subtotal;
  const total = parts.total;
  const taxRate = parts.taxRate;
  document.getElementById('cartList').innerHTML = saleCart.map((i, idx) => `
    <div class="cart-item"><div><strong>${svgIcon('box', 'item-inline-icon')}${esc(i.name)}</strong><div class="muted">${esc(i.code || '')} · ${i.qty} × ${money(i.price)}</div></div><div class="cart-item-price"><strong>${money(i.qty * i.price)}</strong><button class="mini danger" onclick="removeSaleCart(${idx})">×</button></div></div>
  `).join('') || '<div class="empty">Agregue productos a la venta.</div>';
  document.getElementById('saleSubtotal').textContent = money(subtotal);
  document.getElementById('saleTax').textContent = money(parts.tax);
  document.getElementById('saleTaxLabel').textContent = `IVA incluido (${taxRate}%)`;
  document.getElementById('saleTotal').textContent = money(total);
  setCheckoutPaymentUi('sale', total);
}

document.getElementById('addProductBtn').onclick = () => {
  const id = document.getElementById('saleProduct').value;
  const qty = Number(document.getElementById('saleQty').value || 1);
  const p = db.products.find(x => x.id === id);
  if (!p) return toast('Seleccione un producto');
  if (qty <= 0) return toast('Ingrese una cantidad válida');
  const inCart = saleCart.filter(i => i.productId === id).reduce((a, i) => a + Number(i.qty), 0);
  if (qty + inCart > Number(p.stock)) return toast('Stock insuficiente');
  saleCart.push({ type: 'product', productId: p.id, code: p.code, name: p.name, qty, price: Number(p.price) });
  document.getElementById('saleQty').value = 1;
  document.getElementById('saleProduct').value = '';
  document.getElementById('saleProductSearch').value = '';
  closeProductSuggestions('saleProductSuggestions');
  updateProductPreview('saleProduct', 'saleProductPreview');
  renderSaleCart();
};

window.removeSaleCart = idx => {
  saleCart.splice(idx, 1);
  renderSaleCart();
};

function nextInvoiceNumber() {
  const nums = db.sales.map(s => Number(String(s.number || '').replace(/\D/g, '')) || 0);
  return 'FAC-' + String(Math.max(0, ...nums) + 1).padStart(6, '0');
}

document.getElementById('salePaymentMode').onchange = () => {
  if (document.getElementById('salePaymentMode').value === 'partial') document.getElementById('saleAmountPaid').value = '0';
  renderSaleCart();
};
document.getElementById('saleAmountPaid').oninput = () => {
  const gross = saleCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  setCheckoutPaymentUi('sale', gross);
};
document.getElementById('repairPaymentMode').onchange = () => {
  if (document.getElementById('repairPaymentMode').value === 'partial') document.getElementById('repairAmountPaid').value = '0';
  renderRepairCart();
};
document.getElementById('repairAmountPaid').oninput = () => {
  const gross = repairCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  setCheckoutPaymentUi('repair', gross);
};

document.getElementById('finishSaleBtn').onclick = () => {
  if (!db.cash.open) return toast('Debe abrir la caja antes de vender');
  if (!saleCart.length) return toast('La venta está vacía');
  const cid = document.getElementById('saleClient').value;
  const c = db.clients.find(x => x.id === cid);
  if (!c) return toast('Seleccione un cliente');

  for (const i of saleCart) {
    const p = db.products.find(x => x.id === i.productId);
    if (!p || Number(p.stock) < Number(i.qty)) return toast('Stock insuficiente para ' + i.name);
  }

  const gross = saleCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const parts = splitIncludedTax(gross);
  const { subtotal, taxRate, tax, total } = parts;
  const paymentInfo = getCheckoutPayment('sale', total);
  if (paymentInfo.error) return toast(paymentInfo.error);
  const initialPayment = paymentInfo.paid > 0 ? makePaymentRecord(paymentInfo.paid, document.getElementById('paymentMethod').value, 'Pago inicial') : null;
  const sale = {
    id: uid('VTA'),
    number: nextInvoiceNumber(),
    source: 'sale',
    order: '',
    date: now(),
    dateKey: today(),
    clientId: c.id,
    clientName: c.name,
    clientCedula: c.cedula,
    clientPhone: c.phone,
    clientEmail: c.email || '',
    taxIncluded: true,
    payment: document.getElementById('paymentMethod').value,
    items: clone(saleCart),
    subtotal, taxRate, tax, total,
    amountPaid: paymentInfo.paid,
    balance: paymentInfo.balance,
    paymentStatus: paymentInfo.status,
    payments: initialPayment ? [initialPayment] : [],
    proformaId: activeProformaForSaleId || ''
  };

  sale.items.forEach(i => {
    const p = db.products.find(x => x.id === i.productId);
    p.stock -= Number(i.qty);
  });
  db.sales.push(sale);
  if (paymentInfo.paid > 0) {
    db.cash.movements.push({ id: uid('MOV'), saleId: sale.id, paymentId: initialPayment?.id || '', date: now(), type: 'ingreso', amount: paymentInfo.paid, concept: 'Venta ' + sale.number });
  }
  if (activeProformaForSaleId) {
    const pf = db.proformas.find(x => x.id === activeProformaForSaleId);
    if (pf) {
      pf.status = 'Convertida';
      pf.saleId = sale.id;
      pf.convertedAt = now();
    }
  }
  activeProformaForSaleId = '';
  saleCart = [];
  document.getElementById('saleClient').value = '';
  document.getElementById('saleClientSearch').value = '';
  closeClientSuggestions('saleClientSuggestions');
  document.getElementById('saleProduct').value = '';
  document.getElementById('saleProductSearch').value = '';
  closeProductSuggestions('saleProductSuggestions');
  updateProductPreview('saleProduct', 'saleProductPreview');
  document.getElementById('salePaymentMode').value = 'full';
  save();
  renderSaleCart();
  printInvoice(sale.id);
  toast(paymentInfo.balance > 0 ? `Venta registrada · Saldo pendiente ${money(paymentInfo.balance)}` : 'Venta registrada y pagada');
};


function nextProformaNumber() {
  const nums = db.proformas.map(p => Number(String(p.number || '').replace(/\D/g, '')) || 0);
  return 'PRO-' + String(Math.max(0, ...nums) + 1).padStart(6, '0');
}

function proformaStatus(pf) {
  if (pf?.status === 'Convertida') return 'Convertida';
  if (pf?.validUntil && String(pf.validUntil) < today()) return 'Vencida';
  return pf?.status || 'Vigente';
}

function renderProformaCart() {
  const gross = proformaCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const parts = splitIncludedTax(gross);
  const list = document.getElementById('proformaCartList');
  if (!list) return;
  list.innerHTML = proformaCart.map((i, idx) => `
    <div class="cart-item"><div><strong>${svgIcon('box', 'item-inline-icon')}${esc(i.name)}</strong><div class="muted">${esc(i.code || '')} · ${i.qty} × ${money(i.price)}</div></div><div class="cart-item-price"><strong>${money(i.qty * i.price)}</strong><button class="mini danger" onclick="removeProformaCart(${idx})">×</button></div></div>
  `).join('') || '<div class="empty">Agregue productos a la proforma.</div>';
  document.getElementById('proformaSubtotal').textContent = money(parts.subtotal);
  document.getElementById('proformaTax').textContent = money(parts.tax);
  document.getElementById('proformaTaxLabel').textContent = `IVA incluido (${parts.taxRate}%)`;
  document.getElementById('proformaTotal').textContent = money(parts.total);
}

document.getElementById('addProformaProductBtn').onclick = () => {
  const id = document.getElementById('proformaProduct').value;
  const qty = Number(document.getElementById('proformaQty').value || 1);
  const product = db.products.find(x => x.id === id);
  if (!product) return toast('Seleccione un producto');
  if (qty <= 0) return toast('Ingrese una cantidad válida');
  const already = proformaCart.filter(i => i.productId === id).reduce((sum, i) => sum + Number(i.qty || 0), 0);
  if (qty + already > Number(product.stock || 0)) return toast('La cantidad supera el stock disponible');
  proformaCart.push({ type: 'product', productId: product.id, code: product.code, name: product.name, qty, price: Number(product.price) });
  document.getElementById('proformaQty').value = 1;
  document.getElementById('proformaProduct').value = '';
  document.getElementById('proformaProductSearch').value = '';
  closeProductSuggestions('proformaProductSuggestions');
  updateProductPreview('proformaProduct', 'proformaProductPreview');
  renderProformaCart();
};

window.removeProformaCart = idx => {
  proformaCart.splice(idx, 1);
  renderProformaCart();
};

function saveProforma(printAfter = false) {
  if (!proformaCart.length) return toast('La proforma está vacía');
  const clientId = document.getElementById('proformaClient').value;
  const client = db.clients.find(c => c.id === clientId);
  if (!client) return toast('Seleccione un cliente');
  const validityDays = Math.max(1, Number(document.getElementById('proformaValidity').value || 7));
  const gross = proformaCart.reduce((sum, i) => sum + Number(i.price) * Number(i.qty), 0);
  const parts = splitIncludedTax(gross);
  const pf = {
    id: uid('COT'),
    number: nextProformaNumber(),
    date: now(),
    dateKey: today(),
    validityDays,
    validUntil: addDaysToDateKey(today(), validityDays),
    clientId: client.id,
    clientName: client.name,
    clientCedula: client.cedula,
    clientPhone: client.phone,
    clientEmail: client.email || '',
    clientAddress: client.address || '',
    items: clone(proformaCart),
    notes: document.getElementById('proformaNotes').value.trim(),
    taxIncluded: true,
    subtotal: parts.subtotal,
    taxRate: parts.taxRate,
    tax: parts.tax,
    total: parts.total,
    status: 'Vigente',
    saleId: ''
  };
  db.proformas.push(pf);
  proformaCart = [];
  document.getElementById('proformaClient').value = '';
  document.getElementById('proformaClientSearch').value = '';
  document.getElementById('proformaProduct').value = '';
  document.getElementById('proformaProductSearch').value = '';
  document.getElementById('proformaQty').value = 1;
  document.getElementById('proformaValidity').value = 7;
  document.getElementById('proformaNotes').value = '';
  closeClientSuggestions('proformaClientSuggestions');
  closeProductSuggestions('proformaProductSuggestions');
  updateProductPreview('proformaProduct', 'proformaProductPreview');
  save();
  renderProformaCart();
  if (printAfter) printProforma(pf.id);
  toast(`Proforma ${pf.number} guardada`);
}

document.getElementById('saveProformaBtn').onclick = () => saveProforma(false);
document.getElementById('savePrintProformaBtn').onclick = () => saveProforma(true);
document.getElementById('proformaSearch').oninput = debounce(renderProformas, 120);

function renderProformas() {
  const table = document.getElementById('proformasTable');
  if (!table) return;
  const q = normalizeSearchText(document.getElementById('proformaSearch')?.value || '');
  const rows = db.proformas.filter(pf => !q || normalizeSearchText(`${pf.number || ''} ${pf.clientName || ''} ${pf.clientCedula || ''}`).includes(q));
  table.innerHTML = rows.slice().reverse().map(pf => {
    const status = proformaStatus(pf);
    const statusClass = status === 'Convertida' ? 'good' : status === 'Vencida' ? 'bad' : 'warn';
    return `<tr>
      <td><strong>${esc(pf.number)}</strong></td>
      <td>${esc(pf.date || '')}</td>
      <td>${esc(pf.clientName || '-')}<br><span class="muted">${esc(pf.clientCedula || '')}</span></td>
      <td>${esc(pf.validUntil || '-')}</td>
      <td><span class="status ${statusClass}">${esc(status)}</span></td>
      <td><strong>${money(pf.total)}</strong></td>
      <td><div class="action-row">
        <button class="mini primary-mini" onclick="printProforma('${pf.id}')">Imprimir</button>
        ${status !== 'Convertida' ? `<button class="mini good-mini" onclick="convertProformaToSale('${pf.id}')">Convertir en venta</button>` : (pf.saleId ? `<button class="mini" onclick="printInvoice('${pf.saleId}')">Ver factura</button>` : '')}
        ${status !== 'Convertida' ? `<button class="mini danger" onclick="deleteProforma('${pf.id}')">Eliminar</button>` : ''}
      </div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No hay proformas guardadas.</td></tr>';
}

window.deleteProforma = id => {
  const pf = db.proformas.find(x => x.id === id);
  if (!pf) return;
  if (pf.status === 'Convertida') return toast('Una proforma convertida no se puede eliminar desde aquí');
  if (!confirm(`¿Eliminar la proforma ${pf.number}?`)) return;
  db.proformas = db.proformas.filter(x => x.id !== id);
  save();
  toast('Proforma eliminada');
};

window.convertProformaToSale = id => {
  const pf = db.proformas.find(x => x.id === id);
  if (!pf) return;
  if (pf.status === 'Convertida') return toast('Esta proforma ya fue convertida en venta');
  const client = db.clients.find(c => c.id === pf.clientId);
  if (!client) return toast('El cliente de la proforma ya no existe');
  for (const item of pf.items || []) {
    const product = db.products.find(p => p.id === item.productId);
    if (!product) return toast(`El producto ${item.name} ya no existe`);
    if (Number(product.stock || 0) < Number(item.qty || 0)) return toast(`Stock insuficiente para ${item.name}`);
  }
  saleCart = clone(pf.items || []);
  activeProformaForSaleId = pf.id;
  document.getElementById('saleClient').value = client.id;
  document.getElementById('saleClientSearch').value = clientDisplayText(client);
  document.getElementById('salePaymentMode').value = 'full';
  showView('ventas');
  renderSaleCart();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast(`${pf.number} cargada en Ventas. Revisa el cobro y finaliza la venta.`);
};

window.printProforma = id => {
  const pf = db.proformas.find(x => x.id === id);
  if (!pf) return;
  const companyName = db.company.name || 'Soporte360';
  const logo = db.company.logo ? `<img src="${db.company.logo}" class="pro-logo" alt="Logo">` : `<div class="pro-logo-placeholder">${esc(companyName.charAt(0).toUpperCase())}</div>`;
  const itemRows = (pf.items || []).map((item, idx) => `
    <tr><td class="num">${idx + 1}</td><td class="code">${esc(item.code || '-')}</td><td><div class="desc-main">${esc(item.name || '')}</div><div class="desc-type">Producto / servicio</div></td><td class="qty">${Number(item.qty || 0)}</td><td class="money-cell">${money(item.price)}</td><td class="money-cell total-cell">${money(Number(item.price || 0) * Number(item.qty || 0))}</td></tr>
  `).join('');
  const body = `
    <div class="invoice-sheet pro-sheet">
      <div class="pro-accent-line"></div>
      <header class="pro-header">
        <div class="pro-company-block">
          ${logo}
          <div class="pro-company-copy">
            <h1>${esc(companyName)}</h1>
            ${db.company.legal ? `<div class="legal-name">${esc(db.company.legal)}</div>` : ''}
            <div class="company-contact">${esc(db.company.address || '')}</div>
            <div class="company-contact">Tel: ${esc(db.company.phone || '-')} ${db.company.email ? ` · ${esc(db.company.email)}` : ''}</div>
          </div>
        </div>
        <div class="pro-doc-box">
          <div class="doc-ruc">RUC ${esc(db.company.ruc || '-')}</div>
          <div class="doc-title">PROFORMA</div>
          <div class="doc-number">${esc(pf.number)}</div>
          <div class="doc-kind">COTIZACIÓN COMERCIAL</div>
          <div class="doc-note">NO CONSTITUYE FACTURA</div>
        </div>
      </header>
      <section class="pro-info-grid">
        <div class="pro-info-box client-info">
          <div class="box-title">DATOS DEL CLIENTE</div>
          <div class="info-row"><span>CI / RUC</span><strong>${esc(pf.clientCedula || '-')}</strong></div>
          <div class="info-row"><span>Cliente</span><strong>${esc(pf.clientName || '-')}</strong></div>
          <div class="info-row"><span>Dirección</span><strong>${esc(pf.clientAddress || '-')}</strong></div>
          <div class="info-row"><span>Teléfono</span><strong>${esc(pf.clientPhone || '-')}</strong></div>
        </div>
        <div class="pro-info-box issue-info">
          <div class="box-title">DATOS DE LA PROFORMA</div>
          <div class="info-row"><span>Fecha emisión</span><strong>${esc(pf.date || '')}</strong></div>
          <div class="info-row"><span>Válida hasta</span><strong>${esc(pf.validUntil || '-')}</strong></div>
          <div class="info-row"><span>Vigencia</span><strong>${Number(pf.validityDays || 0)} días</strong></div>
          <div class="info-row"><span>Estado</span><strong>${esc(proformaStatus(pf))}</strong></div>
        </div>
      </section>
      <table class="pro-items-table">
        <thead><tr><th class="num">#</th><th class="code">CÓD.</th><th>DESCRIPCIÓN</th><th class="qty">CANT.</th><th class="money-cell">PRECIO U.</th><th class="money-cell">IMPORTE</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <section class="pro-bottom">
        <div class="pro-observations">
          <div class="box-title">OBSERVACIONES</div>
          <p>${pf.notes ? esc(pf.notes).replace(/\n/g, '<br>') : 'Precios sujetos a la vigencia indicada. La proforma no reserva existencias y no genera movimientos de caja.'}</p>
          ${db.company.serviceClause ? `<div class="invoice-terms"><strong>Condiciones:</strong><br>${esc(db.company.serviceClause).replace(/\n/g, '<br>')}</div>` : ''}
          <div class="thanks-message"><strong>Gracias por confiar en ${esc(companyName)}.</strong><br>Estamos a su disposición para confirmar esta proforma.</div>
        </div>
        <div class="pro-totals">
          <div><span>SUBTOTAL</span><strong>${money(pf.subtotal)}</strong></div>
          <div><span>IVA ${Number(pf.taxRate || 0)}%</span><strong>${money(pf.tax)}</strong></div>
          <div class="pro-total-final"><span>VALOR TOTAL</span><strong>${money(pf.total)}</strong></div>
        </div>
      </section>
      <section class="pro-signatures">
        <div><span></span><small>Aceptación del cliente</small></div>
        <div><span></span><small>Responsable</small></div>
      </section>
      <footer class="pro-footer"><div>${esc(companyName)} · Proforma comercial</div><div>${esc(db.company.phone || '')}</div></footer>
    </div>`;
  printHtml(pf.number, body, 'invoice');
};

function renderReceivables() {
  const table = document.getElementById('receivablesTable');
  if (!table) return;
  const pending = db.sales.filter(s => saleBalanceAmount(s) > 0.004);
  const q = normalizeSearchText(document.getElementById('receivableSearch')?.value || '');
  const filtered = pending.filter(s => !q || normalizeSearchText(`${s.number || ''} ${s.clientName || ''} ${s.clientCedula || ''} ${s.order || ''}`).includes(q));
  const totalPending = pending.reduce((sum, s) => sum + saleBalanceAmount(s), 0);
  const clients = new Set(pending.map(s => s.clientId).filter(Boolean));
  const todayPayments = db.sales.flatMap(s => Array.isArray(s.payments) ? s.payments : []).filter(p => p.dateKey === today() && p.note === 'Abono').reduce((sum, p) => sum + Number(p.amount || 0), 0);
  document.getElementById('receivableTotal').textContent = money(totalPending);
  document.getElementById('receivableCount').textContent = pending.length;
  document.getElementById('receivableClients').textContent = clients.size;
  document.getElementById('receivableToday').textContent = money(todayPayments);
  table.innerHTML = filtered.slice().reverse().map(s => `
    <tr>
      <td><strong>${esc(s.number)}</strong>${s.order ? `<br><span class="muted">${esc(s.order)}</span>` : ''}</td>
      <td><span class="status ${s.source === 'repair' ? 'warn' : 'good'}">${saleTypeLabel(s)}</span></td>
      <td>${esc(s.clientName || '-')}<br><span class="muted">${esc(s.clientCedula || '')}</span></td>
      <td>${esc(s.date || '')}</td>
      <td><strong>${money(s.total)}</strong></td>
      <td>${money(salePaidAmount(s))}</td>
      <td><strong class="balance-due">${money(saleBalanceAmount(s))}</strong></td>
      <td><div class="action-row"><button class="mini good-mini" onclick="openReceivablePayment('${s.id}')">Registrar abono</button><button class="mini" onclick="printInvoice('${s.id}')">Factura</button></div></td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="empty">No hay saldos pendientes.</td></tr>';
}

document.getElementById('receivableSearch').oninput = debounce(renderReceivables, 120);

function closeReceivablePaymentModal() {
  const modal = document.getElementById('receivablePaymentModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

document.querySelectorAll('[data-close-receivable-payment]').forEach(el => el.onclick = closeReceivablePaymentModal);

window.openReceivablePayment = id => {
  const sale = db.sales.find(s => s.id === id);
  if (!sale) return;
  const balance = saleBalanceAmount(sale);
  if (balance <= 0.004) return toast('Esta factura ya está pagada');
  document.getElementById('receivableSaleId').value = sale.id;
  document.getElementById('receivablePaymentTitle').textContent = `${sale.number} · ${sale.clientName || ''}`;
  document.getElementById('receivablePaymentSummary').textContent = `${saleTypeLabel(sale)} · Total ${money(sale.total)} · Abonado ${money(salePaidAmount(sale))}`;
  document.getElementById('receivableCurrentBalance').textContent = money(balance);
  const amount = document.getElementById('receivablePaymentAmount');
  amount.value = balance.toFixed(2);
  amount.max = balance.toFixed(2);
  document.getElementById('receivablePaymentModal').classList.add('open');
  document.getElementById('receivablePaymentModal').setAttribute('aria-hidden', 'false');
  setTimeout(() => amount.focus(), 50);
};

document.getElementById('receivablePaymentForm').onsubmit = e => {
  e.preventDefault();
  if (!db.cash.open) return toast('Debe abrir la caja antes de registrar un abono');
  const sale = db.sales.find(s => s.id === document.getElementById('receivableSaleId').value);
  if (!sale) return toast('No se encontró la factura');
  const balance = saleBalanceAmount(sale);
  const amount = Number(document.getElementById('receivablePaymentAmount').value || 0);
  const method = document.getElementById('receivablePaymentMethod').value;
  if (!Number.isFinite(amount) || amount <= 0) return toast('Ingrese un abono válido');
  if (amount > balance + 0.004) return toast('El abono no puede superar el saldo pendiente');
  const payment = makePaymentRecord(amount, method, 'Abono');
  if (!Array.isArray(sale.payments)) sale.payments = [];
  sale.payments.push(payment);
  // Recalcular usando el historial para evitar diferencias por redondeo.
  sale.amountPaid = Math.min(Number(sale.total || 0), sale.payments.reduce((sum, p) => sum + Number(p.amount || 0), 0));
  sale.balance = Math.max(0, Number(sale.total || 0) - sale.amountPaid);
  sale.paymentStatus = sale.balance > 0.004 ? 'Pendiente' : 'Pagado';
  db.cash.movements.push({ id: uid('MOV'), saleId: sale.id, paymentId: payment.id, date: now(), type: 'ingreso', amount, concept: `Abono ${sale.number} · ${method}` });
  closeReceivablePaymentModal();
  save();
  toast(sale.balance > 0.004 ? `Abono registrado · Saldo ${money(sale.balance)}` : 'Abono registrado · Factura pagada');
};

function renderInvoices() {
  document.getElementById('invoicesTable').innerHTML = db.sales.slice().reverse().map(s => {
    const paid = salePaidAmount(s);
    const balance = saleBalanceAmount(s);
    const status = salePaymentStatus(s);
    return `<tr>
      <td><strong>${esc(s.number)}</strong></td>
      <td><span class="status ${s.source === 'repair' ? 'warn' : 'good'}">${saleTypeLabel(s)}</span></td>
      <td>${esc(s.order || '-')}</td>
      <td>${esc(s.date)}</td>
      <td>${esc(s.clientName)}</td>
      <td>${esc(salePaymentLabel(s))}</td>
      <td><strong>${money(s.total)}</strong></td>
      <td>${money(paid)}</td>
      <td><strong>${money(balance)}</strong></td>
      <td><span class="status ${status === 'Pagado' ? 'good' : 'warn'}">${status}</span></td>
      <td><div class="action-row"><button class="mini primary-mini" onclick="printInvoice('${s.id}','a4')">A4</button><button class="mini" onclick="printInvoice('${s.id}','ticket')">Ticket 80 mm</button><button class="mini good-mini" onclick="sendInvoiceEmail('${s.id}')">Enviar PDF</button>${balance > 0.004 ? `<button class="mini good-mini" onclick="openReceivablePayment('${s.id}')">Abonar</button>` : ''}${isOwner() ? `<button class="mini danger" onclick="deleteInvoice('${s.id}')">Eliminar</button>` : ''}</div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" class="empty">No hay facturas.</td></tr>';
}

window.deleteInvoice = (id, fromDevice = false) => {
  if (!isOwner()) return toast('Solo el propietario puede eliminar facturas');
  const sale = db.sales.find(s => s.id === id);
  if (!sale) return;
  if (!confirm(`¿Eliminar ${sale.number}? Se devolverá el stock y se retirará el cobro de caja.`)) return;
  (sale.items || []).filter(i => i.type !== 'service' && i.productId).forEach(i => {
    const p = db.products.find(x => x.id === i.productId);
    if (p) p.stock = Number(p.stock || 0) + Number(i.qty || 0);
  });
  db.cash.movements = db.cash.movements.filter(m => m.saleId !== sale.id && !String(m.concept || '').includes(sale.number));
  if (sale.source === 'repair' && sale.deviceId) {
    const d = db.devices.find(x => x.id === sale.deviceId);
    if (d) {
      d.repairSaleId = '';
      d.status = 'En reparación';
      delete d.repairedAt; delete d.deliveredAt; d.warrantyStart = ''; d.warrantyUntil = '';
    }
  }
  if (sale.proformaId) {
    const pf = db.proformas.find(x => x.id === sale.proformaId);
    if (pf) {
      pf.status = 'Vigente';
      pf.saleId = '';
      pf.convertedAt = '';
    }
  }
  db.sales = db.sales.filter(s => s.id !== id);
  save();
  toast('Factura eliminada y movimientos revertidos');
};

function invoiceEmailText(s) {
  const c = db.clients.find(x => x.id === s.clientId) || {};
  const lines = (s.items || []).map(i => `${i.qty} x ${i.name} - ${money(Number(i.price)*Number(i.qty))}`).join('\n');
  return `Hola ${s.clientName || ''},\n\nAdjuntamos el detalle de su comprobante ${s.number}.\n\n${lines}\n\nSubtotal sin IVA: ${money(s.subtotal)}\nIVA incluido (${s.taxRate || 0}%): ${money(s.tax)}\nTOTAL: ${money(s.total)}\nABONADO: ${money(salePaidAmount(s))}\nSALDO: ${money(saleBalanceAmount(s))}\nESTADO: ${salePaymentStatus(s)}\n\nGracias por confiar en ${db.company.name || 'nuestro servicio'}.`;
}

let pendingInvoiceEmailId = '';
let html2pdfLoadPromise = null;
const HTML2PDF_CDN = 'https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js';

function ensureHtml2Pdf() {
  if (window.html2pdf) return Promise.resolve(window.html2pdf);
  if (html2pdfLoadPromise) return html2pdfLoadPromise;
  html2pdfLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HTML2PDF_CDN;
    script.async = true;
    script.onload = () => window.html2pdf ? resolve(window.html2pdf) : reject(new Error('No se pudo inicializar el generador PDF.'));
    script.onerror = () => reject(new Error('No se pudo cargar el generador PDF. Revisa la conexión a internet.'));
    document.head.appendChild(script);
  }).catch(err => { html2pdfLoadPromise = null; throw err; });
  return html2pdfLoadPromise;
}

function buildInvoiceA4Document(s) {
  if (!s) return null;
  const d = s.deviceId ? db.devices.find(x => x.id === s.deviceId) : null;
  const c = db.clients.find(x => x.id === s.clientId) || {};
  const companyName = db.company.name || 'Soporte360';
  const logo = db.company.logo ? `<img src="${db.company.logo}" class="pro-logo" alt="Logo">` : `<div class="pro-logo-placeholder">${esc(companyName.charAt(0).toUpperCase())}</div>`;
  const paidAmount = salePaidAmount(s);
  const balanceAmount = saleBalanceAmount(s);
  const paymentStatus = salePaymentStatus(s);
  const itemRows = (s.items || []).map((i, idx) => {
    const code = i.type === 'service' ? 'SERV' : (i.code || '-');
    return `<tr><td class="num">${idx + 1}</td><td class="code">${esc(code)}</td><td><div class="desc-main">${esc(i.name)}</div><div class="desc-type">${i.type === 'service' ? 'Servicio / mano de obra' : 'Producto / repuesto'}</div></td><td class="qty">${Number(i.qty)}</td><td class="money-cell">${money(i.price)}</td><td class="money-cell total-cell">${money(Number(i.price) * Number(i.qty))}</td></tr>`;
  }).join('');
  const repairBlock = s.source === 'repair' && d ? `
    <section class="repair-strip">
      <div><span>Orden de trabajo</span><strong>${esc(s.order || d.order)}</strong></div>
      <div><span>Equipo</span><strong>${esc(deviceTypeLabel(d))} · ${esc(d.brand)} ${esc(d.model)}</strong></div>
      <div><span>N.º de serie</span><strong>${esc(d.serial || '-')}</strong></div>
      <div><span>Estado</span><strong>REPARADO</strong></div>
      <div><span>Garantía</span><strong>${esc(warrantyLabel(d))}</strong></div>
    </section>` : '';

  const body = `
    <div class="invoice-sheet pro-sheet">
      <div class="pro-accent-line"></div>
      <header class="pro-header">
        <div class="pro-company-block">
          ${logo}
          <div class="pro-company-copy">
            <h1>${esc(companyName)}</h1>
            ${db.company.legal ? `<div class="legal-name">${esc(db.company.legal)}</div>` : ''}
            <div class="company-contact">${esc(db.company.address || '')}</div>
            <div class="company-contact">Tel: ${esc(db.company.phone || '-')} ${db.company.email ? ` · ${esc(db.company.email)}` : ''}</div>
          </div>
        </div>
        <div class="pro-doc-box">
          <div class="doc-ruc">RUC ${esc(db.company.ruc || '-')}</div>
          <div class="doc-title">FACTURA</div>
          <div class="doc-number">${esc(s.number)}</div>
          <div class="doc-kind">${s.source === 'repair' ? 'SERVICIO TÉCNICO' : 'VENTA DE PRODUCTOS'}</div>
          <div class="doc-note">DOCUMENTO INTERNO</div>
        </div>
      </header>
      <section class="pro-info-grid">
        <div class="pro-info-box client-info">
          <div class="box-title">DATOS DEL CLIENTE</div>
          <div class="info-row"><span>CI / RUC</span><strong>${esc(s.clientCedula || '-')}</strong></div>
          <div class="info-row"><span>Cliente</span><strong>${esc(s.clientName || '-')}</strong></div>
          <div class="info-row"><span>Dirección</span><strong>${esc(c.address || '-')}</strong></div>
          <div class="info-row"><span>Teléfono</span><strong>${esc(s.clientPhone || c.phone || '-')}</strong></div>
          <div class="info-row"><span>Correo</span><strong>${esc(s.clientEmail || c.email || '-')}</strong></div>
        </div>
        <div class="pro-info-box issue-info">
          <div class="box-title">DATOS DEL COMPROBANTE</div>
          <div class="info-row"><span>Fecha emisión</span><strong>${esc(s.date || '')}</strong></div>
          <div class="info-row"><span>Forma de pago</span><strong>${esc(salePaymentLabel(s))}</strong></div>
          <div class="info-row"><span>Tipo</span><strong>${s.source === 'repair' ? 'Reparación' : 'Venta'}</strong></div>
          <div class="info-row"><span>N.º control</span><strong>${esc(s.order || s.number)}</strong></div>
          <div class="info-row"><span>Estado de pago</span><strong>${esc(paymentStatus)}</strong></div>
        </div>
      </section>
      ${repairBlock}
      <table class="pro-items-table">
        <thead><tr><th class="num">#</th><th class="code">CÓD.</th><th>DESCRIPCIÓN</th><th class="qty">CANT.</th><th class="money-cell">PRECIO U.</th><th class="money-cell">IMPORTE</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <section class="pro-bottom">
        <div class="pro-observations">
          <div class="box-title">OBSERVACIONES</div>
          <p>${s.source === 'repair' && d ? `Servicio correspondiente a la orden ${esc(s.order || d.order)}. Equipo: ${esc(deviceTypeLabel(d))} ${esc(d.brand)} ${esc(d.model)}.${d.warrantyNotes ? ` Garantía: ${esc(d.warrantyNotes)}` : ''}` : 'Venta de productos registrada en el sistema.'}</p>
          ${s.source === 'repair' && db.company.serviceClause ? `<div class="invoice-terms"><strong>Condiciones de servicio:</strong><br>${esc(db.company.serviceClause).replace(/\n/g, '<br>')}</div>` : ''}
          <div class="thanks-message"><strong>Gracias por confiar en ${esc(companyName)}.</strong><br>Conserve este comprobante para futuras consultas.</div>
        </div>
        <div class="pro-totals">
          <div><span>SUBTOTAL</span><strong>${money(s.subtotal)}</strong></div>
          <div><span>IVA ${Number(s.taxRate || 0)}%</span><strong>${money(s.tax)}</strong></div>
          <div class="pro-total-final"><span>VALOR TOTAL</span><strong>${money(s.total)}</strong></div>
          <div><span>ABONADO</span><strong>${money(paidAmount)}</strong></div>
          <div class="${balanceAmount > 0.004 ? 'payment-due-row' : ''}"><span>SALDO</span><strong>${money(balanceAmount)}</strong></div>
        </div>
      </section>
      <section class="pro-signatures">
        <div><span></span><small>Recibí conforme / Cliente</small></div>
        <div><span></span><small>Responsable / Técnico</small></div>
      </section>
      <footer class="pro-footer">
        <div>${esc(companyName)} · Soporte técnico, reparación y ventas</div>
        <div>${esc(db.company.phone || '')}</div>
      </footer>
    </div>`;
  return { title: s.number, body, kind: 'invoice' };
}

function invoicePdfStyles() {
  const primary = db.company.primary || '#2563eb';
  const secondary = db.company.secondary || '#0f172a';
  return `
    :root{--accent:${primary};--accent2:${secondary};--ink:#1a2230;--muted:#667085;--line:#d7dee7;--soft:#f7f9fc;--ok:#0f766e}
    *{box-sizing:border-box} body{margin:0;background:#fff;color:var(--ink);font-family:Arial,Helvetica,sans-serif}
    .invoice-sheet{width:178mm;margin:0 auto;background:#fff;overflow:hidden;min-height:0!important;height:auto!important}
    .pro-sheet{padding:0 6mm 5mm}.pro-accent-line{height:7px;background:linear-gradient(90deg,var(--accent),#45b7d1,var(--accent2));margin:0 -6mm 4mm}
    .pro-header{display:grid;grid-template-columns:minmax(0,1fr) 56mm;gap:5mm;align-items:start}.pro-company-block{display:flex;align-items:flex-start;gap:3.5mm;min-width:0}
    .pro-logo{width:34mm;height:17mm;object-fit:contain;object-position:left center}.pro-logo-placeholder{width:18mm;height:18mm;border:2px solid var(--accent);display:grid;place-items:center;color:var(--accent);font-size:9mm;font-weight:900;border-radius:4mm;background:#fff}
    .pro-company-copy h1{font-size:20px;line-height:1.02;margin:0 0 1mm;color:var(--accent2)}.legal-name{font-size:8.8px;font-weight:800;margin-bottom:1mm;color:#394150}.company-contact{font-size:8px;color:#4f5967;line-height:1.32}
    .pro-doc-box{border:1.5px solid var(--accent2);border-radius:7px;padding:2.5mm 2.6mm;text-align:center;background:linear-gradient(180deg,#fff,#f5f8ff)}.doc-ruc{font-size:9.5px;font-weight:800;color:var(--accent2)}.doc-title{font-size:17px;font-weight:900;letter-spacing:.04em;margin:1mm 0 .1mm;color:var(--accent2)}.doc-number{font-size:13px;font-weight:900;color:var(--accent);padding:1mm 0;border-top:1px solid #d6dbe2;border-bottom:1px solid #d6dbe2}.doc-kind{font-size:7.4px;font-weight:900;margin-top:1mm;color:var(--ok)}.doc-note{font-size:6.6px;color:#7b8491;margin-top:.5mm;letter-spacing:.04em}
    .pro-info-grid{display:grid;grid-template-columns:1.33fr .87fr;gap:2.3mm;margin-top:3mm}.pro-info-box{border:1px solid #cfd7e2;border-radius:7px;overflow:hidden;background:#fff}.box-title{font-size:7px;font-weight:900;letter-spacing:.08em;padding:1.6mm 2.4mm;color:#fff;background:linear-gradient(90deg,var(--accent2),#344054)}.issue-info .box-title{background:linear-gradient(90deg,var(--accent),#4f8cff)}.pro-info-box .info-row{padding:1.1mm 2.4mm}.info-row{display:grid;grid-template-columns:20mm 1fr;gap:1.5mm;font-size:7.8px;line-height:1.25}.info-row span{font-weight:800;color:#667085}.info-row strong{font-weight:700;color:#1f2937;overflow-wrap:anywhere}
    .repair-strip{display:grid;grid-template-columns:.72fr 1.18fr .82fr .55fr 1fr;gap:0;border:1px solid #d3dbe5;border-radius:7px;overflow:hidden;margin-top:2.4mm;background:#fbfdff}.repair-strip>div{padding:1.9mm 2.1mm;border-right:1px solid #e2e8f0}.repair-strip>div:last-child{border-right:0}.repair-strip>div:nth-child(4){background:#ecfdf5}.repair-strip span{display:block;font-size:6.2px;color:#6d7785;text-transform:uppercase;font-weight:900;margin-bottom:.4mm}.repair-strip strong{font-size:7.4px;line-height:1.15}
    .pro-items-table{width:100%;border-collapse:collapse;margin-top:2.6mm;table-layout:fixed;border:1px solid #dde4ee}.pro-items-table thead tr{background:linear-gradient(180deg,#f2f6fc,#e8eff9)}.pro-items-table th{padding:1.6mm 1.2mm;font-size:6.9px;text-align:left;letter-spacing:.03em;color:var(--accent2);border-bottom:1px solid #d7dee7}.pro-items-table td{border-bottom:1px solid #edf1f5;padding:1.8mm 1.2mm;font-size:7.8px;vertical-align:top}.pro-items-table tbody tr:last-child td{border-bottom:0}.pro-items-table .num{width:7mm;text-align:center}.pro-items-table .code{width:14mm}.pro-items-table .qty{width:10mm;text-align:center}.pro-items-table .money-cell{width:18mm;text-align:right}.pro-items-table .total-cell{font-weight:800}.desc-main{font-weight:700;line-height:1.15}.desc-type{font-size:6.2px;color:#7a8490;margin-top:.4mm}
    .pro-bottom{display:grid;grid-template-columns:1fr 47mm;gap:3mm;margin-top:2.8mm;align-items:start}.pro-observations{border:1px solid #d8e0ea;border-radius:7px;overflow:hidden;background:#fff}.pro-observations p{font-size:7.6px;color:#515b68;line-height:1.28;margin:0;padding:1.8mm 2.4mm .5mm}.invoice-terms{margin:1mm 2.4mm;padding:1.4mm 1.6mm;border:1px solid #e1e6ed;border-radius:5px;background:#fafbfc;font-size:6.8px;line-height:1.3;color:#596273}.thanks-message{margin:0 2.4mm 1.8mm;padding-top:1.4mm;border-top:1px solid #e5eaf0;font-size:7.2px;line-height:1.22;color:#475467}
    .pro-totals{border:1px solid #ced7e2;border-radius:7px;overflow:hidden;background:#fff}.pro-totals>div{display:flex;justify-content:space-between;gap:4mm;padding:1.8mm 2mm;border-bottom:1px solid #eef2f6;font-size:7.9px}.pro-totals>div:last-child{border-bottom:0}.pro-totals span{font-weight:800;color:#525d6a}.pro-total-final{background:linear-gradient(90deg,var(--accent),#2563eb)!important;color:#fff!important;padding:2.4mm 2mm!important;font-size:9px!important}.pro-total-final span,.pro-total-final strong{color:#fff!important}.pro-total-final strong{font-size:12.5px}.payment-due-row{background:#fff7ed}
    .pro-signatures{display:grid;grid-template-columns:1fr 1fr;gap:14mm;margin-top:4mm;padding:0 8mm}.pro-signatures div{text-align:center}.pro-signatures span{display:block;border-top:1px solid #9aa4b2}.pro-signatures small{display:block;font-size:6.6px;color:#697386;margin-top:1mm}.pro-footer{margin-top:2.4mm;border-top:1px solid #e5eaf0;padding-top:1.2mm;display:flex;justify-content:space-between;font-size:6.5px;color:#76808d}`;
}

async function generateInvoicePdfBase64(s) {
  const doc = buildInvoiceA4Document(s);
  if (!doc) throw new Error('No se pudo preparar la factura.');
  await ensureHtml2Pdf();
  const style = document.createElement('style');
  style.textContent = invoicePdfStyles();
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-12000px;top:0;width:210mm;background:#fff;z-index:-1;pointer-events:none;';
  host.innerHTML = doc.body;
  document.head.appendChild(style);
  document.body.appendChild(host);
  try {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const worker = window.html2pdf().set({
      margin: [6, 6, 6, 6],
      filename: `${s.number}.pdf`,
      image: { type: 'jpeg', quality: 0.96 },
      html2canvas: { scale: 1.6, useCORS: true, logging: false, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0 },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
      pagebreak: { mode: ['css', 'legacy'] }
    }).from(host.querySelector('.invoice-sheet'));
    const dataUri = await worker.outputPdf('datauristring');
    const base64 = String(dataUri || '').split(',')[1] || '';
    if (!base64) throw new Error('No se pudo convertir la factura a PDF.');
    return base64;
  } finally {
    host.remove();
    style.remove();
  }
}

function invoiceEmailHtml(s) {
  const text = invoiceEmailText(s).split('\n').map(line => esc(line)).join('<br>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.55"><p>${text}</p><p style="color:#64748b;font-size:12px">Se adjunta el comprobante ${esc(s.number)} en formato PDF.</p></div>`;
}

function closeInvoiceEmailModal() {
  const modal = document.getElementById('invoiceEmailModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  pendingInvoiceEmailId = '';
  const msg = document.getElementById('invoiceEmailMessage');
  if (msg) { msg.textContent = ''; msg.className = 'auth-message'; }
}

document.querySelectorAll('[data-close-invoice-email]').forEach(el => el.onclick = closeInvoiceEmailModal);

window.sendInvoiceEmail = id => {
  const s = db.sales.find(x => x.id === id);
  if (!s) return;
  const toEmail = getClientEmail(s.clientId, s.clientEmail);
  pendingInvoiceEmailId = id;
  document.getElementById('invoiceEmailTitle').textContent = `Enviar ${s.number}`;
  document.getElementById('invoiceEmailSummary').textContent = `${s.clientName || 'Cliente'} · Total ${money(s.total)}`;
  document.getElementById('invoiceEmailTo').value = toEmail || '';
  document.getElementById('invoiceEmailSubject').value = `${db.company.name || 'Soporte360'} - Factura ${s.number}`;
  const modal = document.getElementById('invoiceEmailModal');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => document.getElementById('invoiceEmailTo')?.focus(), 50);
};

document.getElementById('invoiceEmailForm').onsubmit = async e => {
  e.preventDefault();
  const sale = db.sales.find(x => x.id === pendingInvoiceEmailId);
  if (!sale) return toast('No se encontró la factura');
  if (!cloudClient || !cloudUser) return toast('Debes iniciar sesión en Supabase para enviar correos');
  const to = document.getElementById('invoiceEmailTo').value.trim();
  const subject = document.getElementById('invoiceEmailSubject').value.trim();
  const button = document.getElementById('invoiceEmailSendBtn');
  const msg = document.getElementById('invoiceEmailMessage');
  if (!/^\S+@\S+\.\S+$/.test(to)) {
    msg.textContent = 'Escribe un correo válido.'; msg.className = 'auth-message error'; return;
  }
  button.disabled = true;
  button.textContent = 'Generando PDF…';
  msg.textContent = 'Preparando la factura y el archivo PDF…';
  msg.className = 'auth-message';
  try {
    const pdfBase64 = await generateInvoicePdfBase64(sale);
    button.textContent = 'Enviando…';
    msg.textContent = 'Enviando el PDF al correo del cliente…';
    const { data, error } = await cloudClient.functions.invoke('send-invoice', {
      body: {
        to,
        subject: subject || `${db.company.name || 'Soporte360'} - Factura ${sale.number}`,
        html: invoiceEmailHtml(sale),
        pdfBase64,
        fileName: `${sale.number}.pdf`,
        replyTo: db.company.email || ''
      }
    });
    if (error) {
      let detail = error.message || 'No se pudo ejecutar el servicio de correo.';
      try {
        const payload = await error.context?.json?.();
        if (payload?.error) detail = payload.error;
      } catch (_) {}
      throw new Error(detail);
    }
    if (!data?.ok) throw new Error(data?.error || 'El servicio de correo no confirmó el envío.');
    msg.textContent = `Factura enviada correctamente a ${to}.`;
    msg.className = 'auth-message success';
    toast('Factura PDF enviada correctamente');
    setTimeout(closeInvoiceEmailModal, 1100);
  } catch (err) {
    console.error('Error enviando factura PDF:', err);
    msg.textContent = err.message || 'No se pudo enviar la factura. Revisa la configuración del correo.';
    msg.className = 'auth-message error';
  } finally {
    button.disabled = false;
    button.textContent = 'Enviar PDF por correo';
  }
};

window.printInvoice = (id, format = 'a4') => {
  const s = db.sales.find(x => x.id === id);
  if (!s) return;
  const d = s.deviceId ? db.devices.find(x => x.id === s.deviceId) : null;
  const c = db.clients.find(x => x.id === s.clientId) || {};
  const companyName = db.company.name || 'Soporte360';
  const logo = db.company.logo ? `<img src="${db.company.logo}" class="pro-logo" alt="Logo">` : `<div class="pro-logo-placeholder">${esc(companyName.charAt(0).toUpperCase())}</div>`;
  const ticketLogo = db.company.logo ? `<img src="${db.company.logo}" class="ticket-logo" alt="Logo">` : '';
  const paidAmount = salePaidAmount(s);
  const balanceAmount = saleBalanceAmount(s);
  const paymentStatus = salePaymentStatus(s);
  const itemRows = (s.items || []).map((i, idx) => {
    const code = i.type === 'service' ? 'SERV' : (i.code || '-');
    return `<tr><td class="num">${idx + 1}</td><td class="code">${esc(code)}</td><td><div class="desc-main">${esc(i.name)}</div><div class="desc-type">${i.type === 'service' ? 'Servicio / mano de obra' : 'Producto / repuesto'}</div></td><td class="qty">${Number(i.qty)}</td><td class="money-cell">${money(i.price)}</td><td class="money-cell total-cell">${money(Number(i.price) * Number(i.qty))}</td></tr>`;
  }).join('');
  const blankRows = '';

  const repairBlock = s.source === 'repair' && d ? `
    <section class="repair-strip">
      <div><span>Orden de trabajo</span><strong>${esc(s.order || d.order)}</strong></div>
      <div><span>Equipo</span><strong>${esc(deviceTypeLabel(d))} · ${esc(d.brand)} ${esc(d.model)}</strong></div>
      <div><span>N.º de serie</span><strong>${esc(d.serial || '-')}</strong></div>
      <div><span>Estado</span><strong>REPARADO</strong></div>
      <div><span>Garantía</span><strong>${esc(warrantyLabel(d))}</strong></div>
    </section>` : '';

  if (format === 'ticket') {
    const ticketItems = (s.items || []).map(i => `
      <tr><td>${Number(i.qty)}</td><td>${esc(i.name)}</td><td>${money(i.price)}</td><td>${money(Number(i.price) * Number(i.qty))}</td></tr>
    `).join('');
    const ticketRepair = s.source === 'repair' && d ? `<div class="ticket-lines"><div><b>Orden:</b> ${esc(s.order || d.order)}</div><div><b>Equipo:</b> ${esc(deviceTypeLabel(d))} ${esc(d.brand)} ${esc(d.model)}</div><div><b>Serie:</b> ${esc(d.serial || '-')}</div></div>` : '';
    const ticketBody = `
      <div class="ticket-sheet">
        <header class="ticket-header">${ticketLogo}<h1>${esc(companyName)}</h1>${db.company.legal ? `<div>${esc(db.company.legal)}</div>` : ''}<div>${esc(db.company.address || '')}</div><div>RUC: ${esc(db.company.ruc || '-')}</div><div>Tel: ${esc(db.company.phone || '-')}</div></header>
        <div class="ticket-doc"><strong>COMPROBANTE</strong><span>${esc(s.number)}</span></div>
        <div class="ticket-lines"><div><b>Cliente:</b> ${esc(s.clientName || '')}</div><div><b>CI/RUC:</b> ${esc(s.clientCedula || '-')}</div><div><b>Teléfono:</b> ${esc(s.clientPhone || c.phone || '-')}</div><div><b>Fecha:</b> ${esc(s.date || '')}</div><div><b>Pago:</b> ${esc(salePaymentLabel(s))}</div></div>
        ${ticketRepair}
        <table class="ticket-table"><thead><tr><th>Cant.</th><th>Descripción</th><th>P.U.</th><th>Total</th></tr></thead><tbody>${ticketItems}</tbody></table>
        <div class="ticket-totals"><div><span>SUBTOTAL</span><b>${money(s.subtotal)}</b></div><div><span>IVA ${Number(s.taxRate || 0)}%</span><b>${money(s.tax)}</b></div><div class="ticket-grand"><span>TOTAL</span><b>${money(s.total)}</b></div><div><span>ABONADO</span><b>${money(paidAmount)}</b></div><div><span>SALDO</span><b>${money(balanceAmount)}</b></div><div><span>ESTADO</span><b>${esc(paymentStatus)}</b></div></div>
        ${s.source === 'repair' && d && Number(d.warrantyDays || 0) > 0 ? `<div class="ticket-note"><b>Garantía:</b> ${esc(warrantyLabel(d))}</div>` : ''}
        ${s.source === 'repair' && db.company.serviceClause ? `<div class="ticket-note"><b>Condiciones:</b> ${esc(db.company.serviceClause)}</div>` : ''}
        <div class="ticket-note">Gracias por su compra. Conserve este comprobante.</div>
        <div class="ticket-internal">Documento interno · ${esc(companyName)}</div>
      </div>`;
    return printHtml(s.number, ticketBody, 'ticket');
  }

  const body = `
    <div class="invoice-sheet pro-sheet">
      <div class="pro-accent-line"></div>
      <header class="pro-header">
        <div class="pro-company-block">
          ${logo}
          <div class="pro-company-copy">
            <h1>${esc(companyName)}</h1>
            ${db.company.legal ? `<div class="legal-name">${esc(db.company.legal)}</div>` : ''}
            <div class="company-contact">${esc(db.company.address || '')}</div>
            <div class="company-contact">Tel: ${esc(db.company.phone || '-')} ${db.company.email ? ` · ${esc(db.company.email)}` : ''}</div>
          </div>
        </div>
        <div class="pro-doc-box">
          <div class="doc-ruc">RUC ${esc(db.company.ruc || '-')}</div>
          <div class="doc-title">FACTURA</div>
          <div class="doc-number">${esc(s.number)}</div>
          <div class="doc-kind">${s.source === 'repair' ? 'SERVICIO TÉCNICO' : 'VENTA DE PRODUCTOS'}</div>
          <div class="doc-note">DOCUMENTO INTERNO</div>
        </div>
      </header>

      <section class="pro-info-grid">
        <div class="pro-info-box client-info">
          <div class="box-title">DATOS DEL CLIENTE</div>
          <div class="info-row"><span>CI / RUC</span><strong>${esc(s.clientCedula || '-')}</strong></div>
          <div class="info-row"><span>Cliente</span><strong>${esc(s.clientName || '-')}</strong></div>
          <div class="info-row"><span>Dirección</span><strong>${esc(c.address || '-')}</strong></div>
          <div class="info-row"><span>Teléfono</span><strong>${esc(s.clientPhone || c.phone || '-')}</strong></div><div class="info-row"><span>Correo</span><strong>${esc(s.clientEmail || c.email || '-')}</strong></div>
        </div>
        <div class="pro-info-box issue-info">
          <div class="box-title">DATOS DEL COMPROBANTE</div>
          <div class="info-row"><span>Fecha emisión</span><strong>${esc(s.date || '')}</strong></div>
          <div class="info-row"><span>Forma de pago</span><strong>${esc(salePaymentLabel(s))}</strong></div>
          <div class="info-row"><span>Tipo</span><strong>${s.source === 'repair' ? 'Reparación' : 'Venta'}</strong></div>
          <div class="info-row"><span>N.º control</span><strong>${esc(s.order || s.number)}</strong></div>
          <div class="info-row"><span>Estado de pago</span><strong>${esc(paymentStatus)}</strong></div>
        </div>
      </section>

      ${repairBlock}

      <table class="pro-items-table">
        <thead><tr><th class="num">#</th><th class="code">CÓD.</th><th>DESCRIPCIÓN</th><th class="qty">CANT.</th><th class="money-cell">PRECIO U.</th><th class="money-cell">IMPORTE</th></tr></thead>
        <tbody>${itemRows}${blankRows}</tbody>
      </table>

      <section class="pro-bottom">
        <div class="pro-observations">
          <div class="box-title">OBSERVACIONES</div>
          <p>${s.source === 'repair' && d ? `Servicio correspondiente a la orden ${esc(s.order || d.order)}. Equipo: ${esc(deviceTypeLabel(d))} ${esc(d.brand)} ${esc(d.model)}.${d.warrantyNotes ? ` Garantía: ${esc(d.warrantyNotes)}` : ''}` : 'Venta de productos registrada en el sistema.'}</p>
          ${s.source === 'repair' && db.company.serviceClause ? `<div class="invoice-terms"><strong>Condiciones de servicio:</strong><br>${esc(db.company.serviceClause).replace(/\n/g, '<br>')}</div>` : ''}
          <div class="thanks-message"><strong>Gracias por confiar en ${esc(companyName)}.</strong><br>Conserve este comprobante para futuras consultas.</div>
        </div>
        <div class="pro-totals">
          <div><span>SUBTOTAL</span><strong>${money(s.subtotal)}</strong></div>
          <div><span>IVA ${Number(s.taxRate || 0)}%</span><strong>${money(s.tax)}</strong></div>
          <div class="pro-total-final"><span>VALOR TOTAL</span><strong>${money(s.total)}</strong></div>
          <div><span>ABONADO</span><strong>${money(paidAmount)}</strong></div>
          <div class="${balanceAmount > 0.004 ? 'payment-due-row' : ''}"><span>SALDO</span><strong>${money(balanceAmount)}</strong></div>
        </div>
      </section>

      <section class="pro-signatures">
        <div><span></span><small>Recibí conforme / Cliente</small></div>
        <div><span></span><small>Responsable / Técnico</small></div>
      </section>

      <footer class="pro-footer">
        <div>${esc(companyName)} · Soporte técnico, reparación y ventas</div>
        <div>${esc(db.company.phone || '')}</div>
      </footer>
    </div>`;
  printHtml(s.number, body, 'invoice');
};

function printHtml(title, body, kind = 'invoice') {
  const primary = db.company.primary || '#2563eb';
  const secondary = db.company.secondary || '#0f172a';
  const w = window.open('', '_blank', kind === 'ticket' ? 'width=620,height=860' : 'width=1180,height=860');
  if (!w) return toast('El navegador bloqueó la ventana de impresión');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    :root{--accent:${primary};--accent2:${secondary};--ink:#1a2230;--muted:#667085;--line:#d7dee7;--soft:#f7f9fc;--ok:#0f766e}
    *{box-sizing:border-box}
    body{margin:0;background:#e9edf2;color:var(--ink);font-family:Arial,Helvetica,sans-serif}
    .invoice-sheet,.doc-sheet{background:#fff;box-shadow:0 14px 36px rgba(15,23,42,.14)}

    /* Factura super compacta 1 hoja */
    .invoice-sheet{width:178mm;margin:12px auto 18px;border-radius:8px;overflow:hidden;min-height:0!important;height:auto!important}
    .pro-sheet{padding:0 6mm 5mm;min-height:0!important}
    .pro-accent-line{height:7px;background:linear-gradient(90deg,var(--accent),#45b7d1,var(--accent2));margin:0 -6mm 4mm}
    .pro-header{display:grid;grid-template-columns:minmax(0,1fr) 56mm;gap:5mm;align-items:start}
    .pro-company-block{display:flex;align-items:flex-start;gap:3.5mm;min-width:0}
    .pro-logo{width:34mm;height:17mm;object-fit:contain;object-position:left center}
    .pro-logo-placeholder{width:18mm;height:18mm;border:2px solid var(--accent);display:grid;place-items:center;color:var(--accent);font-size:9mm;font-weight:900;border-radius:4mm;background:#fff}
    .pro-company-copy h1{font-size:20px;line-height:1.02;margin:0 0 1mm;color:var(--accent2)}
    .legal-name{font-size:8.8px;font-weight:800;margin-bottom:1mm;color:#394150}
    .company-contact{font-size:8px;color:#4f5967;line-height:1.32}
    .pro-doc-box{border:1.5px solid var(--accent2);border-radius:7px;padding:2.5mm 2.6mm;text-align:center;background:linear-gradient(180deg,#ffffff,#f5f8ff);box-shadow:0 4px 12px rgba(37,99,235,.08)}
    .doc-ruc{font-size:9.5px;font-weight:800;color:var(--accent2)}
    .doc-title{font-size:17px;font-weight:900;letter-spacing:.04em;margin:1mm 0 .1mm;color:var(--accent2)}
    .doc-number{font-size:13px;font-weight:900;color:var(--accent);padding:1mm 0;border-top:1px solid #d6dbe2;border-bottom:1px solid #d6dbe2}
    .doc-kind{font-size:7.4px;font-weight:900;margin-top:1mm;color:var(--ok)}
    .doc-note{font-size:6.6px;color:#7b8491;margin-top:.5mm;letter-spacing:.04em}

    .pro-info-grid{display:grid;grid-template-columns:1.33fr .87fr;gap:2.3mm;margin-top:3mm}
    .pro-info-box{border:1px solid #cfd7e2;border-radius:7px;overflow:hidden;background:#fff}
    .box-title{font-size:7px;font-weight:900;letter-spacing:.08em;padding:1.6mm 2.4mm;color:#fff;background:linear-gradient(90deg,var(--accent2),#344054)}
    .issue-info .box-title{background:linear-gradient(90deg,var(--accent),#4f8cff)}
    .pro-info-box .info-row{padding:1.1mm 2.4mm}
    .info-row{display:grid;grid-template-columns:20mm 1fr;gap:1.5mm;font-size:7.8px;line-height:1.25}
    .info-row span{font-weight:800;color:#667085}
    .info-row strong{font-weight:700;color:#1f2937;overflow-wrap:anywhere}

    .repair-strip{display:grid;grid-template-columns:.72fr 1.18fr .82fr .55fr 1fr;gap:0;border:1px solid #d3dbe5;border-radius:7px;overflow:hidden;margin-top:2.4mm;background:#fbfdff}
    .repair-strip>div{padding:1.9mm 2.1mm;border-right:1px solid #e2e8f0}
    .repair-strip>div:last-child{border-right:0}.repair-strip>div:nth-child(4){background:#ecfdf5}
    .repair-strip span{display:block;font-size:6.2px;color:#6d7785;text-transform:uppercase;font-weight:900;margin-bottom:.4mm}
    .repair-strip strong{font-size:7.4px;line-height:1.15}

    .pro-items-table{width:100%;border-collapse:collapse;margin-top:2.6mm;table-layout:fixed;border:1px solid #dde4ee;border-radius:7px;overflow:hidden}
    .pro-items-table thead tr{background:linear-gradient(180deg,#f2f6fc,#e8eff9)}
    .pro-items-table th{padding:1.6mm 1.2mm;font-size:6.9px;text-align:left;letter-spacing:.03em;color:var(--accent2);border-bottom:1px solid #d7dee7}
    .pro-items-table td{border-bottom:1px solid #edf1f5;padding:1.8mm 1.2mm;font-size:7.8px;vertical-align:top}
    .pro-items-table tbody tr:last-child td{border-bottom:0}
    .pro-items-table .num{width:7mm;text-align:center}.pro-items-table .code{width:14mm}.pro-items-table .qty{width:10mm;text-align:center}.pro-items-table .money-cell{width:18mm;text-align:right}.pro-items-table .total-cell{font-weight:800}
    .desc-main{font-weight:700;line-height:1.15}.desc-type{font-size:6.2px;color:#7a8490;margin-top:.4mm}.blank-row{display:none}

    .pro-bottom{display:grid;grid-template-columns:1fr 47mm;gap:3mm;margin-top:2.8mm;align-items:start}
    .pro-observations{border:1px solid #d8e0ea;border-radius:7px;overflow:hidden;background:#fff}
    .pro-observations .box-title{background:linear-gradient(90deg,var(--accent2),#344054)}
    .pro-observations p{font-size:7.6px;color:#515b68;line-height:1.28;margin:0;padding:1.8mm 2.4mm .5mm}.invoice-terms{margin:1mm 2.4mm;padding:1.4mm 1.6mm;border:1px solid #e1e6ed;border-radius:5px;background:#fafbfc;font-size:6.8px;line-height:1.3;color:#596273}
    .thanks-message{margin:0 2.4mm 1.8mm;padding-top:1.4mm;border-top:1px solid #e5eaf0;font-size:7.2px;line-height:1.22;color:#475467}
    .pro-totals{border:1px solid #ced7e2;border-radius:7px;overflow:hidden;background:#fff;box-shadow:0 4px 12px rgba(15,23,42,.05)}
    .pro-totals>div{display:flex;justify-content:space-between;gap:4mm;padding:1.8mm 2mm;border-bottom:1px solid #eef2f6;font-size:7.9px}
    .pro-totals>div:last-child{border-bottom:0}
    .pro-totals span{font-weight:800;color:#525d6a}
    .pro-total-final{background:linear-gradient(90deg,var(--accent),#2563eb)!important;color:#fff!important;padding:2.4mm 2mm!important;font-size:9px!important}
    .pro-total-final span,.pro-total-final strong{color:#fff!important}.pro-total-final strong{font-size:12.5px}

    .pro-signatures{display:grid;grid-template-columns:1fr 1fr;gap:14mm;margin-top:4mm;padding:0 8mm}
    .pro-signatures div{text-align:center}.pro-signatures span{display:block;border-top:1px solid #9aa4b2}.pro-signatures small{display:block;font-size:6.6px;color:#697386;margin-top:1mm}
    .pro-footer{margin-top:2.4mm;border-top:1px solid #e5eaf0;padding-top:1.2mm;display:flex;justify-content:space-between;font-size:6.5px;color:#76808d}

    /* Ticket 80 mm */
    .ticket-sheet{width:80mm;min-height:0;margin:10px auto;background:#fff;padding:4mm 3.5mm 5mm;box-shadow:0 8px 28px rgba(0,0,0,.15);font-family:Arial,Helvetica,sans-serif;border-top:5px solid var(--accent);border-radius:8px}
    .ticket-header{text-align:center;font-size:9.2px;line-height:1.4}.ticket-logo{display:block;max-width:50mm;max-height:18mm;object-fit:contain;margin:0 auto 1.8mm}.ticket-header h1{font-size:17px;margin:0 0 .8mm;color:var(--accent2)}
    .ticket-doc{border-top:1px dashed #7d8793;border-bottom:1px dashed #7d8793;padding:2.2mm 0;margin:2.5mm 0;text-align:center;background:#f8fbff}.ticket-doc strong{display:block;font-size:11px;color:var(--accent2)}.ticket-doc span{display:block;font-size:10.5px;font-weight:900;margin-top:.8mm;color:var(--accent)}
    .ticket-lines{font-size:8.4px;line-height:1.4;margin-bottom:2mm}.ticket-table{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:1.8mm}.ticket-table th{font-size:7.2px;border-top:1px solid #9da5ae;border-bottom:1px solid #9da5ae;padding:1.4mm .7mm;text-align:left;color:var(--accent2);background:#eef4fb}.ticket-table td{font-size:7.9px;padding:1.6mm .7mm;border-bottom:1px dotted #c7ccd2;vertical-align:top}.ticket-table th:first-child,.ticket-table td:first-child{width:9mm;text-align:center}.ticket-table th:nth-child(3),.ticket-table td:nth-child(3){width:15mm;text-align:right}.ticket-table th:nth-child(4),.ticket-table td:nth-child(4){width:16mm;text-align:right}
    .ticket-totals{margin-top:2.6mm;border:1px solid #cfd5dd;border-radius:6px;overflow:hidden}.ticket-totals>div{display:flex;justify-content:space-between;padding:1.7mm 1.4mm;font-size:8.6px;border-bottom:1px solid #e2e7ed}.ticket-totals>div:last-child{border-bottom:0}.ticket-grand{font-size:11px!important;font-weight:900;background:var(--accent);color:#fff}.ticket-grand span,.ticket-grand b{color:#fff}.ticket-note{text-align:center;font-size:7.8px;line-height:1.3;margin-top:3.2mm}.ticket-internal{text-align:center;font-size:6.8px;color:#727b87;margin-top:1.6mm}

    /* Orden de servicio */
    .doc-sheet{width:188mm;margin:10px auto;padding:12mm;border-radius:8px}.doc-head{display:grid;grid-template-columns:72px 1fr 150px;gap:12px;align-items:center;border-bottom:3px solid var(--accent);padding-bottom:10px}.doc-logo{width:64px;height:50px;object-fit:contain}.doc-company h1{margin:0 0 4px;font-size:20px}.doc-company p{margin:2px 0;color:#697588;font-size:9px;line-height:1.4}.doc-number{text-align:right}.doc-number span{display:block;font-size:9px;color:#7c8796;font-weight:800}.doc-number strong{display:block;color:var(--accent);font-size:20px;margin-top:6px}.doc-card-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0}.doc-card{border:1px solid #e3e8ef;border-radius:10px;padding:9px}.doc-card span{display:block;font-size:8px;color:#8792a1;font-weight:800;margin-bottom:4px}.doc-card b{display:block;font-size:10px}.doc-card small{display:block;color:#697588;margin-top:4px;font-size:8px}.doc-section{margin-top:13px}.doc-section h3{font-size:11px;color:var(--accent);margin-bottom:6px}.doc-section p{font-size:10px;line-height:1.45}.doc-section table{width:100%;border-collapse:collapse}.doc-section th,.doc-section td{border:1px solid #e4e8ee;padding:7px;font-size:9px;text-align:left}.doc-section th{background:#f7f9fb;width:15%}.signatures{display:flex;justify-content:space-between;text-align:center;margin-top:34px;font-size:9px;color:#5e6877}

    @page{size:A4;margin:6mm}
    @media print{
      html,body{height:auto}
      body{background:#fff}
      .invoice-sheet{width:178mm;margin:0 auto;box-shadow:none;min-height:0!important;height:auto!important;break-inside:avoid-page;page-break-inside:avoid}
      .pro-sheet{padding:0 6mm 4mm;min-height:0!important;height:auto!important}
      .doc-sheet{width:188mm;margin:0 auto;box-shadow:none;break-inside:avoid-page;page-break-inside:avoid}
      .ticket-sheet{margin:0 auto;box-shadow:none;width:80mm}
      .no-print{display:none}
    }
    @media(max-width:800px){
      .invoice-sheet,.doc-sheet{width:100%;margin:0;border-radius:0}
      .pro-header{grid-template-columns:1fr}
      .pro-doc-box{width:100%;max-width:300px}
      .pro-info-grid,.pro-bottom{grid-template-columns:1fr}
      .repair-strip{grid-template-columns:1fr 1fr}
      .pro-signatures{padding:0;gap:12px}
      .pro-footer{flex-direction:column;gap:4px}
      .doc-head{grid-template-columns:1fr}
      .doc-number{text-align:left}
    }
  </style></head><body>${kind === 'order' ? `<div class="doc-sheet">${body}</div>` : body}<script>window.onload=()=>setTimeout(()=>window.print(),180)<\/script></body></html>`);
  w.document.close();
}
function renderCompany() {
  const c = db.company;
  document.getElementById('companyRuc').value = c.ruc || '';
  document.getElementById('companyName').value = c.name || '';
  document.getElementById('companyLegal').value = c.legal || '';
  document.getElementById('companyPhone').value = c.phone || '';
  document.getElementById('companyAddress').value = c.address || '';
  document.getElementById('companyEmail').value = c.email || '';
  document.getElementById('companyTaxRate').value = c.taxRate ?? 15;
  document.getElementById('companyServiceClause').value = c.serviceClause || '';
  document.getElementById('primaryColor').value = c.primary || '#2563eb';
  document.getElementById('secondaryColor').value = c.secondary || '#0f172a';
  renderLogoPreview(logoDraftUrl || c.logo || '');
}

function renderLogoPreview(src) {
  const preview = document.getElementById('companyLogoPreview');
  preview.innerHTML = src ? `<img src="${src}" alt="Vista previa del logo">` : '<span>Sin logo</span>';
}

function toDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

document.getElementById('companyLogo').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  logoDraftUrl = await toDataURL(f);
  renderLogoPreview(logoDraftUrl);
};

document.getElementById('companyForm').onsubmit = async e => {
  e.preventDefault();
  if (!isOwner()) return toast('Solo el propietario puede modificar la configuración');
  Object.assign(db.company, {
    ruc: document.getElementById('companyRuc').value.trim(),
    name: document.getElementById('companyName').value.trim(),
    legal: document.getElementById('companyLegal').value.trim(),
    phone: document.getElementById('companyPhone').value.trim(),
    address: document.getElementById('companyAddress').value.trim(),
    email: document.getElementById('companyEmail').value.trim(),
    taxRate: Number(document.getElementById('companyTaxRate').value || 0),
    serviceClause: document.getElementById('companyServiceClause').value.trim()
  });
  if (logoDraftUrl) db.company.logo = logoDraftUrl;
  logoDraftUrl = '';
  document.getElementById('companyLogo').value = '';
  save();
  toast('Configuración guardada');
};

document.getElementById('applyColorsBtn').onclick = () => {
  if (!isOwner()) return toast('Solo el propietario puede modificar la configuración');
  db.company.primary = document.getElementById('primaryColor').value;
  db.company.secondary = document.getElementById('secondaryColor').value;
  save();
  toast('Colores aplicados');
};

document.getElementById('resetDataBtn').onclick = () => {
  if (!isOwner()) return toast('Solo el propietario puede restablecer datos');
  if (!confirm('Esto borrará toda la información guardada en este navegador. ¿Continuar?')) return;
  db = clone(defaults);
  saleCart = [];
  repairCart = [];
  proformaCart = [];
  activeRepairDeviceId = '';
  activeProformaForSaleId = '';
  logoDraftUrl = '';
  save();
  renderSaleCart();
  renderRepairCart();
  renderProformaCart();
  toast('Datos restablecidos');
};

function openLogoModal() {
  const src = logoDraftUrl || db.company.logo;
  if (!src) return toast('Todavía no hay un logo cargado');
  document.getElementById('logoModalImage').src = src;
  document.getElementById('logoModalName').textContent = db.company.name || 'Logo de la empresa';
  document.getElementById('logoModal').classList.add('open');
  document.getElementById('logoModal').setAttribute('aria-hidden', 'false');
}

function closeLogoModal() {
  document.getElementById('logoModal').classList.remove('open');
  document.getElementById('logoModal').setAttribute('aria-hidden', 'true');
}

document.getElementById('brandLogo').onclick = openLogoModal;
document.getElementById('companyLogoPreview').onclick = openLogoModal;
document.querySelectorAll('[data-close-logo]').forEach(el => el.onclick = closeLogoModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLogoModal(); closeClientHistoryModal(); closeReceivablePaymentModal(); closeInvoiceEmailModal(); } });


function renderMachineInventory() {
  const table = document.getElementById('machineInventoryTable');
  if (!table) return;
  const q = (document.getElementById('machineInventorySearch')?.value || '').toLowerCase();
  const filter = document.getElementById('machineInventoryFilter')?.value || 'all';
  const rows = db.devices.filter(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    const text = [d.order,c?.name,c?.cedula,deviceTypeLabel(d),d.brand,d.model,d.serial,d.status,d.damage].join(' ').toLowerCase();
    const statusOk = filter === 'all' || (filter === 'pending' ? !deviceIsRepaired(d) : d.status === filter);
    return (!q || text.includes(q)) && statusOk;
  });
  document.getElementById('machineInvTotal').textContent = db.devices.length;
  document.getElementById('machineInvPending').textContent = db.devices.filter(d => !deviceIsRepaired(d)).length;
  document.getElementById('machineInvRepaired').textContent = db.devices.filter(d => d.status === 'Reparado').length;
  document.getElementById('machineInvDelivered').textContent = db.devices.filter(d => d.status === 'Entregado').length;
  table.innerHTML = rows.slice().reverse().map(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    const cls = d.status === 'Entregado' || d.status === 'Reparado' ? 'good' : 'warn';
    return `<tr><td><strong>${esc(d.order)}</strong></td><td>${esc(c?.name || '-')}</td><td>${esc(c?.cedula || '-')}</td><td>${esc(deviceTypeLabel(d))}</td><td>${esc(d.brand || '-')} ${esc(d.model || '')}</td><td>${esc(d.serial || '-')}</td><td>${esc(d.date || '-')}</td><td><span class="status ${cls}">${esc(d.status || '')}</span></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">No hay equipos para mostrar.</td></tr>';
}

document.getElementById('machineInventorySearch').oninput = debounce(renderMachineInventory, 120);
document.getElementById('machineInventoryFilter').onchange = renderMachineInventory;


function renderAll() {
  // Render completo solo al iniciar o al cargar datos desde la nube.
  // Los guardados normales usan renderView() para no reconstruir módulos ocultos.
  renderShell();
  renderDashboard();
  renderCash();
  renderClients(document.getElementById('clientSearch')?.value || '');
  renderDevices(document.getElementById('deviceSearch')?.value || '');
  renderProducts(document.getElementById('productSearch')?.value || '');
  renderInventory();
  renderMachineInventory();
  renderInvoices();
  renderProformas();
  renderReceivables();
  renderCompany();
  renderSaleCart();
  renderProformaCart();
  renderRepairWorkspace();
}

renderAll();

// Inicio de sesión / registro
document.getElementById('authForm').onsubmit = async e => {
  e.preventDefault();
  if (!cloudClient) return;
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  setAuthMessage('Iniciando sesión…');
  const { data, error } = await cloudClient.auth.signInWithPassword({ email, password });
  if (error) return setAuthMessage(error.message || 'No se pudo iniciar sesión.', 'error');
  if (data.user) {
    setAuthMessage('Sesión iniciada.', 'success');
    await activateCloudUser(data.user);
  }
};

document.getElementById('signupBtn').onclick = async () => {
  if (!cloudClient) return;
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!email || password.length < 6) return setAuthMessage('Escribe un correo válido y una contraseña de al menos 6 caracteres.', 'error');
  setAuthMessage('Creando cuenta…');
  const { data, error } = await cloudClient.auth.signUp({ email, password });
  if (error) return setAuthMessage(error.message || 'No se pudo crear la cuenta.', 'error');
  if (data.session?.user) {
    setAuthMessage('Cuenta creada correctamente.', 'success');
    await activateCloudUser(data.session.user);
  } else {
    setAuthMessage('Cuenta creada. Revisa tu correo para confirmar la cuenta y después inicia sesión.', 'success');
  }
};

document.getElementById('logoutBtn').onclick = async () => {
  if (!cloudClient) return;
  await cloudSyncChain.catch(() => {});
  const { error } = await cloudClient.auth.signOut();
  if (error) return toast('No se pudo cerrar sesión');
  cloudUser = null;
  cloudReady = false;
  workspaceOwnerId = null; cloudRole = 'owner';
  showAuthOverlay();
  setCloudStatus('offline', '☁ Inicia sesión');
};

initCloud();


// ===== GUÍA INTERACTIVA PASO A PASO CON VOZ =====
const guideState = { view: 'dashboard', index: 0, speaking: false };

const guideSteps = {
  dashboard: [
    { selector: '#sidebarToggle', icon: '↔️', title: 'Minimizar o ampliar el menú', text: 'Usa este botón para hacer el menú lateral más pequeño y ganar espacio en pantalla. Vuelve a pulsarlo para ampliarlo.' },
    { selector: '#view-dashboard .stats-grid', icon: '📊', title: 'Resumen del negocio', text: 'Estas tarjetas muestran ingresos y comprobantes del día, clientes, equipos pendientes, equipos listos para entregar, equipos reparados y alertas de stock.' },
    { selector: '#dashboardCash', icon: '💵', title: 'Estado de caja', text: 'Aquí puedes confirmar si la caja está abierta o cerrada y revisar el valor actual antes de realizar cobros.' },
    { selector: '#recentDevices', icon: '🛠️', title: 'Equipos recientes', text: 'Este bloque muestra los últimos equipos que ingresaron al taller y te ayuda a revisar rápidamente su estado.' },
    { selector: '#recentSales', icon: '🧾', title: 'Últimos comprobantes', text: 'Aquí aparecen las ventas y reparaciones facturadas recientemente, con cliente, fecha y total.' }
  ],
  caja: [
    { selector: '#cashStatusPanel', icon: '🔓', title: 'Abrir y cerrar caja', text: 'Antes de cobrar una venta o reparación debes abrir la caja. Ingresa el monto inicial y al terminar el día realiza el cierre para comparar los valores.' },
    { selector: '#movementForm', icon: '↕️', title: 'Movimientos manuales', text: 'Registra aquí ingresos o egresos que no provengan directamente de una venta, por ejemplo compra de insumos, transporte o un ingreso adicional.' },
    { selector: '#cashMovements', icon: '📋', title: 'Historial de movimientos', text: 'Esta tabla permite revisar todos los movimientos registrados en la caja actual, incluyendo ventas, reparaciones, ingresos y egresos.' }
  ],
  clientes: [
    { selector: '#clientForm', icon: '👤', title: 'Registrar un cliente', text: 'Ingresa cédula o RUC, nombre, teléfono, correo y dirección. Estos datos se utilizarán al registrar equipos, ventas y facturas.' },
    { selector: '#clientEmail', icon: '✉️', title: 'Correo del cliente', text: 'Registra un correo válido para poder preparar o enviar la factura al cliente desde el módulo de facturas.' },
    { selector: '#clientSearch', icon: '🔎', title: 'Buscar clientes', text: 'Puedes buscar por cédula, nombre, teléfono o correo para encontrar rápidamente un registro existente.' },
    { selector: '#clientsTable', icon: '📇', title: 'Listado e historial', text: 'Aquí se muestran los clientes guardados. Usa Historial para revisar sus equipos, reparaciones, facturas y total facturado.' }
  ],
  equipos: [
    { selector: '#deviceClientSearch', icon: '🔎', title: 'Buscar al propietario', text: 'Escribe parte del nombre o de la cédula. Aparecerán coincidencias debajo de la misma barra; toca la persona correcta para seleccionarla.' },
    { selector: '#deviceType', icon: '📷', title: 'Tipo de equipo', text: 'Selecciona el tipo de máquina. Si eliges Otro aparecerá un campo donde puedes escribir Cámara, DVR, NVR, UPS u otro equipo, y ese nombre quedará guardado.' },
    { selector: '#deviceForm', icon: '📝', title: 'Registrar el ingreso', text: 'Completa los datos del equipo y, si corresponde, los días y condiciones de garantía. Puedes Guardar o Guardar e imprimir orden para obtener la orden inmediatamente.' },
    { selector: '#devicesTable', icon: '🗂️', title: 'Órdenes ingresadas', text: 'Aquí administras las órdenes. El botón Factura de reparación abre un módulo separado para agregar productos o repuestos y realizar el cobro sin recargar esta pantalla.' }
  ],
  reparaciones: [
    { selector: '#repairOrderSummary', icon: '🧾', title: 'Orden de reparación', text: 'Al entrar desde Equipos se carga automáticamente la orden elegida. También puedes seleccionar otra orden desde la parte superior.' },
    { selector: '#repairProductSearch', icon: '📦', title: 'Buscar productos', text: 'Escribe nombre, código o categoría. Aparecerán coincidencias con precio y stock. La mano de obra se agrega también como un producto previamente registrado.' },
    { selector: '#repairCartList', icon: '📋', title: 'Detalle de reparación', text: 'Revisa todos los productos agregados a la reparación antes de cobrar.' },
    { selector: '#finishRepairBtn', icon: '✅', title: 'Generar factura de reparación', text: 'Con la caja abierta, este botón marca el equipo como reparado, descuenta productos y genera la factura. Si registras un abono, solo ese valor entra a caja y el resto queda pendiente.' }
  ],
  productos: [
    { selector: '#productCode', icon: '🏷️', title: 'Código único', text: 'Cada producto debe tener un código diferente. El sistema valida que no exista otro producto con el mismo código antes de guardarlo.' },
    { selector: '#productForm', icon: '📦', title: 'Registrar producto', text: 'Completa nombre, categoría, marca, precio de compra, precio de venta, stock y stock mínimo para incorporar un producto.' },
    { selector: '#productPrice', icon: '💲', title: 'Precio con IVA incluido', text: 'El precio que ingreses ya es el precio final con IVA incluido. Si escribes 60 dólares, el cliente pagará 60 dólares; la factura separará internamente subtotal e IVA.' },
    { selector: '#productSearch', icon: '🔎', title: 'Buscar o editar', text: 'Busca por código, nombre, categoría o marca para localizar un producto y editar sus datos.' },
    { selector: '#productsTable', icon: '📋', title: 'Listado de productos', text: 'Esta tabla muestra precios, existencias, estado de stock y las acciones disponibles para cada producto.' }
  ],
  inventario: [
    { selector: '#view-inventario .inventory-stats', icon: '📊', title: 'Resumen de inventario', text: 'Estas tarjetas muestran unidades disponibles, valor de compra, valor potencial de venta y cantidad de productos con stock bajo.' },
    { selector: '#inventorySearch', icon: '🔎', title: 'Buscar en inventario', text: 'Busca rápidamente un artículo por código, nombre, marca o categoría.' },
    { selector: '#inventoryFilter', icon: '🎚️', title: 'Filtrar existencias', text: 'Puedes mostrar todos los productos, solo los que tienen stock, los de stock bajo o los que están agotados.' },
    { selector: '#inventoryTable', icon: '📦', title: 'Existencias actuales', text: 'Esta tabla es una vista de consulta del inventario. Muestra costos, precios con IVA incluido y cantidades disponibles.' }
  ],
  'inventario-equipos': [
    { selector: '#view-inventario-equipos .inventory-stats', icon: '🗃️', title: 'Resumen de máquinas', text: 'Aquí puedes ver cuántos equipos han ingresado, cuántos siguen pendientes, cuántos están reparados y cuántos ya fueron entregados.' },
    { selector: '#machineInventorySearch', icon: '🔎', title: 'Buscar una máquina', text: 'Busca por orden, cliente, cédula, tipo de equipo, marca, modelo o número de serie.' },
    { selector: '#machineInventoryFilter', icon: '🎚️', title: 'Filtrar por estado', text: 'Muestra todos los equipos o únicamente pendientes, reparados o entregados.' },
    { selector: '#machineInventoryTable', icon: '📑', title: 'Historial de equipos', text: 'Esta tabla concentra el historial de las máquinas ingresadas al taller con propietario, identificación, equipo, serie, fecha y estado.' }
  ],
  ventas: [
    { selector: '#saleClientSearch', icon: '👤', title: 'Buscar cliente', text: 'Escribe parte de la cédula o del nombre. Debajo aparecerán las coincidencias con cédula, nombre y teléfono; selecciona una para asignar el cliente.' },
    { selector: '#saleProductSearch', icon: '📦', title: 'Buscar producto', text: 'Escribe nombre, código o categoría. Las coincidencias aparecen debajo con stock y precio; selecciona una para agregarla a la venta.' },
    { selector: '#addProductBtn', icon: '➕', title: 'Agregar al detalle', text: 'Indica la cantidad y agrega el producto. El sistema verifica las existencias antes de completar la venta.' },
    { selector: '#cartList', icon: '🛒', title: 'Detalle de la venta', text: 'Aquí aparecen los productos agregados. Revisa cantidades y precios antes de finalizar.' },
    { selector: '#finishSaleBtn', icon: '🧾', title: 'Finalizar venta', text: 'Selecciona pago total o abono. Al finalizar se descuenta el stock, se genera la factura y solo el monto recibido entra a caja; cualquier diferencia queda como saldo pendiente.' }
  ],
  proformas: [
    { selector: '#proformaClientSearch', icon: '👤', title: 'Cliente de la proforma', text: 'Busca al cliente por cédula o nombre y selecciónalo desde el autocompletado.' },
    { selector: '#proformaProductSearch', icon: '📦', title: 'Productos de la proforma', text: 'Busca productos por nombre, código o categoría y agrega las cantidades que deseas cotizar.' },
    { selector: '#savePrintProformaBtn', icon: '📋', title: 'Guardar e imprimir', text: 'La proforma se guarda sin descontar stock ni registrar dinero en caja. Puedes imprimirla y luego convertirla en venta si el cliente acepta.' },
    { selector: '#proformasTable', icon: '🔁', title: 'Convertir en venta', text: 'Desde el historial puedes cargar una proforma aceptada en Ventas. El stock solo se descuenta al finalizar la venta.' }
  ],
  'cuentas-cobrar': [
    { selector: '#view-cuentas-cobrar .receivable-stats', icon: '💳', title: 'Resumen de saldos', text: 'Consulta cuánto dinero está pendiente, cuántas facturas tienen saldo y cuántos clientes deben.' },
    { selector: '#receivableSearch', icon: '🔎', title: 'Buscar saldos', text: 'Busca por factura, cliente, cédula u orden de reparación.' },
    { selector: '#receivablesTable', icon: '💵', title: 'Registrar abonos', text: 'Usa Registrar abono para ingresar un pago parcial. El valor recibido entra a caja y el saldo se actualiza automáticamente.' }
  ],
  facturas: [
    { selector: '#invoicesTable', icon: '📄', title: 'Historial de facturas', text: 'Aquí encontrarás las facturas de ventas y reparaciones, con total, abonado, saldo y estado de pago. Puedes imprimir, enviar, abonar o eliminar cuando corresponda.' },
    { selector: '#view-facturas .panel-head', icon: '⚠️', title: 'Eliminar con cuidado', text: 'La eliminación de una factura es administrativa. Si borras una factura incorrecta, el sistema intenta revertir los movimientos relacionados, por lo que debes usar esta opción únicamente cuando sea necesario.' }
  ],
  configuracion: [
    { selector: '#companyForm', icon: '🏢', title: 'Datos de la empresa', text: 'Configura RUC, nombre del local, razón social, teléfono, dirección, correo y logo. Estos datos se utilizan en los comprobantes.' },
    { selector: '#companyTaxRate', icon: '％', title: 'IVA incluido', text: 'Define aquí el porcentaje de IVA. Los precios registrados ya incluyen ese IVA: un producto guardado a 60 dólares seguirá costando 60 dólares al cliente.' },
    { selector: '#companyLogoPreview', icon: '🖼️', title: 'Logo de la empresa', text: 'Carga y revisa aquí el logo que aparecerá en el sistema y en los comprobantes.' },
    { selector: '#companyServiceClause', icon: '📜', title: 'Cláusulas de servicio', text: 'Escribe las condiciones propias de tu empresa. Se imprimirán en las órdenes de servicio y en los comprobantes de reparación.' },
    { selector: '#primaryColor', icon: '🎨', title: 'Colores del sistema', text: 'Elige los colores principales de la aplicación y pulsa Aplicar colores para personalizar la identidad visual del negocio.' },
    { selector: '#resetDataBtn', icon: '⚠️', title: 'Restablecer datos', text: 'Esta opción es delicada. Úsala únicamente si realmente necesitas restablecer la información de la aplicación.' }
  ]
};

function getCurrentGuideView() {
  const activeView = document.querySelector('.view.active');
  if (activeView?.id?.startsWith('view-')) return activeView.id.replace(/^view-/, '');
  return document.querySelector('.nav-item.active')?.dataset.view || 'dashboard';
}

function guideAvailableViews() {
  return Object.keys(guideSteps);
}

function populateGuideModules(selected) {
  const sel = document.getElementById('guideModuleSelect');
  if (!sel) return;
  const views = guideAvailableViews();
  sel.innerHTML = views.map(v => `<option value="${esc(v)}">${esc(viewMeta[v]?.[0] || v)}</option>`).join('');
  sel.value = views.includes(selected) ? selected : views[0];
}

function clearGuideHighlight() {
  document.querySelectorAll('.guide-highlight').forEach(el => el.classList.remove('guide-highlight'));
}

function stopGuideVoice() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  guideState.speaking = false;
  const status = document.getElementById('guideVoiceStatus');
  if (status) status.textContent = 'Voz lista';
}

function guideSpeak(text) {
  stopGuideVoice();
  if (!('speechSynthesis' in window)) {
    const status = document.getElementById('guideVoiceStatus');
    if (status) status.textContent = 'Voz no disponible';
    return;
  }
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'es-EC';
  utter.rate = 0.96;
  utter.pitch = 1;
  const voices = window.speechSynthesis.getVoices();
  const voice = voices.find(v => /^es-EC/i.test(v.lang)) || voices.find(v => /^es-/i.test(v.lang));
  if (voice) utter.voice = voice;
  utter.onstart = () => {
    guideState.speaking = true;
    const status = document.getElementById('guideVoiceStatus');
    if (status) status.textContent = 'Voz activa';
  };
  utter.onend = utter.onerror = () => {
    guideState.speaking = false;
    const status = document.getElementById('guideVoiceStatus');
    if (status) status.textContent = 'Voz lista';
  };
  window.speechSynthesis.speak(utter);
}

function renderGuideStep({ speak = true } = {}) {
  const steps = guideSteps[guideState.view] || [];
  if (!steps.length) return;
  guideState.index = Math.max(0, Math.min(guideState.index, steps.length - 1));
  const step = steps[guideState.index];
  clearGuideHighlight();

  const title = document.getElementById('guideTitle');
  const count = document.getElementById('guideStepCount');
  const bar = document.getElementById('guideProgressBar');
  const stepTitle = document.getElementById('guideStepTitle');
  const stepText = document.getElementById('guideStepText');
  const icon = document.getElementById('guideStepIcon');
  const prev = document.getElementById('guidePrevBtn');
  const next = document.getElementById('guideNextBtn');
  if (title) title.textContent = `Guía · ${viewMeta[guideState.view]?.[0] || 'Apartado'}`;
  if (count) count.textContent = `Paso ${guideState.index + 1} de ${steps.length}`;
  if (bar) bar.style.width = `${((guideState.index + 1) / steps.length) * 100}%`;
  if (stepTitle) stepTitle.textContent = step.title;
  if (stepText) stepText.textContent = step.text;
  if (icon) icon.innerHTML = svgIcon('guide');
  if (prev) prev.disabled = guideState.index === 0;
  if (next) next.textContent = guideState.index === steps.length - 1 ? 'Finalizar ✓' : 'Siguiente →';

  const target = document.querySelector(step.selector);
  if (target) {
    target.classList.add('guide-highlight');
    setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }), 70);
  }
  if (speak && document.getElementById('guideAutoVoice')?.checked) {
    guideSpeak(`${step.title}. ${step.text}`);
  }
}

function startGuide(view = getCurrentGuideView()) {
  if (!guideSteps[view]) view = 'dashboard';
  if (!guideAvailableViews().includes(view)) view = 'dashboard';
  guideState.view = view;
  guideState.index = 0;
  populateGuideModules(view);
  if (getCurrentGuideView() !== view) showView(view);
  document.getElementById('guidePanel')?.classList.add('open');
  document.getElementById('guidePanel')?.setAttribute('aria-hidden', 'false');
  document.body.classList.add('guide-active');
  renderGuideStep({ speak: true });
}

function closeGuide() {
  stopGuideVoice();
  clearGuideHighlight();
  document.getElementById('guidePanel')?.classList.remove('open');
  document.getElementById('guidePanel')?.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('guide-active');
}

function guideNext() {
  const steps = guideSteps[guideState.view] || [];
  if (guideState.index >= steps.length - 1) {
    guideSpeak('Guía finalizada. Ya puedes utilizar este apartado.');
    setTimeout(closeGuide, 900);
    return;
  }
  guideState.index += 1;
  renderGuideStep({ speak: true });
}

function guidePrev() {
  if (guideState.index <= 0) return;
  guideState.index -= 1;
  renderGuideStep({ speak: true });
}

const guideHelpBtn = document.getElementById('guideHelpBtn');
if (guideHelpBtn) guideHelpBtn.onclick = () => startGuide(getCurrentGuideView());
document.getElementById('guideCloseBtn')?.addEventListener('click', closeGuide);
document.getElementById('guideNextBtn')?.addEventListener('click', guideNext);
document.getElementById('guidePrevBtn')?.addEventListener('click', guidePrev);
document.getElementById('guideSpeakBtn')?.addEventListener('click', () => {
  const step = (guideSteps[guideState.view] || [])[guideState.index];
  if (step) guideSpeak(`${step.title}. ${step.text}`);
});
document.getElementById('guideModuleSelect')?.addEventListener('change', e => {
  const view = e.target.value;
  if (!guideSteps[view]) return;
  stopGuideVoice();
  clearGuideHighlight();
  showView(view);
  guideState.view = view;
  guideState.index = 0;
  renderGuideStep({ speak: true });
});
document.getElementById('guideAutoVoice')?.addEventListener('change', e => {
  if (!e.target.checked) stopGuideVoice();
  else {
    const step = (guideSteps[guideState.view] || [])[guideState.index];
    if (step) guideSpeak(`${step.title}. ${step.text}`);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('guidePanel')?.classList.contains('open')) closeGuide();
  if (!document.getElementById('guidePanel')?.classList.contains('open')) return;
  if (e.key === 'ArrowRight') guideNext();
  if (e.key === 'ArrowLeft') guidePrev();
});
