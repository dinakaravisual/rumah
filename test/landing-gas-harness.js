// Tiruan layanan Google (Drive, Sheet, Cache, Properties) agar Code.gs landing bisa diuji tanpa jaringan.
import fs from 'fs';
import vm from 'vm';

class Sheet {
  constructor() { this.grid = []; }
  getLastRow() { return this.grid.length; }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this, A = (n) => (typeof r === 'string' ? n : n);
    if (typeof r === 'string') { const m = r.match(/^([A-Z])(\d+)/); r = Number(m[2]); c = m[1].charCodeAt(0) - 64; }
    const range = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (sh.grid[r - 1 + i]?.[c - 1 + j] ?? ''))),
      setValues: (v) => { v.forEach((row, i) => row.forEach((x, j) => { (sh.grid[r - 1 + i] ||= [])[c - 1 + j] = x; })); return range; },
      setValue: (x) => { (sh.grid[r - 1] ||= [])[c - 1] = x; },
      setNumberFormat: () => range,
    };
    return range;
  }
}

export function loadLandingGas(file, { pin = 'rahasia-6' } = {}) {
  const sheets = {}, props = pin === null ? {} : { ADMIN_PIN: pin }, cache = new Map();
  const driveTouched = [], shared = [];
  const folders = {
    'FOLDER_SLIDESHOW': ['a.jpg', 'b.jpg'],
    'FOLDER_RAHASIA_KLIEN': ['ktp.jpg', 'kontrak.jpg', 'foto-pribadi.jpg'],
  };
  const mkFile = (folderId, name, i) => ({
    getMimeType: () => 'image/jpeg', getName: () => name, getId: () => `${folderId}-${i}`,
    setSharing: () => { shared.push(`${folderId}/${name}`); },
  });
  const ctx = {
    console: { error() {}, log() {} },
    Date, JSON, Math, Number, String, Array, Object, RegExp,
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = new Sheet()) }) },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'A' }, Permission: { VIEW: 'V' },
      getFolderById: (id) => {
        driveTouched.push(id);
        if (!folders[id]) throw new Error('Folder tidak ada');
        const list = folders[id].map((n, i) => mkFile(id, n, i)); let k = 0;
        return { getFiles: () => ({ hasNext: () => k < list.length, next: () => list[k++] }) };
      },
      getFileById: (id) => { const [f, ...rest] = id.split('-'); const i = Number(rest.pop()); return mkFile(f, folders[f]?.[i] || '?', i); },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
  const run = (fn, arg) => JSON.parse(vm.runInContext(fn, ctx)(arg).text);
  return {
    props, driveTouched, shared, sheets,
    get: (params = {}) => run('doGet', { parameter: params }),
    post: (body) => run('doPost', { postData: { contents: JSON.stringify(body) } }),
  };
}
