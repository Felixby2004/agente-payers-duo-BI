-- Modelos de lectura sobre los pedidos operativos, incluidos los históricos.
-- Una única escritura de la reserva sigue protegiendo cobro, asistencia y disponibilidad.
create schema if not exists payers_operacion;
revoke all on schema payers_operacion from public, anon, authenticated;
grant usage on schema payers_operacion to service_role;

create table if not exists payers_operacion.producto (
  id_producto bigint generated always as identity primary key,
  nombre text not null, categoria text, precio_vigente_centimos bigint check(precio_vigente_centimos >= 0),
  activo boolean not null default true
);
create unique index if not exists payers_producto_nombre on payers_operacion.producto (lower(nombre));
create table if not exists payers_operacion.medio_pago (
  id_medio_pago smallint generated always as identity primary key,
  referencia text not null unique
);
create or replace function payers_operacion.registrar_catalogo() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op = 'INSERT' then
    insert into payers_operacion.producto(nombre,precio_vigente_centimos)
      select item->>'name',(item->>'price')::bigint from jsonb_array_elements(new.data->'items') item
      on conflict do nothing;
  end if;
  if tg_op = 'INSERT' or old.data->'payments' is distinct from new.data->'payments' then
    insert into payers_operacion.medio_pago(referencia)
      select distinct item->>'channel' from jsonb_array_elements(new.data->'payments') item
      where item->>'channel' is not null on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function payers_operacion.registrar_catalogo() from public,anon,authenticated;
grant execute on function payers_operacion.registrar_catalogo() to service_role;
drop trigger if exists payers_catalogo on public.payers_orders;
create trigger payers_catalogo after insert or update of data on public.payers_orders
for each row execute function payers_operacion.registrar_catalogo();

create or replace view payers_operacion.reserva with (security_invoker=true) as
select o.id as reserva_id,c.id as cliente_id,o.data->>'ref' as referencia,
  o.data->>'stage' as estado,o.created_at as creada_en,o.visit_at as visita_en,
  (o.data->>'deadline')::timestamptz as vence_anticipo_en,
  (o.data->>'confirmedAt')::timestamptz as anticipo_confirmado_en,
  (o.data->>'closedAt')::timestamptz as cerrada_en,
  (o.data->>'guests')::smallint as personas_reservadas,
  (o.data->>'total')::bigint as total_centimos,(o.data->>'deposit')::bigint as anticipo_centimos
from public.payers_orders o left join public.payers_clients c on c.phone=o.phone;

create or replace view payers_operacion.detalle_pedido with (security_invoker=true) as
select o.id as reserva_id,p.linea,p.item->>'name' as producto,(p.item->>'quantity')::smallint as cantidad,
  (p.item->>'price')::bigint as precio_pactado_centimos,
  coalesce((p.item->>'discount')::bigint,0) as descuento_centimos,
  (p.item->>'quantity')::bigint*(p.item->>'price')::bigint-coalesce((p.item->>'discount')::bigint,0) as importe_neto_centimos,c.id_producto
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'items') with ordinality p(item,linea)
left join payers_operacion.producto c on lower(c.nombre)=lower(p.item->>'name');

create or replace view payers_operacion.intento_pago with (security_invoker=true) as
select o.id as reserva_id,p.item->>'id' as intento_id,coalesce(p.item->>'purpose','deposit') as finalidad,
  p.item->>'method' as medio,p.item->>'status' as estado,(p.item->>'amount')::bigint as importe_centimos,
  (p.item->>'createdAt')::timestamptz as creado_en,(p.item->>'expiresAt')::timestamptz as vence_en,
  p.item->>'staffId' as emitido_por
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'intents') p(item);

create or replace view payers_operacion.movimiento_pago with (security_invoker=true) as
select o.id as reserva_id,p.item->>'ref' as operacion,p.item->>'intentId' as intento_id,
  coalesce(p.item->>'purpose','deposit') as finalidad,p.item->>'channel' as medio,
  (p.item->>'amount')::bigint as importe_centimos,(p.item->>'at')::timestamptz as confirmado_en,
  p.item->>'original' as operacion_origen,p.item->>'staffId' as registrado_por
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'payments') p(item);

create or replace view payers_operacion.asistencia with (security_invoker=true) as
select o.id as reserva_id,coalesce(a.data->>'state',case when a.data->>'at' is not null then 'confirmed' end) as estado,
  (a.data->>'reportedAt')::timestamptz as reportada_en,(a.data->>'at')::timestamptz as verificada_en,
  (a.data->>'titularPresente')::boolean as titular_presente,
  (a.data->>'count')::smallint as comensales_presentes,a.data->>'staffId' as cajero_id,a.data->>'staffName' as cajero
from public.payers_orders o cross join lateral (select o.data->'attendance' as data) a
where jsonb_typeof(a.data) = 'object';

create or replace view payers_operacion.comprobante with (security_invoker=true) as
select o.id as reserva_id,r.item->>'number' as numero,r.item->>'purpose' as tipo,
  (r.item->>'at')::timestamptz as emitido_en,(r.item->>'amount')::bigint as importe_centimos,
  (r.item->>'reversedAt')::timestamptz as revertido_en
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'receipts') r(item);

create or replace view payers_operacion.evento_reserva with (security_invoker=true) as
select o.id as reserva_id,e.item->>'id' as evento_id,e.item->>'title' as tipo,
  (e.item->>'at')::timestamptz as ocurrido_en,e.item->>'actor' as actor,e.item->>'detail' as detalle
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'events') e(item);

create or replace view payers_operacion.incidencia with (security_invoker=true) as
select o.id as reserva_id,i.item->>'id' as incidencia_id,i.item->>'type' as tipo,
  (i.item->>'at')::timestamptz as abierta_en,(i.item->>'resolvedAt')::timestamptz as resuelta_en,
  i.item->>'detail' as detalle,i.item->>'resolution' as resolucion
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'incidents') i(item);

create or replace view payers_operacion.mensaje_whatsapp with (security_invoker=true) as
select o.id as reserva_id,m.item->>'id' as id_meta,o.phone as telefono,
  (m.item->>'at')::timestamptz as ocurrido_en,m.item->>'direction' as direccion,
  m.item->>'status' as estado,m.item->>'text' as texto,m.item->>'mediaId' as medio
from public.payers_orders o cross join lateral jsonb_array_elements(o.data->'chat') m(item);

-- Los hechos de lectura mantienen el grano dimensional mientras se pospone el merge físico.
create schema if not exists payers_bi;
revoke all on schema payers_bi from public, anon, authenticated;
grant usage on schema payers_bi to service_role;

create or replace view payers_operacion.totales_movimiento with (security_invoker=true) as
select reserva_id, sum(importe_centimos) as total,
  sum(importe_centimos) filter(where finalidad='deposit') as anticipo,
  count(distinct medio) filter(where importe_centimos>0) as n_medios,
  count(distinct medio) filter(where finalidad='deposit' and importe_centimos>0) as n_medios_anticipo,
  min(medio) filter(where importe_centimos>0) as medio,
  min(medio) filter(where finalidad='deposit' and importe_centimos>0) as medio_anticipo
from payers_operacion.movimiento_pago group by reserva_id;

create or replace view payers_bi.v_hecho_anticipo_asistencia with (security_invoker=true) as
select r.reserva_id,r.cliente_id,r.referencia,
  (r.anticipo_confirmado_en at time zone 'America/Lima')::date as fecha_anticipo,
  (r.visita_en at time zone 'America/Lima')::date as fecha_visita,
  case when p.n_medios_anticipo>1 then 'Mixto' else p.medio_anticipo end as medio,
  coalesce(p.anticipo,0)::bigint as anticipo_centimos,
  (r.anticipo_confirmado_en is not null and coalesce(p.anticipo,0)>0) as con_anticipo,
  r.anticipo_confirmado_en is not null as titular_pago,
  a.titular_presente as titular_asistio,
  (a.verificada_en is not null or r.estado='no_show') as asistencia_evaluable,
  a.cajero, a.comensales_presentes
from payers_operacion.reserva r left join payers_operacion.totales_movimiento p using(reserva_id)
left join payers_operacion.asistencia a using(reserva_id);

create or replace view payers_bi.v_hecho_cobranza_completa with (security_invoker=true) as
select r.reserva_id,r.cliente_id,r.referencia,
  (r.cerrada_en at time zone 'America/Lima')::date as fecha_cierre,
  case when p.n_medios>1 then 'Mixto' else p.medio end as medio,
  p.total::bigint as total_centimos,
  extract(epoch from r.cerrada_en - a.verificada_en)::integer as segundos_llegada_cierre
from payers_operacion.reserva r join payers_operacion.totales_movimiento p using(reserva_id)
join payers_operacion.asistencia a using(reserva_id)
where r.estado='closed' and r.cerrada_en is not null and p.total=r.total_centimos and a.verificada_en is not null;

grant select on payers_bi.v_hecho_anticipo_asistencia, payers_bi.v_hecho_cobranza_completa to service_role;

create or replace view public.payers_report_rows with (security_invoker=true) as
select 'M1'::text as measure,fecha_anticipo as date,referencia as ref,medio as label,anticipo_centimos as value
from payers_bi.v_hecho_anticipo_asistencia where con_anticipo
union all
select 'M3',fecha_visita,referencia,coalesce(cajero,'Caja'),1::bigint
from payers_bi.v_hecho_anticipo_asistencia where titular_pago and titular_asistio is true and asistencia_evaluable
union all
select 'M5',fecha_cierre,referencia,medio,total_centimos from payers_bi.v_hecho_cobranza_completa;

revoke all on all tables in schema payers_operacion from public, anon, authenticated;
grant select on all tables in schema payers_operacion to service_role;
revoke all on public.payers_report_rows from public, anon, authenticated;
grant select on public.payers_report_rows to service_role;

