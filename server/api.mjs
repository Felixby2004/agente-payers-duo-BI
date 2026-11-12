import { randomUUID, createHash } from 'node:crypto';
import { readConfig } from './config.mjs';
import { openStore, updateOrder } from './store.mjs';
import { providers, hmac, matches } from './providers.mjs';
import { agentAI } from './agent-ai.mjs';
import { createPortal } from './portal.mjs';
import { isArrivalReport, paymentPromise, wantsPortal } from './customer-intents.mjs';
import { reportKinds, reportPdf } from './reports.mjs';
import { completeSettings, contactTime, defaults, validateSettings } from './agent-settings.mjs';
import { balance, depositDue, money, paid, terminal, stageLabels } from '../shared/orders.mjs';
import { displayText, emojis, friendlyDate, parseAction, reservationFocus, reservationMenu, reservationPrompt, reservationList,
  paymentCta, balancePaymentCta, paymentRejectedCta, receiptCta, paymentReceiptCta, confirmationCta, requestMessage, noReservationMessage,
  customerMainMenu, customerReservationsEmptyMessage, reservationInstructionsMessage, reservationRequest, reservationListRequest, availabilityInquiry,
  parseReservation, reservationKey, reservationConfirmation, reservationRepeatedMessage, rescheduleDaysMessage,
  rescheduleTimesMessage, rescheduleConfirmMessage, cancelReservationConfirmMessage, buttonsMessage, texts } from './interactive.mjs';
import { Problem, requireThat, createOrder, addEvent, openIssue, applyPayment, arrive, recordCounterPayment, issueReceipt, reschedule, endReservation, digits } from './domain.mjs';
import { availabilityConfigured, checkRescheduleEligibility, getAvailableSlots, getDayOccupancy, isSlotBlocked, limaDateKey, limaDateTime, limaFormatDay, validateSlotInput } from './availability.mjs';

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
  const store = options.store || await openStore(config, options);
  const service = providers(config);
  const portal = config.portalEnabled ? createPortal(config, store, service, { ...options, sessionOpen, isOptedOut: optedOut }) : null;
  const portalUrl = config.publicUrl + '/cliente';
  const portalText = 'Consulta tus pedidos, reservas, carta y comprobantes en el portal de El Establo: ' + portalUrl;
  const ai = agentAI(config, service);
  const initialSettings = defaults(config);
  const settings = async () => {
    const saved = await store.settings();
    const merged = completeSettings(saved, initialSettings);
    // Los defaults de la interfaz no cuentan como configuración guardada del aforo.
    merged.availabilityConfigured = availabilityConfigured(saved || {});
    return merged;
  };
  const locks = new Map();
  const rateEvents = new Map();
  const rateWarned = new Map();
  const noReservationReplied = new Map();
  const reservationListRepliedAt = new Map();
  const seenMessages = new Set();
  const optOutPhrases = new Set(['stop', 'baja', 'darme de baja', 'no quiero mensajes']);
  let lastN8nWakeWarningAt = 0;

  function warnWakeFailure(message) {
    const now = Date.now();
    if (now - lastN8nWakeWarningAt < 60_000) return;
    lastN8nWakeWarningAt = now;
    console.warn(message);
  }

  function wakeN8n() {
    if (config.orchestration !== 'n8n' || !config.env.N8N_WAKE_URL) return;
    void Promise.resolve().then(() => fetch(config.env.N8N_WAKE_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.env.N8N_AGENT_TOKEN },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })).then(response => {
      if (!response.ok) warnWakeFailure('No se pudo despertar n8n (HTTP ' + response.status + '); continuará el ciclo programado.');
    }).catch(() => warnWakeFailure('No se pudo despertar n8n; continuará el ciclo programado.'));
  }

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
  const unsupportedTypeRepliedAt = new Map();
  const update = (id, apply) => updateOrder(store, id, apply);
  const linkFor = (intent) => config.publicUrl + '/pago/' + intent.id;
  const receiptLink = (receipt) => config.publicUrl + '/comprobante/' + receipt.token;
  const datePlus = (key, days) => new Date(+new Date(key + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  function availabilityRangeFromText(text, at) {
    const plain = commandText(text);
    const today = limaDateKey(new Date(at));
    const explicit = plain.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (explicit) {
      const parsed = new Date(explicit[1] + 'T12:00:00Z');
      if (Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === explicit[1])
        return { fromDate: explicit[1], toDate: explicit[1], label: 'el ' + explicit[1] };
      return null;
    }
    if (/\b(?:proxima semana|siguiente semana|semana que viene)\b/.test(plain)) {
      const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
      const daysUntilMonday = (8 - weekday) % 7 || 7;
      const fromDate = datePlus(today, daysUntilMonday);
      return { fromDate, toDate: datePlus(fromDate, 6), label: 'la próxima semana' };
    }
    if (/\besta semana\b/.test(plain)) {
      const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
      const daysUntilSunday = (7 - weekday) % 7;
      return { fromDate: today, toDate: datePlus(today, daysUntilSunday), label: 'esta semana' };
    }
    if (/\bmanana\b/.test(plain)) return { fromDate: datePlus(today, 1), toDate: datePlus(today, 1), label: 'mañana' };
    if (/\bhoy\b/.test(plain)) return { fromDate: today, toDate: today, label: 'hoy' };
    const weekdays = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const index = weekdays.findIndex(day => new RegExp('\\b' + day + '\\b').test(plain));
    if (index >= 0) {
      const current = new Date(today + 'T12:00:00Z').getUTCDay();
      let offset = (index - current + 7) % 7;
      const fromDate = datePlus(today, offset);
      return { fromDate, toDate: fromDate, label: 'el ' + weekdays[index] };
    }
    return null;
  }
  async function availabilityAnswer(text, at) {
    const range = availabilityRangeFromText(text, at);
    if (!range) return 'Claro. ¿Para qué día o período quieres consultar la disponibilidad? Puedes decir, por ejemplo, «mañana» o «la próxima semana».';
    const peopleMatch = commandText(text).match(/\bpara\s+(\d{1,2})\s+personas?\b/);
    const guests = peopleMatch ? Number(peopleMatch[1]) : 1;
    if (!Number.isInteger(guests) || guests < 1 || guests > 40) return 'Dime la cantidad de personas, entre 1 y 40, para revisar el aforo.';
    const { rule, days } = await availableDays({ ...range, guests });
    if (!availabilityConfigured(rule)) return 'Aún no está configurado el horario y aforo en el sistema. El personal puede confirmarte la disponibilidad.';
    if (!days.length) return 'No encuentro horarios libres para ' + range.label + ' según el horario, los bloqueos y el aforo actuales.';
    const lines = days.map(day => day.label + ': ' + day.slots.map(slot => slot.time).join(', '));
    return '📅 Horarios con disponibilidad para ' + range.label + ' (para ' + guests + (guests === 1 ? ' persona' : ' personas') + '):\n'
      + lines.join('\n') + '\n\nLa disponibilidad final depende de la cantidad de personas. Para solicitar la reserva, envíame el formato RESERVA con el día y la hora elegidos.';
  }
  async function availableDays({ fromDate = limaDateKey(new Date()), toDate, guests = 1, excludeOrderId = null } = {}) {
    const rule = await settings();
    const endDate = toDate || datePlus(fromDate, rule.offerWindowDays);
    const [orders, blocks] = await Promise.all([store.list(), store.availabilityBlocks(fromDate, endDate)]);
    return { rule, days: getAvailableSlots({ orders, blocks, settings: rule, fromDate, toDate: endDate, guests, excludeOrderId }) };
  }
  async function ensureAvailable(visitAt, guests, excludeOrderId = null, rule = null, forceCapacity = false) {
    const setting = rule || await settings();
    if (!(setting.availabilityConfigured ?? availabilityConfigured(setting))) return true;
    validateSlotInput(visitAt, setting);
    const key = limaDateKey(visitAt);
    const blocks = await store.availabilityBlocks(key, key);
    requireThat(!isSlotBlocked(blocks, visitAt, setting), 'Ese horario está bloqueado. Elige otra opción.', 409);
    const { days } = await availableDays({ fromDate: key, toDate: key, guests, excludeOrderId });
    const exact = days.flatMap(day => day.slots).some(slot => +new Date(slot.visitAt) === +new Date(visitAt));
    requireThat(exact || forceCapacity, 'Ese horario no tiene cupo suficiente o está bloqueado.', 409);
    return exact;
  }
  function reservationAvailabilityMessage(error, visitAt, guests, rule) {
    if (!availabilityConfigured(rule)) return error.message;
    if (Number(guests) > Number(rule.capacityPerSlot))
      return `Ese grupo supera el máximo de ${rule.capacityPerSlot} personas por horario. Escribe 'hablar con alguien' para coordinarlo.`;
    const local = new Date(+new Date(visitAt) - 5 * 3600000);
    const key = local.toISOString().slice(0, 10), weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][local.getUTCDay()];
    const hours = rule.weeklySchedule?.[weekday];
    const day = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', weekday: 'long' }).format(new Date(visitAt));
    if (!hours) return `El ${day} el restaurante está cerrado según el horario de atención configurado.`;
    const [oh, om] = hours.open.split(':').map(Number), [ch, cm] = hours.close.split(':').map(Number);
    const duration = Number(rule.slotMinutes || 60), minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minute < oh * 60 + om || minute + duration > ch * 60 + cm)
      return `El horario de atención del ${day} es de ${hours.open} a ${hours.close}.`;
    if ((minute - (oh * 60 + om)) % duration !== 0) {
      const slots = [];
      for (let value = oh * 60 + om; value + duration <= ch * 60 + cm; value += duration)
        slots.push(String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0'));
      return `La hora no coincide con las franjas del ${day}. Franjas válidas: ${slots.join(', ')}.`;
    }
    if (/bloquead/i.test(error.message)) return 'Ese horario no está disponible.';
    if (/cerrado/i.test(error.message)) return `El horario de atención del ${day} es de ${hours.open} a ${hours.close}.`;
    return 'No hay cupo en ese horario. Puedes volver a enviar el bloque con otra fecha u hora.';
  }
  function lock(id, execute) {
    const previous = locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(execute);
    locks.set(id, next);
    return next.finally(() => { if (locks.get(id) === next) locks.delete(id); });
  }
  async function checkout(id, method = 'checkout', purpose = 'deposit', forceNew = false, staff = null) {
    requireThat(method === 'checkout', 'Solo está disponible el pago en línea con Mercado Pago.', 409);
    const rule = await settings();
    if (portal) method = 'checkout';
    const mode = method === 'checkout' ? config.paymentMode : 'local';
    return lock(id, async () => {
      const intentId = randomUUID();
      const { order, result: intent } = await update(id, data => {
        const amount = purpose === 'deposit' ? depositDue(data) : balance(data);
        requireThat(purpose === 'deposit' ? data.stage === 'awaiting_deposit' && amount > 0
          : data.stage === 'arrived' && amount > 0, purpose === 'deposit' ? 'La reserva no tiene anticipo pendiente.' : 'El saldo solo se habilita después de registrar la llegada.', 409);
        const expiresAt = purpose === 'deposit'
          ? portal ? new Date(Math.min(+new Date(data.deadline), Date.now() + rule.depositLinkExpiryMinutes * 60000)).toISOString() : data.deadline
          : new Date(Date.now() + rule.balanceLinkExpiryMinutes * 60000).toISOString();
        requireThat(purpose !== 'deposit' || new Date(data.deadline) > new Date(), 'El plazo del anticipo venció. Revisa la reserva.', 409);
        for (const old of data.intents) if ((old.purpose || 'deposit') === purpose && old.status === 'pending'
          && new Date(old.expiresAt) <= new Date()) old.status = 'expired';
        const reusable = data.intents.find(i => (i.purpose || 'deposit') === purpose && i.mode === mode
          && (i.method || 'checkout') === method && i.amount === amount
          && i.status === 'pending' && (purpose === 'deposit' && !portal ? i.expiresAt === expiresAt : new Date(i.expiresAt) > new Date())
          && (mode !== 'mercado_pago' || isMercadoPagoInitPoint(i.checkoutUrl)));
        if (reusable) return reusable;
        const previous = data.intents.filter(i => (i.purpose || 'deposit') === purpose);
        if (portal) {
          const maximum = Math.min(3, purpose === 'deposit' ? rule.maxDepositLinks : rule.maxBalanceLinks);
          requireThat(previous.length < maximum, 'Se alcanzó el máximo de enlaces de ' + (purpose === 'deposit' ? 'anticipo' : 'saldo') + '.', 409);
          const last = previous.at(-1);
          if (last) {
            const since = +new Date(last.status === 'expired' ? last.expiresAt : last.updatedAt || last.createdAt || 0);
            requireThat(Date.now() - since >= rule.paymentRetryMinutes * 60000, 'Espera el intervalo configurado para emitir otro enlace.', 409);
          }
        }
        if (purpose === 'balance') {
          const issued = data.intents.filter(i => (i.purpose || 'deposit') === 'balance').length;
          requireThat(issued < rule.maxBalanceLinks, 'Se alcanzó el máximo de enlaces de saldo. El personal se acercará para ayudarte.', 409);
          for (const old of data.intents) if ((old.purpose || 'deposit') === 'balance' && old.status === 'pending') old.status = 'expired';
        }
        const row = { id: intentId, purpose, amount, expiresAt, status: 'pending', mode, method,
          createdAt: instant(), number: previous.length + 1, ...(staff ? { staffId: staff.id } : {}) };
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
  async function sendResolutionNotice(orderId, incidentId) {
    const { result: original } = await update(orderId, data => {
      const issue = data.incidents.find(item => item.id === incidentId && item.resolvedAt);
      const pending = data.incidents.find(item => item.type === 'Aviso de resolución pendiente'
        && item.key === 'resolution-notice:' + incidentId && !item.resolvedAt);
      if (!issue || !pending || pending.noticeStatus === 'sent') return null;
      if (pending.noticeStatus === 'sending' && Date.now() - +new Date(pending.noticeAttemptAt) < 5 * 60000) return null;
      pending.noticeStatus = 'sending'; pending.noticeAttemptAt = instant();
      return structuredClone(issue);
    });
    if (!original) return { sent: false, error: 'El aviso ya se envió o se está procesando.' };
    const current = (await store.get(orderId))?.data;
    try {
      requireThat(current?.phone && config.isPhoneAllowed(current.phone) && !config.isPhoneBlocked(current.phone)
        && !(await optedOut(current.phone)), 'El número no admite mensajes.', 409);
      requireThat(config.waMode !== 'cloud' || await sessionOpen(current.phone),
        'La ventana de WhatsApp está cerrada. Pide al cliente que escriba «hola» para poder avisarle.', 409);
      await send(current, '✅ *Actualización de tu solicitud*\nReserva: *' + current.ref + '*\n'
        + original.type + ': ' + original.resolution + '\n\nSi necesitas más ayuda, responde a este mensaje.', { reply: true });
      await update(orderId, data => {
        const pending = data.incidents.find(item => item.type === 'Aviso de resolución pendiente'
          && item.key === 'resolution-notice:' + incidentId && !item.resolvedAt);
        if (pending) { pending.resolvedAt = instant(); pending.resolution = 'Aviso enviado al cliente.'; pending.noticeStatus = 'sent'; }
        addEvent(data, 'Resolución comunicada al cliente por WhatsApp', original.type, 'Operador');
      });
      return { sent: true };
    } catch (error) {
      await update(orderId, data => {
        const pending = data.incidents.find(item => item.type === 'Aviso de resolución pendiente'
          && item.key === 'resolution-notice:' + incidentId && !item.resolvedAt);
        if (pending) { pending.detail = error.message; pending.noticeStatus = 'failed'; }
      });
      return { sent: false, error: error.message };
    }
  }
  function paymentReceiptUrl(payment) {
    if (!payment || payment.channel !== 'mercadopago' || !/^MP-\d+$/.test(String(payment.ref || ''))) return null;
    return 'https://www.mercadopago.com.pe/ccap/file-viewer/receipt?' + new URLSearchParams({
      flow: 'cow_payment_receipts', origin: 'feedback-screen', payment_id: payment.ref.slice(3) });
  }
  function paymentForReceipt(order, receipt) {
    const activePayments = order.payments.filter(item => item.amount > 0
      && !order.payments.some(adjustment => adjustment.original === item.ref && adjustment.amount < 0));
    return activePayments.find(item => item.ref === receipt.paymentRef)
      || activePayments.find(item => receipt.intentId && item.intentId === receipt.intentId)
      || activePayments.filter(item => (item.purpose || 'deposit') === receipt.purpose && item.amount === receipt.amount)
        .sort((a, b) => +new Date(b.at || 0) - +new Date(a.at || 0))[0]
      || null;
  }
  const openPaymentIssue = order => order.incidents.some(item => !item.resolvedAt
    && ['Pago por revisar', 'Reverso por revisar'].includes(item.type));
  async function deliverReceipt(order, receipt, { force = false } = {}) {
    const keyList = [receipt].map(item => item.token + ':' + item.purpose);
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
    const receiptPayment = receipt.purpose === 'settlement' ? null : paymentForReceipt(order, receipt);
    const officialUrl = paymentReceiptUrl(receiptPayment);
    const messageUrl = receipt.purpose !== 'settlement' && officialUrl ? officialUrl : receiptLink(receipt);
    const depositPayment = allPayments.find(item => (item.purpose || 'deposit') === 'deposit');
    const depositMethod = depositPayment?.channel === 'mercadopago' ? 'Mercado Pago'
      : depositPayment?.channel === 'cash' ? 'efectivo' : depositPayment?.channel === 'pos' ? 'POS'
        : depositPayment?.channel === 'wallet' ? 'billetera' : depositPayment?.channel || 'verificado';
    const summary = receipt.purpose === 'deposit'
      ? 'Anticipo ' + money(receipt.amount) + ' · ' + depositMethod + ' · '
        + new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }).format(new Date(depositPayment?.at || receipt.at))
        + (officialUrl ? ' · Comprobante oficial de Mercado Pago' : '')
      : (receipt.paymentBreakdown || []).map(item => (item.purpose === 'deposit' ? 'Anticipo' : 'Saldo') + ' ' + money(item.amount)
        + ' (' + (item.channel === 'mercadopago' ? 'Mercado Pago' : item.channel === 'cash' ? 'efectivo' : item.channel === 'pos' ? 'POS' : item.channel === 'wallet' ? 'billetera' : item.channel) + ')').join(' · ')
        + (allPayments.some(item => item.channel === 'mercadopago') ? ' · Comprobante oficial: consultar cada operación en Mercado Pago' : '');
    const amount = receipt.purpose === 'deposit' ? 'Anticipo ' + money(receipt.amount) : 'Total ' + money(order.total) + ' · ' + summary
      + (receipt.purpose === 'settlement' ? '\n\n🙏 ¡Gracias por elegir El Establo! Esperamos verte pronto.' : '');
    const message = receipt.purpose === 'deposit'
      ? confirmationCta(order, messageUrl, new Date(), officialUrl ? 'Comprobante oficial de Mercado Pago.' : '')
      : receipt.purpose === 'balance' && officialUrl
        ? paymentReceiptCta(order, receipt, messageUrl)
        : receiptCta(order, messageUrl, amount);
    try {
      if (config.waMode !== 'cloud') {
        await update(order.id, data => {
          data.chat.push({ id: 'SIM-' + randomUUID(), at: instant(), direction: 'out', status: 'simulated', text: displayText(message) });
          for (const key of keyList) Object.assign(data.receiptDeliveries[key], { status: 'simulated', at: instant(), messageId: null });
        });
      } else {
        const template = receipt.purpose === 'deposit' && officialUrl ? 'confirmation'
          : receipt.purpose === 'balance' && officialUrl ? 'balanceReceipt' : 'settlement';
        const result = await send(order, message, { template,
          receiptUrlSuffix: officialUrl ? receiptPayment.ref.slice(3) : receipt.token,
          templateValues: template === 'confirmation'
            ? [order.payer, order.ref, friendlyDate(order.visitAt, new Date(), true), money(receipt.amount), summary]
            : template === 'balanceReceipt' ? [order.payer, order.ref, 'Saldo', money(receipt.amount)]
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
    const pending = fresh.receipts.filter(item => !['sent', 'simulated', 'suppressed'].includes(
      fresh.receiptDeliveries?.[item.token + ':' + item.purpose]?.status));
    for (const receipt of pending) await deliverReceipt(fresh, receipt);
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
    const payerPhone = phone;
    return lock('reservation:' + payerPhone, async () => {
      const operator = false;
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
      if (open.length >= rule.maxOpenReservationsPerPhone) {
        return refuse(texts.reservationLimit.replace('{limit}', String(rule.maxOpenReservationsPerPhone)));
      }

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
      catch (error) { return refuse(reservationAvailabilityMessage(error, order.visitAt, order.guests, rule)); }
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
    const bookingRequest = action?.action === 'book' || reservationRequest(text) || /^\s*RESERVA(?:\s|$)/i.test(String(text || ''));
    if (bookingRequest) {
      if (config.canReserve(phone)) await service.sendWhatsAppReply(phone, reservationInstructionsMessage({ availabilityQuestion: availabilityInquiry(text) }));
      else {
        await store.noteQuery(phone, excerpt, true);
        await service.sendWhatsAppReply(phone, texts.reservationUnavailable);
      }
      return;
    }
    if (action?.action === 'orders' || reservationListRequest(text)) {
      await service.sendWhatsAppReply(phone, customerReservationsEmptyMessage());
      return;
    }
    if (action?.action === 'menu' || isGreeting(text)
      || new Set(['ayuda', 'menu', 'menu principal', 'inicio']).has(commandText(text))) {
      const last = noReservationReplied.get(phone) || 0;
      if (Date.now() - last < 12 * 3600000) return;
      noReservationReplied.set(phone, Date.now());
      await service.sendWhatsAppReply(phone, noReservationMessage());
      return;
    }
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
  async function sendBalanceLink(order, { forceNew = false, reply = false, staff = null } = {}) {
    try {
      if (!reply && (!order.consent || !config.isPhoneAllowed(order.phone) || config.isPhoneBlocked(order.phone) || await optedOut(order.phone))) {
        throw new Problem('No se envió el link automático: falta consentimiento o el teléfono no admite mensajes iniciados por el restaurante.', 409);
      }
      const intent = await checkout(order.id, 'checkout', 'balance', forceNew, staff);
      const current = (await store.get(order.id))?.data || order;
      const text = balancePaymentCta(current, intent, linkFor(intent));
      const result = await send(current, text, { template: 'balance', intent, reply,
        templateValues: [current.payer, current.ref, money(intent.amount)] });
      await update(order.id, data => {
        for (const incident of data.incidents) if (incident.type === 'Envío del link de saldo pendiente'
          && incident.key === 'balance-link-send' && !incident.resolvedAt) {
          incident.resolvedAt = instant(); incident.resolution = 'El enlace se envió correctamente.';
        }
        for (const incident of data.incidents) if (incident.type === 'Solicitud de pago en línea' && !incident.resolvedAt) {
          incident.resolvedAt = instant(); incident.resolution = 'Se envió el enlace solicitado por el cliente.';
        }
      });
      if (staff) return (await update(result.id, data => addEvent(data, 'Enlace de saldo enviado por caja', intent.id, staff.name))).order;
      return result;
    } catch (error) {
      await update(order.id, data => openIssue(data, 'Envío del link de saldo pendiente', error.message, 'balance-link-send'));
      if (/máximo de enlaces/i.test(error.message)) await update(order.id, data => openIssue(data,
        'Máximo de enlaces de saldo alcanzado', 'No se generó otro enlace; el personal debe acercarse.', 'balance-link-limit'));
      throw error;
    }
  }
  async function sendAttendanceConfirmation(order) {
    const claimed = await update(order.id, data => {
      if (!data.attendance?.at || data.attendance.state !== 'confirmed' || data.attendance.customerConfirmationStatus === 'sent') return false;
      if (data.chat.some(message => message.direction === 'out' && /Asistencia confirmada/.test(message.text || ''))) {
        data.attendance.customerConfirmationStatus = 'sent';
        data.attendance.customerConfirmationAt ||= instant();
        return false;
      }
      if (data.attendance.customerConfirmationStatus === 'sending'
        && Date.now() - +new Date(data.attendance.customerConfirmationAttemptAt) < 5 * 60000) return false;
      data.attendance.customerConfirmationStatus = 'sending';
      data.attendance.customerConfirmationAttemptAt = instant();
      return true;
    });
    if (!claimed.result) return false;
    const current = (await store.get(order.id))?.data || order;
    const message = '✅ *Asistencia confirmada*\nReserva: *' + current.ref + '*\nEl personal registró tu llegada. ¡Que disfrutes tu visita!';
    try {
      if (!current.phone || !config.isPhoneAllowed(current.phone) || config.isPhoneBlocked(current.phone) || await optedOut(current.phone)) {
        throw new Problem('No se pudo avisar al cliente: el número no admite mensajes.', 409);
      }
      await send(current, message, { reply: true });
      await update(current.id, data => {
        data.attendance.customerConfirmationStatus = 'sent';
        data.attendance.customerConfirmationAt = instant();
        for (const issue of data.incidents) if (issue.type === 'Confirmación de asistencia pendiente'
          && !issue.resolvedAt) { issue.resolvedAt = instant(); issue.resolution = 'WhatsApp aceptó la confirmación.'; }
        addEvent(data, 'Asistencia confirmada por WhatsApp al cliente', '', 'Sistema');
      });
      return true;
    } catch (error) {
      await update(current.id, data => {
        data.attendance.customerConfirmationStatus = 'failed';
        openIssue(data, 'Confirmación de asistencia pendiente', error.message, 'attendance-confirmation:' + current.visitAt);
      });
      return false;
    }
  }
  async function sendNoShowNotification(order) {
    const claimed = await update(order.id, data => {
      if (data.stage !== 'no_show' || data.noShowNoticeStatus === 'sent') return false;
      if (data.chat.some(message => message.direction === 'out' && /Inasistencia registrada/i.test(message.text || ''))) {
        data.noShowNoticeStatus = 'sent'; data.noShowNoticeAt ||= instant();
        return false;
      }
      if (data.noShowNoticeStatus === 'sending'
        && Date.now() - +new Date(data.noShowNoticeAttemptAt) < 5 * 60000) return false;
      data.noShowNoticeStatus = 'sending'; data.noShowNoticeAttemptAt = instant();
      return true;
    });
    if (!claimed.result) return false;
    const current = (await store.get(order.id))?.data || order;
    const message = '📌 *Inasistencia registrada*\nReserva: *' + current.ref + '*\nEl personal registró que no pudiste asistir a tu visita de '
      + friendlyDate(current.visitAt, new Date(), true) + '. Si sí acudiste o necesitas revisar el anticipo, responde a este mensaje para que podamos ayudarte.';
    try {
      if (!current.phone || !current.consent || !config.isPhoneAllowed(current.phone)
        || config.isPhoneBlocked(current.phone) || await optedOut(current.phone)) {
        throw new Problem('No se pudo avisar al cliente: falta autorización o el número no admite mensajes.', 409);
      }
      await send(current, message, { template: 'noShow', templateValues: [current.payer, current.ref,
        friendlyDate(current.visitAt, new Date(), true)] });
      await update(current.id, data => {
        data.noShowNoticeStatus = 'sent'; data.noShowNoticeAt = instant();
        for (const issue of data.incidents) if (issue.type === 'Aviso de inasistencia pendiente'
          && !issue.resolvedAt) { issue.resolvedAt = instant(); issue.resolution = 'WhatsApp aceptó el aviso.'; }
        addEvent(data, 'Aviso de inasistencia enviado al cliente', '', 'Sistema');
      });
      return true;
    } catch (error) {
      await update(current.id, data => {
        data.noShowNoticeStatus = 'failed';
        openIssue(data, 'Aviso de inasistencia pendiente', error.message, 'no-show-notice:' + current.visitAt);
      });
      return false;
    }
  }
  async function notifyRejectedPayment(order, rejectedIntent) {
    if (portal) {
      if (await sessionOpen(order.phone)) {
        try {
          await sendReply(order, rejectedIntent.purpose === 'balance'
            ? 'El pago fue rechazado. Pide a caja otro enlace si necesitas reintentar.'
            : 'El pago fue rechazado. Escribe «anticipo» si quieres solicitar un nuevo enlace.');
        } catch (error) {
          await update(order.id, data => openIssue(data, 'Aviso de pago no aprobado pendiente', error.message, 'payment-rejected-notice:' + rejectedIntent.id));
        }
      } else {
        await update(order.id, data => openIssue(data, 'Aviso de pago no aprobado pendiente',
          'La ventana de WhatsApp está cerrada y no se envió el aviso. Pide al cliente que escriba «hola» para abrirla.', 'payment-rejected-notice:' + rejectedIntent.id));
      }
      return;
    }
    if (config.waMode !== 'cloud' || !order.consent || !config.isPhoneAllowed(order.phone)
      || config.isPhoneBlocked(order.phone) || await optedOut(order.phone)) return;
    const activeSession = await sessionOpen(order.phone);
    const templateName = rejectedIntent.purpose === 'balance' ? config.env.WA_TEMPLATE_BALANCE : config.env.WA_TEMPLATE_PAYMENT_REJECTED;
    if (!activeSession && !templateName) {
      await update(order.id, data => openIssue(data, 'Aviso de pago no aprobado pendiente',
        'Fuera de la ventana de WhatsApp se necesita una plantilla aprobada. Configura ' + (rejectedIntent.purpose === 'balance' ? 'WA_TEMPLATE_BALANCE.' : 'WA_TEMPLATE_PAYMENT_REJECTED.'), 'payment-rejected-notice:' + rejectedIntent.id));
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
      await update(order.id, data => openIssue(data, 'Aviso de pago no aprobado pendiente', error.message, 'payment-rejected-notice:' + rejectedIntent.id));
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
      if (p.status === 'approved' && !data.payments.some(payment => payment.ref === ref)
        && ((purpose === 'deposit' && portal && (intent.status === 'superseded' || depositDue(data) !== amount
          || data.stage !== 'awaiting_deposit' || new Date(p.date_approved || instant()) > new Date(intent.expiresAt)))
        || (purpose === 'balance' && (intent.status === 'superseded' || balance(data) === 0 || data.stage !== 'arrived'
          || new Date(p.date_approved || instant()) > new Date(intent.expiresAt))))) {
        if (!data.unappliedPayments?.some(item => item.ref === ref)) {
          data.unappliedPayments ||= [];
          data.unappliedPayments.push({ ref, intentId: intent.id, amount, purpose, at: p.date_approved || instant(), reason: 'El pago ya no corresponde al importe, estado o plazo de la reserva.' });
          openIssue(data, 'Pago por revisar', 'Mercado Pago aprobó un pago que ya no puede aplicarse. Operación: ' + ref, ref);
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
          intent.updatedAt = instant();
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
  const mpRecheck = intent => intent.mode === 'mercado_pago' && (intent.status === 'pending'
    || (portal && intent.status === 'expired' && !intent.verifiedExpiredAt && intent.checkoutUrl));
  const depositNeedsReview = order => order.intents.some(intent => (intent.purpose || 'deposit') === 'deposit' && mpRecheck(intent))
    || order.incidents.some(incident => !incident.resolvedAt && ['Pago informado por el cliente', 'Pago por revisar'].includes(incident.type));
  let paymentReconciliationRunning = false;
  async function reconcilePendingPayments() {
    if (config.paymentMode !== 'mercado_pago' || paymentReconciliationRunning) return { checked: 0, updated: 0 };
    paymentReconciliationRunning = true;
    let checked = 0, updated = 0;
    try {
      const now = Date.now();
      const orders = await store.list();
      const pending = orders.flatMap(order => (order.intents || [])
        .filter(intent => mpRecheck(intent)
          && intent.expiresAt && now <= +new Date(intent.expiresAt) + 7 * 86400000
          && now - +new Date(intent.lastMpCheckAt || 0) >= 120000)
        .map(intent => ({ order, intent })))
        .sort((a, b) => +new Date(a.intent.expiresAt) - +new Date(b.intent.expiresAt)).slice(0, 10);
      for (const { order, intent } of pending) {
        const stamp = instant();
        const { result: claimed } = await update(order.id, data => {
          const row = data.intents.find(item => item.id === intent.id);
          if (!row || !mpRecheck(row) || Date.now() - +new Date(row.lastMpCheckAt || 0) < 120000) return false;
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
          const unsettled = candidates.some(item => !['approved','rejected','cancelled','refunded','charged_back'].includes(item.status));
          if (portal && !unsettled && !candidates.some(item => item.status === 'approved') && +new Date(intent.expiresAt) <= Date.now()) {
            await update(order.id, data => {
              const row = data.intents.find(item => item.id === intent.id);
              if (row && mpRecheck(row)) { row.status = 'expired'; row.verifiedExpiredAt = instant(); }
            });
          }
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
    if (order.stage === 'cancelled' && forced?.intent !== 'receipt' && forced?.intent !== 'human') return reservationMenu(order);
    if (order.stage === 'no_show' && forced?.intent !== 'receipt') {
      await update(order.id, data => openIssue(data, 'Revisión de inasistencia solicitada por cliente', String(text || 'El cliente consultó una reserva marcada como no asistió.').slice(0, 500), 'no-show-customer:' + order.ref));
      return reservationMenu(order);
    }
    if (/^(?:yape|plin)$/i.test(String(text || '').trim())
      || (/\b(?:pagar|pago|enlace|link)\b/i.test(String(text || '')) && /\b(?:yape|plin)\b/i.test(String(text || '')))) {
      return 'Por ahora, el pago en línea de esta reserva se realiza con Mercado Pago. Usa «Pagar anticipo» para continuar.';
    }
    const analysis = forced || await ai.classify(text);
    const { intent: intentType, method, paymentIssue, priority, customerReply } = analysis;
    switch (intentType) {
      case 'link': {
        if (order.stage !== 'awaiting_deposit') return summary;
        if (new Date(order.deadline) <= new Date()) return summary + ' El plazo del anticipo venció. Puedo derivar la revisión al personal.';
        if (/\befectivo\b/i.test(text)) return 'El anticipo de ' + order.ref + ' se paga en línea. Puedes pagar el saldo en efectivo cuando llegues al restaurante.';
        const rule = await settings();
        const intent = await checkout(order.id, method);
        return paymentCta(order, intent, linkFor(intent));
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
        const issueLabels = { expired_link: 'enlace vencido', payment_declined: 'medio de pago rechazado', technical_error: 'error técnico',
          amount_mismatch: 'posible diferencia de importe', payment_method: 'consulta sobre medio de pago', other: 'motivo por revisar' };
        const aiNote = intentType === 'issue' && paymentIssue
          ? 'Clasificación asistida: ' + (issueLabels[paymentIssue] || 'motivo por revisar') + '. Prioridad sugerida: ' + (priority === 'high' ? 'alta' : 'normal') + '. ' : '';
        await update(order.id, data => {
          openIssue(data, type, aiNote + text.slice(0, 500));
          if (intentType === 'issue' && paymentIssue) {
            const incident = [...data.incidents].reverse().find(item => item.type === type && !item.resolvedAt);
            if (incident) { incident.aiCategory = paymentIssue; incident.priority = priority === 'high' ? 'high' : 'normal'; }
          }
        });
        return (intentType === 'issue' ? (customerReply || 'Gracias por avisarme.') + '\n\n' : '')
          + requestMessage(order, intentType);
      }
      case 'receipt': {
        if (portal) return portalText;
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
        return '📅 *Datos de tu visita*\nReserva: *' + order.ref + '*\nFecha y hora: '
          + friendlyDate(order.visitAt, new Date(), true) + '\nPersonas: ' + order.guests
          + '\nSi necesitas cambiarla, escribe «cambiar fecha».';
      }
      case 'balance': return [
        '💳 *Resumen de pagos*',
        'Reserva: *' + order.ref + '*',
        'Estado: ' + stageLabels[order.stage],
        'Total acordado: *' + money(order.total) + '*',
        'Pagado registrado: *' + money(paid(order)) + '*',
        'Saldo pendiente: *' + money(balance(order)) + '*',
        ...(order.stage === 'closed' && balance(order) === 0 ? ['La cobranza figura completada.'] : []),
      ].join('\n');
      case 'menu':
      default: return reservationMenu(order);
    }
  }
  async function startReschedule(order, action, phone) {
    const rule = await settings();
    try { checkRescheduleEligibility(order, rule, phone); }
    catch (error) {
      if (order.stage === 'awaiting_deposit' && depositDue(order) > 0 && +new Date(order.deadline) <= Date.now()) {
        return { response: buttonsMessage('El plazo del anticipo venció. Primero renueva el plazo o cancela la reserva *' + order.ref + '*.', [
          { id: 'ren:' + order.ref, title: 'Pedir nuevo plazo' }, { id: 'can:' + order.ref, title: 'Cancelar reserva' },
          { id: 'hum:' + order.ref, title: 'Hablar con alguien' },
        ]) };
      }
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
    const latest = (await store.get(order.id))?.data;
    if (!latest || latest.phone !== phone) return { response: 'No pude validar esta reserva desde tu número. Escribe «ver mis reservas» para actualizar la lista.' };
    order = latest;
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
      if (order.stage === 'awaiting_deposit' && depositDue(order) > 0 && +new Date(order.deadline) <= Date.now()) {
        return { response: buttonsMessage('El plazo del anticipo venció. Primero renueva el plazo o cancela la reserva *' + order.ref + '*.', [
          { id: 'ren:' + order.ref, title: 'Pedir nuevo plazo' }, { id: 'can:' + order.ref, title: 'Cancelar reserva' },
          { id: 'hum:' + order.ref, title: 'Hablar con alguien' },
        ]) };
      }
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
    const forced = { pay: { intent: 'link', method: 'checkout' }, bal: { intent: 'balance' }, rcp: { intent: 'receipt' },
      chg: { intent: 'change' }, hum: { intent: 'human' } }[action];
    const phrase = { pay: 'anticipo', bal: 'saldo', rcp: 'comprobante',
      chg: 'reprogramar', hum: 'ayuda' }[action];
    return replyTo(order, phrase || '', undefined, forced);
  }
  async function renewDepositForCustomer(orderId, phone) {
    const rule = await settings();
    let current = (await store.get(orderId))?.data;
    requireThat(current && current.phone === phone, 'Esta reserva no pertenece a este número.', 403);
    requireThat(current.stage === 'awaiting_deposit' && +new Date(current.deadline) <= Date.now(), 'El anticipo ya no está vencido o la reserva cambió. Actualiza tus reservas.', 409);
    requireThat(!(current.payments || []).length, 'La reserva ya tiene un pago registrado. El personal debe revisar el caso.', 409);
    requireThat(Number(current.depositRenewals || 0) < rule.depositRenewalsMax, 'Ya pediste el nuevo plazo permitido para esta reserva. Hablaré con el personal.', 409);
    requireThat(+new Date(current.visitAt) > Date.now() + 2 * 3600000, 'La visita debe estar a más de 2 horas para pedir un nuevo plazo.', 409);
    requireThat(availabilityConfigured(rule), 'La disponibilidad no está configurada; el personal debe revisar el cupo antes de renovar.', 409);
    await ensureAvailable(current.visitAt, current.guests, current.id, rule);
    const saved = await store.renewDepositAtomic(current.id, rule, 'Cliente', current.visitAt, phone);
    current = saved.data || saved;
    try {
      const intent = await checkout(current.id);
      const fresh = (await store.get(current.id))?.data || current;
      await send(fresh, paymentCta(fresh, intent, linkFor(intent)), { template: 'deposit', intent, reply: true });
    } catch (error) {
      await update(current.id, data => openIssue(data, 'Enlace de anticipo pendiente', error.message, 'renewed-deposit-link:' + current.id));
      await sendReply(current, 'El plazo se renovó, pero no pude enviar el enlace de anticipo. Ya avisé al personal para que lo revise.');
    }
  }

  async function cancelCustomerReservation(orderId, phone, confirm = false) {
    const { data: current } = await store.get(orderId) || {};
    requireThat(current && current.phone === phone, 'Esta reserva no pertenece a este número.', 403);
    requireThat(current.stage === 'awaiting_deposit' && +new Date(current.deadline) <= Date.now(), 'Esta reserva ya cambió o el plazo sigue vigente. Actualiza tus reservas.', 409);
    if ((current.payments || []).length) {
      await update(orderId, data => openIssue(data, 'Solicitud de cancelación o devolución', 'El cliente pidió cancelar una reserva con pagos registrados.', 'customer-cancel:' + orderId));
      return buttonsMessage('La reserva tiene un pago registrado. No haré una devolución ni la cancelaré automáticamente; ya avisé al personal.', [
        { id: 'hum:' + current.ref, title: 'Hablar con alguien' },
      ]);
    }
    if (!confirm) return cancelReservationConfirmMessage(current);
    const { result } = await update(orderId, data => {
      requireThat(data.phone === phone && data.stage === 'awaiting_deposit' && +new Date(data.deadline) <= Date.now() && !(data.payments || []).length,
        'La reserva cambió o tiene un pago registrado. Actualiza tus reservas.', 409);
      data.stage = 'cancelled';
      addEvent(data, 'Reserva cancelada por el cliente', 'Cancelación confirmada por WhatsApp.', 'Cliente');
      return true;
    });
    return result ? 'La reserva ' + current.ref + ' quedó cancelada.' : reservationMenu(current);
  }
  async function reportArrival(phone, orders, ref, timestamp, messageId, text, preferredOrder = null) {
    const eligible = orders.filter(order => ['confirmed', 'arrived', 'paid', 'closed'].includes(order.stage)
      && limaDateKey(order.visitAt) === limaDateKey(new Date(timestamp))
      && (ref ? ref === order.ref : !preferredOrder || preferredOrder.ref === order.ref));
    if (!eligible.length) return service.sendWhatsAppReply(phone, 'No encontré una reserva confirmada para hoy. Si ya estás en el local, consulta con caja.');
    if (eligible.length > 1) return service.sendWhatsAppReply(phone, reservationList(eligible, new Date(), 'sela'));
    const order = eligible[0];
    const result = await update(order.id, data => {
      if (!data.chat.some(item => item.id === messageId)) data.chat.push({ id: messageId, from: phone, direction: 'in',
        at: new Date(timestamp).toISOString(), text });
      if (data.attendance?.at) return 'confirmed';
      if (data.stage !== 'confirmed' || data.visitAt !== order.visitAt) return 'changed';
      if (!data.attendance?.reportedAt) {
        data.attendance = { state: 'pending', reportedAt: new Date(timestamp).toISOString() };
        addEvent(data, 'Llegada reportada por WhatsApp', 'Pendiente de confirmación en caja.', 'Pagador');
      }
      return 'pending';
    });
    const message = result.result === 'confirmed' ? '✅ Caja ya confirmó tu asistencia para ' + order.ref + '.'
      : result.result === 'changed' ? 'La reserva cambió. Confirma la referencia con caja.'
        : '📍 Ya avisé al personal de tu llegada para ' + order.ref + '. Espera su confirmación; te escribiré por aquí cuando registren tu asistencia.';
    return sendReply(order, message);
  }
  function recentConversationOrder(orders, at = Date.now()) {
    const mentions = [];
    for (const order of orders) for (const message of order.chat || []) {
      // Conserva la última reserva mencionada durante el día para entender seguimientos breves.
      if (message.direction !== 'out' || at - +new Date(message.at) > 24 * 3600000 || at < +new Date(message.at)) continue;
      const refs = [...new Set((String(message.text || '').match(/EST-[A-F0-9]{8}/gi) || []).map(value => value.toUpperCase()))];
      if (refs.length === 1 && refs[0] === order.ref) mentions.push({ order, at: +new Date(message.at) });
    }
    return mentions.sort((a, b) => b.at - a.at)[0]?.order || null;
  }
  async function requestOnlinePayment(orderId, phone, text) {
    const current = (await store.get(orderId))?.data;
    if (!current || current.phone !== phone) return 'No pude validar esta reserva desde tu número. Escribe «ver mis reservas» para actualizar la lista.';
    const fresh = await update(orderId, data => {
      if (data.phone !== phone) return false;
      if (['confirmed', 'arrived'].includes(data.stage) && balance(data) > 0) {
        openIssue(data, 'Solicitud de pago en línea', 'El cliente solicita el enlace para pagar el saldo. Solicitud por WhatsApp: ' + String(text || '').slice(0, 250), 'customer-online-payment-request');
        return data.stage === 'arrived' ? 'balance' : 'balance-after-arrival';
      }
      return 'unavailable';
    });
    const purpose = fresh.result;
    if (purpose === 'unavailable') return 'No hay un pago en línea pendiente para la reserva ' + current.ref + '. Si necesitas ayuda, escribe «hablar con alguien».';
    if (purpose === 'balance-after-arrival') return '🧾 Registré tu solicitud de pago en línea para ' + current.ref
      + '. El saldo se habilita cuando el personal confirme tu llegada; ya dejé el aviso en el panel.';
    return '🧾 Registré tu solicitud de pago en línea para ' + current.ref
      + '. El personal la verá en el panel y te enviará el enlace por WhatsApp cuando lo prepare.';
  }

  async function incoming(message) {
    const phone = digits(message.from);
    if (!message.id || config.isPhoneBlocked(phone) || !config.isPhoneAllowed(phone)) return;
    const timestamp = Number(message.timestamp) * 1000;
    if (!Number.isFinite(timestamp) || timestamp < Date.now() - 24 * 3600000 || timestamp > Date.now() + 60000) return;
    if (seenMessages.has(message.id)) return;
    if (message.type === 'reaction') return;
    seenMessages.add(message.id);
    if (seenMessages.size > 5000) seenMessages.delete(seenMessages.values().next().value);

    const attachment = ['image', 'audio', 'document'].includes(message.type) ? message[message.type] : null;
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    const action = parseAction(reply?.id);
    let text = String(message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title
      || message.button?.text || attachment?.caption || '').slice(0, 1000);
    const unsupportedType = ['sticker', 'location', 'contacts', 'contact'].includes(message.type);
    if (!text && !attachment && !unsupportedType) return;
    // Los saludos antiguos no deben producir menús atrasados tras una caída o una cola acumulada.
    if (isGreeting(text) && Date.now() - timestamp > 90_000) {
      console.info('WhatsApp: se omitió un saludo atrasado; ageSeconds=' + Math.round((Date.now() - timestamp) / 1000));
      return;
    }

    // Baja y alta se evalúan antes de clasificar la intención.
    let command = commandText(text);
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
    if (unsupportedType) {
      const previous = unsupportedTypeRepliedAt.get(phone) || 0;
      if (timestamp - previous >= 3600000) {
        unsupportedTypeRepliedAt.set(phone, timestamp);
        await service.sendWhatsAppReply(phone, 'Solo puedo leer mensajes de texto e imágenes de comprobantes.');
      }
      return;
    }

    // Alta por mensaje estructurado: solo cuando el modo lo permite y la palabra RESERVA abre el texto.
    if (config.canReserve(phone) && !attachment) {
      const rule = await settings();
      const reservation = parseReservation(text, new Date(), rule.minReservationNoticeMinutes);
      if (reservation) {
        await registerReservation(phone, text, reservation, timestamp, message.id);
        return;
      }
    }

    // Responder a quien escribe no exige consentimiento; solo los mensajes que
    // inicia el restaurante exigen order.consent y un número no dado de baja.
    const orders = await store.phone(phone);
    // Transcribe antes de elegir reserva o clasificar la intención: una nota de voz
    // debe seguir el mismo flujo determinista que el texto equivalente.
    let proof, mediaError;
    if (attachment && ['image', 'audio'].includes(message.type)) {
      try {
        if (message.type === 'document') throw new Problem('Documento recibido para revisión del personal.');
        const result = await ai.readMedia(message.type, attachment.id);
        if (result.text) text = result.text;
        proof = result.proof;
        if (proof) proof.messageId = message.id;
      } catch (error) { mediaError = error.message; }
    }
    if (message.type === 'audio' && !String(text || '').trim() && !mediaError) {
      mediaError = 'No se obtuvo una transcripción utilizable.';
    }
    if (message.type === 'audio' && mediaError) {
      const context = recentConversationOrder(orders, timestamp);
      const response = /alcanzó un límite de uso/i.test(mediaError)
        ? 'Por ahora no puedo procesar notas de voz. Escríbeme tu mensaje por texto o vuelve a intentarlo más tarde.'
        : /no está disponible temporalmente/i.test(mediaError)
          ? 'El servicio para procesar notas de voz no está disponible por el momento. Escríbeme tu mensaje por texto o vuelve a intentarlo más tarde.'
          : 'No pude entender la nota de voz. Escríbeme el mensaje o envía otra nota de voz, por favor.';
      if (context) await sendReply(context, response);
      else await service.sendWhatsAppReply(phone, response);
      return;
    }
    command = commandText(text);
    const customerPaymentRequest = new Set(['pagar', 'cuenta', 'pagar comida', 'pagar saldo', 'quiero pagar',
      'quiero pagar en linea', 'quiero pagar online', 'pagar en linea', 'pagar online', 'quiero el link de pago',
      'quiero el enlace de pago']).has(command)
      || /\b(?:quiero|quisiera|deseo|necesito|puedo)\b.{0,24}\b(?:pagar|pago)\b/.test(command)
      || /\b(?:pagar|pago)\b.{0,28}\b(?:en linea|online|por internet|saldo|anticipo)\b/.test(command);
    const balanceDetailsRequest = /^(?:(?:mi )?saldo(?: pendiente)?|saldo\s+EST-[a-f0-9]{8})$/i.test(String(text).trim())
      || /\b(?:cuanto|que monto|cual es).{0,30}\b(?:debo|falta|saldo|pagar|pago)\b/.test(command)
      || /\b(?:cuanto|que monto).{0,24}\b(?:queda|resta|pendiente)\b/.test(command);
    const ref = text.match(/\bEST-[a-f0-9]{8}\b/i)?.[0]?.toUpperCase();
    const explicitBookingPhrase = /\b(reservar|reserva nueva|nueva reserva|hacer (?:una |otra )?reserva|crear (?:una |otra )?reserva|tomar (?:una |otra )?reserva|agendar (?:una |otra )?reserva)\b/.test(command);
    const isNewBookingRequest = explicitBookingPhrase || /^\s*RESERVA(?:\s|$)/i.test(text) || action?.action === 'book'
      || (reservationRequest(text) && !availabilityInquiry(text));
    const conversationOrder = !action && !isNewBookingRequest && !reservationListRequest(text) && !isGreeting(text)
      ? orders.find(item => item.ref === ref) || recentConversationOrder(orders, timestamp) : null;
    if (availabilityInquiry(text) && !isNewBookingRequest) {
      const answer = await availabilityAnswer(text, timestamp);
      if (conversationOrder) await sendReply(conversationOrder, answer);
      else await service.sendWhatsAppReply(phone, answer);
      return;
    }
    // Una nueva reserva no debe confundirse con una de las reservas existentes ni
    // registrar su audio/texto dentro de un pedido anterior.
    if (isNewBookingRequest) return replyWithoutReservation(phone, text, action);
    const wantsOrders = action?.action === 'orders' || reservationListRequest(text);
    // La consulta de reservas prevalece sobre el detector genérico del portal.
    // Se muestra siempre la lista dentro de WhatsApp, incluso si solo hay una reserva.
    if (wantsOrders) {
      if (!orders.length) return replyWithoutReservation(phone, text, action);
      const recipient = reservationFocus(orders) || orders[0];
      await update(recipient.id, data => {
        if (!data.chat.some(item => item.id === message.id)) data.chat.push({ id: message.id, from: phone,
          direction: 'in', at: new Date(timestamp).toISOString(), text });
      });
      await sendReply((await store.get(recipient.id))?.data || recipient, reservationList(orders));
      return;
    }
    if (portal && !wantsOrders && (action?.action === 'rcp' || wantsPortal(text) || /^(?:comprobante|constancia|portal|carta)$/.test(command))) {
      return service.sendWhatsAppReply(phone, portalText);
    }
    const ownsRef = !ref || orders.some(order => order.ref === ref);
    if (!orders.length || !ownsRef) {
      await replyWithoutReservation(phone, text, action);
      return;
    }

    const staffFocus = action?.action === 'staff' ? (reservationFocus(orders) || orders[0]) : null;
    const actionFocus = action?.ref ? orders.find(order => order.ref === action.ref) : null;
    const active = orders.filter(order => !terminal(order));
    const candidates = actionFocus ? [actionFocus] : staffFocus ? [staffFocus] : conversationOrder ? [conversationOrder]
      : ref ? orders.filter(order => order.ref === ref) : (active.length ? active : orders);
    if (!candidates.length) {
      await replyWithoutReservation(phone, text, action);
      return;
    }

    if ((!attachment || message.type === 'audio') && (action?.action === 'sela' || isArrivalReport(text))) {
      return reportArrival(phone, orders, action?.ref || ref, timestamp, message.id, text, conversationOrder);
    }
    if (!attachment && portal && wantsPortal(text)) return service.sendWhatsAppReply(phone, portalText);
    const promise = portal && !attachment && !proof && !action ? paymentPromise(text, new Date(timestamp)) : null;
    if (promise) {
      const unpaid = candidates.filter(item => item.stage === 'awaiting_deposit' && depositDue(item) > 0);
      if (unpaid.length > 1) return service.sendWhatsAppReply(phone, 'Indica la referencia de la reserva y repite la hora en el mismo mensaje.');
      if (!unpaid.length) return service.sendWhatsAppReply(phone, 'No encontré un anticipo pendiente para esa reserva.');
      if (promise.ambiguous) return service.sendWhatsAppReply(phone, 'Dime el día y la hora con a. m. o p. m. Por ejemplo: hoy a las 7 p. m.');
      const selected = unpaid[0];
      const { result } = await update(selected.id, data => {
        if (data.stage !== 'awaiting_deposit' || depositDue(data) <= 0
          || +new Date(promise.at) <= Date.now() || +new Date(promise.at) >= +new Date(data.deadline)) return false;
        if (data.depositPromise?.messageId === message.id) return true;
        data.chat.push({ id: message.id, from: phone, direction: 'in', at: new Date(timestamp).toISOString(), text });
        data.depositPromise = { ...promise, messageId: message.id };
        addEvent(data, 'Hora de anticipo acordada', friendlyDate(promise.at, new Date(), true), 'Pagador');
        return true;
      });
      return service.sendWhatsAppReply(phone, result
        ? 'Te recordaré el anticipo ' + friendlyDate(promise.at, new Date(), true) + '. El plazo de pago sigue siendo ' + friendlyDate(selected.deadline, new Date(), true) + '.'
        : 'La hora debe ser futura y anterior al vencimiento del anticipo. Dime otra hora.');
    }

    const { order, result: isNew } = await update(candidates[0].id, data => {
      if (data.chat.some(m => m.id === message.id)) return false;
      data.chat.push({ id: message.id, direction: 'in', at: new Date(timestamp).toISOString(),
        text: text || (attachment ? 'Adjunto de ' + ({ image: 'imagen', audio: 'audio', document: 'documento' }[message.type]) : ''),
        ...(attachment ? { mediaType: message.type, mediaId: String(attachment.id || '') } : {}) });
      return true;
    });
    if (!isNew) return;

    // Los adjuntos solo abren una revisión. El texto extraído de una imagen no ejecuta acciones.
    if (attachment && ['image', 'document'].includes(message.type)) {
      const reviewDetails = proof ? [
        'Datos visibles extraídos para revisión manual.',
        'Importe: ' + (proof.amount || 'ilegible'),
        'Operación: ' + (proof.operation || 'ilegible'),
        'Medio: ' + (proof.provider || 'sin identificar'),
      ].join(' · ') : 'El adjunto requiere revisión del personal.';
      await update(order.id, data => openIssue(data, 'Adjunto por revisar', mediaError || reviewDetails, message.id));
      await sendReply(order, 'Recibí el adjunto para ' + order.ref + '. El personal lo revisará; las imágenes no actualizan pagos ni reservas.');
      return;
    }

    // El botón sin referencia solo existe para derivar al personal.
    if (action?.action === 'staff') {
      await update(order.id, data => openIssue(data, 'Ayuda del personal', text.slice(0, 500) || message.id));
      await sendReply(order, requestMessage(order, 'human'));
      return;
    }

    const bookingRequest = action?.action === 'book' || reservationRequest(text) || /^\s*RESERVA(?:\s|$)/i.test(text);
    if (bookingRequest) {
      if (config.canReserve(phone)) await sendReply(order, reservationInstructionsMessage({ availabilityQuestion: availabilityInquiry(text) }));
      else {
        await update(order.id, data => openIssue(data, 'Ayuda del personal', text.slice(0, 500) || message.id));
        await sendReply(order, texts.reservationUnavailable);
      }
      return;
    }
    if (action?.action === 'menu' || isGreeting(text)
      || new Set(['ayuda', 'menu', 'menu principal', 'inicio']).has(command)) {
      // Un saludo abre el menú principal; la lista se muestra solo cuando el cliente la solicita.
      await sendReply(reservationFocus(orders) || order, customerMainMenu());
      return;
    }
    if (order.stage === 'cancelled' && !['rcp', 'hum'].includes(action?.action)) {
      await sendReply(order, reservationMenu(order));
      return;
    }
    if (order.stage === 'no_show' && action?.action !== 'rcp') {
      await update(order.id, data => openIssue(data, 'Revisión de inasistencia solicitada por cliente', text.slice(0, 500) || 'Consulta del cliente.', 'no-show-customer:' + order.ref));
      await sendReply(order, reservationMenu(order));
      return;
    }

    const target = action?.ref ? orders.find(order => order.ref === action.ref) : null;
    const textTarget = ref ? orders.find(order => order.ref === ref) : null;
    let recipient = target || order;
    try {
      let response;
      const exactChange = new Set(['reprogramar', 'cambiar fecha']).has(command);
      const inChangeFlow = ['chg', 'selc', 'rsd', 'rsm', 'rsh', 'rst', 'rsc', 'rsx'].includes(action?.action);
      if ((action?.action === 'chg' || (!action && exactChange)) && active.length > 1 && !target) {
        response = reservationList(active, new Date(), 'selc');
        recipient = reservationFocus(orders) || order;
      } else if (inChangeFlow || (!action && exactChange)) {
        const selected = target || reservationFocus(orders) || order;
        recipient = selected;
        const result = await rescheduleReply(selected, action || { action: 'chg' }, phone);
        response = result.next?.response || result.response;
      } else if (target && action?.action === 'ren') {
        try { await renewDepositForCustomer(target.id, phone); return; }
        catch (error) {
          await update(target.id, data => openIssue(data, 'Solicitud de renovación de anticipo', error.message, 'renewal:' + target.id));
          response = 'No pude renovar el plazo: ' + error.message + ' Ya avisé al personal.';
        }
      } else if (target && action?.action === 'can') {
        try { response = await cancelCustomerReservation(target.id, phone, false); }
        catch (error) { response = 'No pude continuar: ' + error.message; }
      } else if (target && action?.action === 'cnf') {
        try { response = await cancelCustomerReservation(target.id, phone, true); }
        catch (error) { response = 'No pude cancelar la reserva: ' + error.message; }
      } else if (target && action?.action === 'cx') {
        response = reservationMenu((await store.get(target.id))?.data || target);
      } else if (!action && balanceDetailsRequest) {
        const selected = textTarget || conversationOrder || (active.length === 1 ? active[0] : null);
        if (!selected && active.length > 1) {
          response = reservationList(active, new Date(), 'selb');
          recipient = reservationFocus(orders) || order;
        } else if (!selected) response = 'No encontré una reserva para consultar. Escribe «ver mis reservas» para elegir una.';
        else {
          recipient = selected;
          const latest = (await store.get(selected.id))?.data;
          response = latest?.phone === phone ? await replyTo(latest, text, undefined, 'balance')
            : 'No pude validar esta reserva desde tu número. Escribe «ver mis reservas» para actualizar la lista.';
        }
      } else if (action?.action === 'payb' || action?.action === 'selb' || (!action && customerPaymentRequest)) {
        const selected = target || textTarget || conversationOrder || (active.length === 1 ? active[0] : null);
        if (!selected && active.length > 1) {
          response = reservationList(active, new Date(), 'selb');
          recipient = reservationFocus(orders) || order;
        } else if (!selected) response = 'No encontré una reserva para asociar a tu solicitud. Escribe «ver mis reservas» para elegir una.';
        else {
          recipient = selected;
          const latest = (await store.get(selected.id))?.data;
          if (!latest || latest.phone !== phone) response = 'No pude validar esta reserva desde tu número. Escribe «ver mis reservas» para actualizar la lista.';
          else if (!action && latest.stage === 'awaiting_deposit' && depositDue(latest) > 0) {
            // El flujo normal conserva el enlace automático del anticipo pendiente.
            response = await replyTo(latest, 'anticipo', undefined, { intent: 'link', method: 'checkout' });
          } else response = await requestOnlinePayment(latest.id, phone, text);
        }
      } else if (action && (action.action === 'menu' || (action.ref && !target))) {
        response = reservationPrompt(orders);
        recipient = reservationFocus(orders) || order;
      } else if (action?.action === 'selc') {
        response = target ? (await rescheduleReply(target, { action: 'selc' }, phone)).response : reservationPrompt(orders);
        recipient = target || reservationFocus(orders) || order;
      } else if (action?.action === 'sel') {
        response = target ? reservationMenu(target) : reservationPrompt(orders);
        recipient = target || reservationFocus(orders) || order;
      } else if (target) {
        const latest = (await store.get(target.id))?.data;
        if (!latest || latest.phone !== phone) response = 'No pude validar esta reserva desde tu número. Escribe «ver mis reservas» para actualizar la lista.';
        else response = await actionReply(latest, action.action);
      }
      else if (!ref && !conversationOrder && orders.length > 1) {
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
  function reminderStillRelevant(order, plan, rule, now, claimedAttempt = null) {
    if (!order || order.stage !== plan.snapshot.stage || order.stage !== plan.order.stage
      || order.visitAt !== plan.snapshot.visitAt || order.deadline !== plan.snapshot.deadline
      || (order.attendance?.at || null) !== plan.snapshot.attendanceAt
      || (order.attendance?.reportedAt || null) !== plan.snapshot.attendanceReportedAt
      || depositDue(order) !== plan.snapshot.depositDue || balance(order) !== plan.snapshot.balance
      || !contactTime(rule, new Date(now))) return false;
    if (claimedAttempt !== null) {
      const claim = order.reminders?.[plan.key];
      if (claim?.status !== 'pending' || claim.attempts !== claimedAttempt) return false;
    }
    const before = +new Date(order.visitAt) - now;
    if (plan.reason === 'visit') {
      const key = 'visit:' + order.visitAt + ':' + (before <= rule.lastVisitHours * 3600000 ? 'last' : 'first');
      return rule.visitReminder && order.stage === 'confirmed' && !order.attendance?.at && !order.attendance?.reportedAt
        && before > 0 && before <= rule.firstVisitHours * 3600000 && balance(order) > 0 && key === plan.key;
    }
    if (order.stage !== 'awaiting_deposit' || depositDue(order) <= 0 || +new Date(order.deadline) <= now) return false;
    const promise = portal && order.depositPromise;
    if (plan.reason === 'promise') return Boolean(promise && promise.messageId === plan.snapshot.promiseMessageId
      && +new Date(promise.at) <= now && +new Date(promise.muteUntil) > now && plan.key === 'promise:' + promise.messageId);
    if (portal && +new Date(order.depositPromise?.muteUntil) > now) return false;
    if (plan.reason === 'initial') {
      const latestLink = [...order.chat].reverse().find(message => message.direction === 'out'
        && (message.paymentLink || message.text?.includes('/pago/')));
      return rule.initialRequest && !latestLink && plan.key === 'initial:' + order.deadline;
    }
    if (plan.reason === 'deposit') {
      const latestLink = [...order.chat].reverse().find(message => message.direction === 'out'
        && (message.paymentLink || message.text?.includes('/pago/')));
      const initialKey = 'initial:' + order.deadline;
      const lastRequest = latestLink?.at || order.reminders?.[initialKey]?.at || order.createdAt;
      return rule.depositReminder && now - +new Date(lastRequest) >= rule.depositReminderMinutes * 60000
        && plan.key === 'deposit:' + order.deadline;
    }
    return false;
  }
  async function skipStaleReminder(plan) {
    await update(plan.order.id, data => {
      const current = data.reminders?.[plan.key];
      if (current?.status === 'pending' && current.attempts === plan.attempt) {
        current.status = 'skipped'; current.at = instant();
      }
    });
  }
  async function skipStaleClaims(plans) {
    for (const plan of plans) await skipStaleReminder(plan);
  }
  async function processAlerts() {
    const rule = await settings();
    const now = Date.now();
    const orders = await store.list();
    let sent = 0, escalated = 0, attempted = 0, retriedThisCycle = false, personalizedReminderUsed = false;
    for (const order of orders) {
      if (terminal(order)) continue;
      const cancelHours = Number(rule.autoCancelExpiredHours ?? 24);
      if (cancelHours > 0 && order.stage === 'awaiting_deposit' && (order.payments || []).length === 0
        && now >= +new Date(order.deadline) + cancelHours * 3600000) {
        const { result: cancelled } = await update(order.id, data => {
          if (data.stage !== 'awaiting_deposit' || (data.payments || []).length !== 0
            || now < +new Date(data.deadline) + cancelHours * 3600000) return false;
          data.stage = 'cancelled';
          addEvent(data, 'Cancelada por falta de anticipo', 'El plazo venció hace al menos ' + cancelHours + ' horas y no había pagos registrados.');
          return true;
        });
        if (cancelled) {
          escalated++;
          const fresh = (await store.get(order.id))?.data;
          try {
            if (fresh?.phone && config.waMode === 'cloud' && config.isPhoneAllowed(fresh.phone)
              && !config.isPhoneBlocked(fresh.phone) && !(await optedOut(fresh.phone)) && await sessionOpen(fresh.phone)) {
              await send(fresh, 'La reserva ' + fresh.ref + ' se canceló porque venció el plazo del anticipo sin pagos.', { reply: true });
            }
          } catch { /* El evento deja constancia; si la ventana no admite respuesta, no se escala ni se usa plantilla. */ }
          continue;
        }
      }
      const before = +new Date(order.visitAt) - now;
      const issue = order.stage === 'awaiting_deposit' && now >= +new Date(order.deadline) ? ['Anticipo vencido', 'Revisa el pago y el cupo antes de renovar.', 'deadline:' + order.deadline]
        : order.stage === 'confirmed' && !order.attendance?.reportedAt && before <= -rule.graceMinutes * 60000 ? ['Verificar llegada', 'Pasó la tolerancia sin aviso de llegada. Recepción debe verificar si asistió antes de registrar una inasistencia.', 'arrival:' + order.visitAt]
          : order.stage === 'arrived' && balance(order) > 0 && now - +new Date(order.attendance.at) >= rule.counterAlertMinutes * 60000
            ? ['Saldo por verificar', 'El cliente ya llegó y caja aún no confirmó el saldo.', 'counter:' + order.attendance.at] : null;
      if (rule.internalAlerts && issue && !order.incidents.some(i => i.key === issue[2])) {
        const { result: created } = await update(order.id, data => {
          if (data.stage === order.stage && data.deadline === order.deadline && data.visitAt === order.visitAt
            && (!String(issue[2]).startsWith('arrival:') || !data.attendance?.reportedAt)
            && !data.incidents.some(i => i.key === issue[2])) {
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

    if (config.waMode !== 'cloud' || !rule.reminders) return { sent, escalated };
    const withinHours = contactTime(rule, new Date(now));

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
      const promisedDay = portal && group.some(order => order.stage === 'awaiting_deposit'
        && depositDue(order) > 0 && +new Date(order.deadline) > now && +new Date(order.depositPromise?.muteUntil) > now);
      for (const order of group) {
        if (!order.consent) continue;
        const before = +new Date(order.visitAt) - now;
        const needsDeposit = order.stage === 'awaiting_deposit' && depositDue(order) > 0 && now < +new Date(order.deadline);
        const initialKey = 'initial:' + order.deadline;
        const latestLink = [...order.chat].reverse().find(m => m.direction === 'out' && (m.paymentLink || m.text.includes('/pago/')));
        const promise = portal && order.depositPromise;
        const promised = needsDeposit && promise && +new Date(promise.at) <= now && +new Date(promise.muteUntil) > now;
        const muted = promisedDay;
        const initial = withinHours && !muted && rule.initialRequest && needsDeposit && !latestLink;
        const sinceRequest = now - +new Date(latestLink?.at || order.reminders[initialKey]?.at || order.createdAt);
        const deposit = withinHours && !muted && rule.depositReminder && needsDeposit && sinceRequest >= rule.depositReminderMinutes * 60000;
        const visit = withinHours && rule.visitReminder && !order.attendance?.reportedAt && order.stage === 'confirmed' && before > 0 && before <= rule.firstVisitHours * 3600000;
        const reason = promised ? 'promise' : initial ? 'initial' : deposit ? 'deposit' : visit ? 'visit' : null;
        const key = promised ? 'promise:' + promise.messageId : initial ? initialKey : deposit ? 'deposit:' + order.deadline
          : visit ? 'visit:' + order.visitAt + ':' + (before <= rule.lastVisitHours * 3600000 ? 'last' : 'first') : null;
        const previous = key && order.reminders[key];
        const retryable = previous?.status === 'failed' && (previous.attempts || 1) < 3
          && now - +new Date(previous.at) >= 15 * 60000;
        if (key && (!previous || retryable)) plans.push({ order, key, reason,
          kind: promised || initial || deposit ? 'deposit' : 'visit', promised, retry: Boolean(previous),
          snapshot: { stage: order.stage, visitAt: order.visitAt, deadline: order.deadline,
            attendanceAt: order.attendance?.at || null, attendanceReportedAt: order.attendance?.reportedAt || null,
            depositDue: depositDue(order), balance: balance(order), promiseMessageId: promise?.messageId || null,
            previousAt: previous?.at || null, previousAttempts: previous?.attempts || (previous ? 1 : 0) } });
      }
      if (!plans.length) continue;

      const deposits = plans.filter(plan => plan.kind === 'deposit')
        .sort((a, b) => +new Date(a.order.deadline) - +new Date(b.order.deadline));
      const visits = plans.filter(plan => plan.kind === 'visit')
        .sort((a, b) => +new Date(a.order.visitAt) - +new Date(b.order.visitAt));
      const paymentAlert = deposits.length > 0;
      const priority = deposits.find(plan => plan.promised);
      const chosenPlans = priority ? [priority] : paymentAlert ? deposits : visits;
      const claimed = [];
      for (const plan of chosenPlans) {
        if (plan.retry && retriedThisCycle) continue;
        const { result: didClaim } = await update(plan.order.id, data => {
          const previous = data.reminders[plan.key];
          const retryable = previous?.status === 'failed' && (previous.attempts || 1) < 3
            && now - +new Date(previous.at) >= 15 * 60000;
          if (plan.retry
            ? !retryable || previous.at !== plan.snapshot.previousAt
              || (previous.attempts || 1) !== plan.snapshot.previousAttempts
            : Boolean(previous)) return false;
          if (!reminderStillRelevant(data, plan, rule, Date.now())) return false;
          plan.attempt = (previous?.attempts || (previous ? 1 : 0)) + 1;
          data.reminders[plan.key] = { at: instant(), status: 'pending', attempts: plan.attempt };
          return true;
        });
        if (didClaim) {
          claimed.push(plan);
          if (plan.retry) retriedThisCycle = true;
        }
      }
      if (!claimed.length) continue;
      attempted++;
      let messagePlan = claimed[0];
      try {
        const activeSession = await sessionOpen(phone);
        let current = (await store.get(messagePlan.order.id))?.data;
        if (!reminderStillRelevant(current, messagePlan, rule, Date.now(), messagePlan.attempt)) {
          await skipStaleClaims(claimed);
          continue;
        }
        const pendingPayments = group.filter(order => order.consent && order.stage === 'awaiting_deposit'
          && depositDue(order) > 0 && now < +new Date(order.deadline));

        if (paymentAlert && !messagePlan.promised && activeSession && pendingPayments.length > 1
          && claimed.length === chosenPlans.length) {
          const freshOrders = await store.phone(phone);
          const currentPayments = freshOrders.filter(order => order.consent && order.stage === 'awaiting_deposit'
            && depositDue(order) > 0 && now < +new Date(order.deadline));
          current = (await store.get(messagePlan.order.id))?.data;
          if (!reminderStillRelevant(current, messagePlan, rule, Date.now(), messagePlan.attempt)) {
            await skipStaleClaims(claimed);
            continue;
          }
          await send(current, reservationList(currentPayments, new Date(now)));
          for (const plan of claimed) await update(plan.order.id, data => {
            if (data.reminders[plan.key]?.status === 'pending' && data.reminders[plan.key].attempts === plan.attempt) data.reminders[plan.key].status = 'sent';
          });
          for (const plan of visits) await update(plan.order.id, data => {
            if (!data.reminders[plan.key]) data.reminders[plan.key] = { at: instant(), status: 'skipped' };
          });
          sent++;
          continue;
        }

        if (paymentAlert) {
          let intent;
          try { intent = await checkout(current.id); }
          catch (error) {
            if (!messagePlan.promised || !activeSession || error.status !== 409) throw error;
            current = (await store.get(current.id))?.data;
            if (!reminderStillRelevant(current, messagePlan, rule, Date.now(), messagePlan.attempt)) {
              await skipStaleClaims(claimed);
              continue;
            }
            await send(current, 'Es la hora acordada para revisar el anticipo de ' + current.ref + '. Si necesitas otro enlace, comunícate con caja.');
          }
          if (intent) {
            current = (await store.get(current.id))?.data;
            if (!reminderStillRelevant(current, messagePlan, rule, Date.now(), messagePlan.attempt)) {
              await skipStaleClaims(claimed);
              continue;
            }
            const message = paymentCta(current, intent, linkFor(intent));
            const unresolvedDifficulty = current.incidents?.some(item => !item.resolvedAt && item.type === 'Dificultad de pago');
            if (activeSession && unresolvedDifficulty && !personalizedReminderUsed) {
              personalizedReminderUsed = true;
              const personalLine = await ai.personalizePaymentReminder();
              if (personalLine) {
                message.body = personalLine + '\n' + message.body;
                message.fallback = personalLine + '\n' + message.fallback;
              }
            }
            await send(current, message, { template: 'deposit', intent });
          }
        } else {
          current = (await store.get(current.id))?.data;
          if (!reminderStillRelevant(current, messagePlan, rule, Date.now(), messagePlan.attempt)) {
            await skipStaleClaims(claimed);
            continue;
          }
          const visit = emojis.visit + ' *Próxima visita*\nReserva: *' + current.ref + '*\n'
            + friendlyDate(current.visitAt, new Date(now), true) + '\nSaldo en el local: *' + money(balance(current)) + '*';
          await send(current, visit, { template: 'visit' });
        }

        for (const plan of claimed) await update(plan.order.id, data => {
          if (data.reminders[plan.key]?.status === 'pending' && data.reminders[plan.key].attempts === plan.attempt) {
            data.reminders[plan.key].status = plan === messagePlan ? 'sent' : 'skipped';
          }
        });
        const secondary = paymentAlert ? visits : chosenPlans.slice(1);
        for (const plan of secondary) await update(plan.order.id, data => {
          if (!data.reminders[plan.key]) data.reminders[plan.key] = { at: instant(), status: 'skipped' };
        });
        sent++;
      } catch (error) {
        for (const plan of claimed) await update(plan.order.id, data => {
          if (data.reminders[plan.key]?.status === 'pending') {
            data.reminders[plan.key].status = plan === messagePlan ? 'failed' : 'skipped';
            data.reminders[plan.key].at = instant();
          }
        });
        if (messagePlan.attempt >= 3) await update(messagePlan.order.id, data => openIssue(data,
          'Recordatorio pendiente', 'No se pudo entregar tras 3 intentos. Último motivo: ' + error.message, 'reminder:' + messagePlan.key));
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
      if (isPost && path.endsWith('/alerts')) {
        if (portal) await reconcilePendingPayments();
        return json(res, 200, await reminderTick());
      }
      return json(res, 404, { error: 'Ruta no encontrada.' });
    }
    if (path === '/api/session' && isGet) {
      if (!portal) return json(res, 200, { authenticated: authenticated(req), protected: Boolean(config.adminPassword), role: authenticated(req) ? 'admin' : null });
      const identity = await portal.session(req);
      return json(res, 200, { authenticated: Boolean(identity), protected: true, portalEnabled: true, role: identity?.role, name: identity?.name });
    }
    if (portal && path.startsWith('/api/customer/')) {
      if (isPost && path === '/api/customer/otp') return json(res, 202, await portal.issue(req, parse(await readBody(req))));
      if (isPost && path === '/api/customer/verify') return json(res, 200, await portal.verify(req, res, parse(await readBody(req))));
      const customer = await portal.session(req);
      requireThat(customer?.role === 'client', 'Verifica tu celular para entrar.', 401);
      if (isGet && path === '/api/customer/orders') return json(res, 200, { name: customer.name, menuUrl: config.menuUrl,
        orders: await portal.customerOrders(customer) });
      return json(res, 404, { error: 'Ruta no encontrada.' });
    }
    if (path === '/api/login' && isPost) {
      if (portal) return json(res, 200, await portal.login(req, res, parse(await readBody(req))));
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
      if (portal) portal.logout(res);
      else res.setHeader('Set-Cookie', cookie('', 0));
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
        if (queue.length) wakeN8n();
        // PAYERS y el workflow pueden reclamar la misma cola a la vez; store.claim es atómico.
        // El drenado directo mantiene la respuesta aun cuando n8n esté apagado.
        if (queue.length && !options.memory) void drainInbox().then(result => {
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
      const methodEnabled = method === 'checkout';
      if (isGet) {
        const expected = purpose === 'deposit' ? depositDue(target) : balance(target);
        const rightStage = purpose === 'deposit' ? target.stage === 'awaiting_deposit' && new Date(target.deadline) > new Date()
          : target.stage === 'arrived' && balance(target) > 0;
        const usable = methodEnabled && rightStage && intent.amount === expected
          && new Date(intent.expiresAt) > new Date() && intent.status === 'pending';
        const safeCheckout = intent.mode !== 'mercado_pago' || isMercadoPagoInitPoint(intent.checkoutUrl);
        const requiresReview = target.payments.some(payment => payment.intentId === intent.id && payment.review);
        const unusableReason = purpose === 'balance' && (balance(target) === 0 || ['paid', 'closed'].includes(target.stage))
          ? 'already_paid' : purpose === 'deposit' && (depositDue(target) === 0 || ['confirmed', 'arrived', 'paid', 'closed'].includes(target.stage))
            ? 'already_paid' : ['superseded', 'expired'].includes(intent.status) || +new Date(intent.expiresAt) <= Date.now()
              ? 'expired' : !rightStage ? 'reservation_changed' : null;
        return json(res, 200, { ref: target.ref, amount: intent.amount, status: intent.status, mode: intent.mode, purpose,
          stage: target.stage, requiresReview, unusableReason,
        method, usable: usable && safeCheckout, checkoutUrl: usable && safeCheckout ? intent.checkoutUrl : null });
      }
      if (isPost) {
        const input = parse(await readBody(req));
        if (portal && input.method !== undefined) requireThat(input.method === 'checkout', 'Solo está disponible el pago en línea con Mercado Pago.', 409);
        const selected = method;
        requireThat(methodEnabled && intent.mode === 'local' && config.paymentMode === 'local',
          'Este pago se confirma desde Mercado Pago.', 409);
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
            row.updatedAt = instant();
            openIssue(data, 'Intento rechazado', 'El checkout local simuló un rechazo.', row.id);
          } else {
            requireThat(input.outcome === 'approved', 'Resultado de prueba inválido.');
            row.status = 'approved';
            const payment = { ref: 'SIM-' + row.id, amount: row.amount, purpose, channel: selected === 'checkout' ? 'simulation' : selected + '_demo', intentId: row.id };
            if (purpose === 'deposit') finishDeposit(data, payment, token); else finishBalance(data, payment, token);
          }
          return { status: row.status, confirmed: row.status === 'approved' && data.stage === 'confirmed' };
        });
        if (result.confirmed) await notifyConfirmation(order);
        else if (purpose === 'balance' && result.status === 'approved') await deliverPendingReceipts(order);
        else if (result.status === 'rejected') {
          const rejectedIntent = order.intents.find(item => item.id === intent.id);
          if (rejectedIntent) await notifyRejectedPayment(order, rejectedIntent);
        }
        return json(res, 200, { status: result.status });
      }
    }
    const publicReceipt = path.match(/^\/api\/receipt\/([a-f0-9-]+)$/);
    if (publicReceipt && isGet && uuid.test(publicReceipt[1])) {
      const order = await store.find('receipts', { token: publicReceipt[1] });
      // El token aleatorio de la constancia es el acceso directo compartido por WhatsApp.
      requireThat(order, 'Comprobante no encontrado.', 404);
      const receipt = order.receipts.find(r => r.token === publicReceipt[1]);
      const payment = order.payments.filter(item => item.channel === 'mercadopago' && (item.purpose || 'deposit') === receipt.purpose
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
        : order.payments.filter(item => item.ref === receipt.paymentRef || (receipt.intentId && item.intentId === receipt.intentId)
          || (receipt.purpose === 'deposit' && (item.purpose || 'deposit') === 'deposit' && item.amount === receipt.amount));
      const mercadoPagoReceipts = receiptPayments
        .filter(item => !order.payments.some(adjustment => adjustment.original === item.ref && adjustment.amount < 0))
        .map(item => ({ paymentId: item.ref.slice(3), intentId: item.intentId || null, purpose: item.purpose || 'deposit', amount: item.amount,
          url: paymentReceiptUrl(item) })).filter(item => item.url);
      return json(res, 200, { ...receipt, ref: order.ref, payer: order.payer, total: order.total,
        payments: receipt.paymentBreakdown || receiptPayments.map(item => ({ purpose: item.purpose || 'deposit', amount: item.amount,
          at: item.at, channel: item.channel, ref: item.ref })), mercadoPagoReceipts,
        ...(operationId ? { mercadoPagoOperationId: operationId, mercadoPagoReceiptUrl } : {}) });
    }
    const staff = portal ? await portal.session(req) : authenticated(req) ? { role: 'admin' } : null;
    requireThat(staff, 'Inicia sesión para acceder al panel.', 401);
    requireThat(staff.role !== 'client', 'Esta operación pertenece al panel de personal.', 403);
    if (staff.role === 'cashier') {
      const allowed = path.startsWith('/api/orders') || (isGet && ['/api/config', '/api/availability'].includes(path));
      requireThat(allowed && !path.endsWith('/refund'), 'Esta operación requiere acceso de administrador.', 403);
    }
    if (portal && path === '/api/staff') {
      if (isGet) return json(res, 200, await portal.call('staff_list'));
      if (isPost) return json(res, 200, await portal.saveStaff(parse(await readBody(req)), staff));
    }
    if (isGet && path === '/api/reports/pdf') {
      const measure = url.searchParams.get('measure');
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day || '') && Number.isFinite(Date.parse(day))
        && new Date(day).toISOString().slice(0, 10) === day;
      requireThat(Object.hasOwn(reportKinds, measure) && validDay(from) && validDay(to) && from <= to
        && (Date.parse(to) - Date.parse(from)) / 86400000 <= 92, 'Selecciona una medida y un período válido de hasta 93 días.');
      const pdf = reportPdf(measure, from, to, await store.report(measure, from, to));
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length,
        'Content-Disposition': 'attachment; filename="PAYERS-' + measure + '-' + from + '.pdf"', 'Cache-Control': 'private, no-store' });
      return res.end(pdf);
    }
    if (isPost && path === '/api/reports/insights') {
      requireThat(staff.role === 'admin', 'Las recomendaciones de reportes requieren acceso de administrador.', 403);
      const input = parse(await readBody(req));
      const from = String(input.from || ''), to = String(input.to || '');
      const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day))
        && new Date(day).toISOString().slice(0, 10) === day;
      requireThat(validDay(from) && validDay(to) && from <= to
        && (Date.parse(to) - Date.parse(from)) / 86400000 <= 92, 'Selecciona un período válido de hasta 93 días.');
      const inRange = value => value && limaDateKey(value) >= from && limaDateKey(value) <= to;
      const orders = await store.list();
      const metrics = {
        period: { from, to },
        reservationsCreated: orders.filter(order => inRange(order.createdAt)).length,
        overdueDeposits: orders.filter(order => order.stage === 'awaiting_deposit' && +new Date(order.deadline) < Date.now()).length,
        rejectedOrExpiredLinks: orders.reduce((count, order) => count + order.intents.filter(intent => ['rejected', 'expired', 'failed'].includes(intent.status)
          && inRange(intent.updatedAt || intent.createdAt)).length, 0),
        unresolvedPaymentDifficulties: orders.reduce((count, order) => count + order.incidents.filter(item => !item.resolvedAt
          && ['Dificultad de pago', 'Pago por revisar', 'Pago informado por el cliente'].includes(item.type)).length, 0),
        failedReminders: orders.reduce((count, order) => count + Object.values(order.reminders || {}).filter(item => item.status === 'failed').length, 0),
        noShows: orders.filter(order => order.stage === 'no_show' && inRange(order.visitAt)).length,
        closedReservations: orders.filter(order => order.stage === 'closed' && inRange(order.closedAt)).length,
      };
      const fallback = [];
      if (metrics.unresolvedPaymentDifficulties) fallback.push({ title: 'Priorizar dificultades de pago',
        detail: 'Revisa las incidencias abiertas de pago y registra su resolución para evitar seguimientos duplicados.', priority: 'high' });
      if (metrics.rejectedOrExpiredLinks || metrics.overdueDeposits) fallback.push({ title: 'Revisar enlaces y anticipos vencidos',
        detail: 'Comprueba rechazos y enlaces vencidos antes de emitir nuevos enlaces o cancelar reservas.', priority: 'high' });
      if (metrics.failedReminders) fallback.push({ title: 'Verificar entrega de recordatorios',
        detail: 'Revisa ventana de WhatsApp, consentimiento y configuración del webhook para los recordatorios fallidos.', priority: 'normal' });
      if (metrics.noShows) fallback.push({ title: 'Observar inasistencias',
        detail: 'Compara las inasistencias con los recordatorios de visita y la verificación de llegada.', priority: 'normal' });
      if (!fallback.length) fallback.push({ title: 'Seguir observando la tendencia',
        detail: 'El período no muestra alertas agregadas destacadas. Revisa de nuevo cuando haya más operaciones.', priority: 'normal' });
      const aiResult = await ai.recommend(metrics);
      return json(res, 200, { metrics, insights: aiResult?.insights?.length ? aiResult.insights : fallback,
        source: aiResult?.insights?.length ? 'gemini' : 'local' });
    }
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
      role: staff.role, portalEnabled: Boolean(portal),
      agent: config.orchestration, ai: ai.enabled, ...await settings(), settingsDefaults: initialSettings,
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
      return json(res, 200, { ...occupancy, label: limaFormatDay(date), slotMinutes: rule.slotMinutes, available: getAvailableSlots({ orders, blocks, settings: rule,
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
      const force = staff.role === 'admin' && input.forceCapacity === true;
      const available = await ensureAvailable(order.visitAt, order.guests, null, rule, force);
      if (!available && force) addEvent(order, 'Aforo excedido por personal', 'El operador forzó la reserva para esta franja.', 'Operador');
      return json(res, 201, await store.insert(order));
    }
    const action = path.match(/^\/api\/orders\/([a-f0-9-]+)\/([a-z-]+)$/);
    if (action && isPost && uuid.test(action[1])) {
      const [, id, kind] = action;
      const input = parse(await readBody(req));
      if (kind === 'link') {
        const intent = await checkout(id, input.method, 'deposit', false, staff.id ? staff : null);
        return json(res, 200, { intent, url: linkFor(intent), order: (await store.get(id)).data });
      }
      if (kind === 'message') {
        requireThat(portal || config.waMode === 'cloud', 'Activa WhatsApp Cloud API en la configuración.', 409);
        let order = (await store.get(id))?.data;
        requireThat(order, 'Reserva no encontrada.', 404);
        // Un envío manual solo sale sin plantilla si la baja no está activa o hay sesión abierta.
        if (await optedOut(order.phone) && !(await sessionOpen(order.phone))) {
          const error = new Problem('El cliente se dio de baja de los mensajes', 409);
          const type = input.type === 'balance' ? 'Envío del link de saldo pendiente'
            : input.type === 'receipt' ? 'Envío de constancia pendiente'
              : input.type === 'arrival' ? 'Confirmación de asistencia pendiente'
                : input.type === 'no_show' ? 'Aviso de inasistencia pendiente'
                  : input.type === 'resolution' ? 'Aviso de resolución pendiente' : 'Recordatorio pendiente';
          await update(id, data => {
            if (input.type === 'resolution') {
              const pending = data.incidents.find(issue => issue.type === type && !issue.resolvedAt
                && issue.key?.startsWith('resolution-notice:'));
              if (pending) pending.detail = error.message;
              else openIssue(data, type, error.message, 'resolution-notice:unknown');
            } else openIssue(data, type, error.message,
              input.type === 'arrival' ? 'attendance-confirmation:' + order.visitAt
                : input.type === 'no_show' ? 'no-show-notice:' + order.visitAt : 'manual-message:' + input.type);
          });
          throw error;
        }
        try {
          if (input.type === 'deposit') {
            const intent = await checkout(id, input.method);
            order = await send(order, paymentCta(order, intent, linkFor(intent)), { template: 'deposit', intent });
            await update(id, data => { for (const incident of data.incidents) if (incident.type === 'Solicitud de pago en línea'
              && !incident.resolvedAt) { incident.resolvedAt = instant(); incident.resolution = 'Se envió el enlace de anticipo solicitado por el cliente.'; } });
          } else if (input.type === 'balance') {
            order = await sendBalanceLink(order, { forceNew: Boolean(input.newLink), staff: staff.id ? staff : null });
          } else if (input.type === 'arrival') {
            requireThat(order.attendance?.state === 'confirmed' && order.attendance?.at,
              'Primero confirma la asistencia de la reserva.', 409);
            requireThat(await sendAttendanceConfirmation(order), 'No se pudo enviar el aviso al cliente. Revisa la incidencia abierta.', 409);
            order = (await store.get(id))?.data || order;
          } else if (input.type === 'no_show') {
            requireThat(order.stage === 'no_show', 'Primero registra la inasistencia de la reserva.', 409);
            requireThat(await sendNoShowNotification(order), 'No se pudo enviar el aviso al cliente. Revisa la incidencia abierta.', 409);
            order = (await store.get(id))?.data || order;
          } else if (input.type === 'resolution') {
            const pending = order.incidents.find(issue => issue.type === 'Aviso de resolución pendiente'
              && !issue.resolvedAt && issue.key?.startsWith('resolution-notice:'));
            requireThat(pending, 'No hay un aviso de resolución pendiente.', 409);
            const originalId = pending.key.slice('resolution-notice:'.length);
            const original = order.incidents.find(issue => issue.id === originalId && issue.resolvedAt);
            requireThat(original, 'No se encontró la resolución que se debe comunicar.', 409);
            const delivery = await sendResolutionNotice(id, original.id);
            requireThat(delivery.sent, delivery.error || 'No se pudo enviar el aviso al cliente.', 409);
            order = (await store.get(id))?.data || order;
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
            if (receipt.purpose === 'balance' && settlement) {
              await deliverReceipt(order, receipt, { force: true });
              await deliverReceipt(order, settlement, { force: true });
            } else await deliverReceipt(order, settlement || receipt, { force: true });
            order = (await store.get(id)).data;
          } else throw new Problem('Selecciona un mensaje válido.');
        } catch (error) {
          if (!['balance', 'arrival', 'no_show'].includes(input.type)) {
            const type = input.type === 'receipt' ? 'Envío de constancia pendiente'
              : input.type === 'deposit' ? 'Envío del link de anticipo pendiente'
                : input.type === 'arrival' ? 'Confirmación de asistencia pendiente'
                  : input.type === 'no_show' ? 'Aviso de inasistencia pendiente'
                    : input.type === 'resolution' ? 'Aviso de resolución pendiente' : 'Recordatorio pendiente';
            const pendingNotice = input.type === 'resolution'
              ? (await store.get(id))?.data.incidents.find(issue => issue.type === 'Aviso de resolución pendiente' && !issue.resolvedAt) : null;
            const key = input.type === 'resolution' ? pendingNotice?.key : 'manual-message:' + input.type;
            await update(id, data => {
              const current = input.type === 'resolution' && key
                ? data.incidents.find(issue => issue.key === key && !issue.resolvedAt) : null;
              if (current) current.detail = error.message;
              else openIssue(data, type, error.message, key);
            });
          }
          throw error;
        }
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
        const oldVisitAt = order.visitAt, rule = await settings(), force = staff.role === 'admin' && input.forceCapacity === true;
        requireThat(!(order.stage === 'awaiting_deposit' && depositDue(order) > 0 && +new Date(order.deadline) <= Date.now()) || force,
          'El plazo del anticipo venció. Reabre el plazo antes de reprogramar.', 409);
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
      if (kind === 'renew') {
        const row = await store.get(id), order = row?.data, rule = await settings();
        requireThat(order, 'Reserva no encontrada.', 404);
        requireThat(order.stage === 'awaiting_deposit' && depositDue(order) > 0 && +new Date(order.deadline) <= Date.now(),
          'Solo se pueden reabrir plazos de anticipos vencidos y pendientes.', 409);
        requireThat(!(order.payments || []).length, 'No se puede reabrir el plazo porque hay un pago registrado.', 409);
        requireThat(+new Date(order.visitAt) > Date.now() + 2 * 3600000, 'La visita debe estar a más de 2 horas; reprograma primero y revisa el cupo.', 409);
        requireThat(availabilityConfigured(rule), 'La disponibilidad debe estar configurada para verificar el cupo.', 409);
        await ensureAvailable(order.visitAt, order.guests, order.id, rule);
        const saved = await store.renewDepositAtomic(id, rule, 'Operador', order.visitAt, null);
        return json(res, 200, { order: saved.data || saved });
      }
      const receiptToken = randomUUID();
      const rule = await settings();
      const arrivalReported = kind === 'arrive' && Boolean((await store.get(id))?.data.attendance?.reportedAt);
      const result = await update(id, data => {
        if (kind === 'arrive') {
          if (portal) requireThat(limaDateKey(data.visitAt) === limaDateKey(new Date()) && typeof input.titularPresente === 'boolean',
            'Verifica la presencia del titular el día de su visita.', 409);
          arrive(data, Number(input.count), { staff: staff.id ? staff : null, titularPresente: input.titularPresente });
          if (portal && data.stage === 'paid' && !openPaymentIssue(data)) issueReceipt(data, 'settlement', receiptToken);
          return;
        }
        if (kind === 'counter') {
          if (portal) requireThat(input.channel === 'cash', 'Los pagos digitales se verifican desde su enlace.');
          recordCounterPayment(data, input.channel, staff.id ? staff : null);
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
          // Reclama el aviso en la misma escritura para que una caída no lo pierda.
          openIssue(data, 'Aviso de resolución pendiente', 'Preparando el mensaje para el cliente.', 'resolution-notice:' + issue.id);
          const notice = data.incidents.find(item => item.type === 'Aviso de resolución pendiente'
            && item.key === 'resolution-notice:' + issue.id && !item.resolvedAt);
          if (notice) notice.noticeStatus ||= 'pending';
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
      if (kind === 'arrive' && arrivalReported) await sendAttendanceConfirmation(result.order);
      if (kind === 'no-show') await sendNoShowNotification(result.order);
      if (['counter', 'arrive'].includes(kind) && balance(result.order) === 0) await deliverPendingReceipts(result.order);
      let customerNotified = null;
      if (kind === 'resolve') {
        const resolved = result.order.incidents.find(issue => issue.id === input.id);
        const delivery = resolved ? await sendResolutionNotice(id, resolved.id) : { sent: false };
        customerNotified = Boolean(delivery.sent);
        await deliverPendingReceipts(result.order);
      }
      if (kind === 'receipt') await deliverPendingReceipts(result.order);
      return json(res, 200, { ...result, ...(kind === 'resolve' ? { customerNotified } : {}), order: (await store.get(id))?.data || result.order });
    }
    return json(res, 404, { error: 'Ruta no encontrada.' });
  }
  function redactDiagnostic(value) {
    let result;
    try { result = typeof value === 'string' ? value : JSON.stringify(value); }
    catch { result = String(value); }
    if (result === undefined) return null;
    for (const [name, secret] of Object.entries(config.env || {})) {
      if (!/(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|ACCESS)/i.test(name) || typeof secret !== 'string' || !secret) continue;
      result = result.split(secret).join('[REDACTED]');
    }
    return result;
  }
  const middleware = (req, res, next) => route(req, res, next).catch(error => {
    if (error instanceof Problem) {
      if (!res.headersSent) json(res, error.status, { error: error.message });
      else res.end();
      return;
    }
    const path = (() => { try { return new URL(req.url, 'http://localhost').pathname; } catch { return '[ruta no disponible]'; } })();
    console.error('Error inesperado en PAYERS API', {
      method: req.method,
      path,
      error: {
        message: redactDiagnostic(error?.message),
        code: redactDiagnostic(error?.code),
        details: redactDiagnostic(error?.details),
        hint: redactDiagnostic(error?.hint),
        stack: redactDiagnostic(error?.stack),
      },
    });
    if (!res.headersSent) json(res, 500, { error: 'No se pudo completar la operación.' });
    else res.end();
  });
  return { middleware, async close() {
    clearInterval(timer); clearInterval(paymentTimer); clearTimeout(initialPaymentReconciliation); await store.close?.();
  } };
}
