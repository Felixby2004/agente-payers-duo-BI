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

Copia `.env.example` a `.env`. Mantén las claves en el servidor. Para la demo, `scripts/start-demo.ps1` expone PAYERS con el dominio fijo gratuito de ngrok. Configura `NGROK_DOMAIN` (solo el dominio, sin protocolo) y el mismo origen en `PUBLIC_URL`; el script usa el dominio de `NGROK_DOMAIN` solo para el proceso y nunca modifica `.env` ni su copia. Usa también una contraseña de administración de al menos 12 caracteres y un secreto de sesión aleatorio de al menos 32 caracteres.

### 1. PostgreSQL en Supabase

1. Crea o selecciona un proyecto de Supabase y ejecuta [la migración de reservas](supabase/migrations/001_payers.sql), [la migración del agente](supabase/migrations/002_payers_agent.sql) y [la migración de contactos](supabase/migrations/003_contactos.sql) en ese orden en su editor SQL.
2. Configura `SUPABASE_URL` y `SUPABASE_SECRET_KEY` con la URL y una clave de servidor. La tabla está en el esquema `public`, con RLS y permisos retirados para `anon` y `authenticated`. React accede por la API del servidor.
3. El arranque con Supabase usa su registro remoto. Los pedidos de pruebas locales permanecen separados.

[Seguridad de la API de Supabase](https://supabase.com/docs/guides/api/securing-your-api)

### 2. Mercado Pago

1. En la integración de **Checkout Pro vía Preferences**, configura el vendedor y comprador de prueba. Completa `PAYMENT_MODE=mercado_pago`, `MP_TEST_ACCESS_TOKEN`, `MP_TEST_SELLER_ID` y `MP_TEST_BUYER_ID` con el ID numérico del comprador que aparece en Cuentas de prueba. El correo en `MP_TEST_BUYER_EMAIL` es opcional.
2. Configura la notificación **Pagos** en `https://TU-DOMINIO/api/webhooks/mercado-pago` y copia su secreto en `MP_WEBHOOK_SECRET`. Con el dominio fijo de ngrok, registra la URL una sola vez; `start-demo.ps1` la vuelve a mostrar en cada inicio.
3. Abre el enlace generado en una ventana privada e inicia sesión con ese comprador de prueba. Usa una tarjeta o saldo ficticio de prueba. Checkout Pro redirige al `init_point`; PAYERS verifica por API el vendedor de prueba, el ID exacto del comprador de prueba, la reserva asociada, el importe y PEN antes de registrar el pago. El campo `live_mode` no se usa solo para clasificar las operaciones del flujo de usuarios de prueba.
4. PAYERS también reconcilia periódicamente los anticipos pendientes y verifica el pago al regresar desde Mercado Pago. Si el webhook y el retorno no se procesaron, pega el número de operación en la reserva y pulsa **Consultar pago**; el servidor vuelve a verificarlo directamente con Mercado Pago.

[Cuentas de prueba](https://www.mercadopago.com.pe/developers/en/docs/checkout-pro-preferences/test-accounts) · [Preferencias](https://www.mercadopago.com.pe/developers/es/reference/online-payments/checkout-pro-preferences/create-preference/post) · [Webhooks](https://www.mercadopago.com.pe/developers/en/docs/checkout-pro-orders/resources/notifications/webhooks)

### 3. WhatsApp Cloud API de Meta

1. Configura `WHATSAPP_MODE=cloud` y completa las variables `WA_` obligatorias. Usa la versión de Graph API que indique tu aplicación de Meta, con el prefijo `v`. `WA_ALLOWED_PHONES` es opcional: si se deja vacío, el agente atiende a cualquier número que le escriba; si se llena, solo atiende a esos números (coma-separados y con código de país). `WA_BLOCKED_PHONES` ignora por completo los números indicados. Los destinatarios del número de prueba de Meta se siguen agregando a mano en el panel de Meta; eso no se puede automatizar desde este código.
2. En Meta, registra `https://TU-DOMINIO/api/webhooks/whatsapp` con el mismo `WA_VERIFY_TOKEN`, suscribe `messages` y vincula la aplicación a la cuenta de WhatsApp Business. El servidor verifica la firma con `WA_APP_SECRET`.
3. Al escribir **hola**, el agente muestra **Ver mis reservas**, **Hacer una reserva** y **Hablar con alguien**. También reconoce solicitudes escritas como “ver mis reservas” o “quiero hacer una reserva”. Para una reserva nueva envía primero el formato estructurado; al recibirlo comprueba el horario y aforo antes de registrar. Si hay cupo, crea la reserva y continúa con el anticipo; si no, no la registra y permite volver a intentar con otra fecha u hora. Las reservas existentes mantienen sus opciones de cobranza y reprogramación. Los mensajes **stop**, **baja**, **darme de baja** y **no quiero mensajes** dan de baja al número; **alta** revierte la baja.
4. Los mensajes interactivos solo se envían dentro de la ventana de 24 horas. Fuera de ella, configura las plantillas aprobadas `WA_TEMPLATE_DEPOSIT`, `WA_TEMPLATE_BALANCE`, `WA_TEMPLATE_CONFIRMATION`, `WA_TEMPLATE_BALANCE_RECEIPT` y `WA_TEMPLATE_SETTLEMENT`. Anticipo y saldo por pagar usan botón URL dinámico con base `https://TU-DOMINIO/pago/`. La confirmación de anticipo y el comprobante del saldo usan la URL de comprobante de Mercado Pago (`https://www.mercadopago.com.pe/ccap/file-viewer/receipt?flow=cow_payment_receipts&origin=feedback-screen&payment_id=`) como base, con el id de operación agregado por PAYERS. La plantilla de liquidación conserva el botón de constancia propia con base `https://TU-DOMINIO/comprobante/` y token dinámico. La confirmación lleva 5 variables de cuerpo; comprobante de saldo, 4; liquidación, 4. La plantilla de visita conserva nombre, referencia, fecha y saldo. Ajusta las plantillas aprobadas en Meta para que coincidan con estos parámetros. La emisión y envío de constancias es automático; `ENABLE_REMINDERS=true` solo activa los avisos programados. Los envíos fallidos se reintentan y aparecen como incidencias.

Los botones y las filas usan identificadores `accion:REF` (`pay`, `bal`, `rcp`, `chg`, `hum`, `sel`), `menu` o `staff` sin referencia. El servidor resuelve la referencia solo entre las reservas del teléfono y no ejecuta acciones sensibles desde un botón. Para responder a quien escribe no se exige consentimiento; el consentimiento solo se exige para los mensajes que inicia el restaurante. Con dos o más reservas activas se envía una lista `sel:REF` agrupada por estado —**⏳ Por pagar anticipo**, **✅ Confirmadas**, **⚠️ Requieren atención** y **🧾 Finalizadas**—, con la visita futura más próxima primero y las pasadas al final. Las finalizadas solo se agregan si sobran filas; con una sola activa se muestra su menú directamente y, si solo hay finalizadas, se abre la más reciente. Los títulos usan la hora de Lima (`Hoy 20:16`, `Mañana 20:00`, `Vie 13 nov · 21:30`) y las descripciones combinan estado, personas en singular o plural y referencia. Se aplican los límites de WhatsApp (3 botones, 10 filas, títulos de 20/24 caracteres, descripciones de 72 y cuerpo de 1024); los emojis se usan con moderación (máximo uno por mensaje, sin comida en pagos o incidencias y sin emojis en botones). Si Meta rechaza un interactivo, se reintenta una vez como texto plano con la fecha y el estado de cada opción. El detalle está en [la guía de WhatsApp](WHATSAPP_INTEGRACION.md#botones-listas-y-cta).

#### Alta de reservas por mensaje estructurado

`WA_RESERVATION_MODE` controla esta ruta: `open` (predeterminado) permite a cualquier remitente permitido, `staff` solo autoriza a los números de `WA_RESERVATION_STAFF` y `off` desactiva el registro por WhatsApp. Cuando el cliente pide una reserva, PAYERS le envía primero el formato; solo un mensaje posterior que empieza con `RESERVA` puede registrar el pedido. El servidor comprueba disponibilidad si el horario y aforo están configurados; si la franja no tiene cupo, no crea la reserva ni ofrece horarios alternativos. El precio siempre sale del catálogo, nunca del mensaje. Si el cupo existe, genera el enlace de anticipo y activa alertas y constancias como en cualquier reserva.

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

- `Nombre`, `Fecha` (`AAAA-MM-DD`), `Hora` (`HH:MM` de Lima), `Personas` (1–40) e `Items` son obligatorios. La anticipación mínima se configura en **Conexiones → Agente y alertas** con `minReservationNoticeMinutes` (120 minutos por defecto). Para probar con poca anticipación, usa **Preparar prueba rápida** y luego restaura los valores habituales.
- `Items` usa el catálogo fijo de 12 productos y el formato `2x Producto`, con cantidades de 1 a 100 y hasta 30 líneas. No se aceptan importes por chat.
- Si `Telefono` falta, el pagador es el remitente y el consentimiento es implícito. Si `Telefono` es de un tercero, es un alta de operador: el pedido se crea con `consent: true` solo si el mensaje trae `Consentimiento: si`; la respuesta con el enlace vuelve al operador, no inicia una conversación con el tercero.
- Un reenvío con el mismo teléfono, fecha, personas y productos dentro de 10 minutos responde la reserva existente en lugar de duplicarla. El máximo de reservas abiertas por número en los últimos 30 días se configura en **Conexiones → Agente y alertas**; el valor inicial es 3.
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

El agente gestiona la cobranza y la reprogramación elegible de reservas existentes. Para una reserva nueva, responde con un formato estructurado y valida la disponibilidad únicamente cuando el cliente lo devuelve completo; no conversa libremente para negociar fecha, personas ni precio. La configuración `WA_RESERVATION_MODE` controla quién puede completar esa alta.

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

El inicio compila siempre la interfaz con `npm run build` y luego levanta PAYERS y un solo túnel ngrok hacia `127.0.0.1:5173`; ya no reutiliza una carpeta `dist` antigua. Si la compilación falla, conserva el registro de procesos anterior y no reinicia el servidor. Para omitir la compilación explícitamente usa `-NoBuild`. `-RestartServer` también recompila la interfaz y reinicia PAYERS, manteniendo ngrok y n8n. Instala ngrok con `winget install ngrok.ngrok`, configura una vez el authtoken local con `ngrok config add-authtoken` (no lo pegues en el repositorio) y crea/consulta el dominio gratuito en el panel de ngrok, sección **Domains**. Guarda ese dominio en `NGROK_DOMAIN`. El plan gratuito puede imponer límites de uso, sesiones y disponibilidad; revisa los límites y créditos vigentes en tu panel de ngrok. No se afirma aquí una cuota numérica.

El script imprime estas dos URL estables para registrarlas una sola vez:

- Meta: `https://<NGROK_DOMAIN>/api/webhooks/whatsapp`
- Mercado Pago: `https://<NGROK_DOMAIN>/api/webhooks/mercado-pago`

Ya no cambian al reiniciar mientras conserves el dominio de ngrok. El script deja las variables `PUBLIC_URL` y `N8N_WAKE_URL` en el entorno de PAYERS durante el inicio, sin escribir `.env` ni `.env.backup`; si `PUBLIC_URL` discrepa, muestra una advertencia. Para revisar el túnel, abre `http://127.0.0.1:4040` o consulta `http://127.0.0.1:4040/api/tunnels`. Los logs propios del túnel están en `.demo/ngrok.out.log` y `.demo/ngrok.err.log`.

n8n no usa túnel: el workflow llama a PAYERS en `http://127.0.0.1:5173`, y PAYERS despierta n8n por `http://127.0.0.1:5678/webhook/establo-payers-despertar` con su cabecera interna. Meta y Mercado Pago solo llaman a los webhooks de PAYERS. El script solo revisa `http://127.0.0.1:5678/healthz`; confirma que el workflow esté **activo** en n8n para habilitar su webhook de producción y las alertas programadas. No activa el workflow automáticamente.

El plan gratuito de ngrok muestra una página de aviso al abrir una URL pública desde un navegador. Las llamadas de webhook de Meta y Mercado Pago, que son servidor a servidor, no se ven afectadas. Un cliente puede ver el aviso antes de llegar al portal o panel público, a un enlace de pago (`/pago/...`), a un retorno de Mercado Pago y a una constancia (`/comprobante/...`). Las peticiones internas de PAYERS a su propia URL pública deben enviar `ngrok-skip-browser-warning`; el script lo usa en su comprobación de salud. Conserva tu PC encendida, conectada a internet y con el servidor/ngrok en ejecución mientras quieras recibir webhooks.

Los registros y la lista de procesos (incluido el PID de ngrok) se guardan en `.demo/`. Para apagar lo que inició la demo, ejecuta una sola vez `powershell -ExecutionPolicy Bypass -File .\scripts\stop-demo.ps1`; detiene procesos propios que sigan coincidiendo con PID y hora de inicio y nunca elimina sesiones de ngrok ajenas.

Si ya hay una instancia n8n saludable en `N8N_PORT` y tiene registrado el webhook de producción del workflow, el script la reutiliza en lugar de iniciar otra; `stop-demo.ps1` no detiene esa instancia preexistente. Si el puerto 5173 sigue ocupado después de detener los procesos registrados, el inicio falla antes de levantar n8n o los túneles.

## Actualización PAYERS con portal y caja

### Crear la base y activar el portal

- **Supabase nuevo.** Ejecuta [01_supabase_creacion.sql](sql/01_supabase_creacion.sql) en el SQL Editor. Crea el almacenamiento operativo, las vistas de consulta y el esquema dimensional vacío.
- **Supabase de la demo existente.** Aplica las migraciones pendientes en orden. Si ya aplicaste la 005, ejecuta la [006](supabase/migrations/006_payers_portal.sql), [007](supabase/migrations/007_payers_reporting.sql), [008](supabase/migrations/008_payers_dimensional.sql), [009](supabase/migrations/009_payers_reprogramacion.sql) y [010](supabase/migrations/010_payers_expired_deposit_rules.sql). La 010 contiene el SQL para pegar en el editor de Supabase y reemplaza las funciones RPC necesarias sin modificar migraciones aplicadas.
- **SSMS.** Ejecuta [02_ssms_2022_creacion.sql](sql/02_ssms_2022_creacion.sql) en SQL Server 2022. Crea las bases vacías **ElEstablo_PAYERS_Transaccional** y **ElEstablo_PAYERS_Dimensional**. SQL Server guarda los archivos de datos en la ubicación predeterminada de la instancia. Abre **Database Diagrams** en cada base para mostrar las tablas y sus relaciones.

En el archivo .env existente agrega PAYERS_PORTAL=true y ADMIN_USERNAME=admin (o el usuario que prefieras). Conserva ADMIN_PASSWORD, SESSION_SECRET y las credenciales ya configuradas. El usuario inicial se habilita con esas variables. En **Personal**, un administrador puede crear las cuentas individuales de los cajeros. Si tienes la imagen de la carta, configura PUBLIC_MENU_IMAGE_URL con su enlace público HTTPS de res.cloudinary.com.

Para entrar a **/cliente**, registra un pedido con el celular que usará el pagador. Por defecto, configura `WA_TEMPLATE_OTP` con una plantilla aprobada de categoría **Autenticación** y botón **Copiar código**; `WA_TEMPLATE_OTP_LANGUAGE` debe coincidir con el idioma exacto de Meta. Para probar con el número temporal de Meta, que puede no permitir crear plantillas, puedes activar `WA_OTP_FREE_FORM=true`: PAYERS enviará el código como texto libre solo si el cliente escribió al WhatsApp en las últimas 24 horas. La comprobación usa el mensaje entrante que PAYERS guardó en el historial, no consulta la ventana directamente a Meta. Por eso, durante la demostración deja activo el túnel HTTPS y asegúrate de que el webhook de Meta apunte a la dirección pública actual y siga llegando a PAYERS; si el mensaje no se recibe o procesa, la sesión no se abrirá. Si la ventana está cerrada no envía el código; pídele que escriba **hola** al número de El Establo y vuelve a solicitarlo. Esta opción existe para probar con el número de prueba, solo funciona con la ventana abierta y no debe usarse en producción. Cuando tengas una plantilla OTP aprobada, deja `WA_OTP_FREE_FORM=false` y configura `WA_TEMPLATE_OTP` y el idioma. La respuesta del portal es genérica en todos los casos e incluye la opción para solicitar otro código. El código vence en cinco minutos, admite cinco comprobaciones fallidas y se consume al verificarlo; solo se almacena como digest y no se agrega al historial del pedido. La demo con WhatsApp usa los destinatarios autorizados en Meta. El enlace de constancias que recibe el pagador lleva al portal.

Registrar la llegada en caja solo actualiza la asistencia. PAYERS no envía automáticamente el enlace de saldo en ese momento. Si el cliente escribe **«ya llegué»** o una variante, la reserva queda **Por verificar**, caja recibe el aviso y el cliente debe esperar la confirmación del personal. Al confirmar la asistencia, PAYERS le envía **«Asistencia confirmada»** por WhatsApp; si el envío falla, queda una incidencia con opción de reintento. Después de registrar la llegada, si el cliente pulsa **Solicitar pago en línea** o escribe **«quiero pagar»**/**«pagar saldo»**, PAYERS registra **Solicitud de pago en línea** en el panel, asociándola a la reserva mencionada recientemente. No envía el enlace hasta que el personal pulse **Enviar enlace solicitado** en el detalle de la reserva. Si no hay una reserva identificable en la conversación, el cliente elige una en la lista de WhatsApp. Al completar el pago, el mensaje de liquidación incluye un agradecimiento. Un envío manual fallido abre **Envío del link de saldo pendiente** y conserva la incidencia para el personal. Los envíos manuales fallidos de saldo, recordatorios o constancias también muestran el motivo, incluido el código y detalle de un rechazo de Meta cuando están disponibles. n8n procesa la bandeja antes de las alertas; un recordatorio fallido vuelve a intentarse dentro de **Evaluar alertas configuradas** hasta tres veces, con al menos 15 minutos entre intentos y solo mientras siga siendo pertinente y dentro del horario de contacto. Si se agotan los intentos, queda una sola incidencia. Los recordatorios ya entregados no se vuelven a enviar, y se permite como máximo un reintento de recordatorio por ciclo de alertas.

Durante la tolerancia, el personal puede validar a quien llegue aunque no haya escrito por WhatsApp. Al terminar el margen, si la reserva sigue confirmada y no hay aviso de llegada pendiente, el panel permite registrar la inasistencia. PAYERS guarda el estado y el historial, y avisa al cliente por WhatsApp. Con la ventana de 24 horas abierta, envía un mensaje normal. Fuera de la ventana requiere una plantilla aprobada configurada como `WA_TEMPLATE_NO_SHOW` (tres variables: pagador, referencia y fecha/hora), por ejemplo: `Hola {{1}}, el personal registró que no asististe a la reserva {{2}} programada para {{3}}. Si sí acudiste o necesitas revisar el anticipo, responde a este mensaje para que podamos ayudarte.` Si falta la plantilla, no hay autorización de contacto o Meta la rechaza, se abre **Aviso de inasistencia pendiente** y el personal puede reintentar desde la reserva. El número de prueba de Meta no recibe mensajes fuera de ventana sin una plantilla aprobada. No se puede marcar inasistencia si hay un aviso «ya llegué» pendiente de verificar.

Las reservas sin anticipo dejan de ocupar aforo cuando vence su plazo. El proceso de alertas las cancela después de `autoCancelExpiredHours` (24 por defecto; 0 desactiva la cancelación), siempre que no tengan pagos. El cliente puede pedir una renovación (`depositRenewalsMax`, por defecto 1) si quedan más de dos horas para la visita y hay cupo. `renewDepositMinutes` define la duración del plazo renovado y no puede superar la hora de visita. El personal puede usar **Reabrir plazo** desde el panel.

Para verificar los cambios en Windows/PowerShell, ejecuta `npm test` y `npm run build`. Después de aplicar las migraciones pendientes en Supabase, reinicia PAYERS con `npm run start` (o `npm run dev` durante desarrollo). Estos comandos se proporcionan como referencia; la migración y los servicios deben ejecutarse manualmente en el entorno correspondiente.

### Cobranza y alertas con el portal activo

#### IA opcional (Gemini u OpenAI)

La IA es un apoyo, no reemplaza el flujo determinista ni las verificaciones del sistema. Para usar Gemini, configura `AI_PROVIDER=gemini` y `GEMINI_API_KEY` en el `.env` del servidor. El modelo configurable `GEMINI_MODEL` usa por defecto `gemini-3.8-flash` para clasificación, imágenes y recomendaciones. Las notas de voz usan por separado `GEMINI_TRANSCRIPTION_MODEL`, por defecto `gemini-3.5-transcribe`, especializado en voz a texto. PAYERS sube temporalmente el audio con Files API, pide la transcripción en español latinoamericano con vocabulario del restaurante y luego solicita borrar el archivo. La solicitud de transcripción usa Interactions API y `store=false`. Si omites `AI_PROVIDER`, PAYERS elige Gemini cuando encuentra `GEMINI_API_KEY`; si no, conserva OpenAI mediante `OPENAI_API_KEY`. El texto se clasifica primero localmente y solo se consulta a Gemini cuando el resultado local es desconocido. Si Gemini falla, vuelve al clasificador local. OpenAI sigue disponible como proveedor alternativo.

Gemini ayuda a clasificar consultas ambiguas, identificar el tipo y prioridad sugeridos de una dificultad de pago, extraer importe/operación/medio visibles de una imagen y transcribir notas de voz. La respuesta personalizada ante una dificultad solo añade una frase empática a la respuesta fija del agente; no confirma pagos ni promete acciones. Una imagen solo crea una revisión: la IA nunca confirma pagos. Las intenciones de texto pasan por las reglas existentes; tampoco pueden confirmar pagos, cambiar reservas ni realizar acciones por sí solas.

Los recordatorios de anticipo mantienen importes, fechas, links y estados calculados por PAYERS. Cuando existe una dificultad de pago sin resolver y el cliente tiene abierta la ventana de WhatsApp, Gemini puede generar una breve frase empática que se agrega al recordatorio. Fuera de la ventana se conserva la plantilla fija; no se intenta personalizar con texto libre. En **Reportes → Recomendaciones de mejora**, un administrador puede pedir un análisis de hasta 93 días. Se envían solo conteos agregados (sin teléfonos, nombres, referencias ni datos de pago), y las sugerencias nunca cambian automáticamente la operación.

El nivel gratuito tiene límites de solicitudes por minuto, tokens por minuto y solicitudes diarias; varían según el modelo y el proyecto, y se consultan en **AI Studio → Usage / Rate limits**. Ante respuestas `429` o `503`, PAYERS no repite de inmediato la misma nota de voz por otra ruta: responde que el servicio o límite no está disponible y permite continuar por texto. La disponibilidad gratuita de cada modelo también puede variar. En el nivel gratuito, el contenido puede ser usado por Google para mejorar sus productos; evita enviar información sensible que no sea necesaria. Revisa [límites](https://ai.google.dev/gemini-api/docs/rate-limits), [transcripción de audio](https://ai.google.dev/gemini-api/docs/transcribe?hl=es-419), [precios y condiciones del nivel gratuito](https://ai.google.dev/gemini-api/docs/pricing) y [modelos disponibles](https://ai.google.dev/gemini-api/docs/models).

1. Desde el panel o WhatsApp se emite un enlace de anticipo. Se reutiliza mientras esté vigente. Desde **Conexiones** se ajustan la vigencia, la espera para reemitir y el máximo de hasta tres enlaces por finalidad. Si el pagador indica una hora futura antes del vencimiento, el agente programa ese aviso y pausa los demás recordatorios de anticipo hasta terminar el día acordado, en hora de Lima.
2. En el día de la visita, **Ya llegué** deja la asistencia **Por verificar**. El cajero confirma presencialmente, registra el número de asistentes e indica si está presente el titular.
3. En caja se confirma el efectivo o se envía el enlace de saldo. Los pagos en línea se procesan con Mercado Pago; en modo local se pueden simular para ensayar el flujo. El efectivo se registra en caja. El anticipo aplicado y el saldo aplicado se concilian con el total del pedido para emitir la constancia de liquidación.
4. En **Reportes**, el administrador puede descargar M5, M1 o M3 en PDF. Mientras el esquema dimensional físico espera su carga, los PDF consultan las vistas de hechos construidas sobre la operación vigente. Los registros históricos de asistencia sin confirmación explícita de la presencia del titular no cuentan para M3.

El workflow [Establo-PAYERS.json](n8n/Establo-PAYERS.json) procesa la cola antes de evaluar los plazos y avisos en los ciclos programados. Reimporta y configura el workflow según [la guía de activación](n8n/Activacion.md). Los códigos de acceso se envían desde el servidor con Meta, y n8n recibe los conteos de procesamiento.
