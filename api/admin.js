import crypto from 'crypto';
import { gas, GasError } from '../lib/gas.js';
import { getPublicData, invalidatePublicCache, normalizeConfig } from '../lib/config.js';
import { computeQuote } from '../lib/pricing.js';
import { EMAIL, TIME, normalizePhone, safe, validDate, wibToday } from '../lib/validate.js';
import { isAuthenticated } from '../lib/session.js';
import { originAllowed } from '../lib/http.js';

const STATUSES = ['Menunggu DP', 'DP Diterima', 'Terjadwal', 'Selesai', 'Dibatalkan'];
const PAYMENTS = ['Belum bayar', 'DP', 'Lunas'];
const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com'];

// Kosong = hapus link. Selain itu wajib https ke Google Drive/Docs.
function cleanDriveLink(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  if (raw.length > 400) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && DRIVE_HOSTS.includes(u.hostname) ? u.href : null;
  } catch { return null; }
}

// Galeri milik sendiri: boleh domain https mana pun (bukan http/javascript:).
function cleanHttpsLink(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  if (raw.length > 400) return null;
  try { const u = new URL(raw); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!originAllowed(req)) return res.status(403).json({ error: 'Akses ditolak.' });
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Sesi admin berakhir. Silakan login ulang.' });

  const { action, ...body } = req.body || {};
  try {
    if (action === 'bookings') {
      const r = await gas('listBookings');
      return res.status(200).json({ bookings: r.bookings });
    }
    if (action === 'saveConfig') {
      const config = normalizeConfig(body.config);
      await gas('saveConfig', { config });
      invalidatePublicCache();
      return res.status(200).json({ ok: true, config });
    }
    if (action === 'updateBooking') {
      const id = String(body.id || '').slice(0, 40);
      const patch = { id };
      if (typeof body.archived === 'boolean') patch.archived = body.archived;
      if (STATUSES.includes(body.status)) patch.status = body.status;
      if (PAYMENTS.includes(body.payment)) patch.payment = body.payment;
      if (body.driveLink !== undefined) {
        const link = cleanDriveLink(body.driveLink);
        if (link === null) return res.status(400).json({ error: 'Link harus berupa https://drive.google.com/... atau https://docs.google.com/...' });
        patch.driveLink = link;
      }
      if (body.galleryLink !== undefined) {
        const link = cleanHttpsLink(body.galleryLink);
        if (link === null) return res.status(400).json({ error: 'Link galeri harus diawali https://' });
        patch.galleryLink = link;
      }
      if (!id) return res.status(400).json({ error: 'ID booking tidak valid.' });
      await gas('updateBooking', patch);
      invalidatePublicCache();
      return res.status(200).json({ ok: true });
    }
    if (action === 'blocks') {
      const r = await gas('listBlocks');
      return res.status(200).json({ blocks: r.blocks });
    }
    if (action === 'addBlock') {
      const start = String(body.start || ''), end = String(body.end || body.start || '');
      const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
      if (!validDate(start) || !validDate(end) || end < start) return res.status(400).json({ error: 'Tanggal tidak valid (tanggal selesai harus sama/setelah mulai).' });
      if (end < today) return res.status(400).json({ error: 'Tanggal sudah terlewat.' });
      if ((Date.parse(end) - Date.parse(start)) / 864e5 > 365) return res.status(400).json({ error: 'Rentang maksimal 1 tahun.' });
      const timeStart = String(body.timeStart || '').trim(), timeEnd = String(body.timeEnd || '').trim();
      if (timeStart || timeEnd) {
        if (!TIME.test(timeStart) || !TIME.test(timeEnd) || timeStart >= timeEnd) return res.status(400).json({ error: 'Jam tidak valid (jam selesai harus setelah jam mulai).' });
        if (start !== end) return res.status(400).json({ error: 'Blok berjam hanya untuk satu tanggal. Kosongkan jam untuk blok beberapa hari.' });
      }
      const block = { id: `BLK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, start, end, note: String(body.note || '').trim().slice(0, 80), timeStart, timeEnd };
      await gas('addBlock', { block });
      invalidatePublicCache();
      return res.status(200).json({ ok: true, block });
    }
    if (action === 'deleteBlock') {
      await gas('deleteBlock', { id: String(body.id || '').slice(0, 40) });
      invalidatePublicCache();
      return res.status(200).json({ ok: true });
    }
    if (action === 'deleteBooking') {
      const id = String(body.id || '').slice(0, 40);
      if (!id) return res.status(400).json({ error: 'ID booking tidak valid.' });
      await gas('deleteBooking', { id });
      invalidatePublicCache();
      return res.status(200).json({ ok: true });
    }
    if (action === 'editBooking') return await editBooking(req, res, body);
    return res.status(400).json({ error: 'Aksi tidak dikenal.' });
  } catch (e) {
    const code = e instanceof GasError ? e.code : 'unknown';
    console.error('[admin]', action, code, e?.detail || '');
    if (CONFLICT_MESSAGES[code]) {
      invalidatePublicCache();
      return res.status(409).json({ error: CONFLICT_MESSAGES[code], code });
    }
    return res.status(code === 'not_found' ? 404 : code === 'too_many_blocks' ? 400 : 502).json({ error: 'Gagal menghubungi Google Sheet (' + code + ').' });
  }
}

const CONFLICT_MESSAGES = {
  date_taken: 'Kuota sesi di tanggal tersebut sudah penuh.',
  date_blocked: 'Tanggal tersebut diblok (jadwal terisi).',
  time_taken: 'Jam tersebut bentrok dengan sesi lain (termasuk jeda antar sesi).',
  time_blocked: 'Jam tersebut bentrok dengan jadwal terisi.',
};

// Edit data booking oleh admin (mis. klien salah mengisi form). Harga dihitung ulang bila paket/add-on/tanggal berubah,
// kecuali admin memilih mempertahankan harga lama.
async function editBooking(req, res, body) {
  const bad = (msg) => res.status(400).json({ error: msg });
  const id = String(body.id || '').slice(0, 40);
  if (!id) return bad('ID booking tidak valid.');
  const f = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const cur = (await gas('getBooking', { id })).booking;
  const { config } = await getPublicData();
  const pick = (k) => (f[k] === undefined ? cur[k] : f[k]);

  const clientName = String(pick('clientName')).trim().slice(0, 80);
  const phone = normalizePhone(pick('whatsapp'));
  const sessionDate = String(pick('sessionDate')).trim();
  const timeStart = String(f.timeStart ?? cur.timeStart).trim();
  const timeEnd = String(f.timeEnd ?? cur.timeEnd).trim();
  const location = String(pick('location')).trim().slice(0, 250);
  const email = String(pick('email') || '').trim().toLowerCase();
  const bank = String(pick('paymentBank')) === 'Jago' ? 'Jago' : 'BCA';
  if (!clientName) return bad('Nama tidak boleh kosong.');
  if (!phone) return bad('Nomor WhatsApp tidak valid.');
  if (!location) return bad('Lokasi tidak boleh kosong.');
  if (!validDate(sessionDate)) return bad('Tanggal sesi tidak valid.');
  if (!TIME.test(timeStart) || !TIME.test(timeEnd) || timeStart >= timeEnd) return bad('Jam sesi tidak valid (jam selesai harus setelah jam mulai).');
  if (email && (email.length > 120 || !EMAIL.test(email))) return bad('Format email tidak valid.');

  // Paket & add-on: bandingkan dengan pilihan saat ini (baris lama dicocokkan lewat nama).
  const curPkgId = cur.packageId || config.packages.find((p) => p.name === cur.packageName)?.id || '';
  const curAddonIds = cur.addonIds?.length ? cur.addonIds
    : String(cur.addons || '').split(', ').map((n) => config.addons.find((a) => a.name === n)?.id).filter(Boolean);
  const pkgId = f.packageId ? String(f.packageId) : curPkgId;
  const addonIds = Array.isArray(f.addonIds) ? f.addonIds.map(String) : curAddonIds;
  const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  const totalPeople = Math.max(1, Math.min(50, parseInt(pick('totalPeople'), 10) || 1));
  const changed = pkgId !== curPkgId || !sameSet(addonIds, curAddonIds) || sessionDate !== cur.sessionDate || totalPeople !== (Number(cur.totalPeople) || 0);

  let money = {
    packageName: cur.packageName, addons: cur.addons, subtotalPrice: cur.subtotalPrice, discountAmount: cur.discountAmount,
    discountLabel: cur.discountLabel, totalPrice: cur.totalPrice, dpAmount: cur.dpAmount, breakdown: cur.breakdown || '',
  };
  if (changed && pkgId) {
    const quote = computeQuote(config, { packageId: pkgId, addonIds, sessionDate, totalPeople, bookingDate: cur.bookingDate || wibToday(), lenient: true });
    if (!quote) return bad('Paket tidak ditemukan.');
    const names = { packageName: quote.pkg.name, addons: quote.addons.map((a) => a.name).join(', ') || '-' };
    money = body.keepPrice === true
      ? { ...money, ...names }
      : { ...names, subtotalPrice: quote.subtotal, discountAmount: quote.discountAmount, discountLabel: quote.discountLabel, totalPrice: quote.total, dpAmount: quote.dp, breakdown: quote.breakdown };
  }
  const discountInfo = money.discountAmount > 0
    ? `${money.discountLabel || 'Promo'} (-Rp ${Number(money.discountAmount).toLocaleString('id-ID')})` : '-';
  const note = (k, n) => safe(String(pick(k) ?? '').trim() || '-', n);

  const booking = {
    clientName: safe(clientName, 80),
    whatsapp: phone,
    sessionType: safe(String(pick('sessionType')).slice(0, 60), 60),
    sessionDate,
    timeSlot: `${timeStart} - ${timeEnd}`,
    location: safe(location, 250),
    totalPeople,
    childrenCount: Math.max(0, Math.min(20, parseInt(pick('childrenCount'), 10) || 0)),
    childrenDetails: note('childrenDetails', 300),
    preferences: note('preferences', 400),
    restrictions: note('restrictions', 400),
    paymentBank: bank,
    instagram: safe(String(pick('instagram') || '').replace(/^@/, ''), 40),
    email,
    packageId: pkgId,
    addonIds,
    ...money,
    packageName: safe(money.packageName, 80),
    addons: safe(money.addons, 300),
    discountLabel: safe(money.discountLabel || '', 80),
    breakdown: String(money.breakdown || '').slice(0, 2500),
    discountInfo: safe(discountInfo, 160),
  };
  const r = await gas('editBooking', { id, booking, force: body.force === true });
  invalidatePublicCache();
  return res.status(200).json({ ok: true, booking: r.booking });
}
