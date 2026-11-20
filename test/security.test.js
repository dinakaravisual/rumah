import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeBackend, mockReq, mockRes } from './harness.js';
import { loadLandingGas } from './landing-gas-harness.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

process.env.GSHEET_WEBHOOK_URL = 'https://script.test/exec';
process.env.GSHEET_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'pw-admin-123';
process.env.SESSION_SECRET = 'a-long-random-session-secret-xyz';

const be = makeBackend();
globalThis.fetch = async (url, opts) => ({ ok: true, text: async () => JSON.stringify(be.post(JSON.parse(opts.body))) });
const { default: booking } = await import('../api/booking.js');
const { default: auth } = await import('../api/auth.js');
const { default: admin } = await import('../api/admin.js');
const { default: pub } = await import('../api/public.js');
const { sign } = await import('../lib/session.js');
const call = async (h, req) => { const res = mockRes(); await h(req, res); return res; };
const future = (d) => new Date(Date.now() + d * 864e5 + 7 * 3600e3).toISOString().slice(0, 10);

/* ======================= Routing & header (vercel.json) ======================= */
const vj = JSON.parse(read('vercel.json'));

test('vercel.json: semua tujuan rewrite adalah file yang ada di public/', () => {
  for (const r of vj.rewrites) assert.ok(fs.existsSync(path.join(root, 'public', r.destination)), `tidak ada: ${r.destination}`);
  assert.equal(vj.outputDirectory, 'public');
});

test('vercel.json: /booking, /galeri, dan /galeri/g/* dirutekan benar', () => {
  const src = vj.rewrites.map((r) => r.source);
  for (const s of ['/booking', '/galeri', '/galeri/admin', '/galeri/g/:brand/:id', '/galeri/g/:id']) assert.ok(src.includes(s), s);
});

test('vercel.json: CSP ketat di semua bagian situs (frame-ancestors, object-src, base-uri, connect-src terbatas)', () => {
  const cspFor = (source) => vj.headers.find((h) => h.source === source)?.headers.find((x) => x.key === 'Content-Security-Policy')?.value;
  for (const s of ['/', '/booking', '/galeri', '/galeri/(.*)', '/booking/(.*)']) {
    const c = cspFor(s); assert.ok(c, `CSP hilang untuk ${s}`);
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "default-src 'self'"]) assert.ok(c.includes(d), `${s} tanpa ${d}`);
    assert.ok(!/connect-src[^;]*\*/.test(c), `${s}: connect-src memakai wildcard`);
    assert.ok(!/script-src[^;]*(https:\s|\*)/.test(c.replace(/https:\/\/[^\s;]+/g, '')), `${s}: script-src terlalu longgar`);
  }
  // hanya booking yang boleh memuat skrip pihak ketiga, dan hanya dua host
  const sc = (s) => (cspFor(s).match(/script-src ([^;]*)/)[1].match(/https:\/\/[^\s]+/g) || []);
  assert.deepEqual(sc('/'), []); assert.deepEqual(sc('/galeri'), []);
  assert.deepEqual(sc('/booking').sort(), ['https://cdn.tailwindcss.com', 'https://unpkg.com']);
  // booking tidak boleh menghubungi host luar (API-nya same-origin)
  assert.match(cspFor('/booking'), /connect-src 'self'(;|$)/);
});

test('vercel.json: header keamanan global + API tidak di-cache', () => {
  const all = vj.headers.find((h) => h.source === '/(.*)').headers.map((h) => h.key);
  for (const k of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy', 'Strict-Transport-Security']) assert.ok(all.includes(k), k);
  assert.match(vj.headers.find((h) => h.source === '/api/(.*)').headers.find((h) => h.key === 'Cache-Control').value, /no-store/);
});

test('galeri: semua skrip/path absolut mengarah ke file yang ada dan memakai awalan /galeri', () => {
  for (const f of ['index.html', 'gallery.html', 'admin.html']) {
    const html = read(`public/galeri/${f}`);
    for (const m of html.matchAll(/<script src="(\/[^"]+)"/g)) {
      assert.ok(m[1].startsWith('/galeri/'), `${f}: ${m[1]}`);
      assert.ok(fs.existsSync(path.join(root, 'public', m[1])), `${f}: ${m[1]} tidak ada`);
    }
  }
  const cfg = read('public/galeri/config.js');
  assert.match(cfg, /rumah\.bydinakara\.com/); assert.match(cfg, /linkBase: "https:\/\/rumah\.bydinakara\.com\/galeri\/g"/);
});

test('landing: tidak ada PIN bawaan, tombol demo, atau sink HTML dari data tak tepercaya', () => {
  const h = read('public/index.html');
  assert.ok(!/1234/.test(h), 'masih ada 1234'); assert.ok(!/demoLogin/.test(h));
  assert.ok(!/innerHTML = state\.(heroTitle|testiHeading|logoDataUrl)/.test(h));
  assert.ok(!/src="\$\{state\.logoDataUrl\}"/.test(h));
  assert.match(h, /const DEFAULT_GAS_URL = '';/); // placeholder; diisi pemilik saat setup
});

/* ======================= Apps Script landing (diperkeras) ======================= */
const GS = path.join(root, 'backend', 'landing-Code.gs');

test('landing GAS: pengunjung anonim tidak bisa membuka folder Drive lain lewat ?folderId=', () => {
  const g = loadLandingGas(GS, { pin: 'rahasia-6' });
  g.post({ action: 'saveConfig', pin: 'rahasia-6', config: { driveFolderId: 'FOLDER_SLIDESHOW' } });
  const r = g.get({ action: 'getPhotos', folderId: 'FOLDER_RAHASIA_KLIEN' });
  assert.deepEqual(g.driveTouched.filter((x) => x === 'FOLDER_RAHASIA_KLIEN'), []);
  assert.ok(r.photos.every((p) => p.id.startsWith('FOLDER_SLIDESHOW')));
  assert.ok(g.shared.every((s) => s.startsWith('FOLDER_SLIDESHOW')));
});

test('landing GAS: gagal tertutup bila ADMIN_PIN belum disetel (tidak ada PIN 1234)', () => {
  const g = loadLandingGas(GS, { pin: null });
  for (const p of ['1234', '', 'undefined', 'null']) assert.equal(g.post({ action: 'verifyPin', pin: p }).status, 'unauthorized');
  assert.equal(g.post({ action: 'saveConfig', pin: '1234', config: { heroTitle: 'x' } }).status, 'unauthorized');
});

test('landing GAS: PIN pendek (<6) di Script Property tetap ditolak', () => {
  const g = loadLandingGas(GS, { pin: '1234' });
  assert.equal(g.post({ action: 'verifyPin', pin: '1234' }).status, 'unauthorized');
});

test('landing GAS: 5 PIN salah mengunci, bahkan PIN benar ditolak sementara', () => {
  const g = loadLandingGas(GS, { pin: 'benar-123' });
  for (let i = 0; i < 5; i++) g.post({ action: 'verifyPin', pin: 'salah' + i });
  assert.equal(g.post({ action: 'verifyPin', pin: 'benar-123' }).status, 'locked');
});

test('landing GAS: PIN benar membuka; salah sekali tidak mengunci; kegagalan direset setelah sukses', () => {
  const g = loadLandingGas(GS, { pin: 'benar-123' });
  assert.equal(g.post({ action: 'verifyPin', pin: 'salah' }).status, 'unauthorized');
  assert.equal(g.post({ action: 'verifyPin', pin: 'benar-123' }).status, 'ok');
  for (let i = 0; i < 4; i++) g.post({ action: 'verifyPin', pin: 'x' + i });
  assert.equal(g.post({ action: 'verifyPin', pin: 'benar-123' }).status, 'ok');
});

test('landing GAS: config jahat dibersihkan di server (URL, ikon, ukuran, logo SVG)', () => {
  const g = loadLandingGas(GS, { pin: 'benar-123' });
  const evil = { bookingUrl: 'javascript:alert(1)', contactUrl: 'data:text/html,x', ogImage: 'javascript:1', logoDataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    highlights: Array.from({ length: 30 }, () => ({ icon: '../../x', text: 'y'.repeat(999) })),
    testimonials: Array.from({ length: 40 }, () => ({ family: 'x'.repeat(5000), quote: 'q'.repeat(5000), photo: 'javascript:1' })), slideInterval: 99999, driveFolderId: '../../etc' };
  assert.equal(g.post({ action: 'saveConfig', pin: 'benar-123', config: evil }).status, 'ok');
  const c = g.get().config;
  assert.equal(c.bookingUrl, '/booking'); assert.equal(c.contactUrl, ''); assert.equal(c.ogImage, ''); assert.equal(c.logoDataUrl, '');
  assert.equal(c.highlights.length, 8); assert.ok(c.highlights.every((h) => h.icon === 'home' && h.text.length === 80));
  assert.equal(c.testimonials.length, 12); assert.ok(c.testimonials.every((t) => t.family.length === 80 && t.quote.length === 500 && t.photo === ''));
  assert.equal(c.slideInterval, 15); assert.equal(c.driveFolderId, '');
});

test('landing GAS: logo besar (>50.000 karakter, batas sel Sheets) tersimpan utuh lewat pemecahan sel', () => {
  const g = loadLandingGas(GS, { pin: 'benar-123' });
  const logo = 'data:image/png;base64,' + 'A'.repeat(120000);
  assert.equal(g.post({ action: 'saveConfig', pin: 'benar-123', config: { logoDataUrl: logo } }).status, 'ok');
  assert.equal(g.get().config.logoDataUrl, logo);
});

test('landing GAS: PIN baru <6 ditolak, >=6 berlaku; JSON rusak tidak membocorkan detail error', () => {
  const g = loadLandingGas(GS, { pin: 'benar-123' });
  assert.equal(g.post({ action: 'saveConfig', pin: 'benar-123', newPin: '123', config: { heroTitle: 'a' } }).status, 'error');
  assert.equal(g.post({ action: 'saveConfig', pin: 'benar-123', newPin: 'baru-pin-9', config: { heroTitle: 'a' } }).status, 'ok');
  assert.equal(g.post({ action: 'verifyPin', pin: 'benar-123' }).status, 'unauthorized');
  assert.equal(g.post({ action: 'verifyPin', pin: 'baru-pin-9' }).status, 'ok');
  const bad = JSON.parse(g.post.constructor && (() => { try { return JSON.stringify(g.post({ action: 'x', pin: ['array'] })); } catch (e) { return '{}'; } })());
  assert.ok(!/at |Error|stack/i.test(JSON.stringify(bad)));
});

/* ======================= API booking & admin ======================= */
async function login() {
  const res = await call(auth, mockReq({ body: { password: 'pw-admin-123' } }));
  assert.equal(res.code, 200);
  return { res, cookie: res.headers['Set-Cookie'].split(';')[0] };
}
async function ensureConfigured() {
  const { cookie } = await login();
  const res = await call(admin, withCookie(cookie, { body: { action: 'saveConfig', config: { settings: { adminWa: '6281', accountHolder: 'Studio', bcaNo: '111', jagoNo: '222' } } } }));
  assert.equal(res.code, 200);
}
const withCookie = (cookie, o = {}) => mockReq({ ...o, headers: { host: 'app.test', origin: 'https://app.test', cookie, 'x-forwarded-for': '10.9.9.9' } });

test('cookie sesi: HttpOnly + Secure + SameSite=Strict', async () => {
  const { res } = await login();
  const c = res.headers['Set-Cookie'];
  assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Strict/);
});

test('sesi: token palsu / dimodifikasi / kedaluwarsa / sampah ditolak (401)', async () => {
  const { cookie } = await login();
  const [name, val] = cookie.split('=');
  const [ts, sig] = decodeURIComponent(val).split('.');
  const secret = process.env.SESSION_SECRET;
  const old = Date.now() - 25 * 3600e3;
  const tokens = [
    `${ts}.${'0'.repeat(sig.length)}`,                // tanda tangan salah
    `${Number(ts) + 1000}.${sig}`,                    // ts diubah
    `${old}.${sign(old, secret)}`,                    // valid tapi >24 jam
    `${Date.now() + 9e9}.${sign(Date.now() + 9e9, secret)}`, // dari masa depan
    `abc.def`, '.', ts, `${ts}.${sig}.extra`, 'A'.repeat(5000), `${ts}.${sig.slice(0, -1)}`,
  ];
  for (const t of tokens) {
    const res = await call(admin, withCookie(`${name}=${encodeURIComponent(t)}`, { body: { action: 'bookings' } }));
    assert.equal(res.code, 401, `token lolos: ${t.slice(0, 30)}`);
  }
  assert.equal((await call(admin, withCookie('', { body: { action: 'bookings' } }))).code, 401);
});

test('CSRF/Origin: permintaan lintas situs ditolak di /api/booking, /api/admin, /api/auth', async () => {
  const { cookie } = await login();
  const evilOrigins = ['https://evil.com', 'https://app.test.evil.com', 'https://evilapp.test', 'null', 'http://app.test:8443', 'https://app.test@evil.com'];
  for (const o of evilOrigins) {
    const mk = (body) => mockReq({ body, headers: { host: 'app.test', origin: o, cookie, 'x-forwarded-for': '10.8.8.8' } });
    assert.equal((await call(admin, mk({ action: 'bookings' }))).code, 403, `admin ${o}`);
    assert.equal((await call(booking, mk({}))).code, 403, `booking ${o}`);
    assert.equal((await call(auth, mk({ password: 'pw-admin-123' }))).code, 403, `auth ${o}`);
  }
  // tanpa Origin tapi browser menandai cross-site
  const x = mockReq({ body: { action: 'bookings' }, headers: { host: 'app.test', 'sec-fetch-site': 'cross-site', cookie } });
  assert.equal((await call(admin, x)).code, 403);
});

test('admin: semua aksi butuh sesi; aksi tak dikenal ditolak; metode selain POST ditolak', async () => {
  for (const action of ['bookings', 'saveConfig', 'updateBooking', 'blocks', 'addBlock', 'deleteBlock', 'deleteBooking', 'editBooking', 'apaSaja']) {
    assert.equal((await call(admin, mockReq({ body: { action } }))).code, 401, action);
  }
  for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await call(admin, mockReq({ method: m }))).code, 405, m);
  const { cookie } = await login();
  assert.equal((await call(admin, withCookie(cookie, { body: { action: '__proto__' } }))).code, 400);
});

test('booking: field berbahaya (mass-assignment, prototype pollution, tipe aneh) tidak berefek', async () => {
  await ensureConfigured();
  const body = JSON.parse(`{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}},"_opened_at":${Date.now() - 20000},
    "clientName":"Uji","whatsapp":"0812-3456-7890","sessionType":"Intimate Home Session","sessionDate":"${future(20)}","timeStart":"09:00","timeEnd":"10:00",
    "location":"Sleman","packageId":"pkg1","addonIds":{"0":"add1"},"paymentBank":"BCA","status":"Lunas","payment":"Lunas","archived":true,"totalPrice":1,"dpAmount":0,"bookingId":"BKR-HACKED"}`);
  const res = await call(booking, mockReq({ body }));
  assert.equal(res.code, 200); assert.notEqual(res.body.bookingId, 'BKR-HACKED');
  assert.equal({}.isAdmin, undefined); assert.equal({}.x, undefined);
  const row = be.sheets.Bookings.grid.find((r) => r[0] === res.body.bookingId);
  assert.equal(row[19], 'Menunggu DP'); assert.equal(row[20], ''); assert.equal(row[25], 'Belum bayar');
  assert.ok(row[17] > 1000, 'harga dari klien dipakai!');
  const typeConfusion = await call(booking, mockReq({ body: { ...body, packageId: { $ne: 1 }, clientName: ['a'] } }));
  assert.ok([400, 200].includes(typeConfusion.code));
});

test('booking: karakter kontrol/HTML/rumus di data klien tidak merusak Sheet', async () => {
  await ensureConfigured();
  const body = { _opened_at: Date.now() - 20000, clientName: '=HYPERLINK("http://evil","x")', whatsapp: '081234567890', sessionType: 'Intimate Home Session',
    sessionDate: future(30), timeStart: '13:00', timeEnd: '14:00', location: '+cmd|calc', packageId: 'pkg1', paymentBank: 'BCA', preferences: '@SUM(1)', restrictions: '-2+3' };
  const res = await call(booking, mockReq({ body }));
  assert.equal(res.code, 200);
  const row = be.sheets.Bookings.grid.find((r) => r[0] === res.body.bookingId);
  for (const i of [2, 7, 13, 14]) assert.match(String(row[i]), /^'[=+\-@]/, `kolom ${i} tidak dinetralkan`);
});

test('public: tidak membocorkan secret/kunci server', async () => {
  const res = await call(pub, { method: 'GET', headers: {}, query: {} });
  const s = JSON.stringify(res.body);
  for (const bad of ['test-secret', 'pw-admin-123', 'a-long-random-session-secret-xyz', 'SESSION_SECRET', 'GSHEET', 'script.test']) assert.ok(!s.includes(bad), bad);
});
