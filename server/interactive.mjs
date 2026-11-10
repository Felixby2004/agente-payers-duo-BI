import { balance, depositDue, limaDay, money, terminal } from '../shared/orders.mjs';

export const limits = Object.freeze({ body: 1024, buttons: 3, buttonTitle: 20, listButton: 20,
  rows: 10, rowTitle: 24, rowDescription: 72, ctaText: 20, id: 256 });

export const emojis = Object.freeze({
  deposit: '⏳',
  confirmed: '✅',
  attention: '⚠️',
  finished: '🧾',
  greeting: '🔥',
  visit: '🥩',
  farewell: '🍖',
  payment: '💳',
  receipt: '🧾',
  verified: '✅',
  calendar: '📅',
  note: '📝',
});

const normalized = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
export function clip(value, max) {
  const text = normalized(value);
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
  if (message.kind === 'cta') return message.body + ' [Enlace: ' + message.cta.displayText + ' — ' + message.cta.url + ']';
  return String(message.body || '');
}

export function parseAction(value) {
  const id = String(value ?? '').trim();
  if (id === 'menu') return { action: 'menu', ref: null };
  const match = id.match(/^([a-z]+):(EST-[A-F0-9]{8})$/i);
  if (!match || !['pay', 'yape', 'plin', 'bal', 'rcp', 'chg', 'hum', 'sel'].includes(match[1].toLowerCase())) return null;
  return { action: match[1].toLowerCase(), ref: match[2].toUpperCase() };
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
    const text = order.stage === 'closed'
      ? emojis.farewell + ' Gracias por visitarnos, ' + order.payer + '. ¡Esperamos verte pronto en El Establo!'
      : emojis.farewell + ' Gracias por escribirnos, ' + order.payer + '. Tu reserva *' + order.ref + '* está cerrada.';
    return receipt ? buttonsMessage(text, [button('rcp:' + order.ref, 'Ver constancia')]) : text;
  }
  const date = friendlyDate(order.visitAt, now, true);
  const people = personLabel(order.guests);
  if (order.stage === 'awaiting_deposit') {
    const expired = new Date(order.deadline) <= new Date(now);
    const text = expired
      ? emojis.attention + ' Hola, ' + order.payer + '. El plazo del anticipo de tu reserva *' + order.ref
        + '* venció. Puedo derivarte con el personal para revisarlo.'
      : emojis.greeting + ' Hola, ' + order.payer + '. Tu reserva *' + order.ref + '* en Parrilladas El Establo para el *'
        + date + '* (' + people + ') se confirma al pagar el anticipo de *' + money(depositDue(order)) + '*.';
    return buttonsMessage(text, expired
      ? [button('hum:' + order.ref, 'Hablar con alguien')]
      : [button('pay:' + order.ref, 'Pagar anticipo'), button('bal:' + order.ref, 'Ver saldo'),
        button('hum:' + order.ref, 'Hablar con alguien')]);
  }
  const text = emojis.visit + ' Hola, ' + order.payer + '. Tu reserva *' + order.ref + '* está confirmada para el *'
    + date + '* (' + people + '). Saldo en el local: *' + money(balance(order)) + '*. ¡Te esperamos!';
  if (order.stage === 'confirmed') {
    return buttonsMessage(text, [receiptButton(order, receipt), button('chg:' + order.ref, 'Cambiar fecha'),
      button('hum:' + order.ref, 'Hablar con alguien')]);
  }
  return buttonsMessage(text, [receiptButton(order, receipt), button('hum:' + order.ref, 'Hablar con alguien')]);
}

const sectionDefinitions = Object.freeze([
  { key: 'deposit', title: emojis.deposit + ' Por pagar anticipo' },
  { key: 'confirmed', title: emojis.confirmed + ' Confirmadas' },
  { key: 'attention', title: emojis.attention + ' Requieren atención' },
  { key: 'finished', title: emojis.finished + ' Finalizadas' },
]);
const blockingIncidents = new Set(['Pago por revisar', 'Reverso por revisar', 'Anticipo por resolver', 'Anticipo vencido']);

const blockingIssue = (order) => (order.incidents || []).find(incident => !incident.resolvedAt && blockingIncidents.has(incident.type));
const isExpired = (order, now) => order.stage === 'awaiting_deposit' && new Date(order.deadline) <= new Date(now);

function sectionOf(order, now) {
  if (terminal(order)) return 'finished';
  if (isExpired(order, now) || blockingIssue(order)) return 'attention';
  return order.stage === 'awaiting_deposit' ? 'deposit' : 'confirmed';
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
    state = isExpired(order, now) ? 'Anticipo vencido' : blockingIssue(order)?.type || 'Requiere atención';
  } else if (section === 'deposit') {
    state = 'Falta anticipo ' + money(depositDue(order));
  } else if (section === 'confirmed') {
    state = 'Confirmada · saldo ' + money(balance(order));
  } else {
    state = order.stage === 'cancelled' ? 'Cancelada' : order.stage === 'no_show' ? 'Inasistencia' : 'Finalizada';
  }
  const base = state + ' · ' + personLabel(order.guests);
  const full = base + ' · ' + order.ref;
  return normalized(full).length <= limits.rowDescription ? full : clip(base, limits.rowDescription);
}

function rowOf(order, section, now) {
  return { id: 'sel:' + order.ref, title: friendlyDate(order.visitAt, now),
    description: descriptionOf(order, section, now) };
}

export function reservationList(orders, now = new Date()) {
  const all = [...(orders || [])];
  const activeCount = all.filter(order => !terminal(order)).length;
  const buckets = new Map(sectionDefinitions.map(section => [section.key, []]));
  for (const order of all) buckets.get(sectionOf(order, now)).push(order);
  for (const rows of buckets.values()) rows.sort(visitSorter(now));
  const body = 'Tienes ' + (activeCount === 1 ? '1 reserva activa' : activeCount + ' reservas activas') + '. '
    + (all.length > limits.rows
      ? 'Mostrando las 10 más relevantes de ' + all.length + '. Si buscas otra, escríbeme su referencia.'
      : 'Elige la que quieres revisar.');
  const sections = [];
  let remaining = limits.rows;
  for (const definition of sectionDefinitions) {
    if (remaining <= 0) break;
    const rows = buckets.get(definition.key).slice(0, remaining).map(order => rowOf(order, definition.key, now));
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
  const focus = reservationFocus(orders, now);
  if (focus) return reservationMenu(focus, now);
  return (orders || []).filter(order => !terminal(order)).length > 1 ? reservationList(orders, now) : null;
}

export function requestMessage(order, type) {
  return (type === 'change' ? emojis.calendar : emojis.note) + ' Registré tu solicitud para *' + order.ref
    + '*. El personal la revisará y te confirmará los próximos pasos.';
}

export function paymentCta(order, intent, method, url) {
  const label = method === 'yape' ? 'Yape' : method === 'plin' ? 'Plin' : '';
  const text = emojis.payment + ' Tu anticipo de *' + money(intent.amount) + '* para *' + order.ref + '* está listo.';
  const preferred = label ? 'Pagar con ' + label : 'Pagar ' + money(intent.amount);
  return ctaMessage(text, preferred.length <= limits.ctaText ? preferred : 'Pagar anticipo', url);
}

export function paymentFollowUp(order, rule) {
  const names = [rule.yapeDemo && 'Yape', rule.plinDemo && 'Plin'].filter(Boolean);
  if (!names.length) return null;
  const buttons = [];
  if (rule.yapeDemo) buttons.push(button('yape:' + order.ref, 'Pagar con Yape'));
  if (rule.plinDemo) buttons.push(button('plin:' + order.ref, 'Pagar con Plin'));
  buttons.push(button('hum:' + order.ref, 'Hablar con alguien'));
  return buttonsMessage('También puedes simular el anticipo con *' + names.join('* o *') + '*, si lo prefieres.', buttons);
}

export function receiptCta(order, url) {
  return ctaMessage(emojis.receipt + ' Aquí tienes tu constancia de *' + order.ref + '*.', 'Ver constancia', url);
}

export function confirmationCta(order, url, now = new Date()) {
  return ctaMessage(emojis.verified + ' Anticipo verificado. Tu reserva *' + order.ref + '* está confirmada para el *'
    + friendlyDate(order.visitAt, now, true) + '*. Saldo a pagar en el local: *' + money(balance(order)) + '*.',
  'Ver constancia', url);
}
