import { balance, depositDue, limaDay, money, reservationStatus, terminal } from '../shared/orders.mjs';
import { menu } from '../shared/samples.mjs';

export const limits = Object.freeze({ body: 1024, buttons: 3, buttonTitle: 20, listButton: 20,
  rows: 10, rowTitle: 24, rowDescription: 72, ctaText: 20, id: 256 });

export const emojis = Object.freeze({
  deposit: '⏳',
  confirmed: '✅',
  attention: '⚠️',
  finished: '🧾',
  greeting: '💳',
  visit: '📅',
  farewell: '👋',
  payment: '💳',
  receipt: '🧾',
  verified: '✅',
  calendar: '📅',
  note: '📝',
});

const normalized = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const foldMap = Object.freeze({ á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n',
  Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U', Ü: 'U', Ñ: 'N' });
const fold = (value) => String(value ?? '').replace(/[áéíóúüñÁÉÍÓÚÜÑ]/g, char => foldMap[char] || char);
const onlyDigits = (value = '') => String(value).replace(/\D/g, '');
const productKey = (value) => fold(value).toLowerCase().replace(/[·•]/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
export function clip(value, max) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}
const identifier = (value) => String(value ?? '').trim().slice(0, limits.id);
const button = (id, title) => ({ id: identifier(id), title: clip(title, limits.buttonTitle) });
const withFallback = (message, items, separator = ' · ') => {
  const detail = items.filter(Boolean).join(separator);
  return { ...message, fallback: clip(message.body, limits.body) + (detail ? '\n\n' + detail : '') };
};

export function buttonsMessage(body, buttons) {
  const rows = (buttons || []).filter(Boolean).slice(0, limits.buttons).map(item => button(item.id, item.title));
  if (!rows.length) return clip(body, limits.body);
  return withFallback({ kind: 'buttons', body: clip(body, limits.body), buttons: rows }, rows.map(item => item.title));
}

export function listMessage({ body, title = 'Opciones', button: label = 'Ver opciones', rows, sections }) {
  const source = Array.isArray(sections) && sections.length ? sections : [{ title, rows }];
  const clean = [];
  let remaining = limits.rows;
  for (const section of source) {
    if (remaining <= 0) break;
    const items = (section.rows || []).filter(Boolean).slice(0, remaining).map(row => ({
      id: identifier(row.id), title: clip(row.title, limits.rowTitle),
      ...(row.description ? { description: clip(row.description, limits.rowDescription) } : {}),
    }));
    if (!items.length) continue;
    remaining -= items.length;
    clean.push({ title: clip(section.title || title, limits.rowTitle), rows: items });
  }
  const message = { kind: 'list', body: clip(body, limits.body),
    list: { button: clip(label, limits.listButton), sections: clean } };
  return withFallback(message, clean.flatMap(section => section.rows.map(row =>
    row.description ? row.title + ' — ' + row.description : row.title)), '\n');
}

export function ctaMessage(body, displayText, url) {
  const message = { kind: 'cta', body: clip(body, limits.body),
    cta: { displayText: clip(displayText, limits.ctaText), url: String(url || '') } };
  return withFallback(message, [message.cta.url]);
}

export function displayText(message) {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  if (message.kind === 'buttons') return message.body + ' [Botones: ' + message.buttons.map(item => item.title).join(' · ') + ']';
  if (message.kind === 'list') return message.body + ' [Lista: ' + (message.list.sections || []).flatMap(section =>
    section.rows.map(row => section.title + ' — ' + row.title + (row.description ? ' — ' + row.description : ''))).join(' · ') + ']';
  if (message.kind === 'cta') return message.body + ' [Botón: ' + message.cta.displayText + ']';
  return String(message.body || '');
}

export function parseAction(value) {
  const id = String(value ?? '').trim();
  if (id === 'menu') return { action: 'menu', ref: null };
  // Acción sin referencia para quien escribe sin una reserva registrada.
  if (id === 'staff') return { action: 'staff', ref: null };
  const reschedule = id.match(/^(rsd|rst|rsc):(EST-[A-F0-9]{8}):(.+)$/i);
  if (reschedule) {
    const [, action, ref, value] = reschedule;
    if ((action.toLowerCase() === 'rsd' && /^\d{4}-\d{2}-\d{2}$/.test(value))
      || (/^(rst|rsc)$/i.test(action) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) {
      return { action: action.toLowerCase(), ref: ref.toUpperCase(), value };
    }
    return null;
  }
  const page = id.match(/^(rsm|rsh):(EST-[A-F0-9]{8}):(\d{4}-\d{2}-\d{2}|\d{1,4})(?::(\d{1,4}))?$/i);
  if (page) return { action: page[1].toLowerCase(), ref: page[2].toUpperCase(), value: page[3], offset: Number(page[4] || (page[1].toLowerCase() === 'rsm' ? page[3] : 0)) };
  const match = id.match(/^([a-z]+):(EST-[A-F0-9]{8})$/i);
  if (!match || !['pay', 'payb', 'yape', 'plin', 'bal', 'rcp', 'chg', 'hum', 'sel', 'selb', 'selc', 'rsx'].includes(match[1].toLowerCase())) return null;
  return { action: match[1].toLowerCase(), ref: match[2].toUpperCase() };
}

export function rescheduleDaysMessage(order, days, offset = 0) {
  const page = days.slice(offset, offset + 9);
  const rows = page.map(day => ({ id: `rsd:${order.ref}:${day.date}`, title: day.label,
    description: day.slots.length + (day.slots.length === 1 ? ' horario disponible' : ' horarios disponibles') }));
  if (offset + 9 < days.length) rows.push({ id: `rsm:${order.ref}:${offset + 9}`, title: 'Ver más fechas' });
  return listMessage({ body: 'Elige una fecha para mover tu visita de *' + order.ref + '*.', button: 'Ver fechas', sections: [{ title: 'Fechas disponibles', rows }] });
}

export function rescheduleTimesMessage(order, day, offset = 0) {
  const pageSize = offset + 9 < day.slots.length ? 8 : 9;
  const page = day.slots.slice(offset, offset + pageSize);
  const rows = page.map(slot => ({ id: `rst:${order.ref}:${slot.date}T${slot.time}`, title: slot.time, description: 'Cupo disponible' }));
  if (offset + pageSize < day.slots.length) rows.push({ id: `rsh:${order.ref}:${day.date}:${offset + pageSize}`, title: 'Ver más horarios' });
  rows.push({ id: `rsm:${order.ref}:0`, title: 'Elegir otro día' });
  return listMessage({ body: 'Horarios disponibles para ' + day.label + '.', button: 'Ver horarios', sections: [{ title: 'Horarios', rows }] });
}

export function rescheduleConfirmMessage(order, newVisitAt, now = new Date()) {
  const current = friendlyDate(order.visitAt, now, true), next = friendlyDate(newVisitAt, now, true);
  const lima = new Date(+new Date(newVisitAt) - 5 * 60 * 60 * 1000);
  const value = lima.getUTCFullYear() + '-' + String(lima.getUTCMonth() + 1).padStart(2, '0') + '-'
    + String(lima.getUTCDate()).padStart(2, '0') + 'T' + String(lima.getUTCHours()).padStart(2, '0') + ':'
    + String(lima.getUTCMinutes()).padStart(2, '0');
  return buttonsMessage('¿Confirmas el cambio de fecha?\nReserva: *' + order.ref + '*\nActual: ' + current + '\nNueva: *' + next + '*',
    [button(`rsc:${order.ref}:${value}`, 'Confirmar'), button('rsx:' + order.ref, 'Cancelar')]);
}

export const texts = Object.freeze({
  noReservation: 'Hola 👋 Soy el asistente de cobranza de Parrilladas El Establo. Solo puedo ayudarte con anticipos y pagos de reservas ya registradas, y no encuentro una reserva asociada a este número. Si necesitas ayuda, pulsa el botón.',
  noReservationFallback: 'Si necesitas ayuda, responde «ayuda».',
  staff: 'Listo, avisé al personal. Te contactarán pronto.',
  reservation: 'Por aquí solo gestiono los pagos de tu reserva. Para cambios o una reserva nueva, el personal te ayudará.',
  optOut: 'Listo, no te enviaremos más recordatorios. Si quieres volver a recibirlos, escribe «alta».',
  optIn: 'Listo, volverás a recibir los recordatorios de tus reservas.',
  rate: 'Estás enviando muchos mensajes. Intenta de nuevo en unos minutos.',
  reservationRepeated: 'Ya tengo esta reserva registrada: {ref}.',
  reservationRegistered: '✅ Reserva {ref} registrada',
  reservationDetails: '{payer} · {people} · {date}',
  reservationTotal: 'Total {total} · Anticipo {deposit}',
  reservationDeadline: 'Vence el anticipo el {date}.',
  reservationDuplicateDate: 'Ese número ya tiene una reserva para esa fecha y esas personas: {ref}.',
  reservationLimit: 'Ese número ya tiene 3 reservas abiertas en los últimos 30 días. Pide al personal que revise el caso.',
  reservationMissingName: 'Falta el nombre del pagador. Envía el mensaje con Nombre: Nombre y apellidos.',
  reservationMissingDate: 'Falta la fecha de visita. Envía la reserva con Fecha y Hora en formato AAAA-MM-DD y HH:MM.',
  reservationInvalidDate: 'La fecha de visita no es válida. Usa Fecha: AAAA-MM-DD y Hora: HH:MM.',
  reservationTooSoon: 'La visita debe ser futura y con al menos 2 horas de anticipo.',
  reservationPeopleRange: 'Indica entre 1 y 40 personas.',
  reservationMissingItems: 'Falta el detalle del pedido. Indica los productos con Items: 2x Producto, ...',
  reservationItemFormat: 'Cada producto debe tener el formato "2x Producto".',
  reservationLineLimit: 'Agrega como máximo 30 líneas al pedido.',
  reservationNotesLimit: 'Las notas no pueden superar 500 caracteres.',
  reservationPhoneFormat: 'El teléfono debe incluir el código de país, por ejemplo 51999999999.',
  reservationConsentFormat: 'Indica Consentimiento: si o no.',
  reservationFieldFormat: 'No reconozco esa línea. Usa el formato Campo: valor.',
  reservationDuplicateField: 'El campo {field} aparece más de una vez. Déjalo una sola vez.',
  reservationUnknownProduct: 'No conozco el producto "{product}". Revisa la carta del restaurante.',
  reservationQuantityRange: 'La cantidad de "{product}" debe estar entre 1 y 100.',
});

const staffButton = () => button('staff', 'Hablar con alguien');

export function noReservationMessage() {
  const message = buttonsMessage(texts.noReservation, [staffButton()]);
  return { ...message, fallback: clip(texts.noReservation + '\n\nHablar con alguien.\n\n' + texts.noReservationFallback, limits.body) };
}

export function reservationHelpMessage() {
  return buttonsMessage(texts.reservation, [staffButton()]);
}

const reservationChange = /\b(cambiar|reprogramar|mover|modificar|cancelar|anular|devolucion|reembolso)\b/;
const reservationRequests = [
  /\b(reservar|reserva nueva|nueva reserva|hacer (?:una |otra )?reserva|tomar (?:una |otra )?reserva|agendar (?:una |otra )?reserva)\b/,
  /\b(quiero|quisiera|deseo|necesito|puedo|podemos|me gustaria|como (?:hago|puedo)|se puede)\b[^.!?]{0,60}\b(reservar|reserva nueva|hacer (?:una |otra )?reserva|tomar (?:una |otra )?reserva|agendar (?:una |otra )?reserva|una (?:nueva )?reserva|otra reserva)\b/,
  /\b(disponibilidad|hay (?:mesa|mesas|cupo|cupos)|mesa para|mesas para|reservar (?:una )?mesa)\b/,
  /\b(hacer|tomar|agendar|apartar|sacar)\b[^.!?]{0,20}\b(reserva|mesa)\b/,
];

// Detecta pedidos de una reserva nueva sin confundirlos con cambios de una existente.
export function reservationRequest(value) {
  const plain = String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ');
  if (!plain || reservationChange.test(plain)) return false;
  return reservationRequests.some(pattern => pattern.test(plain));
}

export const reservationErrors = Object.freeze({
  name: texts.reservationMissingName,
  date: texts.reservationMissingDate,
  dateFormat: texts.reservationInvalidDate,
  future: texts.reservationTooSoon,
  people: texts.reservationPeopleRange,
  items: texts.reservationMissingItems,
  itemFormat: texts.reservationItemFormat,
  lines: texts.reservationLineLimit,
  notes: texts.reservationNotesLimit,
  phone: texts.reservationPhoneFormat,
  consent: texts.reservationConsentFormat,
  line: texts.reservationFieldFormat,
});

const reservationLabels = Object.freeze([
  ['nombre', 'name'], ['pagador', 'name'], ['telefono', 'phone'], ['fecha', 'date'], ['hora', 'time'],
  ['personas', 'guests'], ['items', 'items'], ['productos', 'items'], ['notas', 'notes'],
  ['consentimiento', 'consent'], ['consent', 'consent'],
]);
const catalog = new Map(menu.map(item => [productKey(item.name), item]));

// Parser determinista del mensaje estructurado. No usa IA ni acepta importes.
export function parseReservation(value, now = new Date()) {
  const lines = String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const keyword = fold(lines[0]).replace(/\s+/g, ' ').replace(/:$/, '').trim().toLowerCase();
  if (keyword !== 'reserva') return null;

  const fields = {};
  for (const line of lines.slice(1)) {
    const plain = fold(line);
    let matched = false;
    for (const [label, key] of reservationLabels) {
      const match = new RegExp('^\\s*' + label + '\\b\\s*:?\\s*', 'i').exec(plain);
      if (!match) continue;
      if (Object.hasOwn(fields, key)) {
        return { ok: false, error: texts.reservationDuplicateField.replace('{field}', label) };
      }
      fields[key] = line.slice(match[0].length).trim();
      matched = true;
      break;
    }
    if (!matched) return { ok: false, error: reservationErrors.line + ' Línea: "' + clip(line, 60) + '".' };
  }

  const name = String(fields.name || '').trim();
  if (!name) return { ok: false, error: reservationErrors.name };
  if (name.length < 2) return { ok: false, error: 'Escribe el nombre del pagador.' };
  if (!fields.date || !fields.time) return { ok: false, error: reservationErrors.date };

  let phone;
  if (fields.phone) {
    phone = onlyDigits(fields.phone);
    if (!/^[1-9]\d{7,14}$/.test(phone)) return { ok: false, error: reservationErrors.phone };
  }

  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fields.date);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(fields.time);
  if (!dateMatch || !timeMatch) return { ok: false, error: reservationErrors.dateFormat };
  const [year, month, day] = dateMatch.slice(1).map(Number);
  const [hour, minute] = timeMatch.slice(1).map(Number);
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day
    || wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute || hour > 23 || minute > 59) {
    return { ok: false, error: reservationErrors.dateFormat };
  }
  // Lima es UTC-5 todo el año: la hora escrita se interpreta como hora local.
  const visit = new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
  if (!(+visit >= +new Date(now) + 2 * 3600000)) return { ok: false, error: reservationErrors.future };

  const guests = /^\d{1,2}$/.test(String(fields.guests || '').trim()) ? Number(fields.guests) : NaN;
  if (!Number.isInteger(guests) || guests < 1 || guests > 40) return { ok: false, error: reservationErrors.people };

  const rawItems = String(fields.items || '').trim();
  if (!rawItems) return { ok: false, error: reservationErrors.items };
  const parts = rawItems.split(',').map(part => part.trim());
  if (!parts.length || parts.some(part => !part)) return { ok: false, error: reservationErrors.itemFormat };
  if (parts.length > 30) return { ok: false, error: reservationErrors.lines };
  const items = [];
  for (const part of parts) {
    const match = /^(\d{1,3})\s*[xX×]\s*(.+)$/.exec(part);
    if (!match) return { ok: false, error: reservationErrors.itemFormat + ' Línea: "' + clip(part, 60) + '".' };
    const quantity = Number(match[1]);
    const label = match[2].trim();
    const product = catalog.get(productKey(label));
    if (!product) return { ok: false, error: texts.reservationUnknownProduct.replace('{product}', clip(label, 80)) };
    if (!(quantity >= 1 && quantity <= 100)) {
      return { ok: false, error: texts.reservationQuantityRange.replace('{product}', product.name) };
    }
    items.push({ name: product.name, price: product.price, quantity });
  }

  const notes = String(fields.notes || '').trim();
  if (notes.length > 500) return { ok: false, error: reservationErrors.notes };

  let consent = null;
  if (fields.consent !== undefined && fields.consent !== '') {
    const answer = fold(fields.consent).toLowerCase().trim();
    if (answer === 'si') consent = true;
    else if (answer === 'no') consent = false;
    else return { ok: false, error: reservationErrors.consent };
  }

  return { ok: true, value: {
    name: name.slice(0, 100), phone, date: fields.date, time: fields.time, guests,
    items, notes, consent, visitAt: visit.toISOString(),
  } };
}

// Clave estable para no duplicar el mismo pedido reenviado por WhatsApp.
export function reservationKey(value) {
  const phone = onlyDigits(value?.phone);
  const visitAt = value?.date || (value?.visitAt ? limaDay(value.visitAt) : '');
  const itemCounts = new Map();
  for (const item of value?.items || []) {
    const key = productKey(item.name);
    itemCounts.set(key, (itemCounts.get(key) || 0) + Number(item.quantity));
  }
  const items = [...itemCounts].map(([name, count]) => count + 'x' + name).sort().join(',');
  return [phone, visitAt, Number(value?.guests), items].join('|');
}

export function reservationRepeatedMessage(order) {
  return texts.reservationRepeated.replace('{ref}', order.ref);
}

export function reservationConfirmation(order, url = '', now = new Date()) {
  const body = [
    emojis.confirmed + ' *Reserva registrada*',
    'Referencia: *' + order.ref + '*',
    'Fecha y hora: ' + capitalize(friendlyDate(order.visitAt, now, true)),
    'Personas: ' + personLabel(order.guests),
    'Total: ' + money(order.total),
    'Anticipo: *' + money(order.deposit) + '*',
    'Vence: ' + friendlyDate(order.deadline, now, true),
  ].join('\n');
  if (!url) return body + '\nEl enlace de pago está pendiente. Escribe «anticipo» para solicitarlo de nuevo.';
  return ctaMessage(body, 'Pagar anticipo', url);
}

const capitalize = (value) => value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
const cleanPart = (value) => String(value).replace(/\.+$/, '').trim();
const limaTime = (date) => new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(date);

export function friendlyDate(value, now = new Date(), phrase = false) {
  const date = new Date(value);
  if (!Number.isFinite(+date)) return '';
  const reference = new Date(now);
  const day = limaDay(date);
  const today = limaDay(reference);
  const tomorrow = limaDay(new Date(+reference + 86400000));
  const time = limaTime(date);
  if (+date >= +reference && day === today) return (phrase ? 'hoy ' : 'Hoy ') + time;
  if (+date >= +reference && day === tomorrow) return (phrase ? 'mañana ' : 'Mañana ') + time;
  const weekday = cleanPart(new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', weekday: 'short' }).format(date));
  const dayNumber = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: 'numeric' }).format(date);
  const month = cleanPart(new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', month: 'short' }).format(date));
  const label = (phrase ? weekday.toLowerCase() : capitalize(weekday)) + ' ' + dayNumber + ' ' + month.toLowerCase();
  return label + (phrase ? ', ' : ' · ') + time;
}

export const personLabel = (count) => Number(count) + (Number(count) === 1 ? ' persona' : ' personas');

const receiptButton = (order, receipt) => receipt ? button('rcp:' + order.ref, 'Ver constancia') : button('bal:' + order.ref, 'Ver saldo');

export function reservationMenu(order, now = new Date()) {
  const receipt = order.receipts?.at(-1);
  if (terminal(order)) {
    const terminalText = { closed: 'Reserva cerrada. Gracias por visitarnos, ' + order.payer + '. ¡Esperamos verte pronto!',
      cancelled: 'Reserva cancelada', no_show: 'No asistió: la visita quedó marcada como inasistencia' };
    const text = emojis.farewell + ' *' + (terminalText[order.stage] || 'Reserva finalizada') + '*\nReferencia: *' + order.ref + '*';
    return receipt ? buttonsMessage(text, [button('rcp:' + order.ref, 'Ver constancia')]) : text;
  }
  const date = friendlyDate(order.visitAt, now, true);
  const people = personLabel(order.guests);
  if (order.stage === 'awaiting_deposit') {
    const status = reservationStatus(order, now);
    const expired = status === 'deposit_expired';
    if (status === 'deposit_received') return buttonsMessage(emojis.verified + ' *Anticipo recibido, confirmación pendiente*\nReserva: *'
      + order.ref + '*\nEstamos actualizando el estado del pago. Si no cambia pronto, avísame para revisarlo.',
    [button('hum:' + order.ref, 'Hablar con alguien')]);
    const text = expired
      ? emojis.attention + ' *Venció el plazo del anticipo*\nReserva: *' + order.ref + '*\nSi necesitas revisarlo, puedo avisar al personal.'
      : emojis.greeting + ' *Anticipo pendiente*\nReserva: *' + order.ref + '*\nVisita: ' + date + ' · ' + people
        + '\nImporte: *' + money(depositDue(order)) + '*';
    return buttonsMessage(text, expired
      ? [button('hum:' + order.ref, 'Hablar con alguien')]
      : [button('pay:' + order.ref, 'Pagar anticipo'), button('chg:' + order.ref, 'Cambiar fecha'),
        button('hum:' + order.ref, 'Hablar con alguien')]);
  }
  const status = reservationStatus(order, now);
  const headline = status === 'arrived' ? 'Llegada registrada' : status === 'paid' ? 'Pago completo' : 'Reserva confirmada';
  const text = emojis.visit + ' *' + headline + '*\nReferencia: *' + order.ref + '*\nVisita: ' + date + ' · ' + people
    + '\nSaldo en el local: *' + money(balance(order)) + '*';
  if (order.stage === 'confirmed') {
    return buttonsMessage(text, [receiptButton(order, receipt), button('chg:' + order.ref, 'Cambiar fecha'),
      button('hum:' + order.ref, 'Hablar con alguien')]);
  }
  if (order.stage === 'arrived' && balance(order) > 0) return buttonsMessage(text,
    [button('payb:' + order.ref, 'Pagar saldo en línea'), button('bal:' + order.ref, 'Ver saldo'), button('hum:' + order.ref, 'Hablar con alguien')]);
  return buttonsMessage(text, [receiptButton(order, receipt), button('hum:' + order.ref, 'Hablar con alguien')]);
}

const sectionDefinitions = Object.freeze([
  { key: 'deposit', title: 'Por pagar anticipo' },
  { key: 'confirmed', title: 'Confirmadas' },
  { key: 'attention', title: 'Requieren atención' },
  { key: 'finished', title: 'Finalizadas' },
]);
const blockingIncidents = new Set(['Pago por revisar', 'Reverso por revisar', 'Anticipo por resolver', 'Anticipo vencido']);

const isExpired = (order, now) => reservationStatus(order, now) === 'deposit_expired';
const blockingIssue = (order, now) => (order.incidents || []).find(incident => !incident.resolvedAt
  && blockingIncidents.has(incident.type)
  // Una incidencia histórica de vencimiento deja de bloquear visualmente al confirmarse el anticipo.
  && (incident.type !== 'Anticipo vencido' || isExpired(order, now)));

function sectionOf(order, now) {
  if (terminal(order)) return 'finished';
  if (['deposit_expired', 'deposit_received'].includes(reservationStatus(order, now)) || blockingIssue(order, now)) return 'attention';
  return reservationStatus(order, now) === 'deposit_pending' ? 'deposit' : 'confirmed';
}

function visitSorter(now) {
  const reference = +new Date(now);
  return (left, right) => {
    const a = +new Date(left.visitAt), b = +new Date(right.visitAt);
    const pastLeft = a < reference, pastRight = b < reference;
    if (pastLeft !== pastRight) return pastLeft ? 1 : -1;
    return pastLeft ? b - a : a - b;
  };
}

function descriptionOf(order, section, now) {
  let state;
  if (section === 'attention') {
    state = reservationStatus(order, now) === 'deposit_expired' ? 'Anticipo vencido' : statusLabel(order, now);
  } else if (section === 'deposit') {
    state = 'Falta anticipo ' + money(depositDue(order));
  } else {
    state = statusLabel(order, now);
  }
  const base = state + ' · ' + personLabel(order.guests);
  const full = base + ' · ' + order.ref;
  return normalized(full).length <= limits.rowDescription ? full : clip(base, limits.rowDescription);
}

function statusLabel(order, now) {
  const labels = { confirmed: 'Confirmada · saldo ' + money(balance(order)), arrived: 'Llegó · saldo ' + money(balance(order)),
    deposit_received: 'Anticipo recibido · confirmación pendiente', paid: 'Pagada', closed: 'Cerrada', cancelled: 'Cancelada',
    no_show: 'No asistió', unknown: 'Requiere atención' };
  return labels[reservationStatus(order, now)] || labels.unknown;
}

function rowOf(order, section, now, selector = 'sel') {
  return { id: selector + ':' + order.ref, title: friendlyDate(order.visitAt, now),
    description: descriptionOf(order, section, now) };
}

export function reservationList(orders, now = new Date(), selector = 'sel') {
  const all = [...(orders || [])];
  const activeCount = all.filter(order => !terminal(order)).length;
  const buckets = new Map(sectionDefinitions.map(section => [section.key, []]));
  for (const order of all) buckets.get(sectionOf(order, now)).push(order);
  for (const rows of buckets.values()) rows.sort(visitSorter(now));
  const body = '📋 Tienes ' + (activeCount === 1 ? '1 reserva activa' : activeCount + ' reservas activas') + '. '
    + (all.length > limits.rows
      ? 'Mostrando las 10 más relevantes de ' + all.length + '. Si buscas otra, escríbeme su referencia.'
      : 'Elige una para ver sus detalles y opciones.');
  const sections = [];
  let remaining = limits.rows;
  for (const definition of sectionDefinitions) {
    if (remaining <= 0) break;
    const rows = buckets.get(definition.key).slice(0, remaining).map(order => rowOf(order, definition.key, now, selector));
    if (!rows.length) continue;
    remaining -= rows.length;
    sections.push({ title: definition.title, rows });
  }
  return listMessage({ body, button: 'Ver opciones', sections });
}

export function reservationFocus(orders, now = new Date()) {
  const all = [...(orders || [])];
  const active = all.filter(order => !terminal(order));
  if (active.length === 1) return active[0];
  if (!active.length && all.length) {
    return all.sort((left, right) => +new Date(right.visitAt) - +new Date(left.visitAt))[0];
  }
  return null;
}

export function reservationPrompt(orders, now = new Date()) {
  const current = [...(orders || [])];
  const active = current.filter(order => !terminal(order));
  const focus = reservationFocus(active.length ? active : current, now);
  if (focus) return reservationMenu(focus, now);
  return active.length > 1 ? reservationList(active, now) : null;
}

export function requestMessage(order, type) {
  return (type === 'change' ? emojis.calendar : emojis.note) + ' Registré tu solicitud para *' + order.ref
    + '*. El personal la revisará y te confirmará los próximos pasos.';
}

export function paymentCta(order, intent, method, url, options = {}) {
  const label = method === 'yape' ? 'Simular con Yape' : method === 'plin' ? 'Simular con Plin' : 'Pagar anticipo';
  const channel = method === 'checkout' ? 'Mercado Pago de prueba' : 'el medio de demostración elegido';
  const alternatives = [options.yapeDemo && 'Yape', options.plinDemo && 'Plin'].filter(Boolean);
  const text = emojis.payment + ' *Anticipo listo*\nReserva: *' + order.ref + '*\nImporte: *' + money(intent.amount)
    + '*\nContinúa en ' + channel + ' con el botón.'
    + (method === 'checkout' && alternatives.length ? '\nPara otro medio simulado, escribe *' + alternatives.join('* o *') + '*.' : '');
  return ctaMessage(text, clip(label, limits.ctaText), url);
}

export function balancePaymentCta(order, intent, url) {
  return ctaMessage(emojis.payment + ' *Saldo listo para pagar*\nReserva: *' + order.ref + '*\nImporte: *'
    + money(intent.amount) + '*\nPaga de forma segura con Mercado Pago.', 'Pagar saldo', url);
}

export function receiptCta(order, url, summary = '') {
  return ctaMessage(emojis.receipt + ' *Constancia interna de reserva*\nReferencia: *' + order.ref
    + '*' + (summary ? '\n' + summary : '')
    + '\nEs el resumen de El Establo. El comprobante oficial de Mercado Pago se consulta en la operación del pago.', 'Ver constancia', url);
}

export function confirmationCta(order, url, now = new Date(), additional = '') {
  const payment = [...(order.payments || [])].reverse().find(item => (item.purpose || 'deposit') === 'deposit' && item.amount > 0);
  const method = payment ? (payment.channel === 'mercadopago' ? 'Mercado Pago' : String(payment.channel || 'verificado').replace('_demo', '')) : 'verificado';
  return ctaMessage(emojis.verified + ' *Anticipo verificado*\nReserva: *' + order.ref + '*\nVisita: '
    + friendlyDate(order.visitAt, now, true) + '\nTotal: ' + money(order.total) + ' · Anticipo: *' + money(payment?.amount || order.deposit)
    + '* (' + method + (payment ? ' · ' + friendlyDate(payment.at, now, true) : '') + ')\nSaldo pendiente: *' + money(balance(order)) + '*.'
    + (additional ? '\n' + additional : ''),
  'Ver constancia', url);
}

export function paymentRejectedCta(order, intent, url) {
  const text = emojis.attention + ' *Pago no aprobado*\nReserva: *' + order.ref + '*\nNo se confirmó el anticipo de '
    + money(intent.amount) + '. Puedes intentarlo de nuevo con el botón.';
  return ctaMessage(text, 'Reintentar pago', url);
}
