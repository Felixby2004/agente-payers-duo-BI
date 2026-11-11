import { Problem, requireThat } from './domain.mjs';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ACTIVE = new Set(['awaiting_deposit', 'confirmed', 'arrived', 'paid']);
const MINUTE = 60000;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export function availabilityConfigured(settings = {}) {
  if (settings.availabilityConfigured === false) return false;
  const hasOpenDay = WEEKDAYS.some(day => {
    const hours = settings.weeklySchedule?.[day];
    return hours && typeof hours.open === 'string' && typeof hours.close === 'string';
  });
  return hasOpenDay && Number(settings.capacityPerSlot) > 0;
}
const localParts = (date) => {
  const shifted = new Date(+new Date(date) - 5 * 3600000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), weekday: shifted.getUTCDay() };
};
const dateKey = ({ year, month, day }) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
export const limaDateKey = (date) => dateKey(localParts(date));
export const limaDateTime = (key, time) => {
  const [year, month, day] = key.split('-').map(Number), [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute)).toISOString();
};
export const limaFormatDay = (key) => new Intl.DateTimeFormat('es-PE', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
  .format(new Date(`${key}T12:00:00Z`)).replace('.', '');
export const limaFormatTime = (iso) => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

export function defaultWeeklySchedule() {
  // Horario inicial amplio de demostración; el panel debe ajustarse al horario real del local.
  return Object.fromEntries(DAY_KEYS.map(key => [key, { open: '00:00', close: '23:59' }]));
}

function overlaps(block, slotStart, slotEnd, key) {
  if (block.local_date !== key) return false;
  if (block.kind === 'day' || (!block.starts_at && !block.ends_at)) return true;
  const start = +new Date(block.starts_at), end = +new Date(block.ends_at);
  return start < slotEnd && end > slotStart;
}
export function isSlotBlocked(blocks, visitAt, settings) {
  const { key } = validateSlotInput(visitAt, settings), start = +new Date(visitAt);
  return blocks.some(block => overlaps(block, start, start + Number(settings.slotMinutes || 60) * MINUTE, key));
}

export function getAvailableSlots({ orders = [], blocks = [], settings, fromDate, toDate, guests = 1, excludeOrderId = null, now = new Date() }) {
  requireThat(Number.isInteger(guests) && guests >= 1 && guests <= 40, 'La cantidad de personas no es válida.');
  if (!availabilityConfigured(settings)) return [];
  const duration = Number(settings.slotMinutes || 60), capacity = Number(settings.capacityPerSlot || 0);
  const first = new Date(`${fromDate}T12:00:00Z`), last = new Date(`${toDate}T12:00:00Z`);
  requireThat(Number.isFinite(+first) && Number.isFinite(+last) && first <= last, 'El rango de fechas no es válido.');
  const days = [];
  for (let cursor = +first; cursor <= +last; cursor += 86400000) {
    const date = new Date(cursor), key = date.toISOString().slice(0, 10), rule = settings.weeklySchedule?.[DAY_KEYS[date.getUTCDay()]];
    if (!rule) continue;
    const [openHour, openMinute] = rule.open.split(':').map(Number), [closeHour, closeMinute] = rule.close.split(':').map(Number);
    const opens = openHour * 60 + openMinute, closes = closeHour * 60 + closeMinute;
    const slots = [];
    for (let minutes = opens; minutes + duration <= closes; minutes += duration) {
      const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const startAt = limaDateTime(key, time), startMs = +new Date(startAt), endMs = startMs + duration * MINUTE;
      if (startMs <= +now || blocks.some(block => overlaps(block, startMs, endMs, key))) continue;
      const occupied = orders.filter(order => order.id !== excludeOrderId && ACTIVE.has(order.stage)
        && Number.isFinite(+new Date(order.visitAt)) && +new Date(order.visitAt) >= startMs && +new Date(order.visitAt) < endMs)
        .reduce((sum, order) => sum + Number(order.guests || 0), 0);
      if (capacity - occupied >= guests) slots.push({ date: key, time, visitAt: startAt, remaining: capacity - occupied });
    }
    if (slots.length) days.push({ date: key, label: limaFormatDay(key), slots });
  }
  return days;
}

export function getDayOccupancy({ orders = [], blocks = [], settings, date }) {
  if (!availabilityConfigured(settings)) return { date, closed: false, unconfigured: true, slots: [] };
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(), rule = settings.weeklySchedule?.[DAY_KEYS[weekday]];
  if (!rule) return { date, closed: true, slots: [] };
  const [oh, om] = rule.open.split(':').map(Number), [ch, cm] = rule.close.split(':').map(Number);
  const duration = Number(settings.slotMinutes || 60), capacity = Number(settings.capacityPerSlot || 0), slots = [];
  for (let minutes = oh * 60 + om; minutes + duration <= ch * 60 + cm; minutes += duration) {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const start = +new Date(limaDateTime(date, time)), end = start + duration * MINUTE;
    const occupied = orders.filter(order => ACTIVE.has(order.stage) && +new Date(order.visitAt) >= start && +new Date(order.visitAt) < end)
      .reduce((sum, order) => sum + Number(order.guests || 0), 0);
    slots.push({ time, occupied, capacity, blocked: blocks.some(block => overlaps(block, start, end, date)) });
  }
  return { date, closed: false, slots };
}

export function checkRescheduleEligibility(order, settings, fromPhone = null, now = new Date()) {
  requireThat(settings.whatsappRescheduling, 'La reprogramación por WhatsApp está desactivada.', 409);
  requireThat(availabilityConfigured(settings), 'La disponibilidad aún no está configurada. El personal te ayudará con el cambio.', 409);
  requireThat(['awaiting_deposit', 'confirmed'].includes(order.stage), 'Esta reserva ya no se puede reprogramar por WhatsApp.', 409);
  if (fromPhone !== null) requireThat(String(order.phone) === String(fromPhone), 'Esta reserva no pertenece a este número.', 403);
  const remaining = +new Date(order.visitAt) - +now;
  requireThat(remaining >= Number(settings.minRescheduleHours) * 3600000, `Solo puedes cambiar la visita con al menos ${settings.minRescheduleHours} horas de anticipación.`, 409);
  requireThat(Number(order.rescheduleCount || 0) < Number(settings.maxCustomerReschedules), 'Alcanzaste el máximo de cambios de fecha para esta reserva.', 409);
}

export function validateSlotInput(visitAt, settings) {
  requireThat(Number.isFinite(+new Date(visitAt)) && +new Date(visitAt) > Date.now() + 60000, 'Elige una franja futura.');
  const parts = localParts(visitAt), key = dateKey(parts), mins = parts.hour * 60 + parts.minute;
  const rule = settings.weeklySchedule?.[DAY_KEYS[parts.weekday]];
  requireThat(rule, 'Ese día el restaurante está cerrado.', 409);
  const [openH, openM] = rule.open.split(':').map(Number), [closeH, closeM] = rule.close.split(':').map(Number);
  const duration = Number(settings.slotMinutes || 60), close = closeH * 60 + closeM;
  requireThat(mins >= openH * 60 + openM && mins + duration <= close && (mins - (openH * 60 + openM)) % duration === 0,
    'El horario elegido no coincide con una franja disponible.', 409);
  return { key, endAt: new Date(+new Date(visitAt) + duration * MINUTE).toISOString() };
}

export function noAvailability() { return new Problem('No hay horarios con cupo para esa cantidad de personas.', 409); }

