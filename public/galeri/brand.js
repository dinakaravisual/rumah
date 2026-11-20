/* Penentu brand + helper bersama (dipakai index, galeri, admin). Muat SETELAH config.js */
(function () {
  var B = CONFIG.BRANDS, KEYS = Object.keys(B);
  var PAL = ['#d9a441', '#2fb59d', '#7b8cff', '#e0728f', '#a07be0', '#6fb86a'];

  function fromHost() {
    var h = location.hostname.toLowerCase();
    for (var i = 0; i < KEYS.length; i++) {
      var b = B[KEYS[i]], list = (b.hosts || []).concat(b.domain ? [b.domain] : []);
      if (list.some(function (x) { return String(x).toLowerCase() === h; })) return KEYS[i];
    }
    return '';
  }

  window.Brands = {
    keys: KEYS,
    get: function (k) { return B[k]; },
    hostBrand: fromHost,                                    // '' bila domain tidak dikenal
    color: function (k) { return (B[k] && B[k].color) || PAL[Math.max(0, KEYS.indexOf(k)) % PAL.length]; },
    defaultKey: function () { return fromHost() || CONFIG.DEFAULT_BRAND || KEYS[0]; },
    // urutan percobaan untuk mencari sebuah project: brand dari domain dulu, sisanya menyusul
    order: function (first) {
      var f = first || fromHost();
      return f && B[f] ? [f].concat(KEYS.filter(function (k) { return k !== f; })) : KEYS.slice();
    },
    // link galeri untuk klien: pendek bila brand punya domain sendiri, selain itu /g/<brand>/<id>
    link: function (k, id) {
      var b = B[k], enc = encodeURIComponent(id);
      if (b && b.linkBase) return String(b.linkBase).replace(/\/+$/, '') + '/' + enc;     // mis. https://rumah.bydinakara.com/galeri/g
      if (b && b.domain) return 'https://' + b.domain + '/g/' + enc;
      return location.origin + '/galeri/g/' + encodeURIComponent(k) + '/' + enc;
    }
  };

  window.escapeHTML = function (s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* Panggilan ke Apps Script (POST teks biasa = tanpa preflight CORS, sama seperti sebelumnya) */
  window.callApi = async function (brandKey, payload) {
    var r = await fetch(B[brandKey].api, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' });
    return r.json();
  };

  /* Tanggal acara: Sheets menyimpannya sebagai ISO, atau teks bebas seperti "2 Oktober 2026" */
  var BULAN = ['januari','februari','maret','april','mei','juni','juli','agustus','september','oktober','november','desember'];
  window.fmtEvent = function (v) {
    if (!v) return '';
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      var d = new Date(s);
      if (!isNaN(d)) return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Jakarta' });
    }
    return s;
  };
  window.fmtDateInput = function (iso) {           // "2026-10-02" -> "2 Oktober 2026"
    if (!iso) return '';
    return new Date(iso + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  };
  window.eventToInput = function (v) {              // nilai tersimpan -> "yyyy-mm-dd" untuk <input type=date>, '' bila tak terbaca
    if (!v) return '';
    var s = String(v), m;
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      var d = new Date(s);
      if (isNaN(d)) return '';
      return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    }
    if ((m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/))) {
      var mi = BULAN.indexOf(m[2].toLowerCase());
      if (mi > -1) return m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    }
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
  };
})();
