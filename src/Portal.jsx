import { useEffect, useState } from 'react';
import { api } from './client.mjs';
import { limaDay, money, stageLabels, visitText } from '../shared/orders.mjs';

export function CustomerPortal({ Brand }) {
  const [data, setData] = useState(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }

  return <main className="public-shell"><section className={'public-card ' + (data ? 'customer-card' : 'login')}>
    <Brand />
    <div className="public-head"><span className="eyebrow">PORTAL DEL CLIENTE</span><h1>{data ? 'Hola, ' + data.name : 'Verifica tu celular'}</h1></div>
    {loading && <p role="status">Cargando…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {!loading && !data && <form onSubmit={submit}>
      {request ? <><p>{request.message}</p><label>Código de WhatsApp<input required inputMode="numeric" pattern="[0-9]{6}"
        autoComplete="one-time-code" maxLength={6} value={code} onChange={event => setCode(event.target.value)} /></label></>
        : <label>Celular registrado<input type="tel" required autoComplete="tel" placeholder="+51 999 999 999"
          value={phone} onChange={event => setPhone(event.target.value)} /></label>}
      <button className="button primary full" disabled={busy}>{request ? 'Verificar código' : 'Enviar código por WhatsApp'}</button>
      {request && <button type="button" className="text-button" disabled={busy} onClick={() => { setRequest(null); setCode(''); }}>Solicitar otro código</button>}
      <a className="text-button" href="/">Acceso de personal</a>
    </form>}
    {data && <>
      <div className="button-row"><button className="button outline" onClick={async () => {
        try { await api('logout', {}); setData(null); setRequest(null); setCode(''); } catch (error) { setError(error.message); }
      }}>Cerrar sesión</button></div>
      {data.menuUrl && <details className="action-panel"><summary>Ver la carta</summary><img className="customer-menu" src={data.menuUrl} alt="Carta de Parrilladas El Establo" loading="lazy" referrerPolicy="no-referrer" /></details>}
      <h2>Mis pedidos y reservas</h2>
      {!data.orders.length && <p>Todavía no figuran pedidos vinculados con tu número.</p>}
      {data.orders.map(order => <section className="action-panel" key={order.id}>
        <h3>{order.ref} · {stageLabels[order.stage]}</h3>
        <p>{visitText(order.visitAt)} · {order.guests} {order.guests === 1 ? 'persona' : 'personas'}</p>
        {order.attendance === 'pending' && <p className="inline-note">Caja debe confirmar tu llegada.</p>}
        <ul className="detail-list">{order.items.map((item, index) => <li key={index}><span>{item.quantity} × {item.name}</span>
          <strong>{money(item.price * item.quantity - (item.discount || 0))}</strong></li>)}</ul>
        <p>Total {money(order.total)} · Anticipo {money(order.deposit)} · Saldo {money(order.balance)}</p>
        <div className="button-row">{order.receipts.map(receipt => <a className="button outline" key={receipt.token}
          href={'/comprobante/' + receipt.token}>{receipt.purpose === 'deposit' ? 'Constancia de anticipo' : receipt.purpose === 'balance'
            ? 'Constancia de saldo' : 'Liquidación'}{receipt.reversedAt ? ' (revertida)' : ''}</a>)}</div>
      </section>)}
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

