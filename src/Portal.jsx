import { useEffect, useState } from 'react';
import { ArrowLeft, Ban, CalendarDays, CheckCircle2, CircleDollarSign, Clock3, ExternalLink, FileCheck2, LogOut, ReceiptText, Users, Wallet, XCircle } from 'lucide-react';
import { api } from './client.mjs';
import { limaDay, money, stageLabels, visitText } from '../shared/orders.mjs';

const monthKey = value => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month;
};
const reservationStatus = stage => ({ awaiting_deposit: 'Anticipo pendiente', confirmed: 'Confirmada', arrived: 'Llegó',
  paid: 'Cobrada', closed: 'Finalizada', cancelled: 'Cancelada', no_show: 'No asistió' }[stage] || stageLabels[stage] || 'En revisión');
const reservationGroupOrder = ['awaiting_deposit', 'confirmed', 'arrived', 'paid', 'closed', 'cancelled', 'no_show'];
const reservationIcons = { awaiting_deposit: Clock3, confirmed: CalendarDays, arrived: Users, paid: CircleDollarSign,
  closed: CheckCircle2, cancelled: Ban, no_show: XCircle };
function ReservationIcon({ stage, size = 16 }) {
  const Icon = reservationIcons[stage] || CalendarDays;
  return <Icon size={size} aria-hidden="true" />;
}

export function CustomerPortal({ Brand }) {
  const [data, setData] = useState(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState('');
  const otpMessage = "Si tu número tiene una reserva, recibirás un código por WhatsApp. Si no llega, escribe 'hola' al WhatsApp de El Establo y vuelve a solicitarlo.";
  const load = async () => {
    try { setData(await api('customer/orders')); }
    catch (error) { if (error.status !== 401) setError(error.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      if (request) {
        await api('customer/verify', { id: request.id, code });
        await load();
      } else setRequest(await api('customer/otp', { phone }));
    } catch (error) {
      if (!request) setRequest({ message: otpMessage });
      else setError(error.message);
    }
    finally { setBusy(false); }
  }

  return <main className="public-shell"><section className={'public-card ' + (data ? 'customer-card' : 'login')}>
    <Brand />
    <div className={'public-head' + (data ? ' customer-heading' : '')}>
      <div><span className="eyebrow">PORTAL DEL CLIENTE</span><h1>{data ? 'Hola, ' + data.name : 'Verifica tu celular'}</h1></div>
      {data && <button className="button outline customer-logout" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={async () => {
        try { await api('logout', {}); setData(null); setRequest(null); setCode(''); setSelectedOrderId(null); }
        catch (error) { setError(error.message); }
      }}><LogOut size={16} /><span>Cerrar sesión</span></button>}
    </div>
    {loading && <p role="status">Cargando…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!loading && !data && <form onSubmit={submit}>
      {request ? <><p>{otpMessage}</p><label>Código de WhatsApp<input required inputMode="numeric" pattern="[0-9]{6}"
        autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value)} /></label></>
        : <label>Celular registrado<input type="tel" required autoComplete="tel" placeholder="+51 999 999 999"
          value={phone} onChange={event => setPhone(event.target.value)} /></label>}
      <button className="button primary full" disabled={busy}>{request ? 'Verificar código' : 'Enviar código por WhatsApp'}</button>
      {request && <button type="button" className="text-button" disabled={busy} onClick={async () => {
        setBusy(true); setError(''); setCode('');
        try { setRequest(await api('customer/otp', { phone })); }
        catch { setRequest({ message: otpMessage }); }
        finally { setBusy(false); }
      }}>Solicitar otro código</button>}
      <a className="text-button" href="/">Acceso de personal</a>
    </form>}
    {data && <>
      {data.menuUrl && <details className="action-panel"><summary>Ver la carta</summary><img className="customer-menu" src={data.menuUrl} alt="Carta de Parrilladas El Establo" loading="lazy" referrerPolicy="no-referrer" /></details>}
      <h2>Mis reservas</h2>
      {!data.orders.length && <p>Todavía no figuran reservas vinculadas con tu número.</p>}
      {data.orders.length > 0 && (() => {
        const sorted = [...data.orders].sort((a, b) => +new Date(b.visitAt) - +new Date(a.visitAt));
        const months = [...new Map(sorted.map(order => {
          const key = monthKey(order.visitAt);
          const label = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', month: 'long', year: 'numeric' }).format(new Date(order.visitAt));
          return [key, { key, label }];
        })).values()];
        const month = selectedMonth && months.some(item => item.key === selectedMonth) ? selectedMonth : months[0]?.key;
        const rows = sorted.filter(order => monthKey(order.visitAt) === month);
        const groups = reservationGroupOrder.map(stage => ({ stage, label: reservationStatus(stage),
          orders: rows.filter(order => order.stage === stage) })).filter(group => group.orders.length);
        const selected = sorted.find(order => order.id === selectedOrderId);
        return <>
          {!selected && <>
            <div className="button-row" aria-label="Filtrar reservas por mes">{months.map(item => <button key={item.key}
              className={'button ' + (month === item.key ? 'primary' : 'outline')} aria-pressed={month === item.key}
              onClick={() => setSelectedMonth(item.key)}>{item.label}</button>)}</div>
            {groups.map(group => <section className="reservation-group" key={group.stage}>
              <h3><ReservationIcon stage={group.stage} />{group.label} <span>{group.orders.length}</span></h3>
              <div className="reservation-picker">{group.orders.map(order => <button className="button outline" key={order.id}
                onClick={() => setSelectedOrderId(order.id)}><strong><CalendarDays size={15} />{visitText(order.visitAt)}</strong><span>{order.ref}</span>
                <small className={'reservation-status status-' + order.stage}><ReservationIcon stage={order.stage} size={13} />{reservationStatus(order.stage)}</small></button>)}</div>
            </section>)}
          </>}
          {selected && <section className="action-panel customer-order-detail">
            <button className="text-button customer-back" onClick={() => setSelectedOrderId(null)}><ArrowLeft size={16} /> Volver a mis reservas</button>
            <div className="customer-detail-heading">
              <span className="customer-detail-mark"><ReservationIcon stage={selected.stage} size={21} /></span>
              <div><small>DETALLE DE RESERVA</small><h3>{selected.ref}</h3></div>
              <span className={'reservation-status status-' + selected.stage}><ReservationIcon stage={selected.stage} size={14} />{reservationStatus(selected.stage)}</span>
            </div>
            <div className="customer-visit-summary"><span><CalendarDays size={16} />{visitText(selected.visitAt)}</span>
              <span><Users size={16} />{selected.guests} {selected.guests === 1 ? 'persona' : 'personas'}</span></div>
            {selected.attendance === 'pending' && <p className="inline-note customer-arrival-note"><Clock3 size={15} />Caja debe confirmar tu llegada.</p>}
            <h4 className="customer-section-title">Detalle del pedido</h4>
            <ul className="detail-list">{selected.items.map((item, index) => <li key={index}><span>{item.quantity} × {item.name}</span>
              <strong>{money(item.price * item.quantity - (item.discount || 0))}</strong></li>)}</ul>
            <div className="customer-order-totals"><div><small>Total</small><strong>{money(selected.total)}</strong></div>
              <div><small>Anticipo</small><strong><Wallet size={14} />{money(selected.deposit)}</strong></div>
              <div><small>Saldo</small><strong>{money(selected.balance)}</strong></div></div>
            {selected.receipts.length > 0 && <section className="customer-receipts">
              <h4><ReceiptText size={17} />Comprobantes</h4>
              {selected.receipts.map(receipt => {
                const kind = receipt.purpose === 'deposit' ? 'anticipo' : receipt.purpose === 'balance' ? 'saldo' : 'liquidación';
                return <div className="customer-receipt" key={receipt.token}>
                  <div><strong><FileCheck2 size={15} />{receipt.purpose === 'settlement' ? 'Liquidación de El Establo' : 'Constancia interna de ' + kind}</strong>
                    <small>{receipt.number || 'Documento de demostración'}{receipt.reversedAt ? ' · Revertida' : ''}</small></div>
                  <div className="button-row receipt-actions">
                    <a className="button outline" href={'/comprobante/' + receipt.token}><ReceiptText size={15} />Ver constancia interna</a>
                    {(receipt.mercadoPagoReceipts || []).map(item => <a className="button outline" key={item.paymentId}
                      href={item.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />Comprobante Mercado Pago · {item.purpose === 'balance' ? 'Saldo' : 'Anticipo'}</a>)}
                  </div>
                </div>;
              })}
            </section>}
          </section>}
        </>;
      })()}
    </>}
  </section></main>;
}

const blankStaff = { name: '', username: '', role: 'cashier', active: true, password: '' };

export function StaffAccounts() {
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState(blankStaff);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    try { setRows(await api('staff')); }
    catch (error) { setError(error.message); }
  }
  useEffect(() => { load(); }, []);
  const field = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  return <>
    <div className="page-head"><div><span className="eyebrow">ADMINISTRACIÓN</span><h1>Personal</h1><p>Cuentas individuales de administrador y cajero.</p></div></div>
    <section className="panel">
      {error && <p className="error" role="alert">{error}</p>}
      <h2>{draft.id ? 'Editar cuenta' : 'Crear cuenta'}</h2>
      <form className="staff-form" onSubmit={async event => {
        event.preventDefault(); setBusy(true); setError('');
        try { await api('staff', draft); setDraft(blankStaff); await load(); }
        catch (error) { setError(error.message); }
        finally { setBusy(false); }
      }}>
        <label>Nombre<input required minLength={2} maxLength={100} value={draft.name} onChange={event => field('name', event.target.value)} /></label>
        <label>Usuario<input required disabled={Boolean(draft.id)} minLength={3} maxLength={40} value={draft.username}
          onChange={event => field('username', event.target.value)} /></label>
        <label>Rol<select value={draft.role} onChange={event => field('role',event.target.value)}>
          <option value="cashier">Cajero</option><option value="admin">Administrador</option></select></label>
        <label>{draft.id ? 'Nueva contraseña (opcional)' : 'Contraseña'}<input type="password" required={!draft.id} minLength={12}
          autoComplete="new-password" value={draft.password} onChange={event => field('password', event.target.value)} /></label>
        {draft.id && <label className="check"><input type="checkbox" checked={draft.active} onChange={event => field('active',event.target.checked)} />Cuenta activa</label>}
        <div className="button-row"><button className="button primary" disabled={busy}>Guardar cuenta</button>
          {draft.id && <button type="button" className="button outline" onClick={() => setDraft(blankStaff)}>Cancelar edición</button>}</div>
      </form>
      {rows.map(row => <div className="issue-line" key={row.id}><div><strong>{row.name}</strong>
        <small>{row.username} · {row.role === 'admin' ? 'Administrador' : 'Cajero'} · {row.active ? 'Activo' : 'Inactivo'}</small></div>
        <button className="button outline" onClick={() => setDraft({ ...row, password: '' })}>Editar</button></div>)}
    </section>
  </>;
}

export function PdfReports() {
  const [measure, setMeasure] = useState('M5');
  const [from, setFrom] = useState(() => limaDay(new Date(Date.now() - 6 * 86400000)));
  const [to, setTo] = useState(limaDay);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <section className="panel"><h2>Descargar reporte PDF</h2>
    <form className="staff-form" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError('');
      try {
        const response = await fetch('/api/reports/pdf?' + new URLSearchParams({ measure, from, to }));
        if (!response.ok) throw new Error((await response.json()).error);
        const url = URL.createObjectURL(await response.blob());
        const link = Object.assign(document.createElement('a'), { href: url, download: 'PAYERS-' + measure + '-' + from + '.pdf' });
        link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { setError(error.message); }
      finally { setBusy(false); }
    }}>
      <label>Medida<select value={measure} onChange={event => setMeasure(event.target.value)}>
        <option value="M5">M5 · Ingresos de reservas liquidadas</option>
        <option value="M1">M1 · Anticipos confirmados</option>
        <option value="M3">M3 · Asistencia de titulares</option>
      </select></label>
      <label>Desde<input type="date" required value={from} onChange={event => setFrom(event.target.value)} /></label>
      <label>Hasta<input type="date" required value={to} onChange={event => setTo(event.target.value)} /></label>
      <button className="button primary" disabled={busy}>Descargar PDF</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

