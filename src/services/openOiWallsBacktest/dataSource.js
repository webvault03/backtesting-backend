/**
 * Dhan history for the Open OI Walls backtest — kept in this process's memory only (never MongoDB).
 *
 * Per trading day:
 *   nifty: { m: [minute], o, h, l, c }                     NIFTY index 1-min
 *   CE / PE: { [strike]: { m, o, h, l, c, oi } }           nearest weekly, rolling ATM±10, 09:15–15:30
 *   closeOi: { near: { CE: { [strike]: oi } , PE }, next: { CE, PE } }
 *     last OI of the day — `near` = nearest weekly (ATM±10), `next` = second weekly (ATM±3, Dhan max).
 *     The day after an expiry, today's nearest contract was yesterday's `next`, so the 09:15 ΔOI
 *     baseline comes from there.
 */
const zlib = require('zlib');
const { addDays, dhanPost, istParts, mapLimit } = require('../oiCandleAgreeBacktest/dataSource');
const { getIstClock } = require('../../utils/dateTime');

const WINDOW_DAYS = 25;
const MAX_IN_FLIGHT = 4;
const MEMORY_MAX_DAYS = 1600;
const FIRST_MINUTE = 9 * 60 + 15;
const CONTRACTS = [
  { book: 'near', expiryCode: 1, offsets: Array.from({ length: 21 }, (_, i) => i - 10), full: true },
  { book: 'next', expiryCode: 2, offsets: [-3, -2, -1, 0, 1, 2, 3], full: false },
];
const CALLS_PER_WINDOW = 1 + CONTRACTS.reduce((n, c) => n + c.offsets.length * 2, 0);

const memory = new Map();

function remember(dateKey, entry) {
  memory.delete(dateKey);
  memory.set(dateKey, entry);
  while (memory.size > MEMORY_MAX_DAYS) memory.delete(memory.keys().next().value);
}

const offsetLabel = (off) => (off === 0 ? 'ATM' : off > 0 ? `ATM+${off}` : `ATM${off}`);
const pack = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
const unpack = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

async function fetchWindow(from, to, onCall) {
  const days = new Map();
  const dayOf = (dk) => {
    if (!days.has(dk)) {
      days.set(dk, {
        nifty: { m: [], o: [], h: [], l: [], c: [] },
        CE: {},
        PE: {},
        closeOi: { near: { CE: {}, PE: {} }, next: { CE: {}, PE: {} } },
        lastMin: { near: { CE: {}, PE: {} }, next: { CE: {}, PE: {} } },
      });
    }
    return days.get(dk);
  };

  const n = await dhanPost('/charts/intraday', {
    securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: '1', oi: false,
    fromDate: `${from} 09:00:00`, toDate: `${to} 15:30:00`,
  });
  (n.timestamp || []).forEach((t, i) => {
    const p = istParts(t);
    const d = dayOf(p.dateKey).nifty;
    d.m.push(p.minutes);
    d.o.push(n.open[i]);
    d.h.push(n.high[i]);
    d.l.push(n.low[i]);
    d.c.push(n.close[i]);
  });
  onCall();

  const series = [];
  for (const c of CONTRACTS) {
    for (const type of ['CALL', 'PUT']) {
      for (const off of c.offsets) series.push({ ...c, type, off });
    }
  }
  const responses = new Map();
  await mapLimit(series, MAX_IN_FLIGHT, async ({ book, expiryCode, full, type, off }) => {
    const res = await dhanPost('/charts/rollingoption', {
      exchangeSegment: 'NSE_FNO', interval: '1', securityId: 13, instrument: 'OPTIDX', expiryFlag: 'WEEK',
      expiryCode, strike: offsetLabel(off), drvOptionType: type,
      requiredData: full ? ['open', 'high', 'low', 'close', 'oi', 'strike'] : ['oi', 'strike'],
      fromDate: from, toDate: addDays(to, 1),
    });
    responses.set(`${book}${type}${off}`, res);
    onCall();
  });

  // Merge in fixed order so the result does not depend on response arrival order.
  for (const { book, full, type, off } of series) {
    const side = type === 'CALL' ? 'CE' : 'PE';
    const res = responses.get(`${book}${type}${off}`);
    const s = (type === 'CALL' ? res.data?.ce : res.data?.pe) || {};
    (s.timestamp || []).forEach((t, i) => {
      const p = istParts(t);
      if (p.dateKey < from || p.dateKey > to) return;
      const day = dayOf(p.dateKey);
      const k = String(s.strike[i]);
      const oi = s.oi?.[i];
      if (Number.isFinite(oi) && !(day.lastMin[book][side][k] > p.minutes)) {
        day.lastMin[book][side][k] = p.minutes;
        day.closeOi[book][side][k] = oi;
      }
      if (!full || p.minutes < FIRST_MINUTE) return;
      // One strike shows up in several offset series as ATM moves — merge by minute.
      if (!day[side][k]) day[side][k] = new Map();
      if (!day[side][k].has(p.minutes)) day[side][k].set(p.minutes, [s.open[i], s.high[i], s.low[i], s.close[i], oi]);
    });
  }

  for (const day of days.values()) {
    delete day.lastMin;
    for (const side of ['CE', 'PE']) {
      for (const [k, byMin] of Object.entries(day[side])) {
        const mins = [...byMin.keys()].sort((a, b) => a - b);
        const col = (j) => mins.map((m) => byMin.get(m)[j]);
        day[side][k] = { m: mins, o: col(0), h: col(1), l: col(2), c: col(3), oi: col(4) };
      }
    }
  }
  return days;
}

/** Make sure every calendar date in [from, to] is in memory; today is fetched but never kept. */
async function ensureDays(from, to, { onProgress } = {}) {
  const today = getIstClock(new Date()).dateKey;
  const missing = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!memory.has(d) || d === today) missing.push(d);
  }

  const windows = [];
  for (const d of missing) {
    const last = windows[windows.length - 1];
    if (last && addDays(last.to, 1) === d && last.days < WINDOW_DAYS) {
      last.to = d;
      last.days += 1;
    } else {
      windows.push({ from: d, to: d, days: 1 });
    }
  }

  const total = windows.length * CALLS_PER_WINDOW;
  let done = 0;
  onProgress?.({ phase: 'fetch', done, total });
  const live = new Map();
  for (const w of windows) {
    const days = await fetchWindow(w.from, w.to, () => {
      done += 1;
      onProgress?.({ phase: 'fetch', done, total });
    });
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) {
      const data = days.get(d);
      const tradingDay = Boolean(data && data.nifty.m.length > 100);
      if (d === today) {
        if (tradingDay) live.set(d, data);
        continue;
      }
      remember(d, { tradingDay, payload: tradingDay ? pack(data) : null });
    }
  }
  return live;
}

/** Trading days in [from, to] (ascending); `live` holds today's data when it was fetched. */
function loadDays(from, to, live = new Map()) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (live.has(d)) {
      out.push({ dateKey: d, ...live.get(d) });
      continue;
    }
    const entry = memory.get(d);
    if (entry?.tradingDay) out.push({ dateKey: d, ...unpack(entry.payload) });
  }
  return out;
}

module.exports = { addDays, ensureDays, loadDays };
