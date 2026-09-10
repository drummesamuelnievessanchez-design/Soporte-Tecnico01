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

const defaults = {
  company: { ruc: '', name: 'Soporte360', legal: '', phone: '', address: '', email: '', logo: '', primary: '#2563eb', secondary: '#0f172a' },
  cash: { open: false, opening: 0, openedAt: null, closedAt: null, lastClosedTotal: 0, movements: [] },
  clients: [],
  devices: [],
  products: [],
  sales: []
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
      sales: Array.isArray(raw.sales) ? raw.sales : []
    };
  } catch (e) {
    return clone(defaults);
  }
}

let db = load();
let saleCart = [];
let repairCart = [];
let activeRepairDeviceId = '';
let logoDraftUrl = '';

function save(render = true) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  if (render) renderAll();
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
  equipos: ['Equipos', 'Recepción, reparación y seguimiento técnico'],
  productos: ['Inventario', 'Productos, repuestos y stock'],
  ventas: ['Ventas', 'Venta directa de productos'],
  facturas: ['Facturas', 'Historial de ventas y reparaciones'],
  configuracion: ['Configuración', 'Empresa, logo y colores']
};

function showView(v) {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
  document.getElementById('view-' + v).classList.add('active');
  document.getElementById('pageTitle').textContent = viewMeta[v][0];
  document.getElementById('pageSubtitle').textContent = viewMeta[v][1];
}

document.querySelectorAll('.nav-item').forEach(b => b.onclick = () => showView(b.dataset.view));
document.getElementById('todayLabel').textContent = new Date().toLocaleDateString('es-EC', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
document.getElementById('quickOpenCash').onclick = () => { showView('caja'); window.scrollTo({ top: 0, behavior: 'smooth' }); };

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

function renderDashboard() {
  const todaySales = db.sales.filter(isSaleToday);
  document.getElementById('statSales').textContent = money(todaySales.reduce((a, s) => a + Number(s.total || 0), 0));
  document.getElementById('statClients').textContent = db.clients.length;
  document.getElementById('statDevices').textContent = db.devices.length;
  document.getElementById('statLowStock').textContent = db.products.filter(p => Number(p.stock) <= Number(p.min)).length;

  document.getElementById('dashboardCash').innerHTML = db.cash.open
    ? `<div class="cash-box"><span class="status good">ABIERTA</span><strong>${money(cashBalance())}</strong><div class="muted">Apertura: ${money(db.cash.opening)} · ${esc(db.cash.openedAt || '')}</div></div>`
    : `<div class="cash-box"><span class="status bad">CERRADA</span><strong>${money(0)}</strong><div class="muted">Debe abrir caja antes de registrar cobros.</div></div>`;

  document.getElementById('recentDevices').innerHTML = db.devices.slice(-5).reverse().map(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    return `<div class="list-item"><div><strong>${esc(d.order)} · ${esc(d.brand)} ${esc(d.model)}</strong><div class="muted">${esc(c?.name || 'Cliente')}</div></div><span class="status">${esc(d.status)}</span></div>`;
  }).join('') || '<div class="empty">No hay equipos registrados.</div>';

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

function clientOptions(selected = '') {
  return '<option value="">Seleccione...</option>' + db.clients.map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.cedula)} · ${esc(c.name)}</option>`).join('');
}

function renderClients(filter = '') {
  const q = filter.toLowerCase();
  document.getElementById('clientsTable').innerHTML = db.clients.filter(c => [c.cedula, c.name, c.phone, c.address].join(' ').toLowerCase().includes(q)).map(c => `
    <tr><td>${esc(c.cedula)}</td><td><strong>${esc(c.name)}</strong></td><td>${esc(c.phone)}</td><td>${esc(c.address)}</td><td><button class="mini" onclick="editClient('${c.id}')">Editar</button></td></tr>
  `).join('') || '<tr><td colspan="5" class="empty">No hay clientes.</td></tr>';

  const deviceSelected = document.getElementById('deviceClient')?.value || '';
  const saleSelected = document.getElementById('saleClient')?.value || '';
  document.getElementById('deviceClient').innerHTML = clientOptions(deviceSelected);
  document.getElementById('saleClient').innerHTML = clientOptions(saleSelected);
}

document.getElementById('clientSearch').oninput = e => renderClients(e.target.value);
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
  document.getElementById('clientAddress').value = c.address;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

function nextOrderNumber() {
  const nums = db.devices.map(d => Number(String(d.order || '').replace(/\D/g, '')) || 0);
  return 'OT-' + String(Math.max(0, ...nums) + 1).padStart(6, '0');
}

function renderDevices(filter = '') {
  const q = filter.toLowerCase();
  const filtered = db.devices.filter(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    return [d.order, c?.name, c?.cedula, d.type, d.brand, d.model, d.serial, d.damage, d.status].join(' ').toLowerCase().includes(q);
  });

  document.getElementById('devicesTable').innerHTML = filtered.map(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    const alreadyInvoiced = !!d.repairSaleId;
    const invoiceButton = alreadyInvoiced ? `<button class="mini good-mini" onclick="printInvoice('${d.repairSaleId}')">Factura</button>` : `<button class="mini primary-mini" onclick="openRepair('${d.id}')">Reparar</button>`;
    const deliveredButton = d.status === 'Reparado' ? `<button class="mini" onclick="markDelivered('${d.id}')">Entregado</button>` : '';
    return `<tr>
      <td><strong>${esc(d.order)}</strong><br><span class="muted">${esc(d.date || '')}</span></td>
      <td>${esc(c?.name || '')}</td>
      <td>${esc(d.type)}<br><span class="muted">${esc(d.brand)} ${esc(d.model)}</span></td>
      <td>${esc(d.serial || '-')}</td>
      <td>${esc(d.damage)}</td>
      <td><span class="status ${d.status === 'Reparado' || d.status === 'Entregado' ? 'good' : ''}">${esc(d.status)}</span></td>
      <td><div class="action-row">${invoiceButton}${deliveredButton}<button class="mini" onclick="editDevice('${d.id}')">Editar</button><button class="mini" onclick="printWorkOrder('${d.id}')">Orden</button></div></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No hay equipos.</td></tr>';

  renderRepairOrderOptions();
}

document.getElementById('deviceSearch').oninput = e => renderDevices(e.target.value);
document.getElementById('deviceForm').onsubmit = e => {
  e.preventDefault();
  const id = document.getElementById('deviceId').value;
  const prev = db.devices.find(d => d.id === id);
  const obj = {
    ...(prev || {}),
    id: id || uid('EQ'),
    order: prev?.order || nextOrderNumber(),
    clientId: document.getElementById('deviceClient').value,
    type: document.getElementById('deviceType').value,
    brand: document.getElementById('deviceBrand').value.trim(),
    model: document.getElementById('deviceModel').value.trim(),
    serial: document.getElementById('deviceSerial').value.trim(),
    damage: document.getElementById('deviceDamage').value.trim(),
    notes: document.getElementById('deviceNotes').value.trim(),
    status: document.getElementById('deviceStatus').value,
    date: prev?.date || now()
  };
  if (id) db.devices = db.devices.map(d => d.id === id ? obj : d); else db.devices.push(obj);
  e.target.reset();
  document.getElementById('deviceId').value = '';
  save();
  toast('Equipo guardado');
};

window.editDevice = id => {
  const d = db.devices.find(x => x.id === id);
  if (!d) return;
  showView('equipos');
  const map = {
    deviceId: 'id', deviceClient: 'clientId', deviceType: 'type', deviceBrand: 'brand', deviceModel: 'model', deviceSerial: 'serial', deviceDamage: 'damage', deviceNotes: 'notes', deviceStatus: 'status'
  };
  Object.entries(map).forEach(([el, prop]) => document.getElementById(el).value = d[prop] ?? '');
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

function renderRepairOrderOptions() {
  const select = document.getElementById('repairOrderSelect');
  const current = activeRepairDeviceId || select.value;
  select.innerHTML = '<option value="">Seleccione una orden...</option>' + db.devices.slice().reverse().map(d => {
    const c = db.clients.find(x => x.id === d.clientId);
    const tag = d.repairSaleId ? ' · FACTURADA' : '';
    return `<option value="${d.id}" ${d.id === current ? 'selected' : ''}>${esc(d.order)} · ${esc(c?.name || '')} · ${esc(d.brand)} ${esc(d.model)}${tag}</option>`;
  }).join('');
}

function renderRepairProducts() {
  const select = document.getElementById('repairProduct');
  const current = select.value;
  select.innerHTML = '<option value="">Seleccione un producto...</option>' + db.products.filter(p => Number(p.stock) > 0).map(p => `<option value="${p.id}" ${p.id === current ? 'selected' : ''}>${esc(p.code)} · ${esc(p.name)} · ${money(p.price)} · Stock ${p.stock}</option>`).join('');
  updateRepairProductPreview();
}

function updateRepairProductPreview() {
  const id = document.getElementById('repairProduct').value;
  const p = db.products.find(x => x.id === id);
  document.getElementById('repairProductPreview').innerHTML = p
    ? `<strong>${esc(p.name)}</strong> · Precio: <strong>${money(p.price)}</strong> · Stock disponible: <strong>${p.stock}</strong>${p.brand ? ` · Marca: ${esc(p.brand)}` : ''}`
    : 'Selecciona un producto para ver precio y stock.';
}

document.getElementById('repairProduct').onchange = updateRepairProductPreview;

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
  showView('equipos');
  loadRepairOrder(id, true);
  setTimeout(() => document.getElementById('repairPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
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
    <div class="repair-summary-item"><span>Equipo</span><strong>${esc(d.type)} · ${esc(d.brand)} ${esc(d.model)}</strong></div>
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
  renderRepairCart();
};

document.getElementById('addRepairServiceBtn').onclick = () => {
  const d = db.devices.find(x => x.id === activeRepairDeviceId);
  if (!d) return toast('Primero seleccione una orden');
  if (d.repairSaleId) return toast('Esta reparación ya fue facturada');
  const name = document.getElementById('repairServiceDesc').value.trim();
  const price = Number(document.getElementById('repairServicePrice').value || 0);
  if (!name || price <= 0) return toast('Ingrese descripción y valor de mano de obra');
  repairCart.push({ type: 'service', name, qty: 1, price });
  document.getElementById('repairServiceDesc').value = '';
  document.getElementById('repairServicePrice').value = '';
  renderRepairCart();
};

window.removeRepairCart = idx => {
  repairCart.splice(idx, 1);
  renderRepairCart();
};

document.getElementById('repairTaxRate').oninput = renderRepairCart;

function renderRepairCart() {
  const subtotal = repairCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const taxRate = Number(document.getElementById('repairTaxRate').value || 0);
  const total = subtotal * (1 + taxRate / 100);
  document.getElementById('repairCartList').innerHTML = repairCart.map((i, idx) => `
    <div class="cart-item"><div><strong>${i.type === 'product' ? '📦 ' : '🛠️ '}${esc(i.name)}</strong><div class="muted">${i.type === 'product' ? `${esc(i.code || '')} · ` : ''}${i.qty} × ${money(i.price)}</div></div><div class="cart-item-price"><strong>${money(i.qty * i.price)}</strong><button class="mini danger" onclick="removeRepairCart(${idx})">×</button></div></div>
  `).join('') || '<div class="empty">Aún no se han agregado repuestos ni mano de obra.</div>';
  document.getElementById('repairSubtotal').textContent = money(subtotal);
  document.getElementById('repairTotal').textContent = money(total);
}

document.getElementById('finishRepairBtn').onclick = () => {
  if (!db.cash.open) return toast('Debe abrir la caja antes de cobrar la reparación');
  const d = db.devices.find(x => x.id === activeRepairDeviceId);
  if (!d) return toast('Seleccione una orden');
  if (d.repairSaleId) return toast('Esta reparación ya tiene factura');
  if (!repairCart.length) return toast('Agregue al menos un repuesto o mano de obra');

  for (const i of repairCart.filter(i => i.type === 'product')) {
    const p = db.products.find(x => x.id === i.productId);
    if (!p || Number(p.stock) < Number(i.qty)) return toast('Stock insuficiente para ' + i.name);
  }

  const c = db.clients.find(x => x.id === d.clientId);
  if (!c) return toast('El equipo no tiene un cliente válido');

  const subtotal = repairCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const taxRate = Number(document.getElementById('repairTaxRate').value || 0);
  const tax = subtotal * taxRate / 100;
  const total = subtotal + tax;
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
    payment: document.getElementById('repairPaymentMethod').value,
    items: clone(repairCart),
    subtotal, taxRate, tax, total
  };

  sale.items.filter(i => i.type === 'product').forEach(i => {
    const p = db.products.find(x => x.id === i.productId);
    p.stock -= Number(i.qty);
  });

  db.sales.push(sale);
  d.status = 'Reparado';
  d.repairedAt = now();
  d.repairSaleId = sale.id;
  db.cash.movements.push({ id: uid('MOV'), date: now(), type: 'ingreso', amount: total, concept: `Reparación ${d.order} · ${sale.number}` });

  repairCart = [];
  save();
  renderRepairCart();
  printInvoice(sale.id);
  toast('Reparación finalizada y facturada');
};

window.printWorkOrder = id => {
  const d = db.devices.find(x => x.id === id);
  if (!d) return;
  const c = db.clients.find(x => x.id === d.clientId);
  const logo = db.company.logo ? `<img src="${db.company.logo}" class="doc-logo">` : '';
  const body = `
    <div class="doc-head"><div>${logo}</div><div class="doc-company"><h1>${esc(db.company.name)}</h1><p>${esc(db.company.legal || '')}<br>RUC: ${esc(db.company.ruc || '-')} · Tel: ${esc(db.company.phone || '-')}<br>${esc(db.company.address || '')}</p></div><div class="doc-number"><span>ORDEN DE SERVICIO</span><strong>${esc(d.order)}</strong></div></div>
    <div class="doc-card-grid"><div class="doc-card"><span>CLIENTE</span><b>${esc(c?.name || '')}</b><small>${esc(c?.cedula || '')} · ${esc(c?.phone || '')}</small></div><div class="doc-card"><span>RECEPCIÓN</span><b>${esc(d.date || '')}</b><small>Estado: ${esc(d.status)}</small></div></div>
    <div class="doc-section"><h3>Datos del equipo</h3><table><tbody><tr><th>Tipo</th><td>${esc(d.type)}</td><th>Marca</th><td>${esc(d.brand)}</td></tr><tr><th>Modelo</th><td>${esc(d.model)}</td><th>Serie</th><td>${esc(d.serial || '-')}</td></tr></tbody></table></div>
    <div class="doc-section"><h3>Daño reportado</h3><p>${esc(d.damage)}</p></div>
    <div class="doc-section"><h3>Observaciones</h3><p>${esc(d.notes || 'Sin observaciones.')}</p></div>
    <div class="signatures"><div>____________________________<br>Firma del cliente</div><div>____________________________<br>Recepción / técnico</div></div>
  `;
  printHtml(`Orden ${d.order}`, body, 'order');
};

function renderProducts(filter = '') {
  const q = filter.toLowerCase();
  document.getElementById('productsTable').innerHTML = db.products.filter(p => [p.code, p.name, p.category, p.brand].join(' ').toLowerCase().includes(q)).map(p => `
    <tr><td>${esc(p.code)}</td><td><strong>${esc(p.name)}</strong><br><span class="muted">${esc(p.category || '')}</span></td><td>${money(p.cost)}</td><td>${money(p.price)}</td><td>${p.stock}</td><td><span class="status ${Number(p.stock) <= Number(p.min) ? 'bad' : 'good'}">${Number(p.stock) <= Number(p.min) ? 'Stock bajo' : 'Disponible'}</span></td><td><button class="mini" onclick="editProduct('${p.id}')">Editar</button></td></tr>
  `).join('') || '<tr><td colspan="7" class="empty">No hay productos.</td></tr>';

  const currentSale = document.getElementById('saleProduct')?.value || '';
  document.getElementById('saleProduct').innerHTML = '<option value="">Seleccione...</option>' + db.products.filter(p => Number(p.stock) > 0).map(p => `<option value="${p.id}" ${p.id === currentSale ? 'selected' : ''}>${esc(p.code)} · ${esc(p.name)} · ${money(p.price)} · Stock ${p.stock}</option>`).join('');
  renderRepairProducts();
}

document.getElementById('productSearch').oninput = e => renderProducts(e.target.value);
document.getElementById('productForm').onsubmit = e => {
  e.preventDefault();
  const id = document.getElementById('productId').value;
  const obj = {
    id: id || uid('PROD'),
    code: document.getElementById('productCode').value.trim(),
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
  const subtotal = saleCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const taxRate = Number(document.getElementById('taxRate').value || 0);
  const total = subtotal * (1 + taxRate / 100);
  document.getElementById('cartList').innerHTML = saleCart.map((i, idx) => `
    <div class="cart-item"><div><strong>📦 ${esc(i.name)}</strong><div class="muted">${esc(i.code || '')} · ${i.qty} × ${money(i.price)}</div></div><div class="cart-item-price"><strong>${money(i.qty * i.price)}</strong><button class="mini danger" onclick="removeSaleCart(${idx})">×</button></div></div>
  `).join('') || '<div class="empty">Agregue productos a la venta.</div>';
  document.getElementById('saleSubtotal').textContent = money(subtotal);
  document.getElementById('saleTotal').textContent = money(total);
}

document.getElementById('taxRate').oninput = renderSaleCart;
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

  const subtotal = saleCart.reduce((a, i) => a + Number(i.price) * Number(i.qty), 0);
  const taxRate = Number(document.getElementById('taxRate').value || 0);
  const tax = subtotal * taxRate / 100;
  const total = subtotal + tax;
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
    payment: document.getElementById('paymentMethod').value,
    items: clone(saleCart),
    subtotal, taxRate, tax, total
  };

  sale.items.forEach(i => {
    const p = db.products.find(x => x.id === i.productId);
    p.stock -= Number(i.qty);
  });
  db.sales.push(sale);
  db.cash.movements.push({ id: uid('MOV'), date: now(), type: 'ingreso', amount: total, concept: 'Venta ' + sale.number });
  saleCart = [];
  save();
  renderSaleCart();
  printInvoice(sale.id);
  toast('Venta registrada');
};

function renderInvoices() {
  document.getElementById('invoicesTable').innerHTML = db.sales.slice().reverse().map(s => `
    <tr>
      <td><strong>${esc(s.number)}</strong></td>
      <td><span class="status ${s.source === 'repair' ? 'warn' : 'good'}">${saleTypeLabel(s)}</span></td>
      <td>${esc(s.order || '-')}</td>
      <td>${esc(s.date)}</td>
      <td>${esc(s.clientName)}</td>
      <td>${esc(s.payment)}</td>
      <td><strong>${money(s.total)}</strong></td>
      <td><div class="action-row"><button class="mini primary-mini" onclick="printInvoice('${s.id}','a4')">A4</button><button class="mini" onclick="printInvoice('${s.id}','ticket')">Ticket 80 mm</button></div></td>
    </tr>
  `).join('') || '<tr><td colspan="8" class="empty">No hay facturas.</td></tr>';
}

window.printInvoice = (id, format = 'a4') => {
  const s = db.sales.find(x => x.id === id);
  if (!s) return;
  const d = s.deviceId ? db.devices.find(x => x.id === s.deviceId) : null;
  const c = db.clients.find(x => x.id === s.clientId) || {};
  const companyName = db.company.name || 'Soporte360';
  const logo = db.company.logo ? `<img src="${db.company.logo}" class="pro-logo" alt="Logo">` : `<div class="pro-logo-placeholder">${esc(companyName.charAt(0).toUpperCase())}</div>`;
  const ticketLogo = db.company.logo ? `<img src="${db.company.logo}" class="ticket-logo" alt="Logo">` : '';
  const itemRows = (s.items || []).map((i, idx) => {
    const code = i.type === 'service' ? 'SERV' : (i.code || '-');
    return `<tr><td class="num">${idx + 1}</td><td class="code">${esc(code)}</td><td><div class="desc-main">${esc(i.name)}</div><div class="desc-type">${i.type === 'service' ? 'Servicio / mano de obra' : 'Producto / repuesto'}</div></td><td class="qty">${Number(i.qty)}</td><td class="money-cell">${money(i.price)}</td><td class="money-cell total-cell">${money(Number(i.price) * Number(i.qty))}</td></tr>`;
  }).join('');
  const blankRows = '';

  const repairBlock = s.source === 'repair' && d ? `
    <section class="repair-strip">
      <div><span>Orden de trabajo</span><strong>${esc(s.order || d.order)}</strong></div>
      <div><span>Equipo</span><strong>${esc(d.type)} · ${esc(d.brand)} ${esc(d.model)}</strong></div>
      <div><span>N.º de serie</span><strong>${esc(d.serial || '-')}</strong></div>
      <div><span>Estado</span><strong>REPARADO</strong></div>
    </section>` : '';

  if (format === 'ticket') {
    const ticketItems = (s.items || []).map(i => `
      <tr><td>${Number(i.qty)}</td><td>${esc(i.name)}</td><td>${money(i.price)}</td><td>${money(Number(i.price) * Number(i.qty))}</td></tr>
    `).join('');
    const ticketRepair = s.source === 'repair' && d ? `<div class="ticket-lines"><div><b>Orden:</b> ${esc(s.order || d.order)}</div><div><b>Equipo:</b> ${esc(d.type)} ${esc(d.brand)} ${esc(d.model)}</div><div><b>Serie:</b> ${esc(d.serial || '-')}</div></div>` : '';
    const ticketBody = `
      <div class="ticket-sheet">
        <header class="ticket-header">${ticketLogo}<h1>${esc(companyName)}</h1>${db.company.legal ? `<div>${esc(db.company.legal)}</div>` : ''}<div>${esc(db.company.address || '')}</div><div>RUC: ${esc(db.company.ruc || '-')}</div><div>Tel: ${esc(db.company.phone || '-')}</div></header>
        <div class="ticket-doc"><strong>COMPROBANTE</strong><span>${esc(s.number)}</span></div>
        <div class="ticket-lines"><div><b>Cliente:</b> ${esc(s.clientName || '')}</div><div><b>CI/RUC:</b> ${esc(s.clientCedula || '-')}</div><div><b>Teléfono:</b> ${esc(s.clientPhone || c.phone || '-')}</div><div><b>Fecha:</b> ${esc(s.date || '')}</div><div><b>Pago:</b> ${esc(s.payment || '')}</div></div>
        ${ticketRepair}
        <table class="ticket-table"><thead><tr><th>Cant.</th><th>Descripción</th><th>P.U.</th><th>Total</th></tr></thead><tbody>${ticketItems}</tbody></table>
        <div class="ticket-totals"><div><span>SUBTOTAL</span><b>${money(s.subtotal)}</b></div><div><span>IVA ${Number(s.taxRate || 0)}%</span><b>${money(s.tax)}</b></div><div class="ticket-grand"><span>TOTAL</span><b>${money(s.total)}</b></div></div>
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
          <div class="info-row"><span>Teléfono</span><strong>${esc(s.clientPhone || c.phone || '-')}</strong></div>
        </div>
        <div class="pro-info-box issue-info">
          <div class="box-title">DATOS DEL COMPROBANTE</div>
          <div class="info-row"><span>Fecha emisión</span><strong>${esc(s.date || '')}</strong></div>
          <div class="info-row"><span>Forma de pago</span><strong>${esc(s.payment || '-')}</strong></div>
          <div class="info-row"><span>Tipo</span><strong>${s.source === 'repair' ? 'Reparación' : 'Venta'}</strong></div>
          <div class="info-row"><span>N.º control</span><strong>${esc(s.order || s.number)}</strong></div>
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
          <p>${s.source === 'repair' && d ? `Servicio correspondiente a la orden ${esc(s.order || d.order)}. Equipo: ${esc(d.type)} ${esc(d.brand)} ${esc(d.model)}.` : 'Venta de productos registrada en el sistema.'}</p>
          <div class="thanks-message"><strong>Gracias por confiar en ${esc(companyName)}.</strong><br>Conserve este comprobante para futuras consultas.</div>
        </div>
        <div class="pro-totals">
          <div><span>SUBTOTAL</span><strong>${money(s.subtotal)}</strong></div>
          <div><span>IVA ${Number(s.taxRate || 0)}%</span><strong>${money(s.tax)}</strong></div>
          <div class="pro-total-final"><span>VALOR TOTAL</span><strong>${money(s.total)}</strong></div>
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

    .repair-strip{display:grid;grid-template-columns:.82fr 1.42fr 1fr .55fr;gap:0;border:1px solid #d3dbe5;border-radius:7px;overflow:hidden;margin-top:2.4mm;background:#fbfdff}
    .repair-strip>div{padding:1.9mm 2.1mm;border-right:1px solid #e2e8f0}
    .repair-strip>div:last-child{border-right:0;background:#ecfdf5}
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
    .pro-observations p{font-size:7.6px;color:#515b68;line-height:1.28;margin:0;padding:1.8mm 2.4mm .5mm}
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
  Object.assign(db.company, {
    ruc: document.getElementById('companyRuc').value.trim(),
    name: document.getElementById('companyName').value.trim(),
    legal: document.getElementById('companyLegal').value.trim(),
    phone: document.getElementById('companyPhone').value.trim(),
    address: document.getElementById('companyAddress').value.trim(),
    email: document.getElementById('companyEmail').value.trim()
  });
  if (logoDraftUrl) db.company.logo = logoDraftUrl;
  logoDraftUrl = '';
  document.getElementById('companyLogo').value = '';
  save();
  toast('Configuración guardada');
};

document.getElementById('applyColorsBtn').onclick = () => {
  db.company.primary = document.getElementById('primaryColor').value;
  db.company.secondary = document.getElementById('secondaryColor').value;
  save();
  toast('Colores aplicados');
};

document.getElementById('resetDataBtn').onclick = () => {
  if (!confirm('Esto borrará toda la información guardada en este navegador. ¿Continuar?')) return;
  db = clone(defaults);
  saleCart = [];
  repairCart = [];
  activeRepairDeviceId = '';
  logoDraftUrl = '';
  save();
  renderSaleCart();
  renderRepairCart();
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLogoModal(); });

function renderAll() {
  applyTheme();
  renderDashboard();
  renderCash();
  renderClients(document.getElementById('clientSearch')?.value || '');
  renderDevices(document.getElementById('deviceSearch')?.value || '');
  renderProducts(document.getElementById('productSearch')?.value || '');
  renderInvoices();
  renderCompany();
  renderSaleCart();
  renderRepairWorkspace();
}

renderAll();
