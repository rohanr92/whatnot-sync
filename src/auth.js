import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 30;
const COOKIE = 'wns_session';

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function checkPassword(pw, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), 64);
  const want = Buffer.from(key, 'base64');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function userCount() {
  const { rows: [r] } = await q('SELECT count(*)::int AS n FROM users');
  return r.n;
}

// Optional bootstrap from env (ADMIN_EMAIL + ADMIN_PASSWORD) on first start
export async function bootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL, pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw || (await userCount()) > 0) return;
  await q(`INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,'admin')`, [email.toLowerCase().trim(), 'Admin', await hashPassword(pw)]);
  console.log(`Admin user ${email} created from env`);
}

export async function createUser({ email, name, password, role = 'staff' }) {
  email = String(email || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error('Enter a valid email'), { status: 400 });
  if (String(password || '').length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
  if (!['admin', 'staff'].includes(role)) role = 'staff';
  try {
    const { rows: [u] } = await q(`INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,email,name,role,created_at`,
      [email, name || email.split('@')[0], await hashPassword(password), role]);
    return u;
  } catch (e) {
    if (e.code === '23505') throw Object.assign(new Error('That email already has an account'), { status: 409 });
    throw e;
  }
}

export async function startSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now() + interval '${SESSION_DAYS} days')`, [sha(token), userId]);
  await q('UPDATE users SET last_login=now() WHERE id=$1', [userId]);
  if (Math.random() < 0.1) await q('DELETE FROM sessions WHERE expires_at < now()');
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
}

function readToken(req) {
  const c = (req.headers.cookie || '').split(';').map((x) => x.trim()).find((x) => x.startsWith(COOKIE + '='));
  return c ? decodeURIComponent(c.slice(COOKIE.length + 1)) : null;
}

export async function currentUser(req) {
  const t = readToken(req);
  if (!t) return null;
  const { rows: [u] } = await q(`SELECT u.id,u.email,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at > now()`, [sha(t)]);
  return u || null;
}

export async function endSession(req, res) {
  const t = readToken(req);
  if (t) await q('DELETE FROM sessions WHERE token_hash=$1', [sha(t)]);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
}

// very small brute-force guard: 8 failed tries per 15 min per IP+email
const fails = new Map();
export function tooManyAttempts(key) {
  const now = Date.now();
  const arr = (fails.get(key) || []).filter((t) => now - t < 15 * 60_000);
  fails.set(key, arr);
  return arr.length >= 8;
}
export function recordFail(key) { const arr = fails.get(key) || []; arr.push(Date.now()); fails.set(key, arr); }
export function clearFails(key) { fails.delete(key); }
