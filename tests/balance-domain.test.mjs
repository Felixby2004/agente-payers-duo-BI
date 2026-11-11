import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPayment, arrive, createOrder, issueReceipt, recordCounterPayment } from '../server/domain.mjs';
import { balance } from '../shared/orders.mjs';

function order() {
  return createOrder({ agreed: true, payer: 'Demo', phone: '51911111111', consent: true, guests: 1,
    visitAt: new Date(Date.now() + 86400000).toISOString(), items: [{ name: 'Parrilla', price: 10000, quantity: 1 }] },
  { depositPerPerson: 2000, deadlineMs: 3600000 });
}

test('Un intento balance de caja invalida el link pendiente y crea comprobantes por pago y liquidación', () => {
  const data = order();
  applyPayment(data, { ref: 'MP-ANT', amount: data.deposit, purpose: 'deposit', channel: 'mercadopago', intentId: 'deposit-intent' });
  arrive(data, 1);
  data.intents.push({ id: 'balance-intent', purpose: 'balance', amount: balance(data), status: 'pending', expiresAt: new Date(Date.now() + 60000).toISOString() });
  recordCounterPayment(data, 'cash');
  assert.equal(data.intents[0].status, 'superseded');
  assert.equal(data.payments.at(-1).purpose, 'balance');
  assert.equal(data.payments.at(-1).actor, 'Personal de caja');
  assert.equal(data.stage, 'paid');
  const balanceReceipt = issueReceipt(data, 'balance', 'balance-token', data.payments.at(-1));
  const finalReceipt = issueReceipt(data, 'settlement', 'settlement-token');
  assert.equal(balanceReceipt.paymentRef, data.payments.at(-1).ref);
  assert.deepEqual(finalReceipt.paymentBreakdown.map(item => item.purpose), ['deposit', 'balance']);
  assert.equal(issueReceipt(data, 'balance', 'ignored-token', data.payments.at(-1)).token, 'balance-token');
  assert.equal(data.stage, 'closed');
});

test('Un intento histórico sin propósito sigue siendo un anticipo', () => {
  const data = order();
  applyPayment(data, { ref: 'SIM-OLD', amount: data.deposit, channel: 'simulation' });
  assert.equal(data.stage, 'confirmed');
  assert.equal(data.payments[0].purpose, 'deposit');
});
