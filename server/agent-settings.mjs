import { requireThat } from './domain.mjs';
import { defaultWeeklySchedule } from './availability.mjs';

export function defaults(config) {
  return {
    depositPerPerson: config.depositPerPerson,
    deadlineMinutes: config.deadlineMs / 60000,
    graceMinutes: config.graceMs / 60000,
    reminders: config.reminderEnabled,
    initialRequest: false,
    depositReminder: true,
    cancelExpiredDeposits: true,
    depositReminderMinutes: 30,
    depositLinkExpiryMinutes: 60,
    autoCancelExpiredHours: 24,
    depositRenewalsMax: 1,
    renewDepositMinutes: config.deadlineMs / 60000,
    paymentRetryMinutes: 0,
    maxDepositLinks: 3,
    maxOpenReservationsPerPhone: 3,
    visitReminder: true,
    firstVisitHours: 24,
    lastVisitHours: 3,
    counterAlertMinutes: 2,
    balanceLinkExpiryMinutes: 30,
    maxBalanceLinks: 3,
    weeklySchedule: defaultWeeklySchedule(),
    slotMinutes: 60,
    capacityPerSlot: 40,
    minRescheduleHours: 24,
    maxCustomerReschedules: 2,
    offerWindowDays: 30,
    whatsappRescheduling: true,
    internalAlerts: true,
    contactStart: '08:00',
    contactEnd: '22:00',
    yapeDemo: true,
    plinDemo: true,
    automaticConfirmation: true,
  };
}

export function completeSettings(saved, initial) {
  const previous = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const result = { ...initial, ...previous };
  result.maxBalanceLinks = Math.min(3, result.maxBalanceLinks);
  // Ajustes guardados antes de disponibilidad aún no tienen estos campos.
  for (const key of ['weeklySchedule', 'slotMinutes', 'capacityPerSlot']) {
    if (!Object.hasOwn(previous, key)) result[key] = structuredClone(initial[key]);
  }
  if (result.weeklySchedule && typeof result.weeklySchedule === 'object' && !Array.isArray(result.weeklySchedule)) {
    result.weeklySchedule = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map(day => {
      const hours = result.weeklySchedule[day];
      return [day, hours === null || (hours && typeof hours.open === 'string' && typeof hours.close === 'string') ? hours : null];
    }));
  }
  return result;
}

export function validateSettings(input, initial) {
  const data = {};
  input = { ...initial, ...input };
  const ranges = { depositPerPerson: [1, 100000], deadlineMinutes: [1, 43200], graceMinutes: [0, 1440],
    depositReminderMinutes: [1, 43200], firstVisitHours: [1, 168], lastVisitHours: [1, 168], counterAlertMinutes: [1, 1440],
    depositLinkExpiryMinutes: [1, 43200], paymentRetryMinutes: [0, 1440], maxDepositLinks: [1, 3],
    maxOpenReservationsPerPhone: [1, 100],
    balanceLinkExpiryMinutes: [1, 1440], maxBalanceLinks: [1, 3], slotMinutes: [15, 240], capacityPerSlot: [1, 1000],
    autoCancelExpiredHours: [0, 720], depositRenewalsMax: [0, 10], renewDepositMinutes: [1, 43200],
    minRescheduleHours: [1, 720], maxCustomerReschedules: [0, 10], offerWindowDays: [1, 90] };
  for (const [name, [min, max]] of Object.entries(ranges)) {
    const value = input?.[name];
    requireThat(Number.isInteger(value) && value >= min && value <= max, 'Revisa los importes y plazos de la configuración.');
    data[name] = value;
  }
  for (const [name, value] of Object.entries(initial)) if (typeof value === 'boolean') {
    requireThat(typeof input[name] === 'boolean', 'Revisa las opciones activadas.');
    data[name] = input[name];
  }
  for (const key of ['contactStart', 'contactEnd']) {
    requireThat(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input[key]), 'Indica un horario válido.');
    data[key] = input[key];
  }
  requireThat(typeof input.whatsappRescheduling === 'boolean', 'Revisa el interruptor de reprogramación.');
  data.whatsappRescheduling = input.whatsappRescheduling;
  const schedule = input.weeklySchedule;
  requireThat(schedule && typeof schedule === 'object' && !Array.isArray(schedule), 'Revisa el horario semanal.');
  const weeklySchedule = {};
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
    const hours = schedule[day];
    if (hours === null) { weeklySchedule[day] = null; continue; }
    requireThat(hours && typeof hours === 'object' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours.open)
      && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(hours.close) && hours.open < hours.close,
    'Indica apertura y cierre válidos para cada día abierto.');
    const open = hours.open.split(':').map(Number), close = hours.close.split(':').map(Number);
    requireThat(((close[0] * 60 + close[1]) - (open[0] * 60 + open[1])) >= data.slotMinutes,
      'Cada día abierto debe durar al menos una franja.');
    weeklySchedule[day] = { open: hours.open, close: hours.close };
  }
  data.weeklySchedule = weeklySchedule;
  requireThat(data.contactStart < data.contactEnd, 'La hora de inicio debe ser anterior a la hora de fin.');
  requireThat(data.lastVisitHours < data.firstVisitHours, 'El segundo aviso debe quedar más cerca de la visita que el primero.');
  return data;
}

export function contactTime(settings, now = new Date()) {
  const lima = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return lima >= settings.contactStart && lima < settings.contactEnd;
}
