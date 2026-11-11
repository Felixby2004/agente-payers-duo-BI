import { randomUUID, createHash } from 'node:crypto';
import { readConfig } from './config.mjs';
import { openStore, updateOrder } from './store.mjs';
import { providers, hmac, matches } from './providers.mjs';
import { agentAI } from './agent-ai.mjs';
import { contactTime, defaults, validateSettings } from './agent-settings.mjs';
import { balance, depositDue, money, terminal, stageLabels } from '../shared/orders.mjs';
import { displayText, emojis, friendlyDate, parseAction, reservationFocus, reservationMenu, reservationPrompt, reservationList,
  paymentCta, balancePaymentCta, paymentRejectedCta, receiptCta, confirmationCta, requestMessage, noReservationMessage, reservationHelpMessage,
  reservationRequest, parseReservation, reservationKey, reservationConfirmation, reservationRepeatedMessage, rescheduleDaysMessage,
  rescheduleTimesMessage, rescheduleConfirmMessage, texts } from './interactive.mjs';
import { Problem, requireThat, createOrder, addEvent, openIssue, applyPayment, arrive, recordCounterPayment, issueReceipt, reschedule, endReservation, digits } from './domain.mjs';
import { checkRescheduleEligibility, getAvailableSlots, getDayOccupancy, isSlotBlocked, limaDateKey, limaDateTime, validateSlotInput } from './availability.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const instant = () => new Date().toISOString();
const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
function isMercadoPagoInitPoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /^(www\.)?mercadopago\.com(\.[a-z]{2})?$/.test(url.hostname);
  } catch { return false; }
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new Problem('Solicitud demasiado grande.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parse(raw) {
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { throw new Problem('El contenido de la solicitud no es válido.'); }
}

export async function makeApi(env, options = {}) {
  const config = readConfig(env);
  const store = await openStore(config, options);
  const service = providers(config);
  const ai = agentAI(config, service);
  const initialSettings = defaults(config);
  const settings = async () => ({ ...initialSettings, ...await store.settings() });
  const locks = new Map();
  const rateEvents = new Map();
  const rateWarned = new Map();
  const noReservationReplied = new Map();
  const reservationListRepliedAt = new Map();
  const seenMessages = new Set();
  const optOutPhrases = new Set(['stop', 'baja', 'darme de baja', 'no quiero mensajes']);

  function rateCheck(phone) {
    const now = Date.now();
    const recent = (rateEvents.get(phone) || []).filter(at => now - at < config.rateLimitWindowMs);
    recent.push(now);
    rateEvents.set(phone, recent);
    if (recent.length <= config.rateLimitMax) return { allowed: true, warn: false };
    // Un solo aviso por ventana; el resto se ignora sin llamar a OpenAI ni a Graph.
    if (now - (rateWarned.get(phone) || 0) >= config.rateLimitWindowMs) {
      rateWarned.set(phone, now);
      return { allowed: false, warn: true };
    }
    return { allowed: false, warn: false };
  }

  function commandText(value) {
    return String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
      .replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }
  const greetings = new Set(['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'hola que tal', 'hola buenas']);
  const isGreeting = value => greetings.has(commandText(value));

  async function optedOut(phone) {
    return Boolean((await store.contact(phone))?.opted_out);
  }
  const sign = (value) => hmac(config.sessionSecret, value);
  const cookie = (value, age) => 'establo_session=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + age + (config.publicUrl ? '; Secure' : '');
  function authenticated(req) {
    if (!config.adminPassword) return true;
    const value = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('establo_session='))?.slice(16);
    const [expiry, nonce, signature] = String(value || '').split('.');
    return Number(expiry) > Date.now() && matches(sign(expiry + '.' + nonce), signature);
  }
  const attempts = new Map();
  const update = (id, apply) => updateOrder(store, id, apply);
  const linkFor = (intent) => config.publicUrl + '/pago/' + intent.id;
  const receiptLink = (receipt) => config.publicUrl + '/comprobante/' + receipt.token;
  const datePlus = (key, days) => new Date(+new Date(key + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  async function availableDays({ fromDate = limaDateKey(new Date()), toDate, guests = 1, excludeOrderId = null } = {}) {
    const rule = await settings();
    const endDate = toDate || datePlus(fromDate, rule.offerWindowDays);
    const [orders, blocks] = await Promise.all([store.list(), store.availabilityBlocks(fromDate, endDate)]);
    return { rule, days: getAvailableSlots({ orders, blocks, settings: rule, fromDate, toDate: endDate, guests, excludeOrderId }) };
  }
  async function ensureAvailable(visitAt, guests, excludeOrderId = null, rule = null, forceCapacity = false) {
    const setting = rule || await settings();
    validateSlotInput(visitAt, setting);
    const key = limaDateKey(visitAt);
    const blocks = await store.availabilityBlocks(key, key);
    requireThat(!isSlotBlocked(blocks, visitAt, setting), 'Ese horario está bloqueado. Elige otra opción.', 409);
    const { days } = await availableDays({ fromDate: key, toDate: key, guests, excludeOrderId });
    const exact = days.flatMap(day => day.slots).some(slot => +new Date(slot.visitAt) === +new Date(visitAt));
    requireThat(exact || forceCapacity, 'Ese horario no tiene cupo suficiente o está bloqueado.', 409);
    return exact;
  }
  function lock(id, execute) {
    const previous = locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(execute);
    locks.set(id, next);
    return next.finally(() => { if (locks.get(id) === next) locks.delete(id); });
  }
  async function checkout(id, method = 'checkout', purpose = 'deposit', forceNew = false) {
    requireThat(['checkout', 'yape', 'plin'].includes(method), 'Elige un medio de anticipo válido.');
    const rule = await settings();
    requireThat(method === 'checkout' || rule[method + 'Demo'], 'Ese medio de demostración está desactivado.', 409);
    const mode = method === 'checkout' ? config.paymentMode : 'local';
    return lock(id, async () => {
      const intentId = randomUUID();
      const { order, result: intent } = await update(id, data => {
        const amount = purpose === 'deposit' ? depositDue(data) : balance(data);
        requireThat(purpose === 'deposit' ? data.stage === 'awaiting_deposit' && amount > 0
          : data.stage === 'arrived' && amount > 0, purpose === 'deposit' ? 'La reserva no tiene anticipo pendiente.' : 'El saldo solo se habilita después de registrar la llegada.', 409);
        const expiresAt = purpose === 'deposit' ? data.deadline : new Date(Date.now() + rule.balanceLinkExpiryMinutes * 60000).toISOString();
        requireThat(purpose !== 'deposit' || new Date(data.deadline) > new Date(), 'El plazo del anticipo venció. Revisa la reserva.', 409);
        for (const old of data.intents) if ((old.purpose || 'deposit') === purpose && old.status === 'pending'
          && new Date(old.expiresAt) <= new Date()) old.status = 'expired';
        const reusable = data.intents.find(i => (i.purpose || 'deposit') === purpose && i.mode === mode
          && (i.method || 'checkout') === method && i.amount === amount
          && i.status === 'pending' && (purpose === 'deposit' ? i.expiresAt === expiresAt : new Date(i.expiresAt) > new Date())
          && (mode !== 'mercado_pago' || isMercadoPagoInitPoint(i.checkoutUrl)));
        if (reusable) return reusable;
        if (purpose === 'balance') {
          const issued = data.intents.filter(i => (i.purpose || 'deposit') === 'balance').length;
          requireThat(issued < rule.maxBalanceLinks, 'Se alcanzó el máximo de enlaces de saldo. El personal se acercará para ayudarte.', 409);
          for (const old of data.intents) if ((old.purpose || 'deposit') === 'balance' && old.status === 'pending') old.status = 'expired';
        }
        const row = { id: intentId, purpose, amount, expiresAt, status: 'pending', mode, method };
        data.intents.push(row);
        addEvent(data, purpose === 'deposit' ? 'Enlace de anticipo solicitado' : 'Enlace de saldo solicitado', money(amount));
        return row;
      });
      if (intent.mode === 'local' || intent.checkoutUrl) return intent;
      const external = await service.checkout(order, intent);
      return (await update(id, data => {
        const row = data.intents.find(i => i.id === intent.id);
        Object.assign(row, external);
        addEvent(data, 'Enlace de Mercado Pago de prueba creado', purpose + ' · ' + money(intent.amount));
        return row;
      })).result;
    });
  }
  async function sessionOpen(phone) {
    return (await store.phone(phone)).some(order => order.chat.some(message =>
      message.direction === 'in' && (!message.from || digits(message.from) === phone)
      && Date.now() - +new Date(message.at) < 24 * 3600000));
  }
  async function send(order, text, params = {}) {
    if (config.waMode !== 'cloud') {
      if (!params.reply && (!order.consent || !config.isPhoneAllowed(order.phone) || config.isPhoneBlocked(order.phone) || await optedOut(order.phone))) return order;
      const shown = displayText(text);
      return (await update(order.id, data => {
        const id = 'SIM-' + randomUUID();
        data.chat.push({ id, at: instant(), text: shown, direction: 'out', status: 'simulated',
          ...(text?.kind === 'cta' && String(text.cta?.url || '').includes('/pago/') ? { paymentLink: true } : {}) });
        addEvent(data, 'Mensaje simulado registrado', id);
      })).order;
    }
    const id = await service.sendWhatsApp(order, text, { ...params, reply: Boolean(params.reply), session: await sessionOpen(order.phone) });
    const shown = displayText(text);
    return (await update(order.id, data => {
      data.chat.push({ id, at: instant(), text: shown, direction: 'out', status: 'accepted',
        ...(text?.kind === 'cta' && String(text.cta?.url || '').includes('/pago/') ? { paymentLink: true } : {}) });
      addEvent(data, 'Mensaje aceptado por WhatsApp', id);
    })).order;
  }
  async function sendReply(order, reply) {
    for (const message of Array.isArray(reply) ? reply : [reply]) if (message) await send(order, message, { reply: true });
  }
  function paymentReceiptUrl(payment) {
    if (!payment || payment.channel !== 'mercadopago' || !/^MP-\d+$/.test(String(payment.ref || ''))) return null;
    return 'https://www.mercadopago.com.pe/ccap/file-viewer/receipt?' + new URLSearchParams({
      flow: 'cow_payment_receipts', origin: 'feedback-screen', payment_id: payment.ref.slice(3) });
  }
  const openPaymentIssue = order => order.incidents.some(item => !item.resolvedAt
    && ['Pago por revisar', 'Reverso por revisar'].includes(item.type));
  async function deliverReceipt(order, receipt, { force = false, related = [] } = {}) {
    const receipts = [receipt, ...related].filter(Boolean);
    const keyList = receipts.map(item => item.token + ':' + item.purpose);
    const stamp = instant();
    const { result: claimed } = await update(order.id, data => {
      data.receiptDeliveries ||= {};
      if (!force && keyList.every(key => ['sent', 'simulated', 'suppressed'].includes(data.receiptDeliveries[key]?.status))) return false;
      if (!force && keyList.some(key => data.receiptDeliveries[key]?.status === 'failed'
        && Date.now() - +new Date(data.receiptDeliveries[key].at) < 60000)) return false;
      if (keyList.some(key => data.receiptDeliveries[key]?.status === 'sending'
        && Date.now() - +new Date(data.receiptDeliveries[key].at) < 5 * 60000)) return false;
      for (const key of keyList) data.receiptDeliveries[key] = { status: 'sending', at: stamp,
        attempts: (data.receiptDeliveries[key]?.attempts || 0) + 1 };
      return true;
    });
    if (!claimed) return;
    const permitted = order.phone && order.consent && config.isPhoneAllowed(order.phone)
      && !config.isPhoneBlocked(order.phone) && !(await optedOut(order.phone));
    if (!permitted) {
      await update(order.id, data => { for (const key of keyList) Object.assign(data.receiptDeliveries[key],
        { status: 'suppressed', reason: 'Sin consentimiento o contacto habilitado', at: instant() }); });
      return;
    }
    const allPayments = order.payments.filter(item => item.amount > 0 && !order.payments.some(adjustment => adjustment.original === item.ref && adjustment.amount < 0));
    const mpUrls = allPayments.filter(item => ['deposit', 'balance'].includes(item.purpose || 'deposit')).map(paymentReceiptUrl).filter(Boolean);
    const depositPayment = allPayments.find(item => (item.purpose || 'deposit') === 'deposit');
    const depositMethod = depositPayment?.channel === 'mercadopago' ? 'Mercado Pago'
      : depositPayment?.channel === 'cash' ? 'efectivo' : depositPayment?.channel === 'pos' ? 'POS'
        : depositPayment?.channel === 'wallet' ? 'billetera' : depositPayment?.channel || 'verificado';
    const summary = receipt.purpose === 'deposit'
      ? 'Anticipo ' + money(receipt.amount) + ' · ' + depositMethod + ' · '
        + new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }).format(new Date(depositPayment?.at || receipt.at))
        + (paymentReceiptUrl(depositPayment) ? ' · Comprobante Mercado Pago: ' + paymentReceiptUrl(depositPayment) : '')
      : (receipt.paymentBreakdown || []).map(item => (item.purpose === 'deposit' ? 'Anticipo' : 'Saldo') + ' ' + money(item.amount)
        + ' (' + (item.channel === 'mercadopago' ? 'Mercado Pago' : item.channel === 'cash' ? 'efectivo' : item.channel === 'pos' ? 'POS' : item.channel === 'wallet' ? 'billetera' : item.channel) + ')').join(' · ')
        + (mpUrls.length ? ' · Comprobantes de Mercado Pago: ' + mpUrls.join(' ') : '');
    const amount = receipt.purpose === 'deposit' ? 'Anticipo ' + money(receipt.amount) : 'Total ' + money(order.total) + ' · ' + summary;
    const message = receipt.purpose === 'deposit'
      ? confirmationCta(order, receiptLink(receipt), new Date(), paymentReceiptUrl(depositPayment) ? 'Comprobante Mercado Pago: ' + paymentReceiptUrl(depositPayment) : '')
      : receiptCta(order, receiptLink(receipt), amount);
    try {
      if (config.waMode !== 'cloud') {
        await update(order.id, data => {
          data.chat.push({ id: 'SIM-' + randomUUID(), at: instant(), direction: 'out', status: 'simulated', text: displayText(message) });
          for (const key of keyList) Object.assign(data.receiptDeliveries[key], { status: 'simulated', at: instant(), messageId: null });
        });
      } else {
        const result = await send(order, message, { template: receipt.purpose === 'deposit' ? 'confirmation' : 'settlement',
          receiptToken: receipt.token, templateValues: receipt.purpose === 'deposit'
            ? [order.payer, order.ref, friendlyDate(order.visitAt, new Date(), true), money(receipt.amount), summary]
            : [order.payer, order.ref, money(order.total), amount] });
        const outbound = result.chat.at(-1);
        await update(order.id, data => { for (const key of keyList) Object.assign(data.receiptDeliveries[key],
          { status: 'sent', at: outbound?.at || instant(), messageId: outbound?.id || null });
          for (const incident of data.incidents) if (incident.type === 'Envío de constancia pendiente'
            && incident.key === keyList.join('|') && !incident.resolvedAt) { incident.resolvedAt = instant(); incident.resolution = 'WhatsApp aceptó el reintento.'; }
        });
      }
    } catch (error) {
      await update(order.id, data => {
        for (const key of keyList) Object.assign(data.receiptDeliveries[key], { status: 'failed', at: instant(), error: String(error.message).slice(0, 300) });
        openIssue(data, 'Envío de constancia pendiente', error.message, keyList.join('|'));
      });
    }
  }
  async function deliverPendingReceipts(order) {
    if (openPaymentIssue(order)) {
      if (order.stage === 'paid' && !order.receipts.some(item => item.purpose === 'settlement')) {
        await update(order.id, data => openIssue(data, 'Constancia final pendiente', 'Se resolverá al aclarar la incidencia de pago.', 'settlement-pending'));
      }
      return;
    }
    let fresh = order;
    if (fresh.stage === 'paid' && balance(fresh) === 0) {
      const token = randomUUID();
      const result = await update(fresh.id, data => issueReceipt(data, 'settlement', token));
      fresh = result.order;
    }
    const settlement = fresh.receipts.find(item => item.purpose === 'settlement');
    const balanceReceipts = fresh.receipts.filter(item => item.purpose === 'balance');
    if (settlement && balanceReceipts.length) await deliverReceipt(fresh, settlement, { related: balanceReceipts });
    else {
      const pending = fresh.receipts.find(item => !['sent', 'simulated', 'suppressed'].includes(fresh.receiptDeliveries?.[item.token + ':' + item.purpose]?.status));
      if (pending) await deliverReceipt(fresh, pending);
    }
  }
  async function registerReservation(phone, text, parsed, timestamp, messageId) {
    const excerpt = String(text || '').slice(0, 200);
    const refuse = async error => {
      // El intento fallido no registra pedido, pero queda como consulta para el personal.
      await store.noteQuery(phone, excerpt, true);
      await service.sendWhatsAppReply(phone, error);
    };
    if (!parsed.ok) return refuse(parsed.error);

    const value = parsed.value;
    const payerPhone = value.phone || phone;
    return lock('reservation:' + payerPhone, async () => {
      const operator = payerPhone !== phone;
      const rule = await settings();
      const previous = await store.phone(payerPhone);
      const key = reservationKey({ ...value, phone: payerPhone });
      const now = Date.now();
      const duplicate = previous.find(order => {
        const age = now - +new Date(order.createdAt);
        return !terminal(order) && age >= 0 && age <= 10 * 60000 && reservationKey(order) === key;
      });
      if (duplicate) {
        await service.sendWhatsAppReply(phone, reservationRepeatedMessage(duplicate));
        return;
      }
      const open = previous.filter(order => {
        const age = now - +new Date(order.createdAt);
        return !terminal(order) && age >= 0 && age <= 30 * 86400000;
      });
      if (open.length >= 3) return refuse(texts.reservationLimit);

      let order;
      try {
        order = createOrder({
          agreed: true, payer: value.name, phone: payerPhone, guests: value.guests, visitAt: value.visitAt,
          items: value.items, notes: value.notes, consent: operator ? value.consent === true : true, synthetic: false,
        }, { depositPerPerson: rule.depositPerPerson, deadlineMs: rule.deadlineMinutes * 60000 });
      } catch (error) {
        return refuse(error.message);
      }
      order.events = order.events.filter(event => event.title !== 'Pedido recibido de LEADS');
      addEvent(order, 'Pedido recibido por WhatsApp', operator
        ? 'Alta de operador mediante mensaje estructurado.' : 'Alta de cliente mediante mensaje estructurado.',
          operator ? 'Operador' : 'Cliente');
      addEvent(order, 'Origen: ' + (operator ? 'operador' : 'cliente'), '', operator ? 'Operador' : 'Cliente');
      order.chat.push({ id: messageId, direction: 'in', from: phone, at: new Date(timestamp).toISOString(),
        text: String(text || '').slice(0, 1000) });
      try { await ensureAvailable(order.visitAt, order.guests, null, rule); }
      catch (error) { return refuse('No se registró la reserva porque no hay disponibilidad para ese horario.'); }
      await store.insert(order);

      let intent = null;
      try { intent = await checkout(order.id); }
      catch (error) {
        await update(order.id, data => openIssue(data, 'Enlace de anticipo pendiente', error.message));
      }
      const confirmation = reservationConfirmation(order, intent ? linkFor(intent) : '');
      if (operator) {
        // El alta de operador responde al remitente; el tercero no inicia la conversación.
        try {
          const id = await service.sendWhatsAppReply(phone, confirmation);
          await update(order.id, data => {
            data.chat.push({ id, at: instant(), text: displayText(confirmation), direction: 'out', status: 'accepted' });
            addEvent(data, 'Mensaje aceptado por WhatsApp', id);
          });
        } catch (error) {
          await update(order.id, data => openIssue(data, 'Respuesta de WhatsApp pendiente', error.message, messageId));
        }
        return;
      }
      try { await sendReply(order, confirmation); }
      catch (error) { await update(order.id, data => openIssue(data, 'Respuesta de WhatsApp pendiente', error.message, messageId)); }
    });
  }
  async function replyWithoutReservation(phone, text, action) {
    const excerpt = String(text || '').slice(0, 200);
    let staff = action?.action === 'staff';
    // Los saludos y «ayuda» de un desconocido solo muestran el aviso, sin clasificar.
    const greeting = isGreeting(text) || new Set(['ayuda', 'menu', 'menu principal', 'inicio']).has(commandText(text));
    // Solo texto libre sin acción ni saludo: se evita clasificar pedidos de reserva y botones ajenos.
    if (!staff && !action && !greeting && !reservationRequest(text)) {
      try { staff = (await ai.classify(text)).intent === 'human'; } catch { staff = false; }
    }
    if (staff) {
      await store.noteQuery(phone, excerpt, true);
      await service.sendWhatsAppReply(phone, texts.staff);
      return;
    }
    await store.noteQuery(phone, excerpt, false);
    // Anti-eco: el mensaje informativo se repite como máximo cada 12 horas.
    const last = noReservationReplied.get(phone) || 0;
    if (Date.now() - last < 12 * 3600000) return;
    noReservationReplied.set(phone, Date.now());
    await service.sendWhatsAppReply(phone, noReservationMessage());
  }
  function finishDeposit(data, payment, token) {
    const changed = applyPayment(data, payment);
    if (changed && data.stage === 'confirmed' && !data.receipts.some(r => r.purpose === 'deposit')) issueReceipt(data, 'deposit', token, payment);
    return changed;
  }
  function finishBalance(data, payment, token) {
    const changed = applyPayment(data, payment);
    if (!changed) return false;
    const applied = data.payments.find(item => item.ref === payment.ref);
    if (balance(data) === 0) {
      if (!data.receipts.some(item => item.purpose === 'balance' && item.paymentRef === payment.ref)) issueReceipt(data, 'balance', token, applied);
      if (data.stage === 'paid' && !openPaymentIssue(data)) issueReceipt(data, 'settlement', randomUUID());
    }
    return true;
  }
  async function notifyConfirmation(order) {
    const receipt = order.receipts.find(r => r.purpose === 'deposit');
    if (receipt) await deliverReceipt(order, receipt);
  }
  async function sendBalanceLink(order, { forceNew = false, reply = false } = {}) {
    try {
      if (!reply && (!order.consent || !config.isPhoneAllowed(order.phone) || config.isPhoneBlocked(order.phone) || await optedOut(order.phone))) {
        throw new Problem('No se envió el link automático: falta consentimiento o el teléfono no admite mensajes iniciados por el restaurante.', 409);
      }
      const intent = await checkout(order.id, 'checkout', 'balance', forceNew);
      const current = (await store.get(order.id))?.data || order;
      const text = balancePaymentCta(current, intent, linkFor(intent));
      return await send(current, text, { template: 'balance', intent, reply,
        templateValues: [current.payer, current.ref, money(intent.amount)] });
    } catch (error) {
      if (/máximo de enlaces/i.test(error.message)) await update(order.id, data => openIssue(data,
        'Máximo de enlaces de saldo alcanzado', 'No se generó otro enlace; el personal debe acercarse.', 'balance-link-limit'));
      throw error;
    }
  }
  async function autoPayOrder(order) {
    if (order.stage === 'arrived' && balance(order) > 0) return sendBalanceLink(order, { reply: true });
    if (order.stage === 'awaiting_deposit' && depositDue(order) > 0) {
      if (new Date(order.deadline) <= new Date()) return sendReply(order, reservationMenu(order));
      const intent = await checkout(order.id);
      return send(order, paymentCta(order, intent, 'checkout', linkFor(intent), await settings()), { template: 'deposit', intent, reply: true });
    }
    if (order.stage === 'confirmed') return send(order, 'El saldo se habilita cuando recepción registre tu llegada. Por ahora no generaré un enlace de saldo.', { reply: true });
    const receipt = order.receipts.find(item => item.purpose === 'settlement') || order.receipts.at(-1);
    if (['paid', 'closed'].includes(order.stage) && receipt) return send(order, receiptCta(order, receiptLink(receipt)), { reply: true });
    return send(order, reservationMenu(order), { reply: true });
  }
  async function notifyRejectedPayment(order, rejectedIntent) {
    if (config.waMode !== 'cloud' || !order.consent || !config.isPhoneAllowed(order.phone)
      || config.isPhoneBlocked(order.phone) || await optedOut(order.phone)) return;
    const activeSession = await sessionOpen(order.phone);
    const templateName = rejectedIntent.purpose === 'balance' ? config.env.WA_TEMPLATE_BALANCE : config.env.WA_TEMPLATE_PAYMENT_REJECTED;
    if (!activeSession && !templateName) {
      await update(order.id, data => openIssue(data, 'Aviso de pago no aprobado pendiente',
        'Fuera de la ventana de WhatsApp se necesita una plantilla aprobada. Configura ' + (rejectedIntent.purpose === 'balance' ? 'WA_TEMPLATE_BALANCE.' : 'WA_TEMPLATE_PAYMENT_REJECTED.'), rejectedIntent.id));
      return;
    }
    try {
      if (rejectedIntent.purpose === 'balance') {
        const intent = await checkout(order.id, 'checkout', 'balance');
        await send(order, balancePaymentCta(order, intent, linkFor(intent)), { template: 'balance', intent });
      } else {
        const intent = await checkout(order.id);
        await send(order, paymentRejectedCta(order, intent, linkFor(intent)), { template: 'paymentRejected', intent });
      }
    } catch (error) {
      await update(order.id, data => openIssue(data, 'Aviso de pago no aprobado pendiente', error.message, rejectedIntent.id));
    }
  }
  async function notifyPaymentReview(order, payment) {
    if (config.waMode !== 'cloud' || !order.consent || !config.isPhoneAllowed(order.phone)
      || config.isPhoneBlocked(order.phone) || await optedOut(order.phone) || !(await sessionOpen(order.phone))) return;
    try {
      const message = '✅ Mercado Pago verificó el anticipo de *' + money(payment.amount) + '* para la reserva *' + order.ref
        + '*. La reserva requiere revisión porque el pago llegó fuera del plazo. El personal te confirmará la disponibilidad.';
      await send(order, message, { reply: true });
    } catch (error) {
      await update(order.id, data => openIssue(data, 'Aviso de pago por revisar pendiente', error.message, payment.ref));
    }
  }
  async function syncMp(id, verified = null) {
    const p = verified || await service.payment(id);
    requireThat(uuid.test(String(p.external_reference || '')), 'La operación no corresponde a una reserva de la aplicación.', 404);
    const target = await store.find('intents', { id: p.external_reference, mode: 'mercado_pago' });
    requireThat(target, 'Referencia de pago no encontrada.', 404);
    const intentPurpose = target.intents.find(item => item.id === p.external_reference)?.purpose || 'deposit';
    const token = randomUUID();
    let rejectedIntent = null;
    const { order, result } = await update(target.id, data => {
      rejectedIntent = null;
      const intent = data.intents.find(i => i.id === p.external_reference);
      requireThat(intent, 'Intento de pago no encontrado.', 404);
      const purpose = intent.purpose || 'deposit';
      requireThat(['deposit', 'balance'].includes(purpose), 'Propósito de pago inválido.', 409);
      const ref = 'MP-' + String(p.id);
      const amount = Math.round(Number(p.transaction_amount) * 100);
      requireThat(Number.isSafeInteger(amount) && amount > 0, 'Importe de pago inválido.', 409);
      if (amount !== intent.amount) {
        openIssue(data, 'Pago por revisar', 'El importe de Mercado Pago difiere del enlace solicitado.', ref);
        return false;
      }
      let changed = false;
      if (p.status === 'approved' && purpose === 'balance'
        && (intent.status === 'superseded' || balance(data) === 0 || data.stage !== 'arrived'
          || new Date(p.date_approved || instant()) > new Date(intent.expiresAt))) {
        if (!data.unappliedPayments?.some(item => item.ref === ref)) {
          data.unappliedPayments ||= [];
          data.unappliedPayments.push({ ref, intentId: intent.id, amount, purpose, at: p.date_approved || instant(), reason: 'El saldo ya se cobró en caja, venció el link o cambió el estado.' });
          openIssue(data, 'Pago por revisar', 'Mercado Pago aprobó un pago de saldo que ya no puede aplicarse. Operación: ' + ref, ref);
          addEvent(data, 'Pago tardío no aplicado', ref + ' · ' + money(amount));
          intent.status = 'late_approved';
          changed = true;
        }
      } else if (['approved', 'refunded', 'charged_back'].includes(p.status)) {
        intent.status = p.status === 'approved' ? 'approved' : p.status;
        const payment = { ref, amount, purpose, channel: 'mercadopago', at: p.date_approved || instant(), intentId: intent.id,
          review: p.status !== 'approved' || new Date(p.date_approved || instant()) > new Date(intent.expiresAt) };
        changed = purpose === 'deposit' ? finishDeposit(data, payment, token) : finishBalance(data, payment, token);
        const reported = Math.round(Number(p.transaction_amount_refunded || 0) * 100);
        const reversed = ['refunded', 'charged_back'].includes(p.status) ? (reported || amount) : reported;
        const already = data.payments.filter(x => x.original === ref).reduce((sum, x) => sum - x.amount, 0);
        if (reversed > already && reversed <= amount) {
          data.payments.push({ ref: ref + '-AJUSTE-' + reversed, amount: -(reversed - already), at: instant(),
            channel: 'mercadopago', purpose, original: ref });
          openIssue(data, 'Reverso por revisar', 'Mercado Pago confirmó una devolución o reverso.', ref + '-reverso');
          if (data.stage === 'confirmed' && depositDue(data) > 0) data.stage = 'awaiting_deposit';
          if (['paid', 'closed'].includes(data.stage) && balance(data) > 0) {
            data.stage = 'arrived'; data.closedAt = null;
            for (const receipt of data.receipts) if (receipt.purpose === 'settlement') receipt.reversedAt = instant();
          }
          changed = true;
        }
      } else if (['rejected', 'cancelled'].includes(p.status)) {
        if (intent.status === 'pending') {
          intent.status = 'rejected';
          rejectedIntent = structuredClone(intent);
        }
        openIssue(data, 'Intento rechazado', 'Mercado Pago informó un intento fallido de ' + purpose + '.', ref);
      }
      return changed;
    });
    if (result && p.status === 'approved') {
      if (intentPurpose === 'deposit' && order.stage === 'confirmed') await notifyConfirmation(order);
      else if (intentPurpose === 'balance' && !order.unappliedPayments?.some(x => x.ref === 'MP-' + String(p.id))) await deliverPendingReceipts(order);
      else {
        const reviewPayment = order.payments.find(item => item.ref === 'MP-' + String(p.id) && item.review);
        if (reviewPayment) await notifyPaymentReview(order, reviewPayment);
      }
    }
    if (rejectedIntent) await notifyRejectedPayment(order, rejectedIntent);
    return { order, changed: result };
  }
  let paymentReconciliationRunning = false;
  async function reconcilePendingPayments() {
    if (config.paymentMode !== 'mercado_pago' || paymentReconciliationRunning) return { checked: 0, updated: 0 };
    paymentReconciliationRunning = true;
    let checked = 0, updated = 0;
    try {
      const now = Date.now();
      const orders = await store.list();
      const pending = orders.flatMap(order => (order.intents || [])
        .filter(intent => intent.mode === 'mercado_pago' && intent.status === 'pending'
          && intent.expiresAt && now <= +new Date(intent.expiresAt) + 7 * 86400000
          && now - +new Date(intent.lastMpCheckAt || 0) >= 120000)
        .map(intent => ({ order, intent })))
        .sort((a, b) => +new Date(a.intent.expiresAt) - +new Date(b.intent.expiresAt)).slice(0, 10);
      for (const { order, intent } of pending) {
        const stamp = instant();
        const { result: claimed } = await update(order.id, data => {
          const row = data.intents.find(item => item.id === intent.id);
          if (!row || row.status !== 'pending' || Date.now() - +new Date(row.lastMpCheckAt || 0) < 120000) return false;
          row.lastMpCheckAt = stamp;
          return true;
        });
        if (!claimed) continue;
        checked++;
        try {
          const results = await service.paymentsByExternalReference(intent.id);
          const candidates = results.filter(item => String(item.external_reference) === intent.id && /^\d+$/.test(String(item.id)));
          const candidate = candidates.find(item => item.status === 'approved')
            || candidates.sort((a, b) => +new Date(b.date_created || 0) - +new Date(a.date_created || 0))
              .find(item => ['rejected', 'cancelled', 'refunded', 'charged_back'].includes(item.status));
          if (!candidate) continue;
          const payment = await service.payment(String(candidate.id));
          if (String(payment.external_reference) !== intent.id) continue;
          const result = await syncMp(String(candidate.id), payment);
          if (result.changed) updated++;
        } catch (error) {
          console.error('Mercado Pago: no se pudo reconciliar un anticipo pendiente:', error.message);
        }
      }
    } finally { paymentReconciliationRunning = false; }
    return { checked, updated };
  }
  async function replyTo(order, text, proof, forcedIntent) {
    const summary = order.ref + ' · ' + stageLabels[order.stage] + '. Visita: '
      + friendlyDate(order.visitAt, new Date(), true) + '. Saldo: ' + money(balance(order)) + '.';
    const forced = typeof forcedIntent === 'string' ? { intent: forcedIntent, method: 'checkout' } : forcedIntent;
    const { intent: intentType, method } = forced || await ai.classify(text);
    switch (intentType) {
      case 'link': {
        if (order.stage !== 'awaiting_deposit') return summary;
        if (new Date(order.deadline) <= new Date()) return summary + ' El plazo del anticipo venció. Puedo derivar la revisión al personal.';
        if (/\befectivo\b/i.test(text)) return 'El anticipo de ' + order.ref + ' se paga en línea. Puedes pagar el saldo en efectivo cuando llegues al restaurante.';
        const rule = await settings();
        if (method !== 'checkout' && !rule[method + 'Demo']) return 'Ese medio de demostración está desactivado. Puedes escribir «tarjeta» para abrir el checkout disponible.';
        const intent = await checkout(order.id, method);
        return paymentCta(order, intent, method, linkFor(intent), rule);
      }
      case 'paid': {
        if (depositDue(order) === 0) return summary + ' El anticipo figura verificado.';
        const details = proof ? ['Medio: ' + (proof.provider || 'sin identificar'), 'Importe visible: ' + (proof.amount || 'ilegible'),
          'Operación: ' + (proof.operation || 'ilegible'), 'Datos extraídos de una imagen aportada por el pagador.'].join(' · ') : 'Revisar la transacción con la pasarela.';
        await update(order.id, data => openIssue(data, 'Pago informado por el cliente', details, proof ? 'voucher:' + (proof.operation || proof.messageId) : 'paid-reported'));
        return (proof ? 'Recibí tu comprobante.' : 'Recibí tu aviso.') + ' ⏳ *Pago en verificación*\n'
          + 'Reserva: *' + order.ref + '*\nAún no aparece aprobado en Mercado Pago. Espera la confirmación antes de volver a intentarlo.';
      }
      case 'change':
      case 'cancel':
      case 'issue':
      case 'human': {
        const type = { change: 'Solicitud de reprogramación', cancel: 'Solicitud de cancelación o devolución', issue: 'Dificultad de pago', human: 'Ayuda del personal' }[intentType];
        await update(order.id, data => openIssue(data, type, text.slice(0, 500)));
        return requestMessage(order, intentType);
      }
      case 'receipt': {
        const receipt = order.receipts.at(-1);
        return receipt ? receiptCta(order, receiptLink(receipt)) : 'El comprobante se habilitará tras verificar el pago correspondiente.';
      }
      case 'visit': {
        if (/\b(confirmo (?:mi )?asistencia|si (?:voy a ir|asistire))\b/.test(text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase())) {
          await update(order.id, data => {
            if (data.stage !== 'confirmed' || data.visitIntent?.visitAt === data.visitAt) return;
            data.visitIntent = { visitAt: data.visitAt, at: instant() };
            addEvent(data, 'Intención de asistir informada por WhatsApp', 'La llegada se registra en recepción.', 'Pagador');
          });
        }
        return summary;
      }
      case 'balance': return summary;
      case 'menu':
      default: return reservationMenu(order);
    }
  }
  async function startReschedule(order, action, phone) {
    const rule = await settings();
    try { checkRescheduleEligibility(order, rule, phone); }
    catch (error) {
      await update(order.id, data => openIssue(data, 'Solicitud de reprogramación', error.message, 'reschedule:' + order.ref));
      return { response: '📅 No puedo reprogramar esta reserva: ' + error.message + ' Ya avisé al personal.' };
    }
    const today = limaDateKey(new Date());
    const { days } = await availableDays({ fromDate: today, toDate: datePlus(today, rule.offerWindowDays), guests: order.guests, excludeOrderId: order.id });
    if (!days.length) {
      await update(order.id, data => openIssue(data, 'Sin disponibilidad para reprogramar', 'No se encontró un horario con cupo dentro de la ventana configurada.', 'reschedule-no-slots'));
      return { response: 'No hay horarios disponibles dentro de los próximos ' + rule.offerWindowDays + ' días. Ya avisé al personal.' };
    }
    return { response: rescheduleDaysMessage(order, days, action?.action === 'rsm' ? action.offset : 0) };
  }

  async function rescheduleReply(order, action, phone) {
    const rule = await settings();
    if (action.action === 'rsx') return { response: reservationMenu(order) };
    if (action.action === 'rsc') {
      const proposed = limaDateTime(action.value.slice(0, 10), action.value.slice(11));
      if (+new Date(order.visitAt) === +new Date(proposed)) return { response: 'La visita ya figura en ese horario.', order };
    }
    if (['rsd', 'rsh', 'rst', 'rsc'].includes(action.action)) {
      const date = action.value.slice(0, 10), today = limaDateKey(new Date());
      if (date < today || date > datePlus(today, rule.offerWindowDays)) return startReschedule(order, null, phone);
    }
    if (action.action === 'chg' || action.action === 'selc') return startReschedule(order, null, phone);
    try { checkRescheduleEligibility(order, rule, phone); }
    catch (error) {
      await update(order.id, data => openIssue(data, 'Solicitud de reprogramación', error.message, 'reschedule:' + order.ref));
      return { response: '📅 No puedo reprogramar esta reserva: ' + error.message + ' Ya avisé al personal.' };
    }
    if (action.action === 'rsm') return startReschedule(order, action, phone);
    if (action.action === 'rsd') {
      const { days } = await availableDays({ fromDate: action.value, toDate: action.value, guests: order.guests, excludeOrderId: order.id });
      if (!days[0]) return startReschedule(order, null, phone);
      return { response: rescheduleTimesMessage(order, days[0], 0) };
    }
    if (action.action === 'rsh') {
      const { days } = await availableDays({ fromDate: action.value, toDate: action.value, guests: order.guests, excludeOrderId: order.id });
      const day = days[0];
      if (!day) return startReschedule(order, null, phone);
      return { response: rescheduleTimesMessage(order, day, action.offset) };
    }
    if (action.action === 'rst') {
      const visitAt = limaDateTime(action.value.slice(0, 10), action.value.slice(11));
      const { days } = await availableDays({ fromDate: action.value.slice(0, 10), toDate: action.value.slice(0, 10), guests: order.guests, excludeOrderId: order.id });
      const slot = days.flatMap(day => day.slots).find(item => +new Date(item.visitAt) === +new Date(visitAt));
      if (!slot) return startReschedule(order, null, phone);
      return { response: rescheduleConfirmMessage(order, visitAt) };
    }
    if (action.action === 'rsc') {
      const visitAt = limaDateTime(action.value.slice(0, 10), action.value.slice(11));
      try {
        checkRescheduleEligibility(order, rule, phone);
        await ensureAvailable(visitAt, order.guests, order.id, rule);
        const saved = await store.rescheduleAtomic(order.id, visitAt, rule, false, 'Cliente', order.visitAt);
        const moved = saved.data || saved.order?.data || saved.order || saved;
        return { response: '✅ *Visita reprogramada*\nReserva: *' + moved.ref + '*\nNueva fecha: *'
          + friendlyDate(moved.visitAt, new Date(), true) + '*', order: moved };
      } catch (error) {
        const current = (await store.get(order.id))?.data || order;
        await update(order.id, data => openIssue(data, 'Reprogramación no completada', error.message, 'reschedule-conflict:' + action.value));
        return { response: 'Ese horario dejó de estar disponible. Actualizo las opciones para que elijas otro.', next: await startReschedule(current, null, phone) };
      }
    }
    return { response: reservationMenu(order) };
  }

  async function actionReply(order, action) {
    const forced = { pay: { intent: 'link', method: 'checkout' }, yape: { intent: 'link', method: 'yape' },
      plin: { intent: 'link', method: 'plin' }, bal: { intent: 'balance' }, rcp: { intent: 'receipt' },
      chg: { intent: 'change' }, hum: { intent: 'human' } }[action];
    const phrase = { pay: 'anticipo', yape: 'yape', plin: 'plin', bal: 'saldo', rcp: 'comprobante',
      chg: 'reprogramar', hum: 'ayuda' }[action];
    return replyTo(order, phrase || '', undefined, forced);
  }
  async function incoming(message) {
    const phone = digits(message.from);
    if (!message.id || config.isPhoneBlocked(phone) || !config.isPhoneAllowed(phone)) return;
    const timestamp = Number(message.timestamp) * 1000;
    if (!Number.isFinite(timestamp) || timestamp < Date.now() - 24 * 3600000 || timestamp > Date.now() + 60000) return;
    if (seenMessages.has(message.id)) return;
    seenMessages.add(message.id);
    if (seenMessages.size > 5000) seenMessages.delete(seenMessages.values().next().value);

    const attachment = ['image', 'audio', 'document'].includes(message.type) ? message[message.type] : null;
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    const action = parseAction(reply?.id);
    let text = String(message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title
      || message.button?.text || attachment?.caption || '').slice(0, 1000);
    if (!text && !attachment) return;
    // Los saludos antiguos no deben producir menús atrasados tras una caída o una cola acumulada.
    if (isGreeting(text) && Date.now() - timestamp > 90_000) {
      console.info('WhatsApp: se omitió un saludo atrasado; ageSeconds=' + Math.round((Date.now() - timestamp) / 1000));
      return;
    }

    // Baja y alta se evalúan antes de clasificar la intención.
    const command = commandText(text);
    const balanceShortcut = new Set(['pagar', 'cuenta', 'pagar comida', 'saldo', 'pagar saldo']).has(command);
    if (optOutPhrases.has(command)) {
      await store.setOptOut(phone, true);
      await service.sendWhatsAppReply(phone, texts.optOut);
      return;
    }
    if (command === 'alta') {
      await store.setOptOut(phone, false);
      await service.sendWhatsAppReply(phone, texts.optIn);
      return;
    }

    const rate = rateCheck(phone);
    if (!rate.allowed) {
      if (rate.warn) await service.sendWhatsAppReply(phone, texts.rate);
      return;
    }

    // Alta por mensaje estructurado: solo cuando el modo lo permite y la palabra RESERVA abre el texto.
    if (config.canReserve(phone)) {
      const reservation = parseReservation(text);
      if (reservation) {
        await registerReservation(phone, text, reservation, timestamp, message.id);
        return;
      }
    }

    // Responder a quien escribe no exige consentimiento; solo los mensajes que
    // inicia el restaurante exigen order.consent y un número no dado de baja.
    const orders = await store.phone(phone);
    const ref = text.match(/\bEST-[a-f0-9]{8}\b/i)?.[0]?.toUpperCase();
    const ownsRef = !ref || orders.some(order => order.ref === ref);
    if (!orders.length || !ownsRef) {
      await replyWithoutReservation(phone, text, action);
      return;
    }

    const staffFocus = action?.action === 'staff' ? (reservationFocus(orders) || orders[0]) : null;
    const actionFocus = action?.ref ? orders.find(order => order.ref === action.ref) : null;
    const active = orders.filter(order => !terminal(order));
    const candidates = actionFocus ? [actionFocus] : staffFocus ? [staffFocus]
      : ref ? orders.filter(order => order.ref === ref) : (active.length ? active : orders);
    if (!candidates.length) {
      await replyWithoutReservation(phone, text, action);
      return;
    }

    let proof, mediaError;
    if (attachment) {
      try {
        if (message.type === 'document') throw new Problem('Documento recibido para revisión del personal.');
        const result = await ai.readMedia(message.type, attachment.id);
        if (result.text) text = result.text;
        proof = result.proof;
        if (proof) proof.messageId = message.id;
      } catch (error) { mediaError = error.message; }
    }

    const { order, result: isNew } = await update(candidates[0].id, data => {
      if (data.chat.some(m => m.id === message.id)) return false;
      data.chat.push({ id: message.id, direction: 'in', at: new Date(timestamp).toISOString(),
        text: text || (attachment ? 'Adjunto de ' + ({ image: 'imagen', audio: 'audio', document: 'documento' }[message.type]) : ''),
        ...(attachment ? { mediaType: message.type, mediaId: String(attachment.id || '') } : {}) });
      return true;
    });
    if (!isNew) return;

    // El botón sin referencia solo existe para derivar al personal.
    if (action?.action === 'staff') {
      await update(order.id, data => openIssue(data, 'Ayuda del personal', text.slice(0, 500) || message.id));
      await sendReply(order, requestMessage(order, 'human'));
      return;
    }

    // El agente no ofrece ni gestiona reservas nuevas: deriva al personal con un texto fijo.
    if (reservationRequest(text)) {
      await update(order.id, data => openIssue(data, 'Ayuda del personal', text.slice(0, 500) || message.id));
      await sendReply(order, reservationHelpMessage());
      return;
    }

    const target = action?.ref ? orders.find(order => order.ref === action.ref) : null;
    let recipient = target || order;
    try {
      let response;
      const exactChange = new Set(['reprogramar', 'cambiar fecha']).has(command);
      const inChangeFlow = ['chg', 'selc', 'rsd', 'rsm', 'rsh', 'rst', 'rsc', 'rsx'].includes(action?.action);
      if ((action?.action === 'chg' || (!action && exactChange)) && active.length > 1) {
        response = reservationList(active, new Date(), 'selc');
        recipient = reservationFocus(orders) || order;
      } else if (inChangeFlow || (!action && exactChange)) {
        const selected = target || reservationFocus(orders) || order;
        recipient = selected;
        const result = await rescheduleReply(selected, action || { action: 'chg' }, phone);
        response = result.next?.response || result.response;
      } else if (action?.action === 'payb' || action?.action === 'selb') {
        const selected = target || order;
        recipient = selected;
        await autoPayOrder(selected);
        return;
      } else if (!action && balanceShortcut && !ref && orders.length > 1) {
        const eligibles = active.length ? active : orders;
        response = reservationList(eligibles, new Date(), 'selb');
        recipient = reservationFocus(orders) || order;
      } else if (!action && balanceShortcut) {
        await autoPayOrder(order);
        return;
      } else if (action && (action.action === 'menu' || (action.ref && !target))) {
        response = reservationPrompt(orders);
        recipient = reservationFocus(orders) || order;
      } else if (action?.action === 'selc') {
        response = target ? (await rescheduleReply(target, { action: 'selc' }, phone)).response : reservationPrompt(orders);
        recipient = target || reservationFocus(orders) || order;
      } else if (action?.action === 'sel') {
        response = target ? reservationMenu(target) : reservationPrompt(orders);
        recipient = target || reservationFocus(orders) || order;
      } else if (target) response = await actionReply(target, action.action);
      else if (!ref && orders.length > 1) {
        if (isGreeting(text)) {
          const previous = reservationListRepliedAt.get(phone) || 0;
          if (timestamp - previous >= 120_000) {
            response = reservationPrompt(orders);
            if (response?.kind === 'list') reservationListRepliedAt.set(phone, timestamp);
          }
        } else response = reservationPrompt(orders);
        recipient = reservationFocus(orders) || order;
      } else if (mediaError || (proof && proof.kind !== 'voucher')) {
        await update(order.id, data => openIssue(data, 'Adjunto por revisar', mediaError || 'La imagen requiere revisión del personal.', message.id));
        response = 'Recibí el archivo para ' + order.ref + '. El personal revisará el adjunto. También puedes contarme por escrito cómo te ayudo.';
      } else response = await replyTo(order, text, proof, proof ? 'paid' : undefined);
      await sendReply(recipient, response);
    } catch (error) {
      await update(order.id, data => openIssue(data, 'Respuesta de WhatsApp pendiente', error.message, message.id));
        if (/máximo de enlaces de saldo/i.test(error.message)) {
          try { await send(order, 'Por ahora no puedo crear otro enlace de saldo. El personal se acercará para ayudarte.', { reply: true }); }
          catch { /* La incidencia deja el aviso visible para el personal. */ }
        }
    }
  }
  async function delivery(status) {
    const record = await store.find('chat', { id: status.id });
    if (!record) return;
    await update(record.id, data => {
      const msg = data.chat.find(m => m.id === status.id);
      const rank = { accepted: 0, sent: 1, delivered: 2, read: 3 };
      if (status.status === 'failed' && (rank[msg.status] ?? 0) < 2) {
        msg.status = 'failed';
        openIssue(data, 'Mensaje no entregado', 'WhatsApp informó un error de entrega.', status.id);
      } else if (rank[status.status] > (rank[msg.status] ?? -1)) msg.status = status.status;
    });
  }
  let inboxRunning = false;
  let inboxRequested = false;
  async function drainInbox() {
    if (inboxRunning) { inboxRequested = true; return { processed: 0, failed: 0, busy: true }; }
    inboxRunning = true;
    const result = { processed: 0, failed: 0 };
    try {
      // Vuelve a consultar la cola para recoger mensajes que llegaron mientras se procesaba
      // el lote anterior. El límite de tiempo deja espacio para el resto de la API.
      const started = Date.now();
      for (let pass = 0; pass < 8 && Date.now() - started < 20_000; pass++) {
        const batch = await processInbox();
        result.processed += batch.processed;
        result.failed += batch.failed;
        const requested = inboxRequested;
        inboxRequested = false;
        if (!batch.processed && !batch.failed && !requested) break;
      }
      return result;
    }
    finally { inboxRunning = false; }
  }
  async function processInbox() {
    await store.expireJobs(new Date(Date.now() - 5 * 60000).toISOString());
    const result = { processed: 0, failed: 0 };
    for (const job of await store.queued(20)) {
      const rich = job.kind === 'message' && ['image', 'audio'].includes(job.payload.type);
      if (rich && result.processed + result.failed > 0) break;
      if (!await store.claim(job.id)) continue;
      try {
        if (job.kind === 'message') {
          const ageSeconds = Math.max(0, Math.round((Date.now() - Number(job.payload.timestamp) * 1000) / 1000));
          console.info('WhatsApp: procesando mensaje; ageSeconds=' + ageSeconds);
          await incoming(job.payload);
        }
        else await delivery(job.payload);
        await store.finishJob(job.id, 'done');
        result.processed++;
      } catch (error) {
        await store.finishJob(job.id, 'failed', String(error.message).slice(0, 250));
        result.failed++;
      }
      // Deja margen para el timeout de la llamada HTTP cuando se procesa multimedia.
      if (rich) break;
    }
    return result;
  }
  let alertsRunning = false;
  async function reminderTick() {
    if (alertsRunning) return { sent: 0, escalated: 0, busy: true };
    alertsRunning = true;
    try { return await processAlerts(); }
    finally { alertsRunning = false; }
  }
  async function processAlerts() {
    const rule = await settings();
    const now = Date.now();
    const orders = await store.list();
    let sent = 0, escalated = 0, attempted = 0;
    for (const order of orders) {
      if (terminal(order)) continue;
      const before = +new Date(order.visitAt) - now;
      const issue = order.stage === 'awaiting_deposit' && now >= +new Date(order.deadline) ? ['Anticipo vencido', 'Revisa el pago y el cupo antes de renovar.', 'deadline:' + order.deadline]
        : order.stage === 'confirmed' && before <= -rule.graceMinutes * 60000 ? ['Verificar llegada', 'Pasó la tolerancia. Recepción debe verificar si asistió.', 'arrival:' + order.visitAt]
          : order.stage === 'arrived' && balance(order) > 0 && now - +new Date(order.attendance.at) >= rule.counterAlertMinutes * 60000
            ? ['Saldo por verificar', 'El cliente ya llegó y caja aún no confirmó el saldo.', 'counter:' + order.attendance.at] : null;
      if (rule.internalAlerts && issue && !order.incidents.some(i => i.key === issue[2])) {
        const { result: created } = await update(order.id, data => {
          if (data.stage === order.stage && data.deadline === order.deadline && data.visitAt === order.visitAt && !data.incidents.some(i => i.key === issue[2])) {
            openIssue(data, ...issue);
            return true;
          }
        });
        if (created) escalated++;
      }
    }

    for (const order of orders) {
      if (!order.receipts?.length) continue;
      const hasPendingDelivery = order.receipts.some(receipt => !order.receiptDeliveries?.[receipt.token + ':' + receipt.purpose]
        || ['pending', 'failed'].includes(order.receiptDeliveries?.[receipt.token + ':' + receipt.purpose]?.status)
        || (order.receiptDeliveries?.[receipt.token + ':' + receipt.purpose]?.status === 'sending'
          && now - +new Date(order.receiptDeliveries[receipt.token + ':' + receipt.purpose].at) > 5 * 60000));
      if (hasPendingDelivery) await deliverPendingReceipts((await store.get(order.id))?.data || order);
    }

    if (config.waMode !== 'cloud' || !rule.reminders || !contactTime(rule, new Date(now))) return { sent, escalated };

    const groups = new Map();
    for (const order of orders) {
      if (terminal(order) || !order.phone) continue;
      if (!groups.has(order.phone)) groups.set(order.phone, []);
      groups.get(order.phone).push(order);
    }

    for (const [phone, group] of groups) {
      if (attempted >= 4) break;
      if (!config.isPhoneAllowed(phone) || config.isPhoneBlocked(phone) || await optedOut(phone)) continue;
      const plans = [];
      for (const order of group) {
        if (!order.consent) continue;
        const before = +new Date(order.visitAt) - now;
        const needsDeposit = order.stage === 'awaiting_deposit' && depositDue(order) > 0 && now < +new Date(order.deadline);
        const initialKey = 'initial:' + order.deadline;
        const latestLink = [...order.chat].reverse().find(m => m.direction === 'out' && (m.paymentLink || m.text.includes('/pago/')));
        const initial = rule.initialRequest && needsDeposit && !latestLink && !order.reminders[initialKey];
        const sinceRequest = now - +new Date(latestLink?.at || order.reminders[initialKey]?.at || order.createdAt);
        const deposit = rule.depositReminder && needsDeposit && sinceRequest >= rule.depositReminderMinutes * 60000;
        const visit = rule.visitReminder && order.stage === 'confirmed' && before > 0 && before <= rule.firstVisitHours * 3600000;
        const key = initial ? initialKey : deposit ? 'deposit:' + order.deadline
          : visit ? 'visit:' + order.visitAt + ':' + (before <= rule.lastVisitHours * 3600000 ? 'last' : 'first') : null;
        if (key && !order.reminders[key]) plans.push({ order, key, kind: initial || deposit ? 'deposit' : 'visit' });
      }
      if (!plans.length) continue;

      const deposits = plans.filter(plan => plan.kind === 'deposit')
        .sort((a, b) => +new Date(a.order.deadline) - +new Date(b.order.deadline));
      const visits = plans.filter(plan => plan.kind === 'visit')
        .sort((a, b) => +new Date(a.order.visitAt) - +new Date(b.order.visitAt));
      const paymentAlert = deposits.length > 0;
      const chosenPlans = paymentAlert ? deposits : visits;
      const claimed = [];
      for (const plan of chosenPlans) {
        const { result: didClaim } = await update(plan.order.id, data => {
          if (data.reminders[plan.key] || data.stage !== plan.order.stage || data.visitAt !== plan.order.visitAt
            || data.deadline !== plan.order.deadline) return false;
          data.reminders[plan.key] = { at: instant(), status: 'pending' };
          return true;
        });
        if (didClaim) claimed.push(plan);
      }
      if (!claimed.length) continue;
      attempted++;
      let messagePlan = claimed[0];
      try {
        const activeSession = await sessionOpen(phone);
        let current = (await store.get(messagePlan.order.id))?.data;
        const pendingPayments = group.filter(order => order.consent && order.stage === 'awaiting_deposit'
          && depositDue(order) > 0 && now < +new Date(order.deadline));

        if (paymentAlert && activeSession && pendingPayments.length > 1) {
          const freshOrders = await store.phone(phone);
          const currentPayments = freshOrders.filter(order => order.consent && order.stage === 'awaiting_deposit'
            && depositDue(order) > 0 && now < +new Date(order.deadline));
          await send(current, reservationList(currentPayments, new Date(now)));
          for (const plan of claimed) await update(plan.order.id, data => {
            if (data.reminders[plan.key]?.status === 'pending') data.reminders[plan.key].status = 'sent';
          });
          for (const plan of visits) await update(plan.order.id, data => {
            if (!data.reminders[plan.key]) data.reminders[plan.key] = { at: instant(), status: 'skipped' };
          });
          sent++;
          continue;
        }

        if (paymentAlert) {
          const intent = await checkout(current.id);
          current = (await store.get(current.id))?.data;
          await send(current, paymentCta(current, intent, 'checkout', linkFor(intent), rule), { template: 'deposit', intent });
        } else {
          const visit = emojis.visit + ' *Próxima visita*\nReserva: *' + current.ref + '*\n'
            + friendlyDate(current.visitAt, new Date(now), true) + '\nSaldo en el local: *' + money(balance(current)) + '*';
          await send(current, visit, { template: 'visit' });
        }

        for (const plan of claimed) await update(plan.order.id, data => {
          if (data.reminders[plan.key]?.status === 'pending') data.reminders[plan.key].status = plan === messagePlan ? 'sent' : 'skipped';
        });
        const secondary = paymentAlert ? visits : chosenPlans.slice(1);
        for (const plan of secondary) await update(plan.order.id, data => {
          if (!data.reminders[plan.key]) data.reminders[plan.key] = { at: instant(), status: 'skipped' };
        });
        sent++;
      } catch (error) {
        for (const plan of claimed) await update(plan.order.id, data => {
          if (data.reminders[plan.key]?.status === 'pending') data.reminders[plan.key].status = plan === messagePlan ? 'failed' : 'skipped';
        });
        await update(messagePlan.order.id, data => openIssue(data, 'Recordatorio pendiente', error.message, messagePlan.key));
      }
    }
    return { sent, escalated };
  }
  let running = false;
  const timer = config.orchestration === 'server' ? setInterval(async () => {
    if (running) return;
    running = true;
    try {
      if (config.waMode === 'cloud') await drainInbox();
      await reminderTick();
    } catch (e) { console.error('Agente PAYERS:', e.message); }
    finally { running = false; }
  }, 30000) : null;
  timer?.unref();
  const paymentTimer = config.paymentMode === 'mercado_pago' ? setInterval(async () => {
    try { await reconcilePendingPayments(); }
    catch (error) { console.error('Mercado Pago: falló la reconciliación de pagos pendientes:', error.message); }
  }, 120000) : null;
  paymentTimer?.unref();
  const initialPaymentReconciliation = config.paymentMode === 'mercado_pago' && !options.memory ? setTimeout(() => {
    reconcilePendingPayments().catch(error => console.error('Mercado Pago: falló la reconciliación inicial:', error.message));
  }, 2000) : null;
  initialPaymentReconciliation?.unref();

  async function route(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return next();
    const isGet = req.method === 'GET', isPost = req.method === 'POST';
    if (path.startsWith('/api/internal/agent/')) {
      requireThat(config.orchestration === 'n8n' && matches(req.headers.authorization, 'Bearer ' + config.env.N8N_AGENT_TOKEN), 'Credencial del agente inválida.', 401);
      if (isPost && path.endsWith('/inbox')) return json(res, 200, await drainInbox());
      if (isPost && path.endsWith('/alerts')) return json(res, 200, await reminderTick());
      return json(res, 404, { error: 'Ruta no encontrada.' });
    }
    if (path === '/api/session' && isGet) return json(res, 200, { authenticated: authenticated(req), protected: Boolean(config.adminPassword) });
    if (path === '/api/login' && isPost) {
      const host = req.socket.remoteAddress;
      const state = attempts.get(host);
      if (state?.count >= 10 && state.expiry > Date.now()) throw new Problem('Espera antes de volver a intentar el ingreso.', 429);
      const body = parse(await readBody(req));
      if (!matches(hash(config.adminPassword), hash(body.password)) || !config.adminPassword) {
        attempts.set(host, state?.expiry > Date.now() ? { ...state, count: state.count + 1 } : { count: 1, expiry: Date.now() + 15 * 60000 });
        throw new Problem('La contraseña es incorrecta.', 401);
      }
      attempts.delete(host);
      const key = (Date.now() + 8 * 3600000) + '.' + randomUUID();
      res.setHeader('Set-Cookie', cookie(key + '.' + sign(key), 28800));
      return json(res, 200, { authenticated: true });
    }
    if (path === '/api/logout' && isPost) {
      res.setHeader('Set-Cookie', cookie('', 0));
      return json(res, 200, { authenticated: false });
    }
    if (path === '/api/webhooks/whatsapp' && config.waMode === 'cloud') {
      if (isGet) {
        requireThat(url.searchParams.get('hub.mode') === 'subscribe' && matches(config.env.WA_VERIFY_TOKEN, url.searchParams.get('hub.verify_token')), 'Verificación inválida.', 403);
        res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(url.searchParams.get('hub.challenge'));
      }
      if (isPost) {
        const raw = await readBody(req);
        const signatureValid = matches('sha256=' + hmac(config.env.WA_APP_SECRET, raw), req.headers['x-hub-signature-256']);
        const body = signatureValid ? parse(raw) : null;
        console.log('WhatsApp webhook:', new Date().toISOString(), 'signatureValid=' + signatureValid,
          'entries=' + (body && Array.isArray(body.entry) ? body.entry.length : 'not-parsed'));
        requireThat(signatureValid, 'Firma de WhatsApp inválida.', 403);
        const queue = [];
        for (const entry of body.entry || []) for (const change of entry.changes || []) {
          const value = change.value || {};
          if (String(value.metadata?.phone_number_id) !== config.env.WA_PHONE_NUMBER_ID) continue;
          for (const message of value.messages || []) if (message.id && config.isPhoneAllowed(message.from)
            && !config.isPhoneBlocked(message.from)) {
            queue.push({ id: 'message:' + message.id, kind: 'message', payload: message });
          }
          for (const status of value.statuses || []) if (status.id && ['sent', 'delivered', 'read', 'failed'].includes(status.status)) {
            queue.push({ id: 'status:' + status.id + ':' + status.status, kind: 'status', payload: { id: status.id, status: status.status } });
          }
        }
        await store.enqueue(queue);
        const queuedMessages = queue.filter(job => job.kind === 'message').length;
        const queuedStatuses = queue.length - queuedMessages;
        if (queue.length) console.info('WhatsApp webhook: mensajes=' + queuedMessages + '; estados=' + queuedStatuses);
        // Atiende la cola desde el servidor en cuanto Meta entrega el webhook. n8n
        // conserva la programación de alertas, pero no media la respuesta conversacional.
        if (queue.length) void drainInbox().then(result => {
          if (result.failed) console.error('WhatsApp: falló el procesamiento de ' + result.failed + ' elemento(s) de la cola.');
        }).catch(error => console.error('WhatsApp: no se pudo vaciar la cola:', error.message));
        return json(res, 200, { received: true });
      }
    }
    if (path === '/api/webhooks/mercado-pago' && isPost && config.paymentMode === 'mercado_pago') {
      const raw = await readBody(req);
      const id = service.verifyMp(req, url);
      requireThat(id, 'Firma de Mercado Pago inválida.', 403);
      const notification = parse(raw);
      if ((notification.type || url.searchParams.get('type')) === 'payment') {
        try {
          const result = await syncMp(id);
          const payment = result.order.payments.find(item => item.ref === 'MP-' + id);
          console.log('Mercado Pago webhook: payment verified; status=' + (payment ? 'recorded' : 'pending')
            + '; reservation=' + result.order.ref + '; changed=' + Boolean(result.changed));
        } catch (error) {
          console.error('Mercado Pago webhook: payment processing failed:', error.message);
          throw error;
        }
      }
      return json(res, 200, { received: true });
    }
    const publicPay = path.match(/^\/api\/payment\/([a-f0-9-]+)$/);
    if (publicPay && uuid.test(publicPay[1])) {
      let target = await store.find('intents', { id: publicPay[1] });
      requireThat(target, 'Enlace no encontrado.', 404);
      let intent = target.intents.find(i => i.id === publicPay[1]);
      if (isGet && intent.mode === 'mercado_pago' && config.paymentMode === 'mercado_pago') {
        const returnedPaymentId = url.searchParams.get('payment_id') || url.searchParams.get('collection_id');
        if (returnedPaymentId) {
          requireThat(/^\d{1,30}$/.test(returnedPaymentId), 'Identificador de pago inválido.');
          const payment = await service.payment(returnedPaymentId);
          requireThat(String(payment.external_reference) === intent.id, 'El pago no corresponde a este enlace.', 409);
          await syncMp(returnedPaymentId, payment);
          target = (await store.get(target.id))?.data;
          requireThat(target, 'Reserva no encontrada.', 404);
          intent = target.intents.find(i => i.id === publicPay[1]);
        }
      }
      const method = intent.method || 'checkout';
      const purpose = intent.purpose || 'deposit';
      const methodEnabled = method === 'checkout' || (await settings())[method + 'Demo'];
      if (isGet) {
        const expected = purpose === 'deposit' ? depositDue(target) : balance(target);
        const rightStage = purpose === 'deposit' ? target.stage === 'awaiting_deposit' && new Date(target.deadline) > new Date()
          : target.stage === 'arrived' && balance(target) > 0;
        const usable = methodEnabled && rightStage && intent.amount === expected
          && new Date(intent.expiresAt) > new Date() && intent.status === 'pending';
        const safeCheckout = intent.mode !== 'mercado_pago' || isMercadoPagoInitPoint(intent.checkoutUrl);
        const requiresReview = target.payments.some(payment => payment.intentId === intent.id && payment.review);
        return json(res, 200, { ref: target.ref, amount: intent.amount, status: intent.status, mode: intent.mode, purpose,
          stage: target.stage, requiresReview,
          method, usable: usable && safeCheckout, checkoutUrl: usable && safeCheckout ? intent.checkoutUrl : null });
      }
      if (isPost) {
        requireThat(methodEnabled && intent.mode === 'local' && (method !== 'checkout' || config.paymentMode === 'local'), 'Este pago se confirma desde el medio autorizado.', 409);
        const input = parse(await readBody(req));
        const token = randomUUID();
        const { order, result } = await update(target.id, data => {
          const row = data.intents.find(i => i.id === intent.id);
          if (row.status === 'approved') return { status: row.status, confirmed: false };
          const due = purpose === 'deposit' ? depositDue(data) : balance(data);
          const stageOkay = purpose === 'deposit' ? data.stage === 'awaiting_deposit' && new Date(data.deadline) > new Date()
            : data.stage === 'arrived';
          requireThat(stageOkay && due > 0 && row.status === 'pending' && row.amount === due
            && new Date(row.expiresAt) > new Date(), 'El enlace ya no está disponible.', 409);
          if (input.outcome === 'rejected') {
            row.status = 'rejected';
            openIssue(data, 'Intento rechazado', 'El checkout local simuló un rechazo.', row.id);
          } else {
            requireThat(input.outcome === 'approved', 'Resultado de prueba inválido.');
            row.status = 'approved';
            const payment = { ref: 'SIM-' + row.id, amount: row.amount, purpose, channel: method === 'checkout' ? 'simulation' : method + '_demo', intentId: row.id };
            if (purpose === 'deposit') finishDeposit(data, payment, token); else finishBalance(data, payment, token);
          }
          return { status: row.status, confirmed: row.status === 'approved' && data.stage === 'confirmed' };
        });
        if (result.confirmed) await notifyConfirmation(order);
        else if (purpose === 'balance' && result.status === 'approved') await deliverPendingReceipts(order);
        return json(res, 200, { status: result.status });
      }
    }
    const publicReceipt = path.match(/^\/api\/receipt\/([a-f0-9-]+)$/);
    if (publicReceipt && isGet && uuid.test(publicReceipt[1])) {
      const order = await store.find('receipts', { token: publicReceipt[1] });
      requireThat(order, 'Comprobante no encontrado.', 404);
      const receipt = order.receipts.find(r => r.token === publicReceipt[1]);
      const payment = order.payments.filter(item => item.channel === 'mercadopago' && item.purpose === receipt.purpose
        && item.amount === receipt.amount && /^MP-\d+$/.test(String(item.ref || '')))
        .sort((a, b) => +new Date(b.at || 0) - +new Date(a.at || 0))
        .find(item => !order.payments.some(adjustment => adjustment.original === item.ref && adjustment.amount < 0));
      const operationId = payment ? payment.ref.slice(3) : null;
      const mercadoPagoReceiptUrl = operationId ? 'https://www.mercadopago.com.pe/ccap/file-viewer/receipt?'
        + new URLSearchParams({ flow: 'cow_payment_receipts', origin: 'feedback-screen', payment_id: operationId }) : null;
      const receiptPayments = receipt.purpose === 'settlement'
        ? (receipt.paymentBreakdown?.length
          ? receipt.paymentBreakdown.map(row => order.payments.find(item => item.ref === row.ref)).filter(Boolean)
          : order.payments.filter(item => item.amount > 0 && !order.payments.some(adjustment => adjustment.original === item.ref && adjustment.amount < 0)))
        : order.payments.filter(item => item.ref === receipt.paymentRef || (receipt.intentId && item.intentId === receipt.intentId));
      const mercadoPagoReceipts = receiptPayments.filter(item => !order.payments.some(adjustment => adjustment.original === item.ref && adjustment.amount < 0))
        .map(item => ({ paymentId: item.ref.slice(3), intentId: item.intentId || null, purpose: item.purpose || 'deposit', amount: item.amount,
          url: paymentReceiptUrl(item) })).filter(item => item.url);
      return json(res, 200, { ...receipt, ref: order.ref, payer: order.payer, total: order.total,
        payments: receipt.paymentBreakdown || receiptPayments.map(item => ({ purpose: item.purpose || 'deposit', amount: item.amount,
          at: item.at, channel: item.channel, ref: item.ref })), mercadoPagoReceipts,
        ...(operationId ? { mercadoPagoOperationId: operationId, mercadoPagoReceiptUrl } : {}) });
    }
    requireThat(authenticated(req), 'Inicia sesión para acceder al panel.', 401);
    const attachment = path.match(/^\/api\/orders\/([a-f0-9-]+)\/media\/([^/]+)$/);
    if (attachment && isGet && uuid.test(attachment[1])) {
      const order = (await store.get(attachment[1]))?.data;
      const message = order?.chat.find(m => m.direction === 'in' && m.id === decodeURIComponent(attachment[2]) && m.mediaId);
      requireThat(message, 'Adjunto no encontrado.', 404);
      const media = await service.downloadMedia(message.mediaId, 12 * 1024 ** 2);
      const inline = /^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg|mp4|wav|webm|opus))$/.test(media.mime);
      const document = media.mime === 'application/pdf';
      requireThat(inline || document, 'Este tipo de archivo requiere revisión en el canal de origen.', 415);
      res.writeHead(200, { 'Content-Type': media.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
        'Content-Disposition': inline ? 'inline' : 'attachment; filename="adjunto.pdf"' });
      return res.end(media.bytes);
    }
    if (path === '/api/config' && isGet) return json(res, 200, {
      database: store.label, paymentMode: config.paymentMode, whatsapp: config.waMode, protected: Boolean(config.adminPassword),
      agent: config.orchestration, ai: ai.enabled, ...await settings(),
    });
    if (path === '/api/agent/settings' && isPost) {
      const next = validateSettings(parse(await readBody(req)), initialSettings);
      await store.saveSettings(next);
      return json(res, 200, next);
    }
    if (path === '/api/availability' && isGet) {
      const rule = await settings(), date = url.searchParams.get('date') || limaDateKey(new Date());
      requireThat(/^\d{4}-\d{2}-\d{2}$/.test(date), 'Indica una fecha válida.');
      const guests = Number(url.searchParams.get('guests') || 1);
      requireThat(Number.isInteger(guests) && guests >= 1 && guests <= 40, 'La cantidad de personas no es válida.');
      const [orders, blocks] = await Promise.all([store.list(), store.availabilityBlocks(date, date)]);
      const occupancy = getDayOccupancy({ orders, blocks, settings: rule, date });
      return json(res, 200, { ...occupancy, label: limaFormatDay(date), available: getAvailableSlots({ orders, blocks, settings: rule,
        fromDate: date, toDate: date, guests }).flatMap(day => day.slots) });
    }
    if (path === '/api/availability/blocks' && isGet) return json(res, 200, await store.availabilityBlocks());
    if (path === '/api/availability/blocks' && isPost) {
      const input = parse(await readBody(req)), reason = String(input.reason || '').trim().slice(0, 240);
      requireThat(['day', 'range', 'slot'].includes(input.kind) && /^\d{4}-\d{2}-\d{2}$/.test(input.local_date)
        && reason.length >= 3, 'Completa el tipo, fecha y motivo del bloqueo.');
      requireThat(limaDateKey(limaDateTime(input.local_date, '12:00')) === input.local_date, 'La fecha del bloqueo no es válida.');
      let starts_at = null, ends_at = null;
      if (input.kind !== 'day') {
        requireThat(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.startTime) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.endTime)
          && input.endTime > input.startTime, 'Indica un rango horario válido.');
        starts_at = limaDateTime(input.local_date, input.startTime);
        ends_at = limaDateTime(input.local_date, input.endTime);
        if (input.kind === 'slot') {
          const rule = await settings();
          requireThat(+new Date(ends_at) - +new Date(starts_at) === rule.slotMinutes * 60000,
            'El bloqueo de franja debe tener la duración configurada.');
          validateSlotInput(starts_at, rule);
        }
      }
      const block = await store.addAvailabilityBlock({ kind: input.kind, local_date: input.local_date, starts_at, ends_at, reason });
      return json(res, 201, block);
    }
    const removeBlock = path.match(/^\/api\/availability\/blocks\/([a-f0-9-]+)$/);
    if (removeBlock && isPost && uuid.test(removeBlock[1])) {
      requireThat(await store.deleteAvailabilityBlock(removeBlock[1]), 'El bloqueo no existe.', 404);
      return json(res, 200, { deleted: true });
    }
    if (path === '/api/agent/activity' && isGet) return json(res, 200, await store.agentStatus());
    if (path === '/api/agent/queries' && isGet) return json(res, 200, await store.queries());
    const handledQuery = path.match(/^\/api\/agent\/queries\/([a-f0-9-]+)\/handled$/);
    if (handledQuery && isPost && uuid.test(handledQuery[1])) {
      const handled = await store.handleQuery(handledQuery[1]);
      requireThat(handled, 'La consulta ya fue atendida o no existe.', 409);
      return json(res, 200, { handled: true });
    }
    if (path === '/api/orders' && isGet) return json(res, 200, await store.list());
    if (path === '/api/orders' && isPost) {
      const rule = await settings();
      const input = parse(await readBody(req)), order = createOrder(input, { depositPerPerson: rule.depositPerPerson, deadlineMs: rule.deadlineMinutes * 60000 });
      const available = await ensureAvailable(order.visitAt, order.guests, null, rule, input.forceCapacity === true);
      if (!available && input.forceCapacity) addEvent(order, 'Aforo excedido por personal', 'El operador forzó la reserva para esta franja.', 'Operador');
      return json(res, 201, await store.insert(order));
    }
    const action = path.match(/^\/api\/orders\/([a-f0-9-]+)\/([a-z-]+)$/);
    if (action && isPost && uuid.test(action[1])) {
      const [, id, kind] = action;
      const input = parse(await readBody(req));
      if (kind === 'link') {
        const intent = await checkout(id, input.method);
        return json(res, 200, { intent, url: linkFor(intent), order: (await store.get(id)).data });
      }
      if (kind === 'message') {
        requireThat(config.waMode === 'cloud', 'Activa WhatsApp Cloud API en la configuración.', 409);
        let order = (await store.get(id))?.data;
        requireThat(order, 'Reserva no encontrada.', 404);
        // Un envío manual solo sale sin plantilla si la baja no está activa o hay sesión abierta.
        if (await optedOut(order.phone) && !(await sessionOpen(order.phone))) {
          throw new Problem('El cliente se dio de baja de los mensajes', 409);
        }
        if (input.type === 'deposit') {
          const intent = await checkout(id, input.method);
          order = await send(order, paymentCta(order, intent, input.method || 'checkout', linkFor(intent), await settings()), { template: 'deposit', intent });
        } else if (input.type === 'balance') {
          order = await sendBalanceLink(order, { forceNew: Boolean(input.newLink) });
        } else if (input.type === 'visit') {
          requireThat(order.stage === 'confirmed', 'La visita debe estar confirmada.', 409);
          order = await send(order, emojis.visit + ' *Próxima visita*\nReserva: *' + order.ref + '*\n'
            + friendlyDate(order.visitAt, new Date(), true) + '\nSaldo en el local: *' + money(balance(order)) + '*', { template: 'visit' });
        } else if (input.type === 'receipt') {
          const receipt = order.receipts.find(item => item.token === input.receiptToken) || order.receipts.at(-1);
          requireThat(receipt, 'Aún no hay un comprobante emitido.', 409);
          requireThat(!receipt.reversedAt, 'Esta liquidación fue revertida y no se puede reenviar.', 409);
          const settlement = ['balance', 'settlement'].includes(receipt.purpose)
            ? (receipt.purpose === 'settlement' && !receipt.reversedAt ? receipt : order.receipts.find(item => item.purpose === 'settlement' && !item.reversedAt)) : null;
          if (receipt.purpose === 'balance') requireThat(settlement, 'La constancia final se habilitará al resolver las incidencias de pago.', 409);
          await deliverReceipt(order, settlement || receipt, { force: true,
            related: settlement ? order.receipts.filter(item => item.purpose === 'balance') : [] });
          order = (await store.get(id)).data;
        } else throw new Problem('Selecciona un mensaje válido.');
        return json(res, 200, { order });
      }
      if (kind === 'sync') {
        requireThat(config.paymentMode === 'mercado_pago' && /^\d+$/.test(String(input.paymentId)), 'Indica el número de operación de Mercado Pago.');
        const p = await service.payment(input.paymentId);
        const row = await store.get(id);
        requireThat(row?.data.intents.some(i => i.id === p.external_reference), 'El pago corresponde a otro pedido.', 409);
        return json(res, 200, await syncMp(input.paymentId, p));
      }
      if (kind === 'refund') {
        const data = (await store.get(id))?.data;
        requireThat(data && (['cancelled', 'no_show'].includes(data.stage) || data.incidents.some(i => i.key === input.ref && !i.resolvedAt)),
          'Registra primero la cancelación, inasistencia o incidencia asociada al cobro.', 409);
        const payment = data.payments.find(p => p.ref === input.ref && p.amount > 0 && p.purpose === 'deposit');
        requireThat(payment, 'Selecciona un anticipo válido.');
        if (payment.channel === 'mercadopago') {
          const confirmed = await service.payment(payment.ref.slice(3));
          if (confirmed.status === 'approved' && !Number(confirmed.transaction_amount_refunded || 0)) {
            const key = hash(id + ':' + payment.ref).slice(0, 36);
            await service.refund(payment.ref.slice(3), payment.amount, key);
          }
          return json(res, 200, await syncMp(payment.ref.slice(3)));
        }
        return json(res, 200, await update(id, data => {
          if (data.payments.some(p => p.original === payment.ref)) return;
          data.payments.push({ ref: payment.ref + '-REFUND', original: payment.ref, amount: -payment.amount,
            at: instant(), purpose: 'deposit', channel: payment.channel });
          addEvent(data, 'Devolución de demostración registrada', payment.ref, 'Caja');
        }));
      }
      if (kind === 'reschedule') {
        const row = await store.get(id), order = row?.data;
        requireThat(order, 'Reserva no encontrada.', 404);
        const oldVisitAt = order.visitAt, rule = await settings(), force = input.forceCapacity === true;
        const hasCapacity = await ensureAvailable(input.visitAt, order.guests, id, rule, force);
        const saved = await store.rescheduleAtomic(id, new Date(input.visitAt).toISOString(), rule, force, 'Operador', oldVisitAt);
        const moved = saved.data || saved.order?.data || saved.order || saved;
        if (saved.changed !== false) {
          const confirmation = '📅 *Visita reprogramada*\nReserva: *' + moved.ref + '*\nNueva fecha: *'
            + friendlyDate(moved.visitAt, new Date(), true) + '*.';
          try {
            if (moved.phone) await send(moved, confirmation, { template: 'reschedule', templateValues: [moved.payer, moved.ref,
              friendlyDate(oldVisitAt, new Date(), true), friendlyDate(moved.visitAt, new Date(), true)] });
          } catch (error) {
            await update(id, data => openIssue(data, 'Confirmación de reprogramación pendiente', error.message, 'reschedule-confirmation:' + moved.visitAt));
          }
        }
        return json(res, 200, { order: (await store.get(id))?.data || moved, result: { changed: saved.changed !== false, forced: force && !hasCapacity } });
      }
      const receiptToken = randomUUID();
      const rule = await settings();
      const result = await update(id, data => {
        if (kind === 'arrive') return arrive(data, Number(input.count));
        if (kind === 'counter') {
          recordCounterPayment(data, input.channel);
          const payment = data.payments.at(-1);
          if (balance(data) === 0) {
            issueReceipt(data, 'balance', receiptToken, payment);
            if (!openPaymentIssue(data)) issueReceipt(data, 'settlement', randomUUID());
          }
          return payment;
        }
        if (kind === 'receipt') return issueReceipt(data, 'settlement', receiptToken);
        if (kind === 'renew') {
          requireThat(data.stage === 'awaiting_deposit' && depositDue(data) > 0 && new Date(data.deadline) <= new Date(),
            'Solo se renuevan anticipos pendientes y vencidos.');
          requireThat(+new Date(data.visitAt) > Date.now() + 60000, 'Reprograma primero la visita y verifica la disponibilidad.');
          data.deadline = new Date(Math.min(Date.now() + rule.deadlineMinutes * 60000, +new Date(data.visitAt))).toISOString();
          addEvent(data, 'Plazo de anticipo renovado', 'Cupo revisado por el operador.', 'Operador');
          return;
        }
        if (kind === 'cancel') return endReservation(data, 'cancelled', input.reason, rule.graceMinutes * 60000);
        if (kind === 'no-show') return endReservation(data, 'no_show', input.reason, rule.graceMinutes * 60000);
        if (kind === 'resolve') {
          const issue = data.incidents.find(i => i.id === input.id && !i.resolvedAt);
          requireThat(issue, 'La incidencia no está pendiente.', 409);
          requireThat(String(input.note || '').trim().length >= 3, 'Describe cómo se resolvió la incidencia.');
          const resolution = String(input.note).slice(0, 300);
          issue.resolvedAt = instant();
          issue.resolution = resolution;
          addEvent(data, 'Incidencia resuelta', resolution, 'Operador');
          if (data.stage === 'awaiting_deposit' && depositDue(data) === 0 && new Date(data.visitAt) > new Date()
            && !data.incidents.some(i => !i.resolvedAt && ['Pago por revisar', 'Reverso por revisar'].includes(i.type))) {
            data.stage = 'confirmed';
            data.confirmedAt = instant();
            addEvent(data, 'Reserva confirmada tras revisión', '', 'Operador');
            issueReceipt(data, 'deposit', receiptToken);
          }
          if (data.stage === 'arrived' && balance(data) === 0
            && !data.incidents.some(i => !i.resolvedAt && ['Pago por revisar', 'Reverso por revisar'].includes(i.type))) {
            data.stage = 'paid';
            addEvent(data, 'Saldo conciliado tras revisión', '', 'Operador');
            const balancePayment = [...data.payments].reverse().find(payment => payment.amount > 0 && payment.purpose === 'balance');
            if (balancePayment && !data.receipts.some(r => r.purpose === 'balance' && r.paymentRef === balancePayment.ref)) {
              issueReceipt(data, 'balance', receiptToken, balancePayment);
            }
          }
          return;
        }
        throw new Problem('Acción no disponible.', 404);
      });
      if (kind === 'arrive' && result.order.stage === 'arrived' && balance(result.order) > 0) {
        try { await sendBalanceLink(result.order); }
        catch (error) { await update(id, data => openIssue(data, 'Envío del link de saldo pendiente', error.message, 'balance-link:' + result.order.attendance.at)); }
      }
      if (kind === 'counter' && balance(result.order) === 0) await deliverPendingReceipts(result.order);
      if (kind === 'resolve') {
        await deliverPendingReceipts(result.order);
        if (result.order.stage === 'arrived' && balance(result.order) > 0) {
          try { await sendBalanceLink(result.order); }
          catch (error) { await update(id, data => openIssue(data, 'Envío del link de saldo pendiente', error.message, 'balance-link-retry')); }
        }
      }
      if (kind === 'receipt') await deliverPendingReceipts(result.order);
      return json(res, 200, { ...result, order: (await store.get(id))?.data || result.order });
    }
    return json(res, 404, { error: 'Ruta no encontrada.' });
  }
  const middleware = (req, res, next) => route(req, res, next).catch(error => {
    if (!(error instanceof Problem)) console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'No se pudo completar la operación.' });
    else res.end();
  });
  return { middleware, async close() {
    clearInterval(timer); clearInterval(paymentTimer); clearTimeout(initialPaymentReconciliation); await store.close?.();
  } };
}
