-- Descarta el aviso de llegada pendiente al cambiar de fecha y conserva las dos fechas en el evento.
create or replace function public.payers_reschedule_order(
  p_order_id uuid,
  p_new_visit_at timestamptz,
  p_expected_version integer,
  p_expected_visit_at timestamptz,
  p_settings jsonb,
  p_force_capacity boolean default false,
  p_actor text default 'Cliente'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.payers_orders%rowtype;
  v_local timestamp;
  v_date date;
  v_dow integer;
  v_day_key text;
  v_hours jsonb;
  v_open integer;
  v_close integer;
  v_duration integer;
  v_capacity integer;
  v_minute integer;
  v_slot_start timestamptz;
  v_slot_end timestamptz;
  v_occupied integer;
  v_count integer;
  v_data jsonb;
  v_old timestamptz;
  v_availability_configured boolean;
begin
  select * into v_row from public.payers_orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Reserva no encontrada.'; end if;
  if (v_row.data->>'visitAt')::timestamptz = p_new_visit_at then
    return jsonb_build_object('data', v_row.data, 'version', v_row.version, 'changed', false);
  end if;
  if (v_row.data->>'visitAt')::timestamptz <> p_expected_visit_at then raise exception using errcode = '40001', message = 'La reserva ya cambió de horario. Actualiza las opciones e inténtalo otra vez.'; end if;
  if v_row.version <> p_expected_version then raise exception using errcode = '40001', message = 'La reserva cambió en otro equipo. Actualiza e inténtalo otra vez.'; end if;
  if v_row.data->>'stage' not in ('awaiting_deposit', 'confirmed') then raise exception using errcode = 'P0001', message = 'Solo se puede reprogramar antes de registrar la llegada.'; end if;
  if p_new_visit_at <= now() + interval '1 minute' then raise exception using errcode = 'P0001', message = 'Elige una franja futura.'; end if;
  v_availability_configured := p_settings->>'availabilityConfigured' is distinct from 'false'
    and coalesce((p_settings->>'capacityPerSlot')::integer, 0) > 0
    and exists (
      select 1 from jsonb_each(coalesce(p_settings->'weeklySchedule', '{}'::jsonb)) as schedule(day_key, hours)
      where jsonb_typeof(hours) = 'object' and hours->>'open' is not null and hours->>'close' is not null
    );
  if p_actor = 'Cliente' then
    if p_settings->>'whatsappRescheduling' <> 'true' then raise exception using errcode = 'P0001', message = 'La reprogramación por WhatsApp está desactivada.'; end if;
    if not v_availability_configured then
      raise exception using errcode = 'P0001', message = 'La disponibilidad aún no está configurada. El personal te ayudará con el cambio.';
    end if;
    if (v_row.data->>'visitAt')::timestamptz - now() < make_interval(hours => coalesce((p_settings->>'minRescheduleHours')::integer,24)) then
      raise exception using errcode = 'P0001', message = 'La reserva está dentro del margen mínimo para reprogramar.';
    end if;
    if coalesce((v_row.data->>'rescheduleCount')::integer,0) >= coalesce((p_settings->>'maxCustomerReschedules')::integer,2) then
      raise exception using errcode = 'P0001', message = 'Alcanzaste el máximo de cambios de fecha para esta reserva.';
    end if;
    if (p_new_visit_at at time zone 'America/Lima')::date > (now() at time zone 'America/Lima')::date + coalesce((p_settings->>'offerWindowDays')::integer,30) then
      raise exception using errcode = 'P0001', message = 'La fecha supera la ventana de opciones permitida.';
    end if;
  end if;

  if v_availability_configured then
  v_local := p_new_visit_at at time zone 'America/Lima';
  v_date := v_local::date;
  v_dow := extract(isodow from v_local)::integer;
  v_day_key := (array['mon','tue','wed','thu','fri','sat','sun'])[v_dow];
  v_hours := p_settings->'weeklySchedule'->v_day_key;
  if v_hours is null or v_hours = 'null'::jsonb then raise exception using errcode = 'P0001', message = 'Ese día el restaurante está cerrado.'; end if;
  v_duration := coalesce((p_settings->>'slotMinutes')::integer, 60);
  v_capacity := coalesce((p_settings->>'capacityPerSlot')::integer, 0);
  v_open := split_part(v_hours->>'open', ':', 1)::integer * 60 + split_part(v_hours->>'open', ':', 2)::integer;
  v_close := split_part(v_hours->>'close', ':', 1)::integer * 60 + split_part(v_hours->>'close', ':', 2)::integer;
  v_minute := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  if extract(second from v_local) <> 0 or v_minute < v_open or v_minute + v_duration > v_close or mod(v_minute-v_open, v_duration) <> 0 then
    raise exception using errcode = 'P0001', message = 'El horario elegido no coincide con una franja disponible.';
  end if;
  v_slot_start := p_new_visit_at;
  v_slot_end := v_slot_start + make_interval(mins => v_duration);
  perform pg_advisory_xact_lock(hashtext(v_slot_start::text));
  if exists (select 1 from public.payers_availability_blocks b where b.local_date = v_date and
    (b.kind = 'day' or (b.starts_at < v_slot_end and b.ends_at > v_slot_start))) then
    raise exception using errcode = 'P0001', message = 'Ese horario está bloqueado. Elige otra opción.';
  end if;
  select coalesce(sum((o.data->>'guests')::integer), 0) into v_occupied
    from public.payers_orders o
   where o.id <> p_order_id and o.data->>'stage' in ('awaiting_deposit','confirmed','arrived','paid')
     and o.visit_at >= v_slot_start and o.visit_at < v_slot_end;
  if not p_force_capacity and v_occupied + (v_row.data->>'guests')::integer > v_capacity then
    raise exception using errcode = 'P0001', message = 'Ese horario ya no tiene cupo suficiente. Elige otra opción.';
  end if;
  end if;

  v_old := (v_row.data->>'visitAt')::timestamptz;
  v_data := v_row.data || jsonb_build_object('visitAt', to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'reminders', '{}'::jsonb);
  if v_data->>'stage' = 'awaiting_deposit' and (v_data->>'deadline')::timestamptz > p_new_visit_at then
    v_data := jsonb_set(v_data, '{deadline}', to_jsonb(to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;
  if (v_data->'depositPromise'->>'at')::timestamptz >= (v_data->>'deadline')::timestamptz then
    v_data := v_data - 'depositPromise';
  end if;
  if v_data->'attendance'->>'state' = 'pending' then
    v_data := v_data || jsonb_build_object('attendance', null);
  end if;
  if p_actor = 'Cliente' then
    v_count := coalesce((v_data->>'rescheduleCount')::integer, 0) + 1;
    v_data := jsonb_set(v_data, '{rescheduleCount}', to_jsonb(v_count), true);
  else
    v_count := coalesce((v_data->>'rescheduleCount')::integer, 0);
  end if;
  v_data := jsonb_set(v_data, '{events}', coalesce(v_data->'events','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid(), 'at', now(), 'title', 'Visita reprogramada',
    'detail', 'Anterior: ' || v_old::text || ' · Nueva: ' || p_new_visit_at::text || ' · Cambios del cliente: ' || v_count::text || case when p_force_capacity then ' · Aforo forzado por personal' else '' end,
    'actor', p_actor, 'previousVisitAt', v_old, 'newVisitAt', p_new_visit_at)));
  update public.payers_orders set data = v_data, version = version + 1, updated_at = now() where id = p_order_id;
  return jsonb_build_object('data', v_data, 'version', v_row.version + 1, 'changed', true);
end $$;
revoke all on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) from public, anon, authenticated;
grant execute on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) to service_role;
