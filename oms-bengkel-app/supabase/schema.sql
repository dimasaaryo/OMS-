-- =====================================================================
-- OMS Bengkel · skema database (Supabase / PostgreSQL 15)
-- Jalankan SEKALI di Supabase → SQL Editor → New query → tempel → Run.
-- Pengguna pertama yang mendaftar otomatis menjadi admin aktif.
-- =====================================================================
-- ---------- tipe ----------
create type public.app_role as enum ('admin','kepala_bengkel','sa','mekanik','sales_counter','admin_gudang','kasir');
create type public.wo_status as enum ('Antre','Diagnosa','Estimasi disetujui','Tunggu Part','Dikerjakan','QC','Siap Ambil','Selesai','Batal');
create type public.estimate_status as enum ('draft','sent','approved','rejected','revisi');
create type public.line_state as enum ('draft','queued','reserved_temp','reserved','backorder','failed','picking','picked','issued','returning','returned','released');
create type public.so_status as enum ('Draft','Menunggu approval Finance','Dikonfirmasi','Dibayar','Picking','Siap invoice','Invoiced sebagian','Invoiced','Dibatalkan','Kedaluwarsa');
create type public.customer_type as enum ('servis','retail','b2b','mitra');

-- ---------- pengguna & peran ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text not null default '',
  role public.app_role not null default 'sa',
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  select not exists (select 1 from public.profiles) into first_user;
  insert into public.profiles (id, email, full_name, role, active)
  values (new.id, new.email,
          coalesce(nullif(new.raw_user_meta_data->>'full_name',''), split_part(new.email,'@',1)),
          case when first_user then 'admin'::public.app_role else 'sa'::public.app_role end,
          first_user);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active)
$$;
create or replace function public.has_role(roles public.app_role[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'admin' or p.role = any(roles)
                   from public.profiles p where p.id = auth.uid() and p.active), false)
$$;
create or replace function public.require_role(roles public.app_role[]) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role(roles) then
    raise exception 'Akses ditolak: peran Anda tidak boleh melakukan aksi ini' using errcode = '42501';
  end if;
end $$;

-- ---------- pengaturan ----------
create table public.app_settings (
  key text primary key,
  value jsonb not null,
  label text,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value, label) values
  ('workshop_name', '"Bengkel"', 'Nama bengkel (tampil di aplikasi & invoice)'),
  ('workshop_address', '""', 'Alamat bengkel (tampil di invoice)'),
  ('sa_discount_limit_pct', '5', 'Batas diskon SA tanpa approval Kepala Bengkel (%)'),
  ('wo_temp_reservation_hours', '4', 'Lama reservasi sementara WO menunggu persetujuan estimasi (jam)'),
  ('so_retail_expiry_hours', '24', 'Kedaluwarsa reservasi SO retail yang belum dibayar (jam)');

create or replace function public.setting_num(p_key text) returns numeric
language sql stable security definer set search_path = public as $$
  select (value #>> '{}')::numeric from public.app_settings where key = p_key
$$;

-- ---------- nomor dokumen ----------
create table public.doc_counters (
  prefix text not null, period text not null, last int not null,
  primary key (prefix, period)
);
create or replace function public.next_doc_no(p text) returns text
language plpgsql security definer set search_path = public as $$
declare per text := to_char(now() at time zone 'Asia/Jakarta', 'YYMM'); n int;
begin
  insert into public.doc_counters values (p, per, 1)
  on conflict (prefix, period) do update set last = public.doc_counters.last + 1
  returning last into n;
  return p || '-' || per || '-' || lpad(n::text, 4, '0');
end $$;

-- ---------- master data ----------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  type public.customer_type not null default 'servis',
  top_days int not null default 0 check (top_days >= 0),
  credit_limit numeric(14,0) not null default 0 check (credit_limit >= 0),
  address text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  plate text not null,
  plate_key text generated always as (upper(regexp_replace(plate, '\s', '', 'g'))) stored unique,
  model text,
  year int,
  customer_id uuid references public.customers(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.labor_rates (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  price numeric(14,0) not null check (price >= 0),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.parts (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,               -- harus sama persis dengan SKU di WMS (satu SKU = satu kode)
  name text not null,
  unit text not null default 'pcs',
  price numeric(14,0) not null default 0 check (price >= 0),
  category text not null default 'part' check (category in ('part','oli')),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.bays (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort int not null default 0,
  active boolean not null default true
);

-- ---------- work order ----------
create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  no text not null unique default public.next_doc_no('WO'),
  vehicle_id uuid not null references public.vehicles(id),
  customer_id uuid not null references public.customers(id),
  complaint text not null,
  odometer int,
  fuel_level smallint check (fuel_level between 0 and 4),
  equipment text[] not null default '{}',
  existing_damage text,
  photos text[] not null default '{}' check (cardinality(photos) >= 4),
  diagnosis text,
  mechanic_id uuid references public.profiles(id),
  bay_id uuid references public.bays(id),
  status public.wo_status not null default 'Antre',
  estimate public.estimate_status not null default 'draft',
  estimate_sent_at timestamptz,
  estimate_decided_at timestamptz,
  estimate_note text,
  discount numeric(14,0) not null default 0 check (discount >= 0),
  discount_requested numeric(14,0),
  discount_approved_by uuid references public.profiles(id),
  eta timestamptz,
  ready_at timestamptz,
  closed_at timestamptz,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.wo_status_log (
  id bigint generated always as identity primary key,
  wo_id uuid not null references public.work_orders(id) on delete cascade,
  status public.wo_status not null,
  changed_by uuid references public.profiles(id),
  at timestamptz not null default now()
);
create table public.wo_labor (
  id uuid primary key default gen_random_uuid(),
  wo_id uuid not null references public.work_orders(id) on delete cascade,
  labor_rate_id uuid references public.labor_rates(id),
  name text not null,
  price numeric(14,0) not null check (price >= 0),
  created_at timestamptz not null default now()
);

-- ---------- penjualan eksternal ----------
create table public.sales_orders (
  id uuid primary key default gen_random_uuid(),
  no text not null unique default public.next_doc_no('SO'),
  customer_id uuid not null references public.customers(id),
  status public.so_status not null default 'Draft',
  finance_approved_by uuid references public.profiles(id),
  paid_at timestamptz,
  proforma_no text,
  payment_method text,
  payment_ref text,
  expires_at timestamptz,
  note text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- invoice & pembayaran ----------
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  no text not null unique default public.next_doc_no('INV'),
  wo_id uuid references public.work_orders(id),
  so_id uuid references public.sales_orders(id),
  customer_id uuid not null references public.customers(id),
  subtotal numeric(14,0) not null,
  discount numeric(14,0) not null default 0,
  total numeric(14,0) not null,
  due_date date not null default current_date,
  status text not null default 'unpaid' check (status in ('unpaid','paid','void')),
  paid_at timestamptz,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  check ((wo_id is null) <> (so_id is null))
);
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  amount numeric(14,0) not null check (amount > 0),
  method text not null,
  ref text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now()
);

-- ---------- pengambilan barang ----------
create table public.pick_requests (
  id uuid primary key default gen_random_uuid(),
  no text not null unique default public.next_doc_no('PK'),
  wms_pick_id text,
  wo_id uuid references public.work_orders(id),
  so_id uuid references public.sales_orders(id),
  destination text not null,
  status text not null default 'requested' check (status in ('requested','picking','picked','issued','cancelled')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- baris part (WO & SO) ----------
create table public.order_lines (
  id uuid primary key default gen_random_uuid(),
  wo_id uuid references public.work_orders(id) on delete cascade,
  so_id uuid references public.sales_orders(id) on delete cascade,
  part_id uuid not null references public.parts(id),
  sku text not null,
  qty numeric(12,2) not null check (qty > 0),
  price numeric(14,0) not null,
  state public.line_state not null default 'draft',
  reservation_id text,
  reservation_kind text check (reservation_kind in ('WO_TEMP','WO','SO')),
  pick_request_id uuid references public.pick_requests(id),
  picked_qty numeric(12,2),
  gi_no text,
  hpp numeric(14,0),
  wms_return_id text,
  invoice_id uuid references public.invoices(id),
  note text,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((wo_id is null) <> (so_id is null))
);
create index on public.order_lines (reservation_id);
create index on public.order_lines (sku, state);
create index on public.order_lines (wo_id);
create index on public.order_lines (so_id);

-- ---------- integrasi WMS ----------
create table public.wms_outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                 -- reservation | reservation_patch | reservation_delete | pick_request | internal_return
  method text not null,
  path text not null,
  body jsonb,
  idem_key text not null unique,
  line_id uuid,
  doc_no text,
  status text not null default 'sending' check (status in ('sending','sent','rejected','pending','failed','cancelled')),
  http_status int,
  attempts int not null default 0,
  last_error text,
  response jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on public.wms_outbox (status, created_at);
create table public.wms_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);

-- ---------- audit trail ----------
create table public.audit_log (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_id uuid,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  changed_by uuid,
  at timestamptz not null default now()
);

-- ---------- trigger umum ----------
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public.audit_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log(table_name, row_id, action, new_data, changed_by) values (tg_table_name, new.id, tg_op, to_jsonb(new), auth.uid());
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_log(table_name, row_id, action, old_data, new_data, changed_by) values (tg_table_name, new.id, tg_op, to_jsonb(old), to_jsonb(new), auth.uid());
    return new;
  else
    insert into public.audit_log(table_name, row_id, action, old_data, changed_by) values (tg_table_name, old.id, tg_op, to_jsonb(old), auth.uid());
    return old;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['customers','vehicles','labor_rates','parts','work_orders','sales_orders','pick_requests','order_lines'] loop
    execute format('create trigger touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at()', t);
  end loop;
  foreach t in array array['customers','vehicles','labor_rates','parts','work_orders','wo_labor','sales_orders','order_lines','invoices','payments'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function public.audit_trigger()', t);
  end loop;
end $$;

create or replace function public.log_wo_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.wo_status_log (wo_id, status, changed_by) values (new.id, new.status, auth.uid());
  end if;
  return new;
end $$;
create trigger wo_status_log after insert or update of status on public.work_orders
  for each row execute function public.log_wo_status();

-- ---------- view ----------
create or replace view public.v_work_orders with (security_invoker = true) as
select w.*,
       v.plate, v.model, v.year,
       c.name as customer_name, c.phone as customer_phone,
       m.full_name as mechanic_name,
       b.name as bay_name,
       coalesce((select sum(l.price) from public.wo_labor l where l.wo_id = w.id), 0) as labor_total,
       coalesce((select sum(ol.qty * ol.price) from public.order_lines ol where ol.wo_id = w.id and ol.state not in ('released','returned')), 0) as parts_total,
       (select i.no from public.invoices i where i.wo_id = w.id and i.status <> 'void' limit 1) as invoice_no
from public.work_orders w
join public.vehicles v on v.id = w.vehicle_id
join public.customers c on c.id = w.customer_id
left join public.profiles m on m.id = w.mechanic_id
left join public.bays b on b.id = w.bay_id;

create or replace view public.v_sales_orders with (security_invoker = true) as
select s.*, c.name as customer_name, c.type as customer_type, c.top_days, c.credit_limit,
       coalesce((select sum(ol.qty * ol.price) from public.order_lines ol where ol.so_id = s.id and ol.state <> 'released'), 0) as total
from public.sales_orders s
join public.customers c on c.id = s.customer_id;

create or replace view public.v_invoices with (security_invoker = true) as
select i.*, c.name as customer_name, c.phone as customer_phone,
       coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0) as paid_amount,
       coalesce(w.no, s.no) as doc_no
from public.invoices i
join public.customers c on c.id = i.customer_id
left join public.work_orders w on w.id = i.wo_id
left join public.sales_orders s on s.id = i.so_id;

create or replace function public.customer_ar(p_customer uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(i.total - coalesce((select sum(p.amount) from public.payments p where p.invoice_id = i.id), 0)), 0)
  from public.invoices i where i.customer_id = p_customer and i.status = 'unpaid'
$$;

-- =====================================================================
-- RPC (aturan bisnis; peran dicek di setiap fungsi)
-- =====================================================================

-- Check-in: buat WO (pelanggan & kendaraan baru otomatis disimpan)
create or replace function public.create_work_order(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_cust uuid; v_veh uuid; v_wo uuid;
        v_plate text := upper(regexp_replace(trim(coalesce(p->>'plate','')), '\s+', ' ', 'g'));
begin
  perform public.require_role(array['sa','kepala_bengkel']::public.app_role[]);
  if v_plate = '' then raise exception 'Nomor polisi wajib diisi'; end if;
  if coalesce(trim(p->>'complaint'), '') = '' then raise exception 'Keluhan pelanggan wajib diisi'; end if;
  if jsonb_array_length(coalesce(p->'photos', '[]'::jsonb)) < 4 then raise exception 'Foto 4 sisi kendaraan wajib sebelum WO dibuat'; end if;

  select id, customer_id into v_veh, v_cust from public.vehicles where plate_key = upper(regexp_replace(v_plate, '\s', '', 'g'));
  if v_cust is null then
    if coalesce(trim(p->>'customer_name'), '') = '' then raise exception 'Nama pelanggan wajib untuk kendaraan baru'; end if;
    insert into public.customers (name, phone, type) values (trim(p->>'customer_name'), nullif(trim(p->>'customer_phone'), ''), 'servis')
    returning id into v_cust;
  end if;
  if v_veh is null then
    insert into public.vehicles (plate, model, year, customer_id)
    values (v_plate, nullif(trim(p->>'model'), ''), nullif(p->>'year', '')::int, v_cust) returning id into v_veh;
  else
    update public.vehicles set customer_id = v_cust where id = v_veh and customer_id is null;
  end if;

  insert into public.work_orders (vehicle_id, customer_id, complaint, odometer, fuel_level, equipment, existing_damage, photos, eta)
  values (v_veh, v_cust, trim(p->>'complaint'),
          nullif(regexp_replace(coalesce(p->>'odometer', ''), '\D', '', 'g'), '')::int,
          nullif(p->>'fuel_level', '')::smallint,
          coalesce(array(select jsonb_array_elements_text(p->'equipment')), '{}'),
          nullif(trim(p->>'existing_damage'), ''),
          array(select jsonb_array_elements_text(p->'photos')),
          nullif(p->>'eta', '')::timestamptz)
  returning id into v_wo;
  return v_wo;
end $$;

create or replace function public.wo_assign(p_wo uuid, p_mechanic uuid, p_bay uuid) returns void
language plpgsql security definer set search_path = public as $$
declare clash text;
begin
  perform public.require_role(array['kepala_bengkel','sa']::public.app_role[]);
  if not exists (select 1 from public.profiles where id = p_mechanic and role = 'mekanik' and active) then
    raise exception 'Mekanik tidak valid';
  end if;
  select no into clash from public.work_orders
   where bay_id = p_bay and id <> p_wo and status not in ('Siap Ambil','Selesai','Batal') limit 1;
  if clash is not null then raise exception 'Bay sedang dipakai %', clash; end if;
  update public.work_orders set mechanic_id = p_mechanic, bay_id = p_bay
   where id = p_wo and status not in ('Selesai','Batal');
end $$;

create or replace function public.wo_set_diagnosis(p_wo uuid, p_text text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['mekanik','sa','kepala_bengkel']::public.app_role[]);
  update public.work_orders set diagnosis = p_text where id = p_wo and status not in ('Selesai','Batal');
end $$;

create or replace function public.wo_add_labor(p_wo uuid, p_rate uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.labor_rates;
begin
  perform public.require_role(array['sa','kepala_bengkel','mekanik']::public.app_role[]);
  select * into r from public.labor_rates where id = p_rate and active;
  if not found then raise exception 'Jasa tidak ditemukan'; end if;
  if exists (select 1 from public.work_orders where id = p_wo and status in ('Selesai','Batal','Siap Ambil')) then
    raise exception 'WO sudah tidak bisa diubah';
  end if;
  insert into public.wo_labor (wo_id, labor_rate_id, name, price) values (p_wo, r.id, r.name, r.price);
  update public.work_orders set estimate = case estimate when 'approved' then 'revisi'::public.estimate_status when 'rejected' then 'draft'::public.estimate_status else estimate end
   where id = p_wo;
end $$;

create or replace function public.wo_remove_labor(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['sa','kepala_bengkel']::public.app_role[]);
  delete from public.wo_labor l using public.work_orders w
   where l.id = p_id and w.id = l.wo_id and w.status not in ('Selesai','Batal','Siap Ambil');
end $$;

create or replace function public.wo_send_estimate(p_wo uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['sa','kepala_bengkel']::public.app_role[]);
  if not exists (select 1 from public.wo_labor where wo_id = p_wo) and not exists (select 1 from public.order_lines where wo_id = p_wo and state <> 'released') then
    raise exception 'Tambahkan jasa atau part sebelum mengirim estimasi';
  end if;
  update public.work_orders set estimate = 'sent', estimate_sent_at = now() where id = p_wo and status not in ('Selesai','Batal');
end $$;

create or replace function public.wo_set_discount(p_wo uuid, p_amount numeric) returns text
language plpgsql security definer set search_path = public as $$
declare sub numeric; lim numeric;
begin
  perform public.require_role(array['sa','kepala_bengkel']::public.app_role[]);
  select labor_total + parts_total into sub from public.v_work_orders where id = p_wo;
  if p_amount < 0 or p_amount > sub then raise exception 'Diskon tidak valid'; end if;
  lim := coalesce(public.setting_num('sa_discount_limit_pct'), 0);
  if p_amount > sub * lim / 100 and not public.has_role(array['kepala_bengkel']::public.app_role[]) then
    update public.work_orders set discount_requested = p_amount where id = p_wo;
    return 'pending';
  end if;
  update public.work_orders
     set discount = p_amount, discount_requested = null,
         discount_approved_by = case when p_amount > sub * lim / 100 then auth.uid() else null end
   where id = p_wo;
  return 'ok';
end $$;

create or replace function public.wo_approve_discount(p_wo uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['kepala_bengkel']::public.app_role[]);
  if p_approve then
    update public.work_orders set discount = discount_requested, discount_requested = null, discount_approved_by = auth.uid()
     where id = p_wo and discount_requested is not null;
  else
    update public.work_orders set discount_requested = null where id = p_wo;
  end if;
end $$;

-- Maju ke status berikutnya dengan penjagaan aturan PRD
create or replace function public.wo_advance(p_wo uuid) returns public.wo_status
language plpgsql security definer set search_path = public as $$
declare w public.work_orders; blocking boolean; pending boolean; returning_ boolean; nxt public.wo_status;
begin
  select * into w from public.work_orders where id = p_wo for update;
  if not found then raise exception 'WO tidak ditemukan'; end if;
  if public.has_role(array['mekanik']::public.app_role[]) and not public.has_role(array['sa','kepala_bengkel','kasir']::public.app_role[])
     and w.mechanic_id is distinct from auth.uid() then
    raise exception 'WO ini tidak ditugaskan ke Anda';
  end if;
  select exists (select 1 from public.order_lines where wo_id = p_wo and state in ('draft','queued','backorder','failed')) into blocking;
  select exists (select 1 from public.order_lines where wo_id = p_wo and state not in ('issued','returning','returned','released')) into pending;
  select exists (select 1 from public.order_lines where wo_id = p_wo and state = 'returning') into returning_;

  case w.status
    when 'Antre' then
      perform public.require_role(array['sa','kepala_bengkel','mekanik']::public.app_role[]);
      if w.mechanic_id is null or w.bay_id is null then raise exception 'Tugaskan mekanik dan bay dulu'; end if;
      nxt := 'Diagnosa';
    when 'Diagnosa' then
      perform public.require_role(array['sa','kepala_bengkel']::public.app_role[]);
      if w.estimate <> 'approved' then raise exception 'Estimasi harus disetujui pelanggan dulu'; end if;
      nxt := 'Estimasi disetujui';
    when 'Estimasi disetujui', 'Tunggu Part' then
      perform public.require_role(array['sa','kepala_bengkel','mekanik']::public.app_role[]);
      if w.estimate <> 'approved' then raise exception 'Ada estimasi yang belum disetujui pelanggan'; end if;
      if blocking then
        if w.status = 'Tunggu Part' then raise exception 'Masih ada part backorder atau reservasi yang belum berhasil'; end if;
        nxt := 'Tunggu Part';
      else
        nxt := 'Dikerjakan';
      end if;
    when 'Dikerjakan' then
      perform public.require_role(array['mekanik','sa','kepala_bengkel']::public.app_role[]);
      if w.estimate <> 'approved' then raise exception 'Tambahan pekerjaan belum disetujui pelanggan'; end if;
      if pending then raise exception 'Semua part harus sudah diserahkan gudang (goods issue) sebelum QC'; end if;
      nxt := 'QC';
    when 'QC' then
      perform public.require_role(array['kepala_bengkel']::public.app_role[]);
      if returning_ then raise exception 'Tunggu retur internal diterima gudang'; end if;
      nxt := 'Siap Ambil';
    when 'Siap Ambil' then
      perform public.require_role(array['kasir','sa','kepala_bengkel']::public.app_role[]);
      if not exists (select 1 from public.invoices where wo_id = p_wo and status <> 'void') then raise exception 'Terbitkan invoice dulu'; end if;
      nxt := 'Selesai';
    else
      raise exception 'WO sudah ditutup';
  end case;

  update public.work_orders
     set status = nxt,
         ready_at = case when nxt = 'Siap Ambil' then now() else ready_at end,
         closed_at = case when nxt = 'Selesai' then now() else closed_at end
   where id = p_wo;
  return nxt;
end $$;

create or replace function public.issue_invoice_wo(p_wo uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare w record; v_id uuid;
begin
  perform public.require_role(array['kasir','sa','kepala_bengkel']::public.app_role[]);
  select * into w from public.v_work_orders where id = p_wo;
  if not found then raise exception 'WO tidak ditemukan'; end if;
  if w.status <> 'Siap Ambil' then raise exception 'Invoice WO terbit setelah QC lulus (status Siap Ambil)'; end if;
  if exists (select 1 from public.invoices where wo_id = p_wo and status <> 'void') then raise exception 'Invoice WO ini sudah ada'; end if;
  if exists (select 1 from public.order_lines where wo_id = p_wo and state not in ('issued','released','returned')) then
    raise exception 'Masih ada part yang belum goods issue atau retur yang belum selesai';
  end if;
  insert into public.invoices (wo_id, customer_id, subtotal, discount, total, due_date)
  values (p_wo, w.customer_id, w.labor_total + w.parts_total, w.discount, w.labor_total + w.parts_total - w.discount, current_date)
  returning id into v_id;
  update public.order_lines set invoice_id = v_id where wo_id = p_wo and state = 'issued';
  return v_id;
end $$;

create or replace function public.create_sales_order(p_customer uuid, p_lines jsonb, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_so uuid; l jsonb; pt public.parts;
begin
  perform public.require_role(array['sales_counter','kepala_bengkel']::public.app_role[]);
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then raise exception 'Tambahkan minimal satu part'; end if;
  insert into public.sales_orders (customer_id, note) values (p_customer, p_note) returning id into v_so;
  for l in select * from jsonb_array_elements(p_lines) loop
    select * into pt from public.parts where id = (l->>'part_id')::uuid and active;
    if not found then raise exception 'Part tidak ditemukan'; end if;
    insert into public.order_lines (so_id, part_id, sku, qty, price) values (v_so, pt.id, pt.sku, (l->>'qty')::numeric, pt.price);
  end loop;
  return v_so;
end $$;

create or replace function public.so_pay(p_so uuid, p_method text, p_ref text) returns text
language plpgsql security definer set search_path = public as $$
declare s record; v_pf text;
begin
  perform public.require_role(array['sales_counter','kasir']::public.app_role[]);
  select * into s from public.v_sales_orders where id = p_so;
  if s.top_days > 0 then raise exception 'Pelanggan TOP dibayar lewat invoice, bukan proforma'; end if;
  if s.status <> 'Dikonfirmasi' then raise exception 'SO harus berstatus Dikonfirmasi'; end if;
  v_pf := public.next_doc_no('PF');
  update public.sales_orders set paid_at = now(), proforma_no = v_pf, payment_method = p_method, payment_ref = p_ref, status = 'Dibayar', expires_at = null
   where id = p_so;
  return v_pf;
end $$;

create or replace function public.refresh_so_status(p_so uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.sales_orders; n_live int; n_inv int; n_ready int; n_pick int;
begin
  select * into s from public.sales_orders where id = p_so;
  if not found or s.status in ('Draft','Menunggu approval Finance','Dibatalkan','Kedaluwarsa') then return; end if;
  select count(*) filter (where state <> 'released'),
         count(*) filter (where state <> 'released' and invoice_id is not null),
         count(*) filter (where state = 'issued' and invoice_id is null),
         count(*) filter (where state in ('picking','picked'))
    into n_live, n_inv, n_ready, n_pick
    from public.order_lines where so_id = p_so;
  update public.sales_orders set status =
    case when n_live > 0 and n_inv = n_live then 'Invoiced'::public.so_status
         when n_ready > 0 then 'Siap invoice'::public.so_status
         when n_pick > 0 then 'Picking'::public.so_status
         when n_inv > 0 then 'Invoiced sebagian'::public.so_status
         else status end
  where id = p_so;
end $$;

create or replace function public.issue_invoice_so(p_so uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare s record; v_total numeric; v_id uuid;
begin
  perform public.require_role(array['kasir','sales_counter','kepala_bengkel']::public.app_role[]);
  select * into s from public.v_sales_orders where id = p_so;
  select coalesce(sum(qty * price), 0) into v_total from public.order_lines where so_id = p_so and state = 'issued' and invoice_id is null;
  if v_total = 0 then raise exception 'Invoice baru bisa terbit setelah barang diserahkan gudang (goods issue)'; end if;
  insert into public.invoices (so_id, customer_id, subtotal, total, due_date, status, paid_at)
  values (p_so, s.customer_id, v_total, v_total, current_date + s.top_days,
          case when s.top_days = 0 and s.paid_at is not null then 'paid' else 'unpaid' end,
          case when s.top_days = 0 and s.paid_at is not null then now() end)
  returning id into v_id;
  if s.top_days = 0 and s.paid_at is not null then
    insert into public.payments (invoice_id, amount, method, ref) values (v_id, v_total, coalesce(s.payment_method, 'tunai'), s.proforma_no);
  end if;
  update public.order_lines set invoice_id = v_id where so_id = p_so and state = 'issued' and invoice_id is null;
  perform public.refresh_so_status(p_so);
  return v_id;
end $$;

create or replace function public.record_payment(p_invoice uuid, p_amount numeric, p_method text, p_ref text) returns void
language plpgsql security definer set search_path = public as $$
declare i record;
begin
  perform public.require_role(array['kasir']::public.app_role[]);
  select * into i from public.v_invoices where id = p_invoice;
  if not found or i.status <> 'unpaid' then raise exception 'Invoice tidak bisa dibayar'; end if;
  if p_amount <= 0 or p_amount > i.total - i.paid_amount then raise exception 'Nominal melebihi sisa tagihan'; end if;
  insert into public.payments (invoice_id, amount, method, ref) values (p_invoice, p_amount, p_method, p_ref);
  if i.paid_amount + p_amount >= i.total then
    update public.invoices set status = 'paid', paid_at = now() where id = p_invoice;
  end if;
end $$;

create or replace function public.set_user(p_user uuid, p_role public.app_role, p_active boolean, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role(array['admin']::public.app_role[]);
  if p_user = auth.uid() and (not p_active or p_role <> 'admin') then raise exception 'Tidak bisa menonaktifkan atau menurunkan akun admin Anda sendiri'; end if;
  update public.profiles set role = p_role, active = p_active, full_name = coalesce(nullif(trim(p_name), ''), full_name) where id = p_user;
end $$;

-- =====================================================================
-- Row Level Security: semua pengguna aktif boleh membaca;
-- perubahan dokumen transaksi hanya lewat RPC di atas / Edge Function.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['profiles','app_settings','doc_counters','customers','vehicles','labor_rates','parts','bays','work_orders','wo_status_log','wo_labor','sales_orders','invoices','payments','pick_requests','order_lines','wms_outbox','wms_events','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  foreach t in array array['app_settings','customers','vehicles','labor_rates','parts','bays','work_orders','wo_status_log','wo_labor','sales_orders','invoices','payments','pick_requests','order_lines','wms_outbox','wms_events'] loop
    execute format('create policy "read_active" on public.%I for select to authenticated using (public.is_active_user())', t);
  end loop;
end $$;

create policy "read_self_or_active" on public.profiles for select to authenticated using (id = auth.uid() or public.is_active_user());
create policy "read_audit" on public.audit_log for select to authenticated using (public.has_role(array['kepala_bengkel']::public.app_role[]));

create policy "write_customers" on public.customers for all to authenticated
  using (public.has_role(array['sa','sales_counter','kepala_bengkel','kasir']::public.app_role[]))
  with check (public.has_role(array['sa','sales_counter','kepala_bengkel','kasir']::public.app_role[]));
create policy "write_vehicles" on public.vehicles for all to authenticated
  using (public.has_role(array['sa','kepala_bengkel']::public.app_role[]))
  with check (public.has_role(array['sa','kepala_bengkel']::public.app_role[]));
create policy "write_labor" on public.labor_rates for all to authenticated
  using (public.has_role(array['kepala_bengkel']::public.app_role[]))
  with check (public.has_role(array['kepala_bengkel']::public.app_role[]));
create policy "write_parts" on public.parts for all to authenticated
  using (public.has_role(array['kepala_bengkel','admin_gudang']::public.app_role[]))
  with check (public.has_role(array['kepala_bengkel','admin_gudang']::public.app_role[]));
create policy "write_bays" on public.bays for all to authenticated
  using (public.has_role(array['kepala_bengkel']::public.app_role[]))
  with check (public.has_role(array['kepala_bengkel']::public.app_role[]));
create policy "write_settings" on public.app_settings for update to authenticated
  using (public.has_role(array['admin']::public.app_role[]))
  with check (public.has_role(array['admin']::public.app_role[]));

-- ---------- storage foto check-in ----------
insert into storage.buckets (id, name, public) values ('checkin', 'checkin', false) on conflict (id) do nothing;
create policy "checkin_read" on storage.objects for select to authenticated
  using (bucket_id = 'checkin' and public.is_active_user());
create policy "checkin_upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'checkin' and public.has_role(array['sa','kepala_bengkel']::public.app_role[]));

-- ---------- realtime (dashboard & layar lain ter-update otomatis) ----------
alter publication supabase_realtime add table public.work_orders, public.order_lines, public.sales_orders, public.invoices, public.pick_requests, public.wms_outbox;

-- ---------- data awal minimal ----------
insert into public.bays (name, sort) values ('Bay 1',1),('Bay 2',2),('Bay 3',3),('Bay 4',4),('Bay 5',5),('Bay 6',6);
insert into public.customers (name, type) values ('Pelanggan retail (counter)', 'retail');
