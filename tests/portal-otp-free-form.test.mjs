import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { makeApi } from '../server/api.mjs';
import { openStore } from '../server/store.mjs';
import { hmac } from '../server/providers.mjs';

const generic = "Si tu número tiene una reserva, recibirás un código por WhatsApp. Si no llega, escribe 'hola' al WhatsApp de El Establo y vuelve a solicitarlo.";
const env = { PAYERS_PORTAL: 'true', ADMIN_PASSWORD: 'admin-de-demostracion', PUBLIC_URL: 'https://establo.test',
  SESSION_SECRET: 'secreto-ficticio-largo-para-pruebas', SUPABASE_URL: 'https://db.test.invalid', SUPABASE_SECRET_KEY: 'ficticio',
  WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0', WA_PHONE_NUMBER_ID: '456', WA_ACCESS_TOKEN: 'token-ficticio',
  WA_VERIFY_TOKEN: 'verify-ficticio', WA_APP_SECRET: 'firma-ficticia', WA_ALLOWED_PHONES: '51911111111,51933333333,51944444444,51955555555',
  WA_BLOCKED_PHONES: '51944444444',
  WA_OTP_FREE_FORM: 'true', AGENT_ORCHESTRATION: 'n8n', N8N_AGENT_TOKEN: 'token-n8n-de-prueba-largo-suficiente' };

function harness(api) {
  return async (path, { method = 'GET', body, cookie } = {}) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = { method, url: '/api/' + path, socket: { remoteAddress: '127.0.0.1' }, headers: { cookie },
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); } };
    const res = { status: 200, headers: {}, writeHead(status, headers) { this.status = status; this.headersSent = true; Object.assign(this.headers, headers); },
      setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; } };
    await api.middleware(req, res, () => {});
    return { status: res.status, data: JSON.parse(res.body || 'null'), cookie: res.headers['Set-Cookie']?.split(';')[0] };
  };
}

test('OTP por texto solo sale con ventana abierta y deja respuesta idéntica si está cerrada', async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  let failDelivery = false;
  globalThis.fetch = async (_url, options) => {
    if (failDelivery) throw new Error('fallo simulado de Meta');
    sent.push(JSON.parse(options.body));
    return Response.json({ messages: [{ id: 'wamid-test' }] });
  };
  const config = { ...env };
  const store = await openStore((await import('../server/config.mjs')).readConfig(config), { memory: true });
  const api = await makeApi(config, { store });
  try {
    const call = harness(api);
    const admin = (await call('login', { method: 'POST', body: { username: 'admin', password: env.ADMIN_PASSWORD } })).cookie;
    const created = await call('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer: 'Cliente OTP', phone: '51911111111',
      consent: true, guests: 1, visitAt: new Date(Date.now() + 86400000).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
    assert.equal(created.status, 201);

    const closed = await call('customer/otp', { method: 'POST', body: { phone: '51911111111' } });
    assert.equal(closed.status, 202);
    assert.equal(closed.data.message, generic);
    assert.equal(sent.length, 0);
    const unknown = await call('customer/otp', { method: 'POST', body: { phone: '51922222222' } });
    assert.equal(unknown.data.message, generic);

    const row = await store.get(created.data.id);
    row.data.chat.push({ id: 'inbound-test', at: new Date().toISOString(), from: row.data.phone, direction: 'in', text: 'hola' });
    await store.save(row.data, row.version);
    const logs = [];
    const oldLog = console.log, oldInfo = console.info, oldError = console.error;
    console.log = console.info = console.error = (...args) => logs.push(args.join(' '));
    let open;
    try { open = await call('customer/otp', { method: 'POST', body: { phone: '51911111111' } }); }
    finally { console.log = oldLog; console.info = oldInfo; console.error = oldError; }
    assert.equal(open.data.message, generic);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'text');
    assert.match(sent[0].text.body, /^Tu código de acceso a El Establo es \d{6}\. Vence en 5 minutos\. No lo compartas\.$/);
    const code = sent[0].text.body.match(/\d{6}/)[0];
    assert.equal(logs.some(line => line.includes(code)), false);
    const fresh = await store.get(created.data.id);
    assert.equal(JSON.stringify({ chat: fresh.data.chat, events: fresh.data.events, incidents: fresh.data.incidents }).includes(code), false);

    const second = await call('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer: 'Cliente OTP 2', phone: '51933333333',
      consent: true, guests: 1, visitAt: new Date(Date.now() + 86400000).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
    const secondRow = await store.get(second.data.id);
    secondRow.data.chat.push({ id: 'inbound-test-2', at: new Date().toISOString(), from: secondRow.data.phone, direction: 'in', text: 'hola' });
    await store.save(secondRow.data, secondRow.version);
    failDelivery = true;
    const errors = [];
    const oldErrorDelivery = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const failed = await call('customer/otp', { method: 'POST', body: { phone: '51933333333' } });
      assert.equal(failed.data.message, generic);
    } finally { console.error = oldErrorDelivery; }
    assert.deepEqual(errors, []);

    for (const [phone, name] of [['51944444444', 'Cliente bloqueado'], ['51955555555', 'Cliente dado de baja']]) {
      const blockedOrder = await call('orders', { method: 'POST', cookie: admin, body: { agreed: true, payer: name, phone,
        consent: true, guests: 1, visitAt: new Date(Date.now() + 86400000).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] } });
      const blockedRow = await store.get(blockedOrder.data.id);
      blockedRow.data.chat.push({ id: 'inbound-' + phone, at: new Date().toISOString(), from: phone, direction: 'in', text: 'hola' });
      await store.save(blockedRow.data, blockedRow.version);
      if (phone === '51955555555') await store.setOptOut(phone, true);
      const noDelivery = await call('customer/otp', { method: 'POST', body: { phone } });
      assert.equal(noDelivery.data.message, generic);
    }
    assert.equal(sent.length, 1);
  } finally {
    await api.close();
    globalThis.fetch = originalFetch;
  }
});

test('Con WA_OTP_FREE_FORM apagado el proveedor sigue requiriendo plantilla', async () => {
  const { providers } = await import('../server/providers.mjs');
  const { readConfig } = await import('../server/config.mjs');
  const config = readConfig({ ...env, WA_OTP_FREE_FORM: 'false', WA_TEMPLATE_OTP: '' });
  await assert.rejects(providers(config).sendOtp('51911111111', '123456'), /configurado/);
});

test('OTP conserva los cinco intentos y el vencimiento de cinco minutos', async () => {
  const { readConfig } = await import('../server/config.mjs');
  const store = await openStore(readConfig(env), { memory: true });
  try {
    const row = await store.insert({ id: randomUUID(), ref: 'EST-OTPTEST', payer: 'Cliente', phone: '51911111111', stage: 'confirmed',
      visitAt: new Date(Date.now() + 86400000).toISOString(), guests: 1, total: 1, items: [], payments: [], receipts: [], incidents: [],
      chat: [], reminders: {}, events: [], intents: [], attendance: null, deadline: new Date(Date.now() + 3600000).toISOString(),
      consent: true, version: 0, createdAt: new Date().toISOString() });
    const id = randomUUID();
    const digest = hmac(env.SESSION_SECRET, 'otp:' + id + ':123456');
    assert.ok(await store.portal('otp_start', { id, phone: row.phone, digest }));
    for (let i = 0; i < 5; i++) assert.equal(await store.portal('otp_verify', { id, digest: hmac(env.SESSION_SECRET, 'otp:' + id + ':000000') }), null);
    assert.equal(await store.portal('otp_verify', { id, digest }), null);
    const sql = await readFile(new URL('../supabase/migrations/006_payers_portal.sql', import.meta.url), 'utf8');
    assert.match(sql, /now\(\)\s*\+\s*interval\s+'5 minutes'/i);
    assert.match(sql, /attempts\s*<\s*5/i);
  } finally { await store.close(); }
});
