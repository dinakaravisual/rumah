import crypto from 'crypto';
import { gas } from './gas.js';

export function clientIpHash(req) {
  const raw = (req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
    .toString().split(',')[0].trim();
  return crypto.createHash('sha256').update(raw || 'unknown').digest('hex').slice(0, 24);
}

// Same-origin + daftar tambahan (ALLOWED_ORIGINS, dipisah koma, persis https://domain).
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const own = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  if (host === own) return true;
  return (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

// Pembatas laju terdistribusi via Apps Script; jika gagal, jatuh ke memori instance.
const mem = new Map();
export async function rateAllowed(key, limit, windowSec) {
  try {
    return (await gas('rate', { key, limit, windowSec }, 8000)).allowed === true;
  } catch {
    const bucket = `${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
    const n = (mem.get(bucket) || 0) + 1;
    mem.set(bucket, n);
    if (mem.size > 5000) mem.clear();
    return n <= limit;
  }
}
