import { randomUUID } from 'node:crypto';
import { balance, deposited, depositDue, paid, terminal } from '../shared/orders.mjs';

export class Problem extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireThat(condition, message, status) {
  if (!condition) throw new Problem(message, status);
}
const now = () => new Date().toISOString();
export const digits = (value = '') => String(value).replace(/\D/g, '');
export function addEvent(order, title, detail = '', actor = 'Sistema') {
  order.events.push({ id: randomUUID(), at: now(), title, detail, actor });
}
export function createOrder(input, config) {
  requireThat(input?.agreed === true, 'Confirma que el pedido y la visita ya fueron acordados.');
  const payer = String(input.payer || '').trim().slice(0, 100);
  const phone = digits(input.phone);
  const guests = Number(input.guests);
  const visitAt = new Date(input.visitAt);
  requireThat(payer.length >= 2, 'Escribe el nombre del pagador.');
  requireThat(!phone || /^[1-9]\d{7,14}$/.test(phone), 'Escribe el número con código de país.');
  requireThat(phone || input.synthetic, 'Indica el número de WhatsApp del pagador.');
  requireThat(Number.isInteger(guests) && guests >= 1 && guests <= 40, 'Indica entre 1 y 40 personas.');
  requireThat(Number.isFinite(+visitAt) && +visitAt > Date.now() + 60000, 'Elige una fecha y hora de visita futuras.');
  requireThat(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 30, 'Agrega entre 1 y 30 líneas al pedido.');
  const items = input.items.map(item => {
    const name = String(item.name || '').trim().slice(0, 120);
    const price = Number(item.price), quantity = Number(item.quantity);
    requireThat(name && Number.isInteger(price) && price >= 0 && price <= 1000000, 'Revisa los nombres y precios del pedido.');
    requireThat(Number.isInteger(quantity) && quantity >= 1 && quantity <= 100, 'Revisa las cantidades del pedido.');
    return { name, price, quantity };
  });
  const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
  const deposit = config.depositPerPerson * guests;
  requireThat(total >= deposit && deposit > 0, 'El total del pedido debe cubrir el anticipo por persona.');
  const id = randomUUID();
  const deadline = new Date(Math.min(Date.now() + config.deadlineMs, +visitAt)).toISOString();
  const order = {
    id, ref: 'EST-' + id.slice(0, 8).toUpperCase(), payer, phone, guests, items, total, deposit,
    rate: config.depositPerPerson, visitAt: visitAt.toISOString(), createdAt: now(),
    deadline, initialDeadline: deadline,
    stage: 'awaiting_deposit', notes: String(input.notes || '').slice(0, 500),
    consent: Boolean(phone && input.consent), synthetic: Boolean(input.synthetic), events: [], intents: [],
    payments: [], receipts: [], incidents: [], chat: [], reminders: {}, attendance: null, closedAt: null,
  };
  addEvent(order, 'Pedido recibido de LEADS', 'Pedido acordado para atención en el restaurante.', 'Operador');
  return order;
}

export function openIssue(order, type, detail, key = type) {
  if (order.incidents.some(i => i.key === key && !i.resolvedAt)) return;
  order.incidents.push({ id: randomUUID(), key, type, detail, at: now(), resolvedAt: null });
  addEvent(order, type, detail);
}

export function applyPayment(order, payment) {
  if (order.payments.some(p => p.ref === payment.ref)) return false;
  const due = payment.purpose === 'deposit' ? depositDue(order) : balance(order);
  const exceptions = payment.review || terminal(order) || (payment.purpose === 'deposit' && (
    new Date(payment.at || now()) > new Date(order.deadline) || order.stage !== 'awaiting_deposit'
  ));
  order.payments.push({ ...payment, at: payment.at || now() });
  addEvent(order, 'Pago verificado', payment.ref);
  if (payment.amount > due || exceptions) {
    openIssue(order, 'Pago por revisar', 'El pago llegó fuera del flujo esperado o supera el importe pendiente.', payment.ref);
  }
  if (!exceptions && !order.incidents.some(i => !i.resolvedAt && i.type === 'Pago por revisar')) {
    if (order.stage === 'awaiting_deposit' && depositDue(order) === 0) {
      order.stage = 'confirmed';
      order.confirmedAt = now();
      addEvent(order, 'Reserva confirmada');
    }
    if (order.stage === 'arrived' && balance(order) === 0) order.stage = 'paid';
  }
  return true;
}

export function arrive(order, count) {
  requireThat(order.stage === 'confirmed', 'Primero confirma el anticipo de la reserva.', 409);
  requireThat(Number.isInteger(count) && count >= 1 && count <= order.guests, 'La asistencia debe estar entre 1 y la cantidad reservada.');
  order.attendance = { count, at: now() };
  order.stage = balance(order) === 0 ? 'paid' : 'arrived';
  addEvent(order, 'Llegada verificada', count + ' de ' + order.guests + ' personas.', 'Recepción');
}

export function recordCounterPayment(order, channel) {
  requireThat(order.stage === 'arrived' && balance(order) > 0, 'No hay un saldo por cobrar en caja.', 409);
  requireThat(['cash', 'pos', 'wallet'].includes(channel), 'Selecciona un medio de demostración.');
  applyPayment(order, { ref: 'CAJA-' + randomUUID(), amount: balance(order), purpose: 'balance', channel });
}

export function issueReceipt(order, purpose, token) {
  requireThat(['deposit', 'settlement'].includes(purpose), 'Selecciona un tipo de comprobante.');
  const existing = order.receipts.find(r => r.purpose === purpose);
  if (existing) return existing;
  if (purpose === 'deposit') requireThat(deposited(order) >= order.deposit, 'El anticipo debe estar verificado.');
  else {
    requireThat(order.attendance && order.stage === 'paid' && paid(order) === order.total, 'Verifica la llegada y concilia el importe exacto del pedido antes de emitir.');
    requireThat(!order.incidents.some(i => !i.resolvedAt && ['Pago por revisar', 'Reverso por revisar'].includes(i.type)), 'Resuelve las incidencias de pago antes de cerrar.', 409);
  }
  const receipt = { purpose, token, at: now(), number: 'DEMO-' + order.ref.slice(4) + (purpose === 'deposit' ? '-A' : '-L'),
    amount: purpose === 'deposit' ? order.deposit : order.total, appliedDeposit: purpose === 'settlement' ? deposited(order) : 0 };
  order.receipts.push(receipt);
  addEvent(order, 'Comprobante de demostración emitido', receipt.number, 'Caja');
  if (purpose === 'settlement') {
    order.stage = 'closed';
    order.closedAt = now();
    addEvent(order, 'Cobranza cerrada', 'Llegada verificada, saldo cero y comprobante emitido.');
  }
  return receipt;
}

export function reschedule(order, value) {
  requireThat(['awaiting_deposit', 'confirmed'].includes(order.stage), 'Solo se puede cambiar una visita antes de la llegada.', 409);
  const newDate = new Date(value);
  requireThat(Number.isFinite(+newDate) && +newDate > Date.now() + 60000, 'Elige una fecha y hora futuras.');
  const previous = order.visitAt;
  order.visitAt = newDate.toISOString();
  if (order.stage === 'awaiting_deposit' && order.deadline > order.visitAt) order.deadline = order.visitAt;
  addEvent(order, 'Visita reprogramada', previous + ' → ' + order.visitAt, 'Operador');
}

export function endReservation(order, action, reason, graceMs) {
  requireThat(['awaiting_deposit', 'confirmed'].includes(order.stage), 'La reserva ya no admite esta acción.', 409);
  requireThat(String(reason || '').trim().length >= 3, 'Registra el motivo de la decisión.');
  if (action === 'no_show') requireThat(Date.now() >= +new Date(order.visitAt) + graceMs && order.stage === 'confirmed', 'Espera el final de la tolerancia para registrar la inasistencia.');
  order.stage = action;
  addEvent(order, action === 'cancelled' ? 'Reserva cancelada' : 'Inasistencia registrada', String(reason).slice(0, 300), 'Operador');
  if (paid(order) > 0) openIssue(order, 'Anticipo por resolver', 'Verifica la política de devolución antes de disponer del anticipo.');
}
