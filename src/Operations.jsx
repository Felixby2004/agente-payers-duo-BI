import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronLeft, ChevronRight, ClipboardList, Clock3, Copy, ExternalLink, FileCheck2, Link2, MessageCircle, Plus, ReceiptText, Search, Trash2, TriangleAlert, Users, X } from 'lucide-react';
import { balance, deposited, depositDue, money, paid, paymentLabels, stageLabels, visitText } from '../shared/orders.mjs';
import { menu, samples } from '../shared/samples.mjs';
import { api, downloadCsv, fromLima, localDateInput } from './client.mjs';
import { Badge, Empty, OrdersTable } from './Dashboard.jsx';

const blank = () => ({ payer: '', phone: '', guests: 1, visit: localDateInput(), notes: '', items: [], consent: false, agreed: false, synthetic: false });
const buttonLink = (href) => new URL(href, location.origin).href;
const normalize = (v) => v.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
const reservationTemplate = (form) => {
  const [date = '', time = ''] = String(form.visit || '').split('T');
  const phone = String(form.phone || '').replace(/\D/g, '');
  const items = form.items.length
    ? form.items.map(item => (Number(item.quantity) || 1) + 'x ' + (item.name || 'Producto')).join(', ')
    : '1x Parrilla familiar';
  return [
    'RESERVA',
    'Nombre: ' + (form.payer || 'Nombre y apellidos'),
    phone ? 'Telefono: ' + phone : null,
    'Fecha: ' + (date || 'AAAA-MM-DD'),
    'Hora: ' + ((time || '20:00').slice(0, 5)),
    'Personas: ' + (form.guests || 1),
    'Items: ' + items,
    form.notes ? 'Notas: ' + form.notes : null,
    'Consentimiento: ' + (form.consent ? 'si' : 'no'),
  ].filter(Boolean).join('\n');
};

export function Register({ config, created, notify }) {
  const [form, setForm] = useState(blank);
  const [sample, setSample] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [product, setProduct] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const results = samples.filter(x => normalize(x.payer + ' ' + x.notes).includes(normalize(query)));
  const set = (name, value) => setForm(current => ({ ...current, [name]: value }));
  const total = form.items.reduce((sum, i) => sum + i.quantity * i.price, 0);
  const deposit = form.guests * config.depositPerPerson;
  function changeItem(index, field, value) {
    setForm(current => ({ ...current, items: current.items.map((item, j) => index === j ? { ...item, [field]: value } : item) }));
  }
  async function register(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!form.agreed || form.items.length === 0) {
      setError('Agrega productos y confirma que el pedido ya fue acordado.');
      return;
    }
    setBusy(true);
    try {
      const order = await api('orders', { ...form, visitAt: fromLima(form.visit) });
      notify(order.ref + ' registrada en PAYERS.');
      created(order);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function copyTemplate() {
    setError('');
    try {
      await navigator.clipboard.writeText(reservationTemplate(form));
      notify('Plantilla de reserva copiada.');
    } catch { setError('No se pudo copiar la plantilla. Revisa los permisos del navegador.'); }
  }
  return <>
    <div className="page-head"><div><span className="eyebrow">ENTRADA DESDE LEADS</span><h1>Registrar pedido</h1><p>Entrega a cobranza un pedido acordado para atención en el local.</p></div>
      <button className="button outline" onClick={() => setSample(v => !v)}><ClipboardList size={17} /> {sample ? 'Ocultar ejemplos' : 'Ver 100 casos de ejemplo'}</button></div>
    {sample && <section className="panel sample-panel">
      <div className="panel-head"><div><h2>Casos de demostración</h2><p>Selecciona un caso ficticio para completar el formulario. Los casos se guardan al registrar el pedido.</p></div>
        <label className="search"><Search size={17} /><input aria-label="Buscar caso" value={query} placeholder="Buscar por nombre o caso" onChange={e => { setQuery(e.target.value); setPage(0); }} /></label></div>
      <div className="sample-grid">{results.slice(page * 8, page * 8 + 8).map(item => <button key={item.key} className="sample-card" onClick={() => {
        setForm({ ...blank(), ...item, items: item.items.map(i => ({ ...i })) });
        setSample(false); setError(''); notify('Formulario completado con el caso ' + item.key + '.');
      }}><small>CASO {String(item.key).padStart(3, '0')}</small><strong>{item.payer}</strong><span>{item.guests} pers. · {money(item.items.reduce((sum, i) => sum + i.price * i.quantity, 0))}</span></button>)}</div>
      {!results.length && <Empty icon={Search} title="Sin coincidencias" detail="Prueba con otro nombre o número de caso." />}
      <div className="pager"><button className="icon-button" disabled={page === 0} aria-label="Página anterior" onClick={() => setPage(p => p - 1)}><ChevronLeft size={17} /></button>
        <small>{Math.min(page * 8 + 1, results.length)}–{Math.min((page + 1) * 8, results.length)} de {results.length}</small>
        <button className="icon-button" disabled={(page + 1) * 8 >= results.length} aria-label="Página siguiente" onClick={() => setPage(p => p + 1)}><ChevronRight size={17} /></button></div>
    </section>}
    <form className="register-grid" onSubmit={register}>
      <div>
        <section className="panel form-panel"><div className="panel-head"><div><h2>Pagador y visita</h2><p>Una persona será responsable del anticipo y del saldo.</p></div></div>
          <div className="form-grid">
            <label>Nombre del pagador<input required minLength={2} maxLength={100} value={form.payer} onChange={e => set('payer', e.target.value)} placeholder="Nombre y apellidos" /></label>
            <label>Número de WhatsApp<input required={!form.synthetic} type="tel" maxLength={22} value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+51 9XX XXX XXX" /></label>
            <label>Personas reservadas<input required type="number" min="1" max="40" value={form.guests} onChange={e => set('guests', e.target.value === '' ? '' : Number(e.target.value))} /></label>
            <label>Fecha y hora de visita <small>Hora de Lima</small><input required type="datetime-local" value={form.visit} onChange={e => set('visit', e.target.value)} /></label>
            <label className="span-all">Observaciones<textarea rows="2" maxLength={500} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Acuerdos sobre la visita o el pedido" /></label>
            <label className="check span-all"><input type="checkbox" checked={form.consent} disabled={!form.phone} onChange={e => set('consent', e.target.checked)} /> El pagador autorizó el contacto por WhatsApp.</label>
          </div>
        </section>
        <section className="panel form-panel"><div className="panel-head"><div><h2>Detalle del pedido</h2><p>Usa los precios pactados con el cliente.</p></div></div>
          <div className="items-toolbar"><select aria-label="Producto de carta" value={product} onChange={e => setProduct(e.target.value)}>
            {menu.map((item, i) => <option key={item.name} value={i}>{item.name} · {money(item.price)}</option>)}
          </select><button type="button" className="button outline" onClick={() => set('items', [...form.items, { ...menu[Number(product)], quantity: 1 }])}><Plus size={16} /> Añadir</button>
          <button type="button" className="text-button" onClick={() => set('items', [...form.items, { name: '', price: 0, quantity: 1 }])}>Otro producto</button></div>
          {!form.items.length ? <Empty icon={ClipboardList} title="Agrega el primer producto" detail="Los importes se calcularán a partir de las líneas del pedido." /> :
            <div className="item-rows">{form.items.map((item, i) => <div className="item-row" key={i}>
              <label>Producto<input required value={item.name} onChange={e => changeItem(i, 'name', e.target.value)} /></label>
              <label>Cantidad<input aria-label={'Cantidad de línea ' + (i + 1)} required type="number" min="1" max="100" value={item.quantity} onChange={e => changeItem(i, 'quantity', e.target.value === '' ? '' : Number(e.target.value))} /></label>
              <label>Precio S/<input aria-label={'Precio de línea ' + (i + 1)} required type="number" min="0" max="10000" step="0.01" value={item.price === '' ? '' : item.price / 100} onChange={e => changeItem(i, 'price', e.target.value === '' ? '' : Math.round(Number(e.target.value) * 100))} /></label>
              <button type="button" className="icon-button" aria-label={'Quitar línea ' + (i + 1)} onClick={() => set('items', form.items.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
            </div>)}</div>}
        </section>
      </div>
      <section className="panel order-summary">
        <span className="eyebrow">RESUMEN DE COBRANZA</span><h2>Pedido acordado</h2>
        <dl><div><dt>Total del pedido</dt><dd>{money(total)}</dd></div>
          <div><dt>Anticipo virtual <small>{money(config.depositPerPerson)} × {form.guests || 0} {form.guests === 1 ? 'persona' : 'personas'}</small></dt><dd>{money(deposit)}</dd></div>
          <div className="summary-total"><dt>Saldo en el local</dt><dd>{money(Math.max(total - deposit, 0))}</dd></div></dl>
        {form.synthetic && <p className="inline-note">Caso ficticio. Agrega tu propio número autorizado para la prueba por WhatsApp.</p>}
        <label className="check"><input type="checkbox" checked={form.agreed} onChange={e => set('agreed', e.target.checked)} /> El pedido, el total y la visita ya fueron acordados.</label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="button outline full" onClick={copyTemplate}><Copy size={16} /> Copiar plantilla de reserva</button>
        <button type="submit" className="button primary full" disabled={busy}>{busy ? 'Registrando…' : 'Registrar en PAYERS'} <ArrowRight size={17} /></button>
      </section>
    </form>
  </>;
}

export function Reservations({ orders, open, go }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const matches = orders.filter(o => (!filter || o.stage === filter) && normalize(o.payer + ' ' + o.ref + ' ' + o.phone).includes(normalize(query)));
  return <>
    <div className="page-head"><div><span className="eyebrow">OPERACIONES</span><h1>Reservas</h1><p>Control de anticipos, visitas y saldos en el local.</p></div>
      <button className="button primary" onClick={() => go('registro')}><Plus size={17} /> Registrar pedido</button></div>
    <section className="panel">
      <div className="panel-head"><div><h2>Pedidos registrados</h2><p>{matches.length} {matches.length === 1 ? 'reserva' : 'reservas'}</p></div>
        <div className="button-row"><label className="search"><Search size={17} /><input aria-label="Buscar reserva" value={query} onChange={e => setQuery(e.target.value)} placeholder="Nombre o referencia" /></label>
          <select aria-label="Filtrar por estado" value={filter} onChange={e => setFilter(e.target.value)}><option value="">Todos los estados</option>
            {Object.entries(stageLabels).map(([stage, label]) => <option key={stage} value={stage}>{label}</option>)}</select></div></div>
      <OrdersTable orders={matches} open={open} />
    </section>
  </>;
}

export function Detail({ order, config, close, reload, notify }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState('gestión');
  const [count, setCount] = useState(order.guests);
  const [channel, setChannel] = useState('cash');
  const [date, setDate] = useState(localDateInput(order.visitAt));
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [paymentId, setPaymentId] = useState('');
  const [depositMethod, setDepositMethod] = useState('checkout');
  const box = useRef(null);
  useEffect(() => {
    const old = document.activeElement;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    box.current?.focus();
    const key = e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const items = Array.from(box.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled), textarea:not(:disabled)') || []);
        if (!items.length) return;
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = previous; document.removeEventListener('keydown', key); old?.focus(); };
  }, [order.id]);
  const activeLink = order.intents.filter(i => (i.method || 'checkout') === depositMethod && i.status === 'pending' && i.expiresAt === order.deadline
    && (i.mode === 'local' || i.checkoutUrl) && +new Date(i.expiresAt) > Date.now()).at(-1);
  const beforeVisit = ['awaiting_deposit', 'confirmed'].includes(order.stage);
  const pendingIssues = order.incidents.filter(i => !i.resolvedAt);
  const expired = +new Date(order.deadline) <= Date.now();
  async function run(kind, body = {}, message = 'Reserva actualizada.') {
    if (busy) return;
    setBusy(kind); setError('');
    try { await api('orders/' + order.id + '/' + kind, body); await reload(); notify(message); }
    catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }
  async function copyLink(intent) {
    try { await navigator.clipboard.writeText(buttonLink('/pago/' + intent.id)); notify('Enlace copiado.'); }
    catch { setError('Abre el enlace para copiar su dirección.'); }
  }
  function exportOrder() {
    const rows = [['Reserva', 'Pagador', 'Total PEN', 'Anticipo PEN', 'Pagado neto PEN', 'Saldo PEN', 'Reservados', 'Asistentes', 'Estado'],
      [order.ref, order.payer, order.total / 100, order.deposit / 100, paid(order) / 100, balance(order) / 100, order.guests, order.attendance?.count ?? '', stageLabels[order.stage]],
      [], ['Fecha', 'Evento', 'Detalle'], ...order.events.map(e => [e.at, e.title, e.detail])];
    downloadCsv(order.ref, rows);
  }
  return <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="order-title" tabIndex="-1" ref={box}>
      <div className="drawer-head"><div><span className="eyebrow">{order.ref}</span><h2 id="order-title">{order.payer}</h2><Badge stage={order.stage} /></div>
        <button className="icon-button" onClick={close} aria-label="Cerrar reserva"><X size={22} /></button></div>
      <div className="drawer-facts"><span><CalendarDays size={16} /> {visitText(order.visitAt)}</span><span><Users size={16} /> {order.guests} personas</span>
        {order.phone && <span><MessageCircle size={16} /> +{order.phone}</span>}</div>
      <div className="tabs" role="group" aria-label="Detalle de reserva">{['gestión', 'pedido', 'historial'].map(x => <button key={x} aria-pressed={tab === x} className={tab === x ? 'selected' : ''} onClick={() => setTab(x)}>{x}</button>)}</div>
      <div className="drawer-body">
        {error && <p className="error" role="alert">{error}</p>}
        {tab === 'gestión' && <>
          <div className="drawer-money"><div><small>Total acordado</small><strong>{money(order.total)}</strong></div>
            <div><small>Anticipo neto</small><strong>{money(deposited(order))}</strong></div><div><small>Saldo pendiente</small><strong>{money(balance(order))}</strong></div></div>
          {order.stage === 'awaiting_deposit' && <section className="action-panel">
            <h3><Link2 size={18} /> Anticipo virtual</h3><p>{money(depositDue(order))} pendiente · {expired ? 'Plazo vencido' : 'Pagar hasta ' + visitText(order.deadline)}</p>
            <label>Medio de anticipo<select value={depositMethod} onChange={e => setDepositMethod(e.target.value)}>
              <option value="checkout">{config.paymentMode === 'mercado_pago' ? 'Mercado Pago de prueba (tarjeta o Yape)' : 'Tarjeta de demostración'}</option>
              {config.yapeDemo && <option value="yape">Yape simulado</option>}
              {config.plinDemo && <option value="plin">Plin simulado</option>}
            </select></label>
            <div className="button-row">{activeLink ? <>
              <a className="button primary" href={'/pago/' + activeLink.id} target="_blank" rel="noreferrer">Abrir pago de prueba <ExternalLink size={15} /></a>
              <button className="button outline" onClick={() => copyLink(activeLink)}><Copy size={16} /> Copiar enlace</button></>
              : expired ? <button className="button outline" disabled={Boolean(busy) || depositDue(order) <= 0} onClick={() => {
                if (confirm('¿Confirmas que el cupo sigue disponible para renovar el plazo?')) run('renew', {}, 'Plazo renovado.');
              }}>Renovar plazo</button> : <button className="button primary" disabled={Boolean(busy) || depositDue(order) <= 0} onClick={() => run('link', { method: depositMethod }, 'Enlace de anticipo preparado.')}>Generar enlace</button>}
              {config.whatsapp === 'cloud' && <button className="button outline" disabled={Boolean(busy) || expired || depositDue(order) <= 0} onClick={() => run('message', { type: 'deposit', method: depositMethod }, 'WhatsApp aceptó el envío.')}><MessageCircle size={16} /> Enviar anticipo</button>}</div>
            {config.paymentMode === 'mercado_pago' && <div className="action-line"><input aria-label="Número de operación de Mercado Pago" value={paymentId} onChange={e => setPaymentId(e.target.value)} placeholder="N.º de operación" />
              <button className="button outline" disabled={Boolean(busy) || !paymentId} onClick={() => run('sync', { paymentId }, 'Consulta de pago completada.')}>Consultar pago</button></div>}
          </section>}
          {order.stage === 'confirmed' && <section className="action-panel"><h3><Users size={18} /> Recepción en el local</h3><p>Registra a las personas que llegaron al restaurante.</p>
            <div className="action-line"><label>Asistentes<input type="number" min="1" max={order.guests} value={count} onChange={e => setCount(e.target.value)} /></label>
              <button className="button primary" disabled={Boolean(busy)} onClick={() => run('arrive', { count }, 'Llegada verificada.')}>Confirmar llegada</button>
              {config.whatsapp === 'cloud' && <button className="button outline" disabled={Boolean(busy)} onClick={() => run('message', { type: 'visit' }, 'WhatsApp aceptó el recordatorio.')}>Recordar visita</button>}</div>
          </section>}
          {order.stage === 'arrived' && <section className="action-panel"><h3><ReceiptText size={18} /> Cobro en caja</h3><p>Registra el pago de demostración del saldo de {money(balance(order))}.</p>
            <div className="action-line"><select aria-label="Medio de pago en caja" value={channel} onChange={e => setChannel(e.target.value)}>
              <option value="cash">Efectivo de demostración</option><option value="pos">POS de demostración</option><option value="wallet">Billetera de demostración</option></select>
              <button className="button primary" disabled={Boolean(busy)} onClick={() => run('counter', { channel }, 'Saldo registrado en caja.')}>Confirmar cobro</button></div>
          </section>}
          {order.stage === 'paid' && <section className="action-panel"><h3><FileCheck2 size={18} /> Cierre de cobranza</h3><p>Se verificaron la llegada y el pago completo. Emite la constancia de demostración.</p>
            <button className="button primary" disabled={Boolean(busy)} onClick={() => run('receipt', {}, 'Comprobante emitido y cobranza cerrada.')}>Emitir y cerrar</button></section>}
          {order.stage === 'closed' && <div className="closed-note"><Check size={19} /><span><strong>Cobranza completada</strong><small>Asistencia verificada · saldo liquidado · comprobante emitido</small></span></div>}
          {order.receipts.length > 0 && <section className="action-panel"><h3><ReceiptText size={17} /> Comprobantes de demostración</h3>
            <div className="button-row">{order.receipts.map(receipt => <a className="button outline" key={receipt.token} href={'/comprobante/' + receipt.token} target="_blank" rel="noreferrer">
              {receipt.purpose === 'deposit' ? 'Anticipo' : 'Liquidación'} <ExternalLink size={14} /></a>)}
              {config.whatsapp === 'cloud' && <button className="button outline" disabled={Boolean(busy)} onClick={() => run('message', { type: 'receipt' }, 'WhatsApp aceptó el comprobante.')}>Enviar último</button>}</div>
          </section>}
          {pendingIssues.length > 0 && <section className="action-panel"><h3><TriangleAlert size={18} /> Incidencias abiertas</h3>
            <label>Nota de resolución<input value={note} maxLength={300} onChange={e => setNote(e.target.value)} placeholder="Resultado de la revisión" /></label>
            {pendingIssues.map(issue => <div className="issue-line" key={issue.id}><div><strong>{issue.type}</strong><small>{issue.detail}</small></div>
              <button className="button outline" disabled={Boolean(busy) || note.trim().length < 3} onClick={() => run('resolve', { id: issue.id, note }, 'Incidencia resuelta.')}>Resolver</button></div>)}</section>}
          {beforeVisit && <details className="action-panel"><summary>Reprogramar o cancelar</summary>
            <div className="action-line"><label>Nueva fecha y hora<input type="datetime-local" value={date} onChange={e => setDate(e.target.value)} /></label>
              <button className="button outline" disabled={Boolean(busy) || !date} onClick={() => run('reschedule', { visitAt: fromLima(date) }, 'Visita reprogramada.')}>Guardar cambio</button></div>
            <label>Motivo<input value={reason} onChange={e => setReason(e.target.value)} placeholder="Motivo de cancelación o inasistencia" /></label>
            <div className="button-row"><button className="button outline danger" disabled={Boolean(busy) || reason.trim().length < 3} onClick={() => run('cancel', { reason }, 'Reserva cancelada.')}>Cancelar reserva</button>
              {order.stage === 'confirmed' && +new Date(order.visitAt) + config.graceMinutes * 60000 <= Date.now()
                && <button className="button outline" disabled={Boolean(busy) || reason.trim().length < 3} onClick={() => run('no-show', { reason }, 'Inasistencia registrada.')}>Registrar inasistencia</button>}</div>
          </details>}
          {order.payments.filter(p => p.amount > 0 && p.purpose === 'deposit'
            && (['cancelled', 'no_show'].includes(order.stage) || pendingIssues.some(i => i.key === p.ref))
            && !order.payments.some(q => q.original === p.ref)).map(p => <section className="action-panel" key={p.ref}>
            <h3>Devolución del anticipo</h3><p>{money(p.amount)} · {paymentLabels[p.channel]}</p>
            <button className="button outline" disabled={Boolean(busy)} onClick={() => {
              if (confirm('¿Confirmas la devolución autorizada del anticipo de demostración?')) run('refund', { ref: p.ref }, 'Devolución procesada.');
            }}>Procesar devolución autorizada</button></section>)}
        </>}
        {tab === 'pedido' && <><section className="action-panel"><h3><ClipboardList size={18} /> Productos acordados</h3>
          <ul className="detail-list">{order.items.map((item, i) => <li key={i}><span>{item.quantity} × {item.name}</span><strong>{money(item.price * item.quantity)}</strong></li>)}</ul>
          {order.notes && <p>{order.notes}</p>}</section>
          <section className="action-panel"><h3><ReceiptText size={18} /> Movimientos verificados</h3>
            {!order.payments.length ? <p>Todavía no hay pagos confirmados.</p> : <ul className="detail-list">{order.payments.map(p => <li key={p.ref}>
              <span>{p.purpose === 'deposit' ? 'Anticipo' : 'Saldo'} <small>{paymentLabels[p.channel]}</small></span><strong>{money(p.amount)}</strong></li>)}</ul>}</section></>}
        {tab === 'historial' && <><section className="action-panel"><h3><Clock3 size={17} /> Historial de la reserva</h3>
          <ol className="timeline">{[...order.events].reverse().map(e => <li key={e.id}><strong>{e.title}</strong><small>{visitText(e.at)} · {e.actor}</small>{e.detail && <p>{e.detail}</p>}</li>)}</ol>
        </section>{order.chat.length > 0 && <section className="action-panel"><h3><MessageCircle size={17} /> WhatsApp</h3><ul className="chat-list">{order.chat.map(m => <li key={m.id}><small>{m.direction === 'in' ? 'Pagador' : 'Agente'} · {visitText(m.at)}{m.status ? ' · ' + ({ accepted: 'aceptado', sent: 'enviado', delivered: 'entregado', read: 'leído', failed: 'fallido' }[m.status]) : ''}</small><p>{m.text}</p>
          {m.mediaId && <a className="text-button" href={'/api/orders/' + order.id + '/media/' + encodeURIComponent(m.id)} target="_blank" rel="noreferrer">Abrir adjunto en WhatsApp <ExternalLink size={14} /></a>}</li>)}</ul></section>}</>}
      </div>
      <div className="drawer-footer"><button className="text-button" onClick={exportOrder}>Exportar ficha CSV <ArrowRight size={16} /></button>{busy && <small role="status">Procesando…</small>}</div>
    </aside>
  </div>;
}
