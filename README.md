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

1. Crea o selecciona un proyecto de Supabase y ejecuta [la migración de reservas](supabase/migrations/001_payers.sql) y [la migración del agente](supabase/migrations/002_payers_agent.sql) en ese orden en su editor SQL.
2. Configura `SUPABASE_URL` y `SUPABASE_SECRET_KEY` con la URL y una clave de servidor. La tabla está en el esquema `public`, con RLS y permisos retirados para `anon` y `authenticated`. React accede por la API del servidor.
3. El arranque con Supabase usa su registro remoto. Los pedidos de pruebas locales permanecen separados.

[Seguridad de la API de Supabase](https://supabase.com/docs/guides/api/securing-your-api)

### 2. Mercado Pago

1. En la integración de **Checkout Pro vía Preferences**, configura el vendedor y comprador de prueba. Completa `PAYMENT_MODE=mercado_pago`, `MP_TEST_ACCESS_TOKEN` y `MP_TEST_SELLER_ID`. El correo en `MP_TEST_BUYER_EMAIL` es opcional. El comprador se identifica al iniciar sesión en el checkout.
2. Configura la notificación **Pagos** en `https://TU-DOMINIO/api/webhooks/mercado-pago` y copia su secreto en `MP_WEBHOOK_SECRET`.
3. Abre el enlace generado usando el comprador de prueba y una tarjeta de prueba. La aplicación usa el `init_point` de la preferencia y verifica la operación por API. El servidor exige que el token pertenezca al vendedor de prueba configurado y que el pago verificado indique modo de prueba.
4. Si el webhook no llega, en la reserva puedes pegar el número de operación y pulsar **Consultar pago**. El servidor vuelve a verificarla.

[Cuentas de prueba](https://www.mercadopago.com.pe/developers/en/docs/checkout-pro-preferences/test-accounts) · [Preferencias](https://www.mercadopago.com.pe/developers/es/reference/online-payments/checkout-pro-preferences/create-preference/post) · [Webhooks](https://www.mercadopago.com.pe/developers/en/docs/checkout-pro-orders/resources/notifications/webhooks)

### 3. WhatsApp Cloud API de Meta

1. Configura `WHATSAPP_MODE=cloud` y completa las variables `WA_` obligatorias. Usa la versión de Graph API que indique tu aplicación de Meta, con el prefijo `v`. En `WA_ALLOWED_PHONES`, coloca los números autorizados para la demostración, separados por comas y con código de país. Si usas el número de prueba de Meta, agrega también esos destinatarios en su panel.
2. En Meta, registra `https://TU-DOMINIO/api/webhooks/whatsapp` con el mismo `WA_VERIFY_TOKEN`, suscribe `messages` y vincula la aplicación a la cuenta de WhatsApp Business. El servidor verifica la firma con `WA_APP_SECRET`.
3. Registra un caso con el número de prueba autorizado y su permiso de contacto. Desde WhatsApp, escribe **hola** para recibir el menú de la reserva o **anticipo EST-XXXXXXXX** como respaldo. El agente responde con botones (**Pagar anticipo**, **Ver saldo**, **Hablar con alguien**) y un `cta_url` con el enlace de pago; si Yape o Plin de demostración están activos, ofrece un segundo mensaje con esos medios. También entiende **saldo**, **reprogramar**, **comprobante** y los comandos de texto anteriores. **Ayuda** ahora muestra el menú; para abrir una incidencia de personal usa **Hablar con alguien** o “quiero hablar con alguien”.
4. Los mensajes interactivos solo se envían dentro de la ventana de 24 horas. Fuera de ella, configura plantillas aprobadas: la de anticipo usa nombre, referencia e importe en el cuerpo y un botón URL dinámico con base `https://TU-DOMINIO/pago/`; las de visita y confirmación usan nombre, referencia, fecha de visita y saldo en ese orden. La constancia puede solicitarse desde el chat y, con sesión abierta, se envía como `cta_url` **Ver constancia**. Para habilitar avisos automáticos, establece `ENABLE_REMINDERS=true`. Los mensajes fallidos aparecen como incidencias.

Los botones y las filas usan identificadores `accion:REF` (`pay`, `yape`, `plin`, `bal`, `rcp`, `chg`, `hum`, `sel`) o `menu`. El servidor resuelve la referencia solo entre las reservas con consentimiento del teléfono y no ejecuta acciones sensibles desde un botón. Con dos o más reservas activas se envía una lista `sel:REF` agrupada por estado —**⏳ Por pagar anticipo**, **✅ Confirmadas**, **⚠️ Requieren atención** y **🧾 Finalizadas**—, con la visita futura más próxima primero y las pasadas al final. Las finalizadas solo se agregan si sobran filas; con una sola activa se muestra su menú directamente y, si solo hay finalizadas, se abre la más reciente. Los títulos usan la hora de Lima (`Hoy 20:16`, `Mañana 20:00`, `Vie 13 nov · 21:30`) y las descripciones combinan estado, personas en singular o plural y referencia. Se aplican los límites de WhatsApp (3 botones, 10 filas, títulos de 20/24 caracteres, descripciones de 72 y cuerpo de 1024); los emojis se usan con moderación (máximo uno por mensaje, sin comida en pagos o incidencias y sin emojis en botones). Si Meta rechaza un interactivo, se reintenta una vez como texto plano con la fecha y el estado de cada opción. El detalle está en [la guía de WhatsApp](WHATSAPP_INTEGRACION.md#botones-listas-y-cta).

[WhatsApp Cloud API de Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) · [Política de mensajería](https://whatsappbusiness.com/policy/)

### 4. Ejecutar la versión de demostración

```sh
npm ci
npm run build
npm start
```

La aplicación sirve la interfaz y los webhooks en el mismo origen. Mantén un proceso Node activo para recibir notificaciones y ejecutar los recordatorios. Selecciona `PORT` si el alojamiento lo requiere. La demostración utiliza un único acceso de operador y un catálogo editable al registrar el pedido. Recepción y caja validan el cupo y los cambios autorizados.

## Alcance del agente

El agente usa OpenAI para clasificar mensajes y procesar imágenes y audios cuando se configura la clave. Cuenta con un clasificador local para texto como alternativa. Las respuestas se adaptan con el estado confirmado de la reserva. Los importes, los cierres y las devoluciones pasan por reglas de negocio. El historial conserva el origen de las confirmaciones.

La versión de demostración usa constancias internas, un único operador y registro manual de caja. La emisión tributaria, la integración con POS y la disponibilidad de mesas se conectan al sistema del restaurante cuando existan proveedores y políticas definidos. El alojamiento externo y las credenciales de Meta, Mercado Pago y Supabase son necesarios para validar la demostración integrada.

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

El inicio levanta el servidor y los túneles temporales, actualiza `PUBLIC_URL` y, si `AGENT_ORCHESTRATION=n8n`, `N8N_WAKE_URL`. Después de cada inicio debes actualizar en Meta la URL de devolución del webhook. Los registros y la lista de procesos se guardan en `.demo/`.
