import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { makeApi } from '../server/api.mjs';
import { hmac } from '../server/providers.mjs';
import { readConfig } from '../server/config.mjs';
import { noReservationMessage, parseAction, reservationHelpMessage, texts } from '../server/interactive.mjs';
import { limaDateTime } from '../server/availability.mjs';

const base = () => ({
  PUBLIC_URL: 'https://establo.example', ADMIN_PASSWORD: 'prueba-operador-2026',
  SESSION_SECRET: 'secreto-ficticio-para-pruebas-automatizadas',
  SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'clave-ficticia',
  WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0', WA_PHONE_NUMBER_ID: '456',
  WA_ACCESS_TOKEN: 'wa-ficticio', WA_VERIFY_TOKEN: 'verificacion-ficticia',
  WA_APP_SECRET: 'firma-wa-ficticia',
  PAYMENT_MODE: 'local', AGENT_ORCHESTRATION: 'n8n',
  N8N_AGENT_TOKEN: 'token-interno-de-prueba-para-n8n-2026',
});

async function runtime(extra = {}) {
  const e = { ...base(), ...extra };
  const api = await makeApi(e, { memory: true });
  const server = createServer((req, res) => api.middleware(req, res, () => res.end()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const realFetch = globalThis.fetch;
  const sent = [];
  let outboundId = 0, inboundId = 0, session;
  globalThis.fetch = async (url, options) => {
    url = String(url);
    if (url === 'https://graph.facebook.com/v25.0/456/messages') {
      sent.push(JSON.parse(options.body));
      return Response.json({ messages: [{ id: 'wamid.out-' + (++outboundId) }] });
    }
    if (url.startsWith(origin + '/')) return realFetch(url, options);
    throw new Error('Llamada inesperada en prueba: ' + url);
  };
  async function call(path, body, status = 200, headers = {}) {
    const res = await realFetch(origin + '/api/' + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}), ...headers },
    });
    assert.equal(res.status, status, await res.clone().text().catch(() => ''));
    return { res, data: await res.json() };
  }
  const login = await call('login', JSON.stringify({ password: e.ADMIN_PASSWORD }), 200);
  session = login.res.headers.get('set-cookie').split(';')[0];
  const worker = { Authorization: 'Bearer ' + e.N8N_AGENT_TOKEN };
  const drain = async () => (await call('internal/agent/inbox', '{}', 200, worker)).data;
  const receive = async message => {
    const payload = { id: 'wamid.in-' + (++inboundId), timestamp: String(Math.floor(Date.now() / 1000)), ...message };
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '456' }, messages: [payload] } }] }] });
    await call('webhooks/whatsapp', body, 200, { 'x-hub-signature-256': 'sha256=' + hmac(e.WA_APP_SECRET, body) });
    return payload;
  };
  const answer = async message => {
    const before = sent.length;
    await receive(message);
    await drain();
    return sent.slice(before);
  };
  const createOrder = async (phone, payer, consent = true) => (await call('orders', JSON.stringify({
    agreed: true, payer, phone, consent, guests: 2,
    visitAt: limaDateTime(new Date(Date.now() + 3 * 86400000 - 5 * 3600000).toISOString().slice(0, 10), '12:00'),
    items: [{ name: 'Parrilla familiar', price: 14900, quantity: 1 }],
  }), 201)).data;
  const close = async () => {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
    await api.close();
  };
  return { e, call, sent, answer, receive, drain, createOrder, close };
}

const bodyOf = payload => payload.text?.body || payload.interactive?.body?.text || '';
const idsOf = payload => (payload.interactive?.action?.buttons || []).map(button => button.reply.id);
const orderList = async runtime => (await runtime.call('orders', undefined, 200)).data;

test('El teléfono permitido y bloqueado son opcionales y estrictos', () => {
  const open = readConfig({});
  assert.equal(open.isPhoneAllowed('51911111111'), true);
  assert.equal(open.isPhoneBlocked('51911111111'), false);
  const closed = readConfig({ WA_ALLOWED_PHONES: '+51 999 999 999', WA_BLOCKED_PHONES: '51966666666' });
  assert.equal(closed.isPhoneAllowed('51999999999'), true);
  assert.equal(closed.isPhoneAllowed('51911111111'), false);
  assert.equal(closed.isPhoneBlocked('+51 966 666 666'), true);
  assert.deepEqual(parseAction('staff'), { action: 'staff', ref: null });
  assert.equal(parseAction('staff:EST-12345678'), null);
});

test('Un número sin reserva recibe el aviso, deriva al personal y no ve datos ajenos', async () => {
  const r = await runtime({ WA_RESERVATION_MODE: 'open' });
  try {
    const owner = await r.createOrder('51999999999', 'Ana Demo', true);
    const foreign = await r.createOrder('51988888888', 'Luis Ajeno', true);

    let out = await r.answer({ from: '51911111111', type: 'text', text: { body: 'hola' } });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'interactive');
    assert.equal(out[0].interactive.body.text, texts.noReservation);
    assert.deepEqual(idsOf(out[0]), ['staff']);
    assert.equal(bodyOf(out[0]).includes(owner.ref), false);

    // Anti-eco: el mismo desconocido no recibe otra respuesta dentro de 12 h.
    const before = r.sent.length;
    await r.answer({ from: '51911111111', type: 'text', text: { body: 'buenas tardes' } });
    assert.equal(r.sent.length, before);

    // El modo abierto permite iniciar el alta y explica el formato estructurado.
    const countBeforeIntake = (await orderList(r)).length;
    out = await r.answer({ from: '51922222222', type: 'text', text: { body: 'quiero reservar una mesa' } });
    assert.equal(out.length, 1);
    assert.match(bodyOf(out[0]), /Copia solo el bloque desde RESERVA/);
    assert.equal((await orderList(r)).length, countBeforeIntake, 'una petición de instrucciones no crea un pedido');

    // Los textos fijos tampoco invitan a reservar.
    const fixed = noReservationMessage();
    assert.equal(fixed.body, texts.noReservation);
    assert.match(fixed.fallback, /Si necesitas ayuda, responde «ayuda»\.$/);
    assert.equal(/reservar|reserva nueva|disponibilidad/i.test(fixed.body + fixed.fallback), false);
    assert.match(reservationHelpMessage().body, /solo gestiono los pagos de tu reserva/);

    // La solicitud de otra reserva conserva la admisión y entrega el formato, sin crearla todavía.
    out = await r.answer({ from: '51999999999', type: 'text', text: { body: 'quiero hacer una reserva nueva' } });
    assert.equal(out.length, 1);
    assert.match(bodyOf(out[0]), /Copia solo el bloque desde RESERVA/);
    const stored = (await orderList(r)).find(order => order.id === owner.id);
    assert.equal(stored.incidents.some(incident => incident.type === 'Ayuda del personal' && !incident.resolvedAt), false);

    // Referencia EST- ajena: se trata como número sin reserva y no revela la reserva.
    out = await r.answer({ from: '51911111112', type: 'text', text: { body: 'mi reserva es ' + foreign.ref } });
    assert.equal(out.length, 1);
    assert.equal(out[0].interactive.body.text, texts.noReservation);
    assert.equal(JSON.stringify(out).includes(foreign.ref), false);

    // Id interactivo con referencia ajena desde un número sin reservas: mismo aviso.
    out = await r.answer({ from: '51911111113', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'pay:' + foreign.ref, title: 'Pagar anticipo' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].interactive.body.text, texts.noReservation);
    assert.equal(JSON.stringify(out).includes(foreign.ref), false);

    // El botón staff crea una consulta visible y responde la confirmación.
    out = await r.answer({ from: '51911111114', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'staff', title: 'Hablar con alguien' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'text');
    assert.equal(out[0].text.body, texts.staff);
    let queries = (await r.call('agent/queries', undefined, 200)).data;
    assert.equal(queries.length, 1);
    assert.equal(queries[0].phone, '51911111114');
    assert.equal(queries[0].state, 'open');
    assert.equal(queries[0].message_count, 1);
    assert.ok(queries[0].excerpt.length <= 200);

    // «hola» y «ayuda» no crean consultas.
    await r.answer({ from: '51911111115', type: 'text', text: { body: 'hola' } });
    await r.answer({ from: '51911111115', type: 'text', text: { body: 'ayuda' } });
    queries = (await r.call('agent/queries', undefined, 200)).data;
    assert.equal(queries.some(query => query.phone === '51911111115'), false);

    // La frase de intención human sí crea la consulta.
    out = await r.answer({ from: '51911111116', type: 'text', text: { body: 'quiero hablar con alguien' } });
    assert.equal(out[0].text.body, texts.staff);
    queries = (await r.call('agent/queries', undefined, 200)).data;
    assert.equal(queries.filter(query => query.phone === '51911111116' && query.state === 'open').length, 1);

    // Solo puede haber una consulta abierta por número; los mensajes se cuentan.
    await r.answer({ from: '51911111114', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'staff', title: 'Hablar con alguien' } } });
    queries = (await r.call('agent/queries', undefined, 200)).data;
    const repeated = queries.filter(query => query.phone === '51911111114');
    assert.equal(repeated.filter(query => query.state === 'open').length, 1);
    assert.equal(repeated[0].message_count, 2);

    // El panel puede marcarla como atendida y luego se abre una nueva si vuelve a escribir.
    await r.call('agent/queries/' + repeated[0].id + '/handled', '{}', 200);
    queries = (await r.call('agent/queries', undefined, 200)).data;
    assert.equal(queries.find(query => query.id === repeated[0].id).state, 'handled');
    await r.answer({ from: '51911111114', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'staff', title: 'Hablar con alguien' } } });
    queries = (await r.call('agent/queries', undefined, 200)).data;
    assert.equal(queries.filter(query => query.phone === '51911111114' && query.state === 'open').length, 1);
  } finally { await r.close(); }
});

test('Responder no exige consentimiento y la baja/alta bloquea solo los envíos iniciados', async () => {
  const r = await runtime({ ENABLE_REMINDERS: 'true', WA_TEMPLATE_DEPOSIT: 'anticipo_prueba' });
  try {
    const consented = await r.createOrder('51999999999', 'Con Consentimiento', true);
    const noConsent = await r.createOrder('51988888888', 'Sin Consentimiento', false);

    // Con reserva SIN consentimiento el agente responde a quien escribe.
    let out = await r.answer({ from: '51988888888', type: 'text', text: { body: 'hola' } });
    assert.equal(out.length, 1);
    assert.match(bodyOf(out[0]), new RegExp(noConsent.ref));

    const config = (await r.call('config', undefined, 200)).data;
    await r.call('agent/settings', JSON.stringify({ ...config, reminders: true, initialRequest: true,
      depositReminder: true, contactStart: '00:00', contactEnd: '23:59' }), 200);
    const worker = { Authorization: 'Bearer ' + r.e.N8N_AGENT_TOKEN };
    const beforeAlerts = r.sent.length;
    const alerts = (await r.call('internal/agent/alerts', '{}', 200, worker)).data;
    assert.equal(alerts.sent, 1);
    const proactive = r.sent.slice(beforeAlerts);
    assert.equal(proactive.length, 1);
    assert.equal(proactive[0].to, '51999999999');
    assert.equal(proactive[0].type, 'template');
    assert.equal(proactive.some(payload => payload.to === '51988888888'), false);

    // «stop» se evalúa antes de clasificar y persiste la baja.
    out = await r.answer({ from: '51999999999', type: 'text', text: { body: 'stop' } });
    assert.equal(out.length, 1);
    assert.equal(out[0].text.body, texts.optOut);

    const afterStop = await r.createOrder('51999999999', 'Reserva tras baja', true);
    const beforeBlocked = r.sent.length;
    const blocked = (await r.call('internal/agent/alerts', '{}', 200, worker)).data;
    assert.equal(blocked.sent, 0);
    assert.equal(r.sent.length, beforeBlocked);

    // Sin sesión de chat, el envío manual responde 409 con el mensaje de baja.
    const manual = await r.call('orders/' + afterStop.id + '/message', JSON.stringify({ type: 'deposit' }), 409);
    assert.equal(manual.data.error, 'El cliente se dio de baja de los mensajes');

    // «alta» revierte la baja y el envío manual vuelve a salir.
    out = await r.answer({ from: '51999999999', type: 'text', text: { body: 'alta' } });
    assert.equal(out[0].text.body, texts.optIn);
    await r.call('orders/' + afterStop.id + '/message', JSON.stringify({ type: 'deposit' }), 200);
    assert.equal(r.sent.at(-1).to, '51999999999');
    assert.equal(r.sent.at(-1).type, 'template');

    // La confirmación automática tampoco sale con la baja activa.
    await r.answer({ from: '51999999999', type: 'text', text: { body: 'no quiero mensajes' } });
    const link = (await r.call('orders/' + afterStop.id + '/link', JSON.stringify({}), 200)).data;
    const beforePayment = r.sent.length;
    await r.call('payment/' + link.intent.id, JSON.stringify({ outcome: 'approved' }), 200);
    assert.equal(r.sent.length, beforePayment);
    const verified = (await orderList(r)).find(order => order.id === afterStop.id);
    assert.equal(verified.stage, 'confirmed');
  } finally { await r.close(); }
});

test('WA_ALLOWED_PHONES con valores limita y WA_BLOCKED_PHONES se ignora por completo', async () => {
  const r = await runtime({ WA_ALLOWED_PHONES: '51999999999,51966666666', WA_BLOCKED_PHONES: '51966666666' });
  try {
    await r.createOrder('51966666666', 'Número Bloqueado', true);
    const before = r.sent.length;
    await r.answer({ from: '51966666666', type: 'text', text: { body: 'hola' } });
    await r.answer({ from: '51911111111', type: 'text', text: { body: 'hola' } });
    assert.equal(r.sent.length, before);

    const out = await r.answer({ from: '51999999999', type: 'text', text: { body: 'hola' } });
    assert.equal(out.length, 1);
    assert.equal(out[0].interactive.body.text, texts.noReservation);
  } finally { await r.close(); }
});

test('El límite de tasa avisa una sola vez y no llama a Graph en los mensajes siguientes', async () => {
  const r = await runtime();
  try {
    for (let index = 0; index < 20; index++) {
      await r.answer({ from: '51911111111', type: 'text', text: { body: 'hola' } });
    }
    const before = r.sent.length;
    let out = await r.answer({ from: '51911111111', type: 'text', text: { body: 'hola' } });
    assert.equal(out.length, 1);
    assert.equal(out[0].text.body, texts.rate);
    assert.equal(r.sent.length, before + 1);

    out = await r.answer({ from: '51911111111', type: 'text', text: { body: 'hola' } });
    assert.equal(out.length, 0);
    assert.equal(r.sent.length, before + 1);
  } finally { await r.close(); }
});
