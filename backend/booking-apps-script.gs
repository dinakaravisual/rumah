/**
 * Berkunjung ke RUMAH — backend Google Apps Script (v3)
 * Sheet "Bookings" = data booking. Sheet "Config" = paket, harga, promo, rekening (dikelola dari dashboard admin).
 * Setup: lihat SETUP.md. Wajib isi Script Property "SECRET" lalu jalankan setup() sekali.
 */
var TZ = 'Asia/Jakarta';
var HEADERS = ['Booking ID','Waktu Input','Nama Klien','WhatsApp','Tipe Sesi','Tanggal Sesi','Jam Sesi','Lokasi',
  'Jumlah Orang','Jumlah Anak','Detail Anak','Paket','Add-Ons','Preferensi','Pantangan','Bank','Info Diskon',
  'Total Harga','Nominal DP','Status','Arsip','Instagram','Subtotal','Nominal Diskon','Label Diskon','Pembayaran','Link Drive','Event ID','Email','Link Galeri','Tgl Pesan','Paket ID','Add-On IDs'];
var NUMERIC_COLS = [8, 9, 17, 18, 22, 23]; // indeks 0-based kolom angka
var STATUSES = ['Menunggu DP', 'DP Diterima', 'Terjadwal', 'Selesai', 'Dibatalkan'];
var PAYMENTS = ['Belum bayar', 'DP', 'Lunas'];
var CAL_STATUSES = ['Terjadwal', 'DP Diterima', 'Selesai']; // status yang punya event kalender
var CHUNK = 45000, MAX_CHUNKS = 10;

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Bookings') || ss.insertSheet('Bookings');
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  if (!ss.getSheetByName('Config')) ss.insertSheet('Config');
  CalendarApp.getDefaultCalendar(); // memicu permintaan izin Google Calendar
  if (!PropertiesService.getScriptProperties().getProperty('SECRET')) {
    throw new Error('Isi Script Property SECRET dulu (Project Settings > Script properties).');
  }
}

function doGet() { return out_({ status: 'ok', service: 'bkr-backend' }); }

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || req.secret !== secret) return out_({ status: 'error', error: 'unauthorized' });
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (req.action) {
        case 'public': var av = availability_(); return out_(ok_({ config: readConfig_(), bookedDates: av.bookedDates, busyTimes: av.busyTimes }));
        case 'createBooking': return out_(createBooking_(req));
        case 'listBookings': return out_(ok_({ bookings: listBookings_() }));
        case 'getBooking': return out_(getBooking_(req));
        case 'editBooking': return out_(editBooking_(req));
        case 'deleteBooking': return out_(deleteBooking_(req));
        case 'updateBooking': return out_(updateBooking_(req));
        case 'saveConfig': writeConfig_(req.config || {}); return out_(ok_({}));
        case 'listBlocks': return out_(ok_({ blocks: blocks_() }));
        case 'addBlock': return out_(addBlock_(req));
        case 'deleteBlock': return out_(deleteBlock_(req));
        case 'rate': return out_(ok_({ allowed: rateHit_(String(req.key), Number(req.limit), Number(req.windowSec)) }));
        default: return out_({ status: 'error', error: 'unknown_action' });
      }
    } finally { lock.releaseLock(); }
  } catch (err) {
    return out_({ status: 'error', error: 'server_error', detail: String(err && err.message || err) });
  }
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function ok_(o) { o.status = 'ok'; return o; }
function bookings_() { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bookings'); }
function str_(v) { return String(v == null ? '' : v).replace(/^'(?=[=+\-@])/, ''); }
function dateStr_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : str_(v); }
function isArchived_(v) { return v === 'YA' || v === true || v === 'TRUE'; }

function rows_() {
  var sh = bookings_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
}
function isActive_(r) { return !isArchived_(r[20]) && str_(r[19]) !== 'Dibatalkan'; }

function createBooking_(req) {
  var b = req.booking || {};
  if (req.ip && !rateHit_('bk:' + req.ip, 5, 3600)) return { status: 'error', error: 'rate_limited' };
  var date = String(b.sessionDate);
  var slot = String(b.timeSlot || '').split(' - ');
  if (slot.length < 2) return { status: 'error', error: 'bad_slot' };
  var err = availabilityError_(date, toMin_(slot[0]), toMin_(slot[1]), '');
  if (err) return { status: 'error', error: err };
  var row = [b.bookingId, b.createdAt, b.clientName, b.whatsapp, b.sessionType, date, b.timeSlot, b.location,
    b.totalPeople, b.childrenCount, b.childrenDetails, b.packageName, b.addons, b.preferences, b.restrictions,
    b.paymentBank, b.discountInfo || '-', b.totalPrice, b.dpAmount, 'Menunggu DP', '', b.instagram || '',
    b.subtotalPrice, b.discountAmount, b.discountLabel || '', 'Belum bayar', '', '', b.email || '', '', b.bookingDate || '', b.packageId || '', (b.addonIds || []).join(',')];
  var sh = bookings_(), r = sh.getLastRow() + 1;
  var range = sh.getRange(r, 1, 1, HEADERS.length);
  range.setNumberFormat('@'); // teks polos: tanggal tidak berubah jadi Date, "=..." tidak jadi rumus
  NUMERIC_COLS.forEach(function (i) { sh.getRange(r, i + 1).setNumberFormat('0'); });
  range.setValues([row]);
  return ok_({ bookingId: b.bookingId });
}

function rowToBooking_(r) {
  var slot = str_(r[6]).split(' - '), addonIds = str_(r[32]);
  return {
    id: str_(r[0]), createdAt: str_(r[1]), clientName: str_(r[2]), whatsapp: str_(r[3]), sessionType: str_(r[4]),
    sessionDate: dateStr_(r[5]), timeStart: slot[0] || '', timeEnd: slot[1] || '', location: str_(r[7]),
    totalPeople: Number(r[8]) || 0, childrenCount: Number(r[9]) || 0, childrenDetails: str_(r[10]),
    packageName: str_(r[11]), addons: str_(r[12]), preferences: str_(r[13]), restrictions: str_(r[14]),
    paymentBank: str_(r[15]), totalPrice: Number(r[17]) || 0, dpAmount: Number(r[18]) || 0,
    status: str_(r[19]) || 'Menunggu DP', archived: isArchived_(r[20]), instagram: str_(r[21]),
    subtotalPrice: Number(r[22]) || Number(r[17]) || 0, discountAmount: Number(r[23]) || 0, discountLabel: str_(r[24]),
    payment: str_(r[25]) || 'Belum bayar', driveLink: str_(r[26]), inCalendar: !!str_(r[27]), email: str_(r[28]),
    galleryLink: str_(r[29]), bookingDate: str_(r[30]), packageId: str_(r[31]), addonIds: addonIds ? addonIds.split(',') : []
  };
}

function listBookings_() {
  return rows_().map(rowToBooking_).reverse().slice(0, 500);
}

function findRow_(id) {
  var ids = rows_().map(function (r) { return str_(r[0]); });
  var idx = ids.indexOf(String(id));
  return idx < 0 ? 0 : idx + 2;
}

function getBooking_(req) {
  var row = findRow_(req.id);
  if (!row) return { status: 'error', error: 'not_found' };
  return ok_({ booking: rowToBooking_(bookings_().getRange(row, 1, 1, HEADERS.length).getValues()[0]) });
}

// Hapus permanen satu booking: baris Sheet dihapus dan event kalendernya ikut dihapus (tamu menerima pembatalan).
function deleteBooking_(req) {
  var row = findRow_(req.id);
  if (!row) return { status: 'error', error: 'not_found' };
  var sh = bookings_(), r = sh.getRange(row, 1, 1, HEADERS.length).getValues()[0], evId = str_(r[27]);
  if (evId) {
    try { var ev = calendar_().getEventById(evId); if (ev) ev.deleteEvent(); } catch (err) { console.error('hapus event gagal: ' + err); }
  }
  sh.deleteRow(row);
  return ok_({});
}

// Edit data booking oleh admin. Cek bentrok hanya bila tanggal/jam berubah dan booking masih aktif; force = admin tetap menyimpan.
function editBooking_(req) {
  var row = findRow_(req.id);
  if (!row) return { status: 'error', error: 'not_found' };
  var b = req.booking || {}, sh = bookings_();
  var range = sh.getRange(row, 1, 1, HEADERS.length), r = range.getValues()[0];
  var oldDate = dateStr_(r[5]), oldSlot = str_(r[6]);
  var slot = String(b.timeSlot || '').split(' - ');
  if (slot.length < 2) return { status: 'error', error: 'bad_slot' };
  if (isActive_(r) && !req.force && (String(b.sessionDate) !== oldDate || String(b.timeSlot) !== oldSlot)) {
    var err = availabilityError_(String(b.sessionDate), toMin_(slot[0]), toMin_(slot[1]), String(req.id));
    if (err) return { status: 'error', error: err };
  }
  var set = { 2: b.clientName, 3: b.whatsapp, 4: b.sessionType, 5: b.sessionDate, 6: b.timeSlot, 7: b.location,
    8: b.totalPeople, 9: b.childrenCount, 10: b.childrenDetails, 11: b.packageName, 12: b.addons, 13: b.preferences,
    14: b.restrictions, 15: b.paymentBank, 16: b.discountInfo || '-', 17: b.totalPrice, 18: b.dpAmount,
    21: b.instagram || '', 22: b.subtotalPrice, 23: b.discountAmount, 24: b.discountLabel || '', 28: b.email || '',
    31: b.packageId || '', 32: (b.addonIds || []).join(',') };
  Object.keys(set).forEach(function (k) { r[Number(k)] = set[k]; });
  range.setNumberFormat('@');
  NUMERIC_COLS.forEach(function (i) { sh.getRange(row, i + 1).setNumberFormat('0'); });
  range.setValues([r]);
  syncRow_(sh, row);
  return ok_({ booking: rowToBooking_(sh.getRange(row, 1, 1, HEADERS.length).getValues()[0]) });
}

function updateBooking_(req) {
  var id = String(req.id), sh = bookings_(), ids = rows_().map(function (r) { return str_(r[0]); });
  var idx = ids.indexOf(id);
  if (idx < 0) return { status: 'error', error: 'not_found' };
  var row = idx + 2;
  if (typeof req.archived === 'boolean') sh.getRange(row, 21).setValue(req.archived ? 'YA' : '');
  if (req.status && STATUSES.indexOf(req.status) >= 0) sh.getRange(row, 20).setValue(req.status);
  if (req.payment && PAYMENTS.indexOf(req.payment) >= 0) sh.getRange(row, 26).setValue(req.payment);
  if (typeof req.driveLink === 'string') sh.getRange(row, 27).setValue(req.driveLink);
  if (typeof req.galleryLink === 'string') sh.getRange(row, 30).setValue(req.galleryLink);
  syncRow_(sh, row);
  return ok_({});
}

function configSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName('Config') || ss.insertSheet('Config');
}
function readConfig_() {
  var sh = configSheet_(), last = sh.getLastRow(), cfg = {};
  if (last < 1) return cfg;
  sh.getRange(1, 1, last, MAX_CHUNKS + 1).getValues().forEach(function (r) {
    if (!r[0]) return;
    var json = r.slice(1).join('');
    try { cfg[r[0]] = JSON.parse(json); } catch (e) {}
  });
  return cfg;
}
function writeConfig_(cfg) {
  var sh = configSheet_(), keys = ['settings', 'discounts', 'sessionTypes', 'packages', 'addons', 'waTemplates'], rows = [];
  keys.forEach(function (k) {
    if (cfg[k] === undefined) return;
    var json = JSON.stringify(cfg[k]);
    if (json.length > CHUNK * MAX_CHUNKS) throw new Error('config_too_large:' + k);
    var row = [k];
    for (var i = 0; i < MAX_CHUNKS; i++) row.push(json.substr(i * CHUNK, CHUNK));
    rows.push(row);
  });
  if (!rows.length) return;
  sh.clear();
  var range = sh.getRange(1, 1, rows.length, MAX_CHUNKS + 1);
  range.setNumberFormat('@');
  range.setValues(rows);
}

// Pembatas laju sederhana (jendela tetap) memakai CacheService; dipanggil di dalam lock.
function rateHit_(key, limit, windowSec) {
  var cache = CacheService.getScriptCache();
  var k = 'rl:' + key.slice(0, 200) + ':' + Math.floor(Date.now() / (windowSec * 1000));
  var n = Number(cache.get(k) || 0) + 1;
  cache.put(k, String(n), Math.min(windowSec + 60, 21600));
  return n <= limit;
}

// ---------- Google Calendar ----------
// Event dibuat saat status Terjadwal/DP Diterima/Selesai, dihapus saat Dibatalkan atau kembali ke Menunggu DP.
// Gagal kalender tidak pernah menggagalkan booking. Kalender: Script Property CALENDAR_ID, atau kalender utama.
function calendar_() {
  var id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  return id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
}

function syncRow_(sh, row) {
  try {
    var r = sh.getRange(row, 1, 1, HEADERS.length).getValues()[0];
    var cal = calendar_();
    if (!cal) return;
    var evId = str_(r[27]), ev = null;
    if (evId) { try { ev = cal.getEventById(evId); } catch (e) { ev = null; } }
    var want = CAL_STATUSES.indexOf(str_(r[19])) >= 0;
    if (!want) {
      if (ev) ev.deleteEvent();
      if (evId) sh.getRange(row, 28).setValue('');
      return;
    }
    var date = dateStr_(r[5]), slot = str_(r[6]).split(' - ');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || slot.length < 2) return;
    var start = new Date(date + 'T' + slot[0] + ':00+07:00'), end = new Date(date + 'T' + slot[1] + ':00+07:00');
    var title = '\uD83D\uDCF8 ' + str_(r[2]) + ' \u2014 ' + str_(r[11]);
    var desc = ['ID: ' + str_(r[0]), 'WA: https://wa.me/' + str_(r[3]), 'Tipe: ' + str_(r[4]),
      'Peserta: ' + r[8] + ' orang (' + r[9] + ' anak) ' + str_(r[10]), 'Add-on: ' + str_(r[12]),
      'Preferensi: ' + str_(r[13]), 'Pantangan: ' + str_(r[14]),
      'Total: Rp ' + r[17] + ' | DP: Rp ' + r[18] + ' | Pembayaran: ' + (str_(r[25]) || 'Belum bayar')].join('\n');
    if (ev) {
      ev.setTitle(title); ev.setTime(start, end); ev.setLocation(str_(r[7])); ev.setDescription(desc);
    } else {
      var opts = { location: str_(r[7]), description: desc }, guests = guests_(str_(r[28]));
      if (guests) { opts.guests = guests; opts.sendInvites = true; }
      ev = cal.createEvent(title, start, end, opts);
      ev.removeAllReminders(); ev.addPopupReminder(1440); ev.addPopupReminder(120);
      if (guests) { ev.setGuestsCanSeeGuests(false); ev.setGuestsCanInviteOthers(false); ev.setGuestsCanModify(false); }
      sh.getRange(row, 28).setValue(ev.getId());
    }
  } catch (err) { console.error('calendar sync gagal: ' + err); }
}

// Tamu undangan: email klien (kecuali INVITE_CLIENT = 'tidak') + EXTRA_GUESTS (Script Property, dipisah koma, mis. fotografer kedua).
function guests_(clientEmail) {
  var props = PropertiesService.getScriptProperties(), list = [];
  if (clientEmail && props.getProperty('INVITE_CLIENT') !== 'tidak') list.push(clientEmail);
  (props.getProperty('EXTRA_GUESTS') || '').split(',').forEach(function (e) { e = e.trim(); if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) list.push(e); });
  var seen = {};
  return list.filter(function (e) { var k = e.toLowerCase(); return seen[k] ? false : (seen[k] = true); }).join(',');
}

// Rekonsiliasi semua baris (setelah edit manual di Sheet). Bisa dijalankan manual atau lewat trigger waktu.
function syncCalendar() {
  var sh = bookings_(), n = Math.max(0, sh.getLastRow() - 1);
  for (var i = 0; i < n; i++) syncRow_(sh, i + 2);
}

// ---------- Ketersediaan: kuota sesi per hari, jeda antar sesi, jadwal terisi ----------
// Satu hari baru "Penuh" bila jumlah sesi aktif >= maxSessionsPerDay (Config), diblok seharian, atau event seharian.
// Sesi di hari yang sama hanya ditolak bila jamnya bentrok (termasuk jeda bufferMinutes antar sesi).
// Sumber blokir: sheet "Blocks" (manual, seharian atau berjam) + opsional Google Calendar lain (BLOCK_CALENDAR_IDS).
var BLOCK_HEADERS = ['ID', 'Mulai', 'Selesai', 'Catatan', 'Jam Mulai', 'Jam Selesai'];

// '' bila tersedia; selain itu kode: date_blocked | time_blocked | date_taken | time_taken. excludeId = booking yang sedang diedit.
function availabilityError_(date, s0, e0, excludeId) {
  var rules = rules_(), info = blockInfo_();
  if (info.fullDays.indexOf(date) >= 0) return 'date_blocked';
  var wins = info.windows[date] || [];
  if (wins.some(function (w) { return overlaps_(s0, e0, toMin_(w[0]), toMin_(w[1]), 0); })) return 'time_blocked';
  var same = rows_().filter(function (r) { return isActive_(r) && dateStr_(r[5]) === date && str_(r[0]) !== excludeId; });
  if (same.length >= rules.max) return 'date_taken';
  var clash = same.some(function (r) {
    var sl = str_(r[6]).split(' - ');
    return sl.length >= 2 && overlaps_(s0, e0, toMin_(sl[0]), toMin_(sl[1]), rules.buf);
  });
  return clash ? 'time_taken' : '';
}

function toMin_(t) { var p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function overlaps_(s, e, bs, be, buf) { return s < be + buf && e + buf > bs; }
function timeStr_(d) { return Utilities.formatDate(d, TZ, 'HH:mm'); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }

function rules_() {
  var st = readConfig_().settings || {};
  var max = Math.max(1, Math.min(10, Number(st.maxSessionsPerDay) || 4));
  var buf = st.bufferMinutes === undefined ? 60 : Math.max(0, Math.min(240, Number(st.bufferMinutes) || 0));
  return { max: max, buf: buf };
}

function blocksSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName('Blocks');
  if (!sh) {
    sh = ss.insertSheet('Blocks');
    sh.getRange(1, 1, 1, BLOCK_HEADERS.length).setValues([BLOCK_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function addDays_(iso, n) {
  var p = iso.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10);
}
function eachDay_(start, end) {
  var out = [], d = start;
  while (d <= end && out.length < 400) { out.push(d); d = addDays_(d, 1); }
  return out;
}
function blocks_() {
  var sh = blocksSheet_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, BLOCK_HEADERS.length).getValues().map(function (r) {
    return { id: str_(r[0]), start: dateStr_(r[1]), end: dateStr_(r[2]), note: str_(r[3]), timeStart: str_(r[4]), timeEnd: str_(r[5]) };
  }).sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
}
function addBlock_(req) {
  var b = req.block || {}, sh = blocksSheet_();
  if (sh.getLastRow() > 400) return { status: 'error', error: 'too_many_blocks' };
  var r = sh.getLastRow() + 1, range = sh.getRange(r, 1, 1, BLOCK_HEADERS.length);
  range.setNumberFormat('@');
  range.setValues([[b.id, b.start, b.end, b.note || '', b.timeStart || '', b.timeEnd || '']]);
  return ok_({ id: b.id });
}
function deleteBlock_(req) {
  var sh = blocksSheet_(), last = sh.getLastRow();
  if (last < 2) return { status: 'error', error: 'not_found' };
  var ids = sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return str_(r[0]); });
  var i = ids.indexOf(String(req.id));
  if (i < 0) return { status: 'error', error: 'not_found' };
  sh.deleteRow(i + 2);
  return ok_({});
}

// Hasil: { fullDays: [tanggal], windows: { tanggal: [[mulai, selesai], ...] } }
function calendarBlocked_() {
  var props = PropertiesService.getScriptProperties();
  var ids = (props.getProperty('BLOCK_CALENDAR_IDS') || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  var empty = { fullDays: [], windows: {} };
  if (!ids.length) return empty;
  var cache = CacheService.getScriptCache(), hit = cache.get('blockcal2');
  if (hit) return JSON.parse(hit);
  var skip = {}, full = {}, win = {}, from = new Date(), to = new Date(from.getTime() + 180 * 86400000);
  rows_().forEach(function (r) { if (str_(r[27])) skip[str_(r[27])] = 1; }); // event booking aplikasi ini tidak dihitung dua kali
  ids.forEach(function (id) {
    try {
      var cal = CalendarApp.getCalendarById(id);
      if (!cal) return;
      cal.getEvents(from, to).forEach(function (ev) {
        if (skip[ev.getId()]) return;
        if (ev.isAllDayEvent()) {
          var s = dateStr_(ev.getAllDayStartDate()), e = addDays_(dateStr_(ev.getAllDayEndDate()), -1);
          eachDay_(s, e).forEach(function (d) { full[d] = 1; });
          return;
        }
        var st = ev.getStartTime(), en = ev.getEndTime();
        var sd = dateStr_(st), ed = dateStr_(new Date(en.getTime() - 1));
        eachDay_(sd, ed).forEach(function (d) {
          var ws = d === sd ? timeStr_(st) : '00:00';
          var we = d === ed ? (dateStr_(en) === ed ? timeStr_(en) : '24:00') : '24:00';
          (win[d] = win[d] || []).push([ws, we]);
        });
      });
    } catch (err) { console.error('impor kalender gagal: ' + err); }
  });
  var out = { fullDays: Object.keys(full), windows: win };
  cache.put('blockcal2', JSON.stringify(out), 300);
  return out;
}

function blockInfo_() {
  var today = today_(), full = {}, win = {};
  blocks_().forEach(function (b) {
    if (b.timeStart && b.timeEnd && b.start === b.end) {
      if (b.start >= today) (win[b.start] = win[b.start] || []).push([b.timeStart, b.timeEnd]);
    } else {
      eachDay_(b.start, b.end).forEach(function (d) { if (d >= today) full[d] = 1; });
    }
  });
  var c = calendarBlocked_();
  c.fullDays.forEach(function (d) { if (d >= today) full[d] = 1; });
  Object.keys(c.windows).forEach(function (d) {
    if (d >= today) c.windows[d].forEach(function (w) { (win[d] = win[d] || []).push(w); });
  });
  return { fullDays: Object.keys(full), windows: win };
}

// bookedDates = hari yang tidak bisa dipesan sama sekali. busyTimes = jam terisi per tanggal ('b' booking, 'x' diblok).
function availability_() {
  var today = today_(), rules = rules_(), info = blockInfo_(), count = {}, busy = {}, full = {};
  info.fullDays.forEach(function (d) { full[d] = 1; });
  Object.keys(info.windows).forEach(function (d) {
    info.windows[d].forEach(function (w) { (busy[d] = busy[d] || []).push([w[0], w[1], 'x']); });
  });
  rows_().forEach(function (r) {
    var d = dateStr_(r[5]);
    if (!isActive_(r) || d < today) return;
    count[d] = (count[d] || 0) + 1;
    var sl = str_(r[6]).split(' - ');
    if (sl.length >= 2) (busy[d] = busy[d] || []).push([sl[0], sl[1], 'b']);
  });
  Object.keys(count).forEach(function (d) { if (count[d] >= rules.max) full[d] = 1; });
  Object.keys(busy).forEach(function (d) { busy[d].sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); });
  return { bookedDates: Object.keys(full), busyTimes: busy };
}
