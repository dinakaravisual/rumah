export class GasError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

export async function gas(action, payload = {}, timeoutMs = 20000) {
  const url = process.env.GSHEET_WEBHOOK_URL;
  const secret = process.env.GSHEET_SECRET;
  if (!url || !secret) throw new GasError('not_configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, secret, action }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    let j;
    try { j = JSON.parse(await r.text()); } catch { throw new GasError('bad_response'); }
    if (j.status !== 'ok') throw new GasError(j.error || 'gas_error', j.detail);
    return j;
  } catch (e) {
    if (e instanceof GasError) throw e;
    throw new GasError(e.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}
