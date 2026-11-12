import { randomBytes } from 'node:crypto';
import { Problem } from './domain.mjs';

const phone = (value = '') => String(value).replace(/\D/g, '');

export function readConfig(env) {
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/$/, '');
  const paymentMode = env.PAYMENT_MODE || 'local';
  const waMode = env.WHATSAPP_MODE || 'off';
  const orchestration = env.AGENT_ORCHESTRATION || 'server';
  if (env.AI_PROVIDER && !['gemini', 'openai'].includes(env.AI_PROVIDER)) throw new Error('AI_PROVIDER debe ser gemini u openai.');
  const remote = Boolean(publicUrl || paymentMode === 'mercado_pago' || waMode === 'cloud');
  const portalEnabled = env.PAYERS_PORTAL === 'true';
  const otpFreeForm = env.WA_OTP_FREE_FORM === 'true';
  const menuUrl = env.PUBLIC_MENU_IMAGE_URL || '';
  if (menuUrl && !/^https:\/\/res\.cloudinary\.com\/[^\s]+$/i.test(menuUrl)) {
    throw new Error('PUBLIC_MENU_IMAGE_URL debe ser un enlace HTTPS público de res.cloudinary.com.');
  }
  const required = [];
  if (remote) required.push('PUBLIC_URL', 'ADMIN_PASSWORD', 'SESSION_SECRET');
  else if (portalEnabled) required.push('ADMIN_PASSWORD');
  // WA_ALLOWED_PHONES es opcional: vacía significa modo abierto para cualquier remitente.
  if (waMode === 'cloud') required.push('WA_GRAPH_VERSION', 'WA_PHONE_NUMBER_ID', 'WA_ACCESS_TOKEN', 'WA_VERIFY_TOKEN', 'WA_APP_SECRET');
  if (orchestration === 'n8n') required.push('N8N_AGENT_TOKEN');
  if (paymentMode === 'mercado_pago') required.push('MP_TEST_ACCESS_TOKEN', 'MP_TEST_SELLER_ID', 'MP_TEST_BUYER_ID', 'MP_WEBHOOK_SECRET');
  if (env.SUPABASE_URL || env.SUPABASE_SECRET_KEY || remote) required.push('SUPABASE_URL', 'SUPABASE_SECRET_KEY');
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error('Falta configurar ' + missing.join(', '));
  if (!['local', 'mercado_pago'].includes(paymentMode) || !['off', 'cloud'].includes(waMode)) throw new Error('Revisa PAYMENT_MODE y WHATSAPP_MODE.');
  if (paymentMode === 'mercado_pago' && !/^\d{1,20}$/.test(env.MP_TEST_BUYER_ID)) throw new Error('MP_TEST_BUYER_ID debe ser el ID numérico del comprador de prueba.');
  if (!['server', 'n8n'].includes(orchestration) || (orchestration === 'n8n' && env.N8N_AGENT_TOKEN.length < 32)) throw new Error('Configura el modo de agente y un token n8n de al menos 32 caracteres.');
  if (publicUrl && (!/^https:\/\//.test(publicUrl) || new URL(publicUrl).origin !== publicUrl)) throw new Error('PUBLIC_URL debe ser el origen HTTPS público, sin ruta.');
  if (env.N8N_WAKE_URL) {
    const wakeUrl = new URL(env.N8N_WAKE_URL);
    const localWake = ['127.0.0.1', 'localhost', '[::1]'].includes(wakeUrl.hostname);
    if (wakeUrl.protocol !== 'https:' && !(localWake && wakeUrl.protocol === 'http:')) {
      throw new Error('N8N_WAKE_URL debe usar HTTPS, salvo que apunte al propio equipo.');
    }
  }
  if (portalEnabled && env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD debe tener al menos 12 caracteres.');
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
  // El flujo acepta altas solo mediante el mensaje estructurado y valida disponibilidad.
  const reservationMode = env.WA_RESERVATION_MODE || 'off';
  if (!['off', 'staff', 'open'].includes(reservationMode)) throw new Error('Revisa WA_RESERVATION_MODE.');
  const reservationStaff = new Set((env.WA_RESERVATION_STAFF || '').split(',').map(phone).filter(Boolean));
  return {
    env, publicUrl, paymentMode, waMode, orchestration, portalEnabled, otpFreeForm, menuUrl, depositPerPerson: Math.round(rate * 100),
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
  catch (cause) {
    const error = new Problem('No se pudo contactar con ' + service + '. Revisa la conexión y vuelve a intentar.', 502);
    // Metadatos técnicos para diagnóstico seguro; nunca se conserva la URL ni el cuerpo enviado.
    error.upstreamHttpStatus = null;
    error.upstreamCode = cause?.name === 'TimeoutError' || cause?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
    throw error;
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    if (service === 'WhatsApp' && data?.error?.message) {
      const detail = String(data.error.message).replace(/(bearer\s+)[^\s,;]+/ig, '$1[oculto]')
        .replace(/\b(EAA[A-Za-z0-9_-]{20,})\b/g, '[token oculto]').slice(0, 240);
      const code = data.error.code ? ' · código ' + String(data.error.code).slice(0, 20) : '';
      throw new Problem('Meta rechazó el envío' + code + ': ' + detail, 502);
    }
    const error = new Problem(service + ' respondió con un error (' + res.status + '). Revisa su configuración.', 502);
    error.upstreamHttpStatus = res.status;
    // El status/código de proveedores permite distinguir cuota, acceso y solicitud inválida.
    // Se limita a un identificador alfanumérico para no filtrar mensajes ni datos de respuesta.
    const rawCode = data?.error?.status ?? data?.error?.code;
    error.upstreamCode = rawCode == null
      ? (data ? 'UPSTREAM_ERROR' : 'NON_JSON_RESPONSE')
      : String(rawCode).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    throw error;
  }
  return data;
}
