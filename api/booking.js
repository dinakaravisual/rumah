import crypto from 'crypto';
import { gas, GasError } from '../lib/gas.js';
import { getPublicData, invalidatePublicCache } from '../lib/config.js';
import { computeQuote } from '../lib/pricing.js';
import { clientIpHash, originAllowed } from '../lib/http.js';
import { EMAIL, TIME, normalizePhone, safe, validDate } from '../lib/validate.js';

const escapeTg = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const note = (v) => { const t = String(v || '').replace(/^'/, '').trim(); return t && t !== '-'; };

async function notifyTelegram(text) {
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!token || !chat) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) console.error('[booking] telegram status', r.status);
  } catch (e) {
    console.error('[booking] telegram gagal:', e?.name);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!originAllowed(req)) return res.status(403).json({ error: 'Akses ditolak.' });

  const data = req.body || {};
  if (data._hp_field) return res.status(200).json({ success: true, bookingId: 'BKR-0000000000' }); // honeypot: bot dikelabui
  if (Date.now() - Number(data._opened_at || 0) < 3000) {
    return res.status(400).json({ error: 'Formulir terkirim terlalu cepat. Coba lagi.' });
  }

  const clientName = String(data.clientName || '').trim().slice(0, 80);
  const phone = normalizePhone(data.whatsapp);
  const sessionDate = String(data.sessionDate || '').trim();
  const timeStart = String(data.timeStart || '').trim();
  const timeEnd = String(data.timeEnd || '').trim();
  const location = String(data.location || '').trim().slice(0, 250);

  if (!clientName || !phone || !location || !validDate(sessionDate)) {
    return res.status(400).json({ error: 'Data booking tidak valid atau belum lengkap.' });
  }
  const email = String(data.email || '').trim().toLowerCase();
  if (email && (email.length > 120 || !EMAIL.test(email))) {
    return res.status(400).json({ error: 'Format email tidak valid.' });
  }
  if (!TIME.test(timeStart) || !TIME.test(timeEnd) || timeStart >= timeEnd) {
    return res.status(400).json({ error: 'Jam sesi tidak valid (jam selesai harus setelah jam mulai).' });
  }
  const todayWIB = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  if (sessionDate < todayWIB) return res.status(400).json({ error: 'Tanggal sesi sudah terlewat.' });

  let pub;
  try { pub = await getPublicData(); } catch (e) {
    console.error('[booking] config', e?.code);
    return res.status(e?.code === 'not_configured' ? 500 : 502).json({ error: 'Server belum siap menerima booking. Hubungi admin.' });
  }
  const { config } = pub;
  const totalPeople = Math.max(1, Math.min(50, parseInt(data.totalPeople, 10) || 1));
  const quote = computeQuote(config, { packageId: String(data.packageId || ''), addonIds: data.addonIds, sessionDate, totalPeople, bookingDate: todayWIB });
  if (!quote) return res.status(400).json({ error: 'Paket tidak tersedia. Muat ulang halaman lalu pilih paket lagi.' });
  const sessionType = config.sessionTypes.includes(String(data.sessionType)) ? String(data.sessionType) : null;
  if (!sessionType) return res.status(400).json({ error: 'Tipe sesi tidak valid.' });
  const st = config.settings;
  const banks = [st.bcaActive && st.bcaNo ? 'BCA' : null, st.jagoActive && st.jagoNo ? 'Jago' : null].filter(Boolean);
  if (!banks.length) return res.status(400).json({ error: 'Rekening pembayaran belum tersedia. Hubungi admin.' });
  const bank = String(data.paymentBank || '');
  if (!banks.includes(bank)) return res.status(400).json({ error: 'Rekening yang dipilih sedang tidak tersedia. Muat ulang halaman lalu pilih rekening lain.' });

  const bookingId = `BKR-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const addonsText = quote.addons.map((a) => a.name).join(', ') || '-';
  const discountInfo = quote.discountAmount > 0
    ? `${quote.discountLabel} (-Rp ${quote.discountAmount.toLocaleString('id-ID')})` : '-';
  const children = Math.max(0, Math.min(20, parseInt(data.childrenCount, 10) || 0));

  const booking = {
    bookingId,
    createdAt: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
    clientName: safe(clientName, 80),
    whatsapp: phone,
    sessionType: safe(sessionType, 60),
    sessionDate,
    timeSlot: `${timeStart} - ${timeEnd}`,
    location: safe(location, 250),
    totalPeople,
    childrenCount: children,
    childrenDetails: safe(data.childrenDetails || '-', 300),
    packageName: safe(quote.pkg.name, 80),
    addons: safe(addonsText, 300),
    preferences: safe(data.preferences || '-', 400),
    restrictions: safe(data.restrictions || '-', 400),
    paymentBank: bank,
    discountInfo: safe(discountInfo, 160),
    email,
    instagram: safe(String(data.instagram || '').replace(/^@/, ''), 40),
    bookingDate: todayWIB,
    packageId: quote.pkg.id,
    addonIds: quote.addons.map((a) => a.id),
    subtotalPrice: quote.subtotal,
    discountAmount: quote.discountAmount,
    discountLabel: safe(quote.discountLabel, 80),
    totalPrice: quote.total,
    dpAmount: quote.dp,
    breakdown: quote.breakdown,
  };

  try {
    await gas('createBooking', { booking, ip: clientIpHash(req) });
  } catch (e) {
    const code = e instanceof GasError ? e.code : 'unknown';
    console.error('[booking] sheet gagal:', code, e?.detail || '');
    if (['date_taken', 'date_blocked', 'time_taken', 'time_blocked'].includes(code)) {
      invalidatePublicCache();
      const msg = {
        date_taken: 'Maaf, kuota sesi di tanggal tersebut baru saja penuh. Silakan pilih tanggal lain.',
        date_blocked: 'Maaf, tanggal tersebut tidak tersedia. Silakan pilih tanggal lain.',
        time_taken: 'Jam tersebut bentrok dengan sesi lain (termasuk jeda antar sesi). Silakan pilih jam lain.',
        time_blocked: 'Jam tersebut tidak tersedia. Silakan pilih jam lain.',
      }[code];
      return res.status(409).json({ error: msg, code });
    }
    if (code === 'rate_limited') return res.status(429).json({ error: 'Terlalu banyak percobaan booking. Coba lagi nanti.', code });
    return res.status(code === 'not_configured' ? 500 : 502).json({ error: 'Booking belum tersimpan karena gangguan server. Silakan coba lagi.', code });
  }
  invalidatePublicCache();

  await notifyTelegram([
    `🏡 <b>BOOKING BARU — BERKUNJUNG KE RUMAH</b>`,
    `ID: <code>${escapeTg(bookingId)}</code>`,
    ``,
    `👤 <b>Klien:</b> ${escapeTg(clientName)}`,
    `📱 <b>WA:</b> <a href="https://wa.me/${phone}">+${phone}</a>`,
    `📅 <b>Jadwal:</b> ${escapeTg(sessionDate)} (${escapeTg(timeStart)} - ${escapeTg(timeEnd)})`,
    `📍 <b>Lokasi:</b> ${escapeTg(location)}`,
    `👨‍👩‍👧 <b>Peserta:</b> ${booking.totalPeople} orang (${children} anak)`,
    `📦 <b>Paket:</b> ${escapeTg(quote.pkg.name)}`,
    `➕ <b>Add-Ons:</b> ${escapeTg(addonsText)}`,
    quote.extraFee > 0 ? `👥 <b>Peserta tambahan:</b> ${quote.extraPeople} orang × Rp ${quote.extraUnit.toLocaleString('id-ID')} = Rp ${quote.extraFee.toLocaleString('id-ID')}` : null,
    quote.addonDiscount > 0 ? `🎁 <b>Diskon add-on:</b> -Rp ${quote.addonDiscount.toLocaleString('id-ID')}` : null,
    quote.discountAmount > 0 ? `🏷️ <b>Diskon:</b> ${escapeTg(discountInfo)}` : null,
    note(booking.preferences) ? `📝 <b>Momen yang diinginkan:</b> ${escapeTg(booking.preferences)}` : null,
    note(booking.restrictions) ? `⛔ <b>Hal yang tidak boleh:</b> ${escapeTg(booking.restrictions)}` : null,
    `💳 <b>Total Akhir:</b> Rp ${quote.total.toLocaleString('id-ID')} (DP: Rp ${quote.dp.toLocaleString('id-ID')} via ${bank})`,
  ].filter(Boolean).join('\n'));

  return res.status(200).json({
    success: true,
    bookingId,
    booking: {
      packageName: quote.pkg.name, addons: addonsText, subtotalPrice: quote.subtotal,
      discountAmount: quote.discountAmount, discountLabel: quote.discountLabel,
      totalPrice: quote.total, dpAmount: quote.dp, whatsapp: phone, breakdown: quote.breakdown,
    },
  });
}
