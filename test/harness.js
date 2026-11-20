import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));

class Sheet {
  constructor(name) { this.name = name; this.grid = []; this.fmt = {}; }
  getLastRow() { return this.grid.length; }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    const range = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (sh.grid[r - 1 + i]?.[c - 1 + j] ?? ''))),
      setValues: (v) => { v.forEach((row, i) => row.forEach((x, j) => { (sh.grid[r - 1 + i] ||= [])[c - 1 + j] = x; })); return range; },
      setValue: (x) => { (sh.grid[r - 1] ||= [])[c - 1] = x; },
      setNumberFormat: () => range, setFontWeight: () => range,
    };
    return range;
  }
  setFrozenRows() {} clear() { this.grid = []; }
  deleteRow(n) { this.grid.splice(n - 1, 1); }
}

export function makeBackend() {
  const sheets = { Bookings: new Sheet('Bookings'), Config: new Sheet('Config') };
  const cache = new Map();
  const props = {};
  const ext = [];
  const events = new Map(); let evN = 0, calFail = false;
  const calendar = {
    getEventById: (id) => events.get(id) || null,
    getEvents: () => ext,
    createEvent: (title, start, end, o) => {
      if (calFail) throw new Error('kalender down');
      const id = 'ev' + ++evN;
      const ev = { id, title, start, end, ...o, getId: () => id, setTitle(t) { ev.title = t; }, setTime(a, b) { ev.start = a; ev.end = b; },
        setLocation(l) { ev.location = l; }, setDescription(d) { ev.description = d; }, removeAllReminders() {}, addPopupReminder() {}, setGuestsCanSeeGuests(v) { ev.seeGuests = v; }, setGuestsCanInviteOthers() {}, setGuestsCanModify() {},
        deleteEvent() { events.delete(id); } };
      events.set(id, ev); return ev;
    },
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = new Sheet(n)) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'SECRET' ? 'test-secret' : props[k] ?? null) }) },
    CalendarApp: { getDefaultCalendar: () => calendar, getCalendarById: () => calendar },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
    Date,
    Utilities: { formatDate: (d, tz, fmt) => { const iso = new Date(d.getTime() + 7 * 3600e3).toISOString(); return fmt === 'HH:mm' ? iso.slice(11, 16) : iso.slice(0, 10); } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(here, '..', 'backend', 'booking-apps-script.gs'), 'utf8'), ctx);
  vm.runInContext('setup', ctx)();
  return { sheets, events, props, ext, setCalFail: (v) => { calFail = v; }, post: (body) => JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify(body) } }).text) };
}

export function mockRes() {
  const r = { code: 200, headers: {}, body: undefined };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
let ipN = 0;
export const mockReq = (o = {}) => ({ method: 'POST', headers: { host: 'app.test', origin: 'https://app.test', 'x-forwarded-for': `10.0.0.${++ipN}` }, body: {}, ...o });
