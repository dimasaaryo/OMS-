'use strict';
/* =====================================================================
   OMS Bengkel · aplikasi web (GitHub Pages + Supabase)
   ===================================================================== */
const CFG = window.OMS_CONFIG || {};
const TZ = 'Asia/Jakarta';
// 'internal' = stok dikelola di OMS (layar Gudang); 'wms' = stok lewat Edge Function ke WMS
const INTERNAL = (CFG.WMS_MODE || 'internal') !== 'wms';
const WH = INTERNAL ? 'gudang' : 'WMS';

const ROLES = {admin:'Admin', kepala_bengkel:'Kepala Bengkel', sa:'Service Advisor', mekanik:'Mekanik', sales_counter:'Sales Counter', admin_gudang:'Admin Gudang', kasir:'Kasir / Finance'};
const STATUSES = ['Antre','Diagnosa','Estimasi disetujui','Tunggu Part','Dikerjakan','QC','Siap Ambil','Selesai'];
const WO_CHIP = {'Antre':'gray','Diagnosa':'blue','Estimasi disetujui':'orange','Tunggu Part':'purple','Dikerjakan':'amber','QC':'teal','Siap Ambil':'green','Selesai':'gray','Batal':'gray'};
const EST = {draft:['gray','Belum dikirim'], sent:['amber','Menunggu pelanggan'], revisi:['amber','Perlu persetujuan ulang'], approved:['green','Disetujui'], rejected:['red','Ditolak']};
const LINE = {
  draft:['gray','Draft'], queued:['amber','Menunggu WMS'], reserved_temp:['blue','Reservasi sementara'], reserved:['orange','Ter-reservasi'],
  backorder:['purple','Backorder'], failed:['red','Reservasi gagal'], picking:['amber','Picking'], picked:['teal','Picked'],
  issued:['green','Goods issue'], returning:['amber','Retur diproses'], returned:['gray','Diretur'], released:['gray','Dilepas']
};
const SO_CHIP = {'Draft':'gray','Menunggu approval Finance':'red','Dikonfirmasi':'orange','Dibayar':'blue','Picking':'amber','Siap invoice':'teal','Invoiced sebagian':'teal','Invoiced':'green','Dibatalkan':'gray','Kedaluwarsa':'gray'};
const CUST_TYPE = {servis:'Pelanggan servis', retail:'Retail counter', b2b:'B2B grosir', mitra:'Bengkel mitra'};
const FUEL = ['E','¼','½','¾','F'];
const EQUIP = ['STNK','Kunci serep','Ban serep','Dongkrak','Toolkit','Buku servis'];
const SIDES = ['Depan','Belakang','Kiri','Kanan'];

const ICON = {
  dashboard:'<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  checkin:'<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  wo:'<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/>',
  sales:'<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
  kasir:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  stok:'<path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/>',
  gudang:'<path d="M3 21V8l9-5 9 5v13"/><path d="M7 21v-8h10v8M7 17h10"/>',
  master:'<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6"/>',
  integrasi:'<path d="M4 6h16M4 12h16M4 18h10"/>'
};
const ALL = null;
const NAV = [
  ['dashboard','Dashboard Order',ALL],
  ['checkin','Check-in Kendaraan',['sa','kepala_bengkel']],
  ['wo','Work Order',ALL],
  ['sales','Penjualan Eksternal',['sales_counter','kepala_bengkel','kasir']],
  ['kasir','Kasir & Invoice',['kasir','kepala_bengkel','sa','sales_counter']],
  ['stok','Stok Sparepart',ALL],
  ['gudang','Gudang',['admin_gudang','kepala_bengkel'], INTERNAL],
  ['master','Master Data',ALL],
  ['integrasi','Integrasi WMS',['kepala_bengkel','admin_gudang'], !INTERNAL]
];

let sb = null;
const U = {user: null, profile: null};
const M = {settings: {}, bays: [], mechanics: [], labor: []};
const V = {view: 'dashboard', woId: null, soId: null, woFilter: 'Aktif', woSearch: '', invFilter: 'unpaid', masterTab: 'customers', stokQ: '', gdQ: ''};
let D = {};
let CI = null;
let SD = null;          // draft SO baru
let partHits = {};      // hasil pencarian part terakhir (id → row)

/* ---------- util ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rp = (n) => 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const fmt = (opt) => new Intl.DateTimeFormat('id-ID', {timeZone: TZ, ...opt});
const fDT = (s) => s ? fmt({day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'}).format(new Date(s)) : '—';
const fT = (s) => s ? fmt({hour:'2-digit', minute:'2-digit'}).format(new Date(s)) : '—';
const fD = (s) => s ? fmt({day:'2-digit', month:'short', year:'numeric'}).format(new Date(s)) : '—';
const todayISO = () => new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date());
const startOfToday = () => new Date(todayISO() + 'T00:00:00+07:00').toISOString();
const chip = (color, text) => `<span class="chip c-${color}">${esc(text)}</span>`;
const lineChip = (st) => chip((LINE[st] || ['gray'])[0], (LINE[st] || [, st])[1]);
const can = (...roles) => U.profile && (U.profile.role === 'admin' || roles.includes(U.profile.role));
const navAllowed = (roles) => !roles || can(...roles);
const navOk = (n) => n[3] !== false && navAllowed(n[2]);
const minsSince = (s) => Math.floor((Date.now() - new Date(s).getTime()) / 60000);
const isLate = (w) => w.eta && !['Siap Ambil','Selesai','Batal'].includes(w.status) && new Date(w.eta) < new Date();
const woTotal = (w) => Number(w.labor_total || 0) + Number(w.parts_total || 0) - Number(w.discount || 0);
const waNumber = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '62' + d.slice(1); else if (d.startsWith('8')) d = '62' + d; return d; };
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };

let toastTimer;
function toast(msg, err){
  const el = $('toast'); el.textContent = msg; el.hidden = false; el.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, err ? 6000 : 3500);
}
function openModal(html, narrow){ const m = $('modal'); m.innerHTML = `<div class="dialog ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true">${html}</div>`; m.hidden = false; const f = m.querySelector('input,select,textarea'); if (f) setTimeout(() => f.focus(), 0); }
function closeModal(){ const m = $('modal'); m.hidden = true; m.innerHTML = ''; }

/* ---------- akses data ---------- */
async function q(p){ const {data, error} = await p; if (error) throw new Error(error.message); return data; }
async function rpc(name, args){ return q(sb.rpc(name, args)); }
async function fn(action, body){
  const {data, error} = await sb.functions.invoke('wms', {body: {action, ...(body || {})}});
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || msg; } catch (e) {}
    if (/Failed to send a request/i.test(msg)) msg = 'Edge Function "wms" belum di-deploy atau tidak bisa dihubungi.';
    throw new Error(msg);
  }
  return data;
}

// Satu pintu untuk semua urusan stok: internal (RPC database) atau WMS (Edge Function)
async function stock(action, b){
  b = b || {};
  if (!INTERNAL) return fn(action, b);
  switch (action) {
    case 'availability': {
      let qq = sb.from('v_stock').select('id,sku,name,unit,price,category,bin,min_stock,on_hand,reserved,quarantine,available').eq('active', true).order('name').limit(b.all ? 2000 : 40);
      if (b.q) { const s = String(b.q).replace(/[%,()]/g, ' '); qq = qq.or(`name.ilike.%${s}%,sku.ilike.%${s}%`); }
      let rows = (await q(qq)).map((x) => ({...x, wms: {on_hand: +x.on_hand, reserved: +x.reserved, quarantine: +x.quarantine, available: +x.available, min_stock: +x.min_stock, bin: x.bin}}));
      if (b.low) rows = rows.filter((x) => x.wms.available < x.wms.min_stock);
      return {wms_ok: true, rows};
    }
    case 'wo_add_part': return {result: await rpc('wo_add_part', {p_wo: b.wo_id, p_part: b.part_id, p_qty: b.qty})};
    case 'line_reserve': return {result: await rpc('line_reserve', {p_line: b.line_id})};
    case 'line_remove': await rpc('line_remove', {p_line: b.line_id}); return {};
    case 'line_backorder': await rpc('line_backorder', {p_line: b.line_id}); return {};
    case 'wo_estimate_decide': await rpc('wo_estimate_decide', {p_wo: b.wo_id, p_approved: b.approved, p_note: b.note || null}); return {};
    case 'pick_request': return {pick_no: await rpc('pick_request', {p_wo: b.wo_id || null, p_so: b.so_id || null})};
    case 'internal_return': await rpc('internal_return', {p_line: b.line_id}); return {};
    case 'so_confirm': { const r = await rpc('so_confirm', {p_so: b.so_id}); return {result: r.result, lines: {backorder: r.backorder || 0}}; }
    case 'so_finance_approve': await rpc('so_finance_approve', {p_so: b.so_id}); return {};
    case 'so_cancel': await rpc('so_cancel', {p_so: b.so_id}); return {};
    case 'flush': { const r = await rpc('expire_reservations'); return {sent: 0, still_pending: 0, ...r}; }
  }
  throw new Error('Aksi tidak dikenal: ' + action);
}

async function loadMasters(){
  const [settings, bays, mech, labor] = await Promise.all([
    q(sb.from('app_settings').select('*')),
    q(sb.from('bays').select('*').eq('active', true).order('sort')),
    q(sb.from('profiles').select('id,full_name').eq('role', 'mekanik').eq('active', true).order('full_name')),
    q(sb.from('labor_rates').select('*').eq('active', true).order('name'))
  ]);
  M.settings = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  M.bays = bays; M.mechanics = mech; M.labor = labor;
  $('ws-name').textContent = M.settings.workshop_name || 'OMS Bengkel';
  document.title = (M.settings.workshop_name || 'Bengkel') + ' · OMS';
}

/* =====================================================================
   VIEWS
   ===================================================================== */
function topbar(title, sub, extra){
  return `<div class="top"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="top-r">${extra || ''}</div></div>`;
}

/* ---------- Dashboard ---------- */
async function loadDashboard(){
  const t0 = startOfToday();
  const [wos, woCount, soToday, invToday, probLines, soFin, outbox, discReq] = await Promise.all([
    q(sb.from('v_work_orders').select('*').not('status', 'in', '("Selesai","Batal")').order('created_at', {ascending: false}).limit(200)),
    sb.from('work_orders').select('id', {count: 'exact', head: true}).gte('created_at', t0),
    sb.from('sales_orders').select('id', {count: 'exact', head: true}).gte('created_at', t0),
    q(sb.from('invoices').select('total').neq('status', 'void').gte('created_at', t0)),
    q(sb.from('order_lines').select('id,state,qty,sku,note,wo_id,so_id,parts(name),work_orders(no),sales_orders(no)').in('state', ['failed','backorder']).limit(50)),
    q(sb.from('sales_orders').select('id,no').eq('status', 'Menunggu approval Finance')),
    sb.from('wms_outbox').select('id', {count: 'exact', head: true}).eq('status', 'pending'),
    q(sb.from('work_orders').select('id,no,discount_requested').not('discount_requested', 'is', null))
  ]);
  D = {wos, woToday: woCount.count || 0, soToday: soToday.count || 0, omzet: invToday.reduce((a, i) => a + Number(i.total), 0), invCount: invToday.length,
       probLines, soFin, outbox: outbox.count || 0, discReq, low: null, lowErr: null};
  stock('availability', {all: true, low: true}).then((r) => { D.low = r.wms_ok ? r.rows : []; D.lowErr = r.wms_ok ? null : r.error; if (V.view === 'dashboard') paint(); }).catch((e) => { D.low = []; D.lowErr = e.message; if (V.view === 'dashboard') paint(); });
}
function dashAlerts(){
  const a = [];
  D.wos.forEach((w) => {
    if (w.estimate === 'sent' || w.estimate === 'revisi') a.push(['warn', `<b>${esc(w.no)}</b> menunggu persetujuan estimasi${w.estimate === 'revisi' ? ' tambahan' : ''}.`, `${esc(w.plate)} · ${esc(w.customer_name)}`, 'open-wo', w.id]);
    if (isLate(w)) a.push(['crit', `<b>${esc(w.no)}</b> melewati estimasi selesai ${fT(w.eta)}.`, `Status: ${w.status}`, 'open-wo', w.id]);
    if (w.status === 'Siap Ambil' && w.ready_at && minsSince(w.ready_at) > 120) a.push(['info', `<b>${esc(w.no)}</b> siap ambil sejak ${Math.floor(minsSince(w.ready_at) / 60)} jam lalu.`, 'Hubungi pelanggan', 'open-wo', w.id]);
  });
  D.probLines.forEach((l) => {
    const no = l.work_orders?.no || l.sales_orders?.no; const act = l.wo_id ? 'open-wo' : 'open-so'; const id = l.wo_id || l.so_id;
    if (l.state === 'failed') a.push(['crit', `Reservasi gagal: <b>${esc(no)}</b> · ${esc(l.parts?.name)} × ${l.qty}.`, l.note || 'Tawarkan substitusi atau jadikan backorder', act, id]);
    else a.push(['warn', `Backorder: <b>${esc(no)}</b> · ${esc(l.parts?.name)} × ${l.qty}.`, 'Teruskan ke purchasing; terisi otomatis saat stok masuk', act, id]);
  });
  D.soFin.forEach((s) => a.push(['warn', `<b>${esc(s.no)}</b> melebihi limit kredit pelanggan.`, 'Butuh approval Finance', 'open-so', s.id]));
  D.discReq.forEach((w) => a.push(['warn', `<b>${esc(w.no)}</b> minta diskon ${rp(w.discount_requested)}.`, 'Butuh approval Kepala Bengkel', 'open-wo', w.id]));
  if (D.outbox && !INTERNAL) a.push(['crit', `${D.outbox} permintaan ke WMS masih antre.`, 'WMS tidak bisa dihubungi; kirim ulang dari menu Integrasi', 'go', 'integrasi']);
  (D.low || []).forEach((p) => a.push([p.wms.available <= 0 ? 'crit' : 'warn', `${esc(p.name)}: available <b>${p.wms.available} ${esc(p.unit)}</b>, di bawah minimum ${p.wms.min_stock}.`, 'Buat PO di sistem procurement', 'go', 'stok']));
  const order = {crit: 0, warn: 1, info: 2};
  return a.sort((x, y) => order[x[0]] - order[y[0]]);
}
function vDashboard(){
  const w = D.wos;
  const used = Object.fromEntries(w.filter((x) => x.bay_id && !['Siap Ambil'].includes(x.status)).map((x) => [x.bay_id, x]));
  const tp = w.filter((x) => x.status === 'Tunggu Part');
  const al = dashAlerts();
  const kpis = [
    ['Order hari ini', D.woToday + D.soToday, `${D.woToday} WO · ${D.soToday} SO eksternal`],
    ['Sedang dikerjakan', w.filter((x) => x.status === 'Dikerjakan').length, `${M.bays.length} bay tersedia`],
    ['Tunggu part', tp.length, tp.filter(isLate).length ? `${tp.filter(isLate).length} melewati estimasi` : 'tidak ada yang terlambat'],
    ['Siap diambil', w.filter((x) => x.status === 'Siap Ambil').length, 'menunggu pelanggan'],
    ['Omzet hari ini', D.omzet >= 1e6 ? (D.omzet / 1e6).toLocaleString('id-ID', {maximumFractionDigits: 1}) + ' jt' : rp(D.omzet), `${D.invCount} invoice terbit`]
  ];
  return topbar('Dashboard Order', fmt({weekday:'long', day:'numeric', month:'long', year:'numeric'}).format(new Date()),
      can('sa','kepala_bengkel') ? `<button type="button" class="btn primary" data-act="go" data-id="checkin">+ Check-in baru</button>` : '') + `
  <div class="kpis">${kpis.map(([l, v, s]) => `<div class="card kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
  <div class="cols">
    <div class="col-main">
      <section class="card" aria-labelledby="h-wo"><div class="card-h"><h2 id="h-wo">Work order aktif</h2><button type="button" class="btn sm" data-act="go" data-id="wo">Semua WO</button></div>
        <div class="tw"><table class="t" style="min-width:760px"><thead><tr><th>No. WO</th><th>Kendaraan</th><th>Pelanggan</th><th>Keluhan</th><th>Mekanik · Bay</th><th>Status</th><th>Estimasi selesai</th></tr></thead><tbody>
        ${w.length ? w.map(woRow).join('') : '<tr><td colspan="7" class="empty">Belum ada WO aktif. Mulai dari Check-in Kendaraan.</td></tr>'}
        </tbody></table></div></section>
    </div>
    <div class="col-side">
      <section class="card" aria-labelledby="h-act"><div class="card-h"><h2 id="h-act">Perlu tindakan</h2>${chip(al.some((x) => x[0] === 'crit') ? 'red' : 'gray', String(al.length))}</div>
        <div class="alerts">${al.length ? al.map(([sev, html, sub, act, id]) => `<button type="button" class="alert" data-act="${act}" data-id="${esc(id)}"><span class="dot sev-${sev}"></span><span><span>${html}</span><div class="sub">${esc(sub)}</div></span></button>`).join('') : `<div class="empty">${D.low === null ? 'Memeriksa stok minimum…' : 'Semua beres.'}</div>`}</div>
        ${D.lowErr ? `<div class="card-b" style="border-top:1px solid var(--line)"><div class="small muted">Stok minimum tidak bisa dicek: ${esc(D.lowErr)}</div></div>` : ''}</section>
      <section class="card" aria-labelledby="h-bay"><div class="card-h"><h2 id="h-bay">Okupansi bay</h2><span class="small muted">${Object.keys(used).length}/${M.bays.length} terisi</span></div>
        <div class="card-b"><div class="bays">${M.bays.map((b) => used[b.id] ? `<div class="bay full"><b>${esc(b.name)}</b><span class="mono">${esc(used[b.id].plate)}</span></div>` : `<div class="bay empty"><b>${esc(b.name)}</b><span>Kosong</span></div>`).join('') || '<div class="small muted">Tambahkan bay di Master Data.</div>'}</div></div></section>
    </div>
  </div>`;
}
function woRow(w){
  return `<tr class="click" data-act="open-wo" data-id="${w.id}">
    <td><button type="button" class="link" data-act="open-wo" data-id="${w.id}">${esc(w.no)}</button></td>
    <td><div class="mono" style="font-weight:600">${esc(w.plate)}</div><div class="small muted">${esc(w.model || '')}</div></td>
    <td>${esc(w.customer_name)}</td><td>${esc(w.complaint)}</td>
    <td>${w.mechanic_name ? esc(w.mechanic_name) + ' · ' + esc(w.bay_name || '—') : '<span class="muted">Belum ditugaskan</span>'}</td>
    <td>${chip(WO_CHIP[w.status], w.status)}</td>
    <td><div class="mono" style="font-weight:600">${w.eta ? fT(w.eta) : '—'}</div><div class="small ${isLate(w) ? 'late' : 'muted'}">${isLate(w) ? 'Terlambat ' + minsSince(w.eta) + ' menit' : w.status === 'Selesai' ? 'Selesai' : ''}</div></td></tr>`;
}

/* ---------- Check-in ---------- */
function newCI(){
  const eta = new Date(Date.now() + 3 * 3600e3);
  return {plate: '', vehicle: null, looked: false, name: '', phone: '', model: '', year: '', odometer: '', fuel: '2', equipment: {STNK: true}, damage: '', complaint: '',
          eta: fmt({hour:'2-digit', minute:'2-digit', hour12: false}).format(eta).replace('.', ':'), photos: {}};
}
async function loadCheckin(){ if (!CI) CI = newCI(); }
function vCheckin(){
  const c = CI; const n = SIDES.filter((s) => c.photos[s]?.path).length;
  const uploading = SIDES.some((s) => c.photos[s]?.uploading);
  return topbar('Check-in kendaraan', 'Foto 4 sisi wajib sebelum WO bisa dibuat') + `
  <section class="card ci"><div class="card-b">
    <div class="field"><label for="ci-plate">Nomor polisi</label>
      <div style="display:flex;gap:8px"><input id="ci-plate" class="in mono" data-bind="plate" value="${esc(c.plate)}" placeholder="B 1234 XYZ" autocomplete="off" autocapitalize="characters"><button type="button" class="btn" data-act="ci-lookup">Cari</button></div></div>
    ${c.vehicle ? `<div class="note"><b>${esc(c.vehicle.customers?.name || 'Tanpa pemilik')}</b> · ${esc(c.vehicle.customers?.phone || '')}<br>${esc(c.vehicle.model || '')} ${c.vehicle.year || ''}</div>` : ''}
    ${c.looked && !c.vehicle ? `<div class="note warn">Kendaraan baru. Lengkapi data pelanggan.</div>
      <div class="field"><label for="ci-name">Nama pelanggan</label><input id="ci-name" class="in" data-bind="name" value="${esc(c.name)}" autocomplete="off"></div>
      <div class="field"><label for="ci-phone">No. WhatsApp</label><input id="ci-phone" class="in" data-bind="phone" value="${esc(c.phone)}" inputmode="tel" placeholder="08xx"></div>
      <div class="row"><div class="field"><label for="ci-model">Kendaraan</label><input id="ci-model" class="in" data-bind="model" value="${esc(c.model)}" placeholder="Toyota Avanza"></div>
      <div class="field" style="flex:0 1 110px"><label for="ci-year">Tahun</label><input id="ci-year" class="in" data-bind="year" value="${esc(c.year)}" inputmode="numeric"></div></div>` : ''}
    <div class="row"><div class="field"><label for="ci-odo">Odometer (km)</label><input id="ci-odo" class="in mono" data-bind="odometer" value="${esc(c.odometer)}" inputmode="numeric"></div>
      <div class="field"><label for="ci-eta">Estimasi selesai (hari ini)</label><input id="ci-eta" class="in mono" type="time" data-bind="eta" value="${esc(c.eta)}"></div></div>
    <div class="field"><span class="lbl" id="fuel-l">Level BBM</span><div class="seg" role="radiogroup" aria-labelledby="fuel-l">${FUEL.map((x, i) => `<label><input type="radio" name="fuel" value="${i}" data-bind="fuel" ${String(i) === String(c.fuel) ? 'checked' : ''}><span>${x}</span></label>`).join('')}</div></div>
    <div class="field"><span class="lbl">Kelengkapan</span><div class="checks">${EQUIP.map((k, i) => `<label><input type="checkbox" id="eq-${i}" data-bind="eq.${k}" ${c.equipment[k] ? 'checked' : ''}>${k}</label>`).join('')}</div></div>
    <div class="field"><label for="ci-dmg">Kerusakan existing</label><input id="ci-dmg" class="in" data-bind="damage" value="${esc(c.damage)}" placeholder="Baret pintu kiri belakang"></div>
    <div class="field"><label for="ci-cmp">Keluhan pelanggan</label><textarea id="ci-cmp" class="in" data-bind="complaint">${esc(c.complaint)}</textarea></div>
    <div class="field"><span class="lbl">Foto 4 sisi (${n}/4)</span>
      <div class="photos">${SIDES.map((s) => { const p = c.photos[s]; return `<label class="ph ${p?.path ? 'done' : ''}" style="${p?.preview ? `background-image:url(${p.preview})` : ''}">
        <input type="file" accept="image/*" capture="environment" data-photo="${s}" aria-label="Foto ${s}">
        ${p?.uploading ? `<span class="cap">Mengunggah…</span>` : p?.path ? `<span class="cap">✓ ${s}</span>` : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg><span>${s}</span>`}</label>`; }).join('')}</div></div>
    <button type="button" class="btn primary" data-act="ci-create" style="min-height:48px" ${n === 4 && !uploading ? '' : 'disabled'}>Buat Work Order</button>
  </div></section>`;
}
async function compress(file){
  try {
    const img = await createImageBitmap(file);
    const s = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  } catch (e) { return file; }
}
async function uploadPhoto(side, file){
  CI.photos[side] = {uploading: true, preview: URL.createObjectURL(file)}; paint();
  try {
    const blob = await compress(file);
    const path = `${todayISO().slice(0, 7)}/${crypto.randomUUID()}-${side.toLowerCase()}.jpg`;
    const {error} = await sb.storage.from('checkin').upload(path, blob, {contentType: 'image/jpeg'});
    if (error) throw new Error(error.message);
    CI.photos[side] = {path, preview: CI.photos[side].preview};
  } catch (e) { delete CI.photos[side]; toast('Foto gagal diunggah: ' + e.message, true); }
  if (V.view === 'checkin') paint();
}

/* ---------- Work Order ---------- */
async function loadWO(){
  let lq = sb.from('v_work_orders').select('*').order('created_at', {ascending: false}).limit(150);
  if (V.woFilter === 'Aktif') lq = lq.not('status', 'in', '("Selesai","Batal")');
  else if (V.woFilter !== 'Semua') lq = lq.eq('status', V.woFilter);
  if (V.woSearch) { const s = V.woSearch.replace(/[%,()]/g, ' '); lq = lq.or(`no.ilike.%${s}%,plate.ilike.%${s}%,customer_name.ilike.%${s}%`); }
  if (U.profile.role === 'mekanik' && V.woFilter === 'Aktif') lq = lq.eq('mechanic_id', U.user.id);
  D = {list: await q(lq)};
  if (!V.woId) return;
  const [w, labor, lines, log] = await Promise.all([
    q(sb.from('v_work_orders').select('*').eq('id', V.woId).single()),
    q(sb.from('wo_labor').select('*').eq('wo_id', V.woId).order('created_at')),
    q(sb.from('order_lines').select('*, parts(name,unit)').eq('wo_id', V.woId).order('created_at')),
    q(sb.from('wo_status_log').select('*, profiles(full_name)').eq('wo_id', V.woId).order('at'))
  ]);
  let photos = [];
  if (w.photos?.length) {
    const {data} = await sb.storage.from('checkin').createSignedUrls(w.photos, 3600);
    photos = data || [];
  }
  Object.assign(D, {w, labor, lines, log, photos});
}
function vWOList(){
  const f = ['Aktif', ...STATUSES, 'Semua'];
  return topbar('Work order', 'Klik baris untuk membuka detail', can('sa','kepala_bengkel') ? `<button type="button" class="btn primary" data-act="go" data-id="checkin">+ Check-in baru</button>` : '') + `
  <section class="card"><div class="card-h"><div class="filters" role="group" aria-label="Filter status">${f.map((x) => `<button type="button" class="fbtn" data-act="wo-filter" data-id="${x}" aria-pressed="${V.woFilter === x}">${x}</button>`).join('')}</div>
    <div style="flex:1 1 220px;max-width:320px"><label class="sr" for="wo-q">Cari WO</label><input id="wo-q" class="in" type="search" placeholder="No. WO, plat, pelanggan…" value="${esc(V.woSearch)}"></div></div>
    <div class="tw"><table class="t" style="min-width:760px"><thead><tr><th>No. WO</th><th>Kendaraan</th><th>Pelanggan</th><th>Keluhan</th><th>Mekanik · Bay</th><th>Status</th><th>Estimasi selesai</th></tr></thead><tbody>
    ${D.list.length ? D.list.map(woRow).join('') : '<tr><td colspan="7" class="empty">Tidak ada WO.</td></tr>'}</tbody></table></div></section>`;
}
function nextLabel(w, lines){
  const blocking = lines.some((l) => ['draft','queued','backorder','failed'].includes(l.state));
  return {'Antre':'Mulai diagnosa','Diagnosa':'Lanjut: estimasi disetujui','Estimasi disetujui': blocking ? 'Tandai tunggu part' : 'Mulai dikerjakan','Tunggu Part':'Mulai dikerjakan','Dikerjakan':'Selesai, masuk QC','QC':'QC lulus, siap ambil','Siap Ambil':'Kendaraan diambil, tutup WO'}[w.status];
}
function vWO(){
  if (!V.woId) return vWOList();
  const {w, labor, lines, log, photos} = D;
  const closed = ['Selesai','Batal'].includes(w.status);
  const locked = closed || w.status === 'Siap Ambil';
  const si = STATUSES.indexOf(w.status);
  const nl = !closed && nextLabel(w, lines);
  const pickable = lines.filter((l) => l.state === 'reserved').length;
  const live = lines.filter((l) => !['released','returned'].includes(l.state));
  const canInv = w.status === 'Siap Ambil' && !w.invoice_no && live.every((l) => l.state === 'issued');
  const est = EST[w.estimate];
  const lim = Number(M.settings.sa_discount_limit_pct || 0);
  return topbar(`${w.no} · ${w.plate}`, `${esc(w.model || '')} · ${esc(w.customer_name)} · ${esc(w.customer_phone || '')}`, `<button type="button" class="btn" data-act="wo-back">← Semua WO</button>`) + `
  <section class="card" aria-label="Status WO">
    <div class="stepper">${STATUSES.map((s, i) => `<span class="step ${i < si ? 'done' : i === si ? 'cur' : ''}">${s}</span>`).join('')}</div>
    <div class="card-b" style="border-top:1px solid var(--line)"><div class="btns">
      ${nl ? `<button type="button" class="btn primary" data-act="wo-next">${nl}</button>` : ''}
      ${isLate(w) ? `<span class="late small">Terlambat ${minsSince(w.eta)} menit dari estimasi ${fT(w.eta)}</span>` : `<span class="small muted">Estimasi selesai ${w.eta ? fDT(w.eta) : '—'}</span>`}
    </div></div>
  </section>
  <div class="cols">
    <div class="col-main">
      <section class="card" aria-labelledby="h-info"><div class="card-h"><h2 id="h-info">Check-in &amp; penugasan</h2></div>
        <div class="card-b">
          <dl class="kv"><dt>Keluhan</dt><dd>${esc(w.complaint)}</dd>
            <dt>Kondisi masuk</dt><dd>Odometer ${w.odometer != null ? Number(w.odometer).toLocaleString('id-ID') + ' km' : '—'} · BBM ${w.fuel_level != null ? FUEL[w.fuel_level] : '—'} · ${esc((w.equipment || []).join(', ') || 'tanpa kelengkapan')}${w.existing_damage ? ' · Kerusakan: ' + esc(w.existing_damage) : ''}</dd>
            <dt>Mekanik · bay</dt><dd>${w.mechanic_name ? esc(w.mechanic_name) + ' · ' + esc(w.bay_name || '—') : '<span class="muted">Belum ditugaskan</span>'}</dd></dl>
          ${photos.length ? `<div class="thumbs">${photos.map((p, i) => p.signedUrl ? `<a href="${esc(p.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(p.signedUrl)}" alt="Foto ${SIDES[i] || i + 1}" loading="lazy"></a>` : '').join('')}</div>` : ''}
          ${!closed && can('kepala_bengkel','sa') ? `<div class="row">
            <div class="field"><label for="as-mek">Mekanik</label><select id="as-mek" class="in"><option value="">Pilih…</option>${M.mechanics.map((m) => `<option value="${m.id}" ${m.id === w.mechanic_id ? 'selected' : ''}>${esc(m.full_name)}</option>`).join('')}</select></div>
            <div class="field"><label for="as-bay">Bay</label><select id="as-bay" class="in"><option value="">Pilih…</option>${M.bays.map((b) => `<option value="${b.id}" ${b.id === w.bay_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
            <button type="button" class="btn" data-act="wo-assign">Tugaskan</button></div>
            ${!M.mechanics.length ? '<div class="small muted">Belum ada akun dengan peran Mekanik. Atur di Master Data → Pengguna.</div>' : ''}` : ''}
          <div class="field"><label for="wo-diag">Diagnosa mekanik</label><textarea id="wo-diag" class="in" ${closed || !can('mekanik','sa','kepala_bengkel') ? 'disabled' : ''}>${esc(w.diagnosis || '')}</textarea></div>
          ${!closed && can('mekanik','sa','kepala_bengkel') ? `<div class="btns"><button type="button" class="btn sm" data-act="wo-diag">Simpan diagnosa</button></div>` : ''}
        </div></section>

      <section class="card" aria-labelledby="h-jasa"><div class="card-h"><h2 id="h-jasa">Jasa</h2></div>
        <div class="tw"><table class="t"><thead><tr><th>Jasa</th><th class="num">Tarif</th><th></th></tr></thead><tbody>
        ${labor.length ? labor.map((j) => `<tr><td>${esc(j.name)}</td><td class="num">${rp(j.price)}</td><td class="num">${!locked && can('sa','kepala_bengkel') ? `<button type="button" class="btn sm" data-act="wo-rm-labor" data-id="${j.id}">Hapus</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="3" class="empty">Belum ada jasa.</td></tr>'}
        </tbody></table></div>
        ${!locked && can('sa','kepala_bengkel','mekanik') ? `<div class="card-b" style="border-top:1px solid var(--line)"><div class="row"><div class="field"><label for="labor-sel">Tambah dari master tarif</label><select id="labor-sel" class="in">${M.labor.map((l) => `<option value="${l.id}">${esc(l.name)} · ${rp(l.price)}</option>`).join('') || '<option value="">Master tarif jasa masih kosong</option>'}</select></div><button type="button" class="btn" data-act="wo-add-labor">Tambah jasa</button></div></div>` : ''}
      </section>

      <section class="card" aria-labelledby="h-part"><div class="card-h"><h2 id="h-part">Sparepart</h2>
        <div class="btns">${!locked && can('sa','kepala_bengkel','mekanik') ? `<button type="button" class="btn sm" data-act="part-modal" data-id="wo">+ Tambah part</button>` : ''}
        ${!closed && can('sa','kepala_bengkel','mekanik') ? `<button type="button" class="btn sm" data-act="wo-pick" ${pickable ? '' : 'disabled'}>Kirim pick request (${pickable})</button>` : ''}</div></div>
        <div class="tw"><table class="t" style="min-width:640px"><thead><tr><th>Part</th><th class="num">Qty</th><th class="num">Subtotal</th><th>Status</th><th></th></tr></thead><tbody>
        ${lines.length ? lines.map((l) => lineRow(l, w.status, locked)).join('') : `<tr><td colspan="5" class="empty">Belum ada part. Part yang ditambahkan langsung direservasi sementara di ${WH}.</td></tr>`}
        </tbody></table></div></section>
    </div>

    <div class="col-side">
      <section class="card" aria-labelledby="h-est"><div class="card-h"><h2 id="h-est">Estimasi</h2>${chip(est[0], est[1])}</div>
        <div class="card-b">
          <dl class="kv"><dt>Jasa</dt><dd class="num">${rp(w.labor_total)}</dd><dt>Sparepart</dt><dd class="num">${rp(w.parts_total)}</dd><dt>Diskon</dt><dd class="num">${Number(w.discount) ? '− ' + rp(w.discount) : rp(0)}</dd></dl>
          <div class="total"><span>Total</span><span class="mono">${rp(woTotal(w))}</span></div>
          ${w.discount_requested != null ? `<div class="note warn">Permintaan diskon ${rp(w.discount_requested)} menunggu Kepala Bengkel.${can('kepala_bengkel') ? `<div class="btns" style="margin-top:8px"><button type="button" class="btn sm" data-act="wo-disc-ok" data-id="1">Setujui</button><button type="button" class="btn sm danger" data-act="wo-disc-ok" data-id="0">Tolak</button></div>` : ''}</div>` : ''}
          ${!locked && can('sa','kepala_bengkel') ? `<div class="row"><div class="field"><label for="wo-disc">Diskon (Rp) · batas SA ${lim}%</label><input id="wo-disc" class="in mono" inputmode="numeric" value="${Number(w.discount) || ''}"></div><button type="button" class="btn sm" data-act="wo-disc">Simpan</button></div>` : ''}
          ${!closed && can('sa','kepala_bengkel') ? `<div class="btns">
            ${['draft','revisi','rejected'].includes(w.estimate) ? `<button type="button" class="btn primary" data-act="wo-send-est">Kirim estimasi via WhatsApp</button>` : ''}
            ${w.estimate === 'sent' ? `<button type="button" class="btn" data-act="wo-send-est">Kirim ulang</button>` : ''}</div>
            ${w.estimate === 'sent' ? `<div class="note">Catat jawaban pelanggan:<div class="btns" style="margin-top:8px"><button type="button" class="btn sm" data-act="wo-decide" data-id="1">Pelanggan setuju</button><button type="button" class="btn sm danger" data-act="wo-decide" data-id="0">Pelanggan menolak</button></div></div>` : ''}
            ${w.estimate === 'revisi' ? '<div class="note warn">Ada tambahan pekerjaan. Kirim ulang estimasi dan catat persetujuan pelanggan.</div>' : ''}` : ''}
          <div class="small muted">Part direservasi sementara (${esc(M.settings.wo_temp_reservation_hours ?? '?')} jam) selama menunggu persetujuan. Disetujui → tetap; ditolak → dilepas.</div>
        </div></section>

      <section class="card" aria-labelledby="h-inv"><div class="card-h"><h2 id="h-inv">Invoice</h2>${w.invoice_no ? chip('green', w.invoice_no) : ''}</div>
        <div class="card-b">${w.invoice_no ? `<div class="btns"><button type="button" class="btn sm" data-act="go" data-id="kasir">Buka di Kasir</button></div>` :
          `${can('kasir','sa','kepala_bengkel') ? `<button type="button" class="btn ${canInv ? 'primary' : ''}" data-act="wo-invoice" ${canInv ? '' : 'disabled'}>Terbitkan invoice</button>` : ''}
           <div class="small muted">Terkunci sampai QC lulus dan semua part sudah goods issue dari ${WH} (atau dilepas / diretur).</div>`}</div></section>

      <section class="card" aria-labelledby="h-tl"><div class="card-h"><h2 id="h-tl">Riwayat status</h2></div>
        <div class="card-b"><div class="timeline">${log.slice().reverse().map((t) => `<div><span class="mono">${fDT(t.at)}</span><span><b>${esc(t.status)}</b> · ${esc(t.profiles?.full_name || 'sistem')}</span></div>`).join('')}</div></div></section>
    </div>
  </div>`;
}
function lineRow(l, docStatus, locked){
  const isWO = !!l.wo_id; const doc = isWO ? 'wo' : 'so';
  const btn = [];
  if (isWO && l.state === 'issued' && ['Dikerjakan','QC'].includes(docStatus) && can('mekanik','sa','kepala_bengkel')) btn.push(`<button type="button" class="btn sm" data-act="line-return" data-id="${l.id}">Retur (tidak terpasang)</button>`);
  if (l.state === 'failed' && can('sa','kepala_bengkel','sales_counter')) btn.push(`<button type="button" class="btn sm" data-act="line-bo" data-id="${l.id}">Jadikan backorder</button>`);
  if (['draft','failed'].includes(l.state) && !locked && can('sa','kepala_bengkel','sales_counter') && !(isWO && l.state === 'draft' && D.w && D.w.estimate !== 'approved')) btn.push(`<button type="button" class="btn sm" data-act="line-reserve" data-id="${l.id}">Reservasi</button>`);
  if (['draft','queued','reserved_temp','reserved','backorder','failed'].includes(l.state) && !locked && can('sa','kepala_bengkel','sales_counter')) btn.push(`<button type="button" class="btn sm danger" data-act="line-rm" data-id="${l.id}" data-doc="${doc}">Hapus</button>`);
  return `<tr><td><div>${esc(l.parts?.name || l.sku)}</div><div class="small muted mono">${esc(l.sku)}${l.gi_no ? ' · ' + esc(l.gi_no) : ''}</div>${l.note ? `<div class="small muted">${esc(l.note)}</div>` : ''}</td>
    <td class="num">${Number(l.qty)} ${esc(l.parts?.unit || '')}</td>
    <td class="num">${['released','returned'].includes(l.state) ? '<span class="muted">—</span>' : rp(l.qty * l.price)}</td>
    <td>${lineChip(l.state)}${l.invoice_id ? ' ' + chip('green', 'Invoiced') : ''}</td>
    <td class="num"><div class="btns" style="justify-content:flex-end">${btn.join('')}</div></td></tr>`;
}

/* ---------- pencarian part (modal WO & form SO) ---------- */
function partTable(r, act){
  if (!r) return '<div class="loading">Mencari…</div>';
  partHits = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  const warn = r.wms_ok ? '' : `<div class="card-b"><div class="note crit">Stok WMS tidak bisa dibaca: ${esc(r.error)}. Part tetap bisa ditambahkan; reservasi akan diantrekan.</div></div>`;
  if (!r.rows.length) return warn + '<div class="empty">Tidak ada part yang cocok. Tambahkan di Master Data → Sparepart.</div>';
  return warn + `<table class="t" style="min-width:620px"><thead><tr><th>Part</th><th>Bin</th><th class="num">Available</th><th class="num">Harga</th><th>Qty</th><th></th></tr></thead><tbody>
  ${r.rows.map((x) => { const a = x.wms ? x.wms.available : null; return `<tr><td><div>${esc(x.name)}</div><div class="small muted mono">${esc(x.sku)}${x.category === 'oli' ? ' · FEFO' : ''}</div></td>
    <td class="mono">${esc(x.wms?.bin || '—')}</td>
    <td class="num">${a == null ? '<span class="muted">?</span>' : `<b class="${a <= 0 ? 'late' : ''}">${a}</b>${x.wms.min_stock && a < x.wms.min_stock ? `<div class="small muted">&lt; min ${x.wms.min_stock}</div>` : ''}`}</td>
    <td class="num">${rp(x.price)}</td>
    <td><label class="sr" for="qty-${x.id}">Qty ${esc(x.name)}</label><input id="qty-${x.id}" class="in inline-q" type="number" min="1" step="1" value="1"></td>
    <td><button type="button" class="btn sm" data-act="${act}" data-id="${x.id}">${a != null && a <= 0 ? 'Tambah (backorder)' : 'Tambah'}</button></td></tr>`; }).join('')}</tbody></table>`;
}
const searchParts = debounce(async (term, targetId, act) => {
  const el = $(targetId); if (!el) return;
  try { const r = await stock('availability', {q: term}); if ($(targetId)) $(targetId).innerHTML = partTable(r, act); }
  catch (e) { if ($(targetId)) $(targetId).innerHTML = `<div class="card-b"><div class="note crit">${esc(e.message)}</div></div>`; }
}, 350);

/* ---------- Penjualan eksternal ---------- */
async function loadSales(){
  const list = await q(sb.from('v_sales_orders').select('*').order('created_at', {ascending: false}).limit(100));
  D = {list};
  if (V.soId === 'new') {
    D.customers = await q(sb.from('customers').select('*').in('type', ['retail','b2b','mitra']).eq('active', true).order('name'));
    if (!SD) SD = {customer_id: D.customers.find((c) => c.type === 'retail')?.id || D.customers[0]?.id || '', lines: [], q: ''};
  } else if (V.soId) {
    const so = await q(sb.from('v_sales_orders').select('*').eq('id', V.soId).single());
    const [lines, ar] = await Promise.all([
      q(sb.from('order_lines').select('*, parts(name,unit)').eq('so_id', V.soId).order('created_at')),
      so.top_days > 0 ? rpc('customer_ar', {p_customer: so.customer_id}) : Promise.resolve(0)
    ]);
    Object.assign(D, {so, lines, ar});
  }
}
function vSales(){
  return topbar('Penjualan sparepart eksternal', `B2B grosir, bengkel mitra, dan retail counter · stok & reservasi lewat ${WH}`,
      can('sales_counter','kepala_bengkel') ? `<button type="button" class="btn primary" data-act="so-new">+ SO baru</button>` : '') + `
  <div class="cols">
    <div class="col-side" style="flex:1 1 280px"><section class="card" aria-labelledby="h-sol"><div class="card-h"><h2 id="h-sol">Sales order</h2></div>
      <div class="alerts">${D.list.length ? D.list.map((x) => `<button type="button" class="alert" data-act="open-so" data-id="${x.id}" ${x.id === V.soId ? 'style="background:var(--surface-2)"' : ''}><span style="flex:1;min-width:0"><span style="display:flex;justify-content:space-between;gap:8px"><b class="mono">${esc(x.no)}</b>${chip(SO_CHIP[x.status] || 'gray', x.status)}</span><div class="sub">${esc(x.customer_name)} · ${rp(x.total)} · ${fDT(x.created_at)}</div></span></button>`).join('') : '<div class="empty">Belum ada SO.</div>'}</div></section></div>
    <div class="col-main">${V.soId === 'new' ? vSONew() : V.soId ? vSODetail() : '<div class="card empty">Pilih SO di kiri atau buat SO baru.</div>'}</div>
  </div>`;
}
function vSONew(){
  const c = D.customers.find((x) => x.id === SD.customer_id);
  const total = SD.lines.reduce((a, l) => a + l.part.price * l.qty, 0);
  return `<section class="card" aria-labelledby="h-new"><div class="card-h"><h2 id="h-new">SO baru</h2></div>
    <div class="card-b">
      ${D.customers.length ? `<div class="field"><label for="so-cust">Pelanggan</label><select id="so-cust" class="in">${D.customers.map((x) => `<option value="${x.id}" ${x.id === SD.customer_id ? 'selected' : ''}>${esc(x.name)} · ${CUST_TYPE[x.type]}</option>`).join('')}</select></div>` : '<div class="note warn">Belum ada pelanggan retail/B2B/mitra. Tambahkan di Master Data → Pelanggan.</div>'}
      ${c ? `<div class="note">${c.top_days ? `TOP ${c.top_days} hari · limit ${rp(c.credit_limit)}` : 'Retail: bayar dulu (proforma); reservasi kedaluwarsa ' + esc(M.settings.so_retail_expiry_hours ?? 24) + ' jam bila belum dibayar.'}</div>` : ''}
      <div class="field"><label for="so-q">Cari part</label><input id="so-q" class="in" type="search" value="${esc(SD.q)}" placeholder="Nama atau SKU…" autocomplete="off"></div>
    </div>
    <div class="tw" id="so-results"><div class="empty">Ketik nama atau SKU untuk melihat stok.</div></div>
  </section>
  <section class="card" aria-labelledby="h-dl"><div class="card-h"><h2 id="h-dl">Isi SO</h2><span class="mono" style="font-weight:700">${rp(total)}</span></div>
    <div class="tw"><table class="t"><thead><tr><th>Part</th><th class="num">Qty</th><th class="num">Available</th><th class="num">Subtotal</th><th></th></tr></thead><tbody>
    ${SD.lines.length ? SD.lines.map((l, i) => { const a = l.part.wms?.available; return `<tr><td>${esc(l.part.name)}<div class="small muted mono">${esc(l.part.sku)}</div></td><td class="num">${l.qty}</td><td class="num ${a != null && a < l.qty ? 'late' : ''}">${a ?? '?'}${a != null && a < l.qty ? '<div class="small">jadi backorder</div>' : ''}</td><td class="num">${rp(l.part.price * l.qty)}</td><td class="num"><button type="button" class="btn sm" data-act="so-rm" data-id="${i}">Hapus</button></td></tr>`; }).join('') : '<tr><td colspan="5" class="empty">Belum ada part.</td></tr>'}
    </tbody></table></div>
    <div class="card-b" style="border-top:1px solid var(--line)"><div class="btns"><button type="button" class="btn primary" data-act="so-create" ${SD.lines.length && c ? '' : 'disabled'}>Konfirmasi SO &amp; reservasi stok</button></div>
      <div class="small muted">Pelanggan TOP dicek limit kreditnya. Melebihi limit → menunggu approval Finance sebelum stok direservasi.</div></div>
  </section>`;
}
function vSODetail(){
  const {so, lines, ar} = D;
  const dead = ['Dibatalkan','Kedaluwarsa'].includes(so.status);
  const reserved = lines.filter((l) => l.state === 'reserved').length;
  const canPick = reserved && (so.top_days > 0 || so.paid_at) && !dead && !['Draft','Menunggu approval Finance'].includes(so.status);
  const canInv = lines.some((l) => l.state === 'issued' && !l.invoice_id);
  const canCancel = !dead && !lines.some((l) => ['picking','picked','issued'].includes(l.state));
  return `<section class="card" aria-labelledby="h-sod"><div class="card-h"><div><h2 id="h-sod" class="mono">${esc(so.no)}</h2><div class="small muted">${esc(so.customer_name)} · ${CUST_TYPE[so.customer_type]}${so.top_days ? ` · TOP ${so.top_days} hari` : ''} · ${fDT(so.created_at)}</div></div>${chip(SO_CHIP[so.status] || 'gray', so.status)}</div>
    <div class="tw"><table class="t" style="min-width:600px"><thead><tr><th>Part</th><th class="num">Qty</th><th class="num">Subtotal</th><th>Status</th><th></th></tr></thead><tbody>
    ${lines.map((l) => lineRow(l, so.status, dead || ['Invoiced'].includes(so.status))).join('')}</tbody></table></div>
    <div class="card-b" style="border-top:1px solid var(--line)">
      <div class="total" style="border:0;padding:0"><span>Total</span><span class="mono">${rp(so.total)}</span></div>
      ${so.status === 'Menunggu approval Finance' ? `<div class="note warn">Piutang berjalan ${rp(ar)} + SO ini melebihi limit ${rp(so.credit_limit)}. Stok belum direservasi.${can('kasir') ? `<div class="btns" style="margin-top:8px"><button type="button" class="btn sm" data-act="so-finance">Approve Finance</button></div>` : ''}</div>` : ''}
      ${!so.top_days && !so.paid_at && so.status === 'Dikonfirmasi' ? `<div class="note">Reservasi berlaku sampai ${fDT(so.expires_at)} bila belum dibayar.${can('sales_counter','kasir') ? `<div class="btns" style="margin-top:8px"><button type="button" class="btn sm primary" data-act="so-pay">Terima pembayaran</button></div>` : ''}</div>` : ''}
      ${so.proforma_no ? `<div class="small muted">Dibayar (${esc(so.payment_method || '')}) dengan proforma <b class="mono">${esc(so.proforma_no)}</b>. Invoice final terbit setelah goods issue.</div>` : ''}
      <div class="btns">
        ${can('sales_counter','kepala_bengkel') ? `<button type="button" class="btn" data-act="so-pick" ${canPick ? '' : 'disabled'}>Kirim pick request (${reserved})</button>` : ''}
        ${can('kasir','sales_counter','kepala_bengkel') ? `<button type="button" class="btn ${canInv ? 'primary' : ''}" data-act="so-invoice" ${canInv ? '' : 'disabled'}>Terbitkan invoice</button>` : ''}
        ${canCancel && can('sales_counter','kepala_bengkel') ? '<button type="button" class="btn danger" data-act="so-cancel">Batalkan SO</button>' : ''}
      </div>
      <div class="small muted">Invoice terkunci sampai ${WH} memposting goods issue. Line backorder terisi otomatis saat stok masuk.</div>
    </div></section>`;
}

/* ---------- Kasir ---------- */
async function loadKasir(){
  let lq = sb.from('v_invoices').select('*').order('created_at', {ascending: false}).limit(200);
  if (V.invFilter !== 'all') lq = lq.eq('status', V.invFilter);
  D = {inv: await q(lq)};
}
function vKasir(){
  const out = D.inv.filter((i) => i.status === 'unpaid').reduce((a, i) => a + Number(i.total) - Number(i.paid_amount), 0);
  const tabs = [['unpaid','Belum lunas'],['paid','Lunas'],['all','Semua']];
  return topbar('Kasir & invoice', V.invFilter === 'unpaid' ? `Sisa tagihan di daftar ini: <b>${rp(out)}</b>` : '') + `
  <section class="card"><div class="card-h"><div class="filters">${tabs.map(([k, l]) => `<button type="button" class="fbtn" data-act="inv-filter" data-id="${k}" aria-pressed="${V.invFilter === k}">${l}</button>`).join('')}</div></div>
    <div class="tw"><table class="t" style="min-width:760px"><thead><tr><th>Invoice</th><th>Dokumen</th><th>Pelanggan</th><th class="num">Total</th><th class="num">Dibayar</th><th>Jatuh tempo</th><th>Status</th><th></th></tr></thead><tbody>
    ${D.inv.length ? D.inv.map((i) => { const overdue = i.status === 'unpaid' && i.due_date < todayISO(); return `<tr>
      <td class="mono" style="font-weight:600">${esc(i.no)}<div class="small muted">${fDT(i.created_at)}</div></td>
      <td><button type="button" class="link" data-act="${i.wo_id ? 'open-wo' : 'open-so'}" data-id="${i.wo_id || i.so_id}">${esc(i.doc_no)}</button></td>
      <td>${esc(i.customer_name)}</td><td class="num">${rp(i.total)}</td><td class="num">${rp(i.paid_amount)}</td>
      <td class="${overdue ? 'late' : ''}">${fD(i.due_date)}</td>
      <td>${chip(i.status === 'paid' ? 'green' : overdue ? 'red' : 'amber', i.status === 'paid' ? 'Lunas' : overdue ? 'Jatuh tempo' : 'Belum lunas')}</td>
      <td class="num"><div class="btns" style="justify-content:flex-end">${i.status === 'unpaid' && can('kasir') ? `<button type="button" class="btn sm primary" data-act="pay-modal" data-id="${i.id}">Catat bayar</button>` : ''}<button type="button" class="btn sm" data-act="inv-print" data-id="${i.id}">Cetak</button></div></td></tr>`; }).join('') : '<tr><td colspan="8" class="empty">Tidak ada invoice.</td></tr>'}
    </tbody></table></div></section>`;
}

/* ---------- Stok ---------- */
async function loadStok(){ D = {r: await stock('availability', {q: V.stokQ})}; }
function vStok(){
  const r = D.r;
  return topbar('Stok sparepart', `Dibaca dari ${WH} · available = on-hand − reserved − karantina`) + `
  <section class="card"><div class="card-h"><div style="flex:1 1 260px;max-width:360px"><label class="sr" for="stok-q">Cari part</label><input id="stok-q" class="in" type="search" placeholder="Nama atau SKU…" value="${esc(V.stokQ)}"></div><button type="button" class="btn sm" data-act="refresh">Muat ulang</button></div>
    ${r.wms_ok ? '' : `<div class="card-b"><div class="note crit">WMS tidak bisa dibaca: ${esc(r.error)}</div></div>`}
    <div class="tw"><table class="t" style="min-width:820px"><thead><tr><th>Part</th><th>Bin</th><th class="num">On-hand</th><th class="num">Reserved</th><th class="num">Karantina</th><th class="num">Available</th><th class="num">Min</th><th class="num">Harga</th></tr></thead><tbody>
    ${r.rows.length ? r.rows.map((x) => { const s = x.wms; return `<tr><td>${esc(x.name)}<div class="small muted mono">${esc(x.sku)}</div></td><td class="mono">${esc(s?.bin || '—')}</td>
      <td class="num">${s ? s.on_hand : '?'}</td><td class="num">${s ? s.reserved : '?'}</td><td class="num">${s ? s.quarantine : '?'}</td>
      <td class="num">${s ? `<b class="${s.available < s.min_stock ? 'late' : ''}">${s.available}</b>` : '?'}</td><td class="num muted">${s ? s.min_stock : '?'}</td><td class="num">${rp(x.price)}</td></tr>`; }).join('') : '<tr><td colspan="8" class="empty">Belum ada part di katalog. Tambahkan di Master Data → Sparepart, lalu isi stok awal di menu Gudang.</td></tr>'}
    </tbody></table></div></section>`;
}

/* ---------- Master data ---------- */
const MASTER = {
  customers: {label: 'Pelanggan', table: 'customers', order: 'name', edit: ['sa','sales_counter','kepala_bengkel','kasir'],
    cols: [['name','Nama','text',true],['phone','No. HP / WA','text'],['type','Tipe','select',true,CUST_TYPE],['top_days','TOP (hari)','number'],['credit_limit','Limit kredit (Rp)','number'],['address','Alamat','text'],['active','Aktif','bool']]},
  vehicles: {label: 'Kendaraan', table: 'vehicles', order: 'plate', select: '*, customers(name)', edit: ['sa','kepala_bengkel'],
    cols: [['plate','Nomor polisi','text',true],['model','Merek & tipe','text'],['year','Tahun','number'],['customer_id','Pemilik','customer']]},
  labor_rates: {label: 'Tarif jasa', table: 'labor_rates', order: 'name', edit: ['kepala_bengkel'],
    cols: [['name','Nama jasa','text',true],['price','Tarif (Rp)','number',true],['active','Aktif','bool']]},
  parts: {label: 'Sparepart', table: 'parts', order: 'name', edit: ['kepala_bengkel','admin_gudang'],
    cols: [['sku', INTERNAL ? 'SKU' : 'SKU (sama dengan WMS)','text',true],['name','Nama part','text',true],['unit','Satuan','text',true],['price','Harga jual (Rp)','number',true],['category','Kategori','select',true,{part:'Part (FIFO)', oli:'Oli & cairan (FEFO)'}],
           ...(INTERNAL ? [['bin','Lokasi bin','text'],['min_stock','Stok minimum','number']] : []),['active','Aktif','bool']]},
  bays: {label: 'Bay', table: 'bays', order: 'sort', edit: ['kepala_bengkel'],
    cols: [['name','Nama bay','text',true],['sort','Urutan','number'],['active','Aktif','bool']]},
  users: {label: 'Pengguna', admin: true},
  settings: {label: 'Pengaturan', admin: true}
};
async function loadMaster(){
  const t = V.masterTab;
  if (t === 'users') { D = {rows: await q(sb.from('profiles').select('*').order('created_at'))}; return; }
  if (t === 'settings') { D = {rows: await q(sb.from('app_settings').select('*').order('key'))}; return; }
  const m = MASTER[t];
  D = {rows: await q(sb.from(m.table).select(m.select || '*').order(m.order).limit(1000))};
  if (t === 'vehicles') D.customers = await q(sb.from('customers').select('id,name').order('name').limit(2000));
}
function vMaster(){
  const t = V.masterTab;
  const tabs = Object.entries(MASTER).filter(([, m]) => !m.admin || can());
  const m = MASTER[t];
  let body;
  if (t === 'users') {
    body = `<div class="card-b"><div class="note">Pengguna baru mendaftar sendiri lewat halaman masuk (“Daftar”), lalu admin mengaktifkan dan memberi peran di sini.</div></div>
    <div class="tw"><table class="t" style="min-width:620px"><thead><tr><th>Nama</th><th>Email</th><th>Peran</th><th>Status</th><th></th></tr></thead><tbody>
    ${D.rows.map((u) => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${ROLES[u.role]}</td><td>${u.active ? chip('green','Aktif') : chip('amber','Menunggu aktivasi')}</td><td class="num"><button type="button" class="btn sm" data-act="user-edit" data-id="${u.id}">Ubah</button></td></tr>`).join('')}</tbody></table></div>`;
  } else if (t === 'settings') {
    body = `<div class="card-b">${D.rows.map((s) => `<div class="field"><label for="set-${s.key}">${esc(s.label || s.key)}</label><input id="set-${s.key}" class="in" value="${esc(typeof s.value === 'string' ? s.value : JSON.stringify(s.value))}" data-type="${typeof s.value}"></div>`).join('')}
      <div class="btns"><button type="button" class="btn primary" data-act="settings-save">Simpan pengaturan</button></div></div>`;
  } else {
    const editable = can(...m.edit);
    body = `<div class="card-b" style="border-bottom:1px solid var(--line)"><div class="btns">${editable ? `<button type="button" class="btn primary sm" data-act="m-edit" data-id="">+ Tambah ${m.label.toLowerCase()}</button>` : '<span class="small muted">Anda hanya bisa melihat data ini.</span>'}<span class="small muted">${D.rows.length} data</span></div></div>
    <div class="tw"><table class="t" style="min-width:640px"><thead><tr>${m.cols.map(([, l]) => `<th>${l}</th>`).join('')}<th></th></tr></thead><tbody>
    ${D.rows.length ? D.rows.map((r) => `<tr>${m.cols.map(([k, , type, , opts]) => `<td class="${type === 'number' ? 'num' : ''}">${cellFmt(r, k, type, opts)}</td>`).join('')}<td class="num">${editable ? `<button type="button" class="btn sm" data-act="m-edit" data-id="${r.id}">Ubah</button>` : ''}</td></tr>`).join('') : `<tr><td colspan="${m.cols.length + 1}" class="empty">Belum ada data.</td></tr>`}
    </tbody></table></div>`;
  }
  return topbar('Master data', 'Data acuan untuk check-in, WO, dan penjualan') + `
  <section class="card"><div class="tabs" role="tablist">${tabs.map(([k, x]) => `<button type="button" role="tab" aria-selected="${k === t}" data-act="m-tab" data-id="${k}">${x.label}</button>`).join('')}</div>${body}</section>`;
}
function cellFmt(r, k, type, opts){
  const v = r[k];
  if (type === 'bool') return v ? chip('green','Ya') : chip('gray','Tidak');
  if (type === 'select') return esc(opts[v] || v);
  if (type === 'customer') return esc(r.customers?.name || '—');
  if (type === 'number') return k.includes('price') || k.includes('limit') ? rp(v) : esc(v ?? '');
  return k === 'sku' || k === 'plate' ? `<span class="mono">${esc(v)}</span>` : esc(v ?? '');
}
function masterForm(id){
  const m = MASTER[V.masterTab]; const r = D.rows.find((x) => x.id === id) || {active: true, type: 'retail', category: 'part', unit: 'pcs'};
  const fields = m.cols.map(([k, l, type, req, opts]) => {
    const fid = 'mf-' + k;
    if (type === 'bool') return `<label class="checks" style="display:flex"><input type="checkbox" id="${fid}" ${r[k] ? 'checked' : ''}> ${l}</label>`;
    if (type === 'select') return `<div class="field"><label for="${fid}">${l}</label><select id="${fid}" class="in">${Object.entries(opts).map(([v, t]) => `<option value="${v}" ${r[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
    if (type === 'customer') return `<div class="field"><label for="${fid}">${l}</label><select id="${fid}" class="in"><option value="">—</option>${D.customers.map((c) => `<option value="${c.id}" ${r[k] === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`;
    return `<div class="field"><label for="${fid}">${l}${req ? ' *' : ''}</label><input id="${fid}" class="in ${type === 'number' ? 'mono' : ''}" ${type === 'number' ? 'inputmode="numeric"' : ''} value="${esc(r[k] ?? '')}"></div>`;
  }).join('');
  openModal(`<div class="card-h"><h2>${id ? 'Ubah' : 'Tambah'} ${m.label.toLowerCase()}</h2><button type="button" class="btn sm" data-act="close">Tutup</button></div>
    <div class="card-b">${fields}<div class="btns"><button type="button" class="btn primary" data-act="m-save" data-id="${id || ''}">Simpan</button></div></div>`, true);
}

/* ---------- Gudang (mode stok internal) ---------- */
async function loadGudang(){
  const [picks, rets, st] = await Promise.all([
    q(sb.from('pick_requests').select('*, work_orders(no), sales_orders(no), order_lines(id,sku,qty,state,picked_qty,parts(name,unit,bin))').in('status', ['requested','picking','picked']).order('created_at')),
    q(sb.from('order_lines').select('id,sku,qty,updated_at,work_orders(no),parts(name,unit,bin)').eq('state', 'returning').order('updated_at')),
    stock('availability', {q: V.gdQ, all: true})
  ]);
  D = {picks, rets, rows: st.rows};
}
function vGudang(){
  const pkChip = {requested: ['gray','Baru'], picking: ['amber','Picking'], picked: ['teal','Siap diserahkan']};
  const low = D.rows.filter((x) => x.wms.available < x.wms.min_stock).length;
  return topbar('Gudang', 'Ambil barang untuk WO & SO, serahkan, terima retur dan barang masuk') + `
  <section class="card" aria-labelledby="h-pk"><div class="card-h"><h2 id="h-pk">Tugas ambil barang</h2><span class="small muted">${D.picks.length} aktif</span></div>
    <div class="tw"><table class="t" style="min-width:760px"><thead><tr><th>No.</th><th>Dokumen</th><th>Tujuan</th><th>Barang · bin</th><th>Status</th><th></th></tr></thead><tbody>
    ${D.picks.length ? D.picks.map((p) => { const doc = p.work_orders?.no || p.sales_orders?.no; const lines = (p.order_lines || []).filter((l) => ['picking','picked'].includes(l.state)); return `<tr>
      <td class="mono" style="font-weight:600">${esc(p.no)}<div class="small muted">${fDT(p.created_at)}</div></td>
      <td><button type="button" class="link" data-act="${p.wo_id ? 'open-wo' : 'open-so'}" data-id="${p.wo_id || p.so_id}">${esc(doc)}</button></td>
      <td>${esc(p.destination)}</td>
      <td class="small">${lines.map((l) => `${esc(l.parts?.name)} × <b>${Number(l.picked_qty ?? l.qty)}</b> ${esc(l.parts?.unit || '')} <span class="mono muted">${esc(l.parts?.bin || '—')}</span>`).join('<br>') || '<span class="muted">—</span>'}</td>
      <td>${chip(pkChip[p.status][0], pkChip[p.status][1])}</td>
      <td class="num"><div class="btns" style="justify-content:flex-end">
        ${p.status === 'requested' ? `<button type="button" class="btn sm" data-act="pk-start" data-id="${p.id}">Mulai ambil</button>` : ''}
        ${['requested','picking'].includes(p.status) ? `<button type="button" class="btn sm" data-act="pk-done" data-id="${p.id}">Selesai ambil</button>` : ''}
        ${p.status === 'picked' ? `<button type="button" class="btn sm primary" data-act="pk-gi" data-id="${p.id}">Serahkan (goods issue)</button>` : ''}
      </div></td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">Tidak ada tugas. Permintaan ambil barang dari WO atau SO akan muncul di sini.</td></tr>'}
    </tbody></table></div></section>
  ${D.rets.length ? `<section class="card" aria-labelledby="h-rt"><div class="card-h"><h2 id="h-rt">Retur dari bengkel</h2><span class="small muted">part tidak terpasang</span></div>
    <div class="tw"><table class="t" style="min-width:560px"><tbody>${D.rets.map((r) => `<tr><td>${esc(r.parts?.name)} × ${Number(r.qty)} ${esc(r.parts?.unit || '')}<div class="small muted">${esc(r.work_orders?.no)} · bin ${esc(r.parts?.bin || '—')}</div></td>
      <td class="num"><div class="btns" style="justify-content:flex-end"><button type="button" class="btn sm" data-act="rt-recv" data-id="${r.id}" data-good="1">Diterima, kondisi baik</button><button type="button" class="btn sm" data-act="rt-recv" data-id="${r.id}" data-good="0">Karantina</button></div></td></tr>`).join('')}</tbody></table></div></section>` : ''}
  <section class="card" aria-labelledby="h-st"><div class="card-h"><h2 id="h-st">Stok</h2>
    <div class="btns">${low ? `<span class="chip c-red">${low} di bawah minimum</span>` : ''}<div style="width:240px;max-width:100%"><label class="sr" for="gd-q">Cari part</label><input id="gd-q" class="in" type="search" placeholder="Nama atau SKU…" value="${esc(V.gdQ)}"></div></div></div>
    <div class="tw"><table class="t" style="min-width:860px"><thead><tr><th>Part</th><th>Bin</th><th class="num">On-hand</th><th class="num">Reserved</th><th class="num">Karantina</th><th class="num">Available</th><th class="num">Min</th><th></th></tr></thead><tbody>
    ${D.rows.length ? D.rows.map((x) => { const s = x.wms; return `<tr><td>${esc(x.name)}<div class="small muted mono">${esc(x.sku)}${x.category === 'oli' ? ' · FEFO' : ''}</div></td><td class="mono">${esc(s.bin || '—')}</td>
      <td class="num">${s.on_hand}</td><td class="num">${s.reserved}</td><td class="num">${s.quarantine || '<span class="muted">0</span>'}</td>
      <td class="num"><b class="${s.available < s.min_stock ? 'late' : ''}">${s.available}</b></td><td class="num muted">${s.min_stock}</td>
      <td class="num"><div class="btns" style="justify-content:flex-end"><button type="button" class="btn sm" data-act="st-recv" data-id="${x.id}">Terima barang</button><button type="button" class="btn sm" data-act="st-adj" data-id="${x.id}">Opname</button></div></td></tr>`; }).join('') : '<tr><td colspan="8" class="empty">Belum ada part. Tambahkan di Master Data → Sparepart.</td></tr>'}
    </tbody></table></div></section>`;
}

/* ---------- Integrasi WMS ---------- */
async function loadIntegrasi(){
  const [status, outbox, events] = await Promise.all([
    stock('status').catch((e) => ({error: e.message})),
    q(sb.from('wms_outbox').select('*').order('created_at', {ascending: false}).limit(100)),
    q(sb.from('wms_events').select('*').order('received_at', {ascending: false}).limit(50))
  ]);
  D = {status, outbox, events};
}
function vIntegrasi(){
  const s = D.status;
  const pill = s.error ? `<span class="pill"><span class="dot off"></span>Edge Function error</span>` : !s.configured ? `<span class="pill"><span class="dot unk"></span>WMS belum dikonfigurasi</span>` : s.reachable ? `<span class="pill"><span class="dot on"></span>WMS terhubung</span>` : `<span class="pill"><span class="dot off"></span>WMS tidak bisa dihubungi</span>`;
  const oc = {sent:'green', rejected:'red', pending:'amber', failed:'red', cancelled:'gray', sending:'blue'};
  const pend = D.outbox.filter((o) => o.status === 'pending').length;
  return topbar('Integrasi WMS', 'Semua permintaan OMS → WMS dan event WMS → OMS', pill) + `
  ${s.error ? `<div class="note crit">${esc(s.error)}</div>` : s.configured && !s.reachable ? `<div class="note crit">${esc(s.error || '')}</div>` : ''}
  <section class="card"><div class="card-h"><h2>Permintaan ke WMS</h2><div class="btns"><span class="small muted">${pend} antre</span><button type="button" class="btn sm primary" data-act="flush">Kirim ulang antrean &amp; cek kedaluwarsa</button></div></div>
    <div class="tw"><table class="t" style="min-width:760px"><thead><tr><th>Waktu</th><th>Request</th><th>Dokumen</th><th>Status</th><th>Keterangan</th></tr></thead><tbody>
    ${D.outbox.length ? D.outbox.map((o) => `<tr><td class="mono small">${fDT(o.created_at)}</td><td class="mono" style="font-weight:600">${esc(o.method)} ${esc(o.path.split('?')[0])}</td><td class="mono">${esc(o.doc_no || '')}</td><td>${chip(oc[o.status] || 'gray', o.status)}${o.attempts > 1 ? ` <span class="small muted">${o.attempts}×</span>` : ''}</td><td class="small">${esc(o.last_error || (o.response ? JSON.stringify(o.response).slice(0, 140) : ''))}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Belum ada permintaan.</td></tr>'}
    </tbody></table></div></section>
  <section class="card"><div class="card-h"><h2>Event dari WMS</h2></div>
    <div class="tw"><table class="t" style="min-width:680px"><thead><tr><th>Waktu</th><th>Event</th><th>ID</th><th>Status</th></tr></thead><tbody>
    ${D.events.length ? D.events.map((e) => `<tr><td class="mono small">${fDT(e.received_at)}</td><td class="mono" style="font-weight:600">${esc(e.type)}</td><td class="mono small">${esc(e.event_id)}</td><td>${e.error ? chip('red', 'Gagal') + `<div class="small">${esc(e.error)}</div>` : e.processed_at ? chip('green', 'Diproses') : chip('amber', 'Menunggu')}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">Belum ada event. Pastikan webhook WMS mengarah ke Edge Function.</td></tr>'}
    </tbody></table></div></section>`;
}

/* =====================================================================
   RENDER
   ===================================================================== */
const VIEWS = {
  dashboard: [loadDashboard, vDashboard], checkin: [loadCheckin, vCheckin], wo: [loadWO, vWO], sales: [loadSales, vSales],
  kasir: [loadKasir, vKasir], stok: [loadStok, vStok], gudang: [loadGudang, vGudang], master: [loadMaster, vMaster], integrasi: [loadIntegrasi, vIntegrasi]
};
function renderNav(){
  $('nav').innerHTML = NAV.filter(navOk).map(([k, label]) =>
    `<button type="button" data-act="go" data-id="${k}" ${V.view === k ? 'aria-current="page"' : ''}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>${label}</button>`).join('');
  $('me').innerHTML = `<b>${esc(U.profile.full_name)}</b>${ROLES[U.profile.role]}`;
}
function paint(){ try { $('main').innerHTML = VIEWS[V.view][1](); } catch (e) { console.error(e); $('main').innerHTML = `<div class="note crit">Gagal menampilkan halaman: ${esc(e.message)}</div>`; } }
let loadSeq = 0;
async function refresh(showLoading){
  const seq = ++loadSeq;
  renderNav();
  if (showLoading) $('main').innerHTML = '<div class="loading">Memuat…</div>';
  try {
    await VIEWS[V.view][0]();
    if (seq !== loadSeq) return;
    paint();
    if (V.view === 'sales' && V.soId === 'new' && SD?.q) searchParts(SD.q, 'so-results', 'so-add');
  } catch (e) {
    if (seq !== loadSeq) return;
    console.error(e);
    $('main').innerHTML = `<div class="top"><h1>Terjadi kesalahan</h1></div><div class="note crit">${esc(e.message)}</div><div class="btns"><button type="button" class="btn" data-act="refresh">Coba lagi</button></div>`;
  }
}
function go(view){
  const allowed = NAV.find(([k]) => k === view);
  if (!allowed || !navOk(allowed)) view = 'dashboard';
  V.view = view; closeModal(); window.scrollTo(0, 0);
  try { history.replaceState(null, '', '#' + view); } catch (e) {}
  refresh(true);
}

/* =====================================================================
   AKSI
   ===================================================================== */
const ACT = {
  async logout(){ await sb.auth.signOut(); location.reload(); },
  go(d){ go(d.id); return 'nav'; },
  refresh(){ },
  close(){ closeModal(); return 'nav'; },
  'open-wo'(d){ V.woId = d.id; go('wo'); return 'nav'; },
  'open-so'(d){ V.soId = d.id; go('sales'); return 'nav'; },
  'wo-back'(){ V.woId = null; },
  'wo-filter'(d){ V.woFilter = d.id; },
  'inv-filter'(d){ V.invFilter = d.id; },
  'm-tab'(d){ V.masterTab = d.id; },

  /* check-in */
  async 'ci-lookup'(){
    const key = CI.plate.toUpperCase().replace(/\s/g, '');
    if (!key) throw new Error('Isi nomor polisi dulu.');
    const v = await q(sb.from('vehicles').select('*, customers(id,name,phone)').eq('plate_key', key).maybeSingle());
    CI.looked = true; CI.vehicle = v;
    if (v) CI.plate = v.plate;
    toast(v ? 'Pelanggan lama: data terisi otomatis.' : 'Kendaraan baru. Lengkapi data pelanggan.');
    return 'paint';
  },
  async 'ci-create'(){
    const c = CI;
    if (!c.plate.trim() || !c.complaint.trim()) throw new Error('Nomor polisi dan keluhan wajib diisi.');
    if (!c.looked) { await ACT['ci-lookup'](); if (!CI.vehicle) return 'paint'; }
    if (!c.vehicle?.customers && !c.name.trim()) throw new Error('Nama pelanggan wajib untuk kendaraan baru.');
    let eta = null;
    if (/^\d{2}:\d{2}$/.test(c.eta)) eta = new Date(`${todayISO()}T${c.eta}:00+07:00`).toISOString();
    const id = await rpc('create_work_order', {p: {
      plate: c.plate, customer_name: c.name, customer_phone: c.phone, model: c.model, year: c.year, complaint: c.complaint,
      odometer: c.odometer, fuel_level: c.fuel, equipment: EQUIP.filter((k) => c.equipment[k]), existing_damage: c.damage,
      photos: SIDES.map((s) => c.photos[s].path), eta}});
    CI = null; V.woId = id; toast('WO dibuat dan masuk antrean.'); go('wo'); return 'nav';
  },

  /* work order */
  async 'wo-next'(){ const s = await rpc('wo_advance', {p_wo: V.woId}); toast(`Status → ${s}`); },
  async 'wo-assign'(){
    const mek = $('as-mek').value, bay = $('as-bay').value;
    if (!mek || !bay) throw new Error('Pilih mekanik dan bay.');
    await rpc('wo_assign', {p_wo: V.woId, p_mechanic: mek, p_bay: bay}); toast('Penugasan disimpan.');
  },
  async 'wo-diag'(){ await rpc('wo_set_diagnosis', {p_wo: V.woId, p_text: $('wo-diag').value}); toast('Diagnosa disimpan.'); },
  async 'wo-add-labor'(){ const v = $('labor-sel').value; if (!v) throw new Error('Isi master tarif jasa dulu.'); await rpc('wo_add_labor', {p_wo: V.woId, p_rate: v}); },
  async 'wo-rm-labor'(d){ await rpc('wo_remove_labor', {p_id: d.id}); },
  async 'wo-disc'(){
    const amt = Number(String($('wo-disc').value).replace(/\D/g, '')) || 0;
    const r = await rpc('wo_set_discount', {p_wo: V.woId, p_amount: amt});
    toast(r === 'pending' ? 'Diskon melebihi batas SA; menunggu approval Kepala Bengkel.' : 'Diskon disimpan.');
  },
  async 'wo-disc-ok'(d){ await rpc('wo_approve_discount', {p_wo: V.woId, p_approve: d.id === '1'}); },
  async 'wo-send-est'(){
    await rpc('wo_send_estimate', {p_wo: V.woId});
    const w = D.w; const lines = D.lines.filter((l) => !['released','returned'].includes(l.state));
    const txt = [`*Estimasi servis ${M.settings.workshop_name || ''}*`, `${w.no} · ${w.plate} (${w.model || ''})`, '',
      ...D.labor.map((j) => `• ${j.name}: ${rp(j.price)}`),
      ...lines.map((l) => `• ${l.parts?.name} × ${Number(l.qty)}: ${rp(l.qty * l.price)}`),
      ...(Number(w.discount) ? [`• Diskon: − ${rp(w.discount)}`] : []), '', `*Total: ${rp(woTotal(w))}*`, '', 'Mohon balas SETUJU untuk melanjutkan pekerjaan. Terima kasih.'].join('\n');
    const num = waNumber(w.customer_phone);
    const url = `https://wa.me/${num}?text=${encodeURIComponent(txt)}`;
    const win = window.open(url, '_blank', 'noopener');
    toast(win ? 'WhatsApp dibuka. Catat jawaban pelanggan setelah dibalas.' : 'Estimasi ditandai terkirim. Izinkan pop-up untuk membuka WhatsApp.');
  },
  async 'wo-decide'(d){ await stock('wo_estimate_decide', {wo_id: V.woId, approved: d.id === '1'}); toast(d.id === '1' ? 'Estimasi disetujui; reservasi jadi tetap.' : 'Estimasi ditolak; reservasi sementara dilepas.'); },
  async 'wo-pick'(){ const r = await stock('pick_request', {wo_id: V.woId}); toast(`${r.pick_no} dikirim ke ${WH}.`); },
  async 'wo-invoice'(){ await rpc('issue_invoice_wo', {p_wo: V.woId}); toast('Invoice terbit.'); },
  'part-modal'(){
    openModal(`<div class="card-h"><h2>Tambah part ke ${esc(D.w.no)}</h2><button type="button" class="btn sm" data-act="close">Tutup</button></div>
      <div class="card-b"><div class="field"><label for="pp-q">Cari part (stok live dari ${WH})</label><input id="pp-q" class="in" type="search" placeholder="Nama atau SKU…" autocomplete="off"></div></div>
      <div class="tw" id="pp-list"><div class="loading">Mencari…</div></div>`);
    searchParts('', 'pp-list', 'wo-add-part');
    return 'nav';
  },
  async 'wo-add-part'(d){
    const qty = Number($('qty-' + d.id).value) || 1;
    const r = await stock('wo_add_part', {wo_id: V.woId, part_id: d.id, qty});
    closeModal();
    toast({ok: `Part ter-reservasi sementara di ${WH}.`, queued: 'WMS tidak bisa dihubungi: reservasi diantrekan.', backorder: 'Stok kurang: part dijadikan backorder.', draft: 'Part ditambahkan; direservasi setelah pelanggan setuju.'}[r.result] || 'Part ditambahkan.');
  },
  async 'line-rm'(d){ await stock('line_remove', {line_id: d.id}); toast('Part dihapus; reservasi dilepas.'); },
  async 'line-bo'(d){ await stock('line_backorder', {line_id: d.id}); toast('Dijadikan backorder.'); },
  async 'line-reserve'(d){ const r = await stock('line_reserve', {line_id: d.id}); toast(r.result === 'ok' ? 'Ter-reservasi.' : r.result === 'queued' ? 'Diantrekan.' : 'Stok masih kurang.'); },
  async 'line-return'(d){ await stock('internal_return', {line_id: d.id}); toast(`Retur internal dikirim ke ${WH} untuk QC.`); },

  /* penjualan */
  'so-new'(){ V.soId = 'new'; SD = null; },
  'so-add'(d){
    const part = partHits[d.id]; const qty = Number($('qty-' + d.id).value) || 1;
    const ex = SD.lines.find((l) => l.part.id === part.id);
    if (ex) ex.qty += qty; else SD.lines.push({part, qty});
    return 'paint-so';
  },
  'so-rm'(d){ SD.lines.splice(Number(d.id), 1); return 'paint-so'; },
  async 'so-create'(){
    const id = await rpc('create_sales_order', {p_customer: SD.customer_id, p_lines: SD.lines.map((l) => ({part_id: l.part.id, qty: l.qty}))});
    V.soId = id; SD = null;
    const r = await stock('so_confirm', {so_id: id});
    toast(r.result === 'finance' ? 'Melebihi limit kredit: SO menunggu approval Finance.' : `SO dikonfirmasi${r.lines?.backorder ? `, ${r.lines.backorder} line backorder` : ''}${r.lines?.queued ? `, ${r.lines.queued} line antre WMS` : ''}.`);
  },
  async 'so-finance'(){ await stock('so_finance_approve', {so_id: V.soId}); toast('Disetujui Finance; stok direservasi.'); },
  'so-pay'(){
    openModal(`<div class="card-h"><h2>Terima pembayaran ${esc(D.so.no)}</h2><button type="button" class="btn sm" data-act="close">Tutup</button></div>
      <div class="card-b"><div class="total" style="border:0;padding:0"><span>Total</span><span class="mono">${rp(D.so.total)}</span></div>
      <div class="field"><label for="pay-m">Metode</label><select id="pay-m" class="in"><option>Tunai</option><option>Transfer</option><option>QRIS</option><option>Kartu debit</option></select></div>
      <div class="field"><label for="pay-r">Referensi (opsional)</label><input id="pay-r" class="in"></div>
      <div class="btns"><button type="button" class="btn primary" data-act="so-pay-save">Simpan pembayaran</button></div></div>`, true);
    return 'nav';
  },
  async 'so-pay-save'(){ const pf = await rpc('so_pay', {p_so: V.soId, p_method: $('pay-m').value, p_ref: $('pay-r').value}); closeModal(); toast(`Pembayaran diterima (${pf}). Kirim pick request ke gudang.`); },
  async 'so-pick'(){ const r = await stock('pick_request', {so_id: V.soId}); toast(`${r.pick_no} dikirim ke ${WH}.`); },
  async 'so-invoice'(){ await rpc('issue_invoice_so', {p_so: V.soId}); toast('Invoice terbit.'); },
  async 'so-cancel'(){
    openModal(`<div class="card-h"><h2>Batalkan ${esc(D.so.no)}?</h2></div><div class="card-b"><p style="margin:0">Semua reservasi stok SO ini akan dilepas.</p>
      <div class="btns"><button type="button" class="btn danger" data-act="so-cancel-ok">Ya, batalkan</button><button type="button" class="btn" data-act="close">Tidak</button></div></div>`, true);
    return 'nav';
  },
  async 'so-cancel-ok'(){ await stock('so_cancel', {so_id: V.soId}); closeModal(); toast('SO dibatalkan.'); },

  /* kasir */
  'pay-modal'(d){
    const i = D.inv.find((x) => x.id === d.id); const left = Number(i.total) - Number(i.paid_amount);
    openModal(`<div class="card-h"><h2>Catat pembayaran ${esc(i.no)}</h2><button type="button" class="btn sm" data-act="close">Tutup</button></div>
      <div class="card-b"><div class="small muted">${esc(i.customer_name)} · sisa tagihan ${rp(left)}</div>
      <div class="field"><label for="pm-a">Nominal (Rp)</label><input id="pm-a" class="in mono" inputmode="numeric" value="${left}"></div>
      <div class="field"><label for="pm-m">Metode</label><select id="pm-m" class="in"><option>Tunai</option><option>Transfer</option><option>QRIS</option><option>Kartu debit</option><option>Giro</option></select></div>
      <div class="field"><label for="pm-r">Referensi</label><input id="pm-r" class="in" placeholder="No. transfer / bukti"></div>
      <div class="btns"><button type="button" class="btn primary" data-act="pay-save" data-id="${i.id}">Simpan</button></div></div>`, true);
    return 'nav';
  },
  async 'pay-save'(d){
    await rpc('record_payment', {p_invoice: d.id, p_amount: Number(String($('pm-a').value).replace(/\D/g, '')), p_method: $('pm-m').value, p_ref: $('pm-r').value});
    closeModal(); toast('Pembayaran dicatat.');
  },
  async 'inv-print'(d){
    const i = D.inv.find((x) => x.id === d.id);
    const [labor, lines] = await Promise.all([
      i.wo_id ? q(sb.from('wo_labor').select('*').eq('wo_id', i.wo_id)) : [],
      q(sb.from('order_lines').select('*, parts(name,unit)').eq('invoice_id', i.id))
    ]);
    openModal(`<div id="print-area" class="print-doc">
      <div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap"><div><b style="font-size:18px">${esc(M.settings.workshop_name || 'Bengkel')}</b><div class="small">${esc(M.settings.workshop_address || '')}</div></div>
        <div style="text-align:right"><b style="font-size:18px">INVOICE</b><div class="mono">${esc(i.no)}</div><div class="small">${fD(i.created_at)} · jatuh tempo ${fD(i.due_date)}</div></div></div>
      <div><b>${esc(i.customer_name)}</b><div class="small">${esc(i.customer_phone || '')} · ref ${esc(i.doc_no)}</div></div>
      <table><thead><tr><th>Uraian</th><th style="text-align:right">Qty</th><th style="text-align:right">Jumlah</th></tr></thead><tbody>
        ${labor.map((j) => `<tr><td>${esc(j.name)}</td><td style="text-align:right">1</td><td style="text-align:right">${rp(j.price)}</td></tr>`).join('')}
        ${lines.map((l) => `<tr><td>${esc(l.parts?.name)} <span class="small">${esc(l.sku)}</span></td><td style="text-align:right">${Number(l.qty)} ${esc(l.parts?.unit || '')}</td><td style="text-align:right">${rp(l.qty * l.price)}</td></tr>`).join('')}
      </tbody></table>
      <div style="margin-left:auto;min-width:240px"><div style="display:flex;justify-content:space-between"><span>Subtotal</span><span>${rp(i.subtotal)}</span></div>
        ${Number(i.discount) ? `<div style="display:flex;justify-content:space-between"><span>Diskon</span><span>− ${rp(i.discount)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;font-weight:700;font-size:16px;border-top:1px solid #111827;padding-top:6px"><span>Total</span><span>${rp(i.total)}</span></div>
        <div style="display:flex;justify-content:space-between" class="small"><span>Dibayar</span><span>${rp(i.paid_amount)}</span></div></div>
      <div class="btns no-print"><button type="button" class="btn primary" data-act="do-print">Cetak</button><button type="button" class="btn" data-act="close">Tutup</button></div>
    </div>`);
    return 'nav';
  },
  'do-print'(){ window.print(); return 'nav'; },

  /* master */
  'm-edit'(d){ masterForm(d.id); return 'nav'; },
  async 'm-save'(d){
    const m = MASTER[V.masterTab]; const row = {};
    for (const [k, l, type, req] of m.cols) {
      const el = $('mf-' + k);
      let v = type === 'bool' ? el.checked : el.value.trim();
      if (type === 'number') v = v === '' ? (k === 'year' || req ? null : 0) : Number(String(v).replace(/[^\d-]/g, ''));
      if (type === 'customer' && !v) v = null;
      if (req && (v === '' || v == null)) throw new Error(`${l} wajib diisi.`);
      if (k === 'plate' || k === 'sku') v = String(v).toUpperCase().replace(/\s+/g, k === 'sku' ? '' : ' ');
      row[k] = v;
    }
    if (d.id) await q(sb.from(m.table).update(row).eq('id', d.id));
    else await q(sb.from(m.table).insert(row));
    closeModal(); toast('Tersimpan.'); await loadMasters();
  },
  'user-edit'(d){
    const u = D.rows.find((x) => x.id === d.id);
    openModal(`<div class="card-h"><h2>Pengguna</h2><button type="button" class="btn sm" data-act="close">Tutup</button></div>
      <div class="card-b"><div class="small muted">${esc(u.email)}</div>
      <div class="field"><label for="u-name">Nama</label><input id="u-name" class="in" value="${esc(u.full_name)}"></div>
      <div class="field"><label for="u-role">Peran</label><select id="u-role" class="in">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <label class="checks" style="display:flex"><input type="checkbox" id="u-active" ${u.active ? 'checked' : ''}> Akun aktif</label>
      <div class="btns"><button type="button" class="btn primary" data-act="user-save" data-id="${u.id}">Simpan</button></div></div>`, true);
    return 'nav';
  },
  async 'user-save'(d){ await rpc('set_user', {p_user: d.id, p_role: $('u-role').value, p_active: $('u-active').checked, p_name: $('u-name').value}); closeModal(); toast('Pengguna diperbarui.'); await loadMasters(); },
  async 'settings-save'(){
    for (const s of D.rows) {
      const el = $('set-' + s.key); let v = el.value.trim();
      const val = el.dataset.type === 'number' ? Number(v) : v;
      if (el.dataset.type === 'number' && !Number.isFinite(val)) throw new Error(`${s.label}: harus angka.`);
      if (JSON.stringify(val) !== JSON.stringify(s.value)) await q(sb.from('app_settings').update({value: val, updated_at: new Date().toISOString()}).eq('key', s.key));
    }
    toast('Pengaturan disimpan.'); await loadMasters();
  },

  /* gudang */
  async 'pk-start'(d){ await rpc('pick_start', {p_pick: d.id}); },
  'pk-done'(d){
    const p = D.picks.find((x) => x.id === d.id);
    const lines = (p.order_lines || []).filter((l) => l.state === 'picking');
    openModal(`<div class="card-h"><h2>Selesai ambil ${esc(p.no)}</h2><button type="button" class="btn sm" data-act="close">Tutup</button></div>
      <div class="card-b"><div class="small muted">Isi jumlah yang benar-benar ada di rak. Bila kurang, sisanya otomatis jadi backorder dan stok sistem dikoreksi.</div>
      ${lines.map((l) => `<div class="row"><div class="field"><label for="pq-${l.id}">${esc(l.parts?.name)} · bin ${esc(l.parts?.bin || '—')} · diminta ${Number(l.qty)}</label><input id="pq-${l.id}" class="in mono" type="number" min="0" max="${Number(l.qty)}" step="1" value="${Number(l.qty)}" data-line="${l.id}"></div></div>`).join('')}
      <div class="btns"><button type="button" class="btn primary" data-act="pk-done-save" data-id="${p.id}">Simpan</button></div></div>`, true);
    return 'nav';
  },
  async 'pk-done-save'(d){
    const actual = {};
    document.querySelectorAll('#modal [data-line]').forEach((i) => { actual[i.dataset.line] = Number(i.value); });
    const short = await rpc('pick_complete', {p_pick: d.id, p_actual: actual});
    closeModal(); toast(short ? `${short} barang kurang: sisanya jadi backorder, cek fisik bin.` : 'Barang siap diserahkan.');
  },
  async 'pk-gi'(d){ const gi = await rpc('goods_issue', {p_pick: d.id}); toast(`${gi} diposting. Stok berkurang.`); },
  async 'rt-recv'(d){ await rpc('return_receive', {p_line: d.id, p_good: d.good === '1'}); toast(d.good === '1' ? 'Retur masuk stok.' : 'Retur masuk karantina.'); },
  'st-recv'(d){
    const x = D.rows.find((r) => r.id === d.id);
    openModal(`<div class="card-h"><h2>Terima barang</h2><button type="button" class="btn sm" data-act="close">Tutup</button></div>
      <div class="card-b"><div><b>${esc(x.name)}</b> <span class="mono muted">${esc(x.sku)}</span><div class="small muted">On-hand sekarang ${x.wms.on_hand} ${esc(x.unit)} · bin ${esc(x.bin || '—')}</div></div>
      <div class="field"><label for="rc-q">Jumlah diterima</label><input id="rc-q" class="in mono" type="number" min="1" step="1"></div>
      <div class="field"><label for="rc-r">No. PO / surat jalan</label><input id="rc-r" class="in"></div>
      <div class="btns"><button type="button" class="btn primary" data-act="st-recv-save" data-id="${x.id}">Simpan</button></div>
      <div class="small muted">Backorder WO/SO untuk part ini otomatis direservasi bila stok cukup.</div></div>`, true);
    return 'nav';
  },
  async 'st-recv-save'(d){
    const n = await rpc('stock_receive', {p_part: d.id, p_qty: Number($('rc-q').value), p_ref: $('rc-r').value || null});
    closeModal(); toast(n ? `Barang diterima. ${n} backorder terisi otomatis.` : 'Barang diterima.');
  },
  'st-adj'(d){
    const x = D.rows.find((r) => r.id === d.id);
    openModal(`<div class="card-h"><h2>Stock opname</h2><button type="button" class="btn sm" data-act="close">Tutup</button></div>
      <div class="card-b"><div><b>${esc(x.name)}</b> <span class="mono muted">${esc(x.sku)}</span><div class="small muted">Sedang direservasi: ${x.wms.reserved} ${esc(x.unit)}</div></div>
      <div class="row"><div class="field"><label for="aj-oh">On-hand fisik</label><input id="aj-oh" class="in mono" type="number" min="0" value="${x.wms.on_hand}"></div>
      <div class="field"><label for="aj-q">Karantina</label><input id="aj-q" class="in mono" type="number" min="0" value="${x.wms.quarantine}"></div></div>
      <div class="field"><label for="aj-n">Alasan</label><input id="aj-n" class="in" placeholder="Stok awal / stock opname Okt 2026"></div>
      <div class="btns"><button type="button" class="btn primary" data-act="st-adj-save" data-id="${x.id}">Simpan</button></div></div>`, true);
    return 'nav';
  },
  async 'st-adj-save'(d){
    await rpc('stock_adjust', {p_part: d.id, p_on_hand: Number($('aj-oh').value), p_quarantine: Number($('aj-q').value), p_note: $('aj-n').value});
    closeModal(); toast('Stok disesuaikan dan tercatat.');
  },

  /* integrasi */
  async flush(){ const r = await stock('flush'); toast(`Terkirim ${r.sent}, masih antre ${r.still_pending}, SO kedaluwarsa ${r.so_expired}, reservasi sementara dilepas ${r.wo_temp_released}.`); }
};

/* ---------- event ---------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) { if (e.target.id === 'modal') closeModal(); return; }
  if (el.disabled || el.dataset.busy) return;
  const f = ACT[el.dataset.act]; if (!f) return;
  e.preventDefault();
  el.dataset.busy = '1'; if (el.tagName === 'BUTTON') el.disabled = true;
  try {
    const r = await f(el.dataset, el);
    if (r === 'nav') return;
    if (r === 'paint') { paint(); return; }
    if (r === 'paint-so') { paint(); if (SD?.q) searchParts(SD.q, 'so-results', 'so-add'); return; }
    await refresh(false);
  } catch (err) {
    toast(err.message || String(err), true);
    if (document.body.contains(el)) { el.disabled = false; delete el.dataset.busy; }
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'pp-q') return searchParts(t.value, 'pp-list', 'wo-add-part');
  if (t.id === 'so-q') { SD.q = t.value; return searchParts(t.value, 'so-results', 'so-add'); }
  if (t.id === 'wo-q') { V.woSearch = t.value; return searchWO(); }
  if (t.id === 'stok-q') { V.stokQ = t.value; return searchStok(); }
  if (t.id === 'gd-q') { V.gdQ = t.value; return searchGudang(); }
  const b = t.dataset?.bind;
  if (b && CI) { if (b.startsWith('eq.')) CI.equipment[b.slice(3)] = t.checked; else CI[b] = t.value; if (b === 'plate') { CI.looked = false; CI.vehicle = null; } }
});
const searchWO = debounce(() => refresh(false).then(() => { const i = $('wo-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }), 400);
const searchStok = debounce(() => refresh(false).then(() => { const i = $('stok-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }), 400);
const searchGudang = debounce(() => refresh(false).then(() => { const i = $('gd-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }), 400);
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'so-cust') { SD.customer_id = t.value; paint(); return; }
  if (t.dataset?.photo && t.files?.[0]) { uploadPhoto(t.dataset.photo, t.files[0]); return; }
  const b = t.dataset?.bind;
  if (b && CI) { if (b.startsWith('eq.')) CI.equipment[b.slice(3)] = t.checked; else CI[b] = t.value; }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal();
  if (e.key === 'Enter' && e.target.id === 'ci-plate') { e.preventDefault(); document.querySelector('[data-act="ci-lookup"]')?.click(); }
});

/* ---------- realtime: layar ter-update saat orang lain mengubah data ---------- */
const liveRefresh = debounce(() => {
  if (!$('modal').hidden) return;
  if (['checkin','master','stok'].includes(V.view)) return;
  const a = document.activeElement;
  if (a && $('main').contains(a) && ['INPUT','TEXTAREA','SELECT'].includes(a.tagName)) return;
  refresh(false);
}, 800);
function subscribeLive(){
  sb.channel('oms-live')
    .on('postgres_changes', {event: '*', schema: 'public', table: 'work_orders'}, liveRefresh)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'order_lines'}, liveRefresh)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'sales_orders'}, liveRefresh)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'invoices'}, liveRefresh)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'pick_requests'}, liveRefresh)
    .on('postgres_changes', {event: '*', schema: 'public', table: INTERNAL ? 'parts' : 'wms_outbox'}, liveRefresh)
    .subscribe();
}

/* =====================================================================
   LOGIN & BOOT
   ===================================================================== */
let signUp = false;
function showLogin(msg){
  $('boot').hidden = true; $('app').hidden = true; $('login').hidden = false;
  if (msg) $('l-msg').innerHTML = msg;
}
$('l-toggle').addEventListener('click', () => {
  signUp = !signUp;
  $('f-name').hidden = !signUp;
  $('login-h').textContent = signUp ? 'Daftar akun' : 'Masuk';
  $('l-submit').textContent = signUp ? 'Daftar' : 'Masuk';
  $('l-toggle').textContent = signUp ? 'Sudah punya akun? Masuk' : 'Belum punya akun? Daftar';
  $('l-pass').autocomplete = signUp ? 'new-password' : 'current-password';
  $('l-msg').textContent = '';
});
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('l-email').value.trim(), password = $('l-pass').value;
  $('l-submit').disabled = true; $('l-msg').textContent = '';
  try {
    if (signUp) {
      const {data, error} = await sb.auth.signUp({email, password, options: {data: {full_name: $('l-name').value.trim()}, emailRedirectTo: location.origin + location.pathname}});
      if (error) throw error;
      if (!data.session) { $('l-msg').textContent = 'Akun dibuat. Buka email Anda untuk konfirmasi, lalu masuk. Admin perlu mengaktifkan akun dan memberi peran.'; return; }
    } else {
      const {error} = await sb.auth.signInWithPassword({email, password});
      if (error) throw error;
    }
    await start();
  } catch (err) {
    $('l-msg').innerHTML = `<span class="late">${esc(/Invalid login/i.test(err.message) ? 'Email atau password salah.' : err.message)}</span>`;
  } finally { $('l-submit').disabled = false; }
});

async function start(){
  const {data: {session}} = await sb.auth.getSession();
  if (!session) return showLogin();
  U.user = session.user;
  const prof = await q(sb.from('profiles').select('*').eq('id', U.user.id).maybeSingle());
  if (!prof || !prof.active) {
    await sb.auth.signOut();
    return showLogin('<span class="late">Akun Anda belum diaktifkan. Minta admin mengaktifkan akun dan memberi peran.</span>');
  }
  U.profile = prof;
  await loadMasters();
  $('boot').hidden = true; $('login').hidden = true; $('app').hidden = false;
  subscribeLive();
  setInterval(() => { stock('flush').catch(() => {}); }, 5 * 60e3);
  const h = (location.hash || '').slice(1);
  go(NAV.some(([k]) => k === h) ? h : (prof.role === 'mekanik' ? 'wo' : 'dashboard'));
}

(function boot(){
  if (!window.supabase || !CFG.SUPABASE_URL || /XXXX/.test(CFG.SUPABASE_URL) || !CFG.SUPABASE_ANON_KEY || /ISI_/.test(CFG.SUPABASE_ANON_KEY)) {
    $('boot').innerHTML = '<div class="login-card"><h1>Belum dikonfigurasi</h1><p class="muted" style="margin:0">Isi <span class="mono">SUPABASE_URL</span> dan <span class="mono">SUPABASE_ANON_KEY</span> di file <span class="mono">config.js</span>, lalu muat ulang halaman. Lihat PANDUAN-SETUP.md.</p></div>';
    return;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') { U.user = null; U.profile = null; } });
  start().catch((e) => showLogin(`<span class="late">${esc(e.message)}</span>`));
})();
