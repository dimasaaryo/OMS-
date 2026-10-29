// =====================================================================
// OMS Bengkel · Edge Function "wms"
//
// 1) Aksi dari aplikasi (wajib login):  POST /functions/v1/wms  {action, ...}
// 2) Webhook dari WMS:                   POST /functions/v1/wms?webhook=1
//    header  x-wms-secret: <WMS_WEBHOOK_SECRET>
//    body    {event_id, type, data}
//
// Secrets (Supabase → Edge Functions → Secrets):
//   WMS_BASE_URL        mis. https://wms.perusahaan.co.id/api/v1
//   WMS_API_TOKEN       token API WMS (dikirim sebagai Bearer)
//   WMS_WAREHOUSE       kode gudang sparepart bengkel (opsional)
//   WMS_WEBHOOK_SECRET  string acak, diisi juga di konfigurasi webhook WMS
//
// Bagian "ADAPTER WMS" di bawah mengikuti kontrak di PRD. Nama endpoint dan
// field mungkin perlu disesuaikan dengan dokumentasi API WMS yang dipakai.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const WMS_BASE = (Deno.env.get('WMS_BASE_URL') ?? '').replace(/\/+$/, '');
const WMS_TOKEN = Deno.env.get('WMS_API_TOKEN') ?? '';
const WMS_WAREHOUSE = Deno.env.get('WMS_WAREHOUSE') ?? '';
const WEBHOOK_SECRET = Deno.env.get('WMS_WEBHOOK_SECRET') ?? '';

const db = createClient(SB_URL, SB_SERVICE, { auth: { persistSession: false } });

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wms-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

class AppError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}
class WmsDown extends Error {}

// ---------------------------------------------------------------------
// ADAPTER WMS
// ---------------------------------------------------------------------
async function wmsFetch(method: string, path: string, body?: unknown, idemKey?: string) {
  if (!WMS_BASE) throw new WmsDown('WMS_BASE_URL belum diisi di Secrets');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(WMS_BASE + path, {
      method,
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${WMS_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(idemKey ? { 'Idempotency-Key': idemKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new WmsDown(`WMS tidak bisa dihubungi: ${e instanceof Error ? e.message : e}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (res.status >= 500 || res.status === 429 || res.status === 408) {
    throw new WmsDown(`WMS ${res.status}: ${text.slice(0, 200)}`);
  }
  return { ok: res.ok, status: res.status, data };
}

const pick = (o: any, ...keys: string[]) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const listOf = (d: any) => Array.isArray(d) ? d : (d?.data ?? d?.items ?? d?.results ?? []);

// GET /stock/availability → [{sku, on_hand, reserved, quarantine, available, min_stock, bin}]
async function wmsAvailability(skus: string[]) {
  const out: Record<string, any> = {};
  for (let i = 0; i < skus.length; i += 50) {
    const chunk = skus.slice(i, i + 50);
    const qs = new URLSearchParams({ sku: chunk.join(',') });
    if (WMS_WAREHOUSE) qs.set('warehouse', WMS_WAREHOUSE);
    const r = await wmsFetch('GET', `/stock/availability?${qs}`);
    if (!r.ok) throw new AppError(`WMS menolak cek stok (${r.status})`, 502);
    for (const row of listOf(r.data)) {
      const sku = pick(row, 'sku', 'SKU', 'item_code');
      if (!sku) continue;
      const onHand = Number(pick(row, 'on_hand', 'onHand', 'qty_on_hand') ?? 0);
      const reserved = Number(pick(row, 'reserved', 'qty_reserved') ?? 0);
      const quarantine = Number(pick(row, 'quarantine', 'qty_quarantine', 'blocked') ?? 0);
      out[sku] = {
        on_hand: onHand, reserved, quarantine,
        available: Number(pick(row, 'available', 'qty_available') ?? onHand - reserved - quarantine),
        min_stock: Number(pick(row, 'min_stock', 'minStock', 'reorder_point') ?? 0),
        bin: pick(row, 'bin', 'bin_location', 'location') ?? null,
      };
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Outbox: setiap panggilan ke WMS dicatat; bila WMS down, diantrekan
// ---------------------------------------------------------------------
type CallResult = { ok?: boolean; status?: number; data?: any; queued?: boolean };

async function callWms(kind: string, method: string, path: string, body: any, refs: { line_id?: string; doc_no?: string }, queueable: boolean): Promise<CallResult> {
  const idem = `${kind}:${refs.line_id ?? refs.doc_no}:${crypto.randomUUID()}`;
  const { data: row, error } = await db.from('wms_outbox')
    .insert({ kind, method, path, body, idem_key: idem, line_id: refs.line_id ?? null, doc_no: refs.doc_no ?? null, status: 'sending', attempts: 1 })
    .select('id').single();
  if (error) throw error;
  return await sendOutbox(row.id, method, path, body, idem, queueable);
}

async function sendOutbox(id: string, method: string, path: string, body: any, idem: string, queueable: boolean): Promise<CallResult> {
  try {
    const r = await wmsFetch(method, path, body ?? undefined, idem);
    await db.from('wms_outbox').update({
      status: r.ok ? 'sent' : 'rejected', http_status: r.status, response: r.data, sent_at: new Date().toISOString(), last_error: null,
    }).eq('id', id);
    return r;
  } catch (e) {
    if (e instanceof WmsDown) {
      await db.from('wms_outbox').update({ status: queueable ? 'pending' : 'failed', last_error: e.message }).eq('id', id);
      if (queueable) return { queued: true };
      throw new AppError(`${e.message}. Coba lagi setelah WMS bisa dihubungi.`, 503);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------
// Helper data
// ---------------------------------------------------------------------
async function setting(key: string, fallback: number) {
  const { data } = await db.from('app_settings').select('value').eq('key', key).maybeSingle();
  const n = Number(data?.value);
  return Number.isFinite(n) ? n : fallback;
}
async function getLine(id: string) {
  const { data } = await db.from('order_lines').select('*').eq('id', id).maybeSingle();
  if (!data) throw new AppError('Baris part tidak ditemukan', 404);
  return data;
}
async function docOf(line: any) {
  if (line.wo_id) {
    const { data } = await db.from('work_orders').select('id,no,status,estimate,bay_id').eq('id', line.wo_id).single();
    return { type: 'WO', ...data };
  }
  const { data } = await db.from('v_sales_orders').select('id,no,status,top_days,paid_at').eq('id', line.so_id).single();
  return { type: 'SO', ...data };
}
const updLine = (id: string, patch: Record<string, unknown>) => db.from('order_lines').update(patch).eq('id', id);

// ---------------------------------------------------------------------
// Reservasi
// ---------------------------------------------------------------------
async function reserveLine(line: any, kind: 'WO_TEMP' | 'WO' | 'SO', retry = false) {
  const doc = await docOf(line);
  let expires: string | null = null;
  if (kind === 'WO_TEMP') expires = new Date(Date.now() + (await setting('wo_temp_reservation_hours', 4)) * 3600e3).toISOString();
  if (kind === 'SO' && !(doc as any).top_days) expires = new Date(Date.now() + (await setting('so_retail_expiry_hours', 24)) * 3600e3).toISOString();
  const body = {
    reference_no: doc.no, reference_type: doc.type, line_ref: line.id,
    sku: line.sku, qty: Number(line.qty), type: kind, warehouse: WMS_WAREHOUSE || undefined, expires_at: expires,
  };
  await updLine(line.id, { reservation_kind: kind });
  const r = await callWms('reservation', 'POST', '/reservations', body, { line_id: line.id, doc_no: doc.no }, true);
  return await applyReservation(line.id, r, retry);
}

async function applyReservation(lineId: string, r: CallResult, retry: boolean) {
  const line = await getLine(lineId);
  if (r.queued) { await updLine(lineId, { state: 'queued' }); return 'queued'; }
  const d = r.data ?? {};
  const resId = pick(d, 'id', 'reservation_id');
  const st = String(pick(d, 'status') ?? (r.ok ? 'confirmed' : 'rejected')).toLowerCase();
  if (r.ok && (st === 'confirmed' || st === 'reserved')) {
    await updLine(lineId, { state: line.reservation_kind === 'WO_TEMP' ? 'reserved_temp' : 'reserved', reservation_id: resId ?? null, note: null });
    // reservasi dibuat sebagai sementara tapi estimasi keburu disetujui → jadikan tetap
    const doc = await docOf(line);
    if (line.reservation_kind === 'WO_TEMP' && doc.type === 'WO' && (doc as any).estimate === 'approved' && resId) {
      await firmUp({ ...line, reservation_id: resId, state: 'reserved_temp' });
    }
    return 'ok';
  }
  if (r.ok && st === 'pending') { await updLine(lineId, { state: 'queued', reservation_id: resId ?? null }); return 'queued'; }
  const reason = pick(d, 'reason', 'message', 'error') ?? `ditolak WMS (${r.status})`;
  await updLine(lineId, { state: retry ? 'failed' : 'backorder', reservation_id: null, note: String(reason).slice(0, 300) });
  return retry ? 'failed' : 'backorder';
}

async function firmUp(line: any) {
  if (line.state === 'reserved_temp' && line.reservation_id) {
    await callWms('reservation_patch', 'PATCH', `/reservations/${encodeURIComponent(line.reservation_id)}`, { type: 'WO', expires_at: null }, { line_id: line.id }, true);
    await updLine(line.id, { state: 'reserved', reservation_kind: 'WO' });
  } else if (line.state === 'queued') {
    await updLine(line.id, { reservation_kind: 'WO' });
  }
}

async function releaseLine(line: any, reason: string) {
  if (line.reservation_id && ['reserved_temp', 'reserved', 'queued'].includes(line.state)) {
    await callWms('reservation_delete', 'DELETE', `/reservations/${encodeURIComponent(line.reservation_id)}`, undefined, { line_id: line.id }, true);
  }
  await db.from('wms_outbox').update({ status: 'cancelled', last_error: reason })
    .eq('line_id', line.id).eq('kind', 'reservation').eq('status', 'pending');
  await updLine(line.id, { state: 'released', reservation_id: null, note: reason });
}

// ---------------------------------------------------------------------
// Aksi dari aplikasi
// ---------------------------------------------------------------------
type Profile = { id: string; role: string; full_name: string; active: boolean };
function need(p: Profile, ...roles: string[]) {
  if (p.role !== 'admin' && !roles.includes(p.role)) throw new AppError('Akses ditolak untuk peran ini', 403);
}

const actions: Record<string, (p: Profile, b: any) => Promise<unknown>> = {
  async status() {
    if (!WMS_BASE) return { configured: false };
    try { await wmsFetch('GET', `/stock/availability?sku=__ping__${WMS_WAREHOUSE ? '&warehouse=' + WMS_WAREHOUSE : ''}`); return { configured: true, reachable: true, base: WMS_BASE }; }
    catch (e) { return { configured: true, reachable: false, base: WMS_BASE, error: e instanceof Error ? e.message : String(e) }; }
  },

  async availability(_p, b) {
    let q = db.from('parts').select('id,sku,name,unit,price,category').eq('active', true).order('name').limit(b.all ? 1000 : 40);
    if (b.q) q = q.or(`name.ilike.%${String(b.q).replace(/[%,()]/g, ' ')}%,sku.ilike.%${String(b.q).replace(/[%,()]/g, ' ')}%`);
    if (b.skus?.length) q = q.in('sku', b.skus);
    const { data: parts, error } = await q;
    if (error) throw error;
    try {
      const av = await wmsAvailability((parts ?? []).map((x) => x.sku));
      let rows = (parts ?? []).map((x) => ({ ...x, wms: av[x.sku] ?? null }));
      if (b.low) rows = rows.filter((x) => x.wms && x.wms.available < x.wms.min_stock);
      return { wms_ok: true, rows };
    } catch (e) {
      return { wms_ok: false, error: e instanceof Error ? e.message : String(e), rows: (parts ?? []).map((x) => ({ ...x, wms: null })) };
    }
  },

  async wo_add_part(p, b) {
    need(p, 'sa', 'kepala_bengkel', 'mekanik');
    const { data: wo } = await db.from('work_orders').select('id,status,estimate').eq('id', b.wo_id).single();
    if (!wo || ['Siap Ambil', 'Selesai', 'Batal'].includes(wo.status)) throw new AppError('WO sudah tidak bisa diubah');
    const { data: part } = await db.from('parts').select('*').eq('id', b.part_id).eq('active', true).single();
    if (!part) throw new AppError('Part tidak ditemukan');
    const qty = Number(b.qty);
    if (!(qty > 0)) throw new AppError('Qty tidak valid');
    const { data: line, error } = await db.from('order_lines')
      .insert({ wo_id: wo.id, part_id: part.id, sku: part.sku, qty, price: part.price, state: 'draft', created_by: p.id })
      .select('*').single();
    if (error) throw error;
    if (wo.estimate === 'approved') await db.from('work_orders').update({ estimate: 'revisi' }).eq('id', wo.id);
    if (wo.estimate === 'rejected') await db.from('work_orders').update({ estimate: 'draft' }).eq('id', wo.id);
    // tambahan dari mekanik menunggu persetujuan dulu (PRD WO-09)
    if (p.role === 'mekanik') return { result: 'draft' };
    return { result: await reserveLine(line, 'WO_TEMP') };
  },

  async line_reserve(p, b) {
    need(p, 'sa', 'kepala_bengkel', 'sales_counter');
    const line = await getLine(b.line_id);
    if (!['draft', 'backorder', 'failed'].includes(line.state)) throw new AppError('Baris ini tidak perlu direservasi');
    const doc = await docOf(line);
    const kind = doc.type === 'SO' ? 'SO' : ((doc as any).estimate === 'approved' ? 'WO' : 'WO_TEMP');
    return { result: await reserveLine(line, kind) };
  },

  async line_remove(p, b) {
    need(p, 'sa', 'kepala_bengkel', 'sales_counter');
    const line = await getLine(b.line_id);
    if (!['draft', 'queued', 'reserved_temp', 'reserved', 'backorder', 'failed', 'released'].includes(line.state)) {
      throw new AppError('Part yang sudah di-pick atau di-issue tidak bisa dihapus');
    }
    await releaseLine(line, 'baris dihapus');
    await db.from('order_lines').delete().eq('id', line.id);
    return { ok: true };
  },

  async line_backorder(p, b) {
    need(p, 'sa', 'kepala_bengkel', 'sales_counter');
    const line = await getLine(b.line_id);
    if (line.state !== 'failed') throw new AppError('Hanya reservasi gagal yang bisa dijadikan backorder');
    await updLine(line.id, { state: 'backorder' });
    return { ok: true };
  },

  async wo_estimate_decide(p, b) {
    need(p, 'sa', 'kepala_bengkel');
    const { data: wo } = await db.from('work_orders').select('*').eq('id', b.wo_id).single();
    if (!wo || wo.estimate !== 'sent') throw new AppError('Estimasi belum dikirim ke pelanggan');
    const { data: lines } = await db.from('order_lines').select('*').eq('wo_id', wo.id);
    if (b.approved) {
      for (const l of lines ?? []) {
        if (l.state === 'draft') await reserveLine(l, 'WO');
        else await firmUp(l);
      }
      const patch: Record<string, unknown> = { estimate: 'approved', estimate_decided_at: new Date().toISOString(), estimate_note: b.note ?? null };
      if (wo.status === 'Diagnosa') patch.status = 'Estimasi disetujui';
      await db.from('work_orders').update(patch).eq('id', wo.id);
    } else {
      for (const l of lines ?? []) {
        if (['draft', 'queued', 'reserved_temp', 'backorder', 'failed'].includes(l.state)) await releaseLine(l, 'estimasi ditolak pelanggan');
      }
      await db.from('work_orders').update({ estimate: 'rejected', estimate_decided_at: new Date().toISOString(), estimate_note: b.note ?? null }).eq('id', wo.id);
    }
    return { ok: true };
  },

  async pick_request(p, b) {
    need(p, 'sa', 'kepala_bengkel', 'sales_counter', 'mekanik');
    let doc: any, dest: string, lines: any[];
    if (b.wo_id) {
      const { data } = await db.from('v_work_orders').select('id,no,status,bay_name').eq('id', b.wo_id).single();
      doc = data; dest = data?.bay_name ?? 'Bengkel';
      lines = (await db.from('order_lines').select('*').eq('wo_id', b.wo_id).eq('state', 'reserved')).data ?? [];
    } else {
      const { data } = await db.from('v_sales_orders').select('*').eq('id', b.so_id).single();
      doc = data; dest = 'Counter';
      if (['Draft', 'Menunggu approval Finance', 'Dibatalkan', 'Kedaluwarsa'].includes(data.status)) throw new AppError('SO belum bisa diambil');
      if (!data.top_days && !data.paid_at) throw new AppError('Pelanggan retail harus membayar dulu');
      lines = (await db.from('order_lines').select('*').eq('so_id', b.so_id).eq('state', 'reserved')).data ?? [];
    }
    if (!lines.length) throw new AppError('Tidak ada part ter-reservasi yang bisa diambil');
    const { data: pr, error } = await db.from('pick_requests')
      .insert({ wo_id: b.wo_id ?? null, so_id: b.so_id ?? null, destination: dest, created_by: p.id }).select('*').single();
    if (error) throw error;
    const r = await callWms('pick_request', 'POST', '/pick-requests', {
      reference_no: doc.no, pick_ref: pr.no, destination: dest, priority: b.wo_id ? 'normal' : 'counter',
      reservation_ids: lines.map((l) => l.reservation_id),
      lines: lines.map((l) => ({ line_ref: l.id, reservation_id: l.reservation_id, sku: l.sku, qty: Number(l.qty) })),
    }, { doc_no: doc.no }, false);
    if (!r.ok) {
      await db.from('pick_requests').update({ status: 'cancelled' }).eq('id', pr.id);
      throw new AppError(`WMS menolak pick request: ${pick(r.data, 'message', 'reason', 'error') ?? r.status}`, 502);
    }
    await db.from('pick_requests').update({ wms_pick_id: String(pick(r.data, 'id', 'pick_id') ?? pr.no) }).eq('id', pr.id);
    await db.from('order_lines').update({ state: 'picking', pick_request_id: pr.id }).in('id', lines.map((l) => l.id));
    if (b.so_id) await db.from('sales_orders').update({ status: 'Picking' }).eq('id', b.so_id);
    return { pick_no: pr.no };
  },

  async internal_return(p, b) {
    need(p, 'mekanik', 'sa', 'kepala_bengkel');
    const line = await getLine(b.line_id);
    if (!line.wo_id || line.state !== 'issued') throw new AppError('Hanya part WO yang sudah di-issue yang bisa diretur');
    const doc = await docOf(line);
    const r = await callWms('internal_return', 'POST', '/internal-returns', {
      reference_no: doc.no, line_ref: line.id, sku: line.sku, qty: Number(line.qty), reason: b.reason ?? 'part tidak terpasang',
    }, { line_id: line.id, doc_no: doc.no }, false);
    if (!r.ok) throw new AppError(`WMS menolak retur: ${pick(r.data, 'message', 'reason') ?? r.status}`, 502);
    await updLine(line.id, { state: 'returning', wms_return_id: String(pick(r.data, 'id', 'return_id') ?? '') || null });
    return { ok: true };
  },

  async so_confirm(p, b) {
    need(p, 'sales_counter', 'kepala_bengkel');
    return await confirmSO(b.so_id, false);
  },

  async so_finance_approve(p, b) {
    need(p, 'kasir');
    const { data: so } = await db.from('sales_orders').select('status').eq('id', b.so_id).single();
    if (so?.status !== 'Menunggu approval Finance') throw new AppError('SO tidak menunggu approval Finance');
    await db.from('sales_orders').update({ finance_approved_by: p.id }).eq('id', b.so_id);
    return await confirmSO(b.so_id, true);
  },

  async so_cancel(p, b) {
    need(p, 'sales_counter', 'kepala_bengkel');
    const { data: lines } = await db.from('order_lines').select('*').eq('so_id', b.so_id);
    if ((lines ?? []).some((l) => ['picking', 'picked', 'issued'].includes(l.state))) {
      throw new AppError('Barang sudah diproses gudang; gunakan retur penjualan');
    }
    for (const l of lines ?? []) await releaseLine(l, 'SO dibatalkan');
    await db.from('sales_orders').update({ status: 'Dibatalkan' }).eq('id', b.so_id);
    return { ok: true };
  },

  async flush() {
    return await flushAndExpire();
  },
};

async function confirmSO(soId: string, financeOk: boolean) {
  const { data: so } = await db.from('v_sales_orders').select('*').eq('id', soId).single();
  if (!so) throw new AppError('SO tidak ditemukan', 404);
  if (!['Draft', 'Menunggu approval Finance'].includes(so.status)) throw new AppError('SO sudah dikonfirmasi');
  if (so.top_days > 0 && !financeOk) {
    const { data: ar } = await db.rpc('customer_ar', { p_customer: so.customer_id });
    if (Number(ar ?? 0) + Number(so.total) > Number(so.credit_limit)) {
      await db.from('sales_orders').update({ status: 'Menunggu approval Finance' }).eq('id', soId);
      return { result: 'finance', ar, limit: so.credit_limit };
    }
  }
  const { data: lines } = await db.from('order_lines').select('*').eq('so_id', soId).eq('state', 'draft');
  const out: Record<string, number> = {};
  for (const l of lines ?? []) {
    const r = await reserveLine(l, 'SO');
    out[r] = (out[r] ?? 0) + 1;
  }
  const expires = so.top_days > 0 ? null : new Date(Date.now() + (await setting('so_retail_expiry_hours', 24)) * 3600e3).toISOString();
  await db.from('sales_orders').update({ status: 'Dikonfirmasi', expires_at: expires }).eq('id', soId);
  return { result: 'confirmed', lines: out };
}

async function flushAndExpire() {
  // 1) kirim ulang antrean
  const { data: pend } = await db.from('wms_outbox').select('*').eq('status', 'pending').order('created_at').limit(50);
  let sent = 0, still = 0;
  for (const o of pend ?? []) {
    await db.from('wms_outbox').update({ attempts: o.attempts + 1, status: 'sending' }).eq('id', o.id);
    const r = await sendOutbox(o.id, o.method, o.path, o.body, o.idem_key, true);
    if (r.queued) { still++; continue; }
    sent++;
    if (o.kind === 'reservation' && o.line_id) {
      const { data: l } = await db.from('order_lines').select('id,state').eq('id', o.line_id).maybeSingle();
      if (l?.state === 'queued') await applyReservation(o.line_id, r, true);
    }
  }
  // 2) SO retail belum bayar yang lewat batas
  const nowIso = new Date().toISOString();
  const { data: exp } = await db.from('v_sales_orders').select('id,no').eq('status', 'Dikonfirmasi').is('paid_at', null).eq('top_days', 0).lt('expires_at', nowIso);
  for (const so of exp ?? []) {
    const { data: lines } = await db.from('order_lines').select('*').eq('so_id', so.id);
    for (const l of lines ?? []) await releaseLine(l, 'SO retail kedaluwarsa, belum dibayar');
    await db.from('sales_orders').update({ status: 'Kedaluwarsa' }).eq('id', so.id);
  }
  // 3) reservasi sementara WO yang lewat batas tanpa persetujuan
  const hours = await setting('wo_temp_reservation_hours', 4);
  const cutoff = new Date(Date.now() - hours * 3600e3).toISOString();
  const { data: temps } = await db.from('order_lines').select('*, work_orders!inner(estimate)').eq('state', 'reserved_temp').lt('updated_at', cutoff);
  let tempReleased = 0;
  for (const l of temps ?? []) {
    if ((l as any).work_orders?.estimate === 'approved') continue;
    await releaseLine(l, `reservasi sementara lewat ${hours} jam tanpa persetujuan`);
    tempReleased++;
  }
  return { sent, still_pending: still, so_expired: exp?.length ?? 0, wo_temp_released: tempReleased };
}

// ---------------------------------------------------------------------
// Webhook dari WMS
// ---------------------------------------------------------------------
async function lineFor(item: any, pickId?: string) {
  const rid = pick(item, 'reservation_id');
  if (rid) {
    const { data } = await db.from('order_lines').select('*').eq('reservation_id', String(rid)).maybeSingle();
    if (data) return data;
  }
  const ref = pick(item, 'line_ref');
  if (ref) {
    const { data } = await db.from('order_lines').select('*').eq('id', String(ref)).maybeSingle();
    if (data) return data;
  }
  if (pickId && item?.sku) {
    const { data: pr } = await db.from('pick_requests').select('id').or(`wms_pick_id.eq.${pickId},no.eq.${pickId}`).maybeSingle();
    if (pr) {
      const { data } = await db.from('order_lines').select('*').eq('pick_request_id', pr.id).eq('sku', item.sku).limit(1).maybeSingle();
      if (data) return data;
    }
  }
  return null;
}
async function setPickStatus(pickId: string | undefined, status: string) {
  if (!pickId) return;
  await db.from('pick_requests').update({ status }).or(`wms_pick_id.eq.${pickId},no.eq.${pickId}`);
}
async function refreshDoc(line: any) {
  if (line?.so_id) await db.rpc('refresh_so_status', { p_so: line.so_id });
}

async function handleEvent(type: string, d: any) {
  const pickId = pick(d, 'pick_id', 'pick_ref') ? String(pick(d, 'pick_id', 'pick_ref')) : undefined;
  const items: any[] = Array.isArray(d?.lines) ? d.lines : [d];
  switch (type) {
    case 'reservation.confirmed': {
      const l = await lineFor(d);
      if (l && ['queued', 'draft'].includes(l.state)) {
        await updLine(l.id, { state: l.reservation_kind === 'WO_TEMP' ? 'reserved_temp' : 'reserved', reservation_id: String(pick(d, 'reservation_id', 'id')) });
        const doc = await docOf(l);
        if (l.reservation_kind === 'WO_TEMP' && (doc as any).estimate === 'approved') await firmUp({ ...l, state: 'reserved_temp', reservation_id: String(pick(d, 'reservation_id', 'id')) });
      }
      return;
    }
    case 'reservation.rejected': {
      const l = await lineFor(d);
      if (l) await updLine(l.id, { state: 'failed', reservation_id: null, note: String(pick(d, 'reason', 'message') ?? 'ditolak WMS') });
      return;
    }
    case 'pick.started':
      await setPickStatus(pickId, 'picking');
      return;
    case 'pick.completed':
    case 'pick.short': {
      for (const it of items) {
        const l = await lineFor(it, pickId);
        if (!l) continue;
        const req = Number(l.qty);
        const got = Number(pick(it, 'qty_picked', 'picked', 'qty') ?? req);
        if (got >= req) {
          await updLine(l.id, { state: 'picked', picked_qty: got });
        } else if (got > 0) {
          await updLine(l.id, { state: 'picked', picked_qty: got, qty: got, note: `short pick: ${got}/${req}` });
          await db.from('order_lines').insert({
            wo_id: l.wo_id, so_id: l.so_id, part_id: l.part_id, sku: l.sku, qty: req - got, price: l.price,
            state: 'backorder', note: `sisa short pick ${pickId ?? ''}`.trim(),
          });
        } else {
          await updLine(l.id, { state: 'backorder', reservation_id: null, pick_request_id: null, note: `short pick: 0/${req}` });
        }
      }
      await setPickStatus(pickId, 'picked');
      return;
    }
    case 'goods_issue.posted': {
      const gi = String(pick(d, 'gi_no', 'goods_issue_no', 'id') ?? '');
      let last: any = null;
      for (const it of items) {
        const l = await lineFor(it, pickId);
        if (!l || !['picking', 'picked'].includes(l.state)) continue;
        const qty = Number(pick(it, 'qty', 'qty_issued') ?? l.picked_qty ?? l.qty);
        await updLine(l.id, { state: 'issued', gi_no: gi, qty, hpp: pick(it, 'hpp', 'cost', 'value') ?? null });
        last = l;
      }
      await setPickStatus(pickId, 'issued');
      await refreshDoc(last);
      return;
    }
    case 'return.received': {
      const l = await lineFor(d) ?? (d.return_id ? (await db.from('order_lines').select('*').eq('wms_return_id', String(d.return_id)).maybeSingle()).data : null);
      if (!l) return;
      const good = Number(pick(d, 'qty_good', 'good') ?? 0), bad = Number(pick(d, 'qty_quarantine', 'quarantine') ?? 0);
      await updLine(l.id, { state: 'returned', note: `retur diterima: baik ${good}, karantina ${bad}` });
      return;
    }
    case 'stock.received': {
      const skus = Array.isArray(d?.lines) ? d.lines.map((x: any) => x.sku) : [d.sku];
      for (const sku of skus.filter(Boolean)) {
        const { data: bos } = await db.from('order_lines').select('*').eq('sku', sku).eq('state', 'backorder').order('created_at');
        for (const l of bos ?? []) {
          const doc = await docOf(l);
          if (['Selesai', 'Batal', 'Dibatalkan', 'Kedaluwarsa'].includes((doc as any).status)) continue;
          const kind = doc.type === 'SO' ? 'SO' : ((doc as any).estimate === 'approved' ? 'WO' : 'WO_TEMP');
          await reserveLine(l, kind as any);
        }
      }
      return;
    }
    default:
      throw new Error(`Tipe event tidak dikenal: ${type}`);
  }
}

async function webhook(req: Request) {
  if (!WEBHOOK_SECRET || req.headers.get('x-wms-secret') !== WEBHOOK_SECRET) return json({ error: 'unauthorized' }, 401);
  const ev = await req.json();
  const eventId = String(pick(ev, 'event_id', 'id') ?? crypto.randomUUID());
  const type = String(pick(ev, 'type', 'event') ?? '');
  const data = pick(ev, 'data', 'payload') ?? ev;
  const ins = await db.from('wms_events').insert({ event_id: eventId, type, payload: ev });
  if (ins.error) {
    if (ins.error.code !== '23505') throw ins.error;
    const { data: prev } = await db.from('wms_events').select('processed_at').eq('event_id', eventId).single();
    if (prev?.processed_at) return json({ ok: true, duplicate: true });
  }
  try {
    await handleEvent(type, data);
    await db.from('wms_events').update({ processed_at: new Date().toISOString(), error: null }).eq('event_id', eventId);
    return json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.from('wms_events').update({ error: msg }).eq('event_id', eventId);
    return json({ ok: false, error: msg }, 500); // WMS akan mengirim ulang
  }
}

// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (new URL(req.url).searchParams.has('webhook')) return await webhook(req);

    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u, error: ue } = await db.auth.getUser(token);
    if (ue || !u?.user) throw new AppError('Sesi login tidak valid, silakan masuk lagi', 401);
    const { data: prof } = await db.from('profiles').select('*').eq('id', u.user.id).single();
    if (!prof?.active) throw new AppError('Akun belum diaktifkan admin', 403);

    const body = await req.json().catch(() => ({}));
    const fn = actions[body.action];
    if (!fn) throw new AppError(`Aksi tidak dikenal: ${body.action}`);
    return json(await fn(prof as Profile, body));
  } catch (e) {
    if (e instanceof AppError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: e instanceof Error ? e.message : 'Terjadi kesalahan di server' }, 500);
  }
});
