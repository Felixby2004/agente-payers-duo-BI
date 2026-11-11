import { useMemo, useState } from 'react';
import { Activity, ArrowDownToLine, ArrowRight, CalendarDays, CircleCheck, CircleDollarSign, ClipboardList, Clock3, ReceiptText, TriangleAlert, Wallet } from 'lucide-react';
import { balance, depositDue, limaDay, money, paid, paymentLabels, stageLabels, terminal, visitText } from '../shared/orders.mjs';
import { downloadCsv } from './client.mjs';

export const Badge = ({ stage }) => <span className={'badge ' + stage}><i />{stageLabels[stage]}</span>;
export function Empty({ icon: Icon = ClipboardList, title, detail, children }) {
  return <div className="empty"><span className="empty-icon"><Icon size={23} /></span><strong>{title}</strong><p>{detail}</p>{children}</div>;
}
export function Metric({ title, value, detail, icon: Icon, tone = 'wine' }) {
  return <article className="metric"><div className="metric-label">{title}<span className={'metric-icon ' + tone}><Icon size={18} /></span></div>
    <strong>{value}</strong><small>{detail}</small></article>;
}
const relativeDay = (offset) => limaDay(new Date(Date.now() + offset * 86400000));
const movements = (orders) => orders.flatMap(order => order.payments.map(payment => ({ ...payment, order })));
const net = (payments) => payments.reduce((sum, p) => sum + p.amount, 0);

function Trend({ list, days = 7 }) {
  const series = Array.from({ length: days }, (_, i) => {
    const date = relativeDay(i + 1 - days);
    return { date, cents: net(list.filter(p => limaDay(p.at) === date)) };
  });
  const peak = Math.max(100, ...series.map(p => Math.abs(p.cents)));
  return <div className="trend" role="img" aria-label={series.map(p => p.date + ' ' + money(p.cents)).join(', ')}>
    <div className="trend-lines"><span /><span /><span /></div>
    <div className="trend-series">{series.map((p, i) => <div className="trend-col" key={p.date}>
      <div className="trend-slot"><div className={'trend-bar' + (p.cents < 0 ? ' reversal' : '')}
        style={{ height: Math.max(3, Math.abs(p.cents) / peak * 100) + '%' }} title={p.date + ' · ' + money(p.cents)} /></div>
      <span>{days <= 7 || i % 5 === 0 || i === days - 1 ? p.date.slice(8) + '/' + p.date.slice(5, 7) : '\u00a0'}</span>
    </div>)}</div>
  </div>;
}

export function OrdersTable({ orders, open, brief = false }) {
  if (!orders.length) return <Empty title="No hay reservas para mostrar" detail="Las reservas registradas desde el formulario aparecerán aquí." />;
  return <div className="table-scroll"><table><thead><tr>
    <th>Reserva</th><th>Visita</th>{!brief && <th>Total</th>}<th>Saldo</th><th>Estado</th><th aria-label="Abrir" />
  </tr></thead><tbody>{orders.map(order => <tr key={order.id}>
    <td><button className="table-link" onClick={() => open(order.id)}>{order.payer}<small>{order.ref} · {order.guests} {order.guests === 1 ? 'persona' : 'personas'}</small></button></td>
    <td className="nowrap">{visitText(order.visitAt)}</td>
    {!brief && <td className="nowrap">{money(order.total)}</td>}
    <td className="nowrap amount">{money(terminal(order) && order.stage !== 'closed' ? 0 : balance(order))}</td>
    <td>{order.stage === 'confirmed' && order.attendance?.state === 'pending'
      ? <span className="badge awaiting_deposit"><i />Por verificar</span> : <Badge stage={order.stage} />}</td>
    <td><button className="icon-button" aria-label={'Abrir ' + order.ref} onClick={() => open(order.id)}><ArrowRight size={17} /></button></td>
  </tr>)}</tbody></table></div>;
}

export function Dashboard({ orders, go, open }) {
  const pay = useMemo(() => movements(orders), [orders]);
  const today = limaDay();
  const openOrders = orders.filter(o => !terminal(o));
  const pending = openOrders.filter(o => o.stage === 'awaiting_deposit');
  const visits = orders.filter(o => limaDay(o.visitAt) === today && ['confirmed', 'arrived', 'paid', 'closed'].includes(o.stage));
  const issues = orders.flatMap(order => order.incidents.filter(i => !i.resolvedAt).map(issue => ({ order, issue })));
  return <>
    <section className="hero">
      <div><span className="hero-kicker"><i /> FASE PAYERS</span>
        <h1>Control de cobranza</h1><p>Del anticipo por WhatsApp al pago en el local.<br className="wide" /> Gestiona cada reserva desde un solo lugar.</p>
        <button className="button cream" onClick={() => go('registro')}>Registrar pedido <ArrowRight size={17} /></button>
      </div>
      <svg className="hero-mark" aria-hidden="true" viewBox="0 0 300 280" fill="none">
        <circle cx="150" cy="140" r="128" /><circle cx="150" cy="140" r="106" /><circle cx="150" cy="140" r="83" />
        <path d="M147 61c4 35 47 47 47 89a44 44 0 0 1-88 0c0-22 10-36 25-51-4 20 1 29 8 34 12-15 18-41 8-72Z" />
        <path d="M153 133c-1 16 17 22 17 38a21 21 0 1 1-42 0c0-12 15-26 25-38Z" />
        <path d="M20 140h49m162 0h49M150 13v36m0 182v36" />
      </svg>
    </section>
    <div className="metrics">
      <Metric title="Cobranza neta hoy" value={money(net(pay.filter(p => limaDay(p.at) === today)))} detail="Cobros menos devoluciones" icon={Wallet} />
      <Metric title="Anticipos pendientes" value={pending.length} detail={money(pending.reduce((s, o) => s + depositDue(o), 0)) + ' por cobrar'} icon={Clock3} tone="gold" />
      <Metric title="Visitas confirmadas hoy" value={visits.length} detail={visits.reduce((s, o) => s + o.guests, 0) + ' personas reservadas'} icon={CalendarDays} tone="green" />
      <Metric title="Cobranzas cerradas" value={orders.filter(o => o.stage === 'closed').length} detail="Con comprobante emitido" icon={CircleCheck} tone="green" />
    </div>
    <div className="dashboard-grid">
      <section className="panel"><div className="panel-head"><div><h2>Movimiento de cobranza</h2><p>Importes netos por fecha de pago</p></div><span className="label-chip">Últimos 7 días</span></div><Trend list={pay} /></section>
      <section className="panel"><div className="panel-head"><div><h2>Atención prioritaria</h2><p>Incidencias abiertas</p></div><span className="label-chip">{issues.length}</span></div>
        {issues.length ? <div className="issue-preview">{issues.slice(0, 3).map(({ order, issue }) => <button key={issue.id} onClick={() => open(order.id)}><TriangleAlert size={16} /><span><strong>{issue.type}</strong><small>{order.ref} · {order.payer}</small></span><ArrowRight size={14} /></button>)}</div>
          : <Empty icon={CircleCheck} title="Todo al día" detail="Aquí aparecerán pagos por revisar, solicitudes y otros casos que requieran atención." />}
      </section>
    </div>
    <section className="panel"><div className="panel-head"><div><h2>Reservas recientes</h2><p>Pedidos registrados para la fase PAYERS</p></div><button className="text-button" onClick={() => go('reservas')}>Ver todas <ArrowRight size={15} /></button></div>
      <OrdersTable orders={orders.slice(0, 5)} open={open} brief />
    </section>
  </>;
}

export function Reports({ orders }) {
  const [period, setPeriod] = useState(7);
  const from = relativeDay(1 - period), today = limaDay();
  const within = (value) => value && limaDay(value) >= from && limaDay(value) <= today;
  const list = movements(orders).filter(p => within(p.at));
  const closed = orders.filter(o => within(o.closedAt));
  const gross = list.filter(p => p.amount > 0), refunds = list.filter(p => p.amount < 0);
  const cohort = orders.filter(o => o.confirmedAt && within(o.visitAt) && +new Date(o.visitAt) <= Date.now()
    && (o.attendance || o.stage === 'no_show'));
  const attendance = cohort.length ? Math.round(100 * cohort.filter(o => o.attendance).length / cohort.length) + ' %' : '—';
  const dueOrders = orders.filter(o => {
    const due = o.initialDeadline || o.deadline;
    const cancellation = o.events.find(e => e.title === 'Reserva cancelada');
    return within(due) && +new Date(due) <= Date.now() && !(cancellation && cancellation.at < due);
  });
  const onTime = dueOrders.filter(o => {
    const due = o.initialDeadline || o.deadline;
    return net(o.payments.filter(p => p.purpose === 'deposit' && p.at <= due)) >= o.deposit;
  }).length;
  const durations = closed.filter(o => o.attendance).map(o => (+new Date(o.closedAt) - +new Date(o.attendance.at)) / 60000).sort((a, b) => a - b);
  const p90 = durations.length ? durations[Math.ceil(durations.length * .9) - 1] : null;
  const byChannel = Object.entries(paymentLabels).map(([channel, label]) => ({
    label, items: list.filter(p => p.channel === channel),
  })).filter(row => row.items.length);
  function exportReport() {
    downloadCsv('cobranza-establo-' + today, [['Reserva', 'Fecha de pago', 'Finalidad', 'Medio', 'Referencia', 'Importe PEN'],
      ...list.map(p => [p.order.ref, p.at, p.purpose === 'deposit' ? 'Anticipo' : 'Saldo', paymentLabels[p.channel], p.ref, p.amount / 100])]);
  }
  return <>
    <div className="page-head"><div><span className="eyebrow">INTELIGENCIA DE NEGOCIOS</span><h1>Reportes de cobranza</h1><p>Conciliación, cierres y asistencia de la fase PAYERS.</p></div>
      <div className="button-row"><select aria-label="Período del reporte" value={period} onChange={e => setPeriod(Number(e.target.value))}><option value={7}>Últimos 7 días</option><option value={30}>Últimos 30 días</option></select>
        <button className="button primary" onClick={exportReport}><ArrowDownToLine size={17} /> Exportar CSV</button></div></div>
    <div className="metrics">
      <Metric title="Cobros confirmados" value={money(net(gross))} detail={gross.length + ' transacciones'} icon={CircleDollarSign} />
      <Metric title="Cobranza neta" value={money(net(list))} detail={money(-net(refunds)) + ' en devoluciones y reversos'} icon={Wallet} tone="gold" />
      <Metric title="Pedidos cerrados" value={closed.length} detail={money(closed.reduce((sum, o) => sum + o.total, 0)) + ' de valor acordado'} icon={ReceiptText} tone="green" />
      <Metric title="Asistencia verificada" value={attendance} detail={cohort.length + ' visitas con resultado registrado'} icon={Activity} tone="green" />
    </div>
    <section className="panel"><div className="panel-head"><div><h2>Movimiento del período</h2><p>Anticipos, saldos y ajustes confirmados</p></div><span className="label-chip">Hora de Lima</span></div><Trend list={list} days={period} /></section>
    <section className="panel"><div className="panel-head"><div><h2>Conciliación por medio</h2><p>Cobros y devoluciones por canal</p></div></div>
      {!byChannel.length ? <Empty icon={Wallet} title="Todavía no hay movimientos" detail="Verifica un anticipo o registra un saldo en caja para generar el reporte." /> :
        <div className="table-scroll"><table><thead><tr><th>Medio</th><th>Movimientos</th><th>Cobros</th><th>Devoluciones</th><th>Neto</th></tr></thead>
          <tbody>{byChannel.map(row => <tr key={row.label}><td>{row.label}</td><td>{row.items.length}</td><td>{money(net(row.items.filter(p => p.amount > 0)))}</td>
            <td>{money(-net(row.items.filter(p => p.amount < 0)))}</td><td className="amount">{money(net(row.items))}</td></tr>)}</tbody></table></div>}
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Desempeño del período</h2><p>Seguimiento de plazos y cierre presencial</p></div></div>
      <div className="report-notes">
        <div><strong>{dueOrders.length ? Math.round(onTime / dueOrders.length * 100) + ' %' : '—'} de anticipos a tiempo</strong>
          <span>{onTime} de {dueOrders.length} reservas con plazo original vencido en el período.</span></div>
        <div><strong>{p90 === null ? '—' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 }).format(p90) + ' min'} en el percentil 90</strong>
          <span>Tiempo entre llegada y cierre de {durations.length} reservas.</span></div>
        <div><strong>{closed.reduce((sum, o) => sum + (o.attendance?.count || 0), 0)} comensales</strong><span>Personas que asistieron en las reservas cerradas del período.</span></div>
      </div>
    </section>
    <section className="panel"><div className="panel-head"><div><h2>Seguimiento operativo</h2><p>Situación actual de todas las reservas</p></div></div>
      <div className="report-notes">
        <div><strong>{orders.filter(o => !terminal(o) && depositDue(o) > 0 && +new Date(o.deadline) < Date.now()).length} anticipos vencidos</strong><span>Revisar el pago y la disponibilidad antes de confirmar.</span></div>
        <div><strong>{orders.filter(o => o.stage === 'arrived' && balance(o) > 0).length} saldos en caja</strong><span>Atender las reservas con llegada registrada.</span></div>
        <div><strong>{orders.filter(o => o.stage === 'paid').length} comprobantes pendientes</strong><span>Emitir el documento para cerrar la cobranza.</span></div>
      </div>
    </section>
  </>;
}
