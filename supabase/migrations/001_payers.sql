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

