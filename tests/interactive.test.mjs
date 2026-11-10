import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { makeApi } from '../server/api.mjs';
import { hmac } from '../server/providers.mjs';
import { confirmationCta, emojis, friendlyDate, limits, listMessage, paymentCta, receiptCta, reservationFocus,
  reservationList, reservationMenu, reservationPrompt } from '../server/interactive.mjs';

test('El agente usa botones, listas y CTA con ids seguros y fallback de texto', async () => {
  const e = {
    PUBLIC_URL: 'https://establo.example', ADMIN_PASSWORD: 'prueba-operador-2026',
    SESSION_SECRET: 'secreto-ficticio-para-pruebas-automatizadas',
    SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'clave-ficticia',
    WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0', WA_PHONE_NUMBER_ID: '456',
    WA_ACCESS_TOKEN: 'wa-ficticio', WA_VERIFY_TOKEN: 'verificacion-ficticia',
    WA_APP_SECRET: 'firma-wa-ficticia', WA_ALLOWED_PHONES: '51999999999,51988888888',
    PAYMENT_MODE: 'local', WA_TEMPLATE_DEPOSIT: 'anticipo_prueba',
    AGENT_ORCHESTRATION: 'n8n', N8N_AGENT_TOKEN: 'token-interno-de-prueba-para-n8n-2026',
  };
  const api = await makeApi(e, { memory: true });
  const server = createServer((req, res) => api.middleware(req, res, () => res.end()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const realFetch = globalThis.fetch;
  const sent = [];
  let messageId = 0, inboundId = 0, failInteractive = false;
  globalThis.fetch = async (url, options) => {
    url = String(url);
    if (url === 'https://graph.facebook.com/v25.0/456/messages') {
      const payload = JSON.parse(options.body);
      sent.push(payload);
      if (failInteractive && payload.type === 'interactive') {
        return new Response(JSON.stringify({ error: { message: 'interactivo no disponible' } }),
          { status: 400, headers: { 'content-type': 'application/json' } });
      }
      return Response.json({ messages: [{ id: 'wamid.out-' + (++messageId) }] });
    }
    if (url.startsWith(origin + '/')) return realFetch(url, options);
    throw new Error('Llamada inesperada en prueba: ' + url);
  };
  let session;
  async function call(path, body, status = 200, headers = {}) {
    const res = await realFetch(origin + '/api/' + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}), ...headers },
    });
    assert.equal(res.status, status, await res.clone().text().catch(() => ''));
    return { res, data: await res.json() };
  }
  const worker = { Authorization: 'Bearer ' + e.N8N_AGENT_TOKEN };
  const drain = async () => (await call('internal/agent/inbox', '{}', 200, worker)).data;
  const buildWebhook = message => JSON.stringify({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: '456' }, messages: [message] } }] }] });
  const receive = async message => {
    const body = buildWebhook({ id: 'wamid.in-' + (++inboundId), timestamp: String(Math.floor(Date.now() / 1000)), ...message });
    await call('webhooks/whatsapp', body, 200, { 'x-hub-signature-256': 'sha256=' + hmac(e.WA_APP_SECRET, body) });
  };
  const answer = async message => {
    const before = sent.length;
    await receive(message);
    await drain();
    return sent.slice(before);
  };
  const bodyOf = payload => payload.text?.body || payload.interactive?.body?.text || '';
  const buttonsOf = payload => payload.interactive?.action?.buttons || [];
  const idsOf = payload => buttonsOf(payload).map(button => button.reply.id);
  const findOrder = async id => (await call('orders', undefined, 200)).data.find(order => order.id === id);
  async function createOrder(phone, payer, hours, guests) {
    const { data } = await call('orders', JSON.stringify({ agreed: true, payer, phone, consent: true, guests,
      visitAt: new Date(Date.now() + hours * 3600000).toISOString(),
      items: [{ name: 'Parrilla familiar', price: 14900, quantity: 1 }] }), 201);
    return data;
  }
  function checkLimits(payload) {
    if (payload.type !== 'interactive') return;
    const interactive = payload.interactive;
    assert.ok(interactive.body.text.length <= limits.body);
    if (interactive.type === 'button') {
      assert.ok(interactive.action.buttons.length <= limits.buttons);
      for (const button of interactive.action.buttons) {
        assert.ok(button.reply.id.length <= limits.id);
        assert.ok(button.reply.title.length <= limits.buttonTitle);
        assert.equal(/[\r\n]/.test(button.reply.title), false);
        assert.equal(/\p{Extended_Pictographic}/u.test(button.reply.title), false);
      }
    }
    if (interactive.type === 'list') {
      assert.ok(interactive.action.button.length <= limits.listButton);
      for (const section of interactive.action.sections) {
        assert.ok(section.title.length <= limits.rowTitle);
        assert.equal(/[\r\n]/.test(section.title), false);
      }
      const rows = interactive.action.sections.flatMap(section => section.rows);
      assert.ok(rows.length <= limits.rows);
      for (const row of rows) {
        assert.ok(row.id.length <= limits.id);
        assert.ok(row.title.length <= limits.rowTitle);
        assert.ok(!row.description || row.description.length <= limits.rowDescription);
        assert.equal(/[\r\n]/.test(row.title), false);
      }
    }
    if (interactive.type === 'cta_url') {
      assert.ok(interactive.action.parameters.display_text.length <= limits.ctaText);
      assert.match(interactive.action.parameters.url, /^https:\/\//);
    }
  }
  try {
    const { res } = await call('login', JSON.stringify({ password: e.ADMIN_PASSWORD }), 200);
    session = res.headers.get('set-cookie').split(';')[0];
    const order = await createOrder('51999999999', 'Ana Demo', 3, 2);
    assert.equal(order.deposit, 4000);

    // Saludo con una sola reserva: menú del estado real.
    let out = await answer({ from: '51999999999', type: 'text', text: { body: 'hola' } });
    assert.equal(out.length, 1);
    assert.equal(out[0].interactive.type, 'button');
    assert.match(bodyOf(out[0]), /Ana Demo/);
    assert.match(bodyOf(out[0]), new RegExp(order.ref));
    assert.match(bodyOf(out[0]), /S\/\s*40/);
    assert.deepEqual(idsOf(out[0]), ['pay:' + order.ref, 'bal:' + order.ref, 'hum:' + order.ref]);
    assert.equal(buttonsOf(out[0]).at(-1).reply.title, 'Hablar con alguien');
    let stored = await findOrder(order.id);
    assert.ok(stored.chat.some(message => message.direction === 'out' && /\[Botones:/.test(message.text)));

    // Pagar anticipo: CTA con enlace y, después, atajos Yape/Plin.
    out = await answer({ from: '51999999999', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'pay:' + order.ref, title: 'Pagar anticipo' } } });
    assert.equal(out.length, 2);
    assert.equal(out[0].interactive.type, 'cta_url');
    assert.match(out[0].interactive.action.parameters.url, /^https:\/\/establo\.example\/pago\//);
    assert.equal(out[1].interactive.type, 'button');
    assert.deepEqual(idsOf(out[1]), ['yape:' + order.ref, 'plin:' + order.ref, 'hum:' + order.ref]);
    stored = await findOrder(order.id);
    assert.equal(stored.incidents.length, 0);
    assert.equal(stored.payments.length, 0);
    assert.ok(stored.intents.length >= 1);

    // Yape simulado: un solo CTA del medio elegido.
    out = await answer({ from: '51999999999', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'yape:' + order.ref, title: 'Pagar con Yape' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].interactive.type, 'cta_url');
    assert.match(bodyOf(out[0]), /Tu anticipo/);
    assert.match(out[0].interactive.action.parameters.display_text, /Yape/);
    assert.match(out[0].interactive.action.parameters.url, /^https:\/\/establo\.example\/pago\//);

    // Ver saldo.
    out = await answer({ from: '51999999999', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'bal:' + order.ref, title: 'Ver saldo' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'text');
    assert.match(bodyOf(out[0]), /Saldo:/);
    assert.match(bodyOf(out[0]), new RegExp(order.ref));

    // Cambiar fecha abre incidencia, sin cambiar la reserva.
    out = await answer({ from: '51999999999', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'chg:' + order.ref, title: 'Cambiar fecha' } } });
    assert.equal(out[0].type, 'text');
    assert.match(bodyOf(out[0]), /^📅/);
    stored = await findOrder(order.id);
    assert.ok(stored.incidents.some(incident => incident.type === 'Solicitud de reprogramación'));
    assert.equal(stored.visitAt, order.visitAt);

    // Ayuda del personal usa el emoji funcional de nota.
    out = await answer({ from: '51999999999', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'hum:' + order.ref, title: 'Hablar con alguien' } } });
    assert.equal(out[0].type, 'text');
    assert.match(bodyOf(out[0]), /^📝/);

    // Constancia inexistente.
    out = await answer({ from: '51999999999', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'rcp:' + order.ref, title: 'Ver constancia' } } });
    assert.match(bodyOf(out[0]), /comprobante/i);

    // Varias reservas: lista, y la selección responde sobre la reserva elegida.
    const second = await createOrder('51999999999', 'Luis Demo', 5, 3);
    out = await answer({ from: '51999999999', type: 'text', text: { body: 'hola' } });
    assert.equal(out.length, 1);
    assert.equal(out[0].interactive.type, 'list');
    assert.equal(out[0].interactive.action.sections[0].title, emojis.deposit + ' Por pagar anticipo');
    assert.equal(out[0].interactive.action.button, 'Ver opciones');
    assert.match(bodyOf(out[0]), /Tienes 2 reservas activas\. Elige la que quieres revisar\./);
    const rowIds = out[0].interactive.action.sections.flatMap(section => section.rows).map(row => row.id);
    assert.ok(rowIds.includes('sel:' + order.ref));
    assert.ok(rowIds.includes('sel:' + second.ref));
    const descriptions = out[0].interactive.action.sections.flatMap(section => section.rows).map(row => row.description);
    assert.ok(descriptions.some(text => /^Falta anticipo S\/ 40\.00 · 2 personas · EST-/.test(text)));
    assert.ok(descriptions.some(text => /^Falta anticipo S\/ 60\.00 · 3 personas · EST-/.test(text)));
    out = await answer({ from: '51999999999', type: 'interactive', interactive: { type: 'list_reply',
      list_reply: { id: 'sel:' + second.ref, title: 'Elegida' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].interactive.type, 'button');
    assert.match(bodyOf(out[0]), /Luis Demo/);
    assert.deepEqual(idsOf(out[0]), ['pay:' + second.ref, 'bal:' + second.ref, 'hum:' + second.ref]);
    const selected = await findOrder(second.id);
    assert.ok(selected.chat.some(message => message.direction === 'out' && message.id));

    // Referencia de otro teléfono: no ejecuta nada y responde con sus reservas.
    const foreign = await createOrder('51988888888', 'Otra Persona', 4, 2);
    const beforeForeign = await findOrder(foreign.id);
    const beforeSecond = await findOrder(second.id);
    out = await answer({ from: '51999999999', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 'pay:' + foreign.ref, title: 'Pagar anticipo' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].interactive.type, 'list');
    const safeRows = out[0].interactive.action.sections.flatMap(section => section.rows).map(row => row.id);
    assert.ok(!safeRows.includes('sel:' + foreign.ref));
    assert.ok(safeRows.includes('sel:' + order.ref));
    assert.ok(safeRows.includes('sel:' + second.ref));
    const afterForeign = await findOrder(foreign.id);
    const afterSecond = await findOrder(second.id);
    assert.equal(afterForeign.intents.length, beforeForeign.intents.length);
    assert.equal(afterForeign.incidents.length, beforeForeign.incidents.length);
    assert.equal(afterForeign.chat.length, beforeForeign.chat.length);
    assert.equal(afterSecond.intents.length, beforeSecond.intents.length);
    assert.equal(afterSecond.incidents.length, beforeSecond.incidents.length);

    // Id no reconocido: se clasifica el título como texto.
    out = await answer({ from: '51988888888', type: 'interactive', interactive: { type: 'button_reply',
      button_reply: { id: 't:2', title: 'saldo' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'text');
    assert.match(bodyOf(out[0]), /Saldo:/);

    // Meta rechaza el interactivo: se reintenta una vez como texto.
    failInteractive = true;
    out = await answer({ from: '51988888888', type: 'text', text: { body: 'hola' } });
    assert.equal(out.length, 2);
    assert.equal(out[0].type, 'interactive');
    assert.equal(out.at(-1).type, 'text');
    assert.match(bodyOf(out.at(-1)), /Hola/);
    assert.match(bodyOf(out.at(-1)), /Pagar anticipo/);
    failInteractive = false;

    // Más de diez reservas: la lista se recorta a diez filas.
    for (let index = 0; index < 9; index++) await createOrder('51999999999', 'Extra ' + index, 6 + index, 1);
    out = await answer({ from: '51999999999', type: 'text', text: { body: 'hola' } });
    assert.equal(out[0].interactive.type, 'list');
    assert.equal(out[0].interactive.action.sections.flatMap(section => section.rows).length, limits.rows);
    assert.match(bodyOf(out[0]), /Mostrando las 10 más relevantes de 11\. Si buscas otra, escríbeme su referencia\./);

    // Comandos de texto antiguos.
    out = await answer({ from: '51999999999', type: 'text', text: { body: 'saldo ' + order.ref } });
    assert.equal(out[0].type, 'text');
    assert.match(bodyOf(out[0]), /Saldo:/);
    out = await answer({ from: '51999999999', type: 'text', text: { body: 'anticipo ' + order.ref } });
    assert.equal(out[0].interactive.type, 'cta_url');
    assert.match(out[0].interactive.action.parameters.url, /\/pago\//);
    out = await answer({ from: '51999999999', type: 'text', text: { body: 'comprobante ' + order.ref } });
    assert.equal(out[0].type, 'text');
    assert.match(bodyOf(out[0]), /comprobante/i);

    // Fuera de la ventana de 24 h: plantilla, nunca interactivo.
    const clock = Date.now;
    try {
      Date.now = () => clock() + 25 * 3600000;
      const relogin = await call('login', JSON.stringify({ password: e.ADMIN_PASSWORD }), 200);
      session = relogin.res.headers.get('set-cookie').split(';')[0];
      const before = sent.length;
      await call('orders/' + order.id + '/message', JSON.stringify({ type: 'deposit' }), 200);
      const outside = sent.slice(before);
      assert.equal(outside.length, 1);
      assert.equal(outside[0].type, 'template');
      assert.equal(outside[0].template.name, 'anticipo_prueba');
    } finally { Date.now = clock; }

    sent.forEach(checkLimits);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
    await api.close();
  }
});

const fixedNow = new Date('2026-11-11T01:00:00Z');
const hoursFromNow = (hours) => new Date(+fixedNow + hours * 3600000).toISOString();
const messageBody = (message) => typeof message === 'string' ? message : message?.body || '';
const oneEmojiAtMost = (text) => (String(text).match(/\p{Extended_Pictographic}/gu) || []).length <= 1;

function demoOrder({ ref, stage = 'awaiting_deposit', visitAt, deadline, guests = 2, total = 14900,
  deposit, payments, incidents = [], receipts = [], payer = 'Ana Demo' }) {
  const amount = deposit ?? 4000 * guests;
  return { id: 'id-' + ref, ref, payer, phone: '51999999999', stage, visitAt: visitAt || hoursFromNow(1),
    deadline: deadline || hoursFromNow(3), guests, total, deposit: amount,
    payments: payments || (stage === 'awaiting_deposit' ? [] : [{ ref: 'SIM-' + ref, amount, purpose: 'deposit', at: hoursFromNow(-1) }]),
    incidents, receipts, chat: [], createdAt: hoursFromNow(-5) };
}

test('Las fechas usan la hora de Lima con Hoy, Mañana y día de la semana', () => {
  assert.equal(friendlyDate('2026-11-11T01:16:00Z', fixedNow), 'Hoy 20:16');
  assert.equal(friendlyDate('2026-11-11T01:16:00Z', fixedNow, true), 'hoy 20:16');
  assert.equal(friendlyDate('2026-11-12T01:00:00Z', fixedNow), 'Mañana 20:00');
  assert.equal(friendlyDate('2026-11-12T01:00:00Z', fixedNow, true), 'mañana 20:00');
  assert.equal(friendlyDate('2026-11-14T02:30:00Z', fixedNow), 'Vie 13 nov · 21:30');
  assert.equal(friendlyDate('2026-11-14T02:30:00Z', fixedNow, true), 'vie 13 nov, 21:30');
  assert.equal(friendlyDate('2026-11-09T15:00:00Z', fixedNow), 'Lun 9 nov · 10:00');
});

test('La lista agrupa por estado, ordena visitas y usa plural y fechas legibles', () => {
  const depositLater = demoOrder({ ref: 'EST-AAAAAAA1', visitAt: hoursFromNow(2), guests: 1 });
  const depositSoon = demoOrder({ ref: 'EST-AAAAAAA2', visitAt: hoursFromNow(1), guests: 2 });
  const depositPast = demoOrder({ ref: 'EST-AAAAAAA3', visitAt: hoursFromNow(-1), deadline: hoursFromNow(3) });
  const confirmed = demoOrder({ ref: 'EST-AAAAAAA4', stage: 'confirmed', visitAt: hoursFromNow(4) });
  const attention = demoOrder({ ref: 'EST-AAAAAAA5', visitAt: hoursFromNow(5), deadline: hoursFromNow(-1) });
  const finished = demoOrder({ ref: 'EST-AAAAAAA6', stage: 'closed', visitAt: hoursFromNow(-2) });
  const list = reservationList([depositLater, depositSoon, depositPast, confirmed, attention, finished], fixedNow);

  assert.deepEqual(list.list.sections.map(section => section.title), [
    emojis.deposit + ' Por pagar anticipo',
    emojis.confirmed + ' Confirmadas',
    emojis.attention + ' Requieren atención',
    emojis.finished + ' Finalizadas',
  ]);
  const depositRows = list.list.sections[0].rows;
  assert.deepEqual(depositRows.map(row => row.id), [
    'sel:EST-AAAAAAA2', 'sel:EST-AAAAAAA1', 'sel:EST-AAAAAAA3',
  ]);
  assert.equal(depositRows[0].title, 'Hoy 21:00');
  assert.equal(depositRows[1].title, 'Hoy 22:00');
  assert.equal(depositRows[2].title, 'Mar 10 nov · 19:00');
  assert.match(depositRows[0].description, /^Falta anticipo S\/ 80\.00 · 2 personas · EST-AAAAAAA2$/);
  assert.match(depositRows[1].description, /^Falta anticipo S\/ 40\.00 · 1 persona · EST-AAAAAAA1$/);
  assert.match(list.list.sections[1].rows[0].description, /^Confirmada · saldo S\/ 69\.00 · 2 personas · EST-AAAAAAA4$/);
  assert.match(list.list.sections[2].rows[0].description, /^Anticipo vencido · 2 personas · EST-AAAAAAA5$/);
  assert.match(list.list.sections[3].rows[0].description, /^Finalizada · 2 personas · EST-AAAAAAA6$/);
  assert.match(list.body, /^Tienes 5 reservas activas\. Elige la que quieres revisar\.$/);
  assert.match(list.fallback, /Falta anticipo S\/ 80\.00/);
  assert.match(list.fallback, /Hoy 21:00/);
  assert.match(list.fallback, /Anticipo vencido/);
});

test('Una sola activa va al menú, varias usan lista y sin activas se elige la finalizada más reciente', () => {
  const active = demoOrder({ ref: 'EST-BBBBBBB1', visitAt: hoursFromNow(2) });
  const secondActive = demoOrder({ ref: 'EST-BBBBBBB2', visitAt: hoursFromNow(3) });
  const olderFinished = demoOrder({ ref: 'EST-BBBBBBB3', stage: 'closed', visitAt: hoursFromNow(-5) });
  const recentFinished = demoOrder({ ref: 'EST-BBBBBBB4', stage: 'closed', visitAt: hoursFromNow(-1),
    receipts: [{ purpose: 'deposit', token: 'token-reciente' }] });

  const single = reservationPrompt([active, olderFinished, recentFinished], fixedNow);
  assert.equal(single.kind, 'buttons');
  assert.match(single.body, new RegExp(active.ref));
  assert.match(single.body, /^🔥/);
  assert.equal(reservationPrompt([active, secondActive], fixedNow).kind, 'list');
  const finishedOnly = reservationPrompt([olderFinished, recentFinished], fixedNow);
  assert.equal(finishedOnly.kind, 'buttons');
  assert.match(finishedOnly.body, /^🍖/);
  assert.equal(finishedOnly.buttons[0].id, 'rcp:' + recentFinished.ref);
  assert.equal(reservationFocus([olderFinished, recentFinished], fixedNow), recentFinished);
  assert.equal(reservationFocus([active, secondActive], fixedNow), null);
});

test('Más de diez reservas se recortan a diez filas con aviso en el cuerpo', () => {
  const many = Array.from({ length: 12 }, (_, index) => demoOrder({ ref: 'EST-C' + String(index).padStart(7, '0'),
    visitAt: hoursFromNow(1 + index) }));
  const list = reservationList(many, fixedNow);
  const rows = list.list.sections.flatMap(section => section.rows);
  assert.equal(rows.length, limits.rows);
  assert.match(list.body, /Mostrando las 10 más relevantes de 12\. Si buscas otra, escríbeme su referencia\./);
});

test('Los límites recortan la referencia antes que el estado y los botones no llevan emojis', () => {
  const longSection = listMessage({ body: 'Opciones', sections: [{ title: '⚠️ Requieren atención con un texto mucho más largo',
    rows: [{ id: 'sel:EST-ABCDEFGH', title: 'Vie 13 nov · 21:30 con texto adicional',
      description: 'Confirmada · saldo S/ 1,234,567.89 · 40 personas · EST-ABCDEFGH' }] }] });
  assert.ok(longSection.list.sections[0].title.length <= limits.rowTitle);
  assert.ok(longSection.list.sections[0].rows[0].title.length <= limits.rowTitle);
  assert.ok(longSection.list.sections[0].rows[0].description.length <= limits.rowDescription);

  const longRef = 'EST-' + 'A'.repeat(40);
  const longOrder = demoOrder({ ref: longRef, stage: 'confirmed', guests: 40, total: 99999999,
    deposit: 160000, visitAt: hoursFromNow(4) });
  const longRow = reservationList([longOrder], fixedNow).list.sections[0].rows[0];
  assert.ok(longRow.description.length <= limits.rowDescription);
  assert.equal(longRow.description.includes(longRef), false);
  assert.match(longRow.description, /^Confirmada/);

  const menu = reservationMenu(demoOrder({ ref: 'EST-DDDDDDD1', stage: 'confirmed', visitAt: hoursFromNow(2) }), fixedNow);
  assert.ok(menu.buttons.every(button => !/\p{Extended_Pictographic}/u.test(button.title)));
  assert.equal((menu.body.match(/\p{Extended_Pictographic}/gu) || []).length, 1);
});

test('Cada situación usa un emoji funcional o temático, sin comida en pagos ni incidencias', () => {
  const valid = demoOrder({ ref: 'EST-EEEEEEE1', visitAt: hoursFromNow(2) });
  const expired = demoOrder({ ref: 'EST-EEEEEEE2', deadline: hoursFromNow(-1) });
  const confirmed = demoOrder({ ref: 'EST-EEEEEEE3', stage: 'confirmed' });
  const terminal = demoOrder({ ref: 'EST-EEEEEEE4', stage: 'cancelled' });
  const menuBodies = [
    messageBody(reservationMenu(valid, fixedNow)),
    messageBody(reservationMenu(expired, fixedNow)),
    messageBody(reservationMenu(confirmed, fixedNow)),
    messageBody(reservationMenu(terminal, fixedNow)),
  ];
  assert.match(menuBodies[0], /^🔥/);
  assert.match(menuBodies[1], /^⚠️/);
  assert.match(menuBodies[2], /^🥩/);
  assert.match(menuBodies[3], /^🍖/);
  menuBodies.forEach(body => assert.ok(oneEmojiAtMost(body)));
  assert.match(messageBody(paymentCta(valid, { amount: 4000 }, 'checkout', 'https://establo.example/pago/1')), /^💳/);
  assert.match(messageBody(receiptCta(valid, 'https://establo.example/comprobante/1')), /^🧾/);
  assert.match(messageBody(confirmationCta(confirmed, 'https://establo.example/comprobante/1', fixedNow)), /^✅/);
  assert.equal(emojis.calendar, '📅');
  assert.equal(emojis.note, '📝');
});
