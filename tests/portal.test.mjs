import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeApi } from '../server/api.mjs';
import { readConfig } from '../server/config.mjs';
import { openStore } from '../server/store.mjs';
import { limaDateKey } from '../server/availability.mjs';
import { isArrivalReport, paymentPromise } from '../server/customer-intents.mjs';
import { hmac } from '../server/providers.mjs';

const env = { PAYERS_PORTAL: 'true', ADMIN_PASSWORD: 'admin-de-demostracion', PUBLIC_URL: 'https://establo.test',
  SESSION_SECRET: 'secreto-ficticio-largo-para-probar', SUPABASE_URL: 'https://db.test.invalid',
  SUPABASE_SECRET_KEY: 'base-ficticia', WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0',
  WA_PHONE_NUMBER_ID: '456', WA_ACCESS_TOKEN: 'token-mock', WA_VERIFY_TOKEN: 'verify-mock', WA_APP_SECRET: 'firma-mock',
  WA_TEMPLATE_CONFIRMATION: 'confirmacion', WA_TEMPLATE_SETTLEMENT: 'liquidacion', WA_TEMPLATE_BALANCE: 'saldo',
  AGENT_ORCHESTRATION: 'n8n', N8N_AGENT_TOKEN: 'token-interno-de-prueba-suficiente' };

function harness(api) {
  return async (path, { method = 'GET', body, cookie, headers = {} } = {}) => {
    const raw = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body);
    const req = { method, url: '/api/' + path, socket: { remoteAddress: '127.0.0.1' },
      headers: { cookie, ...headers }, async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); } };
    const res = { status: 200, headers: {},
      writeHead(status, fields) { this.status = status; this.headersSent = true; Object.assign(this.headers, fields); },
      setHeader(name, value) { this.headers[name] = value; },
      end(value = '') { this.body = value; },
    };
    await api.middleware(req, res, () => {});
    return { status: res.status, data: Buffer.isBuffer(res.body) ? res.body : JSON.parse(res.body || 'null'),
      cookie: res.headers['Set-Cookie']?.split(';')[0] };
  };
}

test('Se reconoce una hora pactada en Lima y se distingue de un aviso de llegada', () => {
  const now = new Date('2026-11-11T18:00:00Z');
  assert.equal(paymentPromise('Pago hoy a las 7 p. m.', now).at, '2026-11-12T00:00:00.000Z');
  assert.equal(paymentPromise('Pago a las 7', now).ambiguous, true);
  assert.equal(paymentPromise('Ya pagué a las 7', now), null);
  assert.equal(isArrivalReport('Hola, ya llegué al restaurante'), true);
  assert.equal(isArrivalReport('Todavía no llegué'), false);
});

test('Portal OTP, caja y PDF operan con permisos separados y asistencia verificada', async () => {
  const originalFetch = globalThis.fetch;
  const sends = [], otp = [];
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^https:\/\/graph\.facebook\.com\//);
    sends.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ messages: [{ id: 'wa-' + sends.length }] }));
  };
  const api = await makeApi(env, { memory: true, deliverOtp: (phone, code) => otp.push({ phone, code }) });
  try {
    const call = harness(api);
    async function post(path, body, cookie, expected = 200, headers = {}) {
      const result = await call(path, { method: 'POST', body, cookie, headers });
      assert.equal(result.status, expected, JSON.stringify(result.data));
      return result;
    }
    const admin = (await post('login', { username: 'admin', password: env.ADMIN_PASSWORD })).cookie;
    const newStaff = await post('staff', { username: 'cajero01', name: 'Cajero 01', role: 'cashier', password: 'cajero-de-demostracion' }, admin);
    const cashier = (await post('login', { username: 'cajero01', password: 'cajero-de-demostracion' })).cookie;
    assert.equal((await call('staff', { cookie: cashier })).status, 403);
    assert.equal((await post('agent/settings', {}, cashier, 403)).status, 403);
    const visitAt = new Date(Date.now() + 4 * 60000).toISOString();
    const day = limaDateKey(new Date());
    const draft = { agreed: true, payer: 'Cliente de prueba', phone: '911111111', consent: true, guests: 2, visitAt,
      items: [{ name: 'Parrilla', price: 12500, quantity: 2, discount: 1000 }] };
    const order = (await post('orders', draft, cashier, 201)).data;
    const other = (await post('orders', { ...draft, phone: '51922222222' }, admin, 201)).data;
    assert.equal(order.total, 24000);
    async function approveDeposit(target) {
      const link = (await post('orders/' + target.id + '/link', {}, cashier)).data.intent;
      assert.equal(Object.hasOwn((await call('payment/' + link.id)).data, 'options'), false);
      return post('payment/' + link.id, { outcome: 'approved', method: 'checkout' });
    }
    await approveDeposit(order);
    await approveDeposit(other);
    const unknown = await post('customer/otp', { phone: '51933333333' }, undefined, 202);
    assert.equal(otp.length, 0);
    assert.match(unknown.data.id, /^[0-9a-f-]+$/);
    const { data: challenge } = await post('customer/otp', { phone: '911111111' }, undefined, 202);
    assert.equal(otp[0].phone, '51911111111');
    await post('customer/verify', { id: challenge.id, code: otp[0].code === '000000' ? '000001' : '000000' }, undefined, 401);
    const customer = (await post('customer/verify', { id: challenge.id, code: otp[0].code })).cookie;
    await post('customer/verify', { id: challenge.id, code: otp[0].code }, undefined, 401);
    const portal = await call('customer/orders', { cookie: customer });
    assert.deepEqual(portal.data.orders.map(r => r.id), [order.id]);
    assert.equal((await call('orders', { cookie: customer })).status, 403);
    const otherOrder = (await call('orders', { cookie: admin })).data.find(r => r.id === other.id);
    const publicReceipt = await call('receipt/' + otherOrder.receipts[0].token);
    assert.equal(publicReceipt.status, 200, 'el token de constancia permite abrir el comprobante directo sin pasar por /cliente');
    assert.equal(publicReceipt.data.token, otherOrder.receipts[0].token);
    assert.equal((await call('receipt/' + portal.data.orders[0].receipts[0].token, { cookie: customer })).status, 200);
    assert.equal((await call('receipt/' + portal.data.orders[0].receipts[0].token)).status, 200);

    async function whatsapp(id, text) {
      const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '456' },
        messages: [{ id, from: order.phone, timestamp: String(Math.floor(Date.now()/1000)), type: 'text', text: { body: text } }] } }] }] });
      await post('webhooks/whatsapp', body, undefined, 200, { 'x-hub-signature-256': 'sha256=' + hmac(env.WA_APP_SECRET, body) });
      await post('internal/agent/inbox', {}, undefined, 200, { authorization: 'Bearer ' + env.N8N_AGENT_TOKEN });
    }
    await whatsapp('arrival-1', 'Hola, ya llegué');
    const pending = (await call('orders', { cookie: cashier })).data.find(r => r.id === order.id);
    assert.equal(pending.attendance.state, 'pending');
    assert.equal(pending.stage, 'confirmed');
    const prefix = 'orders/' + order.id + '/';
    await post(prefix + 'message', { type: 'balance' }, cashier, 409);
    const arrived = (await post(prefix + 'arrive', { count: 2, titularPresente: true }, cashier)).data.order;
    assert.equal(arrived.attendance.staffId, newStaff.data.id);
    assert.equal(arrived.intents.filter(i => i.purpose === 'balance').length, 0);
    await whatsapp('receipt-1', 'Quiero ver mis comprobantes');
    assert.match(sends.at(-1).text.body, /https:\/\/establo.test\/cliente/);

    const manualResult = await post(prefix + 'message', { type: 'balance' }, cashier);
    const link = manualResult.data.order.intents.find(i => i.purpose === 'balance');
    assert.ok(link, 'el envío manual desde el panel debe emitir el enlace de saldo');
    const paid = (await post(prefix + 'counter', { channel: 'cash' }, cashier)).data.order;
    assert.equal(paid.payments.at(-1).amount, 20000);
    assert.equal(paid.payments.at(-1).staffId, newStaff.data.id);
    assert.equal(paid.receipts.at(-1).amount, 24000);
    assert.equal(paid.intents.find(i => i.id === link.id).status, 'superseded');
    await post('payment/' + link.id, { outcome: 'approved', method: 'plin' }, undefined, 409);
    const pdf = await call('reports/pdf?measure=M5&from=' + day + '&to=' + day, { cookie: admin });
    assert.equal(pdf.status, 200);
    assert.match(pdf.data.toString('latin1'), /^%PDF-1.4/);
    assert.match(pdf.data.toString('latin1'), new RegExp(order.ref));
    assert.doesNotMatch(pdf.data.toString('latin1'), new RegExp(other.ref));
    assert.equal((await call('reports/pdf?measure=M3&from=' + day + '&to=' + day, { cookie: cashier })).status, 403);
    const attendancePdf = await call('reports/pdf?measure=M3&from=' + day + '&to=' + day, { cookie: admin });
    assert.match(attendancePdf.data.toString('latin1'), /Cajero 01/);
    assert.doesNotMatch(attendancePdf.data.toString('latin1'), new RegExp(other.ref));
  } finally {
    await api.close();
    globalThis.fetch = originalFetch;
  }
});


test('El anticipo reutiliza el enlace vigente, limita nuevas emisiones y vence desde n8n', async () => {
  const config = { PAYERS_PORTAL: 'true', ADMIN_PASSWORD: env.ADMIN_PASSWORD,
    AGENT_ORCHESTRATION: 'n8n', N8N_AGENT_TOKEN: env.N8N_AGENT_TOKEN };
  const store = await openStore(readConfig(config), { memory: true });
  const api = await makeApi(config, { store, memory: true });
  try {
    const call = harness(api);
    const admin = await call('login', { method: 'POST', body: { username: 'admin', password: config.ADMIN_PASSWORD } });
    const post = (path, body) => call(path, { method: 'POST', body, cookie: admin.cookie });
    const order = (await post('orders', { agreed: true, payer: 'Pagador de prueba', phone: '51944444444',
      guests: 1, visitAt: new Date(Date.now() + 3600000).toISOString(), items: [{ name: 'Combo', price: 8000, quantity: 1 }] })).data;
    const endpoint = 'orders/' + order.id + '/link';
    for (let i = 1; i <= 3; i++) {
      const link = await post(endpoint, {});
      assert.equal(link.status, 200);
      assert.equal(link.data.intent.number, i);
      assert.equal((await post(endpoint, {})).data.intent.id, link.data.intent.id);
    assert.equal((await post('payment/' + link.data.intent.id, { outcome: 'rejected', method: 'checkout' })).status, 200);
    }
    assert.equal((await post(endpoint, {})).status, 409);
    const stored = await store.get(order.id);
    stored.data.deadline = new Date(Date.now()-23*3600000).toISOString();
    assert.equal(await store.save(stored.data, stored.version), true);
    const alerts = () => call('internal/agent/alerts', { method: 'POST', headers: { authorization: 'Bearer ' + config.N8N_AGENT_TOKEN } });
    const tick = await alerts();
    assert.equal(tick.status, 200);
    assert.equal((await store.get(order.id)).data.stage, 'awaiting_deposit', 'no cancelar antes de las 24 h de gracia');
    const expired = await store.get(order.id);
    expired.data.deadline = new Date(Date.now()-25*3600000).toISOString();
    assert.equal(await store.save(expired.data, expired.version), true);
    assert.equal((await alerts()).status, 200);
    assert.equal((await store.get(order.id)).data.stage, 'cancelled');
    assert.equal((await alerts()).status, 200);
    assert.equal((await store.get(order.id)).data.events.filter(event => event.title === 'Cancelada por falta de anticipo').length, 1,
      'un segundo ciclo no duplica la cancelación');
  } finally { await api.close(); }
});

