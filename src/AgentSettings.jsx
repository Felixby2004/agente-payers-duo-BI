import { useEffect, useState } from 'react';
import { Activity, MessageSquare, Save, Settings2 } from 'lucide-react';
import { api } from './client.mjs';
import { visitText } from '../shared/orders.mjs';

const numbers = [
  ['deadlineMinutes', 'Vencimiento del anticipo (minutos)', 1, 43200],
  ['depositReminderMinutes', 'Aviso de anticipo a los (minutos)', 1, 43200],
  ['firstVisitHours', 'Primer aviso antes de la visita (horas)', 1, 168],
  ['lastVisitHours', 'Segundo aviso antes de la visita (horas)', 1, 168],
  ['graceMinutes', 'Tolerancia de llegada (minutos)', 0, 1440],
  ['counterAlertMinutes', 'Aviso de saldo pendiente en caja (minutos)', 1, 1440],
  ['balanceLinkExpiryMinutes', 'Vencimiento del link de saldo (minutos)', 1, 1440],
  ['maxBalanceLinks', 'Máximo de links de saldo por reserva', 1, 20],
];
const toggles = [
  ['reminders', 'Enviar recordatorios por WhatsApp'],
  ['initialRequest', 'Enviar solicitud de anticipo al registrar el pedido'],
  ['depositReminder', 'Recordar el anticipo pendiente'],
  ['visitReminder', 'Recordar las visitas confirmadas'],
  ['internalAlerts', 'Alertar al personal por vencimiento, retraso o saldo pendiente'],
  ['yapeDemo', 'Ofrecer Yape simulado'],
  ['plinDemo', 'Ofrecer Plin simulado'],
];
const states = { queued: 'En espera', processing: 'Procesando', done: 'Procesado', failed: 'Requiere revisión' };

export function AgentSettings({ config, onSave }) {
  const [draft, setDraft] = useState(() => ({ ...config, rate: config.depositPerPerson / 100 }));
  const [status, setStatus] = useState(null);
  const [activityError, setActivityError] = useState('');
  const [queries, setQueries] = useState([]);
  const [queryError, setQueryError] = useState('');
  const [queryBusy, setQueryBusy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (key, value) => setDraft(v => ({ ...v, [key]: value }));
  async function refresh() {
    try { setStatus(await api('agent/activity')); setActivityError(''); }
    catch (e) { setActivityError(e.message); }
    await refreshQueries();
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
        <div className="config-footer">
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button primary" disabled={busy}><Save size={16} />{busy ? 'Guardando…' : 'Guardar configuración del agente'}</button>
        </div>
      </form>
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
