/**
 * NIFTY index 5-minute candles from Dhan (/charts/intraday) for the NIFTY Champion backtest.
 *
 * Nothing is written to MongoDB or disk: past days are kept in this process's memory (cleared on restart) so
 * repeat runs of the same months do not refetch. Today is always refetched and only finished candles are used.
 *
 * Per trading day: [{ min, o, h, l, c, v, m }] — `min` = IST minute the candle starts (09:15 = 555), ascending;
 * `m` = the 1-minute candles inside it.
 */
const { addDays, dhanPost, istParts } = require('../oiCandleAgreeBacktest/dataSource');
const { getIstClock } = require('../../utils/dateTime');

const TF = 5;
const MEMORY_MAX_DAYS = 3000;
/** dateKey → candles (null = no trading that date). */
const memory = new Map();

function remember(dateKey, candles) {
  memory.delete(dateKey);
  memory.set(dateKey, candles);
  while (memory.size > MEMORY_MAX_DAYS) memory.delete(memory.keys().next().value);
}

async function fetchInterval(from, to, interval) {
  const r = await dhanPost('/charts/intraday', {
    securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: String(interval), oi: false,
    fromDate: `${from} 09:00:00`, toDate: `${to} 15:30:00`,
  });
  const days = new Map();
  (r.timestamp || []).forEach((t, i) => {
    const p = istParts(t);
    if (p.dateKey < from || p.dateKey > to) return;
    if (!days.has(p.dateKey)) days.set(p.dateKey, []);
    days.get(p.dateKey).push({ min: p.minutes, o: r.open[i], h: r.high[i], l: r.low[i], c: r.close[i], v: r.volume?.[i] ?? 0 });
  });
  for (const list of days.values()) list.sort((a, b) => a.min - b.min);
  return days;
}

/** 5-min candles, each with `m` = its 1-minute candles (used only to settle exits inside the 5-min candle). */
async function fetchRange(from, to) {
  const days = await fetchInterval(from, to, TF);
  const minutes = await fetchInterval(from, to, 1);
  for (const [d, list] of days) {
    const ones = minutes.get(d) || [];
    for (const c of list) c.m = ones.filter((x) => x.min >= c.min && x.min < c.min + TF);
  }
  return days;
}

/**
 * Trading days in [from, to] (ascending): [{ dateKey, candles }]. Missing dates are fetched from Dhan in one
 * call (callers keep ranges ≤ 25 days). Today's candle still in progress is dropped.
 */
async function loadCandles(from, to) {
  const now = getIstClock(new Date());
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const missing = dates.filter((d) => !memory.has(d) || d === now.dateKey);
  const fresh = new Map();
  if (missing.length) {
    const days = await fetchRange(missing[0], missing[missing.length - 1]);
    for (const d of missing) {
      const candles = days.get(d) || null;
      if (d === now.dateKey) fresh.set(d, candles ? candles.filter((c) => c.min + TF <= now.minutes) : null);
      else remember(d, candles);
    }
  }
  const out = [];
  for (const d of dates) {
    const candles = fresh.has(d) ? fresh.get(d) : memory.get(d);
    if (candles?.length) out.push({ dateKey: d, candles });
  }
  return out;
}

/** India VIX daily closes (Dhan /charts/historical, security 21): Map dateKey → close. Past days kept in memory. */
const vixMemory = new Map();
const vixFetched = { from: null, to: null };
async function loadVixDaily(from, to) {
  const today = getIstClock(new Date()).dateKey;
  const end = to < today ? to : addDays(today, -1);
  if (!vixFetched.from || vixFetched.from > from || vixFetched.to < end) {
    const r = await dhanPost('/charts/historical', {
      securityId: '21', exchangeSegment: 'IDX_I', instrument: 'INDEX', expiryCode: 0, oi: false,
      fromDate: from, toDate: addDays(end, 1),
    });
    (r.timestamp || []).forEach((t, i) => {
      const d = istParts(t).dateKey;
      if (d <= end && Number.isFinite(r.close?.[i])) vixMemory.set(d, r.close[i]);
    });
    vixFetched.from = vixFetched.from && vixFetched.from < from ? vixFetched.from : from;
    vixFetched.to = vixFetched.to && vixFetched.to > end ? vixFetched.to : end;
  }
  return new Map([...vixMemory].filter(([d]) => d >= from && d <= end).sort((a, b) => a[0].localeCompare(b[0])));
}

module.exports = { loadCandles, loadVixDaily, TF };
