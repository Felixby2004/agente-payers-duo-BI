import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.mjs';
import { createOrder } from '../server/domain.mjs';
import { checkRescheduleEligibility, defaultWeeklySchedule, getAvailableSlots, limaDateKey, limaDateTime } from '../server/availability.mjs';
import { limits, parseAction, rescheduleDaysMessage, rescheduleTimesMessage } from '../server/interactive.mjs';

const dayAfter = (days) => new Date(Date.now() + days * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
const dayKey = date => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${date}T12:00:00Z`).getUTCDay()];
const hours = { open: '12:00', close: '15:00' };
function settingsFor(date, extra = {}) {
  const weeklySchedule = Object.fromEntries(Object.keys(defaultWeeklySchedule()).map(day => [day, null]));
  weeklySchedule[dayKey(date)] = hours;
  return { weeklySchedule, slotMinutes: 60, capacityPerSlot: 3, minRescheduleHours: 24,
    maxCustomerReschedules: 2, offerWindowDays: 30, whatsappRescheduling: true, ...extra };
}

test('La disponibilidad calcula aforo por personas y excluye estados que liberan el cupo', () => {
  const date = dayAfter(3), settings = settingsFor(date), slot = limaDateTime(date, '12:00');
  const orders = [
    { id: 'a', stage: 'confirmed', visitAt: slot, guests: 2 },
    { id: 'b', stage: 'cancelled', visitAt: slot, guests: 5 },
  ];
  const blocks = [];
  assert.equal(getAvailableSlots({ orders, blocks, settings, fromDate: date, toDate: date, guests: 2 }).flatMap(x => x.slots).some(x => x.time === '12:00'), false);
  assert.equal(getAvailableSlots({ orders, blocks, settings, fromDate: date, toDate: date, guests: 1 }).flatMap(x => x.slots).some(x => x.time === '12:00'), true);
});

test('Los bloqueos, día cerrado y calendario se respetan en Lima', () => {
  const date = dayAfter(3), settings = settingsFor(date), slot = limaDateTime(date, '12:00');
  const rangeBlock = { kind: 'range', local_date: date, starts_at: slot, ends_at: limaDateTime(date, '13:00') };
  assert.equal(getAvailableSlots({ orders: [], blocks: [rangeBlock], settings, fromDate: date, toDate: date }).flatMap(x => x.slots).some(x => x.time === '12:00'), false);
  const closed = settingsFor(date, { weeklySchedule: { ...settings.weeklySchedule, [dayKey(date)]: null } });
  assert.deepEqual(getAvailableSlots({ orders: [], blocks: [], settings: closed, fromDate: date, toDate: date }), []);
  assert.equal(limaDateKey(slot), date);
});

test('La elegibilidad verifica estado, propietario, margen y máximo de cambios', () => {
  const setting = { whatsappRescheduling: true, minRescheduleHours: 24, maxCustomerReschedules: 2 };
  const order = { phone: '51911111111', stage: 'confirmed', visitAt: new Date(Date.now() + 48 * 3600000).toISOString(), rescheduleCount: 0 };
  assert.doesNotThrow(() => checkRescheduleEligibility(order, setting, order.phone));
  assert.throws(() => checkRescheduleEligibility(order, setting, '51922222222'), /no pertenece/);
  assert.throws(() => checkRescheduleEligibility({ ...order, visitAt: new Date(Date.now() + 2 * 3600000).toISOString() }, setting, order.phone), /anticipación/);
  assert.throws(() => checkRescheduleEligibility({ ...order, rescheduleCount: 2 }, setting, order.phone), /máximo/);
  assert.throws(() => checkRescheduleEligibility({ ...order, stage: 'arrived' }, setting, order.phone), /no se puede reprogramar/);
});

test('Las listas de fechas y horarios respetan los 10 renglones y los ids van ligados a la reserva', () => {
  const order = { ref: 'EST-1234ABCD', visitAt: limaDateTime(dayAfter(4), '12:00') };
  const days = Array.from({ length: 13 }, (_, index) => ({ date: dayAfter(index + 1), label: 'Día ' + (index + 1), slots: Array(10).fill({}) }));
  const dayPage = rescheduleDaysMessage(order, days);
  assert.equal(dayPage.list.sections[0].rows.length, limits.rows);
  assert.equal(parseAction(dayPage.list.sections[0].rows[0].id).ref, order.ref);
  const times = { date: days[0].date, label: days[0].label, slots: Array.from({ length: 20 }, (_, index) => ({
    date: days[0].date, time: String(12 + Math.floor(index / 60)).padStart(2, '0') + ':' + String(index % 60).padStart(2, '0'),
  })) };
  const timePage = rescheduleTimesMessage(order, times);
  assert.ok(timePage.list.sections[0].rows.length <= limits.rows);
  assert.equal(parseAction('rsc:' + order.ref + ':' + times.date + 'T12:00').action, 'rsc');
  assert.equal(parseAction('rsc:EST-FFFFFFFF:2099-01-01T12:00').ref, 'EST-FFFFFFFF');
  assert.equal(parseAction('rsc:' + order.ref + ':not-a-date'), null);
});

test('El RPC solo asigna el último cupo a una reprogramación concurrente e ignora el doble clic', async () => {
  const store = await openStore({ env: {} }, { memory: true });
  try {
    const destination = dayAfter(3), settings = settingsFor(destination), target = limaDateTime(destination, '12:00');
    const make = async (offset, phone) => {
      const order = createOrder({ agreed: true, payer: 'Prueba', phone, guests: 2,
        visitAt: new Date(Date.now() + offset * 86400000).toISOString(), items: [{ name: 'Parrilla', price: 50000, quantity: 1 }] },
      { depositPerPerson: 2000, deadlineMs: 3600000 });
      order.stage = 'confirmed';
      order.reminders = { ['visit:' + order.visitAt]: { status: 'sent' } };
      await store.insert(order);
      return order;
    };
    const one = await make(8, '51911111111'), two = await make(9, '51922222222');
    const outcomes = await Promise.allSettled([
      store.rescheduleAtomic(one.id, target, settings, false, 'Cliente', one.visitAt),
      store.rescheduleAtomic(two.id, target, settings, false, 'Cliente', two.visitAt),
    ]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
    const winner = +new Date((await store.get(one.id)).data.visitAt) === +new Date(target) ? one : two;
    const before = (await store.get(winner.id)).data;
    const repeated = await store.rescheduleAtomic(winner.id, target, settings, false, 'Cliente', winner.visitAt);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.data.rescheduleCount, before.rescheduleCount);
    assert.equal(repeated.data.events.filter(event => event.title === 'Visita reprogramada').length, 1);
    assert.deepEqual(before.reminders, {});

    const depositOrder = await make(10, '51933333333');
    depositOrder.stage = 'awaiting_deposit';
    const pending = { id: 'pending-deposit', purpose: 'deposit', status: 'pending', expiresAt: limaDateTime(destination, '14:00') };
    let row = await store.get(depositOrder.id);
    row.data.stage = 'awaiting_deposit';
    row.data.deadline = limaDateTime(destination, '15:00');
    row.data.intents.push(pending);
    await store.save(row.data, row.version);
    const earlierSlot = limaDateTime(destination, '13:00');
    const moved = await store.rescheduleAtomic(depositOrder.id, earlierSlot, settings, false, 'Cliente', depositOrder.visitAt);
    assert.equal(+new Date(moved.data.deadline), +new Date(earlierSlot));
    assert.equal(moved.data.intents[0].status, 'pending');
    assert.equal(moved.data.intents[0].expiresAt, pending.expiresAt);
  } finally { await store.close(); }
});
