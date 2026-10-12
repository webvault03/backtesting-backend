/**
 * Dhan history for the CVD + ΔOI backtest, cached on disk so 2021 → today downloads only once.
 *
 * Per trading day (one gzip file per date under .cache/cvdOi, non-trading dates stored as a marker):
 *   nifty: { m: [minute], o, h, l, c }                         NIFTY index, deduped, 09:15–15:29
 *   CE / PE: { [strike]: { m, o, h, l, c, v, oi } }            nearest weekly, rolling ATM±3
 *
 * Days are read back one at a time by the engine — the full range never sits in memory.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { addDays, dhanPost, istParts, mapLimit } = require('../oiCandleAgreeBacktest/dataSource');
const { getIstClock } = require('../../utils/dateTime');

const CACHE_DIR = path.join(__dirname, '..', '..', '..', '.cache', 'cvdOi');
const OFFSETS = [-3, -2, -1, 0, 1, 2, 3];
const WINDOW_DAYS = 25;
const MAX_IN_FLIGHT = 4;
const SESSION_FIRST = 9 * 60 + 15;
const SESSION_LAST = 15 * 60 + 29;
const CALLS_PER_WINDOW = 1 + OFFSETS.length * 2;

const offsetLabel = (off) => (off === 0 ? 'ATM' : off > 0 ? `ATM+${off}` : `ATM${off}`);
const fileFor = (dateKey) => path.join(CACHE_DIR, `${dateKey}.json.gz`);

function writeDay(dateKey, payload) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${fileFor(dateKey)}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
  fs.renameSync(tmp, fileFor(dateKey));
}

function readDay(dateKey) {
  const file = fileFor(dateKey);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

const isCached = (dateKey) => fs.existsSync(fileFor(dateKey));

function columns(byMin, fields) {
  const mins = [...byMin.keys()].sort((a, b) => a - b);
  const out = { m: mins };
  fields.forEach((f, j) => {
    out[f] = mins.map((m) => byMin.get(m)[j]);
  });
  return out;
}

async function fetchWindow(from, to, onCall) {
  const days = new Map();
  const dayOf = (dk) => {
    if (!days.has(dk)) days.set(dk, { nifty: new Map(), CE: {}, PE: {} });
    return days.get(dk);
  };

  const n = await dhanPost('/charts/intraday', {
    securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: '1', oi: false,
    fromDate: `${from} 09:00:00`, toDate: `${to} 15:30:00`,
  });
  (n.timestamp || []).forEach((t, i) => {
    const p = istParts(t);
    if (p.minutes < SESSION_FIRST || p.minutes > SESSION_LAST) return;
    const bars = dayOf(p.dateKey).nifty;
    if (!bars.has(p.minutes)) bars.set(p.minutes, [n.open[i], n.high[i], n.low[i], n.close[i]]);
  });
  onCall();

  const series = [];
  for (const type of ['CALL', 'PUT']) {
    for (const off of OFFSETS) series.push({ type, off });
  }
  const responses = new Map();
  await mapLimit(series, MAX_IN_FLIGHT, async ({ type, off }) => {
    const res = await dhanPost('/charts/rollingoption', {
      exchangeSegment: 'NSE_FNO', interval: '1', securityId: 13, instrument: 'OPTIDX', expiryFlag: 'WEEK',
      expiryCode: 1, strike: offsetLabel(off), drvOptionType: type,
      requiredData: ['open', 'high', 'low', 'close', 'volume', 'oi', 'strike'],
      fromDate: from, toDate: addDays(to, 1),
    });
    responses.set(`${type}${off}`, res);
    onCall();
  });

  // Fixed offset order so the merge does not depend on which response arrived first.
  for (const { type, off } of series) {
    const side = type === 'CALL' ? 'CE' : 'PE';
    const res = responses.get(`${type}${off}`);
    const s = (type === 'CALL' ? res.data?.ce : res.data?.pe) || {};
    (s.timestamp || []).forEach((t, i) => {
      const p = istParts(t);
      if (p.dateKey < from || p.dateKey > to) return;
      if (p.minutes < SESSION_FIRST || p.minutes > SESSION_LAST) return;
      const book = dayOf(p.dateKey)[side];
      const k = String(s.strike[i]);
      if (!book[k]) book[k] = new Map();
      if (!book[k].has(p.minutes)) {
        book[k].set(p.minutes, [s.open[i], s.high[i], s.low[i], s.close[i], s.volume?.[i] ?? 0, s.oi?.[i] ?? null]);
      }
    });
  }

  const out = new Map();
  for (const [dk, day] of days) {
    const payload = { nifty: columns(day.nifty, ['o', 'h', 'l', 'c']), CE: {}, PE: {} };
    for (const side of ['CE', 'PE']) {
      for (const [k, byMin] of Object.entries(day[side])) payload[side][k] = columns(byMin, ['o', 'h', 'l', 'c', 'v', 'oi']);
    }
    out.set(dk, payload);
  }
  return out;
}

/**
 * Download every date in [from, to] that is not on disk yet. Today is fetched but never cached
 * (session still running) and is returned so the engine can use it.
 */
async function ensureDays(from, to, { onProgress } = {}) {
  const today = getIstClock(new Date()).dateKey;
  const missing = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (d === today || !isCached(d)) missing.push(d);
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
      onProgress?.({ phase: 'fetch', done, total, window: w });
    });
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) {
      const data = days.get(d);
      const tradingDay = Boolean(data && data.nifty.m.length > 100);
      if (d === today) {
        if (tradingDay) live.set(d, data);
        continue;
      }
      writeDay(d, tradingDay ? { tradingDay, ...data } : { tradingDay });
    }
  }
  return live;
}

/** Trading day payload for `dateKey` (from `live` for today, else disk), or null. */
function loadDay(dateKey, live = new Map()) {
  if (live.has(dateKey)) return { dateKey, ...live.get(dateKey) };
  const entry = readDay(dateKey);
  return entry?.tradingDay ? { dateKey, ...entry } : null;
}

module.exports = { ensureDays, loadDay, SESSION_FIRST, SESSION_LAST };
