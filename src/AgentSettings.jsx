import { useEffect, useState } from 'react';
import { Activity, MessageSquare, Save, Settings2, Trash2, CalendarDays } from 'lucide-react';
import { api } from './client.mjs';
import { visitText } from '../shared/orders.mjs';

const numbers = [
  ['deadlineMinutes', 'Vencimiento del anticipo (minutos)', 1, 43200],
  ['autoCancelExpiredHours', 'Cancelar reservas sin pago (horas después del vencimiento; 0 desactiva)', 0, 720],
  ['depositRenewalsMax', 'Renovaciones de plazo permitidas al cliente', 0, 10],
  ['renewDepositMinutes', 'Duración del nuevo plazo (minutos)', 1, 43200],
  ['depositLinkExpiryMinutes', 'Vigencia de cada enlace de anticipo (minutos)', 1, 43200],
  ['paymentRetryMinutes', 'Espera para volver a emitir un enlace (minutos)', 0, 1440],
  ['maxDepositLinks', 'Máximo de enlaces de anticipo por reserva', 1, 3],
  ['maxOpenReservationsPerPhone', 'Máximo de reservas abiertas por cliente (últimos 30 días)', 1, 100],
  ['depositReminderMinutes', 'Aviso de anticipo a los (minutos)', 1, 43200],
  ['firstVisitHours', 'Primer aviso antes de la visita (horas)', 1, 168],
  ['lastVisitHours', 'Segundo aviso antes de la visita (horas)', 1, 168],
  ['graceMinutes', 'Tolerancia de llegada (minutos)', 0, 1440],
  ['counterAlertMinutes', 'Aviso de saldo pendiente en caja (minutos)', 1, 1440],
  ['balanceLinkExpiryMinutes', 'Vencimiento del link de saldo (minutos)', 1, 1440],
  ['maxBalanceLinks', 'Máximo de links de saldo por reserva', 1, 3],
  ['slotMinutes', 'Duración de cada franja (minutos)', 15, 240],
  ['capacityPerSlot', 'Aforo por franja (personas)', 1, 1000],
  ['minRescheduleHours', 'Margen mínimo para reprogramar (horas)', 1, 720],
  ['maxCustomerReschedules', 'Máximo de cambios iniciados por cliente', 0, 10],
  ['offerWindowDays', 'Días máximos ofrecidos para reprogramar', 1, 90],
];
const toggles = [
  ['reminders', 'Enviar recordatorios por WhatsApp'],
  ['initialRequest', 'Enviar solicitud de anticipo al registrar el pedido'],
  ['depositReminder', 'Recordar el anticipo pendiente'],
  ['visitReminder', 'Recordar las visitas confirmadas'],
  ['internalAlerts', 'Alertar al personal por vencimiento, retraso o saldo pendiente'],
  ['yapeDemo', 'Ofrecer Yape simulado'],
  ['plinDemo', 'Ofrecer Plin simulado'],
  ['whatsappRescheduling', 'Permitir reprogramación automática por WhatsApp'],
];
const states = { queued: 'En espera', processing: 'Procesando', done: 'Procesado', failed: 'Requiere revisión' };
const weekdays = [['mon', 'Lunes'], ['tue', 'Martes'], ['wed', 'Miércoles'], ['thu', 'Jueves'], ['fri', 'Viernes'], ['sat', 'Sábado'], ['sun', 'Domingo']];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const plusDate = (key, delta) => new Date(+new Date(key + 'T12:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
async function refreshAvailability() {
  const date = today();
  const [blocks, occupancy] = await Promise.all([api('availability/blocks'), Promise.all(Array.from({ length: 7 }, (_, index) =>
    api('availability?date=' + plusDate(date, index))))]);
  return { blocks, occupancy };
}

export function AgentSettings({ config, onSave }) {
  const [draft, setDraft] = useState(() => ({ ...config, rate: config.depositPerPerson / 100 }));
  const [status, setStatus] = useState(null);
  const [activityError, setActivityError] = useState('');
  const [queries, setQueries] = useState([]);
  const [queryError, setQueryError] = useState('');
  const [queryBusy, setQueryBusy] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocks, setBlocks] = useState([]);
  const [occupancy, setOccupancy] = useState([]);
  const [blockForm, setBlockForm] = useState({ kind: 'day', local_date: today(), startTime: '12:00', endTime: '13:00', reason: '' });
  const [blockError, setBlockError] = useState('');
  const [error, setError] = useState('');
  const change = (key, value) => setDraft(v => ({ ...v, [key]: value }));
  async function refresh() {
    try { setStatus(await api('agent/activity')); setActivityError(''); }
    catch (e) { setActivityError(e.message); }
    await refreshQueries();
    try { const result = await refreshAvailability(); setBlocks(result.blocks); setOccupancy(result.occupancy); } catch (e) { setBlockError(e.message); }
  }
  async function refreshQueries() {
    try { setQueries(await api('agent/queries')); setQueryError(''); }
    catch (e) { setQueryError(e.message); }
  }
  async function markHandled(id) {
    setQueryBusy(id);
    try { await api('agent/queries/' + id + '/handled', {}); await refreshQueries(); }
    catch (e) { setQueryError(e.message); }
    finally { setQueryBusy(''); }
  }
  useEffect(() => { refresh(); }, []);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next = await api('agent/settings', { ...draft, depositPerPerson: Math.round(Number(draft.rate) * 100) });
      onSave(next);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function saveBlock(event) {
    event.preventDefault(); setBlockError('');
    try { await api('availability/blocks', blockForm); const result = await refreshAvailability(); setBlocks(result.blocks); setOccupancy(result.occupancy); setBlockForm(v => ({ ...v, reason: '' })); }
    catch (e) { setBlockError(e.message); }
  }
  async function removeBlock(id) {
    setBlockError('');
    try { await api('availability/blocks/' + id, {}); const result = await refreshAvailability(); setBlocks(result.blocks); setOccupancy(result.occupancy); }
    catch (e) { setBlockError(e.message); }
  }
  return <>
    <section className="panel form-panel">
      <div className="panel-head"><div><h2>Agente y alertas</h2>
        <p>Los avisos consultan estas reglas al ejecutarse. Links de saldo y constancias se automatizan según el estado del pedido.</p></div>
        <span className="label-chip"><Settings2 size={14} /> {config.agent === 'n8n' ? 'Orquestación n8n' : 'Modo servidor'}</span></div>
      <form onSubmit={save}>
        <div className="form-grid">
          <label>Anticipo por persona (S/)<input type="number" min="0.01" max="1000" step="0.01" required value={draft.rate}
            onChange={e => change('rate', e.target.value)} /></label>
          {numbers.map(([key, name, min, max]) => <label key={key}>{name}
            <input type="number" required min={min} max={max} value={draft[key]} onChange={e => change(key, e.target.value === '' ? '' : Number(e.target.value))} />
          </label>)}
          <label>Inicio de avisos (hora de Lima)<input type="time" required value={draft.contactStart} onChange={e => change('contactStart', e.target.value)} /></label>
          <label>Fin de avisos (hora de Lima)<input type="time" required value={draft.contactEnd} onChange={e => change('contactEnd', e.target.value)} /></label>
          {toggles.map(([key, label]) => <label className="check" key={key}><input type="checkbox" checked={draft[key]}
            onChange={e => change(key, e.target.checked)} />{label}</label>)}
        </div>
        <section className="action-panel"><h3><CalendarDays size={18} /> Horario semanal de atención</h3>
          <p>El aforo se calcula por franja en personas; la hora se interpreta en Lima.</p>
          {weekdays.map(([day, label]) => { const hours = draft.weeklySchedule?.[day]; return <div className="action-line" key={day}>
            <label className="check"><input type="checkbox" checked={Boolean(hours)} onChange={e => change('weeklySchedule', { ...draft.weeklySchedule, [day]: e.target.checked ? { open: '00:00', close: '23:59' } : null })} />{label}</label>
            {hours && <><label>Apertura<input type="time" value={hours.open} onChange={e => change('weeklySchedule', { ...draft.weeklySchedule, [day]: { ...hours, open: e.target.value } })} /></label>
              <label>Cierre<input type="time" value={hours.close} onChange={e => change('weeklySchedule', { ...draft.weeklySchedule, [day]: { ...hours, close: e.target.value } })} /></label></>}
          </div>; })}
        </section>
        <div className="config-footer">
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button primary" disabled={busy}><Save size={16} />{busy ? 'Guardando…' : 'Guardar configuración del agente'}</button>
        </div>
      </form>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h2>Disponibilidad</h2><p>{config.availabilityConfigured === false
        ? 'Aún no está configurada: las altas no validan horario ni aforo y la reprogramación automática por WhatsApp deriva al personal.'
        : 'Bloqueos excepcionales y ocupación de hoy, calculada con las reservas activas.'}</p></div></div>
      <form className="form-grid" onSubmit={saveBlock}>
        <label>Tipo<select value={blockForm.kind} onChange={e => setBlockForm(v => ({ ...v, kind: e.target.value }))}><option value="day">Día completo</option><option value="range">Rango horario</option><option value="slot">Franja concreta</option></select></label>
        <label>Fecha<input type="date" required value={blockForm.local_date} onChange={e => setBlockForm(v => ({ ...v, local_date: e.target.value }))} /></label>
        {blockForm.kind !== 'day' && <><label>Desde<input type="time" required value={blockForm.startTime} onChange={e => setBlockForm(v => ({ ...v, startTime: e.target.value }))} /></label>
          <label>Hasta<input type="time" required value={blockForm.endTime} onChange={e => setBlockForm(v => ({ ...v, endTime: e.target.value }))} /></label></>}
        <label>Motivo<input required minLength="3" maxLength="240" value={blockForm.reason} onChange={e => setBlockForm(v => ({ ...v, reason: e.target.value }))} /></label>
        <button className="button outline"><Save size={15} /> Crear bloqueo</button>
      </form>
      {blockError && <p className="error" role="alert">{blockError}</p>}
      {occupancy.length > 0 && <div className="table-scroll"><h3>Ocupación · próximos 7 días</h3><table><thead><tr><th>Fecha</th><th>Franja</th><th>Personas</th><th>Aforo</th><th>Estado</th></tr></thead><tbody>
        {occupancy.flatMap(day => day.closed ? [{ date: day.date, label: day.label, closed: true }] : day.slots.map(slot => ({ ...slot, date: day.date, label: day.label }))).map((slot, index) => <tr key={slot.date + ':' + (slot.time || index)}>
          <td>{slot.label}</td><td>{slot.closed ? '—' : slot.time}</td><td>{slot.closed ? '—' : slot.occupied}</td><td>{slot.closed ? '—' : slot.capacity}</td>
          <td>{slot.closed ? 'Cerrado' : slot.blocked ? 'Bloqueada' : slot.occupied >= slot.capacity ? 'Completa' : 'Disponible'}</td></tr>)}</tbody></table></div>}
      <div className="table-scroll"><h3>Bloqueos registrados</h3>{!blocks.length ? <p>No hay bloqueos.</p> : <table><thead><tr><th>Fecha</th><th>Tipo</th><th>Horario</th><th>Motivo</th><th /></tr></thead><tbody>
        {blocks.map(block => <tr key={block.id}><td>{String(block.local_date).slice(0, 10)}</td><td>{block.kind === 'day' ? 'Día' : block.kind === 'range' ? 'Rango' : 'Franja'}</td>
          <td>{block.starts_at ? visitText(block.starts_at) + ' – ' + visitText(block.ends_at) : 'Todo el día'}</td><td>{block.reason}</td>
          <td><button className="icon-button" aria-label="Eliminar bloqueo" onClick={() => removeBlock(block.id)}><Trash2 size={16} /></button></td></tr>)}</tbody></table>}</div>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h2>Actividad de WhatsApp</h2><p>{config.ai ? 'Lectura de imágenes y audios configurada' : 'Lectura de imágenes y audios pendiente de configurar'}</p></div>
        <button className="button outline" onClick={refresh}><Activity size={16} /> Actualizar actividad</button></div>
      <div className="config-footer">
        {activityError && <p className="error" role="alert">{activityError}</p>}
        {status?.length === 0 && <p>Los mensajes y confirmaciones de entrega aparecerán al conectarse el número de prueba.</p>}
        {status?.length > 0 && <div className="table-scroll"><table>
          <thead><tr><th>Recepción</th><th>Estado</th><th>Detalle</th></tr></thead><tbody>
            {status.map((row, index) => <tr key={index}><td>{visitText(row.queued_at)}</td>
              <td>{states[row.state]}</td><td>{row.error || '—'}</td></tr>)}
          </tbody></table></div>}
      </div>
    </section>
    <section className="panel">
      <div className="panel-head"><div><h2>Consultas sin reserva</h2>
        <p>Números que escribieron al agente sin una reserva registrada. El personal las atiende desde aquí.</p></div>
        <button className="button outline" onClick={refreshQueries}><MessageSquare size={16} /> Actualizar consultas</button></div>
      <div className="config-footer">
        {queryError && <p className="error" role="alert">{queryError}</p>}
        {!queries.length && <p>No hay consultas sin reserva.</p>}
        {queries.length > 0 && <div className="table-scroll"><table>
          <thead><tr><th>Fecha</th><th>Teléfono</th><th>Mensajes</th><th>Texto</th><th>Estado</th><th /></tr></thead>
          <tbody>{queries.map(row => <tr key={row.id}>
            <td className="nowrap">{visitText(row.created_at)}</td>
            <td className="nowrap">{row.phone}</td>
            <td>{row.message_count}</td>
            <td className="query-text">{row.excerpt || '—'}</td>
            <td><span className={'badge ' + (row.state === 'open' ? 'arrived' : 'confirmed')}>{row.state === 'open' ? 'Abierta' : 'Atendida'}</span></td>
            <td>{row.state === 'open' && <button className="button outline" disabled={queryBusy === row.id}
              onClick={() => markHandled(row.id)}>{queryBusy === row.id ? 'Guardando…' : 'Marcar atendida'}</button>}</td>
          </tr>)}</tbody></table></div>}
      </div>
    </section>
  </>;
}
