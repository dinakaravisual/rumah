// Semua syarat yang diisi harus terpenuhi: periode pemesanan (hari ini), periode sesi, tanggal sesi khusus, hari sesi.
function eligible(d, pkgId, dateIso, bookingIso) {
  if (!d?.enabled || Number(d.value) <= 0) return false;
  if (d.bookStartDate && bookingIso < d.bookStartDate) return false;
  if (d.bookEndDate && bookingIso > d.bookEndDate) return false;
  if (d.sessionDates?.length && !d.sessionDates.includes(dateIso)) return false;
  if (d.targetPkgId && d.targetPkgId !== 'ALL' && d.targetPkgId !== pkgId) return false;
  if (d.startDate && dateIso < d.startDate) return false;
  if (d.endDate && dateIso > d.endDate) return false;
  if (d.allowedDays?.length) {
    const [y, m, day] = dateIso.split('-').map(Number);
    if (!d.allowedDays.includes(new Date(Date.UTC(y, m - 1, day)).getUTCDay())) return false;
  }
  return true;
}

function amountFor(d, price) {
  const raw = d.type === 'percent' ? Math.round(price * (d.value / 100)) : d.value;
  return Math.max(0, Math.min(price, raw));
}

// Harga dihitung ulang di server dari config; nilai dari browser tidak dipercaya.
// Promo hanya memotong harga paket (bukan add-on). Beberapa promo yang cocok: "best" = ambil potongan terbesar
// (seri: yang paling atas di daftar), "stack" = jumlahkan semuanya (maksimal sebesar harga paket).
export function computeQuote(config, { packageId, addonIds, sessionDate, bookingDate = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10), lenient = false }) {
  const pkg = config.packages.find((p) => p.id === packageId && (lenient || !p.archived)); // lenient: edit admin boleh memakai paket/add-on yang sudah disembunyikan
  if (!pkg) return null;
  const wanted = new Set(Array.isArray(addonIds) ? addonIds.map(String) : []);
  const addons = config.addons.filter((a) => (lenient || a.active) && wanted.has(a.id));
  const subtotal = pkg.price + addons.reduce((s, a) => s + a.price, 0);

  const cands = (config.discounts || []).filter((d) => eligible(d, pkg.id, sessionDate, bookingDate))
    .map((d) => ({ d, amount: amountFor(d, pkg.price) })).filter((x) => x.amount > 0);
  let used = [], discountAmount = 0;
  if (cands.length) {
    if (config.settings?.discountMode === 'stack') {
      used = cands;
      discountAmount = Math.min(pkg.price, cands.reduce((s, x) => s + x.amount, 0));
    } else {
      const best = cands.reduce((a, b) => (b.amount > a.amount ? b : a));
      used = [best];
      discountAmount = best.amount;
    }
  }
  const total = Math.max(0, subtotal - discountAmount);
  return {
    pkg, addons, subtotal, discountAmount, total,
    dp: Math.round(total * 0.5),
    discountLabel: used.map((x) => x.d.title).join(' + '),
  };
}
