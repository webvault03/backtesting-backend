/**
 * Dhan history for the Short straddle next day backtest.
 *
 * Only the minutes the strategy prices at are kept (09:20 entry, 15:15 exit, a few fallback
 * minutes around them), held in this process's memory — nothing is written to MongoDB.
 *
 * Per trading day:
 *   spot: { [minute]: [open, close] }                       NIFTY index
 *   next / near: { CE: { [strike]: { [minute]: [open, close] } }, PE: {...} }
 *     next = second weekly expiry (what the live engine sells), rolling ATM±3 (Dhan max for it)
 *     near = nearest weekly expiry, rolling ATM±5 — the held contract on the day after an expiry-day entry
 */
const { addDays, dhanPost, istParts, mapLimit } = require('../oiCandleAgreeBacktest/dataSource');
const { getIstClock } = require('../../utils/dateTime');

const WINDOW_DAYS = 28;
const MAX_IN_FLIGHT = 4;
const MEMORY_MAX_DAYS = 2500;
const CONTRACTS = [
  { book: 'next', expiryCode: 2, offsets: [-3, -2, -1, 0, 1, 2, 3] },
  { book: 'near', expiryCode: 1, offsets: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5] },
];
const KEEP = new Set([560, 561, 562, 563, 564, 910, 911, 912, 913, 914, 915]);
const CALLS_PER_WINDOW = 1 + CONTRACTS.reduce((n, c) => n + c.offsets.length * 2, 0);

const memory = new Map();

function remember(dateKey, entry) {
  memory.delete(dateKey);
  memory.set(dateKey, entry);
  while (memory.size > MEMORY_MAX_DAYS) memory.delete(memory.keys().next().value);
}

const offsetLabel = (off) => (off === 0 ? 'ATM' : off > 0 ? `ATM+${off}` : `ATM${off}`);

async function fetchWindow(from, to, onCall) {
  const days = new Map();
  const dayOf = (dk) => {
    if (!days.has(dk)) {
      days.set(dk, { bars: 0, spot: {}, next: { CE: {}, PE: {} }, near: { CE: {}, PE: {} } });
    }
    return days.get(dk);
  };

  const n = await dhanPost('/charts/intraday', {
    securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: '1', oi: false,
    fromDate: `${from} 09:00:00`, toDate: `${to} 15:30:00`,
  });
  (n.timestamp || []).forEach((t, i) => {
    const p = istParts(t);
    const day = dayOf(p.dateKey);
    day.bars += 1;
    if (KEEP.has(p.minutes)) day.spot[p.minutes] = [n.open[i], n.close[i]];
  });
  onCall();

  const series = [];
  for (const c of CONTRACTS) {
    for (const type of ['CALL', 'PUT']) {
      for (const off of c.offsets) series.push({ ...c, type, off });
    }
  }
  await mapLimit(series, MAX_IN_FLIGHT, async ({ book, expiryCode, type, off }) => {
    const res = await dhanPost('/charts/rollingoption', {
      exchangeSegment: 'NSE_FNO', interval: '1', securityId: 13, instrument: 'OPTIDX', expiryFlag: 'WEEK',
      expiryCode, strike: offsetLabel(off), drvOptionType: type, requiredData: ['open', 'close', 'strike'],
      fromDate: from, toDate: addDays(to, 1),
    });
    const side = type === 'CALL' ? 'CE' : 'PE';
    const s = (type === 'CALL' ? res.data?.ce : res.data?.pe) || {};
    (s.timestamp || []).forEach((t, i) => {
      const p = istParts(t);
      if (p.dateKey < from || p.dateKey > to || !KEEP.has(p.minutes)) return;
      const strikes = dayOf(p.dateKey)[book][side];
      const k = String(s.strike[i]);
      if (!strikes[k]) strikes[k] = {};
      if (!strikes[k][p.minutes]) strikes[k][p.minutes] = [s.open[i], s.close[i]];
    });
    onCall();
  });
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
      const tradingDay = Boolean(data && data.bars > 100);
      const entry = { tradingDay, data: tradingDay ? data : null };
      if (d === today) live.set(d, entry);
      else remember(d, entry);
    }
  }
  return live;
}

/** Trading days in [from, to] (ascending); `live` holds today's entry when it was fetched. */
function loadDays(from, to, live = new Map()) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const entry = live.get(d) || memory.get(d);
    if (entry?.tradingDay) out.push({ dateKey: d, ...entry.data });
  }
  return out;
}

module.exports = { ensureDays, loadDays };
