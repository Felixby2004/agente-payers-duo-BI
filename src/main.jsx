import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowRight, CalendarDays, CheckCircle2, ChevronRight, ClipboardPlus, Database, ExternalLink, Flame, LayoutDashboard, LogOut, MessageCircle, PanelTop, Printer, ReceiptText, RefreshCw, Settings2, ShieldCheck, Wallet, X } from 'lucide-react';
import { Dashboard, Reports } from './Dashboard.jsx';
import { Detail, Register, Reservations } from './Operations.jsx';
import { api } from './client.mjs';
import { AgentSettings } from './AgentSettings.jsx';
import { money, paymentLabels, visitText } from '../shared/orders.mjs';
import './styles.css';

const nav = [
  { key: 'inicio', label: 'Resumen', icon: LayoutDashboard },
  { key: 'reservas', label: 'Reservas', icon: CalendarDays },
  { key: 'registro', label: 'Registrar pedido', icon: ClipboardPlus },
  { key: 'reportes', label: 'Reportes', icon: ReceiptText },
  { key: 'conexiones', label: 'Conexiones', icon: Settings2 },
];
const current = () => nav.some(n => n.key === location.hash.slice(1)) ? location.hash.slice(1) : 'inicio';

function Brand() {
  return <div className="brand"><img src="/establo.svg" alt="" width="41" height="41" /><div><strong>El Establo</strong><span>PARRILLADAS</span></div></div>;
}
function Config({ config, onSettings }) {
  const items = [
    { name: 'Base de datos', state: config.database, icon: Database, body: config.database === 'Supabase'
      ? 'Las reservas y sus movimientos se guardan en el proyecto PostgreSQL de Supabase.'
      : 'Las reservas se guardan en PostgreSQL local. Configura el proyecto Supabase para compartir el registro.' },
    { name: 'Anticipo virtual', state: config.paymentMode === 'mercado_pago' ? 'Mercado Pago de prueba' : 'Simulación local', icon: Wallet,
      body: config.paymentMode === 'mercado_pago' ? 'Los enlaces se generan con el vendedor de prueba. Usa el comprador y los medios de pago de prueba.' : 'Usa el checkout local para ensayar aprobaciones y rechazos. Los movimientos se registran como simulados.' },
    { name: 'WhatsApp Cloud API', state: config.whatsapp === 'cloud' ? 'Configurado' : 'Pendiente', icon: MessageCircle,
      body: config.whatsapp === 'cloud' ? 'Escribe desde un número autorizado al número empresarial. Prueba con «anticipo EST-…» después de registrar un pedido.' : 'Conecta una aplicación de Meta, el número empresarial, el webhook y los números de prueba autorizados.' },
  ];
  return <>
    <div className="page-head"><div><span className="eyebrow">CONFIGURACIÓN</span><h1>Conexiones</h1><p>Entorno y servicios del agente de cobranza.</p></div></div>
    <div className="connection-grid">{items.map(({ name, state, body, icon: Icon }) => <section className="panel connection" key={name}>
      <span className="metric-icon wine"><Icon size={21} /></span><h2>{name}</h2><span className="label-chip">{state}</span><p>{body}</p>
    </section>)}</div>
    <section className="panel"><div className="panel-head"><div><h2>Reglas vigentes</h2><p>Parámetros de esta instancia de demostración</p></div><ShieldCheck size={23} /></div>
      <div className="report-notes"><div><strong>{money(config.depositPerPerson)} por persona</strong><span>Anticipo de cada reserva</span></div>
        <div><strong>{config.deadlineMinutes} minutos</strong><span>Plazo máximo para completar el anticipo</span></div>
        <div><strong>{config.graceMinutes} minutos</strong><span>Tolerancia para registrar inasistencia</span></div></div>
      <div className="config-footer">Recordatorios automáticos: <strong>{config.reminders ? 'activos' : 'desactivados'}</strong></div>
    </section>
    <AgentSettings config={config} onSave={onSettings} />
  </>;
}

function Login({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div className="public-shell"><section className="public-card login">
    <Brand /><span className="eyebrow">OPERACIONES PAYERS</span><h1>Acceso al panel</h1><p>Ingresa la contraseña de administración.</p>
    <form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try { await api('login', { password }); await onSuccess(); }
      catch (e) { setError(e.message); } finally { setBusy(false); }
    }}><label>Contraseña<input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="button primary full" disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar'} <ArrowRight size={17} /></button></form>
  </section></div>;
}

function PublicPage({ type, token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [returnPaymentId, setReturnPaymentId] = useState(() => {
    if (type !== 'payment') return '';
    const query = new URLSearchParams(location.search);
    const value = query.get('payment_id') || query.get('collection_id') || '';
    return /^\d{1,30}$/.test(value) ? value : '';
  });
  const path = type + '/' + token;
  const refresh = useCallback(async () => {
    const paymentId = returnPaymentId;
    if (paymentId) {
      // Process Mercado Pago's return parameters once; the 4.5s status polling
      // must use the clean URL and must not replay a rejected reconciliation.
      setReturnPaymentId('');
      history.replaceState(null, '', location.pathname);
    }
    try {
      const query = paymentId ? '?payment_id=' + encodeURIComponent(paymentId) : '';
      setData(await api(path + query)); setError('');
    }
    catch (e) { setError(e.message); }
  }, [path, returnPaymentId]);
  useEffect(() => {
    refresh();
    if (type === 'payment') {
      const id = setInterval(refresh, 4500);
      return () => clearInterval(id);
    }
  }, [refresh, type]);
  async function simulate(outcome) {
    setBusy(true);
    try { await api(path, { outcome }); await refresh(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="public-shell"><main className="public-card">
    <Brand />
    <div className="public-head"><span className="eyebrow">DEMOSTRACIÓN · {data?.ref || 'PAYERS'}</span><h1>{type === 'payment' ? 'Anticipo de reserva' : 'Constancia de pago'}</h1></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!data && !error && <p role="status">Consultando el estado…</p>}
    {data && type === 'payment' && <>
      <div className="public-amount"><small>{data.purpose === 'balance' ? 'IMPORTE DEL SALDO' : 'IMPORTE DEL ANTICIPO'}</small><strong>{money(data.amount)}</strong></div>
      {data.status === 'approved' && data.requiresReview ? <div className="inline-note">Mercado Pago verificó el pago, pero PAYERS lo dejó pendiente de revisión. El restaurante confirmará los siguientes pasos.</div>
        : data.status === 'approved' ? <div className="closed-note"><CheckCircle2 size={21} /><span><strong>{data.purpose === 'balance' ? 'Saldo verificado' : 'Anticipo verificado'}</strong><small>La operación de prueba se registró en PAYERS.</small></span></div>
        : data.status === 'rejected' ? <p className="error">El pago de prueba fue rechazado. Solicita un nuevo enlace.</p>
        : data.status === 'refunded' || data.status === 'charged_back' ? <p className="inline-note">La operación fue revertida. Consulta a caja.</p>
        : !data.usable ? <p className="inline-note">Este enlace está vencido o la reserva cambió. Consulta al restaurante.</p>
        : data.mode === 'local' ? <>
          <p>{data.method === 'plin' ? 'Plin simulado' : data.method === 'yape' ? 'Yape simulado' : 'Tarjeta de demostración'}. Elige el resultado para ensayar la confirmación del anticipo.</p>
          <div className="button-row"><button className="button primary" disabled={busy} onClick={() => simulate('approved')}>Aprobar pago de prueba</button>
            <button className="button outline" disabled={busy} onClick={() => simulate('rejected')}>Simular rechazo</button></div>
        </> : <>
          <p>Usa el comprador y una tarjeta de prueba de Mercado Pago. La página se actualiza cuando se verifica el pago.</p>
          {data.checkoutUrl ? <a className="button primary full" href={data.checkoutUrl} rel="noreferrer">Ir a Mercado Pago <ExternalLink size={17} /></a>
            : <p className="inline-note">El restaurante está preparando el enlace de pago.</p>}
        </>}
    </>}
    {data && type === 'receipt' && <>
      <div className="receipt-type">Constancia interna · {data.purpose === 'deposit' ? 'Anticipo de reserva' : data.purpose === 'balance' ? 'Pago de saldo' : 'Liquidación de pedido'} · {data.number}</div>
      {data.reversedAt && <p className="error">Esta constancia corresponde a una liquidación revertida y ya no representa el saldo actual.</p>}
      <dl className="public-receipt"><div><dt>Pagador</dt><dd>{data.payer}</dd></div><div><dt>Fecha de emisión</dt><dd>{visitText(data.at)}</dd></div>
        {data.purpose !== 'settlement' && <div><dt>Importe {data.purpose === 'deposit' ? 'del anticipo' : 'del saldo'}</dt><dd>{money(data.amount)}</dd></div>}
        {data.purpose === 'settlement' && <>
          {(data.payments || []).filter(item => item.amount > 0).map((item, index) => <div key={index}><dt>{item.purpose === 'deposit' ? 'Anticipo' : 'Saldo'} · {paymentLabels[item.channel] || item.channel} · {visitText(item.at)}</dt><dd>{money(item.amount)}</dd></div>)}
          <div><dt>Total</dt><dd>{money(data.total)}</dd></div></>}</dl>
      <p className="inline-note">Constancia de demostración. Sin validez tributaria.</p>
      <div className="button-row">
        {(data.mercadoPagoReceipts || (data.mercadoPagoReceiptUrl ? [{ url: data.mercadoPagoReceiptUrl, purpose: data.purpose, paymentId: data.mercadoPagoOperationId }] : [])).map(item => <a key={item.paymentId || item.url} className="button outline print-hide" href={item.url} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={17} /> Ver comprobante Mercado Pago · {item.purpose === 'balance' ? 'Saldo' : 'Anticipo'} {item.paymentId ? '#' + item.paymentId : ''}</a>)}
        <button className="button primary print-hide" onClick={() => window.print()}><Printer size={17} /> Imprimir constancia interna</button>
      </div>
      {Boolean(data.mercadoPagoReceipts?.length || data.mercadoPagoReceiptUrl) && <p className="receipt-help">Mercado Pago puede pedirte iniciar sesión con la cuenta compradora que hizo cada pago.</p>}
    </>}
    {type === 'payment' && <button className="text-button refresh" onClick={refresh}><RefreshCw size={15} /> Actualizar estado</button>}
  </main></div>;
}

function App() {
  const [page, setPage] = useState(current);
  const [config, setConfig] = useState(null);
  const [orders, setOrders] = useState([]);
  const [orderId, setOrderId] = useState(null);
  const [locked, setLocked] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const notify = useCallback(text => setToast({ text, at: Date.now() }), []);
  const go = (value) => { setPage(value); location.hash = value; window.scrollTo(0, 0); };
  const reload = useCallback(async () => {
    try { setOrders(await api('orders')); setLoadError(''); }
    catch (e) { if (e.status === 401) setLocked(true); else setLoadError(e.message); }
  }, []);
  const load = useCallback(async () => {
    try {
      const session = await api('session');
      if (!session.authenticated) { setLocked(true); setLoadError(''); return; }
      const [cfg, list] = await Promise.all([api('config'), api('orders')]);
      setConfig(cfg); setOrders(list); setLocked(false); setLoadError('');
    } catch (e) { setLoadError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onHash = () => setPage(current());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (!config || locked) return;
    const refresh = () => { if (!document.hidden) reload(); };
    const timer = setInterval(refresh, 6500);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [config, locked, reload]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4600);
    return () => clearTimeout(timer);
  }, [toast]);
  if (locked) return <Login onSuccess={load} />;
  if (!config) return <div className="public-shell"><div className="public-card"><Brand /><h1>El Establo</h1>
    {loadError ? <><p role="alert" className="error">{loadError}</p><button className="button primary" onClick={load}>Reintentar</button></> : <p role="status">Cargando el panel…</p>}</div></div>;
  const opened = orders.find(o => o.id === orderId);
  return <div className="shell">
    <aside className="sidebar">
      <button className="brand-button" onClick={() => go('inicio')}><Brand /></button>
      <span className="nav-label">ESPACIO DE TRABAJO</span>
      <nav aria-label="Principal">{nav.map(({ key, label, icon: Icon }) => <button className={page === key ? 'nav-item active' : 'nav-item'}
        key={key} aria-current={page === key ? 'page' : undefined} onClick={() => go(key)}><Icon size={18} /><span>{label}</span>{page === key && <ChevronRight className="nav-arrow" size={15} />}</button>)}</nav>
      <div className="sidebar-foot"><div><i />{config.database}</div><small>Parrilladas El Establo</small></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><div className="crumb"><PanelTop size={16} /><span>Operaciones</span><ChevronRight size={13} /><strong>{nav.find(n => n.key === page).label}</strong></div>
        <div className="top-actions"><span className="demo"><i /> Demostración</span><button className="icon-button" aria-label="Actualizar datos" disabled={refreshing} onClick={async () => {
          setRefreshing(true); await reload(); setRefreshing(false);
        }}><RefreshCw size={17} /></button>
          {config.protected ? <button className="icon-button" aria-label="Cerrar sesión" onClick={async () => {
            try { await api('logout', {}); setLocked(true); setConfig(null); setOrders([]); setOrderId(null); }
            catch (e) { setLoadError(e.message); }
          }}><LogOut size={18} /></button> : <span className="avatar" title="Administración">AD</span>}</div>
      </header>
      <main className="content">
        {loadError && <p className="error" role="alert">{loadError}</p>}
        {page === 'inicio' && <Dashboard orders={orders} go={go} open={setOrderId} />}
        {page === 'registro' && <Register config={config} notify={notify} created={order => { setOrders(list => [order, ...list.filter(o => o.id !== order.id)]); go('reservas'); setOrderId(order.id); }} />}
        {page === 'reservas' && <Reservations orders={orders} open={setOrderId} go={go} />}
        {page === 'reportes' && <Reports orders={orders} />}
        {page === 'conexiones' && <Config config={config} onSettings={next => {
          setConfig(current => ({ ...current, ...next })); notify('Configuración guardada. El agente usará los nuevos valores.');
        }} />}
        <footer className="workspace-footer"><Flame size={14} /> Parrilladas El Establo <span>Gestión de cobranza · PAYERS</span></footer>
      </main>
    </div>
    {opened && <Detail key={opened.id} order={opened} config={config} close={() => setOrderId(null)} reload={reload} notify={notify} />}
    {toast && <div className="toast" role="status"><CheckCircle2 size={19} />{toast.text}<button className="icon-button" aria-label="Cerrar aviso" onClick={() => setToast(null)}><X size={16} /></button></div>}
  </div>;
}
const parts = location.pathname.split('/');
const publicType = parts[1] === 'pago' ? 'payment' : parts[1] === 'comprobante' ? 'receipt' : '';
createRoot(document.getElementById('root')).render(<StrictMode>
  {publicType ? <PublicPage type={publicType} token={encodeURIComponent(parts[2] || '')} /> : <App />}
</StrictMode>);
