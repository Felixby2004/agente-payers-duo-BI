import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApi } from '../server/api.mjs';
import { readConfig } from '../server/config.mjs';
import { createOrder } from '../server/domain.mjs';
import { hmac } from '../server/providers.mjs';
import { openStore } from '../server/store.mjs';

const wakeUrl = 'http://127.0.0.1:5678/webhook/establo-payers-despertar';
const base = { ADMIN_PASSWORD: 'admin-demostracion', PUBLIC_URL: 'https://payers.example',
  SESSION_SECRET: 'secreto-ficticio-largo-para-pruebas', SUPABASE_URL: 'https://db.test.invalid',
  SUPABASE_SECRET_KEY: 'clave-ficticia', WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0',
  WA_PHONE_NUMBER_ID: '456', WA_ACCESS_TOKEN: 'wa-token-ficticio', WA_VERIFY_TOKEN: 'verificacion-ficticia',
  WA_APP_SECRET: 'firma-ficticia', WA_ALLOWED_PHONES: '51911111111', AGENT_ORCHESTRATION: 'n8n',
  N8N_AGENT_TOKEN: 'token-interno-de-prueba-largo-suficiente', N8N_WAKE_URL: wakeUrl };

function request(api, path, { method = 'GET', body = '', headers = {} } = {}) {
  const req = { method, url: '/api/' + path, socket: { remoteAddress: '127.0.0.1' }, headers,
    async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } };
  const res = { status: 200, headers: {}, writeHead(status, fields) {
    this.status = status; this.headersSent = true; Object.assign(this.headers, fields);
  }, setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = value; } };
  return api.middleware(req, res, () => {}).then(() => ({ status: res.status, data: JSON.parse(res.body || 'null') }));
}

function inbound(phone, id) {
  return JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '456' }, messages: [
    { id, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: '¿Puedo reservar una mesa?' } },
  ] } }] }] });
}

async function sendWebhook(api, id) {
  const body = inbound('51911111111', id);
  return request(api, 'webhooks/whatsapp', { method: 'POST', body,
    headers: { 'x-hub-signature-256': 'sha256=' + hmac(base.WA_APP_SECRET, body) } });
}

test('el despertar no espera al webhook de producción inactivo y limita avisos de fallo a uno por minuto', async () => {
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  const waiting = [];
  const warnings = [];
  let markFetchStarted;
  const fetchStarted = new Promise(resolve => { markFetchStarted = resolve; });
  globalThis.fetch = (url, options) => {
    assert.equal(String(url), wakeUrl);
    assert.equal(options.signal?.aborted, false);
    assert.ok(options.signal instanceof AbortSignal);
    markFetchStarted();
    return new Promise(resolve => waiting.push(resolve));
  };
  console.warn = message => warnings.push(String(message));
  const env = { ...base };
  const store = await openStore(readConfig(env), { memory: true });
  const api = await makeApi(env, { store, memory: true });
  try {
    const first = await sendWebhook(api, 'wamid.pending-1');
    assert.equal(first.status, 200);
    await fetchStarted;
    assert.equal(waiting.length, 1, 'el fetch de despertar quedó pendiente mientras el webhook ya respondió');
    waiting.shift()(new Response('{}', { status: 404 }));
    await new Promise(resolve => setImmediate(resolve));

    const second = await sendWebhook(api, 'wamid.pending-2');
    assert.equal(second.status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(waiting.length, 1);
    waiting.shift()(new Response('{}', { status: 503 }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /HTTP 404|despertar n8n/);
    assert.ok(!warnings.join('\n').includes(base.N8N_AGENT_TOKEN));
  } finally {
    console.warn = previousWarn;
    globalThis.fetch = previousFetch;
    await api.close();
  }
});

test('despertar n8n y drenado directo no responden dos veces al mismo mensaje', async () => {
  const previousFetch = globalThis.fetch;
  const env = { ...base };
  const config = readConfig(env);
  const store = await openStore(config, { memory: true });
  const order = createOrder({ agreed: true, payer: 'Cliente de prueba', phone: '51911111111', consent: true,
    guests: 1, visitAt: new Date(Date.now() + 3600000).toISOString(),
    items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] }, config);
  await store.insert(order);

  const wakeStore = new Proxy(store, { get(target, key, receiver) {
    if (key === 'close') return undefined;
    const value = Reflect.get(target, key, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const directApi = await makeApi(env, { store });
  const workflowApi = await makeApi(env, { store: wakeStore });
  let wakeFinished;
  const wakeDone = new Promise(resolve => { wakeFinished = resolve; });
  const sentReplies = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === wakeUrl) {
      assert.equal(options.headers.Authorization, 'Bearer ' + base.N8N_AGENT_TOKEN);
      const result = await request(workflowApi, 'internal/agent/inbox', { method: 'POST', body: '{}',
        headers: { authorization: options.headers.Authorization } });
      wakeFinished(result);
      return Response.json({ accepted: true });
    }
    assert.equal(String(url), 'https://graph.facebook.com/v25.0/456/messages');
    sentReplies.push(JSON.parse(options.body));
    return Response.json({ messages: [{ id: 'wamid.out-' + sentReplies.length }] });
  };
  try {
    assert.equal((await sendWebhook(directApi, 'wamid.same-message')).status, 200);
    await wakeDone;
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = (await store.get(order.id)).data;
      if (current.chat.some(message => message.direction === 'out')) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const current = (await store.get(order.id)).data;
    assert.equal(sentReplies.length, 1);
    assert.equal(current.chat.filter(message => message.direction === 'out').length, 1);
    assert.equal((await store.agentStatus()).filter(job => job.state === 'done').length, 1);
  } finally {
    globalThis.fetch = previousFetch;
    await workflowApi.close();
    await directApi.close();
  }
});

test('N8N_WAKE_URL HTTP solo acepta loopback y el token se envía únicamente al destino configurado', async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.doesNotThrow(() => readConfig({ ...base, N8N_WAKE_URL: `http://${host}:5678/webhook/prueba` }));
  }
  for (const url of ['http://192.168.1.20:5678/webhook/prueba', 'http://127.0.0.2:5678/webhook/prueba',
    'http://localhost.evil:5678/webhook/prueba']) {
    assert.throws(() => readConfig({ ...base, N8N_WAKE_URL: url }), /N8N_WAKE_URL debe usar HTTPS/);
  }

  const previousFetch = globalThis.fetch;
  const requests = [];
  const configuredUrl = 'http://localhost:5678/webhook/mi-destino-configurado';
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response('{}', { status: 404 });
  };
  const env = { ...base, N8N_WAKE_URL: configuredUrl };
  const store = await openStore(readConfig(env), { memory: true });
  const api = await makeApi(env, { store, memory: true });
  try {
    assert.equal((await sendWebhook(api, 'wamid.configured-target')).status, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, configuredUrl);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer ' + base.N8N_AGENT_TOKEN);
    assert.equal(requests[0].options.redirect, 'error');
    assert.ok(!requests[0].url.includes(base.N8N_AGENT_TOKEN));
  } finally {
    globalThis.fetch = previousFetch;
    await api.close();
  }
});
