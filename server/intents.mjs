// Multinomial Naive Bayes, trained on short Spanish examples used in PAYERS.
const training = {
  menu: ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'menu', 'menu principal', 'inicio', 'hola que tal', 'hola buenas'],
  link: ['quiero pagar mi anticipo', 'mandame el enlace para pagar', 'pasame link de pago', 'como pago la reserva', 'enviame el link del anticipo', 'necesito un enlace de pago', 'quiero abonar', 'puedo pagar ahora'],
  paid: ['ya pague mi anticipo', 'acabo de pagar', 'hice el pago', 'te envie la captura', 'me cobraron', 'ya realice el pago', 'me debitaron el importe', 'hice una transferencia'],
  balance: ['cuanto falta por pagar', 'cual es mi saldo pendiente', 'cuanto queda', 'dime el saldo de mi pedido', 'cuanto pago en caja', 'quiero conocer el importe pendiente', 'cuanto debo pagar al llegar'],
  change: ['quiero cambiar la fecha', 'puedo reprogramar mi reserva', 'llegare tarde', 'podemos mover la hora', 'queremos ir otro dia', 'voy a llegar tarde', 'quiero modificar la visita', 'podemos cambiar el horario'],
  cancel: ['quiero cancelar mi reserva', 'no voy a poder ir', 'necesito una devolucion', 'me devuelven el anticipo', 'anula la reserva', 'quiero un reembolso', 'no podremos asistir'],
  issue: ['el enlace no abre', 'el link no funciona', 'me sale error al pagar', 'me rechazaron la tarjeta', 'mi pago salio rechazado', 'no pude pagar', 'el enlace esta vencido'],
  visit: ['confirmo que asistire', 'si voy a ir', 'donde queda el restaurante', 'a que hora es mi reserva', 'cuando es la visita', 'confirmo asistencia', 'ya estoy en el restaurante'],
  receipt: ['quiero mi comprobante', 'envia la constancia', 'necesito el recibo', 'dame el comprobante del anticipo'],
  human: ['quiero hablar con alguien', 'necesito un asesor humano', 'llama a una persona', 'necesito ayuda del personal', 'quiero hablar con caja'],
};
const tokens = (value) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  .replace(/est-[a-f0-9]{8}/gi, '').match(/[a-z]+/g) || [];
const vocabulary = new Set();
const models = Object.entries(training).map(([intent, lines]) => {
  const counts = new Map();
  let total = 0;
  for (const line of lines) for (const term of tokens(line)) {
    vocabulary.add(term);
    counts.set(term, (counts.get(term) || 0) + 1);
    total++;
  }
  return { intent, counts, total };
});
export function classify(message) {
  const plain = String(message || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/\bEST-[a-f0-9]{8}\b/gi, '').replace(/[^a-z]+/g, ' ').trim();
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|menu|inicio)$/.test(plain)) return 'menu';
  const words = tokens(message);
  if (words.length === 1) {
    const shortcuts = { anticipo: 'link', enlace: 'link', saldo: 'balance', pague: 'paid', comprobante: 'receipt',
      reprogramar: 'change', cancelar: 'cancel', ayuda: 'menu', reserva: 'visit' };
    return shortcuts[words[0]] || 'unknown';
  }
  const known = words.filter(word => vocabulary.has(word));
  if (known.length < 2) return 'unknown';
  const ranked = models.map(model => ({
    intent: model.intent,
    score: known.reduce((score, term) => score + Math.log(((model.counts.get(term) || 0) + 1) / (model.total + vocabulary.size)), 0),
  })).sort((a, b) => b.score - a.score);
  return ranked[0].score - ranked[1].score >= 0.45 ? ranked[0].intent : 'unknown';
}
