import { limaDateKey, limaDateTime } from './availability.mjs';

const normalized = value => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const tomorrow = (day) => new Date(Date.parse(day + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);

export function paymentPromise(text, now = new Date()) {
  const value = normalized(text);
  if (!/\b(?:pago|pagare|voy a pagar|hago el pago|hare el pago|puedo pagar)\b/.test(value)
    || /\b(?:ya|no)\s+(?:pague|pago|pagare|puedo pagar)\b/.test(value)) return null;
  const time = value.match(/\ba la(?:s)?\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|de la manana|de la tarde|de la noche)?/);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2] || '0');
  const meridiem = time[3];
  if (minute >= 60 || hour >= 24 || (meridiem && (hour < 1 || hour > 12))) return { ambiguous: true };
  if (!meridiem && hour > 0 && hour <= 12 && !time[1].startsWith('0')) return { ambiguous: true };
  if (/\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|pasado manana)\b|\d[/-]\d/.test(value)) return { ambiguous: true };
  if (meridiem) hour = hour % 12 + (/^p|tarde|noche/.test(meridiem) ? 12 : 0);
  const today = limaDateKey(now);
  const day = /\bmanana\s+(?:a la|pago|pagare)/.test(value) || /\b(?:pago|pagare)\s+manana\b/.test(value) ? tomorrow(today) : today;
  const at = limaDateTime(day, String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'));
  return { at, muteUntil: limaDateTime(tomorrow(day), '00:00') };
}

export function isArrivalReport(text) {
  const value = normalized(text).trim();
  return !/\b(?:no|aun no|todavia no)\b/.test(value)
    && /\b(?:ya llegue|ya llegamos|ya estoy en (?:el )?(?:local|restaurante)|estoy en la puerta)\b/.test(value);
}

export function wantsPortal(text) {
  return /\b(?:mis (?:pedidos|reservas|pagos|comprobantes|constancias)|(?:ver|enviame|manda|descargar|dame|quiero) (?:el |mi |los |mis )?(?:comprobante[s]?|constancia[s]?|pedido[s]?|reserva[s]?|carta)|la carta)\b/.test(normalized(text));
}

