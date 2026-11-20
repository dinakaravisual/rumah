import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeBackend, mockReq, mockRes } from './harness.js';

process.env.GSHEET_WEBHOOK_URL = 'https://script.test/exec';
process.env.GSHEET_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'pw-admin-123';
process.env.SESSION_SECRET = 'a-long-random-session-secret-xyz';
process.env.TELEGRAM_BOT_TOKEN = 't'; process.env.TELEGRAM_CHAT_ID = 'c';

const be = makeBackend();
let tgCalls = 0, tgFail = false, gasDown = false, lastTg = null;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.telegram.org')) { tgCalls++; lastTg = JSON.parse(opts.body); return { ok: !tgFail, status: tgFail ? 500 : 200 }; }
  if (gasDown) return { ok: true, text: async () => 'oops <html>' };
  return { ok: true, text: async () => JSON.stringify(be.post(JSON.parse(opts.body))) };
};

const { default: pub } = await import('../api/public.js');
const { default: booking } = await import('../api/booking.js');
const { default: auth } = await import('../api/auth.js');
const { default: adminRaw } = await import('../api/admin.js');
// Tes lama menyimpan config parsial; sisipkan rekening contoh agar booking tidak ditolak karena rekening kosong.
const admin = (req, res) => {
  const c = req.body?.action === 'saveConfig' ? req.body.config : null;
  if (c) c.settings = { adminWa: '6281', accountHolder: 'Studio', bcaNo: '111', jagoNo: '222', ...(c.settings || {}) };
  return adminRaw(req, res);
};
const { invalidatePublicCache } = await import('../lib/config.js');

const call = async (h, req) => { const res = mockRes(); await h(req, res); return res; };
const future = (d) => new Date(Date.now() + d * 864e5 + 7 * 3600e3).toISOString().slice(0, 10);
const goodBody = (o = {}) => ({
  _opened_at: Date.now() - 20000, clientName: 'Bima', whatsapp: '0812-3456-7890', sessionType: 'Intimate Home Session',
  sessionDate: future(10), timeStart: '09:00', timeEnd: '11:00', location: 'Sleman', totalPeople: 4, childrenCount: 2,
  packageId: 'pkg2', addonIds: ['add1'], paymentBank: 'BCA', ...o,
});
let cookie = '';

test('login: password salah ditolak, benar dapat cookie, admin tanpa cookie 401', async () => {
  assert.equal((await call(auth, mockReq({ body: { password: 'salah' } }))).code, 401);
  const ok = await call(auth, mockReq({ body: { password: 'pw-admin-123' } }));
  assert.equal(ok.code, 200);
  cookie = ok.headers['Set-Cookie'].split(';')[0];
  assert.equal((await call(admin, mockReq({ body: { action: 'bookings' } }))).code, 401);
  assert.equal((await call(admin, mockReq({ body: { action: 'bookings' }, headers: { ...mockReq().headers, cookie } }))).code, 200);
  assert.equal((await call(auth, mockReq({ method: 'GET', headers: { cookie } }))).code, 200);
  assert.equal((await call(auth, mockReq({ method: 'DELETE' }))).headers['Set-Cookie'].includes('Max-Age=0'), true);
});

test('login: dibatasi setelah 10 percobaan', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call(auth, mockReq({ body: { password: 'x' }, headers: { ...mockReq().headers, 'x-forwarded-for': '9.9.9.9' } }));
  assert.equal(last.code, 429);
});

test('belum dikonfigurasi admin: configured=false, lalu true setelah admin simpan rekening', async () => {
  assert.equal((await call(pub, mockReq({ method: 'GET' }))).body.configured, false);
  const h = { ...mockReq().headers, cookie };
  const cfg = { settings: { adminWa: '081234', accountHolder: 'Studio', bcaNo: '111', jagoNo: '222' } };
  const r = await call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: cfg } }));
  assert.equal(r.code, 200);
  invalidatePublicCache();
  const p = await call(pub, mockReq({ method: 'GET' }));
  assert.equal(p.body.configured, true);
  assert.equal(p.body.config.settings.bcaNo, '111');
  assert.equal(p.body.config.packages.length, 2, 'paket default tetap ada bila tidak dikirim');
});

test('booking: harga dihitung server, input klien dipalsukan diabaikan, WA dinormalisasi', async () => {
  const r = await call(booking, mockReq({ body: goodBody({ totalPrice: 1, subtotalPrice: 1, discountAmount: 999999999 }) }));
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.booking.totalPrice, 1750000 + 450000);
  assert.equal(r.body.booking.dpAmount, 1100000);
  assert.match(r.body.bookingId, /^BKR-[0-9A-F]{10}$/);
  const row = be.sheets.Bookings.grid[1];
  assert.equal(row[3], '6281234567890');
  assert.equal(row[5], future(10));
  assert.equal(tgCalls, 1);
});

test('booking: tanggal yang sama ditolak 409, bahkan dari "browser lain"', async () => {
  const r = await call(booking, mockReq({ body: goodBody({ clientName: 'Orang Lain' }) }));
  assert.equal(r.code, 409);
  const p = await call(pub, mockReq({ method: 'GET' }));
  assert.deepEqual(p.body.busyTimes[future(10)], [['09:00', '11:00', 'b']]);
});

test('arsip lewat admin membebaskan tanggal; status Dibatalkan juga', async () => {
  const h = { ...mockReq().headers, cookie };
  const list = await call(admin, mockReq({ headers: h, body: { action: 'bookings' } }));
  const b = list.body.bookings[0];
  assert.equal(b.timeStart, '09:00'); assert.equal(b.whatsapp, '6281234567890'); assert.equal(b.totalPrice, 2200000);
  await call(admin, mockReq({ headers: h, body: { action: 'updateBooking', id: b.id, archived: true } }));
  invalidatePublicCache();
  assert.equal((await call(pub, mockReq({ method: 'GET' }))).body.busyTimes[future(10)], undefined, 'arsip membebaskan jam');
  assert.equal((await call(booking, mockReq({ body: goodBody({ clientName: 'Baru' }) }))).code, 200);
  const b2 = (await call(admin, mockReq({ headers: h, body: { action: 'bookings' } }))).body.bookings[0];
  await call(admin, mockReq({ headers: h, body: { action: 'updateBooking', id: b2.id, status: 'Dibatalkan' } }));
  invalidatePublicCache();
  assert.equal((await call(pub, mockReq({ method: 'GET' }))).body.busyTimes[future(10)], undefined, 'Dibatalkan membebaskan jam');
});

test('diskon: persen pada paket saja, hanya hari/tanggal yang diizinkan', async () => {
  const h = { ...mockReq().headers, cookie };
  const date = future(20), dow = new Date(date + 'T00:00:00Z').getUTCDay();
  const discount = { enabled: true, title: 'Promo', type: 'percent', value: 10, targetPkgId: 'pkg2', allowedDays: [dow] };
  await call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { discount } } }));
  invalidatePublicCache();
  const r = await call(booking, mockReq({ body: goodBody({ sessionDate: date }) }));
  assert.equal(r.body.booking.discountAmount, 175000);
  assert.equal(r.body.booking.totalPrice, 2200000 - 175000);
  const other = future(21);
  const r2 = await call(booking, mockReq({ body: goodBody({ sessionDate: other, packageId: 'pkg1', addonIds: [] }) }));
  assert.equal(r2.body.booking.discountAmount, 0);
  assert.equal(r2.body.booking.totalPrice, 1250000);
});

test('validasi & keamanan input', async () => {
  const bad = async (o, code, headers) => assert.equal((await call(booking, mockReq({ body: goodBody(o), ...(headers && { headers }) }))).code, code, JSON.stringify(o));
  await bad({ sessionDate: '2026-99-99' }, 400);
  await bad({ sessionDate: '2020-01-01' }, 400);
  await bad({ whatsapp: '123' }, 400);
  await bad({ timeStart: '11:00', timeEnd: '09:00' }, 400);
  await bad({ packageId: 'nope' }, 400);
  await bad({ sessionType: 'Karangan' }, 400);
  await bad({ _opened_at: Date.now() }, 400);
  await bad({ sessionDate: future(30) }, 403, { host: 'app.test', origin: 'https://evil.test' });
  await bad({ sessionDate: future(31) }, 403, { host: 'app.test', origin: 'https://app.test.evil.com' });
  const hp = await call(booking, mockReq({ body: goodBody({ _hp_field: 'x', sessionDate: future(32) }) }));
  assert.equal(hp.code, 200);
  assert.ok(!be.sheets.Bookings.grid.some((r) => r[5] === future(32)), 'honeypot tidak menulis ke sheet');
});

test('formula injection dinetralkan', async () => {
  const d = future(40);
  const r = await call(booking, mockReq({ body: goodBody({ sessionDate: d, clientName: '=HYPERLINK("http://x")', location: '-cmd' }) }));
  assert.equal(r.code, 200);
  const row = be.sheets.Bookings.grid.find((x) => x[5] === d);
  assert.ok(row[2].startsWith("'=")); assert.ok(row[7].startsWith("'-"));
});

test('Telegram gagal tidak menggagalkan booking; Sheet gagal -> error jujur (bukan sukses palsu)', async () => {
  tgFail = true;
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: future(50) }) }))).code, 200);
  tgFail = false;
  gasDown = true; invalidatePublicCache();
  const r = await call(booking, mockReq({ body: goodBody({ sessionDate: future(51) }) }));
  assert.ok(r.code >= 500 && r.body.error); gasDown = false;
});

test('booking dibatasi 5 percobaan/jam per IP', async () => {
  invalidatePublicCache();
  const h = { ...mockReq().headers, 'x-forwarded-for': '7.7.7.7' };
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await call(booking, mockReq({ headers: h, body: goodBody({ sessionDate: future(10) }) }))).code);
  assert.equal(codes.at(-1), 429, codes.join(','));
});

test('Apps Script menolak secret salah', () => {
  assert.equal(be.post({ secret: 'salah', action: 'public' }).error, 'unauthorized');
});

test('dashboard: status, pembayaran, dan link Drive tersimpan; link berbahaya ditolak', async () => {
  const h = { ...mockReq().headers, cookie };
  const d = future(60);
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: d }) }))).code, 200);
  const get = async () => (await call(admin, mockReq({ headers: h, body: { action: 'bookings' } }))).body.bookings.find((x) => x.sessionDate === d);
  const b = await get();
  assert.equal(b.payment, 'Belum bayar'); assert.equal(b.driveLink, '');
  const up = (patch) => call(admin, mockReq({ headers: h, body: { action: 'updateBooking', id: b.id, ...patch } }));
  assert.equal((await up({ payment: 'Lunas', status: 'Terjadwal' })).code, 200);
  const link = 'https://drive.google.com/drive/folders/abc123?usp=sharing';
  assert.equal((await up({ driveLink: link })).code, 200);
  const after = await get();
  assert.equal(after.payment, 'Lunas'); assert.equal(after.status, 'Terjadwal'); assert.equal(after.driveLink, link);
  for (const bad of ['http://drive.google.com/x', 'https://evil.com/drive.google.com', 'javascript:alert(1)', 'https://drive.google.com.evil.com/x'])
    assert.equal((await up({ driveLink: bad })).code, 400, bad);
  assert.equal((await up({ payment: 'Gratis', status: 'Ngawur' })).code, 200); // nilai di luar daftar diabaikan
  const same = await get();
  assert.equal(same.payment, 'Lunas'); assert.equal(same.status, 'Terjadwal');
  assert.equal((await up({ driveLink: '' })).code, 200);
  assert.equal((await get()).driveLink, '');
  const noAuth = await call(admin, mockReq({ body: { action: 'updateBooking', id: b.id, payment: 'Belum bayar' } }));
  assert.equal(noAuth.code, 401);
});

test('kalender: event dibuat saat Terjadwal, diperbarui, dihapus saat Dibatalkan; gagal kalender tidak merusak update', async () => {
  const h = { ...mockReq().headers, cookie };
  const d = future(70);
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: d, clientName: 'Sari' }) }))).code, 200);
  const get = async () => (await call(admin, mockReq({ headers: h, body: { action: 'bookings' } }))).body.bookings.find((x) => x.sessionDate === d);
  const b = await get();
  const up = (patch) => call(admin, mockReq({ headers: h, body: { action: 'updateBooking', id: b.id, ...patch } }));
  const base = be.events.size;
  assert.equal((await get()).inCalendar, false);
  await up({ status: 'Terjadwal', payment: 'DP' });
  assert.equal(be.events.size, base + 1, 'Menunggu DP belum masuk kalender; Terjadwal membuat 1 event');
  const ev = [...be.events.values()].find((e) => e.title.includes('Sari'));
  assert.ok(ev); assert.equal(ev.location, 'Sleman');
  assert.equal(ev.start.toISOString(), new Date(`${d}T09:00:00+07:00`).toISOString());
  assert.equal(ev.end.toISOString(), new Date(`${d}T11:00:00+07:00`).toISOString());
  assert.match(ev.description, /wa\.me\/6281234567890/); assert.match(ev.description, /Pembayaran: DP/);
  assert.equal((await get()).inCalendar, true);
  const sizeBefore = be.events.size;
  await up({ payment: 'Lunas' });
  assert.equal(be.events.size, sizeBefore, 'update tidak menggandakan event');
  assert.match(ev.description, /Pembayaran: Lunas/);
  await up({ archived: true });
  assert.ok(be.events.has(ev.id), 'arsip tidak menghapus event');
  await up({ archived: false });
  await up({ status: 'Dibatalkan' });
  assert.ok(!be.events.has(ev.id)); assert.equal((await get()).inCalendar, false);
  be.setCalFail(true);
  assert.equal((await up({ status: 'Terjadwal' })).code, 200, 'kalender gagal tetap sukses ubah status');
  assert.equal((await get()).status, 'Terjadwal');
  be.setCalFail(false);
  be.post({ secret: 'test-secret', action: 'listBookings' });
});

test('email klien: divalidasi, disimpan, dan jadi tamu undangan kalender (plus EXTRA_GUESTS)', async () => {
  const h = { ...mockReq().headers, cookie };
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: future(80), email: 'bukan-email' }) }))).code, 400);
  be.props.EXTRA_GUESTS = 'Fotografer2@Studio.id, salah, klien@mail.com';
  const d = future(81);
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: d, clientName: 'Tamu', email: ' Klien@Mail.com ' }) }))).code, 200);
  const b = (await call(admin, mockReq({ headers: h, body: { action: 'bookings' } }))).body.bookings.find((x) => x.sessionDate === d);
  assert.equal(b.email, 'klien@mail.com');
  await call(admin, mockReq({ headers: h, body: { action: 'updateBooking', id: b.id, status: 'Terjadwal' } }));
  const ev = [...be.events.values()].find((e) => e.title.includes('Tamu'));
  assert.equal(ev.guests, 'klien@mail.com,Fotografer2@Studio.id');
  assert.equal(ev.sendInvites, true); assert.equal(ev.seeGuests, false);
  be.props.INVITE_CLIENT = 'tidak';
  const d2 = future(82);
  await call(booking, mockReq({ body: goodBody({ sessionDate: d2, clientName: 'Privat', email: 'p@mail.com' }) }));
  const b2 = (await call(admin, mockReq({ headers: h, body: { action: 'bookings' } }))).body.bookings.find((x) => x.sessionDate === d2);
  await call(admin, mockReq({ headers: h, body: { action: 'updateBooking', id: b2.id, status: 'Terjadwal' } }));
  assert.equal([...be.events.values()].find((e) => e.title.includes('Privat')).guests, 'Fotografer2@Studio.id,klien@mail.com', 'email klien p@mail.com tidak diundang');
  delete be.props.EXTRA_GUESTS; delete be.props.INVITE_CLIENT;
});

test('galeri: link https tersimpan, http/javascript ditolak, ikut di daftar booking', async () => {
  const h = { ...mockReq().headers, cookie };
  const d = future(100);
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: d, clientName: 'Galeri' }) }))).code, 200);
  const get = async () => (await call(admin, mockReq({ headers: h, body: { action: 'bookings' } }))).body.bookings.find((x) => x.sessionDate === d);
  const b = await get();
  const up = (patch) => call(admin, mockReq({ headers: h, body: { action: 'updateBooking', id: b.id, ...patch } }));
  assert.equal(b.galleryLink, '');
  assert.equal((await up({ galleryLink: 'https://galeri-saya.vercel.app/klien/abc' })).code, 200);
  assert.equal((await get()).galleryLink, 'https://galeri-saya.vercel.app/klien/abc');
  for (const bad of ['http://galeri.test/x', 'javascript:alert(1)', 'ftp://x.y']) assert.equal((await up({ galleryLink: bad })).code, 400, bad);
  assert.equal((await up({ galleryLink: '' })).code, 200);
  assert.equal((await get()).galleryLink, '');
});

test('jadwal terisi manual: blok tanggal tampil penuh, booking ditolak, hapus membuka lagi', async () => {
  const h = { ...mockReq().headers, cookie };
  const a = (body) => call(admin, mockReq({ headers: h, body }));
  const s = future(110), e = future(112);
  assert.equal((await call(admin, mockReq({ body: { action: 'addBlock', start: s } }))).code, 401);
  assert.equal((await a({ action: 'addBlock', start: e, end: s })).code, 400);
  assert.equal((await a({ action: 'addBlock', start: '2026-02-31' })).code, 400);
  assert.equal((await a({ action: 'addBlock', start: '2020-01-01' })).code, 400);
  const add = await a({ action: 'addBlock', start: s, end: e, note: 'Wedding klien lain' });
  assert.equal(add.code, 200);
  invalidatePublicCache();
  const p = (await call(pub, mockReq({ method: 'GET' }))).body;
  for (const d of [s, future(111), e]) assert.ok(p.bookedDates.includes(d), d);
  assert.ok(!p.bookedDates.includes(future(113)));
  assert.ok(!JSON.stringify(p).includes('Wedding'), 'catatan tidak bocor ke publik');
  const r = await call(booking, mockReq({ body: goodBody({ sessionDate: future(111) }) }));
  assert.equal(r.code, 409);
  assert.equal((await a({ action: 'blocks' })).body.blocks.length >= 1, true);
  await a({ action: 'deleteBlock', id: add.body.block.id });
  invalidatePublicCache();
  assert.ok(!(await call(pub, mockReq({ method: 'GET' }))).body.bookedDates.includes(future(111)));
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: future(111), clientName: 'Boleh' }) }))).code, 200);
});

test('impor Google Calendar lain: all-day (akhir eksklusif) dan jam-jaman memblokir tanggal', async () => {
  const allDay = (a, b) => ({ getId: () => 'x' + a, isAllDayEvent: () => true, getAllDayStartDate: () => new Date(`${a}T00:00:00+07:00`), getAllDayEndDate: () => new Date(`${b}T00:00:00+07:00`) });
  const timed = (a, b) => ({ getId: () => 'y' + a, isAllDayEvent: () => false, getStartTime: () => new Date(`${a}T20:00:00+07:00`), getEndTime: () => new Date(`${b}T23:00:00+07:00`) });
  be.ext.push(allDay(future(120), future(122)), timed(future(130), future(130)));
  be.props.BLOCK_CALENDAR_IDS = 'kerja@group.calendar.google.com';
  invalidatePublicCache();
  const p = (await call(pub, mockReq({ method: 'GET' }))).body;
  assert.ok(p.bookedDates.includes(future(120)) && p.bookedDates.includes(future(121)));
  assert.ok(!p.bookedDates.includes(future(122)), 'akhir all-day bersifat eksklusif');
  assert.ok(!p.bookedDates.includes(future(130)), 'event berjam tidak mengunci seharian');
  assert.deepEqual(p.busyTimes[future(130)], [['20:00', '23:00', 'x']]);
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: future(130), timeStart: '21:00', timeEnd: '22:00' }) }))).code, 409);
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: future(130), timeStart: '09:00', timeEnd: '11:00', clientName: 'Pagi' }) }))).code, 200);
  delete be.props.BLOCK_CALENDAR_IDS; be.ext.length = 0;
});

test('/api/public?fresh=1 hanya melewati cache bila admin', async () => {
  invalidatePublicCache();
  await call(pub, mockReq({ method: 'GET' }));
  const anon = await call(pub, mockReq({ method: 'GET', query: { fresh: '1' } }));
  assert.equal(anon.code, 200);
  const adm = await call(pub, mockReq({ method: 'GET', query: { fresh: '1' }, headers: { ...mockReq().headers, cookie } }));
  assert.equal(adm.code, 200);
});

test('banyak sesi per hari: hanya jam bentrok (termasuk jeda) yang ditolak; penuh setelah kuota tercapai', async () => {
  invalidatePublicCache();
  const d = future(140);
  const book = (a, b, name) => call(booking, mockReq({ body: goodBody({ sessionDate: d, timeStart: a, timeEnd: b, clientName: name }) }));
  const pubBody = async () => { invalidatePublicCache(); return (await call(pub, mockReq({ method: 'GET' }))).body; };
  assert.equal((await book('09:00', '11:00', 'S1')).code, 200);
  let p = await pubBody();
  assert.ok(!p.bookedDates.includes(d), 'satu sesi 2 jam tidak mengunci hari');
  assert.deepEqual(p.busyTimes[d], [['09:00', '11:00', 'b']]);
  assert.equal((await book('11:30', '12:30', 'bentrok-jeda')).code, 409);   // jeda 60 menit
  assert.equal((await book('10:00', '12:00', 'tumpang-tindih')).code, 409);
  const j = (await book('15:30', '17:00', 'sebelum-jeda'));
  assert.equal(j.code, 200, JSON.stringify(j.body));
  assert.equal((await book('13:00', '14:30', 'S3')).code, 200);              // tepat di antara, jeda terpenuhi
  assert.equal((await book('17:30', '18:30', 'S4')).code, 409);              // jeda 60 menit dari 17:00 belum terpenuhi
  assert.equal((await book('18:00', '19:00', 'S4b')).code, 200);             // tepat 60 menit setelah 17:00
  assert.equal((await book('21:00', '22:00', 'S5')).code, 409, 'kuota 4 sesi tercapai');
  p = await pubBody();
  assert.ok(p.bookedDates.includes(d), 'penuh setelah kuota tercapai');
  assert.equal(p.busyTimes[d].length, 4);
});

test('aturan sesi dari admin: kuota 2 dan jeda 0 menit', async () => {
  const h = { ...mockReq().headers, cookie };
  const cur = (await call(pub, mockReq({ method: 'GET' }))).body.config.settings;
  const set = (o) => call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { settings: { ...cur, ...o } } } }));
  assert.equal((await set({ maxSessionsPerDay: 2, bufferMinutes: 0 })).code, 200);
  invalidatePublicCache();
  const d = future(150);
  const book = (a, b, name) => call(booking, mockReq({ body: goodBody({ sessionDate: d, timeStart: a, timeEnd: b, clientName: name }) }));
  assert.equal((await book('09:00', '11:00', 'K1')).code, 200);
  assert.equal((await book('11:00', '13:00', 'K2')).code, 200, 'jeda 0: boleh langsung menyambung');
  assert.equal((await book('15:00', '16:00', 'K3')).code, 409, 'kuota 2 tercapai');
  invalidatePublicCache();
  assert.ok((await call(pub, mockReq({ method: 'GET' }))).body.bookedDates.includes(d));
  await set({ maxSessionsPerDay: 99, bufferMinutes: 9999 });   // dibatasi ke 10 dan 240
  invalidatePublicCache();
  const s2 = (await call(pub, mockReq({ method: 'GET' }))).body.config.settings;
  assert.equal(s2.maxSessionsPerDay, 10); assert.equal(s2.bufferMinutes, 240);
  await set({ maxSessionsPerDay: 4, bufferMinutes: 60 });
  invalidatePublicCache();
});

test('blok manual berjam: hanya jam itu yang tertutup; blok berjam multi-hari ditolak', async () => {
  const h = { ...mockReq().headers, cookie };
  const a = (body) => call(admin, mockReq({ headers: h, body }));
  const d = future(160);
  assert.equal((await a({ action: 'addBlock', start: d, end: future(161), timeStart: '09:00', timeEnd: '12:00' })).code, 400);
  assert.equal((await a({ action: 'addBlock', start: d, timeStart: '12:00', timeEnd: '09:00' })).code, 400);
  const add = await a({ action: 'addBlock', start: d, timeStart: '09:00', timeEnd: '12:00', note: 'Shooting klien lain' });
  assert.equal(add.code, 200);
  invalidatePublicCache();
  const p = (await call(pub, mockReq({ method: 'GET' }))).body;
  assert.ok(!p.bookedDates.includes(d));
  assert.deepEqual(p.busyTimes[d], [['09:00', '12:00', 'x']]);
  assert.ok(!JSON.stringify(p).includes('Shooting'));
  const book = (a2, b2, name) => call(booking, mockReq({ body: goodBody({ sessionDate: d, timeStart: a2, timeEnd: b2, clientName: name }) }));
  assert.equal((await book('11:00', '13:00', 'bentrok-blok')).code, 409);
  assert.equal((await book('12:00', '14:00', 'pas-setelah-blok')).code, 200, 'blok tidak memakai jeda');
  await a({ action: 'deleteBlock', id: add.body.block.id });
});

test('paket: kolom isi paket dibersihkan, urutan array dipertahankan, template WA tersimpan/default', async () => {
  const h = { ...mockReq().headers, cookie };
  const cur = (await call(pub, mockReq({ method: 'GET' }))).body;
  const pkgs = [
    { id: 'b', name: 'Paket B', price: 2000000, desc: '', archived: false, features: [
      { label: 'Foto edit', value: '40 foto' }, { label: 'Kosong', value: '' }, { label: '', value: 'tanpa label' }, { label: 'Cetak', value: '5 lembar 10R' } ] },
    { id: 'a', name: 'Paket A', price: 1000000, desc: 'Catatan', archived: true, features: Array.from({ length: 20 }, (_, i) => ({ label: 'K' + i, value: 'v' + i })) },
  ];
  const r = await call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { ...cur.config, packages: pkgs, waTemplates: { invoice: '  Halo {nama}!\n{diskon}  ', delivery: '' } } } }));
  assert.equal(r.code, 200);
  invalidatePublicCache();
  const p = (await call(pub, mockReq({ method: 'GET' }))).body;
  assert.deepEqual(p.config.packages.map((x) => x.id), ['b', 'a'], 'urutan hasil drag tersimpan');
  assert.deepEqual(p.config.packages[0].features, [{ label: 'Foto edit', value: '40 foto' }, { label: 'Cetak', value: '5 lembar 10R' }]);
  assert.equal(p.config.packages[1].features.length, 12, 'maksimal 12 kolom');
  assert.equal(p.config.packages[1].archived, true);
  assert.equal(p.config.waTemplates.invoice, 'Halo {nama}!\n{diskon}');
  assert.equal(p.config.waTemplates.delivery, p.waTemplateDefaults.delivery, 'template kosong kembali ke bawaan');
  assert.ok(p.waTemplateDefaults.invoice.includes('{nama}') && p.waTemplateDefaults.invoice.includes('{atas_nama}'));
  const r2 = await call(booking, mockReq({ body: goodBody({ sessionDate: future(170), packageId: 'a' }) }));
  assert.equal(r2.code, 400, 'paket disembunyikan tidak bisa dipesan');
  const r3 = await call(booking, mockReq({ body: goodBody({ sessionDate: future(171), packageId: 'b', addonIds: [] }) }));
  assert.equal(r3.code, 200);
  assert.equal(r3.body.booking.totalPrice, 2000000);
  // kembalikan paket bawaan agar tes lain tidak terpengaruh
  await call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { ...cur.config } } }));
  invalidatePublicCache();
});

test('banyak promo: masing-masing sendiri; "best" ambil terbesar, "stack" jumlahkan; promo mati/tidak cocok diabaikan', async () => {
  const h = { ...mockReq().headers, cookie };
  const cur = (await call(pub, mockReq({ method: 'GET' }))).body.config;
  const date = future(180), dow = new Date(date + 'T00:00:00Z').getUTCDay(), otherDow = (dow + 6) % 7; // bukan hari dari tanggal yang dipakai tes (dow..dow+4)
  const promo = (o) => ({ enabled: true, title: 'P', periodText: '', type: 'percent', value: 10, targetPkgId: 'ALL', startDate: '', endDate: '', allowedDays: [], ...o });
  const discounts = [
    promo({ id: 'a', title: 'Diskon 10%', value: 10 }),
    promo({ id: 'b', title: 'Potong 300rb', type: 'nominal', value: 300000 }),
    promo({ id: 'c', title: 'Khusus hari lain', value: 90, allowedDays: [otherDow] }),
    promo({ id: 'd', title: 'Mati', value: 90, enabled: false }),
    promo({ id: 'e', title: 'Khusus pkg1', value: 50, targetPkgId: 'pkg1' }),
  ];
  const save = (settingsPatch) => call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { ...cur, settings: { ...cur.settings, ...settingsPatch }, discounts } } }));
  const quote = async (packageId, n) => (await call(booking, mockReq({ body: goodBody({ sessionDate: future(n), packageId, addonIds: ['add1'] }) }))).body.booking;

  assert.equal((await save({ discountMode: 'best' })).code, 200);
  invalidatePublicCache();
  let q = await quote('pkg2', 180);                       // pkg2 = 1.750.000: 10% = 175.000, nominal = 300.000 -> terbesar 300.000
  assert.equal(q.discountAmount, 300000); assert.equal(q.discountLabel, 'Potong 300rb');
  assert.equal(q.totalPrice, 1750000 + 450000 - 300000);
  q = await quote('pkg1', 181);                           // pkg1 = 1.250.000: 10% = 125.000, 300rb, 50% = 625.000 -> 625.000
  assert.equal(q.discountAmount, 625000); assert.equal(q.discountLabel, 'Khusus pkg1');

  assert.equal((await save({ discountMode: 'stack' })).code, 200);
  invalidatePublicCache();
  q = await quote('pkg2', 182);                           // 175.000 + 300.000 digabung
  assert.equal(q.discountAmount, 475000); assert.equal(q.discountLabel, 'Diskon 10% + Potong 300rb');
  q = await quote('pkg1', 183);                           // 125.000 + 300.000 + 625.000 = 1.050.000 (< harga paket)
  assert.equal(q.discountAmount, 1050000);
  discounts.push(promo({ id: 'f', title: 'Besar', type: 'nominal', value: 99999999 }));
  assert.equal((await save({ discountMode: 'stack' })).code, 200);
  invalidatePublicCache();
  q = await quote('pkg1', 184);
  assert.equal(q.discountAmount, 1250000, 'gabungan tidak boleh melebihi harga paket');
  assert.equal(q.totalPrice, 450000, 'add-on tidak ikut didiskon');
  discounts.length = 0;
  await call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { ...cur, settings: { ...cur.settings, discountMode: 'best' }, discounts: [] } } }));
  invalidatePublicCache();
});

test('promo: format lama dimigrasi, data dibersihkan, id unik, maksimal 20, tidak ada kunci "discount" lagi', async () => {
  const { normalizeConfig } = await import('../lib/config.js');
  const mig = normalizeConfig({ discount: { enabled: true, title: 'Lama', type: 'percent', value: 15, allowedDays: [1, '2', 9, 'x'] } });
  assert.equal(mig.discounts.length, 1); assert.equal(mig.discounts[0].title, 'Lama'); assert.deepEqual(mig.discounts[0].allowedDays, [1, 2]);
  assert.equal('discount' in mig, false);
  assert.deepEqual(normalizeConfig({ discount: { enabled: false, value: 0 } }).discounts, []);
  const many = normalizeConfig({ discounts: Array.from({ length: 30 }, () => ({ id: 'sama', enabled: true, value: 500, type: 'percent', title: '<b>x</b>' })) }).discounts;
  assert.equal(many.length, 20); assert.equal(new Set(many.map((d) => d.id)).size, 20);
  assert.equal(many[0].value, 100, 'persen dibatasi 100');
  assert.equal(normalizeConfig({ discounts: [{ type: 'nominal', value: 9e12 }] }).discounts[0].value, 100000000);
  assert.equal(normalizeConfig({ discounts: [{ startDate: 'kemarin', endDate: '2026-13-99x' }] }).discounts[0].startDate, '');
  assert.equal(normalizeConfig({ settings: { discountMode: 'ngawur' } }).settings.discountMode, 'best');
  assert.equal(normalizeConfig({ discounts: 'bukan array' }).discounts.length, 0);
});

test('promo: periode pemesanan (hari klien memesan) dan tanggal sesi khusus pilihan admin', async () => {
  const h = { ...mockReq().headers, cookie };
  const cur = (await call(pub, mockReq({ method: 'GET' }))).body.config;
  const today = future(0), yday = future(-1), tmrw = future(1);
  const base = { enabled: true, type: 'nominal', value: 100000, targetPkgId: 'pkg1', periodText: '', startDate: '', endDate: '', allowedDays: [], bookStartDate: '', bookEndDate: '', sessionDates: [] };
  const run = async (discounts, n) => {
    await call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { ...cur, discounts } } }));
    invalidatePublicCache();
    const r = await call(booking, mockReq({ body: goodBody({ sessionDate: future(n), packageId: 'pkg1', addonIds: [] }) }));
    assert.equal(r.code, 200, JSON.stringify(r.body));
    return r.body.booking.discountAmount;
  };
  // periode pemesanan: berlaku bila HARI INI ada di dalam rentang, berapa pun tanggal sesinya
  assert.equal(await run([{ ...base, id: 'a', title: 'Hari ini', bookStartDate: today, bookEndDate: today }], 200), 100000);
  assert.equal(await run([{ ...base, id: 'a', title: 'Sudah lewat', bookEndDate: yday }], 201), 0, 'periode pemesanan sudah berakhir');
  assert.equal(await run([{ ...base, id: 'a', title: 'Belum mulai', bookStartDate: tmrw }], 202), 0, 'periode pemesanan belum mulai');
  // tanggal sesi khusus pilihan admin
  const sd = [future(204), future(206)];
  assert.equal(await run([{ ...base, id: 'a', title: 'Tgl khusus', sessionDates: sd }], 204), 100000);
  assert.equal(await run([{ ...base, id: 'a', title: 'Tgl khusus', sessionDates: sd }], 205), 0, 'di luar daftar tanggal khusus');
  // gabungan: syarat pemesanan DAN tanggal sesi harus terpenuhi bersamaan
  const both = { ...base, id: 'a', title: 'Gabungan', bookEndDate: today, sessionDates: [future(208)] };
  assert.equal(await run([both], 208), 100000);
  assert.equal(await run([both], 209), 0);
  assert.equal(await run([{ ...both, sessionDates: [future(211)], bookEndDate: yday }], 211), 0, 'periode pemesanan sudah lewat meski tanggal sesi cocok');
  // beberapa promo aktif bersamaan dengan harga berbeda (mode best)
  const many = [{ ...base, id: 'a', title: 'Kecil', value: 100000 }, { ...base, id: 'b', title: 'Besar', value: 400000 }, { ...base, id: 'c', title: 'Pkg2', targetPkgId: 'pkg2', value: 900000 }];
  assert.equal(await run(many, 210), 400000);
  // normalisasi
  const { normalizeConfig } = await import('../lib/config.js');
  const n = normalizeConfig({ discounts: [{ id: 'x', bookStartDate: 'besok', bookEndDate: '2026-12-31', sessionDates: ['2026-12-25', '2026-12-25', 'salah', '2026-12-24'] }] }).discounts[0];
  assert.equal(n.bookStartDate, ''); assert.equal(n.bookEndDate, '2026-12-31'); assert.deepEqual(n.sessionDates, ['2026-12-24', '2026-12-25']);
  assert.equal(normalizeConfig({ discounts: [{ id: 'y', sessionDates: Array.from({ length: 90 }, (_, i) => `2027-01-${String(i % 28 + 1).padStart(2, '0')}`).concat(Array.from({ length: 90 }, (_, i) => `2027-02-${String(i % 28 + 1).padStart(2, '0')}`)) }] }).discounts[0].sessionDates.length <= 60, true);
  await call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { ...cur, discounts: [] } } }));
  invalidatePublicCache();
});

test('Telegram memuat momen yang diinginkan dan hal yang tidak boleh; kosong/"-" tidak ditampilkan', async () => {
  const withNotes = await call(booking, mockReq({ body: goodBody({ sessionDate: future(300), clientName: 'Catatan', preferences: 'Foto bareng nenek di teras', restrictions: 'Jangan pakai flash, anak tidur' }) }));
  assert.equal(withNotes.code, 200);
  assert.match(lastTg.text, /Momen yang diinginkan:<\/b> Foto bareng nenek di teras/);
  assert.match(lastTg.text, /Hal yang tidak boleh:<\/b> Jangan pakai flash, anak tidur/);
  const none = await call(booking, mockReq({ body: goodBody({ sessionDate: future(301), clientName: 'Tanpa', preferences: '', restrictions: '-' }) }));
  assert.equal(none.code, 200);
  assert.ok(!lastTg.text.includes('Momen yang diinginkan') && !lastTg.text.includes('Hal yang tidak boleh'));
});

test('rekening: bisa diaktifkan/dimatikan; booking ke rekening mati ditolak; tanpa rekening aktif = belum siap', async () => {
  const h = { ...mockReq().headers, cookie };
  const cur = (await call(pub, mockReq({ method: 'GET' }))).body.config;
  const set = (o) => call(admin, mockReq({ headers: h, body: { action: 'saveConfig', config: { ...cur, settings: { ...cur.settings, ...o } } } }));
  const book = (n, bank) => call(booking, mockReq({ body: goodBody({ sessionDate: future(n), paymentBank: bank }) }));
  assert.equal((await book(310, 'Jago')).code, 200);
  await set({ jagoActive: false }); invalidatePublicCache();
  const p1 = (await call(pub, mockReq({ method: 'GET' }))).body;
  assert.equal(p1.config.settings.jagoActive, false); assert.equal(p1.configured, true);
  assert.equal((await book(311, 'Jago')).code, 400, 'rekening nonaktif ditolak');
  assert.equal((await book(311, 'BCA')).code, 200);
  await set({ bcaActive: false, jagoActive: false }); invalidatePublicCache();
  assert.equal((await call(pub, mockReq({ method: 'GET' }))).body.configured, false, 'tanpa rekening aktif');
  assert.equal((await book(312, 'BCA')).code, 400);
  await set({ bcaActive: true, jagoActive: true }); invalidatePublicCache();
  const { normalizeConfig } = await import('../lib/config.js');
  assert.equal(normalizeConfig({ settings: {} }).settings.bcaActive, true, 'bawaan aktif');
  assert.equal((await book(312, 'Jago')).code, 200);
});

test('edit booking: perbaiki data klien, harga dihitung ulang, bentrok perlu konfirmasi, event kalender ikut berubah', async () => {
  const h = { ...mockReq().headers, cookie };
  const a = (body) => call(admin, mockReq({ headers: h, body }));
  const d = future(320);
  const created = await call(booking, mockReq({ body: goodBody({ sessionDate: d, clientName: 'Salah Ketik', whatsapp: '0811-111-1111', location: 'Jl. Salah', packageId: 'pkg1', addonIds: [], instagram: '@salah', email: 'salah@mail.com' }) }));
  assert.equal(created.code, 200, JSON.stringify(created.body));
  const get = async () => (await a({ action: 'bookings' })).body.bookings.find((x) => x.id === created.body.bookingId);
  const b0 = await get();
  assert.equal(b0.bookingDate.length, 10); assert.equal(b0.packageId, 'pkg1'); assert.deepEqual(b0.addonIds, []);
  const edit = (fields, extra = {}) => a({ action: 'editBooking', id: b0.id, fields, ...extra });

  assert.equal((await call(admin, mockReq({ body: { action: 'editBooking', id: b0.id, fields: {} } }))).code, 401);
  assert.equal((await a({ action: 'editBooking', id: 'BKR-TIDAKADA', fields: {} })).code, 404);
  for (const bad of [{ clientName: '  ' }, { whatsapp: '12' }, { sessionDate: '2026-02-31' }, { timeStart: '12:00', timeEnd: '10:00' }, { email: 'x' }, { location: '' }])
    assert.equal((await edit(bad)).code, 400, JSON.stringify(bad));

  // perbaikan teks biasa: harga, status, link, dan arsip tidak berubah
  await a({ action: 'updateBooking', id: b0.id, status: 'Terjadwal', payment: 'DP', driveLink: 'https://drive.google.com/x' });
  const r1 = await edit({ clientName: 'Benar Nama', whatsapp: '0822-2222-2222', location: 'Jl. Benar 5', instagram: '@benar', email: 'Benar@Mail.com', totalPeople: 6, childrenCount: 3, childrenDetails: 'Anak 3 orang', preferences: 'Momen baru', restrictions: '=bahaya()' });
  assert.equal(r1.code, 200, JSON.stringify(r1.body));
  const b1 = await get();
  assert.equal(b1.clientName, 'Benar Nama'); assert.equal(b1.whatsapp, '6282222222222'); assert.equal(b1.location, 'Jl. Benar 5');
  assert.equal(b1.email, 'benar@mail.com'); assert.equal(b1.instagram, 'benar'); assert.equal(b1.totalPeople, 6); assert.equal(b1.preferences, 'Momen baru');
  assert.equal(b1.restrictions, '=bahaya()', 'tampil apa adanya; di sheet diberi awalan agar bukan rumus');
  assert.ok(String(be.sheets.Bookings.grid.find((r) => r[0] === b0.id)[14]).startsWith("'="));
  assert.equal(b1.totalPrice, b0.totalPrice); assert.equal(b1.status, 'Terjadwal'); assert.equal(b1.payment, 'DP'); assert.equal(b1.driveLink, 'https://drive.google.com/x');
  const ev = [...be.events.values()].find((e) => e.title.includes('Benar Nama'));
  assert.ok(ev, 'judul event kalender ikut diperbarui'); assert.equal(ev.location, 'Jl. Benar 5');

  // ganti paket + add-on -> harga dihitung ulang (tanpa promo aktif)
  const r2 = await edit({ packageId: 'pkg2', addonIds: ['add1', 'add2'] });
  assert.equal(r2.code, 200, JSON.stringify(r2.body));
  const b2 = await get();
  assert.equal(b2.packageName, 'Cerita Hangat Keluarga'); assert.equal(b2.totalPrice, 1750000 + 450000 + 400000); assert.equal(b2.dpAmount, 1300000);
  assert.deepEqual(b2.addonIds, ['add1', 'add2']); assert.match(b2.addons, /Photobook.*Tambahan Durasi/);
  // pertahankan harga lama
  const r3 = await edit({ packageId: 'pkg1', addonIds: [] }, { keepPrice: true });
  assert.equal(r3.code, 200);
  const b3 = await get();
  assert.equal(b3.packageName, 'Sesi Singkat di Rumah'); assert.equal(b3.totalPrice, b2.totalPrice, 'harga dipertahankan');

  // pindah ke jam yang bentrok dengan booking lain -> 409; dengan force -> tersimpan
  const d2 = future(321);
  assert.equal((await call(booking, mockReq({ body: goodBody({ sessionDate: d2, clientName: 'Lain', timeStart: '09:00', timeEnd: '11:00' }) }))).code, 200);
  const clash = await edit({ sessionDate: d2, timeStart: '10:00', timeEnd: '12:00' });
  assert.equal(clash.code, 409); assert.equal(clash.body.code, 'time_taken');
  assert.equal((await get()).sessionDate, d, 'belum berubah');
  assert.equal((await edit({ sessionDate: d2, timeStart: '10:00', timeEnd: '12:00' }, { force: true })).code, 200);
  assert.equal((await get()).sessionDate, d2);
  // pindah ke jam bebas tanpa force
  assert.equal((await edit({ sessionDate: d2, timeStart: '15:00', timeEnd: '17:00' })).code, 200);
  assert.equal((await get()).timeStart, '15:00');
  assert.equal(ev.start.toISOString(), new Date(`${d2}T15:00:00+07:00`).toISOString(), 'event kalender ikut pindah');
});

test('hapus booking: baris Sheet dan event kalender hilang, jam terbuka lagi, butuh login', async () => {
  const h = { ...mockReq().headers, cookie };
  const a = (body) => call(admin, mockReq({ headers: h, body }));
  const d = future(330);
  const created = await call(booking, mockReq({ body: goodBody({ sessionDate: d, clientName: 'Hapus Saya' }) }));
  assert.equal(created.code, 200);
  const id = created.body.bookingId;
  await a({ action: 'updateBooking', id, status: 'Terjadwal' });
  const ev = [...be.events.values()].find((e) => e.title.includes('Hapus Saya'));
  assert.ok(ev, 'event kalender dibuat');
  invalidatePublicCache();
  assert.ok((await call(pub, mockReq({ method: 'GET' }))).body.busyTimes[d]);

  assert.equal((await call(admin, mockReq({ body: { action: 'deleteBooking', id } }))).code, 401);
  const del = await a({ action: 'deleteBooking', id });
  assert.equal(del.code, 200);
  assert.ok(!(await a({ action: 'bookings' })).body.bookings.some((x) => x.id === id), 'hilang dari daftar');
  assert.ok(!be.sheets.Bookings.grid.some((r) => r[0] === id), 'baris Sheet terhapus');
  assert.ok(!be.events.has(ev.id), 'event kalender terhapus');
  invalidatePublicCache();
  assert.equal((await call(pub, mockReq({ method: 'GET' }))).body.busyTimes[d], undefined, 'jam terbuka lagi');
  assert.equal((await a({ action: 'deleteBooking', id })).code, 404, 'hapus dua kali -> tidak ditemukan');
  assert.equal((await a({ action: 'deleteBooking', id: '' })).code, 400);
  // booking lain tidak ikut terhapus
  assert.ok((await a({ action: 'bookings' })).body.bookings.length > 0);
});
