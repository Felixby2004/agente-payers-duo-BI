import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApi } from '../server/api.mjs';
import { hmac } from '../server/providers.mjs';
import { availabilityConfigured, defaultWeeklySchedule, limaDateTime } from '../server/availability.mjs';
import { readConfig } from '../server/config.mjs';
import { openStore } from '../server/store.mjs';

const env = { PUBLIC_URL: 'https://establo.example', ADMIN_PASSWORD: 'clave-operador-demostracion',
  SESSION_SECRET: 'secreto-de-sesion-de-prueba-con-mas-de-32-caracteres',
  SUPABASE_URL: 'https://db.test.invalid', SUPABASE_SECRET_KEY: 'valor-de-prueba',
  WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0', WA_PHONE_NUMBER_ID: '456', WA_ACCESS_TOKEN: 'token-mock',
  WA_VERIFY_TOKEN: 'verify-mock', WA_APP_SECRET: 'firma-mock', WA_ALLOWED_PHONES: '51911111111',
  PAYMENT_MODE: 'local', AGENT_ORCHESTRATION: 'n8n', N8N_AGENT_TOKEN: 'token-interno-de-prueba-suficiente' };

const fakeRequest = (method, url, body = '', headers = {}) => ({ method, url, headers,
  socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } });
async function call(api, method, path, body, headers = {}) {
  const res = { status: 200, headers: {}, writeHead(status, value = {}) { this.status = status; Object.assign(this.headers, value); },
    setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = String(value); } };
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  await api.middleware(fakeRequest(method, '/api/' + path, raw, headers), res, () => {});
  return { status: res.status, headers: res.headers, data: res.body ? JSON.parse(res.body) : null };
}
function futureLimaDate(days = 4) {
  return new Date(Date.now() + days * 86400000 - 5 * 3600000).toISOString().slice(0, 10);
}
async function login(api) {
  const result = await call(api, 'POST', 'login', { password: env.ADMIN_PASSWORD });
  return { cookie: result.headers['Set-Cookie'].split(';')[0] };
}
function newOrder(visitAt) {
  return { agreed: true, payer: 'Cliente Demo', phone: '51911111111', consent: true, guests: 2, visitAt,
    items: [{ name: 'Parrilla', price: 60000, quantity: 1 }] };
}

test('Permite el alta del panel cuando horario o aforo todavía no están configurados', async () => {
  const api = await makeApi(env, { memory: true });
  try {
    const admin = await login(api), visitAt = new Date(Date.now() + 3 * 86400000).toISOString();
    const result = await call(api, 'POST', 'orders', newOrder(visitAt), admin);
    assert.equal(result.status, 201, JSON.stringify(result.data));
  } finally { await api.close(); }
});

test('Con horario configurado, rechaza el alta fuera de una franja abierta', async () => {
  const api = await makeApi(env, { memory: true });
  try {
    const admin = await login(api), date = futureLimaDate();
    const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const weekday = weekdays[new Date(date + 'T12:00:00Z').getUTCDay()];
    const configuration = (await call(api, 'GET', 'config', undefined, admin)).data;
    configuration.weeklySchedule = Object.fromEntries(Object.keys(defaultWeeklySchedule()).map(day => [day, null]));
    configuration.weeklySchedule[weekday] = { open: '12:00', close: '14:00' };
    configuration.capacityPerSlot = 40;
    const saved = await call(api, 'POST', 'agent/settings', configuration, admin);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const result = await call(api, 'POST', 'orders', newOrder(limaDateTime(date, '15:00')), admin);
    assert.equal(result.status, 409);
    assert.match(result.data.error, /franja disponible/);
  } finally { await api.close(); }
});

test('Sin disponibilidad configurada, WhatsApp deriva la reprogramación y registra una incidencia', async () => {
  const api = await makeApi(env, { memory: true });
  const originalFetch = globalThis.fetch, sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return Response.json({ messages: [{ id: 'wamid.out-' + sent.length }] });
  };
  try {
    const admin = await login(api), visitAt = new Date(Date.now() + 5 * 86400000).toISOString();
    const created = await call(api, 'POST', 'orders', newOrder(visitAt), admin);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const order = created.data;
    const incoming = { id: 'wamid.in-reschedule', from: order.phone, timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text', text: { body: 'reprogramar' } };
    const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: env.WA_PHONE_NUMBER_ID }, messages: [incoming] } }] }] });
    await call(api, 'POST', 'webhooks/whatsapp', payload, { 'x-hub-signature-256': 'sha256=' + hmac(env.WA_APP_SECRET, payload) });
    await call(api, 'POST', 'internal/agent/inbox', {}, { authorization: 'Bearer ' + env.N8N_AGENT_TOKEN });
    let current;
    for (let attempt = 0; attempt < 100; attempt++) {
      current = (await call(api, 'GET', 'orders', undefined, admin)).data.find(item => item.id === order.id);
      if (current.incidents.some(issue => issue.type === 'Solicitud de reprogramación')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(current.incidents.some(issue => issue.type === 'Solicitud de reprogramación'));
    assert.match(sent.at(-1)?.text?.body || '', /disponibilidad aún no está configurada/i);
  } finally { globalThis.fetch = originalFetch; await api.close(); }
});

test('La ausencia de horario o aforo cuenta como disponibilidad sin configurar', () => {
  assert.equal(availabilityConfigured({ weeklySchedule: {}, capacityPerSlot: 40 }), false);
  assert.equal(availabilityConfigured({ weeklySchedule: { mon: { open: '10:00', close: '12:00' } }, capacityPerSlot: 0 }), false);
  assert.equal(availabilityConfigured({ weeklySchedule: { mon: { open: '10:00', close: '12:00' } }, capacityPerSlot: 20 }), true);
});

test('Una configuración anterior a disponibilidad completa los defaults y permite consultar/crear bloqueos', async () => {
  const store = await openStore(readConfig(env), { memory: true });
  await store.saveSettings({ reminders: true, contactStart: '08:00', contactEnd: '22:00' });
  const api = await makeApi(env, { store });
  try {
    const admin = await login(api), date = futureLimaDate(2);
    const availability = await call(api, 'GET', 'availability?date=' + date, undefined, admin);
    assert.equal(availability.status, 200, JSON.stringify(availability.data));
    assert.equal(availability.data.unconfigured, true);
    const created = await call(api, 'POST', 'availability/blocks', { kind: 'day', local_date: date, reason: 'Mantenimiento' }, admin);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal((await call(api, 'GET', 'availability/blocks', undefined, admin)).data.length, 1);
  } finally { await api.close(); }
});

test('El manejador registra errores inesperados con ruta y campos técnicos, ocultando secretos y query', async () => {
  const store = { label: 'store de prueba', async settings() { return null; }, async list() { return []; },
    async availabilityBlocks() {
      const error = new Error('fallo de backend ' + env.WA_ACCESS_TOKEN);
      error.code = 'PGRST_TEST'; error.details = 'detalle ' + env.WA_ACCESS_TOKEN; error.hint = 'sugerencia de prueba';
      throw error;
    }, async close() {} };
  const api = await makeApi(env, { store }), originalError = console.error, logs = [];
  console.error = (...args) => logs.push(args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  try {
    const admin = await login(api);
    const result = await call(api, 'GET', 'availability?date=2026-11-13&token=privado', undefined, admin);
    assert.equal(result.status, 500);
    assert.equal(result.data.error, 'No se pudo completar la operación.');
    assert.match(logs.join('\n'), /GET/);
    assert.match(logs.join('\n'), /\/api\/availability/);
    assert.match(logs.join('\n'), /PGRST_TEST/);
    assert.match(logs.join('\n'), /sugerencia de prueba/);
    assert.match(logs.join('\n'), /stack/);
    assert.match(logs.join('\n'), /details/);
    assert.doesNotMatch(logs.join('\n'), /token-mock|privado/);
  } finally { console.error = originalError; await api.close(); }
});
