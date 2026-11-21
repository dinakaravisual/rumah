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

// Diskon satu add-on (persen atau nominal), tidak pernah melebihi harga add-on itu sendiri.
export function addonDiscountOf(a) {
  const v = Number(a?.discountValue) || 0, price = Number(a?.price) || 0;
  if (v <= 0 || price <= 0) return 0;
  const raw = a.discountType === 'nominal' ? v : Math.round(price * (v / 100));
  return Math.max(0, Math.min(price, raw));
}

// Biaya peserta tambahan: hanya orang di atas jumlah yang sudah termasuk paket.
export function extraPeopleFee(settings, totalPeople) {
  const fee = Math.max(0, Number(settings?.extraPersonFee) || 0);
  const included = Math.max(1, Number(settings?.includedPeople) || 3);
  const people = Math.max(1, Math.min(50, parseInt(totalPeople, 10) || 1));
  const extra = fee > 0 ? Math.max(0, people - included) : 0;
  return { fee, included, people, extra, amount: extra * fee };
}

// Harga dihitung ulang di server dari config; nilai dari browser tidak dipercaya.
// Promo hanya memotong harga paket (bukan add-on). Beberapa promo yang cocok: "best" = ambil potongan terbesar
// (seri: yang paling atas di daftar), "stack" = jumlahkan semuanya (maksimal sebesar harga paket).
// Add-on punya diskon sendiri-sendiri; peserta tambahan dikenakan biaya per orang dan tidak kena promo.
// subtotal = paket + add-on (setelah diskon add-on) + biaya peserta tambahan; total = subtotal - promo paket.
export function computeQuote(config, { packageId, addonIds, sessionDate, totalPeople = 0, bookingDate = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10), lenient = false }) {
  const pkg = config.packages.find((p) => p.id === packageId && (lenient || !p.archived)); // lenient: edit admin boleh memakai paket/add-on yang sudah disembunyikan
  if (!pkg) return null;
  const wanted = new Set(Array.isArray(addonIds) ? addonIds.map(String) : []);
  const addons = config.addons.filter((a) => (lenient || a.active) && wanted.has(a.id))
    .map((a) => { const discount = addonDiscountOf(a); return { ...a, discount, net: a.price - discount }; });
  const addonDiscount = addons.reduce((s, a) => s + a.discount, 0);
  const ppl = totalPeople ? extraPeopleFee(config.settings, totalPeople) : { fee: 0, included: 0, people: 0, extra: 0, amount: 0 };
  const subtotal = pkg.price + addons.reduce((s, a) => s + a.net, 0) + ppl.amount;

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
  const discountLabel = used.map((x) => x.d.title).join(' + ');

  // Rincian harga yang dibekukan saat booking dibuat (agar invoice lama tidak berubah bila harga di pengaturan diubah nanti).
  const lines = [{ k: 'pkg', n: pkg.name.slice(0, 60), a: pkg.price }];
  addons.slice(0, 15).forEach((a) => lines.push({ k: 'add', n: a.name.slice(0, 50), a: a.price, d: a.discount }));
  if (ppl.amount > 0) lines.push({ k: 'ppl', q: ppl.extra, u: ppl.fee, a: ppl.amount, i: ppl.included });
  if (discountAmount > 0) lines.push({ k: 'promo', n: discountLabel.slice(0, 60), a: discountAmount });
  let breakdown = JSON.stringify(lines);
  if (breakdown.length > 2500) breakdown = '';

  return {
    pkg, addons, subtotal, discountAmount, total, addonDiscount,
    extraPeople: ppl.extra, extraFee: ppl.amount, extraUnit: ppl.fee,
    dp: Math.round(total * 0.5),
    discountLabel, breakdown,
  };
}
