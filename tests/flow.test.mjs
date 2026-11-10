import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { makeApi } from '../server/api.mjs';
import { classify } from '../server/intents.mjs';
import { balance, deposited } from '../shared/orders.mjs';
import { samples } from '../shared/samples.mjs';

test('El catálogo contiene 100 casos distintos y el registro nace vacío', async () => {
  assert.equal(samples.length, 100);
  assert.equal(new Set(samples.map(x => x.payer)).size, 100);
  assert.ok(samples.every(x => !x.phone));
});

test('De formulario a cierre de caja, con rechazos, confirmación duplicada y devolución', async () => {
  const api = await makeApi({}, { memory: true });
  const server = createServer((req, res) => api.middleware(req, res, () => res.end()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = 'http://127.0.0.1:' + server.address().port + '/api/';
  async function call(path, body, expected = 200) {
    const res = await fetch(root + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const result = await res.json();
    assert.equal(res.status, expected, JSON.stringify(result));
    return result;
  }
  const visitAt = new Date(Date.now() + 86400000).toISOString();
  const seed = { agreed: true, synthetic: true, payer: 'Ana de prueba', guests: 4, visitAt, items: [{ name: 'Parrilla', price: 6000, quantity: 4 }] };
  try {
    assert.deepEqual(await call('orders'), []);
    await call('orders', { ...seed, agreed: false }, 400);
    const order = await call('orders', seed, 201);
    const p = 'orders/' + order.id + '/';
    assert.equal(order.deposit, 8000);
    assert.equal(order.total, 24000);
    await call(p + 'arrive', { count: 4 }, 409);
    await call(p + 'receipt', {}, 400);
    const rejected = await call(p + 'link', {});
    assert.equal((await call('payment/' + rejected.intent.id, { outcome: 'rejected' })).status, 'rejected');
    const { intent } = await call(p + 'link', {});
    assert.notEqual(intent.id, rejected.intent.id);
    assert.equal((await call(p + 'link', {})).intent.id, intent.id);
    const [a, b] = await Promise.all([call('payment/' + intent.id, { outcome: 'approved' }), call('payment/' + intent.id, { outcome: 'approved' })]);
    assert.equal(a.status, b.status);
    const [confirmed] = await call('orders');
    assert.equal(confirmed.stage, 'confirmed');
    assert.equal(confirmed.payments.length, 1);
    assert.equal(deposited(confirmed), 8000);
    assert.equal(balance(confirmed), 16000);
    assert.equal(confirmed.receipts[0].purpose, 'deposit');
    const newVisit = new Date(Date.now() + 172800000).toISOString();
    const moved = await call(p + 'reschedule', { visitAt: newVisit });
    assert.equal(moved.order.visitAt, newVisit);
    assert.equal(deposited(moved.order), 8000);
    await call(p + 'arrive', { count: 6 }, 400);
    const arrived = await call(p + 'arrive', { count: 3 });
    assert.equal(arrived.order.attendance.count, 3);
    const settled = await call(p + 'counter', { channel: 'cash' });
    assert.equal(settled.order.stage, 'paid');
    assert.equal(balance(settled.order), 0);
    await call(p + 'counter', { channel: 'cash' }, 409);
    const closed = await call(p + 'receipt', {});
    assert.equal(closed.order.stage, 'closed');
    const repeated = await call(p + 'receipt', {});
    assert.equal(repeated.result.token, closed.result.token);
    assert.equal(repeated.order.receipts.length, 2);
    const publicReceipt = await call('receipt/' + closed.result.token);
    assert.equal(publicReceipt.appliedDeposit, 8000);
    assert.equal(publicReceipt.amount, 24000);

    const another = await call('orders', seed, 201);
    assert.notEqual(another.ref, order.ref);
    const q = 'orders/' + another.id + '/';
    const secondLink = await call(q + 'link', {});
    await call('payment/' + secondLink.intent.id, { outcome: 'approved' });
    const cancelled = await call(q + 'cancel', { reason: 'Cancelación de prueba' });
    const ref = cancelled.order.payments[0].ref;
    await Promise.all([call(q + 'refund', { ref }), call(q + 'refund', { ref })]);
    const refunded = (await call('orders')).find(o => o.id === another.id);
    assert.equal(refunded.payments.length, 2);
    assert.equal(deposited(refunded), 0);

    const config = await call('config');
    await call('agent/settings', { ...config, depositPerPerson: 2500, plinDemo: false });
    const withNewRule = await call('orders', seed, 201);
    assert.equal(withNewRule.deposit, 10000);
    const z = 'orders/' + withNewRule.id + '/';
    await call(z + 'link', { method: 'plin' }, 409);
    const yape = await call(z + 'link', { method: 'yape' });
    assert.equal((await call('payment/' + yape.intent.id)).method, 'yape');
    await call('payment/' + yape.intent.id, { outcome: 'approved' });
    const list = await call('orders');
    assert.equal(list.find(o => o.id === withNewRule.id).payments[0].channel, 'yape_demo');
    assert.equal(list.find(o => o.id === order.id).deposit, 8000);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await api.close();
  }
});

test('El agente distingue las intenciones principales sin inferir confirmaciones', () => {
  assert.equal(classify('Ya pagué mi anticipo'), 'paid');
  assert.equal(classify('Necesito cambiar la fecha de mi reserva'), 'change');
  assert.equal(classify('¿Cuánto falta por pagar?'), 'balance');
  assert.equal(classify('Quiero hablar con alguien'), 'human');
  assert.equal(classify('hola'), 'menu');
  assert.equal(classify('buenos días'), 'menu');
  assert.equal(classify('ayuda'), 'menu');
  assert.equal(classify('🧩'), 'unknown');
});
