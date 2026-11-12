import { createHmac, timingSafeEqual } from 'node:crypto';
import { requestJson } from './config.mjs';
import { digits, requireThat } from './domain.mjs';
import { clip, limits } from './interactive.mjs';
import { money, balance, visitText } from '../shared/orders.mjs';

export const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('hex');
export function matches(left, right) {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
const post = (body, token, service, extra = {}) => ({
  method: 'POST', body: JSON.stringify(body), service,
  headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...extra },
});
const textBody = (value) => ({ type: 'text', text: { body: clip(value, limits.body), preview_url: false } });
function interactiveBody(message) {
  const body = clip(message.body, limits.body);
  if (message.kind === 'cta') {
    requireThat(message.cta?.url, 'El enlace del mensaje no está disponible.', 409);
    return { type: 'interactive', interactive: { type: 'cta_url', body: { text: body }, action: { name: 'cta_url',
      parameters: { display_text: clip(message.cta.displayText, limits.ctaText) || 'Abrir', url: String(message.cta.url) } } } };
  }
  if (message.kind === 'list') {
    const source = message.list?.sections?.length ? message.list.sections
      : [{ title: message.list?.title || 'Opciones', rows: message.list?.rows || [] }];
    const sections = [];
    let remaining = limits.rows;
    for (const section of source) {
      if (remaining <= 0) break;
      const rows = (section.rows || []).slice(0, remaining).map(row => ({ id: String(row.id).slice(0, limits.id),
        title: clip(row.title, limits.rowTitle), ...(row.description ? { description: clip(row.description, limits.rowDescription) } : {}) }));
      if (!rows.length) continue;
      remaining -= rows.length;
      sections.push({ title: clip(section.title || 'Opciones', limits.rowTitle), rows });
    }
    requireThat(sections.length > 0, 'La lista no tiene opciones disponibles.', 409);
    return { type: 'interactive', interactive: { type: 'list', body: { text: body }, action: {
      button: clip(message.list?.button || 'Ver opciones', limits.listButton), sections } } };
  }
  const buttons = (message.buttons || []).slice(0, limits.buttons).map(item => ({ type: 'reply',
    reply: { id: String(item.id).slice(0, limits.id), title: clip(item.title, limits.buttonTitle) } }));
  requireThat(buttons.length > 0, 'El mensaje no tiene botones disponibles.', 409);
  return { type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons } } };
}

export function providers(config) {
  const e = config.env;
  const mp = 'https://api.mercadopago.com';
  const mpAuth = { service: 'Mercado Pago', headers: { Authorization: 'Bearer ' + e.MP_TEST_ACCESS_TOKEN } };
  let sellerVerified = false;
  async function verifySeller() {
    if (sellerVerified) return;
    const seller = await requestJson('https://api.mercadolibre.com/users/me', mpAuth);
    const isTest = seller.tags?.includes('test_user') || seller.user_type === 'test_user';
    requireThat(isTest && String(seller.id) === e.MP_TEST_SELLER_ID, 'La credencial no corresponde a la cuenta vendedora de prueba configurada.', 502);
    sellerVerified = true;
  }
  // Un solo POST a Graph para textos, interactivos y plantillas.
  async function submit(phone, body) {
    const result = await requestJson('https://graph.facebook.com/' + e.WA_GRAPH_VERSION + '/' + e.WA_PHONE_NUMBER_ID + '/messages',
      post({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, ...body }, e.WA_ACCESS_TOKEN, 'WhatsApp'));
    requireThat(result.messages?.[0]?.id, 'WhatsApp no devolvió una referencia del mensaje.', 502);
    return result.messages[0].id;
  }
  // Dentro de la ventana de 24 h: texto libre o interactivo con reintento como texto.
  async function deliver(phone, text) {
    if (typeof text === 'string') return submit(phone, textBody(text));
    try { return await submit(phone, interactiveBody(text)); }
    catch (error) {
      const fallback = text?.fallback || text?.body;
      if (!fallback) throw error;
      return submit(phone, textBody(fallback));
    }
  }
  return {
    async downloadMedia(id, limit) {
      requireThat(config.waMode === 'cloud' && /^\d{1,30}$/.test(String(id)), 'Referencia de adjunto inválida.');
      const headers = { Authorization: 'Bearer ' + e.WA_ACCESS_TOKEN };
      const meta = await requestJson('https://graph.facebook.com/' + e.WA_GRAPH_VERSION + '/' + id
        + '?phone_number_id=' + encodeURIComponent(e.WA_PHONE_NUMBER_ID), { service: 'WhatsApp', headers });
      const target = new URL(meta.url);
      requireThat(target.protocol === 'https:' && (['lookaside.fbsbx.com', 'graph.facebook.com'].includes(target.hostname)
        || target.hostname.endsWith('.fbcdn.net')), 'WhatsApp devolvió una dirección de adjunto inesperada.', 502);
      requireThat(Number(meta.file_size || 0) <= limit, 'El adjunto supera el tamaño permitido.');
      const res = await fetch(target, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
      requireThat(res.ok && res.body && Number(res.headers.get('content-length') || 0) <= limit, 'No se pudo descargar el adjunto de WhatsApp.', 502);
      const parts = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        requireThat(size <= limit, 'El adjunto supera el tamaño permitido.');
        parts.push(Buffer.from(chunk));
      }
      requireThat(size > 0, 'El adjunto está vacío.');
      return { bytes: Buffer.concat(parts), mime: String(meta.mime_type || res.headers.get('content-type') || '').split(';')[0] };
    },
    async checkout(order, intent) {
      if (config.paymentMode === 'local') return {};
      await verifySeller();
      const returnUrl = config.publicUrl + '/pago/' + intent.id;
      const buyerEmail = e.MP_TEST_BUYER_EMAIL?.trim();
      const result = await requestJson(mp + '/checkout/preferences', post({
        items: [{ id: intent.id, title: (intent.purpose === 'balance' ? 'Saldo de pedido · ' : 'Anticipo de prueba · ')
          + order.ref, quantity: 1, currency_id: 'PEN', unit_price: intent.amount / 100 }],
        ...(buyerEmail ? { payer: { email: buyerEmail } } : {}),
        external_reference: intent.id,
        notification_url: config.publicUrl + '/api/webhooks/mercado-pago?source_news=webhooks',
        back_urls: { success: returnUrl, pending: returnUrl, failure: returnUrl },
        auto_return: 'approved',
        expires: true, expiration_date_to: intent.expiresAt,
        payment_methods: { installments: 1 },
      }, e.MP_TEST_ACCESS_TOKEN, 'Mercado Pago'));
      requireThat(typeof result.init_point === 'string' && result.init_point,
        'Mercado Pago no devolvió el enlace de Checkout Pro.', 502);
      const checkoutUrl = new URL(result.init_point);
      requireThat(checkoutUrl.protocol === 'https:' && /^(www\.)?mercadopago\.com(\.[a-z]{2})?$/.test(checkoutUrl.hostname),
        'Mercado Pago devolvió un enlace inesperado.', 502);
      return { checkoutUrl: checkoutUrl.href, preferenceId: String(result.id) };
    },
    async payment(id) {
      await verifySeller();
      const p = await requestJson(mp + '/v1/payments/' + encodeURIComponent(id), mpAuth);
      requireThat(String(p.collector_id) === e.MP_TEST_SELLER_ID,
        'El pago no pertenece al vendedor de prueba configurado.', 409);
      // Checkout Pro test users use the standard init_point. In this test-user
      // flow live_mode alone is not a safe discriminator; bind the payment to
      // the configured test buyer as well as the verified test seller.
      requireThat(String(p.payer?.id || '') === e.MP_TEST_BUYER_ID,
        'El pago no proviene del comprador de prueba configurado.', 409);
      requireThat(p.currency_id === 'PEN', 'El pago no está en soles peruanos.', 409);
      return p;
    },
    async paymentsByExternalReference(externalReference) {
      await verifySeller();
      const query = new URLSearchParams({ external_reference: String(externalReference), sort: 'date_created', criteria: 'desc', limit: '10' });
      const result = await requestJson(mp + '/v1/payments/search?' + query, mpAuth);
      return Array.isArray(result.results) ? result.results : [];
    },
    async refund(id, cents, key) {
      await verifySeller();
      return requestJson(mp + '/v1/payments/' + encodeURIComponent(id) + '/refunds',
        post({ amount: cents / 100 }, e.MP_TEST_ACCESS_TOKEN, 'Mercado Pago', { 'X-Idempotency-Key': key }));
    },
    verifyMp(req, url) {
      const fields = Object.fromEntries(String(req.headers['x-signature'] || '').split(',').map(x => x.trim().split('=')));
      const id = (url.searchParams.get('data.id') || '').toLowerCase();
      const requestId = req.headers['x-request-id'];
      if (!id || !requestId || !fields.ts || !fields.v1) return null;
      const expected = hmac(e.MP_WEBHOOK_SECRET, 'id:' + id + ';request-id:' + requestId + ';ts:' + fields.ts + ';');
      return matches(expected, fields.v1) ? id : null;
    },
    async sendWhatsApp(order, text, { template, intent, session: open, reply = false, templateValues, receiptUrlSuffix } = {}) {
      requireThat(config.waMode === 'cloud', 'Conecta WhatsApp Cloud API para enviar mensajes.', 409);
      // Responder a quien escribe no exige consentimiento; iniciar un mensaje sí.
      requireThat((reply || order.consent) && config.isPhoneAllowed(order.phone) && !config.isPhoneBlocked(order.phone),
        'El pagador debe autorizar el contacto y su número debe estar habilitado para la demostración.', 409);
      const session = typeof open === 'boolean' ? open
        : order.chat.some(m => m.direction === 'in' && (!m.from || digits(m.from) === digits(order.phone))
          && Date.now() - +new Date(m.at) < 24 * 3600000);
      if (session) return deliver(order.phone, text);
      const name = { deposit: e.WA_TEMPLATE_DEPOSIT, paymentRejected: e.WA_TEMPLATE_PAYMENT_REJECTED,
        visit: e.WA_TEMPLATE_VISIT, balance: e.WA_TEMPLATE_BALANCE, confirmation: e.WA_TEMPLATE_CONFIRMATION,
        balanceReceipt: e.WA_TEMPLATE_BALANCE_RECEIPT, settlement: e.WA_TEMPLATE_SETTLEMENT,
        reschedule: e.WA_TEMPLATE_RESCHEDULE, noShow: e.WA_TEMPLATE_NO_SHOW }[template];
      requireThat(name, 'Pide al pagador que escriba al número de WhatsApp o configura una plantilla aprobada.', 409);
      const values = templateValues || (['deposit', 'paymentRejected', 'balance'].includes(template) ? [order.payer, order.ref, money(intent.amount)]
        : template === 'reschedule' ? [order.payer, order.ref, visitText(order.visitAt), String(order.rescheduledTo || '')]
        : template === 'settlement' ? [order.payer, order.ref, money(order.total)]
          : [order.payer, order.ref, visitText(order.visitAt), money(balance(order))]);
      const components = [{ type: 'body', parameters: values.map(value => ({ type: 'text', text: value })) }];
      if (['deposit', 'paymentRejected', 'balance'].includes(template)) components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: intent.id }] });
      if (['settlement', 'confirmation', 'balanceReceipt'].includes(template)) components.push({ type: 'button', sub_type: 'url', index: '0',
        parameters: [{ type: 'text', text: receiptUrlSuffix || order.receipts.find(r => r.purpose === template)?.token
          || order.receipts.at(-1)?.token }] });
      return submit(order.phone, { type: 'template', template: { name, language: { code: e.WA_TEMPLATE_LANGUAGE || 'es_PE' }, components } });
    },
    async sendOtp(phone, code, { freeForm = false, session = false } = {}) {
      if (freeForm) {
        requireThat(config.waMode === 'cloud' && session && config.isPhoneAllowed(phone) && !config.isPhoneBlocked(phone),
          'El envío del código aún no está disponible.', 409);
        return deliver(phone, 'Tu código de acceso a El Establo es ' + code + '. Vence en 5 minutos. No lo compartas.');
      }
      requireThat(config.waMode === 'cloud' && e.WA_TEMPLATE_OTP && config.isPhoneAllowed(phone)
        && !config.isPhoneBlocked(phone), 'El envío del código aún no está configurado.', 503);
      const parameters = [{ type: 'text', text: code }];
      return submit(phone, { type: 'template', template: { name: e.WA_TEMPLATE_OTP,
        language: { code: e.WA_TEMPLATE_OTP_LANGUAGE || e.WA_TEMPLATE_LANGUAGE || 'es_PE' },
        components: [{ type: 'body', parameters }, { type: 'button', sub_type: 'url', index: '0', parameters }] } });
    },
    // Solo para responder a un mensaje entrante reciente. Nunca inicia una conversación.
    async sendWhatsAppReply(phone, text) {
      requireThat(config.waMode === 'cloud', 'Conecta WhatsApp Cloud API para enviar mensajes.', 409);
      requireThat(config.isPhoneAllowed(phone) && !config.isPhoneBlocked(phone),
        'El número no está habilitado para la demostración.', 409);
      return deliver(phone, text);
    },
  };
}
