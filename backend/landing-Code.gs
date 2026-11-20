/**
 * Backend Apps Script untuk landing rumah.bydinakara.com (versi diperkeras).
 * Menyimpan konfigurasi landing di Google Sheet dan membaca foto slideshow dari SATU folder Drive yang diatur admin.
 *
 * SETUP WAJIB (lihat SETUP.md):
 *   Project Settings > Script properties > tambah  ADMIN_PIN = PIN rahasia, minimal 6 karakter.
 *   Tanpa ADMIN_PIN, semua aksi admin DITOLAK (tidak ada PIN bawaan).
 */
var CONFIG_SHEET_NAME = 'SiteConfig';
var CHUNK = 45000, MAX_CHUNKS = 6;            // batas sel Google Sheets = 50.000 karakter
var MAX_PHOTOS = 12;
var PHOTO_CACHE_SEC = 600;
var MAX_FAILS = 5, LOCK_SEC = 900;
var ICONS = ['no-flash', 'home', 'heart', 'shield', 'sparkles'];

function doGet(e) {
  try {
    // Pengunjung publik HANYA boleh membaca config + foto dari folder yang sudah diatur admin.
    // Parameter folderId dari URL sengaja diabaikan (sebelumnya bisa dipakai membuka folder Drive mana pun).
    var config = readSiteConfig_();
    var folderId = config && /^[A-Za-z0-9_-]{10,100}$/.test(String(config.driveFolderId || '')) ? config.driveFolderId : '';
    return json_({ status: 'ok', config: config, photos: folderId ? photos_(folderId) : [] });
  } catch (err) {
    console.error('doGet: ' + err);
    return json_({ status: 'error', message: 'Gagal memuat data.' });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    var payload = JSON.parse(e.postData.contents);
    var auth = checkPin_(payload.pin);
    if (auth !== 'ok') return json_({ status: auth, message: auth === 'locked' ? 'Terlalu banyak percobaan.' : 'PIN Admin salah.' });

    if (payload.action === 'verifyPin') return json_({ status: 'ok' });

    if (payload.action === 'saveConfig' && payload.config && typeof payload.config === 'object') {
      writeSiteConfig_(sanitize_(payload.config));
      CacheService.getScriptCache().remove('photos');
      var np = payload.newPin == null ? '' : String(payload.newPin).trim();
      if (np) {
        if (np.length < 6 || np.length > 64) return json_({ status: 'error', message: 'PIN baru minimal 6 karakter.' });
        PropertiesService.getScriptProperties().setProperty('ADMIN_PIN', np);
      }
      return json_({ status: 'ok', message: 'Konfigurasi tersimpan permanen di Google Sheets.' });
    }
    return json_({ status: 'error', message: 'Aksi tidak valid.' });
  } catch (err) {
    console.error('doPost: ' + err);
    return json_({ status: 'error', message: 'Permintaan gagal diproses.' });   // detail error tidak dibocorkan
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

/* ---------- Autentikasi: tanpa PIN bawaan, perbandingan konstan, pembatas percobaan ---------- */
function checkPin_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || '';
  if (expected.length < 6) return 'unauthorized';               // gagal tertutup bila belum disetel
  var cache = CacheService.getScriptCache();
  if (Number(cache.get('pin_fails') || 0) >= MAX_FAILS) return 'locked';
  if (safeEqual_(String(given == null ? '' : given), expected)) { cache.remove('pin_fails'); return 'ok'; }
  var n = Number(cache.get('pin_fails') || 0) + 1;
  cache.put('pin_fails', String(n), LOCK_SEC);
  return n >= MAX_FAILS ? 'locked' : 'unauthorized';
}
function safeEqual_(a, b) {
  var len = Math.max(a.length, b.length), diff = a.length ^ b.length;
  for (var i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ---------- Sanitasi config di SERVER (jangan percaya klien) ---------- */
function clip_(v, n) { return String(v == null ? '' : v).slice(0, n); }
function url_(v, allowRelative) {
  v = clip_(v, 600).trim();
  if (/^https:\/\/[^\s"'<>]+$/i.test(v)) return v;
  if (allowRelative && /^\/(?![\/\\])[^\s"'<>]*$/.test(v)) return v;
  return '';
}
function sanitize_(c) {
  var out = {};
  ['brandSub', 'bookingLabel', 'contactLabel', 'testiEyebrow', 'footerCopy', 'ogTitle'].forEach(function (k) { if (c[k] !== undefined) out[k] = clip_(c[k], 160); });
  ['heroSubtitle', 'ogDesc'].forEach(function (k) { if (c[k] !== undefined) out[k] = clip_(c[k], 400); });
  ['heroTitle', 'testiHeading'].forEach(function (k) { if (c[k] !== undefined) out[k] = clip_(c[k], 300); });   // klien me-render sebagai teks; hanya <em> yang jadi miring
  if (c.bookingUrl !== undefined) out.bookingUrl = url_(c.bookingUrl, true) || '/booking';
  if (c.contactUrl !== undefined) out.contactUrl = url_(c.contactUrl, false);
  if (c.ogImage !== undefined) out.ogImage = url_(c.ogImage, true);
  var logo = String(c.logoDataUrl || '');
  out.logoDataUrl = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(logo) && logo.length <= 150000 ? logo : '';
  var fid = String(c.driveFolderId || '').trim();
  out.driveFolderId = /^[A-Za-z0-9_-]{10,100}$/.test(fid) ? fid : '';
  out.slideInterval = Math.min(15, Math.max(2, Number(c.slideInterval) || 5));
  out.highlights = (Array.isArray(c.highlights) ? c.highlights : []).slice(0, 8).filter(function (h) { return h && typeof h === 'object'; })
    .map(function (h) { return { icon: ICONS.indexOf(h.icon) >= 0 ? h.icon : 'home', text: clip_(h.text, 80) }; });
  out.testimonials = (Array.isArray(c.testimonials) ? c.testimonials : []).slice(0, 12).filter(function (t) { return t && typeof t === 'object'; })
    .map(function (t) { return { family: clip_(t.family, 80), session: clip_(t.session, 100), quote: clip_(t.quote, 500), photo: url_(t.photo, true) }; });
  out.fallbackSlides = (Array.isArray(c.fallbackSlides) ? c.fallbackSlides : []).slice(0, 12).map(function (u) { return url_(u, true); }).filter(Boolean);
  return out;
}

/* ---------- Foto slideshow: hanya folder terkonfigurasi, di-cache, maksimal 12 ---------- */
function photos_(folderId) {
  var cache = CacheService.getScriptCache(), key = 'photos';
  var hit = cache.get(key);
  if (hit) { try { var o = JSON.parse(hit); if (o.f === folderId) return o.p; } catch (e) {} }
  var files = DriveApp.getFolderById(folderId).getFiles(), list = [], seen = 0;
  while (files.hasNext() && seen < 200) {                       // batas keras agar folder besar tidak membebani
    var file = files.next(); seen++;
    var mime = file.getMimeType();
    if (mime && mime.indexOf('image/') === 0) {
      var id = file.getId();
      list.push({ id: id, name: file.getName(), url: 'https://lh3.googleusercontent.com/d/' + id + '=w1600' });
    }
  }
  list.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); });
  list = list.slice(0, MAX_PHOTOS);
  list.forEach(function (p) {                                   // hanya file di folder ini yang dibuat "siapa pun dengan link"
    try { DriveApp.getFileById(p.id).setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  });
  cache.put(key, JSON.stringify({ f: folderId, p: list }), PHOTO_CACHE_SEC);
  return list;
}

/* ---------- Penyimpanan config (dipecah per 45.000 karakter agar tidak melebihi batas sel) ---------- */
function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(CONFIG_SHEET_NAME);
  if (!sh) { sh = ss.insertSheet(CONFIG_SHEET_NAME); sh.getRange('A1').setValue('key / potongan JSON'); }
  return sh;
}
function readSiteConfig_() {
  var sh = sheet_();
  if (sh.getLastRow() < 2) return null;
  var row = sh.getRange(2, 1, 1, MAX_CHUNKS + 1).getValues()[0];
  var json = row.slice(1).join('');
  if (!json) return null;
  try { return JSON.parse(json); } catch (e) { return null; }
}
function writeSiteConfig_(obj) {
  var json = JSON.stringify(obj);
  if (json.length > CHUNK * MAX_CHUNKS) throw new Error('config_too_large');
  var row = ['main_config'];
  for (var i = 0; i < MAX_CHUNKS; i++) row.push(json.substr(i * CHUNK, CHUNK));
  var r = sheet_().getRange(2, 1, 1, MAX_CHUNKS + 1);
  r.setNumberFormat('@');
  r.setValues([row]);
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
