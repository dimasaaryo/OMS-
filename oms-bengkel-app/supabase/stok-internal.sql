-- =====================================================================
-- OMS Bengkel · MODE STOK INTERNAL (tanpa koneksi WMS)
-- Jalankan SETELAH schema.sql: SQL Editor → New query → tempel → Run.
--
-- Stok, bin, reservasi, picking, goods issue, dan retur dikelola di OMS
-- oleh Admin Gudang. Aturan sama dengan PRD:
--   available = on-hand − reserved − karantina
-- Saat WMS siap, ubah WMS_MODE di config.js menjadi 'wms' dan pasang
-- Edge Function; tabel & status di bawah tetap dipakai.
-- =====================================================================

-- ---------- stok per part ----------
alter table public.parts
  add column if not exists bin text,
  add column if not exists min_stock numeric(12,2) not null default 0,
  add column if not exists on_hand numeric(12,2) not null default 0 check (on_hand >= 0),
  add column if not exists quarantine numeric(12,2) not null default 0 check (quarantine >= 0);

-- angka stok hanya boleh berubah lewat fungsi gudang di bawah
revoke insert, update on public.parts from authenticated;
grant insert (sku, name, unit, price, category, active, bin, min_stock) on public.parts to authenticated;
grant update (sku, name, unit, price, category, active, bin, min_stock) on public.parts to authenticated;

create table if not exists public.stock_moves (
  id bigint generated always as identity primary key,
  part_id uuid not null references public.parts(id),
  qty numeric(12,2) not null,
  type text not null check (type in ('receive','issue','return_good','return_quarantine','adjust','short')),
  ref text,
  note text,
  created_by uuid references public.profiles(id) default auth.uid(),
  at timestamptz not null default now()
);
alter table public.stock_moves enable row level security;
create policy "read_active" on public.stock_moves for select to authenticated using (public.is_active_user());

create or replace view public.v_stock with (security_invoker = true) as
select p.*,
       coalesce(r.qty, 0) as reserved,
       p.on_hand - coalesce(r.qty, 0) - p.quarantine as available
from public.parts p
left join (
  select part_id, sum(qty) as qty from public.order_lines
  where state in ('reserved_temp','reserved','picking','picked')
  group by part_id
) r on r.part_id = p.id;

-- ---------- helper internal (tidak bisa dipanggil langsung dari aplikasi) ----------
create or replace function public._reserve(p_line uuid, p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare l public.order_lines; av numeric;
begin
  select * into l from public.order_lines where id = p_line for update;
  perform 1 from public.parts where id = l.part_id for update;   -- antre per part agar tidak rebutan stok
  select available into av from public.v_stock where id = l.part_id;
  if av >= l.qty then
    update public.order_lines
       set state = case when p_kind = 'WO_TEMP' then 'reserved_temp'::public.line_state else 'reserved'::public.line_state end,
           reservation_kind = p_kind, reservation_id = 'INT-' || left(p_line::text, 8), note = null
     where id = p_line;
    return 'ok';
  end if;
  update public.order_lines
     set state = 'backorder', reservation_kind = p_kind, reservation_id = null,
         note = 'stok kurang (available ' || greatest(av, 0) || ')'
   where id = p_line;
  return 'backorder';
end $$;

create or replace function public._release(p_line uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.order_lines set state = 'released', reservation_id = null, note = p_reason where id = p_line;
end $$;

create or replace function public._so_confirm(p_so uuid, p_skip_credit boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; l record; bo int := 0; hrs numeric;
begin
  select * into s from public.v_sales_orders where id = p_so;
  if not found then raise exception 'SO tidak ditemukan'; end if;
  if s.status not in ('Draft','Menunggu approval Finance') then raise exception 'SO sudah dikonfirmasi'; end if;
  if s.top_days > 0 and not p_skip_credit and s.finance_approved_by is null
     and public.customer_ar(s.customer_id) + s.total > s.credit_limit then
    update public.sales_orders set status = 'Menunggu approval Finance' where id = p_so;
    return jsonb_build_object('result', 'finance');
  end if;
  for l in select id from public.order_lines where so_id = p_so and state = 'draft' order by created_at loop
    if public._reserve(l.id, 'SO') = 'backorder' then bo := bo + 1; end if;
  end loop;
  hrs := coalesce(public.setting_num('so_retail_expiry_hours'), 24);
  update public.sales_orders
     set status = 'Dikonfirmasi',
         expires_at = case when s.top_days > 0 then null else now() + make_interval(secs => hrs * 3600) end
   where id = p_so;
  return jsonb_build_object('result', 'confirmed', 'backorder', bo);
end $$;

revoke execute on function public._reserve(uuid, text) from public, anon, authenticated;
revoke execute on function public._release(uuid, text) from public, anon, authenticated;
revoke execute on function public._so_confirm(uuid, boolean) from public, anon, authenticated;

-- ---------- part di WO ----------
create or replace function public.wo_add_part(p_wo uuid, p_part uuid, p_qty numeric) returns text
language plpgsql security definer set search_path = public as $$
declare w public.work_orders; pt public.parts; v_line uuid;
begin
  perform public.require_role(array['sa','kepala_bengkel','mekanik']::public.app_role[]);
  select * into w from public.work_orders where id = p_wo;
  if not found or w.status in ('Siap Ambil','Selesai','Batal') then raise exception 'WO sudah tidak bisa diubah'; end if;
  select * into pt from public.parts where id = p_part and active;
  if not found then raise exception 'Part tidak ditemukan'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Qty tidak valid'; end if;
  insert into public.order_lines (wo_id, part_id, sku, qty, price) values (p_wo, pt.id, pt.sku, p_qty, pt.price) returning id into v_line;
  update public.work_orders
     set estimate = case estimate when 'approved' then 'revisi'::public.estimate_status when 'rejected' then 'draft'::public.estimate_status else estimate end
   where id = p_wo;
  -- tambahan dari mekanik menunggu persetujuan dulu (PRD WO-09)
  if not public.has_role(array['sa','kepala_bengkel']::public.app_role[]) then return 'draft'; end if;
  return public._reserve(v_line, 'WO_TEMP');
end $$;

create or replace function public.line_reserve(p_line uuid) returns text
language plpgsql security definer set search_path = public as $$
declare l public.order_lines; est public.estimate_status;
begin
  perform public.require_role(array['sa','kepala_bengkel','sales_counter']::public.app_role[]);
  select * into l from public.order_lines where id = p_line;
  if not found or l.state not in ('draft','backorder','failed') then raise exception 'Baris ini tidak perlu direservasi'; end if;
  if l.so_id is not null then return public._reserve(p_line, 'SO'); end if;
  select estimate into est from public.work_orders where id = l.wo_id;
  return public._reserve(p_line, case when est = 'approved' then 'WO' else 'WO_TEMP' end);
end $$;

create or replace function public.line_remove(p_line uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l public.order_lines;
begin
  perform public.require_role(array['sa','kepala_bengkel','sales_counter']::public.app_role[]);
  select * into l from public.order_lines where id = p_line;
  if not found then raise exception 'Baris tidak ditemukan'; end if;
  if l.state in ('picking','picked','issued','returning','returned') then raise exception 'Part yang sudah diambil gudang tidak bisa dihapus'; end if;
  if l.wo_id is not null and exists (select 1 from public.work_orders where id = l.wo_id and status in ('Siap Ambil','Selesai','Batal')) then
    raise exception 'WO sudah tidak bisa diubah';
  end if;
  delete from public.order_lines where id = p_line;
end $$;

create or replace function public.line_backorder(p_line uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['sa','kepala_bengkel','sales_counter']::public.app_role[]);
  update public.order_lines set state = 'backorder' where id = p_line and state = 'failed';
end $$;

create or replace function public.wo_estimate_decide(p_wo uuid, p_approved boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare w public.work_orders; l record;
begin
  perform public.require_role(array['sa','kepala_bengkel']::public.app_role[]);
  select * into w from public.work_orders where id = p_wo for update;
  if not found or w.estimate <> 'sent' then raise exception 'Estimasi belum dikirim ke pelanggan'; end if;
  if p_approved then
    for l in select id, state from public.order_lines where wo_id = p_wo and state in ('draft','reserved_temp') loop
      if l.state = 'draft' then perform public._reserve(l.id, 'WO');
      else update public.order_lines set state = 'reserved', reservation_kind = 'WO' where id = l.id; end if;
    end loop;
    update public.work_orders
       set estimate = 'approved', estimate_decided_at = now(), estimate_note = p_note,
           status = case when status = 'Diagnosa' then 'Estimasi disetujui'::public.wo_status else status end
     where id = p_wo;
  else
    for l in select id from public.order_lines where wo_id = p_wo and state in ('draft','queued','reserved_temp','backorder','failed') loop
      perform public._release(l.id, 'estimasi ditolak pelanggan');
    end loop;
    update public.work_orders set estimate = 'rejected', estimate_decided_at = now(), estimate_note = p_note where id = p_wo;
  end if;
end $$;

-- ---------- permintaan ambil barang ----------
create or replace function public.pick_request(p_wo uuid default null, p_so uuid default null) returns text
language plpgsql security definer set search_path = public as $$
declare dest text; s record; v_id uuid; v_no text; n int;
begin
  perform public.require_role(array['sa','kepala_bengkel','sales_counter','mekanik']::public.app_role[]);
  if (p_wo is null) = (p_so is null) then raise exception 'Pilih WO atau SO'; end if;
  if p_wo is not null then
    select coalesce(b.name, 'Bengkel') into dest from public.work_orders w left join public.bays b on b.id = w.bay_id where w.id = p_wo;
  else
    select * into s from public.v_sales_orders where id = p_so;
    if s.status in ('Draft','Menunggu approval Finance','Dibatalkan','Kedaluwarsa') then raise exception 'SO belum bisa diambil'; end if;
    if s.top_days = 0 and s.paid_at is null then raise exception 'Pelanggan retail harus membayar dulu'; end if;
    dest := 'Counter';
  end if;
  select count(*) into n from public.order_lines where (wo_id = p_wo or so_id = p_so) and state = 'reserved';
  if n = 0 then raise exception 'Tidak ada part ter-reservasi yang bisa diambil'; end if;
  insert into public.pick_requests (wo_id, so_id, destination, created_by) values (p_wo, p_so, dest, auth.uid()) returning id, no into v_id, v_no;
  update public.order_lines set state = 'picking', pick_request_id = v_id where (wo_id = p_wo or so_id = p_so) and state = 'reserved';
  if p_so is not null then update public.sales_orders set status = 'Picking' where id = p_so; end if;
  return v_no;
end $$;

create or replace function public.pick_start(p_pick uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['admin_gudang','kepala_bengkel']::public.app_role[]);
  update public.pick_requests set status = 'picking' where id = p_pick and status = 'requested';
end $$;

-- p_actual: {"<line_id>": qty_fisik, ...}; kosong = semua sesuai permintaan
create or replace function public.pick_complete(p_pick uuid, p_actual jsonb default '{}'::jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare l public.order_lines; got numeric; short_lines int := 0; v_no text;
begin
  perform public.require_role(array['admin_gudang','kepala_bengkel']::public.app_role[]);
  select no into v_no from public.pick_requests where id = p_pick and status in ('requested','picking') for update;
  if v_no is null then raise exception 'Tugas picking tidak aktif'; end if;
  for l in select * from public.order_lines where pick_request_id = p_pick and state = 'picking' loop
    got := coalesce((p_actual ->> l.id::text)::numeric, l.qty);
    if got < 0 or got > l.qty then raise exception 'Qty fisik tidak valid untuk %', l.sku; end if;
    if got >= l.qty then
      update public.order_lines set state = 'picked', picked_qty = got where id = l.id;
    else
      short_lines := short_lines + 1;
      -- stok sistem lebih besar dari fisik: koreksi on-hand dan catat untuk cycle count
      update public.parts set on_hand = greatest(on_hand - (l.qty - got), 0) where id = l.part_id;
      insert into public.stock_moves (part_id, qty, type, ref, note) values (l.part_id, -(l.qty - got), 'short', v_no, 'short pick, cek fisik bin');
      if got > 0 then
        update public.order_lines set state = 'picked', picked_qty = got, qty = got, note = 'short pick ' || got || '/' || l.qty where id = l.id;
        insert into public.order_lines (wo_id, so_id, part_id, sku, qty, price, state, note)
        values (l.wo_id, l.so_id, l.part_id, l.sku, l.qty - got, l.price, 'backorder', 'sisa short pick ' || v_no);
      else
        update public.order_lines set state = 'backorder', reservation_id = null, pick_request_id = null, note = 'short pick 0/' || l.qty where id = l.id;
      end if;
    end if;
  end loop;
  update public.pick_requests set status = 'picked' where id = p_pick;
  return short_lines;
end $$;

create or replace function public.goods_issue(p_pick uuid) returns text
language plpgsql security definer set search_path = public as $$
declare pr public.pick_requests; l public.order_lines; v_gi text; q numeric;
begin
  perform public.require_role(array['admin_gudang','kepala_bengkel']::public.app_role[]);
  select * into pr from public.pick_requests where id = p_pick for update;
  if not found or pr.status <> 'picked' then raise exception 'Selesaikan picking dulu'; end if;
  v_gi := public.next_doc_no('GI');
  for l in select * from public.order_lines where pick_request_id = p_pick and state = 'picked' loop
    q := coalesce(l.picked_qty, l.qty);
    update public.parts set on_hand = on_hand - q where id = l.part_id;
    insert into public.stock_moves (part_id, qty, type, ref) values (l.part_id, -q, 'issue', v_gi);
    update public.order_lines set state = 'issued', gi_no = v_gi, qty = q where id = l.id;
  end loop;
  update public.pick_requests set status = 'issued', wms_pick_id = v_gi where id = p_pick;
  if pr.so_id is not null then perform public.refresh_so_status(pr.so_id); end if;
  return v_gi;
end $$;

-- ---------- retur internal (part tidak terpasang) ----------
create or replace function public.internal_return(p_line uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['mekanik','sa','kepala_bengkel']::public.app_role[]);
  update public.order_lines set state = 'returning', note = 'dikembalikan ke gudang: tidak terpasang'
   where id = p_line and wo_id is not null and state = 'issued';
  if not found then raise exception 'Hanya part WO yang sudah di-issue yang bisa diretur'; end if;
end $$;

create or replace function public.return_receive(p_line uuid, p_good boolean) returns void
language plpgsql security definer set search_path = public as $$
declare l public.order_lines; v_no text;
begin
  perform public.require_role(array['admin_gudang','kepala_bengkel']::public.app_role[]);
  select * into l from public.order_lines where id = p_line and state = 'returning' for update;
  if not found then raise exception 'Retur tidak ditemukan'; end if;
  select no into v_no from public.work_orders where id = l.wo_id;
  update public.parts set on_hand = on_hand + l.qty, quarantine = quarantine + case when p_good then 0 else l.qty end where id = l.part_id;
  insert into public.stock_moves (part_id, qty, type, ref) values (l.part_id, l.qty, case when p_good then 'return_good' else 'return_quarantine' end, v_no);
  update public.order_lines set state = 'returned', note = case when p_good then 'retur diterima, kondisi baik' else 'retur diterima, dikarantina' end where id = p_line;
end $$;

-- ---------- penerimaan barang & stock opname ----------
create or replace function public.stock_receive(p_part uuid, p_qty numeric, p_ref text default null) returns int
language plpgsql security definer set search_path = public as $$
declare l record; filled int := 0; kind text; st text;
begin
  perform public.require_role(array['admin_gudang','kepala_bengkel']::public.app_role[]);
  if p_qty is null or p_qty <= 0 then raise exception 'Qty tidak valid'; end if;
  update public.parts set on_hand = on_hand + p_qty where id = p_part;
  if not found then raise exception 'Part tidak ditemukan'; end if;
  insert into public.stock_moves (part_id, qty, type, ref) values (p_part, p_qty, 'receive', p_ref);
  -- isi backorder FIFO (prioritas WO vs SO masih pertanyaan terbuka di PRD)
  for l in
    select ol.id, ol.so_id, w.estimate, coalesce(w.status::text, s.status::text) as doc_status
      from public.order_lines ol
      left join public.work_orders w on w.id = ol.wo_id
      left join public.sales_orders s on s.id = ol.so_id
     where ol.part_id = p_part and ol.state = 'backorder'
     order by ol.created_at
  loop
    if l.doc_status in ('Selesai','Batal','Dibatalkan','Kedaluwarsa') then continue; end if;
    kind := case when l.so_id is not null then 'SO' when l.estimate = 'approved' then 'WO' else 'WO_TEMP' end;
    st := public._reserve(l.id, kind);
    if st = 'ok' then filled := filled + 1; end if;
  end loop;
  return filled;
end $$;

create or replace function public.stock_adjust(p_part uuid, p_on_hand numeric, p_quarantine numeric, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare pt public.parts;
begin
  perform public.require_role(array['admin_gudang','kepala_bengkel']::public.app_role[]);
  if p_on_hand < 0 or p_quarantine < 0 or p_quarantine > p_on_hand then raise exception 'Angka stok tidak valid'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Isi alasan penyesuaian (mis. stock opname)'; end if;
  select * into pt from public.parts where id = p_part for update;
  if not found then raise exception 'Part tidak ditemukan'; end if;
  update public.parts set on_hand = p_on_hand, quarantine = p_quarantine where id = p_part;
  insert into public.stock_moves (part_id, qty, type, note)
  values (p_part, p_on_hand - pt.on_hand, 'adjust', p_note || ' · karantina ' || pt.quarantine || ' → ' || p_quarantine);
end $$;

-- ---------- sales order ----------
create or replace function public.so_confirm(p_so uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['sales_counter','kepala_bengkel']::public.app_role[]);
  return public._so_confirm(p_so, false);
end $$;

create or replace function public.so_finance_approve(p_so uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['kasir']::public.app_role[]);
  update public.sales_orders set finance_approved_by = auth.uid() where id = p_so and status = 'Menunggu approval Finance';
  if not found then raise exception 'SO tidak menunggu approval Finance'; end if;
  return public._so_confirm(p_so, true);
end $$;

create or replace function public.so_cancel(p_so uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  perform public.require_role(array['sales_counter','kepala_bengkel']::public.app_role[]);
  if exists (select 1 from public.order_lines where so_id = p_so and state in ('picking','picked','issued')) then
    raise exception 'Barang sudah diproses gudang; gunakan retur penjualan';
  end if;
  for l in select id from public.order_lines where so_id = p_so and state <> 'released' loop
    perform public._release(l.id, 'SO dibatalkan');
  end loop;
  update public.pick_requests set status = 'cancelled' where so_id = p_so and status in ('requested','picking');
  update public.sales_orders set status = 'Dibatalkan' where id = p_so;
end $$;

-- ---------- kedaluwarsa reservasi (dipanggil aplikasi tiap 5 menit) ----------
create or replace function public.expire_reservations() returns jsonb
language plpgsql security definer set search_path = public as $$
declare s record; l record; n_so int := 0; n_wo int := 0; hrs numeric;
begin
  if not public.is_active_user() then raise exception 'Akses ditolak'; end if;
  for s in select id from public.v_sales_orders where status = 'Dikonfirmasi' and paid_at is null and top_days = 0 and expires_at < now() loop
    for l in select id from public.order_lines where so_id = s.id and state not in ('released') loop
      perform public._release(l.id, 'SO retail kedaluwarsa, belum dibayar');
    end loop;
    update public.sales_orders set status = 'Kedaluwarsa' where id = s.id;
    n_so := n_so + 1;
  end loop;
  hrs := coalesce(public.setting_num('wo_temp_reservation_hours'), 4);
  for l in
    select ol.id from public.order_lines ol join public.work_orders w on w.id = ol.wo_id
     where ol.state = 'reserved_temp' and w.estimate <> 'approved' and ol.updated_at < now() - make_interval(secs => hrs * 3600)
  loop
    perform public._release(l.id, 'reservasi sementara lewat ' || hrs || ' jam tanpa persetujuan');
    n_wo := n_wo + 1;
  end loop;
  return jsonb_build_object('so_expired', n_so, 'wo_temp_released', n_wo);
end $$;

-- layar gudang ikut ter-update otomatis
alter publication supabase_realtime add table public.parts;
