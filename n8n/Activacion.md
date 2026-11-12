# Activación de WhatsApp, n8n y pagos de demostración

El panel, la API y n8n comparten las reservas a través del servidor PAYERS. En modo alojado, PostgreSQL de Supabase conserva las reservas, la cola de WhatsApp y las reglas editadas por administración. Meta entrega eventos a la API del restaurante. n8n procesa los eventos registrados y revisa las alertas programadas.

## 1. Preparar el servidor y Supabase

1. Ejecuta `001_payers.sql` y `002_payers_agent.sql` en el editor SQL del proyecto Supabase, en ese orden. Si la primera migración ya está aplicada, ejecuta la segunda.
2. Completa los campos de servidor de `.env` tomando como referencia `.env.example`. Configura `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, una contraseña de administración de al menos 12 caracteres y un secreto de sesión de al menos 32 caracteres. Mantén las claves en el servidor.
3. Para la demo, `scripts/start-demo.ps1` expone PAYERS con el dominio fijo gratuito de ngrok. `NGROK_DOMAIN` debe contener el dominio de tu cuenta (sin `https://`); consulta o crea el dominio en el panel de ngrok, sección **Domains**. El script asigna `PUBLIC_URL` al proceso PAYERS sin modificar `.env`.
4. Configura `AGENT_ORCHESTRATION=n8n` y un `N8N_AGENT_TOKEN` aleatorio de al menos 32 caracteres. Las llamadas de n8n usan este token. Las claves de Meta, Mercado Pago, OpenAI y Supabase quedan en el servidor.

### Túnel HTTPS fijo de la demostración

1. Instala ngrok con `winget install ngrok.ngrok` y configura el authtoken de forma local con `ngrok config add-authtoken`. No guardes el authtoken en `.env`, el repositorio ni los logs.
2. En el panel de ngrok, sección **Domains**, copia el dominio fijo gratuito de tu cuenta y ponlo en `NGROK_DOMAIN` de `.env`, sin protocolo. Alinea `PUBLIC_URL` con ese origen HTTPS. El script advertirá si no coinciden y usará el dominio fijo solo para el proceso.
3. Desde PowerShell, ejecuta `powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1`. El script levanta solo un túnel para PAYERS en `127.0.0.1:5173`; la inspección local de ngrok está en `http://127.0.0.1:4040`. Detén todo con `powershell -ExecutionPolicy Bypass -File .\scripts\stop-demo.ps1`.
4. Registra una sola vez en Meta `https://<NGROK_DOMAIN>/api/webhooks/whatsapp` y en Mercado Pago `https://<NGROK_DOMAIN>/api/webhooks/mercado-pago`. Las URL permanecen iguales entre reinicios mientras uses ese dominio.
5. La advertencia del navegador del plan gratuito puede aparecer al cliente antes del portal, los enlaces de pago y retorno de Mercado Pago o las constancias. Las llamadas webhook de servidor a servidor no muestran esa página. PAYERS añade `ngrok-skip-browser-warning` cuando necesita consultar su propio dominio público.

n8n no lleva túnel: su workflow llama a PAYERS por `http://127.0.0.1:5173`; PAYERS despierta el webhook de producción por `http://127.0.0.1:5678/webhook/establo-payers-despertar`, enviando el token interno en `Authorization`. El inicio configura `WEBHOOK_URL` local cuando arranca n8n y no cambia `N8N_PORT` ni `N8N_RUNNERS_BROKER_PORT`. Al terminar, el script revisa `http://127.0.0.1:5678/healthz`. El workflow debe estar activo en n8n para que su URL de producción exista y para que corran las alertas cada minuto. La PC debe permanecer encendida y conectada para recibir webhooks.

## Portal y caja

Aplica las migraciones pendientes de PAYERS y activa PAYERS_PORTAL=true en el servidor. En Meta, configura WA_TEMPLATE_OTP con la plantilla de autenticación aprobada. El enlace de las plantillas de anticipo y liquidación que apunta a /comprobante/ usa el sufijo portal en el nuevo flujo y abre /cliente. El webhook de WhatsApp conserva su ruta.

El workflow programado procesa primero la cola y luego concilia los plazos y avisos. El disparador de WhatsApp procesa solo la cola. El servidor conserva las reglas, permisos y comprobaciones de pago.

## 2. Importar el workflow

1. En n8n, importa [Establo-PAYERS.json](Establo-PAYERS.json) desde archivo.
2. En **API del restaurante**, configura `http://127.0.0.1:5173` cuando n8n y PAYERS corren en la misma PC. El túnel público queda reservado para las llamadas entrantes de Meta y Mercado Pago.
3. Crea una credencial **Header Auth** con nombre **PAYERS Token interno**. El nombre del encabezado es `Authorization` y su valor es `Bearer <N8N_AGENT_TOKEN>`.
4. Selecciona esa credencial en **Procesar mensajes y adjuntos**, **Evaluar alertas configuradas** y **Despertar por WhatsApp**.
5. Ejecuta **Ejecutar prueba manual** y comprueba los conteos. Los nodos pueden devolver cero cuando no hay reservas o mensajes pendientes. Publica o activa el workflow para que el horario se ejecute cada minuto.
6. Meta entrega cada mensaje al servidor PAYERS, que guarda y procesa la cola directamente y también despierta el workflow mediante `N8N_WAKE_URL` local con la cabecera `Authorization`. Si el webhook de activación no responde, n8n conserva la ejecución programada cada minuto. Activa el workflow para que exista esa ruta de producción y se ejecuten las alertas programadas. La URL configurada en Meta sigue siendo la pública de PAYERS.

[Importar workflows en n8n](https://docs.n8n.io/workflows/export-import/) · [Programar ejecuciones](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/)

## 3. Conectar WhatsApp real

1. Agrega WhatsApp a la aplicación de Meta y elige el número empresarial de prueba. Agrega el número del teléfono que usarás en la demostración a los destinatarios permitidos por Meta.
2. Configura `WHATSAPP_MODE=cloud`, la versión de Graph indicada por Meta, el identificador del número, el token de acceso, el secreto de la app y un token propio de verificación. Agrega el teléfono de prueba con código de país en `WA_ALLOWED_PHONES`.
3. En Meta, configura como callback `https://TU-DOMINIO/api/webhooks/whatsapp`, usa el valor de `WA_VERIFY_TOKEN` para verificarlo y suscribe el campo `messages`. Vincula la aplicación con la cuenta empresarial de WhatsApp.
4. Registra un pedido en el panel con el teléfono de prueba y permiso de contacto. En WhatsApp, envía **anticipo EST-XXXXXXXX** al número empresarial usando la referencia del pedido. Luego prueba **saldo**, **Yape**, **Plin**, una imagen de un comprobante ficticio y una nota de voz solicitando reprogramación.
5. Configura `OPENAI_API_KEY` para clasificar mensajes con IA, transcribir las notas de voz e interpretar imágenes. Usa medios ficticios durante la demostración. El agente responde por texto, conserva transcripciones y detalles útiles en el historial y permite al operador consultar el adjunto mientras Meta pueda entregarlo. Los documentos se derivan para revisión.
6. Para iniciar la conversación o enviar recordatorios fuera de la ventana de atención, crea y configura las plantillas aprobadas. En **Conexiones → Agente y alertas**, habilita los avisos, la solicitud inicial de anticipo si corresponde y el horario deseado.

| Plantilla | Variables de cuerpo en orden | Botón dinámico |
|---|---|---|
| Anticipo | Pagador, reserva, importe del anticipo | Índice 0, `https://TU-DOMINIO/pago/{{1}}` |
| Visita | Pagador, reserva, fecha y hora de visita, saldo | — |
| Confirmación de anticipo | Pagador, reserva, fecha y hora de visita, saldo | — |
| Liquidación | Pagador, reserva, total pagado | Índice 0, `https://TU-DOMINIO/comprobante/{{1}}` |

Una captura se registra como evidencia. El pago se confirma desde la pasarela, el checkout simulado autorizado o caja, según corresponda. Las fotos y notas de voz no pueden aprobar devoluciones, modificar importes ni registrar una llegada. Las solicitudes de cambio aparecen en el panel para que el personal las resuelva.

[WhatsApp Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) · [Política de mensajes de WhatsApp](https://whatsappbusiness.com/policy/) · [OpenAI Docs sobre transcripción](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)

## 4. Simular al vendedor y al comprador

| Quién | Qué usa |
|---|---|
| **Vendedor de prueba** | La cuenta de prueba de la aplicación representa a Parrilladas El Establo. Su token, identificador de vendedor y secreto de webhook se configuran en el servidor. |
| **Comprador de prueba** | En Mercado Pago Developers, busca la cuenta **Comprador** en **Tus integraciones → aplicación → Cuentas de prueba**. Usa su usuario y contraseña en una ventana de incógnito y los datos de tarjeta de prueba de Mercado Pago. Si el panel no muestra un correo del comprador, deja `MP_TEST_BUYER_EMAIL` vacío. |
| **Pagador de WhatsApp** | Tu teléfono autorizado recibe y contesta mensajes reales. El comprador de Mercado Pago es la identidad de prueba que usas al abrir el enlace de ese pedido. |

En la aplicación configura `PAYMENT_MODE=mercado_pago` y el webhook de pagos `https://TU-DOMINIO/api/webhooks/mercado-pago`. Usa **Credenciales de prueba**, el vendedor de prueba de Perú y el comprador de prueba. Abre el enlace desde la sesión del comprador y usa solo los datos de prueba. El servidor comprueba que el pago pertenezca a la reserva, el vendedor configurado y el entorno de prueba.

- **Tarjeta.** Abre el Checkout Pro oficial desde el enlace y usa una tarjeta de prueba.
- **Yape.** Si Checkout Pro ofrece Yape en esa configuración, puedes ensayar la ruta oficial. Mercado Pago documenta que esa prueba puede quedar pendiente. Para demostrar una aprobación completa, escribe **Yape** al agente y usa el enlace de Yape simulado del proyecto.
- **Plin.** Escribe **Plin** y usa la simulación interna. Su resultado se registra como Plin simulado. El flujo no solicita datos de banca ni utiliza números para transferencias.
- **Efectivo.** Tras confirmar el anticipo, recepción registra la llegada y caja elige **Efectivo de demostración** para registrar el saldo. Al emitir, el agente envía la constancia si tiene una sesión o plantilla autorizada.

[Cuentas de prueba](https://www.mercadopago.com.pe/developers/en/docs/checkout-pro-preferences/test-accounts) · [Compras de prueba con tarjeta y Yape](https://www.mercadopago.com.pe/developers/es/docs/checkout-pro-preferences/integration-test/test-purchases)

## 5. Qué comprobar en el panel

- Guarda cambios en **Conexiones → Agente y alertas**. Revisa el nuevo importe al registrar otro pedido. Los pedidos anteriores conservan el anticipo y plazo acordados.
- Comprueba que las alertas leen la configuración actual, evitan duplicados y respetan la hora de Lima. Los vencimientos y retrasos generan incidencias para el personal.
- Revisa **Actividad de WhatsApp**, el historial de la reserva y la bandeja de incidencias. El workflow recibe conteos, y el detalle queda en el panel.
- Comprueba el cierre con anticipo verificado, llegada, saldo pagado en caja y constancia de demostración.
