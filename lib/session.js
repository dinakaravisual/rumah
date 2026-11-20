import crypto from 'crypto';

export const COOKIE = 'bkr_session';
const MAX_AGE_MS = 24 * 3600 * 1000;

export function sessionSecret() {
  const s = process.env.SESSION_SECRET || '';
  return s.length >= 16 ? s : null;
}

export function sign(ts, secret) {
  return crypto.createHmac('sha256', secret).update(String(ts)).digest('hex');
}

export function makeToken(secret) {
  const ts = Date.now();
  return `${ts}.${sign(ts, secret)}`;
}

export function isAuthenticated(req) {
  const secret = sessionSecret();
  if (!secret) return false;
  const m = (req.headers.cookie || '').match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return false;
  let raw;
  try { raw = decodeURIComponent(m[1]); } catch { return false; }
  const parts = raw.split('.');
  if (parts.length !== 2) return false; // token harus persis "<waktu>.<tanda tangan>"
  const [ts, sig] = parts;
  const age = Date.now() - Number(ts);
  if (!ts || !sig || Number.isNaN(age) || age < 0 || age > MAX_AGE_MS) return false;
  const expected = sign(ts, secret);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`);
}
export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
}
