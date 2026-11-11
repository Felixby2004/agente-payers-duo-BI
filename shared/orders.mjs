export const currency = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
export const money = (cents = 0) => currency.format(cents / 100);

export const stageLabels = {
  awaiting_deposit: 'Anticipo pendiente',
  confirmed: 'Reserva confirmada',
  arrived: 'Saldo pendiente',
  paid: 'Pago completo',
  closed: 'Cobranza cerrada',
  cancelled: 'Cancelada',
  no_show: 'Inasistencia',
};

// Fuente única para el estado que se presenta en listas y en el detalle.
// El plazo solo cambia la etiqueta mientras todavía se espera el anticipo.
export function reservationStatus(order, now = new Date()) {
  switch (order?.stage) {
    case 'awaiting_deposit':
      if (depositDue(order) === 0) return 'deposit_received';
      return Number.isFinite(+new Date(order.deadline)) && +new Date(order.deadline) <= +new Date(now)
        ? 'deposit_expired' : 'deposit_pending';
    case 'confirmed': return 'confirmed';
    case 'arrived': return 'arrived';
    case 'paid': return 'paid';
    case 'closed': return 'closed';
    case 'cancelled': return 'cancelled';
    case 'no_show': return 'no_show';
    default: return 'unknown';
  }
}

export const terminal = (order) => ['closed', 'cancelled', 'no_show'].includes(order.stage);
export const paid = (order) => order.payments.reduce((sum, p) => sum + p.amount, 0);
export const balance = (order) => Math.max(0, order.total - paid(order));
export const deposited = (order) => order.payments.filter(p => p.purpose === 'deposit').reduce((sum, p) => sum + p.amount, 0);
export const depositDue = (order) => Math.max(0, order.deposit - deposited(order));
export const limaDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(date));
export const visitText = (value) => new Intl.DateTimeFormat('es-PE', {
  timeZone: 'America/Lima', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));

export const paymentLabels = { mercadopago: 'Mercado Pago de prueba', simulation: 'Simulación local', yape_demo: 'Yape simulado', plin_demo: 'Plin simulado', cash: 'Efectivo de demostración', pos: 'POS de demostración', wallet: 'Billetera de demostración' };
