import { requireThat } from './domain.mjs';

export function defaults(config) {
  return {
    depositPerPerson: config.depositPerPerson,
    deadlineMinutes: config.deadlineMs / 60000,
    graceMinutes: config.graceMs / 60000,
    reminders: config.reminderEnabled,
    initialRequest: false,
    depositReminder: true,
    depositReminderMinutes: 30,
    visitReminder: true,
    firstVisitHours: 24,
    lastVisitHours: 3,
    counterAlertMinutes: 2,
    balanceLinkExpiryMinutes: 30,
    maxBalanceLinks: 3,
    internalAlerts: true,
    contactStart: '08:00',
    contactEnd: '22:00',
    yapeDemo: true,
    plinDemo: true,
    automaticConfirmation: true,
  };
}

export function validateSettings(input, initial) {
  const data = {};
  const ranges = { depositPerPerson: [1, 100000], deadlineMinutes: [1, 43200], graceMinutes: [0, 1440],
    depositReminderMinutes: [1, 43200], firstVisitHours: [1, 168], lastVisitHours: [1, 168], counterAlertMinutes: [1, 1440],
    balanceLinkExpiryMinutes: [1, 1440], maxBalanceLinks: [1, 20] };
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
  requireThat(data.contactStart < data.contactEnd, 'La hora de inicio debe ser anterior a la hora de fin.');
  requireThat(data.lastVisitHours < data.firstVisitHours, 'El segundo aviso debe quedar más cerca de la visita que el primero.');
  return data;
}

export function contactTime(settings, now = new Date()) {
  const lima = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return lima >= settings.contactStart && lima < settings.contactEnd;
}
