# Activación de WhatsApp, n8n y pagos de demostración

El panel, la API y n8n comparten las reservas a través del servidor PAYERS. En modo alojado, PostgreSQL de Supabase conserva las reservas, la cola de WhatsApp y las reglas editadas por administración. Meta entrega eventos a la API del restaurante. n8n procesa los eventos registrados y revisa las alertas programadas.

## 1. Preparar el servidor y Supabase

1. Ejecuta `001_payers.sql` y `002_payers_agent.sql` en el editor SQL del proyecto Supabase, en ese orden. Si la primera migración ya está aplicada, ejecuta la segunda.
2. Completa los campos de servidor de `.env` tomando como referencia `.env.example`. Configura `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, una contraseña de administración de al menos 12 caracteres y un secreto de sesión de al menos 32 caracteres. Mantén las claves en el servidor.
3. Dale una URL HTTPS pública a la aplicación. El servidor Node sirve tanto el panel como la API que necesita n8n. Para una demostración puedes mantenerlo en tu computadora y usar un túnel temporal. Para mantenerlo disponible con una URL fija, despliega el servidor Node en un alojamiento con HTTPS.
4. Configura `AGENT_ORCHESTRATION=n8n` y un `N8N_AGENT_TOKEN` aleatorio de al menos 32 caracteres. Las llamadas de n8n usan este token. Las claves de Meta, Mercado Pago, OpenAI y Supabase quedan en el servidor.

### Túnel HTTPS temporal para una demostración

1. Detén el panel local si está corriendo con `npm run dev`. Instala `cloudflared` desde las [descargas oficiales de Cloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
2. En una ventana nueva de PowerShell, ejecuta `cloudflared tunnel --url http://127.0.0.1:5173`. Si PowerShell aún no reconoce el comando y WinGet lo instaló en `C:\Program Files (x86)\cloudflared`, ejecuta `& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel --url http://127.0.0.1:5173`. Si cambiaste `PORT`, usa ese puerto. Deja la ventana abierta y copia el origen `https://…trycloudflare.com` que aparezca.
3. Pega ese origen en `PUBLIC_URL` de `.env` y en el nodo **API del restaurante** de n8n. Usa el origen sin `/api` ni otra ruta. `SUPABASE_URL` conserva la dirección del proyecto de base de datos.
4. En otra ventana de PowerShell, desde la carpeta `el-establo-payers`, ejecuta `npm.cmd ci` si faltan dependencias, luego `npm.cmd run build` y `npm.cmd start`. Abre la URL del túnel y verifica que el panel pida la contraseña de administración.
5. Configura Meta con ese origen más `/api/webhooks/whatsapp` y Mercado Pago con ese origen más `/api/webhooks/mercado-pago`. Mantén abiertas las dos ventanas durante la prueba. Si el túnel cambia de dirección, actualiza `PUBLIC_URL`, n8n y los dos webhooks. [Guía oficial de túneles temporales](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 2. Importar el workflow

1. En n8n, importa [Establo-PAYERS.json](Establo-PAYERS.json) desde archivo.
2. En **API del restaurante**, reemplaza `https://REEMPLAZAR.example` por el origen HTTPS del panel.
3. Crea una credencial **Header Auth** con nombre **PAYERS Token interno**. El nombre del encabezado es `Authorization` y su valor es `Bearer <N8N_AGENT_TOKEN>`.
4. Selecciona esa credencial en **Procesar mensajes y adjuntos**, **Evaluar alertas configuradas** y **Despertar por WhatsApp**.
5. Ejecuta **Ejecutar prueba manual** y comprueba los conteos. Los nodos pueden devolver cero cuando no hay reservas o mensajes pendientes. Publica o activa el workflow para que el horario se ejecute cada minuto.
6. Para reducir la espera de una respuesta, copia la **Production URL** de **Despertar por WhatsApp** a `N8N_WAKE_URL` y reinicia el servidor. La revisión por minuto queda activa si esa llamada falla. La URL que se configura en Meta sigue siendo la de la API del restaurante.

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
