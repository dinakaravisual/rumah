// Validasi dan pembersih input yang dipakai bersama oleh pemesanan klien dan edit oleh admin.

// Cegah formula injection di Sheet (nilai diawali = + - @).
export const safe = (v, n) => {
  const s = String(v ?? '').trim().slice(0, n);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};

export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.startsWith('62')) d = d.slice(2);
  d = d.replace(/^0+/, '');
  return d.length >= 8 && d.length <= 13 ? `62${d}` : null;
}

export const wibToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
