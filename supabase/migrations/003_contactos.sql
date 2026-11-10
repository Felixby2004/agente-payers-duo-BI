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
