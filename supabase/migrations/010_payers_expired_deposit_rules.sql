-- Excluye del aforo las reservas vencidas sin pagos, bloquea su reprogramación y permite renovar su plazo.
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
  if v_row.data->>'stage' = 'awaiting_deposit'
    and (v_row.data->>'deadline')::timestamptz <= now()
    and (p_actor = 'Cliente' or not p_force_capacity) then
    raise exception using errcode = 'P0001', message = 'El plazo del anticipo venció. Renueva el plazo o cancela la reserva antes de cambiar la fecha.';
  end if;
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
  perform pg_advisory_xact_lock(hashtext((p_new_visit_at::timestamptz)::text));
  if exists (select 1 from public.payers_availability_blocks b where b.local_date = v_date and
    (b.kind = 'day' or (b.starts_at < v_slot_end and b.ends_at > v_slot_start))) then
    raise exception using errcode = 'P0001', message = 'Ese horario está bloqueado. Elige otra opción.';
  end if;
  select coalesce(sum((o.data->>'guests')::integer), 0) into v_occupied
    from public.payers_orders o
   where o.id <> p_order_id and o.data->>'stage' in ('awaiting_deposit','confirmed','arrived','paid')
     and not (o.data->>'stage' = 'awaiting_deposit' and (o.data->>'deadline')::timestamptz <= now()
       and jsonb_array_length(coalesce(o.data->'payments','[]'::jsonb)) = 0)
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
    'id', gen_random_uuid(), 'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'title', 'Visita reprogramada',
    'detail', 'Anterior: ' || to_char(v_old at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ' · Nueva: '
      || to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || ' · Cambios del cliente: '
      || v_count::text || case when p_force_capacity then ' · Aforo forzado por personal' else '' end,
    'actor', p_actor,
    'previousVisitAt', to_char(v_old at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'newVisitAt', to_char(p_new_visit_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))));
  update public.payers_orders set data = v_data, version = version + 1, updated_at = now() where id = p_order_id;
  return jsonb_build_object('data', v_data, 'version', v_row.version + 1, 'changed', true);
end $$;
revoke all on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) from public, anon, authenticated;
grant execute on function public.payers_reschedule_order(uuid,timestamptz,integer,timestamptz,jsonb,boolean,text) to service_role;

-- Reabre el plazo con cupo verificado y control de versión en una sola transacción.
create or replace function public.payers_renew_deposit_order(
  p_order_id uuid,
  p_expected_version integer,
  p_expected_visit_at timestamptz,
  p_settings jsonb,
  p_actor text default 'Cliente',
  p_phone text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row public.payers_orders%rowtype;
  v_local timestamp;
  v_date date;
  v_day_key text;
  v_hours jsonb;
  v_open integer;
  v_close integer;
  v_duration integer;
  v_capacity integer;
  v_minute integer;
  v_slot_end timestamptz;
  v_occupied integer;
  v_renewals integer;
  v_deadline timestamptz;
  v_data jsonb;
begin
  select * into v_row from public.payers_orders where id = p_order_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Reserva no encontrada.'; end if;
  if v_row.version <> p_expected_version or (v_row.data->>'visitAt')::timestamptz <> p_expected_visit_at then
    raise exception using errcode = '40001', message = 'La reserva cambió. Actualiza tus opciones e inténtalo otra vez.';
  end if;
  if p_actor = 'Cliente' and v_row.data->>'phone' is distinct from p_phone then
    raise exception using errcode = '42501', message = 'Esta reserva no pertenece a este número.';
  end if;
  if v_row.data->>'stage' <> 'awaiting_deposit' or (v_row.data->>'deadline')::timestamptz > now() then
    raise exception using errcode = 'P0001', message = 'Solo se puede renovar un anticipo pendiente cuyo plazo venció.';
  end if;
  if jsonb_array_length(coalesce(v_row.data->'payments','[]'::jsonb)) > 0 then
    raise exception using errcode = 'P0001', message = 'La reserva tiene un pago registrado. El personal debe revisar el caso.';
  end if;
  if (v_row.data->>'visitAt')::timestamptz <= now() + interval '2 hours' then
    raise exception using errcode = 'P0001', message = 'La visita debe estar a más de 2 horas para pedir un nuevo plazo.';
  end if;
  if p_settings->>'availabilityConfigured' = 'false'
    or coalesce((p_settings->>'capacityPerSlot')::integer,0) <= 0 then
    raise exception using errcode = 'P0001', message = 'La disponibilidad no está configurada; el personal debe revisar el cupo antes de renovar.';
  end if;
  v_renewals := coalesce((v_row.data->>'depositRenewals')::integer,0);
  if p_actor = 'Cliente' and v_renewals >= coalesce((p_settings->>'depositRenewalsMax')::integer,1) then
    raise exception using errcode = 'P0001', message = 'Ya pediste el nuevo plazo permitido para esta reserva. Hablaré con el personal.';
  end if;
  v_local := (v_row.data->>'visitAt')::timestamptz at time zone 'America/Lima';
  v_date := v_local::date;
  v_day_key := (array['mon','tue','wed','thu','fri','sat','sun'])[extract(isodow from v_local)::integer];
  v_hours := p_settings->'weeklySchedule'->v_day_key;
  if v_hours is null or v_hours = 'null'::jsonb then raise exception using errcode = 'P0001', message = 'Ese día el restaurante está cerrado.'; end if;
  v_duration := coalesce((p_settings->>'slotMinutes')::integer,60);
  v_capacity := coalesce((p_settings->>'capacityPerSlot')::integer,0);
  v_open := split_part(v_hours->>'open',':',1)::integer * 60 + split_part(v_hours->>'open',':',2)::integer;
  v_close := split_part(v_hours->>'close',':',1)::integer * 60 + split_part(v_hours->>'close',':',2)::integer;
  v_minute := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  if v_minute < v_open or v_minute + v_duration > v_close or mod(v_minute-v_open,v_duration) <> 0 then
    raise exception using errcode = 'P0001', message = 'El horario elegido no coincide con una franja disponible.';
  end if;
  v_slot_end := (v_row.data->>'visitAt')::timestamptz + make_interval(mins => v_duration);
  perform pg_advisory_xact_lock(hashtext(((v_row.data->>'visitAt')::timestamptz)::text));
  if exists (select 1 from public.payers_availability_blocks b where b.local_date = v_date and
    (b.kind = 'day' or (b.starts_at < v_slot_end and b.ends_at > (v_row.data->>'visitAt')::timestamptz))) then
    raise exception using errcode = 'P0001', message = 'Ese horario no está disponible.';
  end if;
  select coalesce(sum((o.data->>'guests')::integer),0) into v_occupied from public.payers_orders o
   where o.id <> p_order_id and o.data->>'stage' in ('awaiting_deposit','confirmed','arrived','paid')
     and not (o.data->>'stage' = 'awaiting_deposit' and (o.data->>'deadline')::timestamptz <= now()
       and jsonb_array_length(coalesce(o.data->'payments','[]'::jsonb)) = 0)
     and o.visit_at >= (v_row.data->>'visitAt')::timestamptz and o.visit_at < v_slot_end;
  if v_occupied + (v_row.data->>'guests')::integer > v_capacity then
    raise exception using errcode = 'P0001', message = 'No hay cupo suficiente para renovar el plazo.';
  end if;
  v_deadline := least(now() + make_interval(mins => coalesce((p_settings->>'renewDepositMinutes')::integer,
    (p_settings->>'deadlineMinutes')::integer,60)), (v_row.data->>'visitAt')::timestamptz);
  v_data := jsonb_set(v_row.data,'{deadline}',to_jsonb(to_char(v_deadline at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),true);
  if p_actor = 'Cliente' then
    v_data := jsonb_set(v_data,'{depositRenewals}',to_jsonb(v_renewals+1),true);
  end if;
  v_data := jsonb_set(v_data,'{events}',coalesce(v_data->'events','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
    'id',gen_random_uuid(),'at',to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'title',case when p_actor = 'Cliente' then 'Plazo de anticipo renovado' else 'Plazo de anticipo reabierto' end,
    'detail','Nuevo vencimiento: ' || to_char(v_deadline at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || case when p_actor = 'Cliente' then ' · Renovaciones del cliente: ' || (v_renewals+1)::text else '' end,
    'actor',p_actor)),true);
  update public.payers_orders set data = v_data, version = version + 1, updated_at = now() where id = p_order_id;
  return jsonb_build_object('data',v_data,'version',v_row.version+1,'changed',true);
end $$;
revoke all on function public.payers_renew_deposit_order(uuid,integer,timestamptz,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.payers_renew_deposit_order(uuid,integer,timestamptz,jsonb,text,text) to service_role;
