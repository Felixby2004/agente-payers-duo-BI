import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hmac } from '../server/providers.mjs';
import { makeApi } from '../server/api.mjs';
import { limaDateTime } from '../server/availability.mjs';

const fakeRequest = (method, url, body = '', headers = {}) => ({ method, url, headers,
  socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(body); } });
async function call(api, method, path, body, headers = {}) {
  const res = { status: 200, headers: {}, writeHead(status, value = {}) { this.status = status; Object.assign(this.headers, value); },
    setHeader(name, value) { this.headers[name] = value; }, end(value = '') { this.body = String(value); } };
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  await api.middleware(fakeRequest(method, '/api/' + path, raw, headers), res, () => {});
  return { status: res.status, headers: res.headers, data: res.body ? JSON.parse(res.body) : null };
}

test('WhatsApp permite seleccionar y confirmar una reprogramación completa en modo de prueba', async () => {
  const env = { PUBLIC_URL: 'https://establo.example', ADMIN_PASSWORD: 'clave-operador-demostracion',
    SESSION_SECRET: 'secreto-de-sesion-de-prueba-con-mas-de-32-caracteres',
    SUPABASE_URL: 'https://db.test.invalid', SUPABASE_SECRET_KEY: 'solo-valor-ficticio',
    WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0', WA_PHONE_NUMBER_ID: '456', WA_ACCESS_TOKEN: 'token-mock',
    WA_VERIFY_TOKEN: 'verify-mock', WA_APP_SECRET: 'firma-mock', WA_ALLOWED_PHONES: '51911111111',
    WA_TEMPLATE_CONFIRMATION: 'confirmacion_demo', PAYMENT_MODE: 'local', AGENT_ORCHESTRATION: 'n8n',
    N8N_AGENT_TOKEN: 'token-interno-de-prueba-con-longitud-suficiente' };
  const api = await makeApi(env, { memory: true });
  const originalFetch = globalThis.fetch, sent = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://graph.facebook.com/v25.0/456/messages');
    sent.push(JSON.parse(options.body));
    return Response.json({ messages: [{ id: 'wamid.out-' + sent.length }] });
  };
  try {
    const login = await call(api, 'POST', 'login', { password: env.ADMIN_PASSWORD });
    assert.equal(login.status, 200);
    const cookie = login.headers['Set-Cookie'].split(';')[0], admin = { cookie };
    const configured = await call(api, 'GET', 'config', undefined, admin);
    assert.equal((await call(api, 'POST', 'agent/settings', configured.data, admin)).status, 200);
    const targetDay = new Date(Date.now() + 10 * 86400000 - 5 * 3600000).toISOString().slice(0, 10);
    const targetDate = limaDateTime(targetDay, '18:00');
    const create = await call(api, 'POST', 'orders', { agreed: true, payer: 'Cliente Demo', phone: '51911111111', consent: true,
      guests: 2, visitAt: targetDate, items: [{ name: 'Parrilla', price: 60000, quantity: 1 }] }, admin);
    assert.equal(create.status, 201, JSON.stringify(create.data));
    const order = create.data;
    const { data: link } = await call(api, 'POST', 'orders/' + order.id + '/link', {}, admin);
    await call(api, 'POST', 'payment/' + link.intent.id, { outcome: 'approved' });
    for (let attempt = 0; attempt < 100 && !JSON.stringify(sent).includes('Reserva confirmada'); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 50));

    let inbound = 0;
    const reply = async (interactive) => {
      const message = { id: 'wamid.in-' + (++inbound), from: order.phone, timestamp: String(Math.floor(Date.now() / 1000)), ...interactive };
      const payload = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: env.WA_PHONE_NUMBER_ID }, messages: [message] } }] }] });
      const result = await call(api, 'POST', 'webhooks/whatsapp', payload, { 'x-hub-signature-256': 'sha256=' + hmac(env.WA_APP_SECRET, payload) });
      assert.equal(result.status, 200);
      const drained = await call(api, 'POST', 'internal/agent/inbox', {}, { authorization: 'Bearer ' + env.N8N_AGENT_TOKEN });
      assert.equal(drained.data.processed, 1, JSON.stringify(drained.data));
      let conversation;
      for (let attempt = 0; attempt < 100; attempt++) {
        conversation = (await call(api, 'GET', 'orders', undefined, admin)).data.find(item => item.id === order.id)?.chat || [];
        const inboundIndex = conversation.findIndex(item => item.id === message.id);
        if (inboundIndex >= 0 && conversation.slice(inboundIndex + 1).some(item => item.direction === 'out')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const inboundIndex = conversation.findIndex(item => item.id === message.id);
      assert.ok(inboundIndex >= 0 && conversation.slice(inboundIndex + 1).some(item => item.direction === 'out'), JSON.stringify(conversation));
      return sent.at(-1);
    };

    let sentMessage = await reply({ type: 'text', text: { body: 'reprogramar' } });
    assert.equal(sentMessage.interactive.type, 'list');
    const dateRow = sentMessage.interactive.action.sections.flatMap(section => section.rows).find(row => row.id.startsWith('rsd:'));
    assert.ok(dateRow);
    sentMessage = await reply({ type: 'interactive', interactive: { type: 'list_reply', list_reply: dateRow } });
    assert.equal(sentMessage.interactive.type, 'list');
    const timeRow = sentMessage.interactive.action.sections.flatMap(section => section.rows).find(row => row.id.startsWith('rst:'));
    assert.ok(timeRow);
    sentMessage = await reply({ type: 'interactive', interactive: { type: 'list_reply', list_reply: timeRow } });
    assert.equal(sentMessage.interactive.type, 'button');
    const confirmId = sentMessage.interactive.action.buttons.find(button => button.reply.id.startsWith('rsc:')).reply.id;
    const expected = confirmId.slice(('rsc:' + order.ref + ':').length);
    sentMessage = await reply({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: confirmId, title: 'Confirmar' } } });
    let saved;
    for (let attempt = 0; attempt < 100; attempt++) {
      saved = (await call(api, 'GET', 'orders', undefined, admin)).data[0];
      if (+new Date(saved.visitAt) === +new Date(limaDateTime(expected.slice(0, 10), expected.slice(11)))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(sentMessage.text?.body || '', /Visita reprogramada/);
    assert.equal(+new Date(saved.visitAt), +new Date(limaDateTime(expected.slice(0, 10), expected.slice(11))));
    assert.equal(saved.rescheduleCount, 1);
    assert.ok(saved.events.some(event => event.title === 'Visita reprogramada' && event.actor === 'Cliente'));
    assert.ok(sentMessage.text.body.includes(order.ref));
  } finally { globalThis.fetch = originalFetch; await api.close(); }
});
