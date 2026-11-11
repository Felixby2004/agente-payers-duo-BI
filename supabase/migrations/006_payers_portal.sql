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

