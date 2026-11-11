-- Base dimensional física. El merge y el poblamiento quedan para una etapa posterior.
create schema if not exists payers_bi;
revoke all on schema payers_bi from public, anon, authenticated;
grant usage on schema payers_bi to service_role;

create table if not exists payers_bi.dim_tiempo (
  key_tiempo integer generated always as identity primary key,
  anio smallint not null, trimestre smallint not null, mes smallint not null, dia smallint not null,
  dia_semana smallint not null, id_tiempo date not null unique
);
create table if not exists payers_bi.dim_cliente (
  key_cliente integer generated always as identity primary key,
  nombre varchar(100) not null, tipo_cliente varchar(60), id_cliente bigint not null unique
);
create table if not exists payers_bi.dim_personal (
  key_personal integer generated always as identity primary key,
  nombre varchar(100) not null, rol varchar(40) not null, id_personal uuid not null unique
);
create table if not exists payers_bi.dim_reserva (
  key_reserva integer generated always as identity primary key,
  origen varchar(40), personas_reservadas smallint not null, id_reserva uuid not null unique
);
create table if not exists payers_bi.dim_medio_pago (
  key_medio_pago integer generated always as identity primary key,
  nombre varchar(60) not null, tipo varchar(30) not null, id_medio_pago smallint not null unique
);
create table if not exists payers_bi.dim_producto (
  key_producto integer generated always as identity primary key,
  nombre varchar(120) not null, categoria varchar(60), id_producto bigint not null unique
);
create table if not exists payers_bi.hecho_anticipo_asistencia (
  key_reserva integer primary key references payers_bi.dim_reserva,
  key_tiempo_anticipo integer references payers_bi.dim_tiempo,
  key_tiempo_visita integer not null references payers_bi.dim_tiempo,
  key_cliente integer not null references payers_bi.dim_cliente,
  key_personal_valida integer references payers_bi.dim_personal,
  key_personal_recepcion integer references payers_bi.dim_personal,
  key_medio_pago_anticipo integer references payers_bi.dim_medio_pago,
  monto_anticipo_confirmado numeric(12,2) not null, con_anticipo boolean not null, titular_asistio boolean,
  titular_pago boolean not null, asistencia_evaluable boolean not null, comensales_presentes smallint
);
create table if not exists payers_bi.hecho_cobranza_completa (
  key_reserva integer primary key references payers_bi.dim_reserva,
  key_tiempo_llegada integer not null references payers_bi.dim_tiempo,
  key_tiempo_cierre integer not null references payers_bi.dim_tiempo,
  key_cliente integer not null references payers_bi.dim_cliente,
  key_personal_cierre integer references payers_bi.dim_personal,
  key_medio_pago_liquidacion integer references payers_bi.dim_medio_pago,
  importe_total_cobrado numeric(12,2) not null, segundos_llegada_a_cierre integer not null
);
create table if not exists payers_bi.detalle_cobranza_producto (
  key_detalle bigint generated always as identity primary key,
  key_reserva integer not null references payers_bi.hecho_cobranza_completa,
  key_producto integer not null references payers_bi.dim_producto,
  cantidad smallint not null check (cantidad > 0),
  precio_unitario_pactado numeric(12,2) not null check (precio_unitario_pactado >= 0),
  descuento_total_linea numeric(12,2) not null default 0,
  importe_neto_linea numeric(12,2) generated always as (cantidad * precio_unitario_pactado - descuento_total_linea) stored,
  check (descuento_total_linea between 0 and cantidad * precio_unitario_pactado)
);
revoke all on all tables in schema payers_bi from public, anon, authenticated;
grant select on all tables in schema payers_bi to service_role;

