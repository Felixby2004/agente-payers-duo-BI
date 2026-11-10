import { randomBytes } from 'node:crypto';
import { Problem } from './domain.mjs';

const phone = (value = '') => String(value).replace(/\D/g, '');

export function readConfig(env) {
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/$/, '');
  const paymentMode = env.PAYMENT_MODE || 'local';
  const waMode = env.WHATSAPP_MODE || 'off';
  const orchestration = env.AGENT_ORCHESTRATION || 'server';
  const remote = Boolean(publicUrl || paymentMode === 'mercado_pago' || waMode === 'cloud');
  const required = [];
  if (remote) required.push('PUBLIC_URL', 'ADMIN_PASSWORD', 'SESSION_SECRET');
  // WA_ALLOWED_PHONES es opcional: vacía significa modo abierto para cualquier remitente.
  if (waMode === 'cloud') required.push('WA_GRAPH_VERSION', 'WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET');
  if (orchestration === 'n8n') required.push('N8N_AGENT_TOKEN');
  if (paymentMode === 'mercado_pago') required.push('MP_TEST_ACCESS_TOKEN', 'MP_TEST_SELLER_ID', 'MP_WEBHOOK_SECRET');
  if (env.SUPABASE_URL || env.SUPABASE_SECRET_KEY || remote) required.push('SUPABASE_URL', 'SUPABASE_SECRET_KEY');
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error('Falta configurar ' + missing.join(', '));
  if (!['local', 'mercado_pago'].includes(paymentMode) || !['off', 'cloud'].includes(waMode)) throw new Error('Revisa PAYMENT_MODE y WHATSAPP_MODE.');
  if (!['server', 'n8n'].includes(orchestration) || (orchestration === 'n8n' && env.N8N_AGENT_TOKEN.length < 32)) throw new Error('Configura el modo de agente y un token n8n de al menos 32 caracteres.');
  if (publicUrl && (!/^https:\/\//.test(publicUrl) || new URL(publicUrl).origin !== publicUrl)) throw new Error('PUBLIC_URL debe ser el origen HTTPS público, sin ruta.');
  if (env.N8N_WAKE_URL && new URL(env.N8N_WAKE_URL).protocol !== 'https:') throw new Error('N8N_WAKE_URL debe usar HTTPS.');
  if (remote && (env.ADMIN_PASSWORD.length < 12 || env.SESSION_SECRET.length < 32)) throw new Error('Configura ADMIN_PASSWORD con 12 caracteres y SESSION_SECRET con 32 como mínimo.');
  const rate = Number(env.DEPOSIT_PER_PERSON || 20);
  const deadline = Number(env.DEPOSIT_DEADLINE_MINUTES || 120);
  const grace = Number(env.ARRIVAL_GRACE_MINUTES || 15);
  if (!(rate >= .01 && rate <= 1000 && deadline >= 1 && deadline <= 43200 && grace >= 0 && grace <= 1440)) throw new Error('Revisa los parámetros de cobranza.');
  const rateLimitMax = Number(env.WA_RATE_LIMIT_MAX || 20);
  const rateLimitWindowMs = Number(env.WA_RATE_LIMIT_WINDOW_MS || 600000);
  if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1 || !Number.isFinite(rateLimitWindowMs) || rateLimitWindowMs < 1000) {
    throw new Error('Revisa WA_RATE_LIMIT_MAX y WA_RATE_LIMIT_WINDOW_MS.');
  }
  const allowedPhones = new Set((env.WA_ALLOWED_PHONES || '').split(',').map(phone).filter(Boolean));
  const blockedPhones = new Set((env.WA_BLOCKED_PHONES || '').split(',').map(phone).filter(Boolean));
  // El alta por WhatsApp está apagada por defecto para no cambiar el comportamiento existente.
  const reservationMode = env.WA_RESERVATION_MODE || 'off';
  if (!['off', 'staff', 'open'].includes(reservationMode)) throw new Error('Revisa WA_RESERVATION_MODE.');
  const reservationStaff = new Set((env.WA_RESERVATION_STAFF || '').split(',').map(phone).filter(Boolean));
  return {
    env, publicUrl, paymentMode, waMode, orchestration, depositPerPerson: Math.round(rate * 100),
    deadlineMs: deadline * 60000, graceMs: grace * 60000,
    adminPassword: env.ADMIN_PASSWORD || '', sessionSecret: env.SESSION_SECRET || randomBytes(32).toString('hex'),
    reminderEnabled: waMode === 'cloud' && env.ENABLE_REMINDERS === 'true',
    allowedPhones, blockedPhones, rateLimitMax, rateLimitWindowMs, reservationMode, reservationStaff,
    // La lista permitida es una restricción opcional para demos controladas.
    isPhoneAllowed(value) { return allowedPhones.size === 0 || allowedPhones.has(phone(value)); },
    isPhoneBlocked(value) { return blockedPhones.has(phone(value)); },
    canReserve(value) {
      if (reservationMode === 'off') return false;
      if (reservationMode === 'open') return true;
      return reservationStaff.has(phone(value));
    },
  };
}

export async function requestJson(url, { service, ...options }) {
  let res;
  try { res = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(12000) }); }
  catch { throw new Problem('No se pudo contactar con ' + service + '. Revisa la conexión y vuelve a intentar.', 502); }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Problem(service + ' respondió con un error (' + res.status + '). Revisa su configuración.', 502);
  return data;
}
