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
