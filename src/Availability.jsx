import { useCallback, useEffect, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, RefreshCw, Users } from 'lucide-react';
import { api, fromLima } from './client.mjs';

const todayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shiftDate = (key, amount) => {
  const date = new Date(key + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};
const displayDay = key => new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  .format(new Date(key + 'T17:00:00Z'));

export function Availability() {
  const [date, setDate] = useState(todayKey);
  const [data, setData] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setRefreshing(true); setError('');
    try {
      const [day, allBlocks] = await Promise.all([
        api('availability?date=' + encodeURIComponent(date)), api('availability/blocks'),
      ]);
      setData(day);
      setBlocks(allBlocks.filter(block => block.local_date === date));
    } catch (e) { setError(e.message || 'No se pudo cargar la disponibilidad.'); }
    finally { setRefreshing(false); }
  }, [date]);
  useEffect(() => { load(); }, [load]);
  const dayBlocks = blocks.filter(block => block.kind === 'day');
  // Los bloqueos se comparan usando los intervalos ISO de cada franja en hora de Lima.
  const slotBlocks = (slot) => blocks.filter(block => {
    if (block.kind === 'day') return true;
    if (!block.starts_at || !block.ends_at) return false;
    const start = +new Date(fromLima(date + 'T' + slot.time));
    const end = start + Number(data.slotMinutes || 60) * 60000;
    return +new Date(block.starts_at) < end && +new Date(block.ends_at) > start;
  });
  const booked = data?.slots?.filter(slot => slot.blocked || slot.occupied >= slot.capacity).length || 0;
  return <>
    <div className="page-head"><div><span className="eyebrow">OPERACIONES</span><h1>Disponibilidad</h1>
      <p>Consulta aforo reservado y cupos libres por franja, según el horario de Lima.</p></div>
      <button className="button outline" disabled={refreshing} onClick={load}><RefreshCw size={16} /> Actualizar</button></div>
    <section className="panel availability-browser">
      <div className="availability-datebar"><button className="icon-button" aria-label="Día anterior" onClick={() => setDate(value => shiftDate(value, -1))}><ChevronLeft size={18} /></button>
        <label><CalendarDays size={17} /><input type="date" aria-label="Fecha de disponibilidad" value={date} onChange={event => setDate(event.target.value)} /></label>
        <button className="icon-button" aria-label="Día siguiente" onClick={() => setDate(value => shiftDate(value, 1))}><ChevronRight size={18} /></button>
        <button className="button outline" onClick={() => setDate(todayKey())}>Hoy</button>
      </div>
      <div className="availability-day-heading"><div><h2>{displayDay(date)}</h2><p>{data?.unconfigured ? 'Configura horario y aforo para ver cupos.'
        : data?.closed ? 'El restaurante está cerrado este día.' : data ? `${data.slots.length} franjas · ${booked} sin cupo o bloqueadas` : 'Consultando horarios…'}</p></div>
        {data && !data.unconfigured && !data.closed && <span className="label-chip"><Users size={14} /> Aforo por personas</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data?.unconfigured && <div className="availability-empty"><CalendarDays size={24} /><strong>Disponibilidad sin configurar</strong>
        <p>Define el horario semanal, la duración de franja y el aforo en Conexiones → Disponibilidad.</p></div>}
      {data?.closed && <div className="availability-empty"><strong>Día cerrado</strong><p>No hay franjas de atención para esta fecha.</p></div>}
      {data && !data.unconfigured && !data.closed && <>
        {dayBlocks.length > 0 && <div className="availability-alert">Día bloqueado: {dayBlocks.map(block => block.reason).join(' · ')}</div>}
        {!data.slots.length ? <div className="availability-empty"><strong>No hay franjas definidas</strong><p>Revisa el horario semanal en la configuración.</p></div>
          : <div className="availability-slots">{data.slots.map(slot => {
            const reasons = slotBlocks(slot);
            const isBlocked = slot.blocked || reasons.length > 0;
            const isFull = slot.occupied >= slot.capacity;
            const state = isBlocked ? 'bloqueado' : isFull ? 'completo' : 'disponible';
            return <article className={'availability-slot ' + state} key={slot.time}>
              <div className="availability-slot-top"><strong>{slot.time}</strong><span>{isBlocked ? 'Bloqueado' : isFull ? 'Completo' : 'Disponible'}</span></div>
              <div className="availability-capacity"><b>{slot.occupied}</b><span>de {slot.capacity} personas</span></div>
              <div className="availability-meter" role="meter" aria-label={`${slot.occupied} de ${slot.capacity} personas`} aria-valuemin="0" aria-valuemax={slot.capacity} aria-valuenow={Math.min(slot.occupied, slot.capacity)}>
                <i style={{ width: `${slot.capacity ? Math.min(100, slot.occupied / slot.capacity * 100) : 0}%` }} />
              </div>
              {reasons.map((block, index) => <small className="availability-reason" key={(block.id || block.kind) + index}>{block.reason}</small>)}
              {isBlocked && !reasons.length && <small className="availability-reason">Bloqueo de horario activo</small>}
            </article>;
          })}</div>}
        {blocks.filter(block => block.kind !== 'day').length > 0 && <section className="availability-block-list">
          <h3>Excepciones horarias</h3>{blocks.filter(block => block.kind !== 'day').map(block => <p key={block.id}>
            <strong>{block.starts_at ? new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(block.starts_at)) : 'Rango'}</strong>
            {block.ends_at && ' – ' + new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(block.ends_at))}
            {' · ' + block.reason}</p>)}</section>}
      </>}
    </section>
  </>;
}
