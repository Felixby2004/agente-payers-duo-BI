-- SQL Server 2022 / SSMS. Ejecutar como un usuario autorizado para crear bases.
-- Creación de la base transaccional vacía. Las tablas están disponibles en Database Diagrams.
USE master;
GO
IF DB_ID(N'ElEstablo_PAYERS_Transaccional') IS NULL
    EXEC(N'CREATE DATABASE ElEstablo_PAYERS_Transaccional');
GO
USE ElEstablo_PAYERS_Transaccional;
GO
SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'dbo.Cliente', N'U') IS NULL
CREATE TABLE dbo.Cliente (
    idCliente BIGINT IDENTITY(1,1) PRIMARY KEY,
    Nombre NVARCHAR(100) NOT NULL,
    TelefonoWhatsApp VARCHAR(16) NOT NULL UNIQUE,
    Consentimiento BIT NOT NULL DEFAULT 0
);

IF OBJECT_ID(N'dbo.Personal', N'U') IS NULL
CREATE TABLE dbo.Personal (
    idPersonal UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    Usuario VARCHAR(40) NOT NULL UNIQUE,
    Nombre NVARCHAR(100) NOT NULL,
    Rol VARCHAR(20) NOT NULL CHECK (Rol IN ('ADMINISTRADOR','CAJERO')),
    Activo BIT NOT NULL DEFAULT 1
);

IF OBJECT_ID(N'dbo.Producto', N'U') IS NULL
CREATE TABLE dbo.Producto (
    idProducto BIGINT IDENTITY(1,1) PRIMARY KEY,
    Nombre NVARCHAR(120) NOT NULL,
    Categoria NVARCHAR(60) NULL,
    Estilo NVARCHAR(40) NULL,
    Coccion NVARCHAR(40) NULL,
    Tipo VARCHAR(20) NOT NULL,
    PrecioVigente DECIMAL(12,2) NOT NULL CHECK (PrecioVigente >= 0),
    Activo BIT NOT NULL DEFAULT 1
);

IF OBJECT_ID(N'dbo.Medio_Pago', N'U') IS NULL
CREATE TABLE dbo.Medio_Pago (
    idMedioPago SMALLINT IDENTITY(1,1) PRIMARY KEY,
    Nombre NVARCHAR(60) NOT NULL UNIQUE,
    Tipo VARCHAR(20) NOT NULL CHECK (Tipo IN ('DIGITAL','EFECTIVO')),
    Activo BIT NOT NULL DEFAULT 1
);

IF OBJECT_ID(N'dbo.Reserva', N'U') IS NULL
CREATE TABLE dbo.Reserva (
    idReserva UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    idCliente BIGINT NOT NULL REFERENCES dbo.Cliente(idCliente),
    Referencia VARCHAR(30) NOT NULL UNIQUE,
    Estado VARCHAR(24) NOT NULL,
    Origen VARCHAR(30) NULL,
    CreadaEn DATETIMEOFFSET(3) NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    VisitaEn DATETIMEOFFSET(3) NOT NULL,
    VenceAnticipoEn DATETIMEOFFSET(3) NOT NULL,
    AnticipoConfirmadoEn DATETIMEOFFSET(3) NULL,
    PersonasReservadas SMALLINT NOT NULL CHECK (PersonasReservadas BETWEEN 1 AND 40),
    TotalPactado DECIMAL(12,2) NOT NULL,
    AnticipoPactado DECIMAL(12,2) NOT NULL,
    AnticipoPorPersona DECIMAL(12,2) NOT NULL,
    CerradaEn DATETIMEOFFSET(3) NULL,
    RecordarEn DATETIMEOFFSET(3) NULL,
    SilenciarHasta DATETIMEOFFSET(3) NULL,
    CHECK (TotalPactado >= AnticipoPactado AND AnticipoPactado > 0)
);

IF OBJECT_ID(N'dbo.Detalle_Pedido', N'U') IS NULL
CREATE TABLE dbo.Detalle_Pedido (
    idDetalle BIGINT IDENTITY(1,1) PRIMARY KEY,
    idReserva UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Reserva(idReserva),
    idProducto BIGINT NOT NULL REFERENCES dbo.Producto(idProducto),
    Cantidad SMALLINT NOT NULL CHECK (Cantidad BETWEEN 1 AND 100),
    PrecioUnitarioPactado DECIMAL(12,2) NOT NULL CHECK (PrecioUnitarioPactado >= 0),
    DescuentoTotalLinea DECIMAL(12,2) NOT NULL DEFAULT 0,
    ImporteNetoLinea AS CONVERT(DECIMAL(12,2), Cantidad * PrecioUnitarioPactado - DescuentoTotalLinea) PERSISTED,
    CHECK (DescuentoTotalLinea >= 0 AND DescuentoTotalLinea <= Cantidad * PrecioUnitarioPactado)
);

IF OBJECT_ID(N'dbo.Intento_Pago', N'U') IS NULL
CREATE TABLE dbo.Intento_Pago (
    idIntento UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    idReserva UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Reserva(idReserva),
    idPersonalEmisor UNIQUEIDENTIFIER NULL REFERENCES dbo.Personal(idPersonal),
    idMedioElegido SMALLINT NULL REFERENCES dbo.Medio_Pago(idMedioPago),
    Numero TINYINT NOT NULL CHECK (Numero BETWEEN 1 AND 3),
    Finalidad VARCHAR(12) NOT NULL CHECK (Finalidad IN ('ANTICIPO','SALDO')),
    Estado VARCHAR(24) NOT NULL,
    ImporteSolicitado DECIMAL(12,2) NOT NULL CHECK (ImporteSolicitado > 0),
    CreadoEn DATETIMEOFFSET(3) NOT NULL,
    VenceEn DATETIMEOFFSET(3) NOT NULL,
    ReferenciaPasarela VARCHAR(100) NULL,
    UNIQUE (idReserva, Finalidad, Numero),
    CHECK (VenceEn >= CreadoEn)
);

IF OBJECT_ID(N'dbo.Movimiento_Pago', N'U') IS NULL
CREATE TABLE dbo.Movimiento_Pago (
    idMovimiento BIGINT IDENTITY(1,1) PRIMARY KEY,
    idReserva UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Reserva(idReserva),
    idIntento UNIQUEIDENTIFIER NULL REFERENCES dbo.Intento_Pago(idIntento),
    idMedioPago SMALLINT NOT NULL REFERENCES dbo.Medio_Pago(idMedioPago),
    idPersonal UNIQUEIDENTIFIER NULL REFERENCES dbo.Personal(idPersonal),
    idMovimientoOrigen BIGINT NULL REFERENCES dbo.Movimiento_Pago(idMovimiento),
    Proveedor VARCHAR(30) NOT NULL,
    OperacionExterna VARCHAR(100) NOT NULL,
    Finalidad VARCHAR(12) NOT NULL CHECK (Finalidad IN ('ANTICIPO','SALDO')),
    Aplicado BIT NOT NULL,
    Importe DECIMAL(12,2) NOT NULL CHECK (Importe <> 0),
    ConfirmadoEn DATETIMEOFFSET(3) NOT NULL,
    UNIQUE (Proveedor, OperacionExterna)
);

IF OBJECT_ID(N'dbo.Asistencia', N'U') IS NULL
CREATE TABLE dbo.Asistencia (
    idReserva UNIQUEIDENTIFIER PRIMARY KEY REFERENCES dbo.Reserva(idReserva),
    idCajero UNIQUEIDENTIFIER NULL REFERENCES dbo.Personal(idPersonal),
    Estado VARCHAR(24) NOT NULL CHECK (Estado IN ('POR_VERIFICAR','CONFIRMADA','NO_ASISTIO')),
    ReportadaEn DATETIMEOFFSET(3) NULL,
    VerificadaEn DATETIMEOFFSET(3) NULL,
    TitularPresente BIT NULL,
    ComensalesPresentes SMALLINT NULL CHECK (ComensalesPresentes BETWEEN 0 AND 40),
    CHECK (Estado <> 'CONFIRMADA' OR (idCajero IS NOT NULL AND VerificadaEn IS NOT NULL AND TitularPresente IS NOT NULL AND ComensalesPresentes IS NOT NULL))
);

IF OBJECT_ID(N'dbo.Comprobante', N'U') IS NULL
CREATE TABLE dbo.Comprobante (
    idComprobante BIGINT IDENTITY(1,1) PRIMARY KEY,
    idReserva UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Reserva(idReserva),
    idMovimiento BIGINT NULL REFERENCES dbo.Movimiento_Pago(idMovimiento),
    Numero VARCHAR(40) NOT NULL,
    Tipo VARCHAR(20) NOT NULL CHECK (Tipo IN ('ANTICIPO','SALDO','LIQUIDACION')),
    Importe DECIMAL(12,2) NOT NULL CHECK (Importe > 0),
    EmitidoEn DATETIMEOFFSET(3) NOT NULL,
    RevertidoEn DATETIMEOFFSET(3) NULL
);

IF OBJECT_ID(N'dbo.Incidencia', N'U') IS NULL
CREATE TABLE dbo.Incidencia (
    idIncidencia BIGINT IDENTITY(1,1) PRIMARY KEY,
    idReserva UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Reserva(idReserva),
    idPersonalResuelve UNIQUEIDENTIFIER NULL REFERENCES dbo.Personal(idPersonal),
    Tipo NVARCHAR(60) NOT NULL,
    Motivo NVARCHAR(500) NULL,
    AbiertaEn DATETIMEOFFSET(3) NOT NULL,
    ResueltaEn DATETIMEOFFSET(3) NULL,
    Resolucion NVARCHAR(500) NULL
);

IF OBJECT_ID(N'dbo.Evento_Reserva', N'U') IS NULL
CREATE TABLE dbo.Evento_Reserva (
    idEvento BIGINT IDENTITY(1,1) PRIMARY KEY,
    idReserva UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.Reserva(idReserva),
    idPersonal UNIQUEIDENTIFIER NULL REFERENCES dbo.Personal(idPersonal),
    Tipo NVARCHAR(100) NOT NULL,
    Actor NVARCHAR(100) NOT NULL,
    OcurridoEn DATETIMEOFFSET(3) NOT NULL,
    VisitaAnteriorEn DATETIMEOFFSET(3) NULL,
    VisitaNuevaEn DATETIMEOFFSET(3) NULL,
    Detalle NVARCHAR(MAX) NULL
);

IF OBJECT_ID(N'dbo.Mensaje_WhatsApp', N'U') IS NULL
CREATE TABLE dbo.Mensaje_WhatsApp (
    idMensaje BIGINT IDENTITY(1,1) PRIMARY KEY,
    idReserva UNIQUEIDENTIFIER NULL REFERENCES dbo.Reserva(idReserva),
    idMeta VARCHAR(128) NOT NULL UNIQUE,
    Telefono VARCHAR(16) NOT NULL,
    Direccion VARCHAR(12) NOT NULL,
    Estado VARCHAR(24) NULL,
    OcurridoEn DATETIMEOFFSET(3) NOT NULL,
    Texto NVARCHAR(MAX) NULL,
    ReferenciaMedio NVARCHAR(255) NULL
);

IF OBJECT_ID(N'dbo.Bloque_Disponibilidad', N'U') IS NULL
CREATE TABLE dbo.Bloque_Disponibilidad (
    idBloque UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    FechaLocal DATE NOT NULL,
    Tipo VARCHAR(20) NOT NULL,
    InicioEn DATETIMEOFFSET(3) NULL,
    FinEn DATETIMEOFFSET(3) NULL,
    Motivo NVARCHAR(240) NOT NULL
);

IF OBJECT_ID(N'dbo.Acceso_Cliente_OTP', N'U') IS NULL
CREATE TABLE dbo.Acceso_Cliente_OTP (
    idSolicitud UNIQUEIDENTIFIER PRIMARY KEY,
    idCliente BIGINT NOT NULL REFERENCES dbo.Cliente(idCliente),
    HashCodigo VARBINARY(32) NOT NULL,
    CreadoEn DATETIMEOFFSET(3) NOT NULL,
    VenceEn DATETIMEOFFSET(3) NOT NULL,
    UsadoEn DATETIMEOFFSET(3) NULL,
    IntentosFallidos TINYINT NOT NULL DEFAULT 0 CHECK (IntentosFallidos BETWEEN 0 AND 5)
);

COMMIT;
GO
