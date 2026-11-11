-- PAYERS. Supabase/PostgreSQL. Ejecutar en el SQL Editor de un proyecto nuevo.

-- Solo estructura, permisos y funciones. Sin datos de negocio, usuarios ni carga dimensional.

begin;

-- 001_payers.sql

-- Una fila por reserva. El documento conserva el pedido pactado, el único
-- pagador, sus transacciones, comprobantes y la bitácora de PAYERS.
create table if not exists public.payers_orders (
  id uuid primary key,
  version integer not null default 0 check (version >= 0),
  phone text not null default '',
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(data) = 'object'),
  check (coalesce(data->>'id', '') = id::text),
  check (coalesce(data->>'phone', '') = phone),
  check (jsonb_typeof(data->'payer') = 'string' and length(data->>'payer') > 0),
  check (phone = '' or phone ~ '^[1-9][0-9]{7,14}$')
);

create index if not exists payers_phone on public.payers_orders (phone);
create unique index if not exists payers_reference on public.payers_orders ((data->>'ref'));
create index if not exists payers_recent on public.payers_orders (created_at desc);

alter table public.payers_orders enable row level security;
revoke all on public.payers_orders from public, anon, authenticated;
grant select, insert, update on public.payers_orders to service_role;

-- 002_payers_agent.sql

create table if not exists public.payers_agent_settings (
  id integer primary key check (id = 1),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.payers_agent_jobs (
  id text primary key,
  kind text not null check (kind in ('message', 'status')),
  payload jsonb not null,
  state text not null default 'queued' check (state in ('queued','processing','done','failed')),
  queued_at timestamptz not null default now(),
  claimed_at timestamptz,
  error text
);
create index if not exists payers_agent_job_queue on public.payers_agent_jobs (state, queued_at);

alter table public.payers_agent_settings enable row level security;
alter table public.payers_agent_jobs enable row level security;
revoke all on public.payers_agent_settings, public.payers_agent_jobs from public, anon, authenticated;
grant select, insert, update on public.payers_agent_settings, public.payers_agent_jobs to service_role;

-- 003_contactos.sql

-- Contactos que escriben sin una reserva registrada y estado de baja/alta.
-- El texto se limita a 200 caracteres y solo se conserva una consulta abierta
-- por número para que el panel no acumule duplicados.
create table if not exists public.payers_agent_contacts (
  phone text primary key check (phone ~ '^[1-9][0-9]{7,14}$'),
  opted_out boolean not null default false,
  opted_out_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.payers_agent_queries (
  id uuid primary key,
  phone text not null check (phone ~ '^[1-9][0-9]{7,14}$'),
  state text not null default 'open' check (state in ('open', 'handled')),
  message_count integer not null default 1 check (message_count > 0),
  excerpt text not null default '' check (char_length(excerpt) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  handled_at timestamptz
);

create unique index if not exists payers_agent_query_open on public.payers_agent_queries (phone) where state = 'open';
create index if not exists payers_agent_query_recent on public.payers_agent_queries (created_at desc);

alter table public.payers_agent_contacts enable row level security;
alter table public.payers_agent_queries enable row level security;
revoke all on public.payers_agent_contacts, public.payers_agent_queries from public, anon, authenticated;
grant select, insert, update on public.payers_agent_contacts, public.payers_agent_queries to service_role;

-- 004_payers_availability.sql

-- Disponibilidad por fecha/hora. Las ocupaciones se consultan desde payers_orders.data.
create table if not exists public.payers_availability_blocks (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('day', 'range', 'slot')),
  local_date date not null,
  starts_at timestamptz,
  ends_at timestamptz,
  reason text not null check (char_length(reason) between 3 and 240),
  created_at timestamptz not null default now(),
  check ((kind = 'day' and starts_at is null and ends_at is null)
    or (kind in ('range', 'slot') and starts_at is not null and ends_at is not null and ends_at > starts_at))
);
create index if not exists payers_availability_blocks_date on public.payers_availability_blocks(local_date);
alter table public.payers_availability_blocks enable row level security;
revoke all on public.payers_availability_blocks from public, anon, authenticated;
grant select, insert, delete on public.payers_availability_blocks to service_role;
-- Columna auxiliar sincronizada para acelerar los cálculos desde el JSON vigente.
alter table public.payers_orders add column if not exists visit_at timestamptz;
create index if not exists payers_visit_at on public.payers_orders (visit_at);
create or replace function public.payers_sync_visit_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.visit_at := (new.data->>'visitAt')::timestamptz;
  return new;
end $$;
drop trigger if exists payers_orders_sync_visit_at on public.payers_orders;
create trigger payers_orders_sync_visit_at before insert or update of data on public.payers_orders
for each row execute function public.payers_sync_visit_at();

-- Cambia una visita con bloqueo por franja, validando settings y cupo en la transacción.
create or replace function public.payers_reschedule_order(
  p_order_id uuid,
  p_new_visit_at timestamptz,
  p_expected_version integer,
  p_expected_visit_at timestamptz,
  p_settings jsonb,
  p_force_capacity boolean default false,
  p_actor text default 'Cliente'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.payers_orders%rowtype;
  v_local timestamp;
  v_date date;
  v_dow integer;
  v_day_key text;
  v_hours jsonb;
  v_open integer;
  v_close integer;
  v_duration integer;
  v_capacity integer;
  v_minute integer;
  v_slot_start timestamptz;
  v_slot_end timestamptz;
  v_occupied integer;
  v_count integer;
  v_data jsonb;
  v_old timestamptz;
begin
  select * into v_row from public.payers_orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Reserva no encontrada.'; end if;
  if (v_row.data->>'visitAt')::timestamptz = p_new_visit_at then return jsonb_build_object('data', v_row.data, 'version', v_row.version, 'changed', false); end if;
  if (v_row.data->>'visitAt')::timestamptz <> p_expected_visit_at then raise exception using errcode = '40001', message = 'La reserva ya cambió de horario. Actualiza las opciones e inténtalo otra vez.'; end if;
  if v_row.version <> p_expected_version then raise exception using errcode = '40001', message = 'La reserva cambió en otro equipo. Actualiza e inténtalo otra vez.'; end if;
  if v_row.data->>'stage' not in ('awaiting_deposit', 'confirmed') then raise exception using errcode = 'P0001', message = 'Solo se puede reprogramar antes de registrar la llegada.'; end if;
  if p_new_visit_at <= now() + interval '1 minute' then raise exception using errcode = 'P0001', message = 'Elige una franja futura.'; end if;
  if p_actor = 'Cliente' then
    if p_settings->>'whatsappRescheduling' <> 'true' then raise exception using errcode = 'P0001', message = 'La reprogramación por WhatsApp está desactivada.'; end if;
    if (v_row.data->>'visitAt')::timestamptz - now() < make_interval(hours => coalesce((p_settings->>'minRescheduleHours')::integer,24)) then
      raise exception using errcode = 'P0001', message = 'La reserva está dentro del margen mínimo para reprogramar.';
    end if;
    if coalesce((v_row.data->>'rescheduleCount')::integer,0) >= coalesce((p_settings->>'maxCustomerReschedules')::integer,2) then
      raise exception using errcode = 'P0001', message = 'Alcanzaste el máximo de cambios de fecha para esta reserva.';
    end if;
    if (p_new_visit_at at time zone 'America/Lima')::date > (now() at time zone 'America/Lima')::date + coalesce((p_settings->>'offerWindowDays')::integer,30) then
      raise exception using errcode = 'P0001', message = 'La fecha supera la ventana de opciones permitida.';
    end if;
  end if;

  v_local := p_new_visit_at at time zone 'America/Lima';
  v_date := v_local::date;
  v_dow := extract(isodow from v_local)::integer;
  v_day_key := (array['mon','tue','wed','thu','fri','sat','sun'])[v_dow];
  v_hours := p_settings->'weeklySchedule'->v_day_key;
  if v_hours is null or v_hours = 'null'::jsonb then raise exception using errcode = 'P0001', message = 'Ese día el restaurante está cerrado.'; end if;
  v_duration := coalesce((p_settings->>'slotMinutes')::integer, 60);
  v_capacity := coalesce((p_settings->>'capacityPerSlot')::integer, 0);
  v_open := split_part(v_hours->>'open', ':', 1)::integer * 60 + split_part(v_hours->>'open', ':', 2)::integer;
  v_close := split_part(v_hours->>'close', ':', 1)::integer * 60 + split_part(v_hours->>'close', ':', 2)::integer;
  v_minute := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  if extract(second from v_local) <> 0 or v_minute < v_open or v_minute + v_duration > v_close or mod(v_minute-v_open, v_duration) <> 0 then
    raise exception using errcode = 'P0001', message = 'El horario elegido no coincide con una franja disponible.';
  end if;
  v_slot_start := p_new_visit_at;
  v_slot_end := v_slot_start + make_interval(mins => v_duration);
  perform pg_advisory_xact_lock(hashtext(v_slot_start::text));
  if exists (select 1 from public.payers_availability_blocks b where b.local_date = v_date and
    (b.kind = 'day' or (b.starts_at < v_slot_end and b.ends_at > v_slot_start))) then
    raise exception using errcode = 'P0001', message = 'Ese horario está bloqueado. Elige otra opción.';
  end if;
  select coalesce(sum((o.data->>'guests')::integer), 0) into v_occupied
    from public.payers_orders o
   where o.id <> p_order_id and o.data->>'stage' in ('awaiting_deposit','confirmed','arrived','paid')
     and o.visit_at >= v_slot_start and o.visit_at < v_slot_end;
  if not p_force_capacity and v_occupied + (v_row.data->>'guests')::integer > v_capacity then
    raise exception using errcode = 'P0001', message = 'Ese horario ya no tiene cupo suficiente. Elige otra opción.';
  end if;

  v_old := (v_row.data->>'visitAt')::timestamptz;
  v_data := v_row.data || jsonb_build_object('visitAt', to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'reminders', '{}'::jsonb);
  if v_data->>'stage' = 'awaiting_deposit' and (v_data->>'deadline')::timestamptz > p_new_visit_at then
    v_data := jsonb_set(v_data, '{deadline}', to_jsonb(to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;
  if p_actor = 'Cliente' then
    v_count := coalesce((v_data->>'rescheduleCount')::integer, 0) + 1;
    v_data := jsonb_set(v_data, '{rescheduleCount}', to_jsonb(v_count), true);
  else
    v_count := coalesce((v_data->>'rescheduleCount')::integer, 0);
  end if;
  v_data := jsonb_set(v_data, '{events}', coalesce(v_data->'events','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid(), 'at', now(), 'title', 'Visita reprogramada',
    'detail', 'Anterior: ' || v_old::text || ' · Nueva: ' || p_new_visit_at::text || ' · Cambios del cliente: ' || v_count::text || case when p_force_capacity then ' · Aforo forzado por personal' else '' end,
    'actor', p_actor)));
  update public.payers_orders set data = v_data, version = version + 1, updated_at = now() where id = p_order_id;
  return jsonb_build_object('data', v_data, 'version', v_row.version + 1, 'changed', true);
end $$;
revoke all on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) from public, anon, authenticated;
grant execute on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) to service_role;

-- 005_availability_unconfigured.sql

-- El RPC de reprogramación también exige cupos configurados para cambios del cliente.
-- La migración 004 permanece intacta para instalaciones donde ya fue aplicada.
create or replace function public.payers_reschedule_order(
  p_order_id uuid,
  p_new_visit_at timestamptz,
  p_expected_version integer,
  p_expected_visit_at timestamptz,
  p_settings jsonb,
  p_force_capacity boolean default false,
  p_actor text default 'Cliente'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.payers_orders%rowtype;
  v_local timestamp;
  v_date date;
  v_dow integer;
  v_day_key text;
  v_hours jsonb;
  v_open integer;
  v_close integer;
  v_duration integer;
  v_capacity integer;
  v_minute integer;
  v_slot_start timestamptz;
  v_slot_end timestamptz;
  v_occupied integer;
  v_count integer;
  v_data jsonb;
  v_old timestamptz;
  v_availability_configured boolean;
begin
  select * into v_row from public.payers_orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Reserva no encontrada.'; end if;
  if (v_row.data->>'visitAt')::timestamptz = p_new_visit_at then
    return jsonb_build_object('data', v_row.data, 'version', v_row.version, 'changed', false);
  end if;
  if (v_row.data->>'visitAt')::timestamptz <> p_expected_visit_at then raise exception using errcode = '40001', message = 'La reserva ya cambió de horario. Actualiza las opciones e inténtalo otra vez.'; end if;
  if v_row.version <> p_expected_version then raise exception using errcode = '40001', message = 'La reserva cambió en otro equipo. Actualiza e inténtalo otra vez.'; end if;
  if v_row.data->>'stage' not in ('awaiting_deposit', 'confirmed') then raise exception using errcode = 'P0001', message = 'Solo se puede reprogramar antes de registrar la llegada.'; end if;
  if p_new_visit_at <= now() + interval '1 minute' then raise exception using errcode = 'P0001', message = 'Elige una franja futura.'; end if;
  v_availability_configured := p_settings->>'availabilityConfigured' is distinct from 'false'
    and coalesce((p_settings->>'capacityPerSlot')::integer, 0) > 0
    and exists (
      select 1 from jsonb_each(coalesce(p_settings->'weeklySchedule', '{}'::jsonb)) as schedule(day_key, hours)
      where jsonb_typeof(hours) = 'object' and hours->>'open' is not null and hours->>'close' is not null
    );
  if p_actor = 'Cliente' then
    if p_settings->>'whatsappRescheduling' <> 'true' then raise exception using errcode = 'P0001', message = 'La reprogramación por WhatsApp está desactivada.'; end if;
    if not v_availability_configured then
      raise exception using errcode = 'P0001', message = 'La disponibilidad aún no está configurada. El personal te ayudará con el cambio.';
    end if;
    if (v_row.data->>'visitAt')::timestamptz - now() < make_interval(hours => coalesce((p_settings->>'minRescheduleHours')::integer,24)) then
      raise exception using errcode = 'P0001', message = 'La reserva está dentro del margen mínimo para reprogramar.';
    end if;
    if coalesce((v_row.data->>'rescheduleCount')::integer,0) >= coalesce((p_settings->>'maxCustomerReschedules')::integer,2) then
      raise exception using errcode = 'P0001', message = 'Alcanzaste el máximo de cambios de fecha para esta reserva.';
    end if;
    if (p_new_visit_at at time zone 'America/Lima')::date > (now() at time zone 'America/Lima')::date + coalesce((p_settings->>'offerWindowDays')::integer,30) then
      raise exception using errcode = 'P0001', message = 'La fecha supera la ventana de opciones permitida.';
    end if;
  end if;

  if v_availability_configured then
  v_local := p_new_visit_at at time zone 'America/Lima';
  v_date := v_local::date;
  v_dow := extract(isodow from v_local)::integer;
  v_day_key := (array['mon','tue','wed','thu','fri','sat','sun'])[v_dow];
  v_hours := p_settings->'weeklySchedule'->v_day_key;
  if v_hours is null or v_hours = 'null'::jsonb then raise exception using errcode = 'P0001', message = 'Ese día el restaurante está cerrado.'; end if;
  v_duration := coalesce((p_settings->>'slotMinutes')::integer, 60);
  v_capacity := coalesce((p_settings->>'capacityPerSlot')::integer, 0);
  v_open := split_part(v_hours->>'open', ':', 1)::integer * 60 + split_part(v_hours->>'open', ':', 2)::integer;
  v_close := split_part(v_hours->>'close', ':', 1)::integer * 60 + split_part(v_hours->>'close', ':', 2)::integer;
  v_minute := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  if extract(second from v_local) <> 0 or v_minute < v_open or v_minute + v_duration > v_close or mod(v_minute-v_open, v_duration) <> 0 then
    raise exception using errcode = 'P0001', message = 'El horario elegido no coincide con una franja disponible.';
  end if;
  v_slot_start := p_new_visit_at;
  v_slot_end := v_slot_start + make_interval(mins => v_duration);
  perform pg_advisory_xact_lock(hashtext(v_slot_start::text));
  if exists (select 1 from public.payers_availability_blocks b where b.local_date = v_date and
    (b.kind = 'day' or (b.starts_at < v_slot_end and b.ends_at > v_slot_start))) then
    raise exception using errcode = 'P0001', message = 'Ese horario está bloqueado. Elige otra opción.';
  end if;
  select coalesce(sum((o.data->>'guests')::integer), 0) into v_occupied
    from public.payers_orders o
   where o.id <> p_order_id and o.data->>'stage' in ('awaiting_deposit','confirmed','arrived','paid')
     and o.visit_at >= v_slot_start and o.visit_at < v_slot_end;
  if not p_force_capacity and v_occupied + (v_row.data->>'guests')::integer > v_capacity then
    raise exception using errcode = 'P0001', message = 'Ese horario ya no tiene cupo suficiente. Elige otra opción.';
  end if;
  end if;

  v_old := (v_row.data->>'visitAt')::timestamptz;
  v_data := v_row.data || jsonb_build_object('visitAt', to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'reminders', '{}'::jsonb);
  if v_data->>'stage' = 'awaiting_deposit' and (v_data->>'deadline')::timestamptz > p_new_visit_at then
    v_data := jsonb_set(v_data, '{deadline}', to_jsonb(to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;
  if p_actor = 'Cliente' then
    v_count := coalesce((v_data->>'rescheduleCount')::integer, 0) + 1;
    v_data := jsonb_set(v_data, '{rescheduleCount}', to_jsonb(v_count), true);
  else
    v_count := coalesce((v_data->>'rescheduleCount')::integer, 0);
  end if;
  v_data := jsonb_set(v_data, '{events}', coalesce(v_data->'events','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid(), 'at', now(), 'title', 'Visita reprogramada',
    'detail', 'Anterior: ' || v_old::text || ' · Nueva: ' || p_new_visit_at::text || ' · Cambios del cliente: ' || v_count::text || case when p_force_capacity then ' · Aforo forzado por personal' else '' end,
    'actor', p_actor)));
  update public.payers_orders set data = v_data, version = version + 1, updated_at = now() where id = p_order_id;
  return jsonb_build_object('data', v_data, 'version', v_row.version + 1, 'changed', true);
end $$;
revoke all on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) from public, anon, authenticated;
grant execute on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) to service_role;

-- 006_payers_portal.sql

-- Acceso operativo. Crear estructura sin insertar cuentas ni poblar reservas.
create table if not exists public.payers_clients (
  id bigint generated always as identity primary key,
  phone text not null unique check (phone ~ '^[1-9][0-9]{7,14}$'),
  name text not null check (length(name) between 2 and 100),
  created_at timestamptz not null default now()
);

create table if not exists public.payers_staff (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  name text not null check (length(name) between 2 and 100),
  role text not null check (role in ('admin','cashier')),
  password_hash text not null,
  active boolean not null default true,
  version integer not null default 0
);

create table if not exists public.payers_client_otp (
  id uuid primary key,
  client_id bigint not null references public.payers_clients(id),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts smallint not null default 0 check (attempts between 0 and 5)
);
create index if not exists payers_client_otp_client_date on public.payers_client_otp (client_id, created_at desc);

alter table public.payers_clients enable row level security;
alter table public.payers_staff enable row level security;
alter table public.payers_client_otp enable row level security;
revoke all on public.payers_clients, public.payers_staff, public.payers_client_otp from public, anon, authenticated;

create or replace function public.payers_link_client() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.phone <> '' then
    insert into public.payers_clients(phone, name) values(new.phone, left(new.data->>'payer', 100))
      on conflict (phone) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.payers_link_client() from public, anon, authenticated;
grant execute on function public.payers_link_client() to service_role;
grant select, insert on public.payers_clients to service_role;
grant usage, select on sequence public.payers_clients_id_seq to service_role;
drop trigger if exists payers_link_client on public.payers_orders;
create trigger payers_link_client after insert on public.payers_orders
for each row execute function public.payers_link_client();

-- Las operaciones del portal solo se invocan desde la API con service_role.
create or replace function public.payers_portal(p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_client public.payers_clients%rowtype;
  v_staff public.payers_staff%rowtype;
  v_name text;
  v_otp_id uuid;
  v_result jsonb;
begin
  case p_action
    when 'staff_login' then
      select * into v_staff from public.payers_staff where username = p_data->>'username' and active;
      return to_jsonb(v_staff);
    when 'staff_session' then
      select * into v_staff from public.payers_staff where id = (p_data->>'id')::uuid and active;
      return to_jsonb(v_staff) - 'password_hash';
    when 'staff_list' then
      select coalesce(jsonb_agg(to_jsonb(s) - 'password_hash' order by s.username), '[]'::jsonb)
        into v_result from public.payers_staff s;
      return v_result;
    when 'staff_save' then
      if p_data->>'id' is null then
        insert into public.payers_staff(username,name,role,password_hash,active)
          values(p_data->>'username',p_data->>'name',p_data->>'role',p_data->>'password_hash',true)
          returning * into v_staff;
      else
        update public.payers_staff set name = p_data->>'name', role = p_data->>'role',
          active = (p_data->>'active')::boolean, password_hash = coalesce(p_data->>'password_hash',password_hash),
          version = version + 1 where id = (p_data->>'id')::uuid returning * into v_staff;
      end if;
      return to_jsonb(v_staff) - 'password_hash';
    when 'otp_start' then
      select * into v_client from public.payers_clients where phone = p_data->>'phone' for update;
      if v_client.id is null then
        -- Compatibilidad con pedidos previos. El DDL no migra ni puebla datos.
        select data->>'payer' into v_name from public.payers_orders
          where phone = p_data->>'phone'
          order by created_at desc limit 1;
        if v_name is null then return null; end if;
        insert into public.payers_clients(phone,name) values(p_data->>'phone',left(v_name,100))
          on conflict (phone) do nothing;
        select * into v_client from public.payers_clients where phone = p_data->>'phone' for update;
      end if;
      if exists(select 1 from public.payers_client_otp where client_id = v_client.id
        and created_at > now() - interval '60 seconds') then return null; end if;
      update public.payers_client_otp set expires_at = now()
        where client_id = v_client.id and used_at is null and expires_at > now();
      insert into public.payers_client_otp(id,client_id,digest,expires_at)
        values((p_data->>'id')::uuid,v_client.id,p_data->>'digest',now()+interval '5 minutes');
      return to_jsonb(v_client);
    when 'otp_verify' then
      v_otp_id := (p_data->>'id')::uuid;
      update public.payers_client_otp set
        used_at = case when digest = p_data->>'digest' then now() else null end,
        attempts = case when digest = p_data->>'digest' then attempts else attempts+1 end
      where id = v_otp_id and used_at is null and expires_at > now() and attempts < 5
      returning case when used_at is not null then client_id end into v_client.id;
      if v_client.id is null then return null; end if;
      select * into v_client from public.payers_clients where id = v_client.id;
      return to_jsonb(v_client);
    when 'client_session' then
      select * into v_client from public.payers_clients where id = (p_data->>'id')::bigint;
      return to_jsonb(v_client);
    else return null;
  end case;
end $$;
revoke all on function public.payers_portal(text,jsonb) from public, anon, authenticated;
grant execute on function public.payers_portal(text,jsonb) to service_role;

-- 007_payers_reporting.sql

-- Modelos de lectura sobre los pedidos operativos, incluidos los históricos.
-- Una única escritura de la reserva sigue protegiendo cobro, asistencia y disponibilidad.
create schema if not exists payers_operacion;
revoke all on schema payers_operacion from public, anon, authenticated;
grant usage on schema payers_operacion to service_role;

create table if not exists payers_operacion.producto (
  id_producto bigint generated always as identity primary key,
  nombre text not null, categoria text, precio_vigente_centimos bigint check(precio_vigente_centimos >= 0),
  activo boolean not null default true
);
create unique index if not exists payers_producto_nombre on payers_operacion.producto (lower(nombre));
create table if not exists payers_operacion.medio_pago (
  id_medio_pago smallint generated always as identity primary key,
  referencia text not null unique
);
create or replace function payers_operacion.registrar_catalogo() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into payers_operacion.producto(nombre,precio_vigente_centimos)
      select item->>'name',(item->>'price')::bigint from jsonb_array_elements(new.data->'items') item
      on conflict do nothing;
  end if;
  if tg_op = 'INSERT' or old.data->'payments' is distinct from new.data->'payments' then
    insert into payers_operacion.medio_pago(referencia)
      select distinct item->>'channel' from jsonb_array_elements(new.data->'payments') item
      where item->>'channel' is not null on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function payers_operacion.registrar_catalogo() from public,anon,authenticated;
grant execute on function payers_operacion.registrar_catalogo() to service_role;
drop trigger if exists payers_catalogo on public.payers_orders;
create trigger payers_catalogo after insert or update of data on public.payers_orders
for each row execute function payers_operacion.registrar_catalogo();

create or replace view payers_operacion.reserva with (security_invoker=true) as
select o.id as reserva_id,c.id as cliente_id,o.data->>'ref' as referencia,
  o.data->>'stage' as estado,o.created_at as creada_en,o.visit_at as visita_en,
  (o.data->>'deadline')::timestamptz as vence_anticipo_en,
  (o.data->>'confirmedAt')::timestamptz as anticipo_confirmado_en,
  (o.data->>'closedAt')::timestamptz as cerrada_en,
  (o.data->>'guests')::smallint as personas_reservadas,
  (o.data->>'total')::bigint as total_centimos,(o.data->>'deposit')::bigint as anticipo_centimos
from public.payers_orders o left join public.payers_clients c on c.phone=o.phone;

create or replace view payers_operacion.detalle_pedido with (security_invoker=true) as
select o.id as reserva_id,p.linea,p.item->>'name' as producto,(p.item->>'quantity')::smallint as cantidad,
  (p.item->>'price')::bigint as precio_pactado_centimos,
  coalesce((p.item->>'discount')::bigint,0) as descuento_centimos,
  (p.item->>'quantity')::bigint*(p.item->>'price')::bigint-coalesce((p.item->>'discount')::bigint,0) as importe_neto_centimos,c.id_producto
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'items') with ordinality p(item,linea)
left join payers_operacion.producto c on lower(c.nombre)=lower(p.item->>'name');

create or replace view payers_operacion.intento_pago with (security_invoker=true) as
select o.id as reserva_id,p.item->>'id' as intento_id,coalesce(p.item->>'purpose','deposit') as finalidad,
  p.item->>'method' as medio,p.item->>'status' as estado,(p.item->>'amount')::bigint as importe_centimos,
  (p.item->>'createdAt')::timestamptz as creado_en,(p.item->>'expiresAt')::timestamptz as vence_en,
  p.item->>'staffId' as emitido_por
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'intents') p(item);

create or replace view payers_operacion.movimiento_pago with (security_invoker=true) as
select o.id as reserva_id,p.item->>'ref' as operacion,p.item->>'intentId' as intento_id,
  coalesce(p.item->>'purpose','deposit') as finalidad,p.item->>'channel' as medio,
  (p.item->>'amount')::bigint as importe_centimos,(p.item->>'at')::timestamptz as confirmado_en,
  p.item->>'original' as operacion_origen,p.item->>'staffId' as registrado_por
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'payments') p(item);

create or replace view payers_operacion.asistencia with (security_invoker=true) as
select o.id as reserva_id,coalesce(a.data->>'state',case when a.data->>'at' is not null then 'confirmed' end) as estado,
  (a.data->>'reportedAt')::timestamptz as reportada_en,(a.data->>'at')::timestamptz as verificada_en,
  (a.data->>'titularPresente')::boolean as titular_presente,
  (a.data->>'count')::smallint as comensales_presentes,a.data->>'staffId' as cajero_id,a.data->>'staffName' as cajero
from public.payers_orders o cross join lateral (select o.data->'attendance' as data) a
where jsonb_typeof(a.data) = 'object';

create or replace view payers_operacion.comprobante with (security_invoker=true) as
select o.id as reserva_id,r.item->>'number' as numero,r.item->>'purpose' as tipo,
  (r.item->>'at')::timestamptz as emitido_en,(r.item->>'amount')::bigint as importe_centimos,
  (r.item->>'reversedAt')::timestamptz as revertido_en
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'receipts') r(item);

create or replace view payers_operacion.evento_reserva with (security_invoker=true) as
select o.id as reserva_id,e.item->>'id' as evento_id,e.item->>'title' as tipo,
  (e.item->>'at')::timestamptz as ocurrido_en,e.item->>'actor' as actor,e.item->>'detail' as detalle
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'events') e(item);

create or replace view payers_operacion.incidencia with (security_invoker=true) as
select o.id as reserva_id,i.item->>'id' as incidencia_id,i.item->>'type' as tipo,
  (i.item->>'at')::timestamptz as abierta_en,(i.item->>'resolvedAt')::timestamptz as resuelta_en,
  i.item->>'detail' as detalle,i.item->>'resolution' as resolucion
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'incidents') i(item);

create or replace view payers_operacion.mensaje_whatsapp with (security_invoker=true) as
select o.id as reserva_id,m.item->>'id' as id_meta,o.phone as telefono,
  (m.item->>'at')::timestamptz as ocurrido_en,m.item->>'direction' as direccion,
  m.item->>'status' as estado,m.item->>'text' as texto,m.item->>'mediaId' as medio
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'chat') m(item);

-- Los hechos de lectura mantienen el grano dimensional mientras se pospone el merge físico.
create schema if not exists payers_bi;
revoke all on schema payers_bi from public, anon, authenticated;
grant usage on schema payers_bi to service_role;

create or replace view payers_operacion.totales_movimiento with (security_invoker=true) as
select reserva_id, sum(importe_centimos) as total,
  sum(importe_centimos) filter(where finalidad='deposit') as anticipo,
  count(distinct medio) filter(where importe_centimos>0) as n_medios,
  count(distinct medio) filter(where finalidad='deposit' and importe_centimos>0) as n_medios_anticipo,
  min(medio) filter(where importe_centimos>0) as medio,
  min(medio) filter(where finalidad='deposit' and importe_centimos>0) as medio_anticipo
from payers_operacion.movimiento_pago group by reserva_id;

create or replace view payers_bi.v_hecho_anticipo_asistencia with (security_invoker=true) as
select r.reserva_id,r.cliente_id,r.referencia,
  (r.anticipo_confirmado_en at time zone 'America/Lima')::date as fecha_anticipo,
  (r.visita_en at time zone 'America/Lima')::date as fecha_visita,
  case when p.n_medios_anticipo>1 then 'Mixto' else p.medio_anticipo end as medio,
  coalesce(p.anticipo,0)::bigint as anticipo_centimos,
  (r.anticipo_confirmado_en is not null and coalesce(p.anticipo,0)>0) as con_anticipo,
  r.anticipo_confirmado_en is not null as titular_pago,
  a.titular_presente as titular_asistio,
  (a.verificada_en is not null or r.estado='no_show') as asistencia_evaluable,
  a.cajero, a.comensales_presentes
from payers_operacion.reserva r left join payers_operacion.totales_movimiento p using(reserva_id)
left join payers_operacion.asistencia a using(reserva_id);

create or replace view payers_bi.v_hecho_cobranza_completa with (security_invoker=true) as
select r.reserva_id,r.cliente_id,r.referencia,
  (r.cerrada_en at time zone 'America/Lima')::date as fecha_cierre,
  case when p.n_medios>1 then 'Mixto' else p.medio end as medio,
  p.total::bigint as total_centimos,
  extract(epoch from r.cerrada_en - a.verificada_en)::integer as segundos_llegada_cierre
from payers_operacion.reserva r join payers_operacion.totales_movimiento p using(reserva_id)
join payers_operacion.asistencia a using(reserva_id)
where r.estado='closed' and r.cerrada_en is not null and p.total=r.total_centimos and a.verificada_en is not null;

grant select on payers_bi.v_hecho_anticipo_asistencia, payers_bi.v_hecho_cobranza_completa to service_role;

create or replace view public.payers_report_rows with (security_invoker=true) as
select 'M1'::text as measure,fecha_anticipo as date,referencia as ref,medio as label,anticipo_centimos as value
from payers_bi.v_hecho_anticipo_asistencia where con_anticipo
union all
select 'M3',fecha_visita,referencia,coalesce(cajero,'Caja'),1::bigint
from payers_bi.v_hecho_anticipo_asistencia where titular_pago and titular_asistio is true and asistencia_evaluable
union all
select 'M5',fecha_cierre,referencia,medio,total_centimos from payers_bi.v_hecho_cobranza_completa;

revoke all on all tables in schema payers_operacion from public, anon, authenticated;
grant select on all tables in schema payers_operacion to service_role;
revoke all on public.payers_report_rows from public, anon, authenticated;
grant select on public.payers_report_rows to service_role;

-- 008_payers_dimensional.sql

-- Base dimensional física. El merge y el poblamiento quedan para una etapa posterior.
create schema if not exists payers_bi;
revoke all on schema payers_bi from public, anon, authenticated;
grant usage on schema payers_bi to service_role;

create table if not exists payers_bi.dim_tiempo (
  key_tiempo integer generated always as identity primary key,
  anio smallint not null, trimestre smallint not null, mes smallint not null, dia smallint not null,
  dia_semana smallint not null, id_tiempo date not null unique
);
create table if not exists payers_bi.dim_cliente (
  key_cliente integer generated always as identity primary key,
  nombre varchar(100) not null, tipo_cliente varchar(60), id_cliente bigint not null unique
);
create table if not exists payers_bi.dim_personal (
  key_personal integer generated always as identity primary key,
  nombre varchar(100) not null, rol varchar(40) not null, id_personal uuid not null unique
);
create table if not exists payers_bi.dim_reserva (
  key_reserva integer generated always as identity primary key,
  origen varchar(40), personas_reservadas smallint not null, id_reserva uuid not null unique
);
create table if not exists payers_bi.dim_medio_pago (
  key_medio_pago integer generated always as identity primary key,
  nombre varchar(60) not null, tipo varchar(30) not null, id_medio_pago smallint not null unique
);
create table if not exists payers_bi.dim_producto (
  key_producto integer generated always as identity primary key,
  nombre varchar(120) not null, categoria varchar(60), id_producto bigint not null unique
);
create table if not exists payers_bi.hecho_anticipo_asistencia (
  key_reserva integer primary key references payers_bi.dim_reserva,
  key_tiempo_anticipo integer references payers_bi.dim_tiempo,
  key_tiempo_visita integer not null references payers_bi.dim_tiempo,
  key_cliente integer not null references payers_bi.dim_cliente,
  key_personal_valida integer references payers_bi.dim_personal,
  key_personal_recepcion integer references payers_bi.dim_personal,
  key_medio_pago_anticipo integer references payers_bi.dim_medio_pago,
  monto_anticipo_confirmado numeric(12,2) not null, con_anticipo boolean not null, titular_asistio boolean,
  titular_pago boolean not null, asistencia_evaluable boolean not null, comensales_presentes smallint
);
create table if not exists payers_bi.hecho_cobranza_completa (
  key_reserva integer primary key references payers_bi.dim_reserva,
  key_tiempo_llegada integer not null references payers_bi.dim_tiempo,
  key_tiempo_cierre integer not null references payers_bi.dim_tiempo,
  key_cliente integer not null references payers_bi.dim_cliente,
  key_personal_cierre integer references payers_bi.dim_personal,
  key_medio_pago_liquidacion integer references payers_bi.dim_medio_pago,
  importe_total_cobrado numeric(12,2) not null, segundos_llegada_a_cierre integer not null
);
create table if not exists payers_bi.detalle_cobranza_producto (
  key_detalle bigint generated always as identity primary key,
  key_reserva integer not null references payers_bi.hecho_cobranza_completa,
  key_producto integer not null references payers_bi.dim_producto,
  cantidad smallint not null check (cantidad > 0),
  precio_unitario_pactado numeric(12,2) not null check (precio_unitario_pactado >= 0),
  descuento_total_linea numeric(12,2) not null default 0,
  importe_neto_linea numeric(12,2) generated always as (cantidad * precio_unitario_pactado - descuento_total_linea) stored,
  check (descuento_total_linea between 0 and cantidad * precio_unitario_pactado)
);
revoke all on all tables in schema payers_bi from public, anon, authenticated;
grant select on all tables in schema payers_bi to service_role;

-- 009_payers_reprogramacion.sql

-- Descarta el aviso de llegada pendiente al cambiar de fecha y conserva las dos fechas en el evento.
create or replace function public.payers_reschedule_order(
  p_order_id uuid,
  p_new_visit_at timestamptz,
  p_expected_version integer,
  p_expected_visit_at timestamptz,
  p_settings jsonb,
  p_force_capacity boolean default false,
  p_actor text default 'Cliente'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.payers_orders%rowtype;
  v_local timestamp;
  v_date date;
  v_dow integer;
  v_day_key text;
  v_hours jsonb;
  v_open integer;
  v_close integer;
  v_duration integer;
  v_capacity integer;
  v_minute integer;
  v_slot_start timestamptz;
  v_slot_end timestamptz;
  v_occupied integer;
  v_count integer;
  v_data jsonb;
  v_old timestamptz;
  v_availability_configured boolean;
begin
  select * into v_row from public.payers_orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Reserva no encontrada.'; end if;
  if (v_row.data->>'visitAt')::timestamptz = p_new_visit_at then
    return jsonb_build_object('data', v_row.data, 'version', v_row.version, 'changed', false);
  end if;
  if (v_row.data->>'visitAt')::timestamptz <> p_expected_visit_at then raise exception using errcode = '40001', message = 'La reserva ya cambió de horario. Actualiza las opciones e inténtalo otra vez.'; end if;
  if v_row.version <> p_expected_version then raise exception using errcode = '40001', message = 'La reserva cambió en otro equipo. Actualiza e inténtalo otra vez.'; end if;
  if v_row.data->>'stage' not in ('awaiting_deposit', 'confirmed') then raise exception using errcode = 'P0001', message = 'Solo se puede reprogramar antes de registrar la llegada.'; end if;
  if p_new_visit_at <= now() + interval '1 minute' then raise exception using errcode = 'P0001', message = 'Elige una franja futura.'; end if;
  v_availability_configured := p_settings->>'availabilityConfigured' is distinct from 'false'
    and coalesce((p_settings->>'capacityPerSlot')::integer, 0) > 0
    and exists (
      select 1 from jsonb_each(coalesce(p_settings->'weeklySchedule', '{}'::jsonb)) as schedule(day_key, hours)
      where jsonb_typeof(hours) = 'object' and hours->>'open' is not null and hours->>'close' is not null
    );
  if p_actor = 'Cliente' then
    if p_settings->>'whatsappRescheduling' <> 'true' then raise exception using errcode = 'P0001', message = 'La reprogramación por WhatsApp está desactivada.'; end if;
    if not v_availability_configured then
      raise exception using errcode = 'P0001', message = 'La disponibilidad aún no está configurada. El personal te ayudará con el cambio.';
    end if;
    if (v_row.data->>'visitAt')::timestamptz - now() < make_interval(hours => coalesce((p_settings->>'minRescheduleHours')::integer,24)) then
      raise exception using errcode = 'P0001', message = 'La reserva está dentro del margen mínimo para reprogramar.';
    end if;
    if coalesce((v_row.data->>'rescheduleCount')::integer,0) >= coalesce((p_settings->>'maxCustomerReschedules')::integer,2) then
      raise exception using errcode = 'P0001', message = 'Alcanzaste el máximo de cambios de fecha para esta reserva.';
    end if;
    if (p_new_visit_at at time zone 'America/Lima')::date > (now() at time zone 'America/Lima')::date + coalesce((p_settings->>'offerWindowDays')::integer,30) then
      raise exception using errcode = 'P0001', message = 'La fecha supera la ventana de opciones permitida.';
    end if;
  end if;

  if v_availability_configured then
  v_local := p_new_visit_at at time zone 'America/Lima';
  v_date := v_local::date;
  v_dow := extract(isodow from v_local)::integer;
  v_day_key := (array['mon','tue','wed','thu','fri','sat','sun'])[v_dow];
  v_hours := p_settings->'weeklySchedule'->v_day_key;
  if v_hours is null or v_hours = 'null'::jsonb then raise exception using errcode = 'P0001', message = 'Ese día el restaurante está cerrado.'; end if;
  v_duration := coalesce((p_settings->>'slotMinutes')::integer, 60);
  v_capacity := coalesce((p_settings->>'capacityPerSlot')::integer, 0);
  v_open := split_part(v_hours->>'open', ':', 1)::integer * 60 + split_part(v_hours->>'open', ':', 2)::integer;
  v_close := split_part(v_hours->>'close', ':', 1)::integer * 60 + split_part(v_hours->>'close', ':', 2)::integer;
  v_minute := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  if extract(second from v_local) <> 0 or v_minute < v_open or v_minute + v_duration > v_close or mod(v_minute-v_open, v_duration) <> 0 then
    raise exception using errcode = 'P0001', message = 'El horario elegido no coincide con una franja disponible.';
  end if;
  v_slot_start := p_new_visit_at;
  v_slot_end := v_slot_start + make_interval(mins => v_duration);
  perform pg_advisory_xact_lock(hashtext(v_slot_start::text));
  if exists (select 1 from public.payers_availability_blocks b where b.local_date = v_date and
    (b.kind = 'day' or (b.starts_at < v_slot_end and b.ends_at > v_slot_start))) then
    raise exception using errcode = 'P0001', message = 'Ese horario está bloqueado. Elige otra opción.';
  end if;
  select coalesce(sum((o.data->>'guests')::integer), 0) into v_occupied
    from public.payers_orders o
   where o.id <> p_order_id and o.data->>'stage' in ('awaiting_deposit','confirmed','arrived','paid')
     and o.visit_at >= v_slot_start and o.visit_at < v_slot_end;
  if not p_force_capacity and v_occupied + (v_row.data->>'guests')::integer > v_capacity then
    raise exception using errcode = 'P0001', message = 'Ese horario ya no tiene cupo suficiente. Elige otra opción.';
  end if;
  end if;

  v_old := (v_row.data->>'visitAt')::timestamptz;
  v_data := v_row.data || jsonb_build_object('visitAt', to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'reminders', '{}'::jsonb);
  if v_data->>'stage' = 'awaiting_deposit' and (v_data->>'deadline')::timestamptz > p_new_visit_at then
    v_data := jsonb_set(v_data, '{deadline}', to_jsonb(to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;
  if (v_data->'depositPromise'->>'at')::timestamptz >= (v_data->>'deadline')::timestamptz then
    v_data := v_data - 'depositPromise';
  end if;
  if v_data->'attendance'->>'state' = 'pending' then
    v_data := v_data || jsonb_build_object('attendance', null);
  end if;
  if p_actor = 'Cliente' then
    v_count := coalesce((v_data->>'rescheduleCount')::integer, 0) + 1;
    v_data := jsonb_set(v_data, '{rescheduleCount}', to_jsonb(v_count), true);
  else
    v_count := coalesce((v_data->>'rescheduleCount')::integer, 0);
  end if;
  v_data := jsonb_set(v_data, '{events}', coalesce(v_data->'events','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid(), 'at', now(), 'title', 'Visita reprogramada',
    'detail', 'Anterior: ' || v_old::text || ' · Nueva: ' || p_new_visit_at::text || ' · Cambios del cliente: ' || v_count::text || case when p_force_capacity then ' · Aforo forzado por personal' else '' end,
    'actor', p_actor, 'previousVisitAt', v_old, 'newVisitAt', p_new_visit_at)));
  update public.payers_orders set data = v_data, version = version + 1, updated_at = now() where id = p_order_id;
  return jsonb_build_object('data', v_data, 'version', v_row.version + 1, 'changed', true);
end $$;
revoke all on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) from public, anon, authenticated;
grant execute on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) to service_role;

commit;
