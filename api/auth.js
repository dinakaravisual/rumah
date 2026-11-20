import crypto from 'crypto';
import { clearCookie, isAuthenticated, makeToken, sessionSecret, setCookie } from '../lib/session.js';
import { clientIpHash, originAllowed, rateAllowed } from '../lib/http.js';

export default async function handler(req, res) {
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  const secret = sessionSecret();
  if (!adminPassword || !secret) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD dan SESSION_SECRET (min. 16 karakter, acak) wajib diisi di Environment Variables.' });
  }

  if (req.method === 'GET') {
    const ok = isAuthenticated(req);
    return res.status(ok ? 200 : 401).json({ authenticated: ok });
  }

  if (req.method === 'DELETE') {
    clearCookie(res);
    return res.status(200).json({ authenticated: false });
  }

  if (req.method === 'POST') {
    if (!originAllowed(req)) return res.status(403).json({ authenticated: false });
    const { password } = req.body || {};
    if (!password || typeof password !== 'string' || password.length > 200) {
      return res.status(400).json({ authenticated: false });
    }
    if (!(await rateAllowed(`login:${clientIpHash(req)}`, 10, 900))) {
      res.setHeader('Retry-After', '900');
      return res.status(429).json({ authenticated: false, error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' });
    }
    await new Promise((r) => setTimeout(r, 400));
    // Hash dulu agar perbandingan tidak bocor lewat panjang password.
    const h = (v) => crypto.createHash('sha256').update(v).digest();
    if (!crypto.timingSafeEqual(h(password), h(adminPassword))) {
      return res.status(401).json({ authenticated: false });
    }
    setCookie(res, makeToken(secret));
    return res.status(200).json({ authenticated: true });
  }

  return res.status(405).end();
}
