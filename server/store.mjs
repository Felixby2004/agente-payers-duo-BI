import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { PGlite } from '@electric-sql/pglite';
import { Problem } from './domain.mjs';

export async function openStore(config, { memory = false } = {}) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY } = config.env;
  if (SUPABASE_URL && SUPABASE_SECRET_KEY && !memory) {
    const client = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const table = () => client.from('payers_orders');
    const jobs = () => client.from('payers_agent_jobs');
    const settings = () => client.from('payers_agent_settings');
    const contacts = () => client.from('payers_agent_contacts');
    const queries = () => client.from('payers_agent_queries');
    const check = ({ data, error }) => {
      if (error) throw new Problem('Error de acceso a Supabase. Comprueba las claves y aplica la migración.', 503);
      return data;
    };
    async function incrementQuery(row) {
      return check(await queries().update({ message_count: row.message_count + 1, updated_at: new Date().toISOString() })
        .eq('id', row.id).select('id,phone,state,message_count,excerpt,created_at,handled_at').maybeSingle());
    }
    async function noteQuery(phone, excerpt, create) {
      const current = check(await queries().select('id,phone,state,message_count,excerpt,created_at,handled_at')
        .eq('phone', phone).eq('state', 'open').maybeSingle());
      if (current) return { created: false, query: await incrementQuery(current) };
      if (!create) return { created: false, query: null };
      const row = { id: randomUUID(), phone, state: 'open', message_count: 1, excerpt: String(excerpt || '').slice(0, 200) };
      const result = await queries().insert(row).select('id,phone,state,message_count,excerpt,created_at,handled_at').maybeSingle();
      if (!result.error) return { created: true, query: result.data };
      // Otra ejecución pudo abrir la consulta entre la lectura y la inserción.
      const existing = check(await queries().select('id,phone,state,message_count,excerpt,created_at,handled_at')
        .eq('phone', phone).eq('state', 'open').maybeSingle());
      if (!existing) check(result);
      return { created: false, query: await incrementQuery(existing) };
    }
    return {
      label: 'Supabase',
      async settings() { return check(await settings().select('data').eq('id', 1).maybeSingle())?.data; },
      async saveSettings(data) { check(await settings().upsert({ id: 1, data, updated_at: new Date().toISOString() })); },
      async contact(phone) { return check(await contacts().select('phone,opted_out,opted_out_at').eq('phone', phone).maybeSingle()); },
      async setOptOut(phone, value) {
        check(await contacts().upsert({ phone, opted_out: Boolean(value), opted_out_at: value ? new Date().toISOString() : null,
          updated_at: new Date().toISOString() }, { onConflict: 'phone' }));
      },
      async queries(limit = 200) {
        return check(await queries().select('id,phone,state,message_count,excerpt,created_at,handled_at')
          .order('created_at', { ascending: false }).limit(limit));
      },
      async noteQuery(phone, excerpt, create = false) { return noteQuery(phone, excerpt, create); },
      async handleQuery(id) {
        return Boolean(check(await queries().update({ state: 'handled', handled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', id).eq('state', 'open').select('id').maybeSingle()));
      },
      async enqueue(rows) { if (rows.length) check(await jobs().upsert(rows, { onConflict: 'id', ignoreDuplicates: true })); },
      // Los mensajes del cliente tienen prioridad frente a los recibos de entrega de Meta.
      async queued(limit) { return check(await jobs().select('id,kind,payload').eq('state', 'queued')
        .order('kind').order('queued_at').order('id').limit(limit)); },
      async claim(id) { return Boolean(check(await jobs().update({ state: 'processing', claimed_at: new Date().toISOString() })
        .eq('id', id).eq('state', 'queued').select('id').maybeSingle())); },
      async finishJob(id, state, error = null) { check(await jobs().update({ state, error, ...(state === 'done' ? { payload: {} } : {}) }).eq('id', id).eq('state', 'processing')); },
      async expireJobs(before) { check(await jobs().update({ state: 'failed', error: 'Ejecución interrumpida. Revisa el historial antes de responder.' })
        .eq('state', 'processing').lt('claimed_at', before)); },
      async agentStatus() {
        const rows = check(await jobs().select('state,error,queued_at,claimed_at').order('queued_at', { ascending: false }).limit(20));
        return rows;
      },
      async list() {
        const result = [];
        for (let start = 0; ; start += 500) {
          const rows = check(await table().select('data').order('created_at', { ascending: false }).order('id').range(start, start + 499));
          result.push(...rows.map(r => r.data));
          if (rows.length < 500) return result;
        }
      },
      async phone(phone) { return check(await table().select('data').eq('phone', phone)).map(r => r.data); },
      async get(id) { return check(await table().select('data,version').eq('id', id).maybeSingle()); },
      async insert(data) { check(await table().insert({ id: data.id, phone: data.phone, data })); return data; },
      async save(data, version) {
        return Boolean(check(await table().update({ data, version: version + 1, updated_at: new Date().toISOString() })
          .eq('id', data.id).eq('version', version).select('id').maybeSingle()));
      },
      async find(collection, criteria) {
        return check(await table().select('data').contains('data', { [collection]: [criteria] }).limit(1).maybeSingle())?.data;
      },
    };
  }
  const directory = fileURLToPath(new URL('../.data', import.meta.url));
  if (!memory) await mkdir(directory, { recursive: true });
  const db = new PGlite(memory ? 'memory://' : join(directory, 'pg'));
  await db.exec(`do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
  end $$;`);
  await db.exec(await readFile(new URL('../supabase/migrations/001_payers.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/002_payers_agent.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/003_contactos.sql', import.meta.url), 'utf8'));
  const queryRow = 'id,phone,state,message_count,excerpt,created_at,handled_at';
  async function noteQuery(phone, excerpt, create) {
    const current = (await db.query(`select ${queryRow} from payers_agent_queries where phone = $1 and state = 'open'`, [phone])).rows[0];
    if (current) {
      const updated = (await db.query(`update payers_agent_queries set message_count = message_count + 1, updated_at = now()
        where id = $1 returning ${queryRow}`, [current.id])).rows[0];
      return { created: false, query: updated };
    }
    if (!create) return { created: false, query: null };
    const row = (await db.query(`insert into payers_agent_queries (id, phone, excerpt) values ($1, $2, $3)
      returning ${queryRow}`, [randomUUID(), phone, String(excerpt || '').slice(0, 200)])).rows[0];
    return { created: true, query: row };
  }
  return {
    label: 'PostgreSQL local',
    async settings() { return (await db.query('select data from payers_agent_settings where id = 1')).rows[0]?.data; },
    async saveSettings(data) { await db.query('insert into payers_agent_settings (id,data) values (1,$1) on conflict (id) do update set data = excluded.data, updated_at = now()', [JSON.stringify(data)]); },
    async contact(phone) {
      return (await db.query('select phone,opted_out,opted_out_at from payers_agent_contacts where phone = $1', [phone])).rows[0];
    },
    async setOptOut(phone, value) {
      await db.query(`insert into payers_agent_contacts (phone, opted_out, opted_out_at) values ($1, $2, $3)
        on conflict (phone) do update set opted_out = excluded.opted_out, opted_out_at = excluded.opted_out_at, updated_at = now()`,
      [phone, Boolean(value), value ? new Date().toISOString() : null]);
    },
    async queries(limit = 200) {
      return (await db.query(`select ${queryRow} from payers_agent_queries order by created_at desc limit $1`, [limit])).rows;
    },
    async noteQuery(phone, excerpt, create = false) { return noteQuery(phone, excerpt, create); },
    async handleQuery(id) {
      return Boolean((await db.query(`update payers_agent_queries set state = 'handled', handled_at = now(), updated_at = now()
        where id = $1 and state = 'open' returning id`, [id])).rows.length);
    },
    async enqueue(rows) {
      if (!rows.length) return;
      await db.query(`insert into payers_agent_jobs (id,kind,payload) select id,kind,payload
        from jsonb_to_recordset($1::jsonb) as x(id text,kind text,payload jsonb) on conflict (id) do nothing`, [JSON.stringify(rows)]);
    },
    async queued(limit) { return (await db.query("select id,kind,payload from payers_agent_jobs where state='queued' order by case when kind='message' then 0 else 1 end,queued_at,id limit $1", [limit])).rows; },
    async claim(id) { return Boolean((await db.query("update payers_agent_jobs set state='processing', claimed_at=now() where id=$1 and state='queued' returning id", [id])).rows.length); },
    async finishJob(id, state, error = null) { await db.query("update payers_agent_jobs set state=$2,error=$3,payload=case when $2='done' then '{}'::jsonb else payload end where id=$1 and state='processing'", [id, state, error]); },
    async expireJobs(before) { await db.query("update payers_agent_jobs set state='failed',error='Ejecución interrumpida. Revisa el historial antes de responder.' where state='processing' and claimed_at<$1", [before]); },
    async agentStatus() { return (await db.query('select state,error,queued_at,claimed_at from payers_agent_jobs order by queued_at desc limit 20')).rows; },
    async list() { return (await db.query('select data from payers_orders order by created_at desc, id')).rows.map(r => r.data); },
    async phone(phone) { return (await db.query('select data from payers_orders where phone = $1', [phone])).rows.map(r => r.data); },
    async get(id) { return (await db.query('select data, version from payers_orders where id = $1', [id])).rows[0]; },
    async insert(data) {
      await db.query('insert into payers_orders (id, phone, data) values ($1, $2, $3)', [data.id, data.phone, JSON.stringify(data)]);
      return data;
    },
    async save(data, version) {
      return Boolean((await db.query('update payers_orders set data = $1, version = version + 1, updated_at = now() where id = $2 and version = $3 returning id',
        [JSON.stringify(data), data.id, version])).rows.length);
    },
    async find(collection, criteria) {
      return (await db.query('select data from payers_orders where data @> $1::jsonb limit 1', [JSON.stringify({ [collection]: [criteria] })])).rows[0]?.data;
    },
    async close() { await db.close(); },
  };
}

export async function updateOrder(store, id, apply) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await store.get(id);
    if (!row) throw new Problem('Reserva no encontrada.', 404);
    const data = structuredClone(row.data);
    const result = apply(data);
    if (await store.save(data, row.version)) return { order: data, result };
  }
  throw new Problem('La reserva se actualizó desde otro equipo. Vuelve a intentar.', 409);
}
