import { gas } from './gas.js';

const str = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const id = (v) => String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

// Placeholder: {nama} {id} {tanggal} {jam_mulai} {jam_selesai} {lokasi} {paket} {addon} {diskon} {total} {dp} {sisa}
// {tambahan} (biaya peserta tambahan + diskon add-on) {atas_nama} {bca} {jago} {link_drive} {link_galeri}. Baris yang hanya berisi placeholder kosong dihapus otomatis.
export const DEFAULT_WA_TEMPLATES = {
  invoice: [
    'Halo *{nama}* 🏡',
    'Terima kasih telah mempercayakan momen keluarga bersama *Berkunjung ke RUMAH*.',
    '',
    'Berikut rincian Invoice pemesanan Anda:',
    '• No. Invoice: *{id}*',
    '• Jadwal Sesi: *{tanggal}* ({jam_mulai} - {jam_selesai})',
    '• Paket: *{paket}*',
    '{tambahan}',
    '{diskon}',
    '• Total Biaya Akhir: *{total}*',
    '• Nominal DP (50%): *{dp}*',
    '',
    'Pembayaran dapat ditransfer ke rekening a.n. *{atas_nama}*:',
    '• Bank BCA: *{bca}*',
    '• Bank Jago: *{jago}*',
    '',
    'Mohon konfirmasi kembali setelah transfer DP agar jadwal kami kunci sepenuhnya. Terima kasih hangat! 🌿',
  ].join('\n'),
  delivery: [
    'Halo *{nama}* 🌿',
    'Terima kasih banyak sudah menyambut *Berkunjung ke RUMAH* di sesi foto kemarin!',
    '',
    'Berikut tautan seluruh file foto dan galeri pemilihan foto edit keluarga Anda:',
    '📂 *Google Drive (All Original Files):*',
    '{link_drive}',
    '',
    '✨ *Link Pilih Foto untuk Diedit:*',
    '{link_galeri}',
    '',
    'Silakan tandai foto-foto favorit keluarga dan kabari kami jika sudah selesai memilih ya. Hangat selalu! 🏡',
  ].join('\n'),
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Satu promo. Dipakai untuk membersihkan data dari dashboard maupun migrasi dari format lama (satu "discount").
function normalizeDiscount(d, pid) {
  const type = d.type === 'nominal' ? 'nominal' : 'percent';
  return {
    id: pid,
    enabled: Boolean(d.enabled),
    title: str(d.title, 80) || 'Promo Spesial',
    periodText: str(d.periodText, 120),
    type,
    value: num(d.value, 0, type === 'nominal' ? 100000000 : 100),
    targetPkgId: id(d.targetPkgId) || 'ALL',
    // Periode pemesanan = kapan klien membuat booking. Periode/tanggal sesi = tanggal foto yang dipilih klien.
    bookStartDate: DATE_RE.test(d.bookStartDate) ? d.bookStartDate : '',
    bookEndDate: DATE_RE.test(d.bookEndDate) ? d.bookEndDate : '',
    startDate: DATE_RE.test(d.startDate) ? d.startDate : '',
    endDate: DATE_RE.test(d.endDate) ? d.endDate : '',
    sessionDates: [...new Set((Array.isArray(d.sessionDates) ? d.sessionDates : []).filter((x) => DATE_RE.test(x)))].sort().slice(0, 60),
    allowedDays: [...new Set((Array.isArray(d.allowedDays) ? d.allowedDays : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))],
  };
}

export const DEFAULT_CONFIG = {
  settings: {
    coverUrl: 'https://images.unsplash.com/photo-1511895426328-dc8714191300?auto=format&fit=crop&w=1920&q=80',
    blurPx: 26, logoDataUrl: '', logoSize: 84,
    heroDesc: 'Home & Family Documentary Photography — Merekam hangatnya cerita keluarga di ruang paling nyaman.',
    adminWa: '', accountHolder: '', bcaNo: '', jagoNo: '', bcaActive: true, jagoActive: true,
    maxSessionsPerDay: 4, bufferMinutes: 60, discountMode: 'best',
    includedPeople: 3, extraPersonFee: 0,   // biaya per orang di atas jumlah yang sudah termasuk paket (0 = nonaktif)
  },
  discounts: [],
  sessionTypes: ['Intimate Home Session', 'Newborn & Postpartum at Home', 'Birthday / Tumbuh Kembang Anak', 'Extended Family Gathering'],
  packages: [
    { id: 'pkg1', name: 'Sesi Singkat di Rumah', price: 1250000, desc: '', archived: false, features: [{ label: 'Durasi', value: '1,5 jam' }, { label: 'Foto edit', value: '40 foto' }, { label: 'Semua file asli', value: 'via Google Drive' }] },
    { id: 'pkg2', name: 'Cerita Hangat Keluarga', price: 1750000, desc: '', archived: false, features: [{ label: 'Durasi', value: '2,5 jam' }, { label: 'Foto edit', value: '75 foto' }, { label: 'Semua file asli', value: 'via Google Drive' }, { label: 'Video reel', value: '30 detik' }] },
  ],
  addons: [
    { id: 'add1', name: 'Cetak Photobook Hardcover 20x20', price: 450000, active: true },
    { id: 'add2', name: 'Tambahan Durasi 1 Jam', price: 400000, active: true },
  ],
};

function normalizeDiscounts(input) {
  const legacy = input.discount && typeof input.discount === 'object' && (input.discount.enabled || Number(input.discount.value) > 0)
    ? [{ ...input.discount, id: 'promo_1' }] : [];
  const raw = Array.isArray(input.discounts) ? input.discounts : legacy; // format lama (satu diskon) otomatis dimigrasi
  const seen = new Set();
  return raw.slice(0, 20).filter((d) => d && typeof d === 'object').map((d, i) => {
    let pid = id(d.id) || `promo_${i + 1}`;
    while (seen.has(pid)) pid += '_';
    seen.add(pid);
    return normalizeDiscount(d, pid);
  });
}

// Membersihkan dan membatasi config apa pun (dari sheet maupun dari admin) sebelum dipakai/disimpan.
export function normalizeConfig(input = {}) {
  const d = DEFAULT_CONFIG;
  const s = { ...d.settings, ...(input.settings || {}) };
  const logo = String(s.logoDataUrl || '');
  return {
    settings: {
      coverUrl: str(s.coverUrl, 500) || d.settings.coverUrl,
      blurPx: num(s.blurPx, 0, 80) || 26,
      logoDataUrl: /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo) && logo.length <= 200000 ? logo : '',
      logoSize: num(s.logoSize, 20, 300) || 84,
      heroDesc: str(s.heroDesc, 300),
      adminWa: str(s.adminWa, 20).replace(/[^0-9]/g, ''),
      accountHolder: str(s.accountHolder, 80),
      bcaNo: str(s.bcaNo, 30),
      jagoNo: str(s.jagoNo, 30),
      bcaActive: s.bcaActive !== false,
      jagoActive: s.jagoActive !== false,
      maxSessionsPerDay: num(s.maxSessionsPerDay, 1, 10) || 4,
      bufferMinutes: num(s.bufferMinutes, 0, 240),
      discountMode: s.discountMode === 'stack' ? 'stack' : 'best',
      includedPeople: Number.isFinite(Number(s.includedPeople)) && Number(s.includedPeople) >= 1 ? Math.min(50, Math.floor(Number(s.includedPeople))) : 3,
      extraPersonFee: num(s.extraPersonFee, 0, 100000000),
    },
    discounts: normalizeDiscounts(input),
    sessionTypes: (Array.isArray(input.sessionTypes) ? input.sessionTypes : d.sessionTypes).map((t) => str(t, 60)).filter(Boolean).slice(0, 30),
    packages: (Array.isArray(input.packages) ? input.packages : d.packages).slice(0, 30)
      .map((p) => ({
        id: id(p.id), name: str(p.name, 80), price: num(p.price, 0, 100000000), desc: str(p.desc, 300), archived: Boolean(p.archived),
        // Kolom isi paket bebas (label + isi). Baris yang tidak lengkap dibuang.
        features: (Array.isArray(p.features) ? p.features : []).slice(0, 12)
          .map((f) => ({ label: str(f?.label, 40), value: str(f?.value, 80) })).filter((f) => f.label && f.value),
      }))
      .filter((p) => p.id && p.name),
    waTemplates: {
      invoice: str(input.waTemplates?.invoice, 3000) || DEFAULT_WA_TEMPLATES.invoice,
      delivery: str(input.waTemplates?.delivery, 3000) || DEFAULT_WA_TEMPLATES.delivery,
    },
    addons: (Array.isArray(input.addons) ? input.addons : d.addons).slice(0, 50)
      .map((a) => {
        const nominal = a.discountType === 'nominal';
        // Diskon per add-on: persen (0-100) atau nominal Rp (tidak boleh melebihi harga add-on).
        return {
          id: id(a.id), name: str(a.name, 80), price: num(a.price, 0, 100000000), active: a.active !== false,
          discountType: nominal ? 'nominal' : 'percent',
          discountValue: num(a.discountValue, 0, nominal ? 100000000 : 100),
        };
      })
      .filter((a) => a.id && a.name),
  };
}

let cache = null;
const TTL_MS = 10000;

export function invalidatePublicCache() { cache = null; }

// Sumber kebenaran: config + tanggal terisi dari Google Sheet (cache 10 detik per instance).
export async function getPublicData() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  const r = await gas('public');
  const config = normalizeConfig(r.config || {});
  const data = {
    config,
    bookedDates: Array.isArray(r.bookedDates) ? r.bookedDates : [],
    busyTimes: r.busyTimes && typeof r.busyTimes === 'object' ? r.busyTimes : {},
  };
  cache = { at: Date.now(), data };
  return data;
}
