import { randomUUID, createHash } from 'node:crypto';
import { readConfig } from './config.mjs';
import { openStore, updateOrder } from './store.mjs';
import { providers, hmac, matches } from './providers.mjs';
import { agentAI } from './agent-ai.mjs';
import { contactTime, defaults, validateSettings } from './agent-settings.mjs';
import { balance, depositDue, money, terminal, visitText, stageLabels } from '../shared/orders.mjs';
import { Problem, requireThat, createOrder, addEvent, openIssue, applyPayment, arrive, recordCounterPayment, issueReceipt, reschedule, endReservation } from './domain.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const instant = () => new Date().toISOString();
const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new Problem('Solicitud demasiado grande.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function parse(raw) {
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { throw new Problem('El contenido de la solicitud no es válido.'); }
}

export async function makeApi(env, options = {}) {
  const config = readConfig(env);
  const store = await openStore(config, options);
  const service = providers(config);
  const ai = agentAI(config, service);
  const initialSettings = defaults(config);
  const settings = async () => ({ ...initialSettings, ...await store.settings() });
  const locks = new Map();
  const sign = (value) => hmac(config.sessionSecret, value);
  const cookie = (value, age) => 'establo_session=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + age + (config.publicUrl ? '; Secure' : '');
  function authenticated(req) {
    if (!config.adminPassword) return true;
    const value = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('establo_session='))?.slice(16);
    const [expiry, nonce, signature] = String(value || '').split('.');
    return Number(expiry) > Date.now() && matches(sign(expiry + '.' + nonce), signature);
  }
  const attempts = new Map();
  const update = (id, apply) => updateOrder(store, id, apply);
  const linkFor = (intent) => config.publicUrl + '/pago/' + intent.id;
  const receiptLink = (receipt) => config.publicUrl + '/comprobante/' + receipt.token;
  function lock(id, execute) {
    const previous = locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(execute);
    locks.set(id, next);
    return next.finally(() => { if (locks.get(id) === next) locks.delete(id); });
  }
  async function checkout(id, method = 'checkout') {
    requireThat(['checkout', 'yape', 'plin'].includes(method), 'Elige un medio de anticipo válido.');
    const rule = await settings();
    requireThat(method === 'checkout' || rule[method + 'Demo'], 'Ese medio de demostración está desactivado.', 409);
    const mode = method === 'checkout' ? config.paymentMode : 'local';
    return lock(id, async () => {
      const intentId = randomUUID();
      const { order, result: intent } = await update(id, data => {
        requireThat(data.stage === 'awaiting_deposit' && depositDue(data) > 0, 'La reserva no tiene anticipo pendiente.', 409);
        requireThat(new Date(data.deadline) > new Date(), 'El plazo del anticipo venció. Revisa la reserva.', 409);
        const reusable = data.intents.find(i => i.mode === mode && (i.method || 'checkout') === method && i.amount === depositDue(data)
          && i.status === 'pending' && i.expiresAt === data.deadline);
        if (reusable) return reusable;
        const row = { id: intentId, amount: depositDue(data), expiresAt: data.deadline, status: 'pending', mode, method };
        data.intents.push(row);
        addEvent(data, 'Enlace de anticipo solicitado');
        return row;
      });
      if (intent.mode === 'local' || intent.checkoutUrl) return intent;
      const external = await service.checkout(order, intent);
      return (await update(id, data => {
        const row = data.intents.find(i => i.id === intent.id);
        Object.assign(row, external);
        addEvent(data, 'Enlace de Mercado Pago de prueba creado');
        return row;
      })).result;
    });
  }
  async function send(order, text, params) {
    const id = await service.sendWhatsApp(order, text, params);
    return (await update(order.id, data => {
      data.chat.push({ id, at: instant(), text, direction: 'out', status: 'accepted' });
      addEvent(data, 'Mensaje aceptado por WhatsApp', id);
    })).order;
  }
  function depositText(order, intent) {
    return 'Hola, ' + order.payer + '. Para confirmar ' + order.ref + ' en Parrilladas El Establo, paga ' + money(intent.amount)
      + ' de anticipo en este enlace de demostración: ' + linkFor(intent) + '. Visita: ' + visitText(order.visitAt) + '.';
  }
  function finishDeposit(data, payment, token) {
    const changed = applyPayment(data, payment);
    if (changed && data.stage === 'confirmed' && !data.receipts.some(r => r.purpose === 'deposit')) issueReceipt(data, 'deposit', token);
    return changed;
  }
  async function notifyConfirmation(order) {
    if (config.waMode !== 'cloud' || !order.consent || !config.allowedPhones.has(order.phone) || !(await settings()).automaticConfirmation) return;
    const receipt = order.receipts.find(r => r.purpose === 'deposit');
    try {
      await send(order, 'Anticipo verificado. Tu reserva ' + order.ref + ' está confirmada para el ' + visitText(order.visitAt)
        + '. Saldo a pagar en el local: ' + money(balance(order)) + '.' + (receipt ? ' Constancia: ' + receiptLink(receipt) : ''),
      { template: 'confirmation' });
    } catch (error) { await update(order.id, data => openIssue(data, 'Confirmación de WhatsApp pendiente', error.message)); }
  }
  async function syncMp(id, verified = null) {
    const p = verified || await service.payment(id);
    requireThat(uuid.test(String(p.external_reference || '')), 'La operación no corresponde a una reserva de la aplicación.', 404);
    const target = await store.find('intents', { id: p.external_reference, mode: 'mercado_pago' });
    requireThat(target, 'Referencia de anticipo no encontrada.', 404);
    const token = randomUUID();
    const { order, result } = await update(target.id, data => {
      const intent = data.intents.find(i => i.id === p.external_reference);
      const ref = 'MP-' + String(p.id);
      const amount = Math.round(Number(p.transaction_amount) * 100);
      requireThat(Number.isSafeInteger(amount) && amount > 0, 'Importe de pago inválido.', 409);
      if (amount !== intent.amount) {
        openIssue(data, 'Pago por revisar', 'El importe de Mercado Pago difiere del enlace solicitado.', ref);
        return false;
      }
      let changed = false;
      if (['approved', 'refunded', 'charged_back'].includes(p.status)) {
        intent.status = p.status === 'approved' ? 'approved' : p.status;
        changed = finishDeposit(data, { ref, amount, purpose: 'deposit', channel: 'mercadopago',
          at: p.date_approved || instant(), intentId: intent.id,
          review: p.status !== 'approved' || new Date(p.date_approved || instant()) > new Date(intent.expiresAt) }, token);
        const reported = Math.round(Number(p.transaction_amount_refunded || 0) * 100);
        const reversed = ['refunded', 'charged_back'].includes(p.status) ? (reported || amount) : reported;
        const already = data.payments.filter(x => x.original === ref).reduce((sum, x) => sum - x.amount, 0);
        if (reversed > already && reversed <= amount) {
          data.payments.push({ ref: ref + '-AJUSTE-' + reversed, amount: -(reversed - already), at: instant(),
            channel: 'mercadopago', purpose: 'deposit', original: ref });
          openIssue(data, 'Reverso por revisar', 'Mercado Pago confirmó una devolución o reverso.', ref + '-reverso');
          if (data.stage === 'confirmed' && depositDue(data) > 0) data.stage = 'awaiting_deposit';
          if (data.stage === 'paid' && balance(data) > 0) data.stage = 'arrived';
          changed = true;
        }
      } else if (['rejected', 'cancelled'].includes(p.status)) {
        if (intent.status === 'pending') intent.status = 'rejected';
        openIssue(data, 'Intento rechazado', 'Mercado Pago informó un intento fallido de anticipo.', ref);
      }
      return changed;
    });
    if (result && order.stage === 'confirmed' && p.status === 'approved') await notifyConfirmation(order);
    return { order, changed: result };
  }
  async function replyTo(order, text, proof, forcedIntent) {
    const summary = order.ref + ' · ' + stageLabels[order.stage] + '. Visita: ' + visitText(order.visitAt) + '. Saldo: ' + money(balance(order)) + '.';
    const { intent: intentType, method } = forcedIntent ? { intent: forcedIntent, method: 'checkout' } : await ai.classify(text);
    switch (intentType) {
      case 'link': {
        if (order.stage !== 'awaiting_deposit') return summary;
        if (new Date(order.deadline) <= new Date()) return summary + ' El plazo del anticipo venció. Puedo derivar la revisión al personal.';
        if (/\befectivo\b/i.test(text)) return 'El anticipo de ' + order.ref + ' se paga en línea. Puedes pagar el saldo en efectivo cuando llegues al restaurante.';
        const rule = await settings();
        if (method !== 'checkout' && !rule[method + 'Demo']) return 'Ese medio de demostración está desactivado. Puedes escribir «tarjeta» para abrir el checkout disponible.';
        const alternatives = [rule.yapeDemo && 'Yape', rule.plinDemo && 'Plin'].filter(Boolean);
        const suffix = method !== 'checkout' ? ' Elegiste ' + method + ' de demostración.'
          : alternatives.length ? ' Si prefieres simular ' + alternatives.join(' o ') + ', escribe el nombre del medio.' : '';
        return depositText(order, await checkout(order.id, method)) + suffix;
      }
      case 'paid': {
        if (depositDue(order) === 0) return summary + ' El anticipo figura verificado.';
        const details = proof ? ['Medio: ' + (proof.provider || 'sin identificar'), 'Importe visible: ' + (proof.amount || 'ilegible'),
          'Operación: ' + (proof.operation || 'ilegible'), 'Datos extraídos de una imagen aportada por el pagador.'].join(' · ') : 'Revisar la transacción con la pasarela.';
        await update(order.id, data => openIssue(data, 'Pago informado por el cliente', details, proof ? 'voucher:' + (proof.operation || proof.messageId) : 'paid-reported'));
        return (proof ? 'Recibí tu comprobante.' : 'Gracias por avisar.') + ' El pago todavía está en verificación para ' + order.ref
          + '. Espera la confirmación antes de intentar pagar de nuevo.';
      }
      case 'change':
      case 'cancel':
      case 'issue':
      case 'human': {
        const type = { change: 'Solicitud de reprogramación', cancel: 'Solicitud de cancelación o devolución', issue: 'Dificultad de pago', human: 'Ayuda del personal' }[intentType];
        await update(order.id, data => openIssue(data, type, text.slice(0, 500)));
        return 'Registré tu solicitud para ' + order.ref + '. El personal revisará tu caso y confirmará los próximos pasos.';
      }
      case 'receipt': {
        const receipt = order.receipts.at(-1);
        return receipt ? 'Aquí tienes la constancia de demostración para ' + order.ref + ': ' + receiptLink(receipt) : 'El comprobante se habilitará tras verificar el pago correspondiente.';
      }
      case 'visit': {
        if (/\b(confirmo (?:mi )?asistencia|si (?:voy a ir|asistire))\b/.test(text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase())) {
          await update(order.id, data => {
            if (data.stage !== 'confirmed' || data.visitIntent?.visitAt === data.visitAt) return;
            data.visitIntent = { visitAt: data.visitAt, at: instant() };
            addEvent(data, 'Intención de asistir informada por WhatsApp', 'La llegada se registra en recepción.', 'Pagador');
          });
        }
        return summary;
      }
      case 'balance': return summary;
      default: return summary + ' Puedes escribir «anticipo», «saldo», «reprogramar» o «ayuda».';
    }
  }
  async function incoming(message) {
    const phone = message.from;
    if (!config.allowedPhones.has(phone) || !message.id) return;
    const timestamp = Number(message.timestamp) * 1000;
    if (!Number.isFinite(timestamp) || timestamp < Date.now() - 24 * 3600000 || timestamp > Date.now() + 60000) return;
    const orders = (await store.phone(phone)).filter(o => o.consent);
    if (!orders.length || orders.some(o => o.chat.some(m => m.id === message.id))) return;
    const attachment = ['image', 'audio', 'document'].includes(message.type) ? message[message.type] : null;
    let text = String(message.text?.body || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title
      || message.button?.text || attachment?.caption || '').slice(0, 1000);
    let proof, mediaError;
    if (attachment) {
      try {
        if (message.type === 'document') throw new Problem('Documento recibido para revisión del personal.');
        const result = await ai.readMedia(message.type, attachment.id);
        if (result.text) text = result.text;
        proof = result.proof;
        if (proof) proof.messageId = message.id;
      } catch (error) { mediaError = error.message; }
    }
    if (!text && !attachment) return;
    const ref = text.match(/\bEST-[a-f0-9]{8}\b/i)?.[0]?.toUpperCase();
    const active = orders.filter(o => !terminal(o));
    const candidates = ref ? orders.filter(o => o.ref === ref) : (active.length ? active : orders);
    if (!candidates.length) return;
    const { order, result: isNew } = await update(candidates[0].id, data => {
      if (data.chat.some(m => m.id === message.id)) return false;
      data.chat.push({ id: message.id, direction: 'in', at: new Date(timestamp).toISOString(),
        text: text || (attachment ? 'Adjunto de ' + ({ image: 'imagen', audio: 'audio', document: 'documento' }[message.type]) : ''),
        ...(attachment ? { mediaType: message.type, mediaId: String(attachment.id || '') } : {}) });
      return true;
    });
    if (!isNew) return;
    try {
      let response;
      if (candidates.length > 1) response = 'Tienes varias reservas. Responde con la referencia que deseas consultar: ' + candidates.map(o => o.ref).join(', ') + '.';
      else if (mediaError || (proof && proof.kind !== 'voucher')) {
        await update(order.id, data => openIssue(data, 'Adjunto por revisar', mediaError || 'La imagen requiere revisión del personal.', message.id));
        response = 'Recibí el archivo para ' + order.ref + '. El personal revisará el adjunto. También puedes contarme por escrito cómo te ayudo.';
      } else response = await replyTo(order, text, proof, proof ? 'paid' : undefined);
      await send(order, response);
    } catch (error) {
      await update(order.id, data => openIssue(data, 'Respuesta de WhatsApp pendiente', error.message, message.id));
    }
  }
  async function delivery(status) {
    const record = await store.find('chat', { id: status.id });
    if (!record) return;
    await update(record.id, data => {
      const msg = data.chat.find(m => m.id === status.id);
      const rank = { accepted: 0, sent: 1, delivered: 2, read: 3 };
      if (status.status === 'failed' && (rank[msg.status] ?? 0) < 2) {
        msg.status = 'failed';
        openIssue(data, 'Mensaje no entregado', 'WhatsApp informó un error de entrega.', status.id);
      } else if (rank[status.status] > (rank[msg.status] ?? -1)) msg.status = status.status;
    });
  }
  let inboxRunning = false;
  async function drainInbox() {
    if (inboxRunning) return { processed: 0, failed: 0, busy: true };
    inboxRunning = true;
    try { return await processInbox(); }
    finally { inboxRunning = false; }
  }
  async function processInbox() {
    await store.expireJobs(new Date(Date.now() - 5 * 60000).toISOString());
    const result = { processed: 0, failed: 0 };
    for (const job of await store.queued(2)) {
      const rich = job.kind === 'message' && ['image', 'audio'].includes(job.payload.type);
      if (rich && result.processed + result.failed > 0) break;
      if (!await store.claim(job.id)) continue;
      try {
        if (job.kind === 'message') await incoming(job.payload);
        else await delivery(job.payload);
        await store.finishJob(job.id, 'done');
        result.processed++;
      } catch (error) {
        await store.finishJob(job.id, 'failed', String(error.message).slice(0, 250));
        result.failed++;
      }
      // Deja margen para el timeout de la llamada HTTP cuando se procesa multimedia.
      if (rich) break;
    }
    return result;
  }
  let alertsRunning = false;
  async function reminderTick() {
    if (alertsRunning) return { sent: 0, escalated: 0, busy: true };
    alertsRunning = true;
    try { return await processAlerts(); }
    finally { alertsRunning = false; }
  }
  async function processAlerts() {
    const rule = await settings();
    let sent = 0, escalated = 0, attempted = 0;
    for (const order of await store.list()) {
      if (terminal(order)) continue;
      const t = Date.now(), before = +new Date(order.visitAt) - t;
      const issue = order.stage === 'awaiting_deposit' && t >= +new Date(order.deadline) ? ['Anticipo vencido', 'Revisa el pago y el cupo antes de renovar.', 'deadline:' + order.deadline]
        : order.stage === 'confirmed' && before <= -rule.graceMinutes * 60000 ? ['Verificar llegada', 'Pasó la tolerancia. Recepción debe verificar si asistió.', 'arrival:' + order.visitAt]
          : order.stage === 'arrived' && balance(order) > 0 && t - +new Date(order.attendance.at) >= rule.counterAlertMinutes * 60000
            ? ['Saldo por verificar', 'El cliente ya llegó y caja aún no confirmó el saldo.', 'counter:' + order.attendance.at] : null;
      if (rule.internalAlerts && issue && !order.incidents.some(i => i.key === issue[2])) {
        const { result: created } = await update(order.id, data => {
          if (data.stage === order.stage && data.deadline === order.deadline && data.visitAt === order.visitAt && !data.incidents.some(i => i.key === issue[2])) {
            openIssue(data, ...issue);
            return true;
          }
        });
        if (created) escalated++;
      }
      if (attempted >= 4 || config.waMode !== 'cloud' || !rule.reminders || !contactTime(rule, new Date(t)) || !order.consent || !config.allowedPhones.has(order.phone)) continue;
      const initialKey = 'initial:' + order.deadline;
      const needsDeposit = order.stage === 'awaiting_deposit' && depositDue(order) > 0 && t < +new Date(order.deadline);
      const latestLink = [...order.chat].reverse().find(m => m.direction === 'out' && m.text.includes('/pago/'));
      const initial = rule.initialRequest && needsDeposit && !latestLink && !order.reminders[initialKey];
      const sinceRequest = t - +new Date(latestLink?.at || order.reminders[initialKey]?.at || order.createdAt);
      const deposit = rule.depositReminder && needsDeposit && sinceRequest >= rule.depositReminderMinutes * 60000;
      const visit = rule.visitReminder && order.stage === 'confirmed' && before > 0 && before <= rule.firstVisitHours * 3600000;
      const askForDeposit = initial || deposit;
      const key = initial ? initialKey : deposit ? 'deposit:' + order.deadline : visit ? 'visit:' + order.visitAt + ':' + (before <= rule.lastVisitHours * 3600000 ? 'last' : 'first') : null;
      if (!key || order.reminders[key]) continue;
      const { result: claimed } = await update(order.id, data => {
        if (data.reminders[key] || data.stage !== order.stage || data.visitAt !== order.visitAt || data.deadline !== order.deadline) return false;
        data.reminders[key] = { at: instant(), status: 'pending' };
        return true;
      });
      if (!claimed) continue;
      attempted++;
      try {
        const intent = askForDeposit ? await checkout(order.id) : null;
        const current = (await store.get(order.id)).data;
        if (current.stage === order.stage && current.visitAt === order.visitAt) {
          await send(current, askForDeposit ? depositText(current, intent) : 'Te esperamos en El Establo el ' + visitText(current.visitAt)
            + '. Reserva ' + current.ref + '. Saldo en el local: ' + money(balance(current)) + '.', { template: askForDeposit ? 'deposit' : 'visit', intent });
          await update(order.id, data => { data.reminders[key].status = 'sent'; });
          sent++;
        } else await update(order.id, data => { data.reminders[key].status = 'skipped'; });
      } catch (error) {
        await update(order.id, data => {
          data.reminders[key].status = 'failed';
          openIssue(data, 'Recordatorio pendiente', error.message, key);
        });
      }
    }
    return { sent, escalated };
  }
  let running = false;
  const timer = config.orchestration === 'server' ? setInterval(async () => {
    if (running) return;
    running = true;
    try {
      if (config.waMode === 'cloud') await drainInbox();
      await reminderTick();
    } catch (e) { console.error('Agente PAYERS:', e.message); }
    finally { running = false; }
  }, 30000) : null;
  timer?.unref();

  async function route(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (!path.startsWith('/api/')) return next();
    const isGet = req.method === 'GET', isPost = req.method === 'POST';
    if (path.startsWith('/api/internal/agent/')) {
      requireThat(config.orchestration === 'n8n' && matches(req.headers.authorization, 'Bearer ' + config.env.N8N_AGENT_TOKEN), 'Credencial del agente inválida.', 401);
      if (isPost && path.endsWith('/inbox')) return json(res, 200, await drainInbox());
      if (isPost && path.endsWith('/alerts')) return json(res, 200, await reminderTick());
      return json(res, 404, { error: 'Ruta no encontrada.' });
    }
    if (path === '/api/session' && isGet) return json(res, 200, { authenticated: authenticated(req), protected: Boolean(config.adminPassword) });
    if (path === '/api/login' && isPost) {
      const host = req.socket.remoteAddress;
      const state = attempts.get(host);
      if (state?.count >= 10 && state.expiry > Date.now()) throw new Problem('Espera antes de volver a intentar el ingreso.', 429);
      const body = parse(await readBody(req));
      if (!matches(hash(config.adminPassword), hash(body.password)) || !config.adminPassword) {
        attempts.set(host, state?.expiry > Date.now() ? { ...state, count: state.count + 1 } : { count: 1, expiry: Date.now() + 15 * 60000 });
        throw new Problem('La contraseña es incorrecta.', 401);
      }
      attempts.delete(host);
      const key = (Date.now() + 8 * 3600000) + '.' + randomUUID();
      res.setHeader('Set-Cookie', cookie(key + '.' + sign(key), 28800));
      return json(res, 200, { authenticated: true });
    }
    if (path === '/api/logout' && isPost) {
      res.setHeader('Set-Cookie', cookie('', 0));
      return json(res, 200, { authenticated: false });
    }
    if (path === '/api/webhooks/whatsapp' && config.waMode === 'cloud') {
      if (isGet) {
        requireThat(url.searchParams.get('hub.mode') === 'subscribe' && matches(config.env.WA_VERIFY_TOKEN, url.searchParams.get('hub.verify_token')), 'Verificación inválida.', 403);
        res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(url.searchParams.get('hub.challenge'));
      }
      if (isPost) {
        const raw = await readBody(req);
        requireThat(matches('sha256=' + hmac(config.env.WA_APP_SECRET, raw), req.headers['x-hub-signature-256']), 'Firma de WhatsApp inválida.', 403);
        const queue = [];
        for (const entry of parse(raw).entry || []) for (const change of entry.changes || []) {
          const value = change.value || {};
          if (String(value.metadata?.phone_number_id) !== config.env.WA_PHONE_NUMBER_ID) continue;
          for (const message of value.messages || []) if (config.allowedPhones.has(message.from) && message.id) {
            queue.push({ id: 'message:' + message.id, kind: 'message', payload: message });
          }
          for (const status of value.statuses || []) if (status.id && ['sent', 'delivered', 'read', 'failed'].includes(status.status)) {
            queue.push({ id: 'status:' + status.id + ':' + status.status, kind: 'status', payload: { id: status.id, status: status.status } });
          }
        }
        await store.enqueue(queue);
        if (config.orchestration === 'server' && queue.length) await drainInbox();
        else if (queue.length && config.env.N8N_WAKE_URL) {
          fetch(config.env.N8N_WAKE_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { Authorization: 'Bearer ' + config.env.N8N_AGENT_TOKEN } }).catch(() => {});
        }
        return json(res, 200, { received: true });
      }
    }
    if (path === '/api/webhooks/mercado-pago' && isPost && config.paymentMode === 'mercado_pago') {
      const raw = await readBody(req);
      const id = service.verifyMp(req, url);
      requireThat(id, 'Firma de Mercado Pago inválida.', 403);
      if ((parse(raw).type || url.searchParams.get('type')) === 'payment') await syncMp(id);
      return json(res, 200, { received: true });
    }
    const publicPay = path.match(/^\/api\/payment\/([a-f0-9-]+)$/);
    if (publicPay && uuid.test(publicPay[1])) {
      const target = await store.find('intents', { id: publicPay[1] });
      requireThat(target, 'Enlace no encontrado.', 404);
      const intent = target.intents.find(i => i.id === publicPay[1]);
      const method = intent.method || 'checkout';
      const methodEnabled = method === 'checkout' || (await settings())[method + 'Demo'];
      if (isGet) {
        const usable = methodEnabled && target.stage === 'awaiting_deposit' && intent.amount === depositDue(target)
          && new Date(intent.expiresAt) > new Date() && new Date(target.deadline) > new Date() && intent.status === 'pending';
        return json(res, 200, { ref: target.ref, amount: intent.amount, status: intent.status, mode: intent.mode,
          method, usable, checkoutUrl: usable ? intent.checkoutUrl : null });
      }
      if (isPost) {
        requireThat(methodEnabled && intent.mode === 'local' && (method !== 'checkout' || config.paymentMode === 'local'), 'Este pago se confirma desde el medio autorizado.', 409);
        const input = parse(await readBody(req));
        const token = randomUUID();
        const { order, result } = await update(target.id, data => {
          const row = data.intents.find(i => i.id === intent.id);
          if (row.status === 'approved') return { status: row.status, confirmed: false };
          requireThat(data.stage === 'awaiting_deposit' && row.status === 'pending' && row.amount === depositDue(data)
            && new Date(row.expiresAt) > new Date() && new Date(data.deadline) > new Date(), 'El enlace ya no está disponible.', 409);
          if (input.outcome === 'rejected') {
            row.status = 'rejected';
            openIssue(data, 'Intento rechazado', 'El checkout local simuló un rechazo.', row.id);
          } else {
            requireThat(input.outcome === 'approved', 'Resultado de prueba inválido.');
            row.status = 'approved';
            finishDeposit(data, { ref: 'SIM-' + row.id, amount: row.amount, purpose: 'deposit', channel: method === 'checkout' ? 'simulation' : method + '_demo', intentId: row.id }, token);
          }
          return { status: row.status, confirmed: row.status === 'approved' && data.stage === 'confirmed' };
        });
        if (result.confirmed) await notifyConfirmation(order);
        return json(res, 200, { status: result.status });
      }
    }
    const publicReceipt = path.match(/^\/api\/receipt\/([a-f0-9-]+)$/);
    if (publicReceipt && isGet && uuid.test(publicReceipt[1])) {
      const order = await store.find('receipts', { token: publicReceipt[1] });
      requireThat(order, 'Comprobante no encontrado.', 404);
      const receipt = order.receipts.find(r => r.token === publicReceipt[1]);
      return json(res, 200, { ...receipt, ref: order.ref, payer: order.payer, total: order.total });
    }
    requireThat(authenticated(req), 'Inicia sesión para acceder al panel.', 401);
    const attachment = path.match(/^\/api\/orders\/([a-f0-9-]+)\/media\/([^/]+)$/);
    if (attachment && isGet && uuid.test(attachment[1])) {
      const order = (await store.get(attachment[1]))?.data;
      const message = order?.chat.find(m => m.direction === 'in' && m.id === decodeURIComponent(attachment[2]) && m.mediaId);
      requireThat(message, 'Adjunto no encontrado.', 404);
      const media = await service.downloadMedia(message.mediaId, 12 * 1024 ** 2);
      const inline = /^(image\/(jpeg|png|webp)|audio\/(ogg|mpeg|mp4|wav|webm|opus))$/.test(media.mime);
      const document = media.mime === 'application/pdf';
      requireThat(inline || document, 'Este tipo de archivo requiere revisión en el canal de origen.', 415);
      res.writeHead(200, { 'Content-Type': media.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store',
        'Content-Disposition': inline ? 'inline' : 'attachment; filename="adjunto.pdf"' });
      return res.end(media.bytes);
    }
    if (path === '/api/config' && isGet) return json(res, 200, {
      database: store.label, paymentMode: config.paymentMode, whatsapp: config.waMode, protected: Boolean(config.adminPassword),
      agent: config.orchestration, ai: ai.enabled, ...await settings(),
    });
    if (path === '/api/agent/settings' && isPost) {
      const next = validateSettings(parse(await readBody(req)), initialSettings);
      await store.saveSettings(next);
      return json(res, 200, next);
    }
    if (path === '/api/agent/activity' && isGet) return json(res, 200, await store.agentStatus());
    if (path === '/api/orders' && isGet) return json(res, 200, await store.list());
    if (path === '/api/orders' && isPost) {
      const rule = await settings();
      return json(res, 201, await store.insert(createOrder(parse(await readBody(req)), { depositPerPerson: rule.depositPerPerson, deadlineMs: rule.deadlineMinutes * 60000 })));
    }
    const action = path.match(/^\/api\/orders\/([a-f0-9-]+)\/([a-z-]+)$/);
    if (action && isPost && uuid.test(action[1])) {
      const [, id, kind] = action;
      const input = parse(await readBody(req));
      if (kind === 'link') {
        const intent = await checkout(id, input.method);
        return json(res, 200, { intent, url: linkFor(intent), order: (await store.get(id)).data });
      }
      if (kind === 'message') {
        requireThat(config.waMode === 'cloud', 'Activa WhatsApp Cloud API en la configuración.', 409);
        let order = (await store.get(id))?.data;
        requireThat(order, 'Reserva no encontrada.', 404);
        if (input.type === 'deposit') {
          const intent = await checkout(id, input.method);
          order = await send(order, depositText(order, intent), { template: 'deposit', intent });
        } else if (input.type === 'visit') {
          requireThat(order.stage === 'confirmed', 'La visita debe estar confirmada.', 409);
          order = await send(order, 'Hola, ' + order.payer + '. Te esperamos el ' + visitText(order.visitAt)
            + ' en El Establo. Reserva ' + order.ref + '. Saldo en el local: ' + money(balance(order)) + '.', { template: 'visit' });
        } else if (input.type === 'receipt') {
          const receipt = order.receipts.at(-1);
          requireThat(receipt, 'Aún no hay un comprobante emitido.', 409);
          order = await send(order, 'Aquí tienes tu comprobante de demostración: ' + receiptLink(receipt),
            { template: receipt.purpose === 'settlement' ? 'settlement' : undefined });
        } else throw new Problem('Selecciona un mensaje válido.');
        return json(res, 200, { order });
      }
      if (kind === 'sync') {
        requireThat(config.paymentMode === 'mercado_pago' && /^\d+$/.test(String(input.paymentId)), 'Indica el número de operación de Mercado Pago.');
        const p = await service.payment(input.paymentId);
        const row = await store.get(id);
        requireThat(row?.data.intents.some(i => i.id === p.external_reference), 'El pago corresponde a otro pedido.', 409);
        return json(res, 200, await syncMp(input.paymentId, p));
      }
      if (kind === 'refund') {
        const data = (await store.get(id))?.data;
        requireThat(data && (['cancelled', 'no_show'].includes(data.stage) || data.incidents.some(i => i.key === input.ref && !i.resolvedAt)),
          'Registra primero la cancelación, inasistencia o incidencia asociada al cobro.', 409);
        const payment = data.payments.find(p => p.ref === input.ref && p.amount > 0 && p.purpose === 'deposit');
        requireThat(payment, 'Selecciona un anticipo válido.');
        if (payment.channel === 'mercadopago') {
          const confirmed = await service.payment(payment.ref.slice(3));
          if (confirmed.status === 'approved' && !Number(confirmed.transaction_amount_refunded || 0)) {
            const key = hash(id + ':' + payment.ref).slice(0, 36);
            await service.refund(payment.ref.slice(3), payment.amount, key);
          }
          return json(res, 200, await syncMp(payment.ref.slice(3)));
        }
        return json(res, 200, await update(id, data => {
          if (data.payments.some(p => p.original === payment.ref)) return;
          data.payments.push({ ref: payment.ref + '-REFUND', original: payment.ref, amount: -payment.amount,
            at: instant(), purpose: 'deposit', channel: payment.channel });
          addEvent(data, 'Devolución de demostración registrada', payment.ref, 'Caja');
        }));
      }
      const receiptToken = randomUUID();
      const rule = await settings();
      const result = await update(id, data => {
        if (kind === 'arrive') return arrive(data, Number(input.count));
        if (kind === 'counter') return recordCounterPayment(data, input.channel);
        if (kind === 'receipt') return issueReceipt(data, 'settlement', receiptToken);
        if (kind === 'reschedule') return reschedule(data, input.visitAt);
        if (kind === 'renew') {
          requireThat(data.stage === 'awaiting_deposit' && depositDue(data) > 0 && new Date(data.deadline) <= new Date(),
            'Solo se renuevan anticipos pendientes y vencidos.');
          requireThat(+new Date(data.visitAt) > Date.now() + 60000, 'Reprograma primero la visita y verifica la disponibilidad.');
          data.deadline = new Date(Math.min(Date.now() + rule.deadlineMinutes * 60000, +new Date(data.visitAt))).toISOString();
          addEvent(data, 'Plazo de anticipo renovado', 'Cupo revisado por el operador.', 'Operador');
          return;
        }
        if (kind === 'cancel') return endReservation(data, 'cancelled', input.reason, rule.graceMinutes * 60000);
        if (kind === 'no-show') return endReservation(data, 'no_show', input.reason, rule.graceMinutes * 60000);
        if (kind === 'resolve') {
          const issue = data.incidents.find(i => i.id === input.id && !i.resolvedAt);
          requireThat(issue, 'La incidencia no está pendiente.', 409);
          requireThat(String(input.note || '').trim().length >= 3, 'Describe cómo se resolvió la incidencia.');
          const resolution = String(input.note).slice(0, 300);
          issue.resolvedAt = instant();
          issue.resolution = resolution;
          addEvent(data, 'Incidencia resuelta', resolution, 'Operador');
          if (data.stage === 'awaiting_deposit' && depositDue(data) === 0 && new Date(data.visitAt) > new Date()
            && !data.incidents.some(i => !i.resolvedAt && i.type === 'Pago por revisar')) {
            data.stage = 'confirmed';
            data.confirmedAt = instant();
            addEvent(data, 'Reserva confirmada tras revisión', '', 'Operador');
            issueReceipt(data, 'deposit', receiptToken);
          }
          return;
        }
        throw new Problem('Acción no disponible.', 404);
      });
      if (kind === 'receipt' && result.result?.token === receiptToken && rule.automaticConfirmation
        && config.waMode === 'cloud' && result.order.consent && config.allowedPhones.has(result.order.phone)) {
        try {
          await send(result.order, 'Verificamos tu llegada y el pago completo de ' + result.order.ref + '. Tu constancia de demostración: '
            + receiptLink(result.result), { template: 'settlement' });
        } catch (error) { await update(id, data => openIssue(data, 'Envío de constancia pendiente', error.message, receiptToken)); }
      }
      return json(res, 200, result);
    }
    return json(res, 404, { error: 'Ruta no encontrada.' });
  }
  const middleware = (req, res, next) => route(req, res, next).catch(error => {
    if (!(error instanceof Problem)) console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'No se pudo completar la operación.' });
    else res.end();
  });
  return { middleware, async close() { clearInterval(timer); await store.close?.(); } };
}
