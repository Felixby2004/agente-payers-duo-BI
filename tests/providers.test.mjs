import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { makeApi } from '../server/api.mjs';
import { hmac } from '../server/providers.mjs';

test('n8n procesa texto, imágenes y voz en WhatsApp y confirma el anticipo desde Mercado Pago', async () => {
  const e = {
    PUBLIC_URL: 'https://establo.example', ADMIN_PASSWORD: 'prueba-operador-2026',
    SESSION_SECRET: 'secreto-ficticio-para-pruebas-automatizadas',
    SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'clave-ficticia',
    WHATSAPP_MODE: 'cloud', WA_GRAPH_VERSION: 'v25.0', WA_PHONE_NUMBER_ID: '456',
    WA_ACCESS_TOKEN: 'wa-ficticio', WA_VERIFY_TOKEN: 'verificacion-ficticia',
    WA_APP_SECRET: 'firma-wa-ficticia', WA_ALLOWED_PHONES: '51999999999,51988888888,51977777777',
    PAYMENT_MODE: 'mercado_pago', MP_TEST_ACCESS_TOKEN: 'mp-ficticio', MP_TEST_SELLER_ID: '123', MP_TEST_BUYER_ID: '3829653747',
    MP_WEBHOOK_SECRET: 'firma-mp-ficticia',
    AGENT_ORCHESTRATION: 'n8n', N8N_AGENT_TOKEN: 'token-interno-de-prueba-para-n8n-2026',
    OPENAI_API_KEY: 'ia-ficticia',
  };
  const api = await makeApi(e, { memory: true });
  const server = createServer((req, res) => api.middleware(req, res, () => res.end()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const realFetch = globalThis.fetch;
  const sent = [];
  let preference, currency = 'USD', amountOverride = null;
  globalThis.fetch = async (url, options) => {
    url = String(url);
    if (url === 'https://api.mercadolibre.com/users/me') return Response.json({ id: 123, tags: ['test_user'] });
    if (url === 'https://api.mercadopago.com/checkout/preferences') {
      preference = JSON.parse(options.body);
      return Response.json({ id: 'preferencia-1', init_point: 'https://www.mercadopago.com.pe/checkout/live',
        sandbox_init_point: 'https://sandbox.mercadopago.com.pe/checkout/test' });
    }
    if (/^https:\/\/api\.mercadopago\.com\/v1\/payments\/\d+$/.test(url)) {
      const paymentId = url.split('/').at(-1);
      return Response.json({ id: paymentId, status: 'approved', collector_id: 123, payer: { id: '3829653747' }, live_mode: true,
        currency_id: currency, external_reference: preference.external_reference,
        transaction_amount: amountOverride ?? preference.items[0].unit_price, date_approved: new Date().toISOString() });
    }
    if (url === 'https://graph.facebook.com/v25.0/456/messages') {
      sent.push(JSON.parse(options.body));
      return Response.json({ messages: [{ id: 'wamid.ficticio-' + sent.length }] });
    }
    if (url === 'https://graph.facebook.com/v25.0/55?phone_number_id=456') return Response.json({
      url: 'https://lookaside.fbsbx.com/imagen', mime_type: 'image/jpeg',
    });
    if (url === 'https://graph.facebook.com/v25.0/56?phone_number_id=456') return Response.json({
      url: 'https://lookaside.fbsbx.com/audio', mime_type: 'audio/ogg',
    });
    if (url === 'https://lookaside.fbsbx.com/imagen' || url === 'https://lookaside.fbsbx.com/audio') return new Response('muestra');
    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      assert.equal(options.body.get('file').name, 'nota.ogg');
      return Response.json({ text: 'Necesito reprogramar mi reserva para mañana' });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      const input = JSON.parse(options.body);
      const isImage = input.input[0].content[0].type === 'input_image';
      const result = isImage ? { kind: 'voucher', amount: 'S/ 40', operation: '987', provider: 'Mercado Pago' } : { intent: 'change' };
      return Response.json({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
    }
    if (String(url).startsWith(origin + '/')) return realFetch(url, options);
    throw new Error('Llamada inesperada en prueba: ' + url);
  };
  let session;
  async function call(path, body, status, headers = {}) {
    const res = await realFetch(origin + '/api/' + path, {
      ...(body === undefined ? {} : { method: 'POST', body }),
      headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}), ...headers },
    });
    assert.equal(res.status, status);
    const data = await res.json();
    return { res, data };
  }
  try {
    await call('orders', undefined, 401);
    const { res } = await call('login', JSON.stringify({ password: e.ADMIN_PASSWORD }), 200);
    session = res.headers.get('set-cookie').split(';')[0];
    const { data: order } = await call('orders', JSON.stringify({
      agreed: true, payer: 'Demo Establo', phone: '+51999999999', consent: true, guests: 2,
      visitAt: new Date(Date.now() + 3 * 3600000).toISOString(), items: [{ name: 'Parrilla familiar', price: 14900, quantity: 1 }],
    }), 201);
    const worker = { Authorization: 'Bearer ' + e.N8N_AGENT_TOKEN };
    const drain = async () => (await call('internal/agent/inbox', '{}', 200, worker)).data;
    await call('internal/agent/inbox', '{}', 401);
    const message = { id: 'wamid.in-ficticio', from: '51999999999', timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text', text: { body: 'anticipo ' + order.ref } };
    const buildWebhook = msg => JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '456' }, messages: [msg] } }] }] });
    const webhook = buildWebhook(message);
    await call('webhooks/whatsapp', webhook, 403);
    const receive = async msg => {
      const body = buildWebhook(msg);
      await call('webhooks/whatsapp', body, 200, { 'x-hub-signature-256': 'sha256=' + hmac(e.WA_APP_SECRET, body) });
    };
    await receive(message);
    await receive(message);
    assert.equal(sent.length, 0);
    assert.equal((await drain()).processed, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, '51999999999');
    assert.equal(sent[0].type, 'interactive');
    assert.equal(sent[0].interactive.type, 'cta_url');
    assert.match(sent[0].interactive.action.parameters.url, /^https:\/\/establo\.example\/pago\//);
    assert.equal(preference.auto_return, 'approved');
    assert.match(sent[0].interactive.action.parameters.url, /^https:\/\/establo\.example\/pago\//);
    assert.match(sent[0].interactive.body.text, /Yape.*Plin/);
    assert.equal(preference.items[0].unit_price, 40);
    assert.equal(preference.items[0].currency_id, 'PEN');
    assert.equal(Object.hasOwn(preference, 'payer'), false);

    await receive({ ...message, id: 'wamid.imagen', type: 'image', text: undefined, image: { id: '55' } });
    assert.equal((await drain()).processed, 1);
    const { data: [evidence] } = await call('orders', undefined, 200);
    assert.equal(evidence.stage, 'awaiting_deposit');
    assert.equal(evidence.payments.length, 0);
    assert.match(evidence.incidents[0].detail, /987/);
    assert.match(sent.at(-1).text.body, /en verificación/);

    await receive({ ...message, id: 'wamid.audio', type: 'audio', text: undefined, audio: { id: '56' } });
    assert.equal((await drain()).processed, 1);
    assert.match(sent.at(-1).text.body, /personal la revisará/);
    assert.match(sent.at(-1).text.body, /^📅/);

    const mpBody = JSON.stringify({ type: 'payment', data: { id: '987' } });
    const signedMp = { 'x-request-id': 'solicitud-1', 'x-signature': 'ts=123,v1='
      + hmac(e.MP_WEBHOOK_SECRET, 'id:987;request-id:solicitud-1;ts:123;') };
    const path = 'webhooks/mercado-pago?data.id=987';
    await call(path, mpBody, 403);
    await call(path, mpBody, 409, signedMp);
    currency = 'PEN';
    await call(path, mpBody, 200, signedMp);
    await call(path, mpBody, 200, signedMp);
    const { data: [verified] } = await call('orders', undefined, 200);
    assert.equal(verified.stage, 'confirmed');
    assert.equal(verified.payments.length, 1);
    assert.equal(verified.payments[0].amount, 4000);
    assert.equal(verified.receipts.length, 1);
    assert.equal(sent.length, 4);
    assert.equal(sent.at(-1).interactive.type, 'cta_url');
    assert.match(sent.at(-1).interactive.body.text, /Anticipo verificado/);
    assert.match(sent.at(-1).interactive.action.parameters.url, /\/comprobante\//);
    assert.ok(verified.incidents.some(i => i.type === 'Solicitud de reprogramación'));

    const { data: returnOrder } = await call('orders', JSON.stringify({
      agreed: true, payer: 'Compra por retorno', phone: '+51999999999', consent: true, guests: 1,
      visitAt: new Date(Date.now() + 3 * 3600000).toISOString(), items: [{ name: 'Parrilla familiar', price: 14900, quantity: 1 }],
    }), 201);
    const { data: returnLink } = await call('orders/' + returnOrder.id + '/link', JSON.stringify({ method: 'checkout' }), 200);
    assert.equal(preference.external_reference, returnLink.intent.id);
    assert.equal(returnLink.intent.checkoutUrl, 'https://www.mercadopago.com.pe/checkout/live');
    const { data: returned } = await call('payment/' + returnLink.intent.id + '?payment_id=987', undefined, 200);
    assert.equal(returned.status, 'approved');
    assert.equal(returned.stage, 'confirmed');
    assert.equal((await call('orders', undefined, 200)).data.find(item => item.id === returnOrder.id).payments.length, 1);
    assert.equal(sent.at(-1).interactive.type, 'cta_url');
    assert.match(sent.at(-1).interactive.body.text, /Anticipo verificado/);

    const { data: rule } = await call('config', undefined, 200);
    await call('agent/settings', JSON.stringify({ ...rule, deadlineMinutes: 1 }), 200);
    const { data: demo } = await call('orders', JSON.stringify({
      agreed: true, payer: 'Demo Plin', synthetic: true, guests: 2,
      visitAt: new Date(Date.now() + 3 * 3600000).toISOString(), items: [{ name: 'Parrilla familiar', price: 14900, quantity: 1 }],
    }), 201);
    const clock = Date.now;
    try {
      Date.now = () => clock() + 2 * 60000;
      assert.equal((await call('internal/agent/alerts', '{}', 200, worker)).data.escalated, 1);
      assert.equal((await call('internal/agent/alerts', '{}', 200, worker)).data.escalated, 0);
    } finally { Date.now = clock; }
    const { data: demoLink } = await call('orders/' + demo.id + '/link', JSON.stringify({ method: 'plin' }), 200);
    await call('payment/' + demoLink.intent.id, JSON.stringify({ outcome: 'approved' }), 200);
    const { data: all } = await call('orders', undefined, 200);
    assert.equal(all.find(o => o.id === demo.id).payments[0].channel, 'plin_demo');

    const { data: balanceOrder } = await call('orders', JSON.stringify({
      agreed: true, payer: 'Saldo Mercado Pago', phone: '+51999999999', consent: true, guests: 1,
      visitAt: new Date(Date.now() + 3 * 3600000).toISOString(), items: [{ name: 'Parrilla familiar', price: 14900, quantity: 1 }],
    }), 201);
    const balancePrefix = 'orders/' + balanceOrder.id + '/';
    const { data: depositLink } = await call(balancePrefix + 'link', JSON.stringify({ method: 'checkout' }), 200);
    preference = { ...preference, external_reference: depositLink.intent.id };
    await call('webhooks/mercado-pago?data.id=989', JSON.stringify({ type: 'payment', data: { id: '989' } }), 200, {
      'x-request-id': 'saldo-deposit-989', 'x-signature': 'ts=123,v1=' + hmac(e.MP_WEBHOOK_SECRET,
        'id:989;request-id:saldo-deposit-989;ts:123;'),
    });
    const { data: arrivedOrder } = await call(balancePrefix + 'arrive', JSON.stringify({ count: 1 }), 200);
    const balancePaymentIntent = arrivedOrder.order.intents.find(item => item.purpose === 'balance');
    assert.ok(balancePaymentIntent);
    assert.equal(balancePaymentIntent.amount, 12900);
    assert.equal(preference.items[0].title, 'Saldo de pedido · ' + balanceOrder.ref);
    const balanceWebhook = { 'x-request-id': 'saldo-mp-990', 'x-signature': 'ts=123,v1=' + hmac(e.MP_WEBHOOK_SECRET,
      'id:990;request-id:saldo-mp-990;ts=123;') };
    const beforeBalanceWebhook = sent.length;
    await call('webhooks/mercado-pago?data.id=990', JSON.stringify({ type: 'payment', data: { id: '990' } }), 200, balanceWebhook);
    await call('webhooks/mercado-pago?data.id=990', JSON.stringify({ type: 'payment', data: { id: '990' } }), 200, balanceWebhook);
    assert.equal(sent.length, beforeBalanceWebhook + 1);
    const { data: afterBalance } = await call('orders', undefined, 200);
    const final = afterBalance.find(item => item.id === balanceOrder.id);
    assert.equal(final.stage, 'closed');
    assert.equal(final.payments.filter(item => item.purpose === 'balance').length, 1);
    assert.ok(final.receipts.some(item => item.purpose === 'balance'));
    assert.ok(final.receipts.some(item => item.purpose === 'settlement'));
    assert.equal(Object.values(final.receiptDeliveries).filter(item => item.status === 'sent').length, 3);
    assert.match(sent.at(-1).interactive.body.text, /ccap\/file-viewer\/receipt/);
    const finalReceipt = final.receipts.find(item => item.purpose === 'settlement');
    const { data: publicFinal } = await call('receipt/' + finalReceipt.token, undefined, 200);
    assert.deepEqual(publicFinal.mercadoPagoReceipts.map(item => item.purpose), ['deposit', 'balance']);

    const { data: shortcutOrder } = await call('orders', JSON.stringify({
      agreed: true, payer: 'Atajo de pago', phone: '+51988888888', consent: true, guests: 1,
      visitAt: new Date(Date.now() + 3 * 3600000).toISOString(), items: [{ name: 'Parrilla familiar', price: 14900, quantity: 1 }],
    }), 201);
    const shortcutPrefix = 'orders/' + shortcutOrder.id + '/';
    const shortcutSession = { ...message, id: 'wamid.in-shortcut-session', from: '51988888888',
      timestamp: String(Math.floor(Date.now() / 1000)), text: { body: 'hola' } };
    await receive(shortcutSession); await drain();
    const { data: shortcutDeposit } = await call(shortcutPrefix + 'link', JSON.stringify({ method: 'checkout' }), 200);
    const shortcutDepositNotice = { 'x-request-id': 'shortcut-deposit-992', 'x-signature': 'ts=123,v1=' + hmac(e.MP_WEBHOOK_SECRET,
      'id:992;request-id:shortcut-deposit-992;ts:123;') };
    await call('webhooks/mercado-pago?data.id=992', JSON.stringify({ type: 'payment', data: { id: '992' } }), 200, shortcutDepositNotice);
    const { data: shortcutArrived } = await call(shortcutPrefix + 'arrive', JSON.stringify({ count: 1 }), 200);
    const autoLink = shortcutArrived.order.intents.find(item => item.purpose === 'balance');
    const preferenceIdBeforeShortcut = preference.external_reference;
    assert.equal(preferenceIdBeforeShortcut, autoLink.id);
    const beforeShortcut = sent.length;
    await receive({ ...shortcutSession, id: 'wamid.in-pay-shortcut', text: { body: 'pagar saldo' } }); await drain();
    assert.equal(sent.length, beforeShortcut + 1);
    assert.match(sent.at(-1).interactive.action.parameters.url, new RegExp('/pago/' + autoLink.id + '$'));
    assert.equal(preference.external_reference, autoLink.id);
    const badAmountNotice = { 'x-request-id': 'bad-balance-997', 'x-signature': 'ts=123,v1=' + hmac(e.MP_WEBHOOK_SECRET,
      'id:997;request-id:bad-balance-997;ts=123;') };
    amountOverride = 0.01;
    await call('webhooks/mercado-pago?data.id=997', JSON.stringify({ type: 'payment', data: { id: '997' } }), 200, badAmountNotice);
    await call('webhooks/mercado-pago?data.id=997', JSON.stringify({ type: 'payment', data: { id: '997' } }), 200, badAmountNotice);
    amountOverride = null;
    const { data: afterBadAmount } = await call('orders', undefined, 200);
    const wrongBalance = afterBadAmount.find(item => item.id === shortcutOrder.id);
    assert.equal(wrongBalance.payments.filter(item => item.purpose === 'balance').length, 0);
    assert.equal(wrongBalance.incidents.filter(item => item.type === 'Pago por revisar').length, 1);

    const { data: raceOrder } = await call('orders', JSON.stringify({
      agreed: true, payer: 'Carrera caja y online', phone: '+51977777777', consent: true, guests: 1,
      visitAt: new Date(Date.now() + 3 * 3600000).toISOString(), items: [{ name: 'Parrilla familiar', price: 14900, quantity: 1 }],
    }), 201);
    const racePrefix = 'orders/' + raceOrder.id + '/';
    const raceDeposit = await call(racePrefix + 'link', JSON.stringify({ method: 'checkout' }), 200);
    const raceDepositNotice = { 'x-request-id': 'race-deposit-995', 'x-signature': 'ts=123,v1=' + hmac(e.MP_WEBHOOK_SECRET,
      'id:995;request-id:race-deposit-995;ts:123;') };
    await call('webhooks/mercado-pago?data.id=995', JSON.stringify({ type: 'payment', data: { id: '995' } }), 200, raceDepositNotice);
    const raceArrival = await call(racePrefix + 'arrive', JSON.stringify({ count: 1 }), 200);
    const raceIntent = raceArrival.data?.order?.intents?.find(item => item.purpose === 'balance')
      || raceArrival.order.intents.find(item => item.purpose === 'balance');
    await call(racePrefix + 'counter', JSON.stringify({ channel: 'cash' }), 200);
    const lateNotice = { 'x-request-id': 'race-late-996', 'x-signature': 'ts=123,v1=' + hmac(e.MP_WEBHOOK_SECRET,
      'id:996;request-id:race-late-996;ts=123;') };
    await call('webhooks/mercado-pago?data.id=996', JSON.stringify({ type: 'payment', data: { id: '996' } }), 200, lateNotice);
    const { data: afterRace } = await call('orders', undefined, 200);
    const raced = afterRace.find(item => item.id === raceOrder.id);
    assert.equal(raced.intents.find(item => item.id === raceIntent.id).status, 'superseded');
    assert.equal(raced.payments.filter(item => item.purpose === 'balance').length, 1);
    assert.equal(raced.payments.find(item => item.purpose === 'balance').channel, 'cash');
    assert.ok(raced.unappliedPayments.some(item => item.intentId === raceIntent.id));
    assert.ok(raced.incidents.some(item => item.type === 'Pago por revisar'));
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
    await api.close();
  }
});
