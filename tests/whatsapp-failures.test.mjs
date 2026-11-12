import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApi } from '../server/api.mjs';
import { readConfig } from '../server/config.mjs';
import { openStore } from '../server/store.mjs';

const base = { ADMIN_PASSWORD: 'admin-de-demostracion', PUBLIC_URL: 'https://establo.test', SESSION_SECRET: 'secreto-ficticio-largo-para-pruebas',
  SUPABASE_URL: 'https://db.test.invalid', SUPABASE_SECRET_KEY: 'ficticio', WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0',
  WA_PHONE_NUMBER_ID: '456', WA_ACCESS_TOKEN: 'token-ficticio', WA_VERIFY_TOKEN: 'verify-ficticio', WA_APP_SECRET: 'firma-ficticia',
  WA_ALLOWED_PHONES: '51911111111', AGENT_ORCHESTRATION: 'n8n', N8N_AGENT_TOKEN: 'token-n8n-de-prueba-largo-suficiente' };

function harness(api) {
  return async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = { method, url: '/api/' + path, socket: { remoteAddress: '127.0.0.1' }, headers: { cookie, ...headers },
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); } };
    const res = { status: 200, headers: {}, writeHead(status, fields) { this.status = status; this.headersSent = true; Object.assign(this.headers, fields); },
      setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; } };
    await api.middleware(req, res, () => {});
    return { status: res.status, data: JSON.parse(res.body || 'null'), cookie: res.headers['Set-Cookie']?.split(';')[0] };
  };
}

test('La llegada no envía saldo y el fallo del envío manual abre incidencia para caja', async () => {
  const env = { ...base, PAYERS_PORTAL: 'true' };
  const store = await openStore(readConfig(env), { memory: true });
  const api = await makeApi(env, { store });
  try {
    const call = harness(api);
    const admin = (await call('login', { method: 'POST', body: { username: 'admin', password: env.ADMIN_PASSWORD } })).cookie;
    const created = await call('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer: 'Cliente', phone: '51911111111',
      consent: true, guests: 1, visitAt: new Date(Date.now() + 3600000).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
    const link = (await call('orders/' + created.data.id + '/link', { method: 'POST', cookie: admin, body: {} })).data.intent;
    await call('payment/' + link.id, { method: 'POST', body: { outcome: 'approved', method: 'yape' } });
    const arrived = await call('orders/' + created.data.id + '/arrive', { method: 'POST', cookie: admin, body: { count: 1, titularPresente: true } });
    assert.equal(arrived.status, 200);
    const current = (await store.get(created.data.id)).data;
    assert.equal(current.intents.filter(item => item.purpose === 'balance').length, 0);
    assert.equal(current.incidents.some(item => item.type === 'Envío del link de saldo pendiente'), false);
    const manual = await call('orders/' + created.data.id + '/message', { method: 'POST', cookie: admin, body: { type: 'balance' } });
    assert.equal(manual.status, 409);
    const afterManual = (await store.get(created.data.id)).data;
    assert.equal(afterManual.intents.filter(item => item.purpose === 'balance').length, 1);
    assert.ok(afterManual.incidents.some(item => item.type === 'Envío del link de saldo pendiente'
      && /plantilla aprobada|Pide al pagador/i.test(item.detail)));
  } finally { await api.close(); }
});

test('Pago rechazado con portal y ventana cerrada crea incidencia y el recordatorio manual fallido queda visible', async () => {
  const env = { ...base, PAYERS_PORTAL: 'true' };
  const store = await openStore(readConfig(env), { memory: true });
  const api = await makeApi(env, { store });
  try {
    const call = harness(api);
    const admin = (await call('login', { method: 'POST', body: { username: 'admin', password: env.ADMIN_PASSWORD } })).cookie;
    const created = await call('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer: 'Cliente', phone: '51911111111',
      consent: true, guests: 1, visitAt: new Date(Date.now() + 3 * 3600000).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
    const link = (await call('orders/' + created.data.id + '/link', { method: 'POST', cookie: admin, body: {} })).data.intent;
    const rejected = await call('payment/' + link.id, { method: 'POST', body: { outcome: 'rejected', method: 'plin' } });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
    let current = (await store.get(created.data.id)).data;
    assert.ok(current.incidents.some(item => item.type === 'Aviso de pago no aprobado pendiente'), JSON.stringify(current.incidents));
    await call('payment/' + link.id, { method: 'POST', body: { outcome: 'approved', method: 'yape' } });
    const failed = await call('orders/' + created.data.id + '/message', { method: 'POST', cookie: admin, body: { type: 'visit' } });
    assert.equal(failed.status, 409);
    current = (await store.get(created.data.id)).data;
    assert.ok(current.incidents.some(item => item.type === 'Recordatorio pendiente'), JSON.stringify(current.incidents));
  } finally { await api.close(); }
});

test('Recordatorio fallido reintenta tras 15 minutos, se entrega al abrir ventana y no se duplica', async () => {
  const env = { ...base, PAYERS_PORTAL: 'false' };
  const store = await openStore(readConfig(env), { memory: true });
  const api = await makeApi(env, { store });
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ messages: [{ id: 'wamid-reminder' }] }); };
  try {
    const call = harness(api);
    const admin = (await call('login', { method: 'POST', body: { username: 'admin', password: env.ADMIN_PASSWORD } })).cookie;
    const settings = (await call('agent/settings', { cookie: admin })).data;
    const weeklySchedule = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(day => [day, null]));
    await call('agent/settings', { method: 'POST', cookie: admin, body: { ...settings, weeklySchedule, reminders: true,
      firstVisitHours: 24, lastVisitHours: 3, contactStart: '00:00', contactEnd: '23:59' } });
    const created = await call('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer: 'Cliente', phone: '51911111111',
      consent: true, guests: 1, visitAt: new Date(Date.now() + 2 * 3600000).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const linked = await call('orders/' + created.data.id + '/link', { method: 'POST', cookie: admin, body: {} });
    assert.equal(linked.status, 200, JSON.stringify(linked.data));
    const link = linked.data.intent;
    await call('payment/' + link.id, { method: 'POST', body: { outcome: 'approved', method: 'yape' } });
    const row = await store.get(created.data.id);
    const key = 'visit:' + row.data.visitAt + ':last';
    row.data.reminders[key] = { at: new Date(Date.now() - 16 * 60000).toISOString(), status: 'failed', attempts: 1 };
    row.data.chat.push({ id: 'incoming', at: new Date().toISOString(), from: row.data.phone, direction: 'in', text: 'hola' });
    await store.save(row.data, row.version);
    const worker = { authorization: 'Bearer ' + env.N8N_AGENT_TOKEN };
    assert.equal((await call('internal/agent/alerts', { method: 'POST', body: {}, headers: worker })).status, 200);
    const retried = (await store.get(created.data.id)).data;
    assert.equal(retried.reminders[key].status, 'sent');
    assert.equal(retried.reminders[key].attempts, 2);
    assert.equal(sent.length, 1);
    await call('internal/agent/alerts', { method: 'POST', body: {}, headers: worker });
    assert.equal(sent.length, 1);
  } finally { await api.close(); globalThis.fetch = originalFetch; }
});

test('Dos alertas simultáneas reclaman un mismo recordatorio y solo una envía', async () => {
  const env = { ...base, PAYERS_PORTAL: 'false' };
  const store = await openStore(readConfig(env), { memory: true });
  const apiA = await makeApi(env, { store: { ...store, close: async () => {} } });
  const apiB = await makeApi(env, { store: { ...store, close: async () => {} } });
  const previousFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); await new Promise(resolve => setTimeout(resolve, 20));
    return Response.json({ messages: [{ id: 'wamid-concurrent' }] }); };
  try {
    const callA = harness(apiA), callB = harness(apiB);
    const admin = (await callA('login', { method: 'POST', body: { username: 'admin', password: env.ADMIN_PASSWORD } })).cookie;
    const settings = (await callA('agent/settings', { cookie: admin })).data;
    const weeklySchedule = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(day => [day, null]));
    await callA('agent/settings', { method: 'POST', cookie: admin, body: { ...settings, weeklySchedule, reminders: true,
      firstVisitHours: 24, lastVisitHours: 3, contactStart: '00:00', contactEnd: '23:59' } });
    const created = await callA('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer: 'Cliente', phone: '51911111111',
      consent: true, guests: 1, visitAt: new Date(Date.now() + 2 * 3600000).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
    const row = await store.get(created.data.id);
    row.data.stage = 'confirmed'; row.data.payments.push({ ref: 'PAGO-ANTICIPO', purpose: 'deposit', amount: row.data.deposit });
    row.data.chat.push({ id: 'ventana', at: new Date().toISOString(), from: row.data.phone, direction: 'in', text: 'hola' });
    const key = 'visit:' + row.data.visitAt + ':last';
    row.data.reminders[key] = { at: new Date(Date.now() - 16 * 60000).toISOString(), status: 'failed', attempts: 1 };
    await store.save(row.data, row.version);
    const worker = { authorization: 'Bearer ' + env.N8N_AGENT_TOKEN };
    const [a, b] = await Promise.all([
      callA('internal/agent/alerts', { method: 'POST', body: {}, headers: worker }),
      callB('internal/agent/alerts', { method: 'POST', body: {}, headers: worker }),
    ]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(sent.length, 1);
    assert.equal((await store.get(created.data.id)).data.reminders[key].status, 'sent');
  } finally { await apiA.close(); await apiB.close(); await store.close(); globalThis.fetch = previousFetch; }
});

test('Como máximo se reintenta un recordatorio fallido en cada ciclo de alertas', async () => {
  const env = { ...base, PAYERS_PORTAL: 'false', WA_ALLOWED_PHONES: '51911111111,51922222222' };
  const store = await openStore(readConfig(env), { memory: true });
  const api = await makeApi(env, { store });
  const previousFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ messages: [{ id: 'wamid-one-retry' }] }); };
  try {
    const call = harness(api);
    const admin = (await call('login', { method: 'POST', body: { username: 'admin', password: env.ADMIN_PASSWORD } })).cookie;
    const settings = (await call('agent/settings', { cookie: admin })).data;
    const weeklySchedule = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(day => [day, null]));
    await call('agent/settings', { method: 'POST', cookie: admin, body: { ...settings, weeklySchedule, reminders: true,
      firstVisitHours: 24, lastVisitHours: 1, contactStart: '00:00', contactEnd: '23:59' } });
    const rows = [];
    for (const [index, phone] of ['51911111111', '51922222222'].entries()) {
      const created = await call('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer: 'Cliente ' + index, phone,
        consent: true, guests: 1, visitAt: new Date(Date.now() + (2 + index) * 3600000).toISOString(),
        items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
      const row = await store.get(created.data.id);
      row.data.stage = 'confirmed'; row.data.payments.push({ ref: 'PAGO-' + index, purpose: 'deposit', amount: row.data.deposit });
      row.data.chat.push({ id: 'ventana-' + index, at: new Date().toISOString(), from: phone, direction: 'in', text: 'hola' });
      const key = 'visit:' + row.data.visitAt + ':first';
      row.data.reminders[key] = { at: new Date(Date.now() - 16 * 60000).toISOString(), status: 'failed', attempts: 1 };
      await store.save(row.data, row.version); rows.push({ id: row.data.id, key });
    }
    const worker = { authorization: 'Bearer ' + env.N8N_AGENT_TOKEN };
    await call('internal/agent/alerts', { method: 'POST', body: {}, headers: worker });
    const current = await Promise.all(rows.map(async item => (await store.get(item.id)).data.reminders[item.key]));
    assert.equal(sent.length, 1);
    assert.equal(current.filter(item => item.attempts === 2).length, 1);
    assert.equal(current.filter(item => item.status === 'failed' && item.attempts === 1).length, 1);
  } finally { await api.close(); globalThis.fetch = previousFetch; }
});

test('Los reclamos de recordatorios atrasados descartan llegada, anticipo pagado y visita modificada', async () => {
  const env = { ...base, PAYERS_PORTAL: 'false', WA_ALLOWED_PHONES: '51911111111,51922222222,51933333333' };
  const baseStore = await openStore(readConfig(env), { memory: true });
  let mutateNextList = false;
  let staleRows = [];
  const store = { ...baseStore, async list() {
    const snapshot = await baseStore.list();
    if (!mutateNextList) return snapshot;
    mutateNextList = false;
    staleRows = snapshot;
    for (const stale of snapshot) {
      const row = await baseStore.get(stale.id);
      if (stale.payer === 'Llegada pendiente') {
        row.data.stage = 'arrived'; row.data.attendance = { at: new Date().toISOString(), count: 1, state: 'confirmed' };
      } else if (stale.payer === 'Anticipo cambió') {
        row.data.stage = 'confirmed'; row.data.payments.push({ ref: 'PAGO-TARDIO', purpose: 'deposit', amount: row.data.deposit });
      } else row.data.visitAt = new Date(Date.now() + 4 * 86400000).toISOString();
      await baseStore.save(row.data, row.version);
    }
    return snapshot;
  } };
  const api = await makeApi(env, { store });
  const previousFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ messages: [{ id: 'wamid-should-not-send' }] }); };
  try {
    const call = harness(api);
    const admin = (await call('login', { method: 'POST', body: { username: 'admin', password: env.ADMIN_PASSWORD } })).cookie;
    const settings = (await call('agent/settings', { cookie: admin })).data;
    const weeklySchedule = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(day => [day, null]));
    await call('agent/settings', { method: 'POST', cookie: admin, body: { ...settings, weeklySchedule, reminders: true,
      initialRequest: true, firstVisitHours: 24, lastVisitHours: 3, contactStart: '00:00', contactEnd: '23:59' } });
    const cases = [
      ['Llegada pendiente', '51911111111', Date.now() + 2 * 3600000, 'visit'],
      ['Anticipo cambió', '51922222222', Date.now() + 3 * 86400000, 'initial'],
      ['Visita cambiada', '51933333333', Date.now() + 2 * 3600000, 'visit'],
    ];
    const ids = [];
    for (const [payer, phone, visitAt] of cases) {
      const created = await call('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer, phone,
        consent: true, guests: 1, visitAt: new Date(visitAt).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
      ids.push(created.data.id);
      const row = await store.get(created.data.id);
      if (payer !== 'Anticipo cambió') {
        row.data.stage = 'confirmed'; row.data.payments.push({ ref: 'PAGO-' + phone, purpose: 'deposit', amount: row.data.deposit });
      }
      row.data.chat.push({ id: 'ventana-' + phone, at: new Date().toISOString(), from: row.data.phone, direction: 'in', text: 'hola' });
      const key = payer === 'Anticipo cambió' ? 'initial:' + row.data.deadline
        : 'visit:' + row.data.visitAt + ':last';
      row.data.reminders[key] = { at: new Date(Date.now() - 16 * 60000).toISOString(), status: 'failed', attempts: 1 };
      await store.save(row.data, row.version);
    }
    mutateNextList = true;
    const worker = { authorization: 'Bearer ' + env.N8N_AGENT_TOKEN };
    const response = await call('internal/agent/alerts', { method: 'POST', body: {}, headers: worker });
    assert.equal(response.status, 200);
    assert.equal(sent.length, 0);
    assert.equal(staleRows.length, 3);
    const current = await Promise.all(ids.map(id => baseStore.get(id)));
    assert.equal(current[0].data.stage, 'arrived');
    assert.equal(current[1].data.stage, 'confirmed');
    assert.notEqual(current[2].data.visitAt, staleRows.find(order => order.payer === 'Visita cambiada').visitAt);
  } finally { await api.close(); globalThis.fetch = previousFetch; }
});
