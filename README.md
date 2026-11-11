# El Establo · PAYERS

Software de demostración para la fase de cobranza de Parrilladas El Establo. Incluye el formulario de entrega de LEADS, 100 pedidos ficticios para precargar, panel de recepción y caja, historial, constancias imprimibles y reportes CSV. Cada reserva tiene un único pagador.

## Abrir en tu equipo

Desde esta carpeta, con Node.js 22.12 o superior:

```sh
npm ci
npm run dev
```

Abre **http://127.0.0.1:5173**. La prueba local guarda datos en PostgreSQL embebido dentro de `.data/`. Los 100 casos son borradores del formulario y no se insertan por defecto.

1. En **Registrar pedido**, abre **Ver 100 casos de ejemplo** y elige uno. Confirma que el pedido se acordó y regístralo.
2. En el detalle, genera y abre el enlace. Selecciona **Aprobar pago de prueba** o ensaya un rechazo y genera otro enlace.
3. Vuelve al panel y registra la llegada. Registra el saldo en caja y elige **Emitir y cerrar**.
4. Abre la constancia y visita **Reportes** para comprobar los cobros y exportarlos.

La simulación local y los pagos registrados en caja son de demostración. Las constancias se pueden imprimir o guardar como PDF y no tienen validez tributaria.

## Demostración con WhatsApp real y Mercado Pago de prueba

Para orquestar WhatsApp y alertas con n8n, usa la [guía de activación](n8n/Activacion.md) y el [workflow importable](n8n/Establo-PAYERS.json). Las reglas se editan en **Conexiones → Agente y alertas**.

Copia `.env.example` a `.env`. Mantén las claves en el servidor. Para exponer los webhooks usa un alojamiento Node o un túnel HTTPS que apunte a la instancia de demostración. Configura el origen HTTPS en `PUBLIC_URL`, una contraseña de administración de al menos 12 caracteres y un secreto de sesión aleatorio de al menos 32 caracteres. El panel solicitará la contraseña.

### 1. PostgreSQL en Supabase

1. Crea o selecciona un proyecto de Supabase y ejecuta [la migración de reservas](supabase/migrations/001_payers.sql), [la migración del agente](supabase/migrations/002_payers_agent.sql) y [la migración de contactos](supabase/migrations/003_contactos.sql) en ese orden en su editor SQL.
2. Configura `SUPABASE_URL` y `SUPABASE_SECRET_KEY` con la URL y una clave de servidor. La tabla está en el esquema `public`, con RLS y permisos retirados para `anon` y `authenticated`. React accede por la API del servidor.
3. El arranque con Supabase usa su registro remoto. Los pedidos de pruebas locales permanecen separados.

[Seguridad de la API de Supabase](https://supabase.com/docs/guides/api/securing-your-api)

### 2. Mercado Pago

1. En la integración de **Checkout Pro vía Preferences**, configura el vendedor y comprador de prueba. Completa `PAYMENT_MODE=mercado_pago`, `MP_TEST_ACCESS_TOKEN`, `MP_TEST_SELLER_ID` y `MP_TEST_BUYER_ID` con el ID numérico del comprador que aparece en Cuentas de prueba. El correo en `MP_TEST_BUYER_EMAIL` es opcional.
2. Configura la notificación **Pagos** en `https://TU-DOMINIO/api/webhooks/mercado-pago` y copia su secreto en `MP_WEBHOOK_SECRET`. Con el túnel temporal, actualiza la URL de prueba de Mercado Pago después de cada inicio; `start-demo.ps1` muestra la dirección vigente.
3. Abre el enlace generado en una ventana privada e inicia sesión con ese comprador de prueba. Usa una tarjeta o saldo ficticio de prueba. Checkout Pro redirige al `init_point`; PAYERS verifica por API el vendedor de prueba, el ID exacto del comprador de prueba, la reserva asociada, el importe y PEN antes de registrar el pago. El campo `live_mode` no se usa solo para clasificar las operaciones del flujo de usuarios de prueba.
4. PAYERS también reconcilia periódicamente los anticipos pendientes y verifica el pago al regresar desde Mercado Pago. Si el webhook y el retorno no se procesaron, pega el número de operación en la reserva y pulsa **Consultar pago**; el servidor vuelve a verificarlo directamente con Mercado Pago.

[Cuentas de prueba](https://www.mercadopago.com.pe/developers/en/docs/checkout-pro-preferences/test-accounts) · [Preferencias](https://www.mercadopago.com.pe/developers/es/reference/online-payments/checkout-pro-preferences/create-preference/post) · [Webhooks](https://www.mercadopago.com.pe/developers/en/docs/checkout-pro-orders/resources/notifications/webhooks)

### 3. WhatsApp Cloud API de Meta

1. Configura `WHATSAPP_MODE=cloud` y completa las variables `WA_` obligatorias. Usa la versión de Graph API que indique tu aplicación de Meta, con el prefijo `v`. `WA_ALLOWED_PHONES` es opcional: si se deja vacío, el agente atiende a cualquier número que le escriba; si se llena, solo atiende a esos números (coma-separados y con código de país). `WA_BLOCKED_PHONES` ignora por completo los números indicados. Los destinatarios del número de prueba de Meta se siguen agregando a mano en el panel de Meta; eso no se puede automatizar desde este código.
2. En Meta, registra `https://TU-DOMINIO/api/webhooks/whatsapp` con el mismo `WA_VERIFY_TOKEN`, suscribe `messages` y vincula la aplicación a la cuenta de WhatsApp Business. El servidor verifica la firma con `WA_APP_SECRET`.
3. Escribe desde cualquier número. Si el teléfono tiene reservas, el agente mantiene el menú o la lista de la mejora de experiencia. Si no tiene ninguna, responde con el aviso de cobranza y el botón **Hablar con alguien**; ese botón crea una consulta visible en **Conexiones → Consultas sin reserva**. El agente no negocia ni ofrece disponibilidad: solo cobranza de reservas ya registradas y, si `WA_RESERVATION_MODE` está habilitado, alta de un pedido ya acordado mediante el mensaje estructurado `RESERVA` (ver abajo). Un pedido de reserva escrito en texto libre se deriva al personal y, si el número tiene una reserva, abre la incidencia **Ayuda del personal**. Los mensajes **stop**, **baja**, **darme de baja** y **no quiero mensajes** dan de baja al número; **alta** revierte la baja.
4. Los mensajes interactivos solo se envían dentro de la ventana de 24 horas. Fuera de ella, configura las plantillas aprobadas `WA_TEMPLATE_DEPOSIT`, `WA_TEMPLATE_BALANCE`, `WA_TEMPLATE_CONFIRMATION` y `WA_TEMPLATE_SETTLEMENT`; las de anticipo y saldo usan nombre, referencia e importe y botón URL dinámico con base `https://TU-DOMINIO/pago/`. La confirmación lleva 5 variables de cuerpo (nombre, referencia, visita, anticipo, resumen) y botón URL dinámico con base `https://TU-DOMINIO/comprobante/`; la liquidación lleva 4 variables (nombre, referencia, total, detalle de pagos) y el mismo botón. La plantilla de visita conserva nombre, referencia, fecha y saldo. Ajusta las plantillas aprobadas en Meta para que coincidan con estos parámetros. La emisión y envío de constancias es automático; `ENABLE_REMINDERS=true` solo activa los avisos programados. Los envíos fallidos se reintentan y aparecen como incidencias.

Los botones y las filas usan identificadores `accion:REF` (`pay`, `yape`, `plin`, `bal`, `rcp`, `chg`, `hum`, `sel`), `menu` o `staff` sin referencia. El servidor resuelve la referencia solo entre las reservas del teléfono y no ejecuta acciones sensibles desde un botón. Para responder a quien escribe no se exige consentimiento; el consentimiento solo se exige para los mensajes que inicia el restaurante. Con dos o más reservas activas se envía una lista `sel:REF` agrupada por estado —**⏳ Por pagar anticipo**, **✅ Confirmadas**, **⚠️ Requieren atención** y **🧾 Finalizadas**—, con la visita futura más próxima primero y las pasadas al final. Las finalizadas solo se agregan si sobran filas; con una sola activa se muestra su menú directamente y, si solo hay finalizadas, se abre la más reciente. Los títulos usan la hora de Lima (`Hoy 20:16`, `Mañana 20:00`, `Vie 13 nov · 21:30`) y las descripciones combinan estado, personas en singular o plural y referencia. Se aplican los límites de WhatsApp (3 botones, 10 filas, títulos de 20/24 caracteres, descripciones de 72 y cuerpo de 1024); los emojis se usan con moderación (máximo uno por mensaje, sin comida en pagos o incidencias y sin emojis en botones). Si Meta rechaza un interactivo, se reintenta una vez como texto plano con la fecha y el estado de cada opción. El detalle está en [la guía de WhatsApp](WHATSAPP_INTEGRACION.md#botones-listas-y-cta).

#### Alta de reservas por mensaje estructurado

`WA_RESERVATION_MODE` controla esta ruta: `off` (predeterminado) mantiene el comportamiento actual, `staff` solo autoriza a los números de `WA_RESERVATION_STAFF` y `open` permite a cualquier remitente. Un mensaje que empieza con `RESERVA` crea un pedido ya acordado; el precio siempre sale del catálogo, nunca del mensaje. Después del alta se genera el enlace de anticipo, se registra el origen y el pedido entra en el motor de alertas y constancias como cualquier otro.

```text
RESERVA
Nombre: Ana Cárdenas
Telefono: 51999999999
Fecha: 2026-11-14
Hora: 20:00
Personas: 4
Items: 2x Parrilla familiar, 1x Parrilla personal, 1x Jarra de chicha morada
Notas: Cumpleaños de 40
Consentimiento: si
```

- `Nombre`, `Fecha` (`AAAA-MM-DD`), `Hora` (`HH:MM` de Lima), `Personas` (1–40) e `Items` son obligatorios. La visita debe ser futura y con al menos 2 horas de anticipo.
- `Items` usa el catálogo fijo de 12 productos y el formato `2x Producto`, con cantidades de 1 a 100 y hasta 30 líneas. No se aceptan importes por chat.
- Si `Telefono` falta, el pagador es el remitente y el consentimiento es implícito. Si `Telefono` es de un tercero, es un alta de operador: el pedido se crea con `consent: true` solo si el mensaje trae `Consentimiento: si`; la respuesta con el enlace vuelve al operador, no inicia una conversación con el tercero.
- Un reenvío con el mismo teléfono, fecha, personas y productos dentro de 10 minutos responde la reserva existente en lugar de duplicarla. Cada número admite hasta 3 pedidos abiertos en 30 días.
- Si el mensaje está incompleto o tiene un dato inválido no se registra nada: el bot responde el error exacto y deja una consulta abierta en **Conexiones → Consultas sin reserva**.
- El botón **Copiar plantilla de reserva** del formulario de registro deja el mensaje listo para pegar desde el celular.

[WhatsApp Cloud API de Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) · [Política de mensajería](https://whatsappbusiness.com/policy/)

### 4. Ejecutar la versión de demostración

```sh
npm ci
npm run build
npm start
```

La aplicación sirve la interfaz y los webhooks en el mismo origen. Mantén un proceso Node activo para recibir notificaciones y ejecutar los recordatorios. Selecciona `PORT` si el alojamiento lo requiere. La demostración utiliza un único acceso de operador y un catálogo editable al registrar el pedido. El alta y los cambios de fecha consultan aforo, horario y bloqueos; el cambio desde WhatsApp se confirma en una transacción.

## Alcance del agente

El agente solo gestiona cobranza y permite reprogramar reservas existentes que cumplan las reglas de elegibilidad. No ofrece disponibilidad para reservas nuevas ni negocia nuevas visitas. Si un mensaje pide reservar en texto libre, responde con un texto fijo y deriva al personal; no pregunta fecha, personas ni disponibilidad. La única puerta de alta es el mensaje estructurado `RESERVA` descrito arriba, y solo cuando `WA_RESERVATION_MODE` no es `off`.

El modo abierto es el predeterminado: `WA_ALLOWED_PHONES` vacío atiende a cualquier número. Si se llena, funciona como restricción opcional para demos controladas. `WA_BLOCKED_PHONES` ignora números por completo. Cada número puede enviar como máximo 20 mensajes cada 10 minutos (`WA_RATE_LIMIT_MAX` y `WA_RATE_LIMIT_WINDOW_MS`); al superar el límite se ignora el mensaje y se envía un solo aviso por ventana. A un número sin reservas se le responde como máximo una vez cada 12 horas, salvo que pulse **Hablar con alguien** o pida hablar con una persona. Las bajas y las consultas sin reserva se guardan en Supabase (migración `003_contactos.sql`) o en el PostgreSQL local; las consultas se ven en **Conexiones → Consultas sin reserva** y se pueden marcar como atendidas. Con el número de prueba de Meta, los destinatarios se siguen agregando a mano en el panel de Meta.

El agente usa OpenAI para clasificar mensajes y procesar imágenes y audios cuando se configura la clave. Cuenta con un clasificador local para texto como alternativa. Las respuestas se adaptan con el estado confirmado de la reserva. Los importes, los cierres y las devoluciones pasan por reglas de negocio. El historial conserva el origen de las confirmaciones.

La versión de demostración usa Mercado Pago Checkout Pro para anticipos y saldos, constancias internas y medios simulados de caja. Recepción registra la llegada y caja registra solo los pagos presenciales; el sistema genera y envía los links, verifica pagos, emite constancias y las entrega por WhatsApp. La disponibilidad se calcula por horario semanal, franja y aforo en personas; los bloqueos excepcionales se administran en **Conexiones → Disponibilidad**. Los valores iniciales son franja de 60 minutos, aforo de 40 personas, margen de 24 horas, máximo de 2 cambios del cliente y ventana de 30 días. El horario inicial es amplio para demostraciones: configúralo con el horario real antes de usar disponibilidad. Cambiar desde el panel no incrementa el contador. No hay mesas ni áreas.

Los cambios de fecha por WhatsApp se inician con el botón **Cambiar fecha** o con el texto exacto `reprogramar` / `cambiar fecha`. El cliente elige fecha, horario y confirma con botones. Solo se permiten reservas `awaiting_deposit` o `confirmed` cuyo teléfono coincida. Si el cupo se ocupa mientras el cliente confirma, PAYERS actualiza las opciones; si no hay alternativas o la reserva no cumple las reglas, deriva el caso al personal. El anticipo se conserva; para una reserva con anticipo pendiente, el vencimiento solo se puede acortar al nuevo horario, nunca extenderse automáticamente. Los cambios hechos desde el panel notifican al cliente; configura `WA_TEMPLATE_RESCHEDULE` con una plantilla aprobada de cuatro variables cuando no esté abierta la ventana de 24 horas. Para pagos de saldo, `balanceLinkExpiryMinutes` (default 30) y `maxBalanceLinks` (default 3) se ajustan en **Conexiones → Agente y alertas**. También configura `WA_TEMPLATE_BALANCE` cuando el envío pueda ocurrir fuera de la ventana de 24 horas.

Las migraciones de disponibilidad son `supabase/migrations/004_payers_availability.sql` y `supabase/migrations/005_availability_unconfigured.sql`. La 005 actualiza el RPC sin modificar la 004 ya aplicada. Para Supabase, revísalas y aplica solo las pendientes desde la raíz del proyecto con `npx supabase db push`. No se ejecutan automáticamente al iniciar PAYERS. La plantilla `WA_TEMPLATE_RESCHEDULE` debe existir y estar aprobada en Meta; el nombre exacto se coloca en `.env`.

```sh
npm test
npm run build
```

### Iniciar o detener la demo en Windows

En PowerShell, desde la raíz del proyecto:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\scripts\stop-demo.ps1
```

El inicio levanta el servidor y los túneles temporales y actualiza `PUBLIC_URL`. Las respuestas a mensajes se procesan directamente al llegar el webhook de Meta; n8n conserva las alertas programadas y la revisión de respaldo de la cola. Después de cada inicio debes actualizar en Meta la URL de devolución de WhatsApp y en Mercado Pago la URL de prueba de pagos. Ambas direcciones se muestran en la salida del comando. Los registros y la lista de procesos se guardan en `.demo/`.

Si ya hay una instancia n8n saludable en `N8N_PORT` y tiene registrado el webhook de producción del workflow, el script la reutiliza en lugar de iniciar otra; `stop-demo.ps1` no detiene esa instancia preexistente. Si el puerto 5173 sigue ocupado después de detener los procesos registrados, el inicio falla antes de levantar n8n o los túneles.

## Actualización PAYERS con portal y caja

### Crear la base y activar el portal

- **Supabase nuevo.** Ejecuta [01_supabase_creacion.sql](sql/01_supabase_creacion.sql) en el SQL Editor. Crea el almacenamiento operativo, las vistas de consulta y el esquema dimensional vacío.
- **Supabase de la demo existente.** Aplica las migraciones pendientes en orden. Si ya aplicaste la 005, empieza con la [006](supabase/migrations/006_payers_portal.sql) y sigue con la [007](supabase/migrations/007_payers_reporting.sql), la [008](supabase/migrations/008_payers_dimensional.sql) y la [009](supabase/migrations/009_payers_reprogramacion.sql).
- **SSMS.** Ejecuta [02_ssms_2022_creacion.sql](sql/02_ssms_2022_creacion.sql) en SQL Server 2022. Crea las bases vacías **ElEstablo_PAYERS_Transaccional** y **ElEstablo_PAYERS_Dimensional**. SQL Server guarda los archivos de datos en la ubicación predeterminada de la instancia. Abre **Database Diagrams** en cada base para mostrar las tablas y sus relaciones.

En el archivo .env existente agrega PAYERS_PORTAL=true y ADMIN_USERNAME=admin (o el usuario que prefieras). Conserva ADMIN_PASSWORD, SESSION_SECRET y las credenciales ya configuradas. El usuario inicial se habilita con esas variables. En **Personal**, un administrador puede crear las cuentas individuales de los cajeros. Si tienes la imagen de la carta, configura PUBLIC_MENU_IMAGE_URL con su enlace público HTTPS de res.cloudinary.com.

Para entrar a **/cliente**, registra un pedido con el celular que usará el pagador. La pantalla de acceso solicita un código enviado al mismo número. Configura WA_TEMPLATE_OTP con una plantilla aprobada de categoría **Autenticación** y botón **Copiar código**. En WA_TEMPLATE_OTP_LANGUAGE pon el idioma exacto de la plantilla de Meta. El código vence en cinco minutos, admite cinco comprobaciones fallidas y se consume al verificarlo. La demo con WhatsApp usa los destinatarios autorizados en Meta. El enlace de constancias que recibe el pagador lleva al portal.

### Cobranza y alertas con el portal activo

1. Desde el panel o WhatsApp se emite un enlace de anticipo. Se reutiliza mientras esté vigente. Desde **Conexiones** se ajustan la vigencia, la espera para reemitir y el máximo de hasta tres enlaces por finalidad. Si el pagador indica una hora futura antes del vencimiento, el agente programa ese aviso y pausa los demás recordatorios de anticipo hasta terminar el día acordado, en hora de Lima.
2. En el día de la visita, **Ya llegué** deja la asistencia **Por verificar**. El cajero confirma presencialmente, registra el número de asistentes e indica si está presente el titular.
3. En caja se confirma el efectivo o se envía el enlace de saldo. La página de pago ofrece Mercado Pago de prueba y las simulaciones Yape/Plin habilitadas. El efectivo se registra en caja. El anticipo aplicado y el saldo aplicado se concilian con el total del pedido para emitir la constancia de liquidación.
4. En **Reportes**, el administrador puede descargar M5, M1 o M3 en PDF. Mientras el esquema dimensional físico espera su carga, los PDF consultan las vistas de hechos construidas sobre la operación vigente. Los registros históricos de asistencia sin confirmación explícita de la presencia del titular no cuentan para M3.

El workflow [Establo-PAYERS.json](n8n/Establo-PAYERS.json) procesa la cola antes de evaluar los plazos y avisos en los ciclos programados. Reimporta y configura el workflow según [la guía de activación](n8n/Activacion.md). Los códigos de acceso se envían desde el servidor con Meta, y n8n recibe los conteos de procesamiento.
