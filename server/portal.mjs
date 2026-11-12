import { randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Problem, requireThat, whatsappPhone } from './domain.mjs';
import { hmac, matches } from './providers.mjs';
import { balance, deposited } from '../shared/orders.mjs';

const derive = promisify(scrypt);
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const nameOf = value => String(value || '').trim().toLowerCase();
const duration = 8 * 3600;
const cookieName = 'establo_portal';

async function passwordDigest(value, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + (await derive(value, salt, 64)).toString('hex');
}

export function createPortal(config, store, provider, options = {}) {
  const bootstrapName = nameOf(config.env.ADMIN_USERNAME || 'admin');
  const bootstrap = { id: 'bootstrap', name: 'Administración', role: 'admin', version: 0 };
  const guard = new Map();
  const sign = value => hmac(config.sessionSecret, value);
  const call = (action, data = {}) => store.portal(action, data);
  const otpDigest = (id, value) => sign('otp:' + id + ':' + value);

  function throttle(key, limit, ms) {
    const now = Date.now();
    if (guard.size >= 4096) for (const [key, item] of guard) if (item.until <= now) guard.delete(key);
    requireThat(guard.has(key) || guard.size < 4096, 'Intenta nuevamente en unos minutos.', 429);
    const current = guard.get(key);
    const row = current?.until > now ? current : { used: 0, until: now + ms };
    requireThat(row.used < limit, 'Intenta nuevamente en unos minutos.', 429);
    row.used++;
    guard.set(key, row);
  }

  function cookie(res, payload) {
    const value = payload ? Buffer.from(JSON.stringify({ ...payload, expires: Date.now() + duration * 1000 })).toString('base64url') : '';
    const token = value ? value + '.' + sign(value) : '';
    res.setHeader('Set-Cookie', cookieName + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age='
      + (value ? duration : 0) + (config.publicUrl ? '; Secure' : ''));
  }

  async function session(req) {
    const raw = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='));
    const [value, signature] = (raw || '').slice(cookieName.length + 1).split('.');
    if (!value || !matches(sign(value), signature)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(value, 'base64url')); } catch { return null; }
    if (!(data.expires > Date.now())) return null;
    if (data.id === bootstrap.id && config.adminPassword) return bootstrap;
    if (data.role === 'client') {
      const client = await call('client_session', { id: data.id });
      return client?.id ? { ...client, role: 'client' } : null;
    }
    const staff = await call('staff_session', { id: data.id });
    return staff?.id && staff.version === data.version ? staff : null;
  }

  async function login(req, res, body) {
    const username = nameOf(body.username);
    const password = String(body.password || '');
    throttle('login:' + (req.socket.remoteAddress || ''), 15, 15 * 60000);
    requireThat(usernamePattern.test(username) && password.length <= 128, 'Usuario o contraseña incorrectos.', 401);
    let user;
    if (config.adminPassword && username === bootstrapName && matches(sign(password), sign(config.adminPassword))) user = bootstrap;
    else {
      const stored = await call('staff_login', { username });
      if (stored?.password_hash) {
        const actual = await passwordDigest(password, stored.password_hash.split(':')[0]);
        if (timingSafeEqual(Buffer.from(sign(actual)), Buffer.from(sign(stored.password_hash)))) user = stored;
      }
    }
    requireThat(user, 'Usuario o contraseña incorrectos.', 401);
    cookie(res, { id: user.id, role: user.role, version: user.version });
    guard.delete('login:' + (req.socket.remoteAddress || ''));
    return { authenticated: true, role: user.role };
  }

  async function issue(req, body) {
    const value = String(body.phone || '').trim();
    requireThat(/^\+?[\d ()-]{8,22}$/.test(value), 'Indica un número de WhatsApp válido.', 400);
    const phone = whatsappPhone(value);
    requireThat(/^[1-9]\d{7,14}$/.test(phone), 'Indica el número con su código de país.', 400);
    throttle('otp:' + (req.socket.remoteAddress || ''), 35, 10 * 60000);
    const id = randomUUID();
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const canAttemptDelivery = options.deliverOtp || (config.waMode === 'cloud'
      && (config.otpFreeForm || config.env.WA_TEMPLATE_OTP));
    const message = "Si tu número tiene una reserva, recibirás un código por WhatsApp. Si no llega, escribe 'hola' al WhatsApp de El Establo y vuelve a solicitarlo.";
    if (canAttemptDelivery) {
      // No crear un reto enviable si las reglas de contacto no permiten entregarlo.
      const session = config.otpFreeForm && config.waMode === 'cloud' ? await options.sessionOpen?.(phone) : false;
      const allowed = config.isPhoneAllowed(phone) && !config.isPhoneBlocked(phone) && !(await options.isOptedOut?.(phone));
      const client = allowed && (!config.otpFreeForm || session)
        ? await call('otp_start', { id, phone, digest: otpDigest(id, code) }) : null;
      if (client?.id) {
        try {
          if (options.deliverOtp) await options.deliverOtp(phone, code);
          else await provider.sendOtp(phone, code, { freeForm: config.otpFreeForm, session });
        } catch { /* No exponer la existencia del cliente ni el código. */ }
      }
    }
    return { id, message };
  }

  async function verify(req, res, body) {
    const { id, code } = body;
    throttle('verify:' + (req.socket.remoteAddress || ''), 45, 10 * 60000);
    requireThat(uuid.test(id || '') && /^\d{6}$/.test(code || ''), 'Ingresa los seis dígitos del código.');
    const client = await call('otp_verify', { id, digest: otpDigest(id, code) });
    requireThat(client?.id, 'El código no es válido o venció. Solicita otro si lo necesitas.', 401);
    cookie(res, { id: client.id, role: 'client' });
    return { authenticated: true, role: 'client' };
  }

  async function saveStaff(body, actor) {
    const id = body.id || null;
    const username = nameOf(body.username);
    const name = String(body.name || '').trim();
    const password = String(body.password || '');
    requireThat(id ? uuid.test(id) : usernamePattern.test(username) && username !== bootstrapName, 'Revisa el nombre de usuario.');
    requireThat(name.length >= 2 && name.length <= 100 && ['admin', 'cashier'].includes(body.role), 'Revisa el nombre y rol.');
    requireThat(!id || actor.id !== id || (body.active !== false && body.role === 'admin'),
      'Tu cuenta debe conservar el acceso de administrador.', 409);
    if (!id || password) requireThat(password.length >= 12 && password.length <= 128, 'Usa una contraseña de 12 a 128 caracteres.');
    const result = await call('staff_save', { id, username, name, role: body.role, active: body.active !== false,
      ...(password ? { password_hash: await passwordDigest(password) } : {}) });
    if (!result?.id) throw new Problem('La cuenta no existe.', 404);
    return result;
  }

  async function customerOrders(client) {
    const orders = await store.phone(client.phone);
    const mercadoPagoUrl = payment => payment?.channel === 'mercadopago' && /^MP-\d+$/.test(String(payment.ref || ''))
      ? 'https://www.mercadopago.com.pe/ccap/file-viewer/receipt?' + new URLSearchParams({
        flow: 'cow_payment_receipts', origin: 'feedback-screen', payment_id: payment.ref.slice(3) }) : null;
    return orders.map(order => ({
      id: order.id, ref: order.ref, visitAt: order.visitAt, stage: order.stage, guests: order.guests,
      total: order.total, deposit: deposited(order), balance: balance(order),
      attendance: order.attendance?.at ? 'confirmed' : order.attendance?.reportedAt ? 'pending' : null,
      items: order.items.map(({ name, quantity, price, discount }) => ({ name, quantity, price, discount })),
      receipts: order.receipts.map(receipt => {
        const payments = receipt.purpose === 'settlement'
          ? (receipt.paymentBreakdown || []).map(row => order.payments.find(item => item.ref === row.ref)).filter(Boolean)
          : order.payments.filter(item => item.ref === receipt.paymentRef
            || (receipt.intentId && item.intentId === receipt.intentId)
            || (receipt.purpose === 'deposit' && (item.purpose || 'deposit') === 'deposit' && item.amount === receipt.amount));
        const mercadoPagoReceipts = payments
          .filter(payment => !order.payments.some(item => item.original === payment.ref && item.amount < 0))
          .map(payment => ({ purpose: payment.purpose || 'deposit', paymentId: payment.ref.slice(3), url: mercadoPagoUrl(payment) }))
          .filter(item => item.url);
        return { purpose: receipt.purpose, token: receipt.token, number: receipt.number, at: receipt.at,
          reversedAt: receipt.reversedAt, mercadoPagoReceipts };
      }),
    }));
  }
  return { login, session, issue, verify, saveStaff, customerOrders, call, logout: res => cookie(res, null) };
}

