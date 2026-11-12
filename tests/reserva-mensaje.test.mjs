import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { makeApi } from '../server/api.mjs';
import { readConfig } from '../server/config.mjs';
import { hmac } from '../server/providers.mjs';
import { limaDateKey, limaDateTime } from '../server/availability.mjs';
import { parseReservation, reservationKey, texts } from '../server/interactive.mjs';
import { menu } from '../shared/samples.mjs';

const fixedNow = new Date('2026-11-10T17:00:00.000Z');
const validMessage = (overrides = {}) => ({
  Nombre: 'Ana Cárdenas',
  Fecha: '2026-11-12',
  Hora: '20:00',
  Personas: '4',
  Items: '2x Parrilla familiar, 1x Jarra de chicha morada',
  ...overrides,
});
const reservationText = fields => ['RESERVA', ...Object.entries(fields).map(([name, value]) => `${name}: ${value}`)].join('\n');

function futureLimaDate(days = 2) {
  const date = new Date(Date.now() + days * 86400000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return parts.filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => part.value).join('-');
}

function integrationText(fields = {}, date = futureLimaDate()) {
  return reservationText({
    Nombre: 'Cliente de Prueba',
    Fecha: date,
    Hora: '20:00',
    Personas: '4',
    Items: '2x Parrilla familiar, 1x Jarra de chicha morada',
    ...fields,
  });
}

const baseEnv = () => ({
  PUBLIC_URL: 'https://establo.example',
  ADMIN_PASSWORD: 'prueba-operador-2026',
  SESSION_SECRET: 'secreto-ficticio-para-pruebas-automatizadas',
  SUPABASE_URL: 'https://db.example',
  SUPABASE_SECRET_KEY: 'clave-ficticia',
  WHATSAPP_MODE: 'cloud',
  WA_GRAPH_VERSION: 'v25.0',
  WA_PHONE_NUMBER_ID: '456',
  WA_ACCESS_TOKEN: 'wa-ficticio',
  WA_VERIFY_TOKEN: 'verificacion-ficticia',
  WA_APP_SECRET: 'firma-wa-ficticia',
  PAYMENT_MODE: 'local',
  AGENT_ORCHESTRATION: 'n8n',
  N8N_AGENT_TOKEN: 'token-interno-de-prueba-para-n8n-2026',
  WA_RESERVATION_MODE: 'open',
});

async function runtime(extra = {}) {
  const env = { ...baseEnv(), ...extra };
  const api = await makeApi(env, { memory: true });
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
    const response = await realFetch(origin + '/api/' + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}), ...headers },
    });
    assert.equal(response.status, status, await response.clone().text().catch(() => ''));
    return { response, data: await response.json() };
  }
  const login = await call('login', JSON.stringify({ password: env.ADMIN_PASSWORD }));
  session = login.response.headers.get('set-cookie').split(';')[0];
  const worker = { Authorization: 'Bearer ' + env.N8N_AGENT_TOKEN };
  const drain = async () => (await call('internal/agent/inbox', '{}', 200, worker)).data;
  const receive = async (message, id = 'wamid.in-' + (++inboundId)) => {
    const payload = {
      id,
      timestamp: String(Math.floor(Date.now() / 1000)),
      from: '51911111111',
      type: 'text',
      text: { body: integrationText() },
      ...message,
    };
    const body = JSON.stringify({ entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '456' }, messages: [payload],
    } }] }] });
    await call('webhooks/whatsapp', body, 200, {
      'x-hub-signature-256': 'sha256=' + hmac(env.WA_APP_SECRET, body),
    });
    return payload;
  };
  const answer = async (message, id) => {
    const before = sent.length;
    await receive(message, id);
    await drain();
    return sent.slice(before);
  };
  const orders = async () => (await call('orders', undefined)).data;
  const close = async () => {
    globalThis.fetch = realFetch;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
    await api.close();
  };
  return { env, call, sent, receive, answer, drain, orders, worker, close };
}

const outgoingBody = payload => payload.text?.body || payload.interactive?.body?.text || '';

test('Un saludo muestra el menú principal aunque el cliente tenga varias reservas activas', async () => {
  const r = await runtime();
  try {
    for (let index = 1; index <= 3; index++) {
      const visitAt = new Date(Date.now() + (index + 2) * 86400000).toISOString();
      const input = { agreed: true, payer: 'Cliente de prueba', phone: '51911111111', consent: true,
        guests: 1, visitAt, items: [{ name: 'Parrilla familiar', price: 3900, quantity: 1 }] };
      await r.call('orders', JSON.stringify(input), 201);
    }
    const sent = await r.answer({ from: '51911111111', text: { body: 'Hola' } }, 'wamid.greeting-menu');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'interactive');
    assert.equal(sent[0].interactive.type, 'button');
    assert.match(sent[0].interactive.body.text, /¿Qué te gustaría hacer\?/);
    assert.deepEqual(sent[0].interactive.action.buttons.map(item => item.reply.title),
      ['Ver mis reservas', 'Hacer una reserva', 'Hablar con alguien']);
  } finally { await r.close(); }
});

test('Ver mis reservas desde el botón del flujo de alta abre una lista dentro de WhatsApp', async () => {
  const r = await runtime();
  try {
    const input = { agreed: true, payer: 'Cliente de prueba', phone: '51911111111', consent: true,
      guests: 2, visitAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      items: [{ name: 'Parrilla familiar', price: 3900, quantity: 2 }] };
    const created = await r.call('orders', JSON.stringify(input), 201);
    const sent = await r.answer({ from: '51911111111', text: { body: '' }, type: 'interactive',
      interactive: { button_reply: { id: 'orders', title: 'Ver mis reservas' } } }, 'wamid.orders-list');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'interactive');
    assert.equal(sent[0].interactive.type, 'list');
    assert.match(sent[0].interactive.body.text, /Mis reservas/);
    const rows = sent[0].interactive.action.sections.flatMap(section => section.rows);
    assert.ok(rows.some(row => row.title === created.data.ref));
    assert.match(rows.find(row => row.title === created.data.ref).description, /📅/);
    assert.doesNotMatch(JSON.stringify(sent[0]), /\/cliente/);
  } finally { await r.close(); }
});

test('parseReservation valida el formato con remitente único, catálogo y hora Lima', () => {
  const complete = parseReservation(reservationText(validMessage({ Notas: 'Cumpleaños' })), fixedNow);
  assert.equal(complete.ok, true);
  assert.equal(complete.value.name, 'Ana Cárdenas');
  assert.equal(complete.value.phone, undefined);
  assert.equal(complete.value.visitAt, '2026-11-13T01:00:00.000Z');
  assert.equal(complete.value.guests, 4);
  assert.equal(complete.value.items[0].price, menu.find(item => item.name === 'Parrilla familiar').price);
  assert.equal(complete.value.items[0].quantity, 2);

  const tolerant = parseReservation(reservationText({
    nombre: 'Luis Demo',
    fecha: '2026-11-12',
    hora: '20:00',
    personas: '2',
    productos: '1x Picana a la parrilla',
  }), fixedNow);
  assert.equal(tolerant.ok, true);
  assert.equal(tolerant.value.phone, undefined);
  assert.equal(tolerant.value.items[0].name, 'Picaña a la parrilla');
  const exactlyTwoHours = parseReservation(reservationText({ ...validMessage(), Fecha: '2026-11-10', Hora: '15:00' }),
    new Date('2026-11-10T18:00:00.000Z'));
  assert.equal(exactlyTwoHours.ok, true);
  assert.equal(parseReservation('quiero reservar una mesa', fixedNow), null);
  assert.equal(parseReservation('RESERVA', fixedNow).ok, false);

  const missingName = parseReservation(reservationText({ ...validMessage(), Nombre: '' }), fixedNow);
  assert.equal(missingName.error, texts.reservationMissingName);
  const withoutDate = { ...validMessage() };
  delete withoutDate.Fecha;
  delete withoutDate.Hora;
  const missingDate = parseReservation(reservationText(withoutDate), fixedNow);
  assert.equal(missingDate.error, texts.reservationMissingDate);
  assert.equal(parseReservation(reservationText({ ...validMessage(), Personas: undefined }), fixedNow).error, texts.reservationPeopleRange);
  const withoutItems = { ...validMessage() };
  delete withoutItems.Items;
  assert.equal(parseReservation(reservationText(withoutItems), fixedNow).error, texts.reservationMissingItems);
  assert.match(parseReservation(reservationText({ ...validMessage(), Fecha: '31/12/2026' }), fixedNow).error, /AAAA-MM-DD/);
  assert.match(parseReservation(reservationText({ ...validMessage(), Fecha: '2026-02-30' }), fixedNow).error, /AAAA-MM-DD/);
  assert.match(parseReservation(reservationText({ ...validMessage(), Fecha: '2026-11-10', Hora: '13:00' }), fixedNow).error,
    /al menos 2 horas de anticipación.*fecha y hora mínima permitida es 2026-11-10 14:00/);
  const lateEvening = new Date('2026-11-12T03:20:00.000Z'); // 22:20 del 11 nov. en Lima
  const nextDayMinimum = parseReservation(reservationText({ ...validMessage(), Fecha: '2026-11-11', Hora: '22:30' }), lateEvening);
  assert.match(nextDayMinimum.error, /fecha y hora mínima permitida es 2026-11-12 00:20/);
  const quickReservation = parseReservation(reservationText({ ...validMessage(), Fecha: '2026-11-11', Hora: '22:36' }), lateEvening, 5);
  assert.equal(quickReservation.ok, true);
  assert.match(parseReservation(reservationText({ ...validMessage(), Hora: '25:00' }), fixedNow).error, /AAAA-MM-DD/);
  assert.match(parseReservation(reservationText({ ...validMessage(), Hora: '9:00' }), fixedNow).error, /AAAA-MM-DD/);
  for (const guests of ['0', '41']) {
    assert.equal(parseReservation(reservationText({ ...validMessage(), Personas: guests }), fixedNow).error, texts.reservationPeopleRange);
  }
  assert.match(parseReservation(reservationText({ ...validMessage(), Items: '1x Producto inexistente' }), fixedNow).error, /No conozco el producto/);
  assert.match(parseReservation(reservationText({ ...validMessage(), Items: '0x Parrilla familiar' }), fixedNow).error, /entre 1 y 100/);
  assert.match(parseReservation(reservationText({ ...validMessage(), Items: '101x Parrilla familiar' }), fixedNow).error, /entre 1 y 100/);
  for (const field of ['Telefono: 51999999999', 'Consentimiento: si']) {
    const rejected = parseReservation(reservationText(validMessage()) + '\n' + field, fixedNow);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, 'Las reservas se registran con el número desde el que escribes. Quita esas líneas y vuelve a enviar el bloque.');
  }
  assert.match(parseReservation(reservationText({ ...validMessage(), Notas: 'x'.repeat(501) }), fixedNow).error, /500 caracteres/);
  assert.equal(parseReservation(reservationText({ ...validMessage(), Items: Array(31).fill('1x Parrilla familiar').join(', ') }), fixedNow).error, texts.reservationLineLimit);
  assert.match(parseReservation(reservationText({ ...validMessage(), Items: '1x Parrilla familiar,,' }), fixedNow).error, /formato "2x Producto"/);
  assert.match(parseReservation(reservationText({ ...validMessage(), Items: '1x Parrilla familiar S/ 20' }), fixedNow).error, /No conozco el producto/);
  assert.match(parseReservation(reservationText({ ...validMessage(), Nombre: 'Ana', Pagador: 'Luis' }), fixedNow).error, /aparece más de una vez/);
  assert.equal(reservationKey({ phone: '+51 999', date: '2026-11-12', guests: 2,
    items: [{ name: 'Picaña a la parrilla', quantity: 1 }] }),
  reservationKey({ phone: '51999', date: '2026-11-12', guests: 2,
    items: [{ name: 'Picana a la parrilla', quantity: 1 }] }));
});

test('RESERVA crea una reserva PAYERS con catálogo, anticipo, CTA y chat trazable', async () => {
  const r = await runtime();
  try {
    const message = integrationText();
    const incoming = await r.receive({ from: '51911111111', text: { body: message } });
    assert.equal((await r.drain()).processed, 1);
    const [order] = await r.orders();
    assert.equal(order.payer, 'Cliente de Prueba');
    assert.equal(order.phone, '51911111111');
    assert.equal(order.consent, true);
    assert.equal(order.guests, 4);
    assert.equal(order.total, 31600);
    assert.equal(order.deposit, 8000);
    assert.equal(order.stage, 'awaiting_deposit');
    assert.equal(order.items[0].price, menu.find(item => item.name === 'Parrilla familiar').price);
    assert.equal(order.items[1].price, menu.find(item => item.name === 'Jarra de chicha morada').price);
    assert.deepEqual(order.chat.filter(item => item.direction === 'in').map(item => item.id), [incoming.id]);
    assert.ok(order.events.some(event => event.title === 'Pedido recibido por WhatsApp'));
    assert.ok(order.events.some(event => event.title === 'Origen: cliente'));
    assert.equal(order.events.some(event => event.title === 'Pedido recibido de LEADS'), false);
    assert.equal(order.synthetic, false);
    assert.equal(order.chat.some(item => item.direction === 'out' && item.text.includes('[Botón: Pagar anticipo]')), true);
    assert.equal(r.sent.length, 1);
    assert.equal(r.sent[0].to, '51911111111');
    assert.equal(r.sent[0].type, 'interactive');
    assert.equal(r.sent[0].interactive.type, 'cta_url');
    assert.equal(r.sent[0].interactive.action.parameters.display_text, 'Pagar anticipo');
    assert.match(r.sent[0].interactive.body.text, /Total: S\/\s*316\.00/);
    assert.match(r.sent[0].interactive.body.text, /Anticipo: \*S\/\s*80\.00\*/);
    assert.match(r.sent[0].interactive.action.parameters.url, /^https:\/\/establo\.example\/pago\//);

    const detail = (await r.orders()).find(item => item.id === order.id);
    assert.equal(detail.ref, order.ref);
    assert.equal(detail.items.length, 2);
    assert.equal(Object.hasOwn(detail, 'origin'), false);
  } finally { await r.close(); }
});

test('Dedupe por message.id e idempotencia por teléfono/fecha/personas/items', async () => {
  const r = await runtime();
  try {
    const date = futureLimaDate();
    const first = integrationText({}, date);
    await r.answer({ from: '51911111111', text: { body: first } }, 'wamid.same');
    const sentAfterFirst = r.sent.length;
    await r.answer({ from: '51911111111', text: { body: first } }, 'wamid.same');
    assert.equal(r.sent.length, sentAfterFirst);
    assert.equal((await r.orders()).length, 1);

    const repeated = integrationText({
      Nombre: 'Otro nombre',
      Hora: '21:00',
      Items: '1x Jarra de chicha morada, 1x Parrilla familiar, 1x Parrilla familiar',
    }, date);
    const out = await r.answer({ from: '51911111111', text: { body: repeated } }, 'wamid.new');
    assert.equal((await r.orders()).length, 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'text');
    assert.match(out[0].text.body, /^Ya tengo esta reserva registrada: EST-[A-F0-9]{8}\.$/);
  } finally { await r.close(); }
});

test('RESERVA rechaza Teléfono y Consentimiento y registra con el número remitente', async () => {
  const r = await runtime({
    ENABLE_REMINDERS: 'true',
    WA_TEMPLATE_DEPOSIT: 'anticipo_demo',
    WA_RESERVATION_MODE: 'open',
  });
  try {
    const sender = '51911111111';
    for (const field of ['Telefono: 51922222222', 'Consentimiento: si']) {
      const out = await r.answer({ from: sender, text: { body: integrationText() + '\n' + field } });
      assert.match(outgoingBody(out[0]), /Las reservas se registran con el número desde el que escribes/);
    }
    assert.equal((await r.orders()).length, 0);
    const registered = await r.answer({ from: sender, text: { body: integrationText() } });
    assert.match(outgoingBody(registered[0]), /Reserva registrada/);
    let orders = await r.orders();
    const ownReservation = orders.find(order => order.phone === sender);
    assert.ok(ownReservation);
    assert.equal(orders.length, 1);
    assert.equal(ownReservation.chat.find(item => item.direction === 'in').from, sender);

    const config = (await r.call('config')).data;
    await r.call('agent/settings', JSON.stringify({
      ...config, reminders: true, initialRequest: false, depositReminder: true,
      depositReminderMinutes: 1, visitReminder: false, contactStart: '00:00', contactEnd: '23:59',
    }));
    const originalNow = Date.now;
    try {
      Date.now = () => originalNow() + 2 * 60000;
      const before = r.sent.length;
      const alerts = (await r.call('internal/agent/alerts', '{}', 200, r.worker)).data;
      assert.equal(alerts.sent, 1);
      assert.equal(r.sent.length, before + 1);
      assert.equal(r.sent.at(-1).to, sender);
    } finally { Date.now = originalNow; }
    orders = await r.orders();
    assert.equal(orders.find(order => order.phone === sender).reminders['deposit:' + ownReservation.deadline]?.status, 'sent');
  } finally { await r.close(); }
});

test('Validación fallida queda como consulta y los límites bloquean sin alta', async () => {
  const r = await runtime();
  try {
    const invalid = await r.answer({ from: '51911111111', text: { body: reservationText({
      Nombre: 'Ana', Fecha: futureLimaDate(), Hora: '20:00', Personas: '2',
    }) } }, 'wamid.invalid');
    assert.match(outgoingBody(invalid[0]), /Falta el detalle del pedido/);
    assert.equal((await r.orders()).length, 0);
    let queries = (await r.call('agent/queries')).data;
    assert.equal(queries.length, 1);
    assert.equal(queries[0].phone, '51911111111');

    for (let index = 0; index < 3; index++) {
      await r.answer({ from: '51911111112', text: { body: integrationText({
        Hora: `${20 + index}:00`,
      }, futureLimaDate(index + 2)) } }, 'wamid.limit-' + index);
    }
    const blocked = await r.answer({ from: '51911111112', text: { body: integrationText({
      Hora: '23:00',
    }, futureLimaDate(6)) } }, 'wamid.limit-4');
    assert.equal((await r.orders()).filter(order => order.phone === '51911111112').length, 3);
    assert.match(outgoingBody(blocked[0]), /ya tiene 3 reservas abiertas/);
    queries = (await r.call('agent/queries')).data;
    assert.ok(queries.some(query => query.phone === '51911111112'));
  } finally { await r.close(); }
});

test('El máximo de reservas abiertas se configura desde Agente y alertas y se aplica al alta WhatsApp', async () => {
  const r = await runtime();
  try {
    const config = (await r.call('config')).data;
    assert.equal(config.maxOpenReservationsPerPhone, 3);
    assert.equal(config.settingsDefaults.minReservationNoticeMinutes, 120);
    await r.call('agent/settings', JSON.stringify({ ...config, maxOpenReservationsPerPhone: 2, minReservationNoticeMinutes: 5 }));
    const sender = '51922222222';
    for (let index = 0; index < 3; index++) {
      const result = await r.answer({ from: sender, text: { body: integrationText({ Hora: `${20 + index}:00` }, futureLimaDate(index + 2)) } },
        'wamid.max-config-' + index);
      if (index < 2) assert.match(outgoingBody(result[0]), /Reserva registrada/);
      else assert.match(outgoingBody(result[0]), /ya tiene 2 reservas abiertas/);
    }
    assert.equal((await r.orders()).filter(order => order.phone === sender).length, 2);
    const saved = (await r.call('config')).data;
    assert.equal(saved.minReservationNoticeMinutes, 5);
    await assert.rejects(() => r.call('agent/settings', JSON.stringify({ ...saved, maxOpenReservationsPerPhone: 0 })), /Revisa los importes y plazos/);
  } finally { await r.close(); }
});

test('Modos off y staff protegen el alta; alta de cliente consiente y texto libre sigue derivando', async () => {
  assert.equal(readConfig({}).reservationMode, 'off');
  assert.equal(readConfig({
    WA_RESERVATION_MODE: 'staff',
    WA_RESERVATION_STAFF: '+51 900 000 001',
  }).canReserve('51900000001'), true);

  const off = await runtime({ WA_RESERVATION_MODE: 'off' });
  try {
    const out = await off.answer({ from: '51911111111', text: { body: integrationText() } });
    assert.equal((await off.orders()).length, 0);
    assert.equal(out.length, 1);
    assert.equal(out[0].text.body, texts.reservationUnavailable);
  } finally { await off.close(); }

  const staff = await runtime({ WA_RESERVATION_MODE: 'staff', WA_RESERVATION_STAFF: '51900000001' });
  try {
    const out = await staff.answer({ from: '51911111111', text: { body: integrationText() } });
    assert.equal((await staff.orders()).length, 0);
    assert.equal(out[0].text.body, texts.reservationUnavailable);
    await staff.answer({ from: '51900000001', text: { body: integrationText() } });
    assert.equal((await staff.orders()).length, 1);
  } finally { await staff.close(); }

  const open = await runtime();
  try {
    const freeText = await open.answer({ from: '51911111111', text: { body: 'quiero reservar una mesa' } });
    assert.equal((await open.orders()).length, 0);
    assert.equal(freeText[0].interactive.type, 'button');
    assert.match(freeText[0].interactive.body.text, /Copia solo el bloque desde RESERVA/);
    const own = await open.answer({ from: '51922222222', text: { body: integrationText() } });
    const order = (await open.orders()).find(item => item.phone === '51922222222');
    assert.ok(order);
    assert.equal(order.chat.find(item => item.direction === 'in').from, '51922222222');
    assert.equal(own[0].interactive.type, 'cta_url');
    const rejected = await open.answer({ from: '51933333333', text: { body: integrationText({
      Telefono: '51944444444',
    }) } });
    assert.match(outgoingBody(rejected[0]), /Las reservas se registran con el número desde el que escribes/);
    assert.equal((await open.orders()).some(item => item.phone === '51944444444'), false);
  } finally { await open.close(); }
});

test('Las reservas nuevas entran al ciclo de pago, constancia, recordatorio y alerta por vencimiento', async () => {
  const RealDate = globalThis.Date;
  const stableDay = limaDateKey(new RealDate());
  const stableNow = +new RealDate(limaDateTime(stableDay, '12:00'));
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [stableNow])); }
    static now() { return stableNow; }
    static parse(value) { return RealDate.parse(value); }
    static UTC(...args) { return RealDate.UTC(...args); }
  };
  const r = await runtime({ ENABLE_REMINDERS: 'true', WA_RESERVATION_MODE: 'open' });
  try {
    const currentSettings = (await r.call('config')).data;
    await r.call('agent/settings', JSON.stringify({
      ...currentSettings, reminders: true, initialRequest: false, depositReminder: false,
      visitReminder: true, firstVisitHours: 168, lastVisitHours: 3,
      contactStart: '00:00', contactEnd: '23:59',
    }));
    await r.answer({ from: '51911111111', text: { body: integrationText() } }, 'wamid.full-cycle');
    let order = (await r.orders())[0];
    assert.equal(order.stage, 'awaiting_deposit');
    const intent = order.intents[0];
    await r.call('payment/' + intent.id, JSON.stringify({ outcome: 'approved' }));
    order = (await r.orders()).find(item => item.id === order.id);
    assert.equal(order.stage, 'confirmed');
    assert.equal(order.receipts.some(receipt => receipt.purpose === 'deposit'), true);
    const receipt = order.receipts.find(item => item.purpose === 'deposit');
    const publicReceipt = (await r.call('receipt/' + receipt.token)).data;
    assert.equal(publicReceipt.ref, order.ref);
    assert.equal(publicReceipt.purpose, 'deposit');
    assert.equal(r.sent.at(-1).interactive.type, 'cta_url');
    assert.match(r.sent.at(-1).interactive.action.parameters.url, /\/comprobante\//);

    const timeToVisit = +new Date(order.visitAt) - Date.now();
    assert.ok(timeToVisit > 0 && timeToVisit <= 168 * 3600000,
      'La visita está fuera del rango de recordatorio configurado: ' + timeToVisit);
    const alerts = (await r.call('internal/agent/alerts', '{}', 200, r.worker)).data;
    assert.equal(alerts.sent, 1, JSON.stringify({ alerts, reminders: order.reminders }));
    assert.ok(r.sent.some(payload => payload.to === '51911111111'));
  } finally { globalThis.Date = RealDate; await r.close(); }
});

test('Una reserva sin pagar tras vencer el plazo genera una alerta interna', async () => {
  const r = await runtime({
    ENABLE_REMINDERS: 'false',
    DEPOSIT_DEADLINE_MINUTES: '1',
    WA_RESERVATION_MODE: 'open',
  });
  try {
    await r.answer({ from: '51944444444', text: { body: integrationText() } }, 'wamid.expired');
    const [order] = await r.orders();
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 2 * 60000;
      const result = (await r.call('internal/agent/alerts', '{}', 200, r.worker)).data;
      assert.equal(result.escalated, 1);
    } finally { Date.now = realNow; }
    const [withAlert] = await r.orders();
    assert.equal(withAlert.stage, 'awaiting_deposit');
    assert.ok(withAlert.incidents.some(incident => incident.type === 'Anticipo vencido'));
    assert.ok(order.deadline);
  } finally { await r.close(); }
});
