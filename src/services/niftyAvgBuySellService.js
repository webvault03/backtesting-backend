/**
 * NIFTY running average price — current session only.
 *
 * Every 1-min candle close of the session is added to a running average:
 *   minute 1 → c1 / 1,  minute 2 → (c1 + c2) / 2,  minute n → (c1 + … + cn) / n
 * Price above the running average → buyers in control; below → sellers in control.
 */
const { fetchTradingDayCandles } = require('./dhanDataService');
const { ensureNseHolidaysLoaded, isNseCashTradingDay } = require('./nseHolidayService');
const { getIstClock, parseDateOnly, formatDateOnly, addDays } = require('../utils/dateTime');

const SYMBOL = 'NIFTY';
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;
const CACHE_MS = 30_000;
const WARMUP_BARS = 15;

const cache = new Map();
const inflight = new Map();

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/** Today (IST) once the session has opened, else the latest completed NSE trading day. */
function resolveSessionDateKey() {
  const { dateKey: today, minutes } = getIstClock(new Date());
  let cursor = parseDateOnly(today);
  if (!isNseCashTradingDay(today) || minutes < SESSION_OPEN_MIN) cursor = addDays(cursor, -1);
  for (let i = 0; i < 15; i += 1) {
    const key = formatDateOnly(cursor);
    if (isNseCashTradingDay(key)) return key;
    cursor = addDays(cursor, -1);
  }
  return today;
}

function sessionCloses(rows, dateKey) {
  const out = [];
  for (const r of rows || []) {
    if (!Array.isArray(r)) continue;
    const ms = Date.parse(r[0]);
    const close = Number(r[4]);
    if (!Number.isFinite(ms) || !Number.isFinite(close)) continue;
    const clock = getIstClock(new Date(ms));
    if (clock.dateKey !== dateKey) continue;
    if (clock.minutes < SESSION_OPEN_MIN || clock.minutes >= SESSION_CLOSE_MIN) continue;
    out.push({ t: Math.floor(ms / 1000), close });
  }
  return out.sort((a, b) => a.t - b.t);
}

function marketStatus(price, avg) {
  if (![price, avg].every(Number.isFinite)) return { code: 'NA', label: 'Not enough data' };
  if (price > avg) return { code: 'UP', label: 'Above average · buyers in control' };
  if (price < avg) return { code: 'DOWN', label: 'Below average · sellers in control' };
  return { code: 'BALANCED', label: 'At average' };
}

function compute(dateKey, candles) {
  let sumClose = 0;
  const points = candles.map((c, i) => {
    sumClose += c.close;
    return { t: c.t, n: i + 1, close: c.close, avg: round2(sumClose / (i + 1)) };
  });

  const ltp = candles.length ? candles[candles.length - 1].close : null;
  const avg = candles.length ? sumClose / candles.length : null;
  const { dateKey: today, minutes } = getIstClock(new Date());

  return {
    ok: true,
    symbol: SYMBOL,
    dateKey,
    isToday: dateKey === today,
    isLive: dateKey === today && minutes >= SESSION_OPEN_MIN && minutes <= SESSION_CLOSE_MIN,
    warmingUp: candles.length < WARMUP_BARS,
    barCount: candles.length,
    summary: {
      ltp: round2(ltp),
      avg: round2(avg),
      sumClose: round2(sumClose),
      distance: round2(Number.isFinite(ltp) && Number.isFinite(avg) ? ltp - avg : null),
      barsAbove: points.filter((p) => p.close > p.avg).length,
      barsBelow: points.filter((p) => p.close < p.avg).length,
      status: marketStatus(ltp, avg),
    },
    points,
    fetchedAt: new Date().toISOString(),
  };
}

async function buildFresh(dateKey) {
  const res = await fetchTradingDayCandles({ symbol: SYMBOL, interval: '1', dateKey });
  const candles = sessionCloses(res.rows, dateKey);
  if (!candles.length) throw new Error(`No NIFTY 1-min candles for ${dateKey} yet`);
  return compute(dateKey, candles);
}

async function getTodayAvgBuySell({ refresh = false } = {}) {
  await ensureNseHolidaysLoaded();
  const dateKey = resolveSessionDateKey();
  const hit = cache.get(dateKey);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return hit.payload;

  if (!inflight.has(dateKey)) {
    inflight.set(
      dateKey,
      buildFresh(dateKey)
        .then((payload) => {
          cache.set(dateKey, { payload, at: Date.now() });
          return payload;
        })
        .finally(() => inflight.delete(dateKey)),
    );
  }
  return inflight.get(dateKey);
}

module.exports = {
  getTodayAvgBuySell,
};
