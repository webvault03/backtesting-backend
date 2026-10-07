/**
 * NIFTY average buying / selling price — current session only.
 *
 * NIFTY index has no volume, so the calculation runs on the near-month NIFTY future's 1-min
 * OHLC + volume. Each candle's volume is split by where it closed inside its range:
 *   buyVol  = V × (C − L) / (H − L)     sellVol = V − buyVol     (flat candle → 50/50)
 *   price   = (H + L + C) / 3
 *   avgBuy  = Σ(price × buyVol) / Σ buyVol     avgSell = Σ(price × sellVol) / Σ sellVol
 * Spot-equivalent levels subtract the current futures basis (fut − spot).
 */
const NiftyAvgBuySellDay = require('../models/niftyAvgBuySellDay');
const { fetchIntradayCandlesBySecurity, fetchTradingDayCandles } = require('./dhanDataService');
const { listFutureExpiries, futureInstrumentTypeForUnderlying } = require('./dhanLiveService');
const { ensureNseHolidaysLoaded, isNseCashTradingDay } = require('./nseHolidayService');
const { getIstClock, parseDateOnly, formatDateOnly, addDays } = require('../utils/dateTime');

const SYMBOL = 'NIFTY';
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;
const CACHE_MS = 30_000;
const WARMUP_BARS = 15;
const RECENT_BARS = 30;

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

async function resolveNearFuture(dateKey) {
  const expiries = await listFutureExpiries(SYMBOL, { includePastDays: 45 });
  const contract = expiries.find((e) => e.expiry >= dateKey);
  if (!contract) throw new Error(`No NIFTY futures contract found for ${dateKey}`);
  return {
    ...contract,
    exchangeSegment: contract.exchangeSegment || 'NSE_FNO',
    instrument: futureInstrumentTypeForUnderlying(SYMBOL),
  };
}

function sessionRows(rows, dateKey) {
  const out = [];
  for (const r of rows || []) {
    if (!Array.isArray(r)) continue;
    const ms = Date.parse(r[0]);
    if (!Number.isFinite(ms)) continue;
    const clock = getIstClock(new Date(ms));
    if (clock.dateKey !== dateKey) continue;
    if (clock.minutes < SESSION_OPEN_MIN || clock.minutes >= SESSION_CLOSE_MIN) continue;
    const [open, high, low, close] = [r[1], r[2], r[3], r[4]].map(Number);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    out.push({ t: Math.floor(ms / 1000), open, high, low, close, volume: Math.max(0, Number(r[5]) || 0) });
  }
  return out.sort((a, b) => a.t - b.t);
}

function splitVolume(c) {
  const range = c.high - c.low;
  const buyFrac = range > 0 ? (c.close - c.low) / range : 0.5;
  const buyVol = c.volume * buyFrac;
  return { buyVol, sellVol: c.volume - buyVol, price: (c.high + c.low + c.close) / 3 };
}

function marketStatus(price, avgBuy, avgSell) {
  if (![price, avgBuy, avgSell].every(Number.isFinite)) {
    return { code: 'NA', label: 'Not enough data', detail: '' };
  }
  const upper = Math.max(avgBuy, avgSell);
  const lower = Math.min(avgBuy, avgSell);
  if (price > upper) {
    return {
      code: 'UP',
      label: 'Market UP — above average buying & selling',
      detail: 'Buyers are in profit, sellers are trapped. Average levels act as support.',
    };
  }
  if (price < lower) {
    return {
      code: 'DOWN',
      label: 'Market DOWN — below average buying & selling',
      detail: 'Sellers are in profit, buyers are trapped. Average levels act as resistance.',
    };
  }
  return {
    code: 'BALANCED',
    label: 'Balanced — between average buying & selling',
    detail: 'No clear control. Wait for a break above or below the band.',
  };
}

function dominance(buyVol, sellVol) {
  const total = buyVol + sellVol;
  if (total <= 0) return { buyPct: null, sellPct: null, side: 'NA' };
  const buyPct = (buyVol / total) * 100;
  let side = 'NEUTRAL';
  if (buyPct >= 55) side = 'BUYERS';
  else if (buyPct <= 45) side = 'SELLERS';
  return { buyPct: round2(buyPct), sellPct: round2(100 - buyPct), side };
}

function compute(dateKey, contract, futCandles, spotCandles) {
  const spotByT = new Map(spotCandles.map((c) => [c.t, c.close]));
  let sumBuyPV = 0;
  let sumBuyV = 0;
  let sumSellPV = 0;
  let sumSellV = 0;
  let sumPV = 0;
  let sumV = 0;
  let lastSpot = null;
  const points = [];
  const perBar = [];

  for (const c of futCandles) {
    const { buyVol, sellVol, price } = splitVolume(c);
    perBar.push({ buyVol, sellVol });
    sumBuyPV += price * buyVol;
    sumBuyV += buyVol;
    sumSellPV += price * sellVol;
    sumSellV += sellVol;
    sumPV += price * c.volume;
    sumV += c.volume;
    if (spotByT.has(c.t)) lastSpot = spotByT.get(c.t);
    points.push({
      t: c.t,
      futClose: c.close,
      spot: spotByT.get(c.t) ?? null,
      avgBuy: round2(sumBuyV > 0 ? sumBuyPV / sumBuyV : null),
      avgSell: round2(sumSellV > 0 ? sumSellPV / sumSellV : null),
      vwap: round2(sumV > 0 ? sumPV / sumV : null),
    });
  }

  const lastFut = futCandles.length ? futCandles[futCandles.length - 1] : null;
  const lastSpotCandle = spotCandles.length ? spotCandles[spotCandles.length - 1] : null;
  const spotLtp = lastSpotCandle ? lastSpotCandle.close : lastSpot;
  const futLtp = lastFut ? lastFut.close : null;
  const basis = Number.isFinite(futLtp) && Number.isFinite(lastSpot) ? futLtp - lastSpot : null;

  const avgBuy = sumBuyV > 0 ? sumBuyPV / sumBuyV : null;
  const avgSell = sumSellV > 0 ? sumSellPV / sumSellV : null;
  const vwap = sumV > 0 ? sumPV / sumV : null;
  const toSpot = (v) => (Number.isFinite(v) && Number.isFinite(basis) ? v - basis : null);

  const recent = perBar.slice(-RECENT_BARS);
  const recentBuy = recent.reduce((s, b) => s + b.buyVol, 0);
  const recentSell = recent.reduce((s, b) => s + b.sellVol, 0);

  const range = (list) => (list.length
    ? {
      open: list[0].open,
      high: Math.max(...list.map((c) => c.high)),
      low: Math.min(...list.map((c) => c.low)),
      close: list[list.length - 1].close,
    }
    : null);

  const { dateKey: today, minutes } = getIstClock(new Date());
  const isLive = dateKey === today && minutes >= SESSION_OPEN_MIN && minutes <= SESSION_CLOSE_MIN;

  return {
    ok: true,
    symbol: SYMBOL,
    dateKey,
    isToday: dateKey === today,
    isLive,
    warmingUp: futCandles.length < WARMUP_BARS,
    barCount: futCandles.length,
    lastBarAt: lastFut ? new Date(lastFut.t * 1000).toISOString() : null,
    futures: {
      securityId: contract.securityId,
      expiry: contract.expiry,
      tradingSymbol: contract.tradingSymbol,
    },
    summary: {
      futLtp: round2(futLtp),
      spotLtp: round2(spotLtp),
      basis: round2(basis),
      fut: {
        avgBuy: round2(avgBuy),
        avgSell: round2(avgSell),
        vwap: round2(vwap),
        ohlc: range(futCandles),
      },
      spot: {
        avgBuy: round2(toSpot(avgBuy)),
        avgSell: round2(toSpot(avgSell)),
        vwap: round2(toSpot(vwap)),
        ohlc: range(spotCandles),
      },
      distance: {
        fromAvgBuy: round2(Number.isFinite(futLtp) && Number.isFinite(avgBuy) ? futLtp - avgBuy : null),
        fromAvgSell: round2(Number.isFinite(futLtp) && Number.isFinite(avgSell) ? futLtp - avgSell : null),
        fromVwap: round2(Number.isFinite(futLtp) && Number.isFinite(vwap) ? futLtp - vwap : null),
      },
      volume: {
        total: Math.round(sumV),
        buy: Math.round(sumBuyV),
        sell: Math.round(sumSellV),
        ...dominance(sumBuyV, sumSellV),
      },
      recent: {
        bars: recent.length,
        buy: Math.round(recentBuy),
        sell: Math.round(recentSell),
        ...dominance(recentBuy, recentSell),
      },
      status: marketStatus(futLtp, avgBuy, avgSell),
    },
    points,
    fetchedAt: new Date().toISOString(),
  };
}

async function saveDay(payload) {
  await NiftyAvgBuySellDay.updateOne(
    { symbol: SYMBOL, dateKey: payload.dateKey },
    {
      $set: {
        futures: payload.futures,
        summary: payload.summary,
        points: payload.points,
        barCount: payload.barCount,
        fetchedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function loadSavedDay(dateKey) {
  const doc = await NiftyAvgBuySellDay.findOne({ symbol: SYMBOL, dateKey }).lean();
  if (!doc) return null;
  return {
    ok: true,
    symbol: SYMBOL,
    dateKey,
    isToday: dateKey === getIstClock(new Date()).dateKey,
    isLive: false,
    warmingUp: (doc.barCount || 0) < WARMUP_BARS,
    barCount: doc.barCount || 0,
    futures: doc.futures,
    summary: doc.summary,
    points: doc.points || [],
    fetchedAt: doc.fetchedAt,
    fromDb: true,
  };
}

async function buildFresh(dateKey) {
  const contract = await resolveNearFuture(dateKey);
  const futRes = await fetchIntradayCandlesBySecurity({
    securityId: contract.securityId,
    exchangeSegment: contract.exchangeSegment,
    instrument: contract.instrument,
    interval: '1',
    dateKey,
  });
  const spotRes = await fetchTradingDayCandles({ symbol: SYMBOL, interval: '1', dateKey });
  const futCandles = sessionRows(futRes.rows, dateKey);
  const spotCandles = sessionRows(spotRes.rows, dateKey);
  if (!futCandles.length) throw new Error(`No NIFTY futures candles for ${dateKey} yet`);
  const payload = compute(dateKey, contract, futCandles, spotCandles);
  saveDay(payload).catch((err) => console.warn('[niftyAvgBuySell] save failed:', err.message));
  return payload;
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

  try {
    return await inflight.get(dateKey);
  } catch (error) {
    const saved = await loadSavedDay(dateKey).catch(() => null);
    if (saved) return { ...saved, staleReason: error.message };
    throw error;
  }
}

module.exports = {
  getTodayAvgBuySell,
};
