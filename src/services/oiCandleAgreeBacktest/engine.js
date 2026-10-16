/**
 * OI + Candle Agree — historical backtest engine.
 *
 * Rebuilds the live OI Flow minute tape from Dhan history (ATM±3 call/put OI per minute, same
 * shape the live engine reads), then replays the live rules: findLatestAgreeSignal each minute,
 * ATM entry at the next minute, Nifty SL from the 15m signal candle, profit trail, 15:15 exit.
 */
const OiFlowDayArchive = require('../../models/oiFlowDayArchive');
const { findLatestAgreeSignal, niftyAtmStrike } = require('../../utils/oiCandleAgreeSignal');
const { computeTrailLockPoints } = require('../../utils/openOiWallsTrail');
const { addDays, ensureDays, loadDays } = require('./dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { niftyLotSizeOn } = require('../../utils/niftyLotSize');

const HISTORY_START = '2020-08-03';
const WARMUP_DAYS = 7;

const SESSION_OPEN = 9 * 60 + 15;
const SESSION_LAST = 15 * 60 + 29;
const TRADE_FROM = 9 * 60 + 20;
const TRADE_TO = 14 * 60;
const EOD = 15 * 60 + 15;
const LOOKAROUND = 3;
const STEP = 50;
const CHARGES = 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const r2 = (n) => Number(Number(n).toFixed(2));
const tick = (n) => Math.round(n * 20) / 20;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** minute → value lookups for one day. */
function indexDay(day) {
  const nifty = new Map();
  day.nifty.m.forEach((m, i) => nifty.set(m, { o: day.nifty.o[i], h: day.nifty.h[i], l: day.nifty.l[i], c: day.nifty.c[i] }));
  const opt = { CE: new Map(), PE: new Map() };
  for (const side of ['CE', 'PE']) {
    for (const [strike, s] of Object.entries(day[side] || {})) {
      const byMin = new Map();
      s.m.forEach((m, i) => byMin.set(m, { o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], oi: s.oi[i] }));
      opt[side].set(Number(strike), byMin);
    }
  }
  return { dateKey: day.dateKey, nifty, opt };
}

/** Weekly NIFTY expiry: Thursday until Aug 2025, Tuesday after (holiday → earlier trading day). */
function expiryWeekday(dateKey) {
  return dateKey >= '2025-09-01' ? 2 : 4;
}

/** True when `prevDateKey` was the weekly expiry, so today's nearest weekly is a new contract. */
function rolledAfter(prevDateKey, dateKey) {
  const wd = expiryWeekday(prevDateKey);
  let t = prevDateKey;
  while (new Date(`${t}T00:00:00Z`).getUTCDay() !== wd) t = addDays(t, 1);
  return dateKey > t;
}

function lastOiBefore(byMin, minute) {
  for (let m = minute; m >= SESSION_OPEN; m -= 1) {
    const v = byMin?.get(m)?.oi;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Minute rows in the live tape shape. Row m = snapshot taken just after minute m opens:
 * spot ≈ previous minute close, OI ≈ previous minute closing OI. Row 09:15 uses the
 * previous session's closing OI for the same contract (or the first minute after a rollover).
 */
function buildTape(day, prevDay) {
  const sameContract = prevDay && !rolledAfter(prevDay.dateKey, day.dateKey);
  const baselineOi = (side, strike) => {
    if (sameContract) {
      const v = lastOiBefore(prevDay.opt[side].get(strike), SESSION_LAST);
      if (Number.isFinite(v)) return v;
    }
    return day.opt[side].get(strike)?.get(SESSION_OPEN)?.oi ?? null;
  };

  const rows = [];
  for (let m = SESSION_OPEN; m <= SESSION_LAST; m += 1) {
    const prevBar = day.nifty.get(m - 1);
    const spot = m === SESSION_OPEN ? day.nifty.get(m)?.o : prevBar?.c;
    if (!Number.isFinite(spot)) continue;
    const atm = Math.round(spot / STEP) * STEP;
    const strikes = [];
    let dayCall = 0;
    let dayPut = 0;
    let callTotal = 0;
    let putTotal = 0;
    for (let k = -LOOKAROUND; k <= LOOKAROUND; k += 1) {
      const strike = atm + k * STEP;
      const callOi = m === SESSION_OPEN ? baselineOi('CE', strike) : lastOiBefore(day.opt.CE.get(strike), m - 1);
      const putOi = m === SESSION_OPEN ? baselineOi('PE', strike) : lastOiBefore(day.opt.PE.get(strike), m - 1);
      strikes.push({ strike, callOi, putOi });
      const cBase = baselineOi('CE', strike);
      const pBase = baselineOi('PE', strike);
      if (Number.isFinite(callOi)) {
        callTotal += callOi;
        if (Number.isFinite(cBase)) dayCall += callOi - cBase;
      }
      if (Number.isFinite(putOi)) {
        putTotal += putOi;
        if (Number.isFinite(pBase)) dayPut += putOi - pBase;
      }
    }
    rows.push({
      minutes: m,
      time: hhmm(m),
      dateKey: day.dateKey,
      symbol: 'NIFTY',
      fetchOk: true,
      atm,
      spotPrice: spot,
      strikes,
      dayCallChgOi: dayCall,
      dayPutChgOi: dayPut,
      callOiTotal: callTotal,
      putOiTotal: putTotal,
    });
  }
  return rows;
}

/** Exact live tape from a v2 OI Flow archive (first minute restored), or null. */
async function archiveTape(dateKey) {
  const a = await OiFlowDayArchive.findOne({ symbol: 'NIFTY', intervalMin: 1, dateKey }).lean();
  if (a?.payload?.schema !== 'oi-flow-tape-v2') return null;
  const rows = (a.payload.rows || [])
    .map((r) => ({ ...r, callAct: null, putAct: null }))
    .sort((x, y) => Number(x.minutes) - Number(y.minutes));
  const first = rows[0];
  if (first && Number(first.minutes) === SESSION_OPEN + 1) {
    const spot = r2(Number(first.spotPrice) - Number(first.spotDelta || 0));
    rows.unshift({
      ...first,
      minutes: SESSION_OPEN,
      time: hhmm(SESSION_OPEN),
      spotPrice: spot,
      spot,
      dayCallChgOi: Number(first.dayCallChgOi) - Number(first.callsChgOi),
      dayPutChgOi: Number(first.dayPutChgOi) - Number(first.putsChgOi),
      callsChgOi: null,
      putsChgOi: null,
    });
  }
  return rows;
}

/**
 * Fresh AGREE bar inside the trade window, seen at minute `now` ≥ `afterMin`.
 * `afterBarEnd` skips bars already used or rejected (must be a newer 15m bar).
 */
function findEntry(rows, { afterMin = TRADE_FROM, afterBarEnd = -Infinity } = {}) {
  const start = Math.max(TRADE_FROM, afterMin);
  for (let now = start; now <= TRADE_TO + 16; now += 1) {
    const visible = rows.filter((r) => Number(r.minutes) <= now);
    const res = findLatestAgreeSignal(visible, now);
    if (!res.ok) continue;
    const barEnd = Number(res.bar?.endMin);
    if (!Number.isFinite(barEnd) || barEnd <= afterBarEnd) continue;
    if (barEnd < TRADE_FROM || barEnd > TRADE_TO || now - barEnd > 16) continue;
    return { now, res };
  }
  return null;
}

/**
 * How strong an AGREE bar is — used to allow a 2nd+ trade only when the new signal beats the last one.
 * Shape rank first (body > wick trap > plain UP/DOWN), then candle range (pts), then body size.
 */
function signalStrength(res) {
  const shape = res.shape || res.bar?.shape || '';
  const rank =
    shape === 'bull_body' || shape === 'bear_body'
      ? 3
      : shape === 'upper_wick_trap' || shape === 'lower_wick_trap'
        ? 2
        : shape === 'tiny' || shape === 'doji'
          ? 0
          : 1;
  const range = Number(res.bar?.range) || 0;
  const body = Math.abs(Number(res.bar?.close) - Number(res.bar?.open)) || 0;
  return r2(rank * 1000 + range + body * 0.01);
}

function crossFraction(from, extreme, level) {
  const span = extreme - from;
  if (!Number.isFinite(span) || span === 0) return 0;
  return Math.min(1, Math.max(0, (level - from) / span));
}

/**
 * SL rule → Nifty level.
 *   mode: 'candle' (signal candle high/low) | 'mid' (candle midpoint) | 'fixed' | 'none'
 *   capPoints: optional max distance from entry for candle / mid
 */
function stopLevel(rule, { isPE, entrySpot, candle }) {
  const { mode = 'candle', capPoints = null, fixedPoints = 30 } = rule;
  if (mode === 'none') return null;
  if (mode === 'fixed') return isPE ? entrySpot + fixedPoints : entrySpot - fixedPoints;
  const full = isPE ? candle.high : candle.low;
  let level = full;
  if (mode === 'mid') {
    const mid = (candle.high + candle.low) / 2;
    const ok = isPE ? mid > entrySpot + 2 : mid < entrySpot - 2;
    level = ok ? mid : full;
  }
  if (Number.isFinite(capPoints) && capPoints > 0) {
    level = isPE ? Math.min(level, entrySpot + capPoints) : Math.max(level, entrySpot - capPoints);
  }
  return r2(level);
}

/** Minute walk: Nifty SL first (engine priority), then trail lock, then 15:15. */
function simulate({ day, optionType, strike, entryMin, entryPremium, entrySpot, sl }) {
  const isPE = optionType === 'PE';
  const book = day.opt[optionType].get(strike);
  let peak = entryPremium;
  let lock = null;
  let lastClose = entryPremium;
  let lastSpot = entrySpot;
  for (let m = entryMin; m <= EOD; m += 1) {
    const n = day.nifty.get(m);
    const o = book?.get(m);
    if (m === EOD) {
      return { exitType: 'EOD', exitMin: m, exitSec: 0, exitPremium: o ? o.o : lastClose, exitSpot: n ? n.o : lastSpot, peak, lock };
    }
    if (!n || !o) continue;
    const startSpot = m === entryMin ? entrySpot : n.o;
    const startPrem = m === entryMin ? entryPremium : o.o;
    if (sl != null) {
      const extreme = isPE ? n.h : n.l;
      if (isPE ? extreme >= sl : extreme <= sl) {
        const already = isPE ? startSpot >= sl : startSpot <= sl;
        const frac = already ? 0 : crossFraction(startSpot, extreme, sl);
        const exitPremium = tick(startPrem - frac * (startPrem - Math.min(startPrem, o.l)));
        return { exitType: 'SL', exitMin: m, exitSec: Math.round(frac * 59), exitPremium, exitSpot: already ? startSpot : sl, peak, lock };
      }
    }
    if (lock != null && o.l <= lock) {
      const gapped = startPrem <= lock;
      return { exitType: 'TRAIL', exitMin: m, exitSec: 0, exitPremium: gapped ? startPrem : lock, exitSpot: gapped ? startSpot : n.c, peak, lock };
    }
    peak = Math.max(peak, o.h);
    const lockPts = computeTrailLockPoints(peak - entryPremium);
    if (lockPts != null) lock = r2(entryPremium + lockPts);
    lastClose = o.c;
    lastSpot = n.c;
  }
  return null;
}

function signalCandle(day, bar) {
  let high = Number(bar.high);
  let low = Number(bar.low);
  for (let m = bar.startMin; m <= bar.endMin; m += 1) {
    const n = day.nifty.get(m);
    if (!n) continue;
    high = Math.max(high, n.h);
    low = Math.min(low, n.l);
  }
  return { high: r2(high), low: r2(low) };
}

/**
 * One or more trades in a day. First AGREE in the window is taken; after that trade closes,
 * a later AGREE is taken only when its strength is strictly higher than the previous trade's signal
 * (same entry / SL / trail / 15:15 rules). One position at a time · max `maxTrades` per day.
 */
function runDay(day, rows, rule, lots) {
  const lotSize = niftyLotSizeOn(day.dateKey);
  const qty = lots * lotSize;
  const maxTrades = Math.max(1, Math.round(rule.maxTrades || 1));
  const month = Number(day.dateKey.slice(5, 7));
  const trades = [];
  let searchFrom = TRADE_FROM;
  let afterBarEnd = -Infinity;
  let lastStrength = -Infinity;
  let skipped = null;

  while (trades.length < maxTrades) {
    const entry = findEntry(rows, { afterMin: searchFrom, afterBarEnd });
    if (!entry) break;
    const { now: entryMin, res } = entry;
    const barEnd = Number(res.bar.endMin);
    const strength = signalStrength(res);

    // After the first trade, only a strictly stronger AGREE may open the next one.
    if (trades.length > 0 && strength <= lastStrength) {
      afterBarEnd = barEnd;
      searchFrom = Math.max(searchFrom, entryMin + 1);
      continue;
    }

    const optionType = res.optionType;
    const isPE = optionType === 'PE';
    const entrySpot = day.nifty.get(entryMin)?.o;
    const strike = niftyAtmStrike(entrySpot);
    const entryCandle = day.opt[optionType].get(strike)?.get(entryMin);
    if (!Number.isFinite(entrySpot) || !entryCandle) {
      skipped = `no ${optionType} ${strike} data at ${hhmm(entryMin)}`;
      afterBarEnd = barEnd;
      searchFrom = Math.max(searchFrom, entryMin + 1);
      continue;
    }

    const entryPremium = entryCandle.o;
    const candle = signalCandle(day, res.bar);
    const sl = stopLevel(rule, { isPE, entrySpot, candle });
    const sim = simulate({ day, optionType, strike, entryMin, entryPremium, entrySpot, sl });
    if (!sim) {
      skipped = 'simulation incomplete';
      break;
    }

    const points = r2(sim.exitPremium - entryPremium);
    const netPnL = r2(points * qty - CHARGES);
    const reasonText = {
      SL: `Nifty SL ${sl} crossed`,
      TRAIL: `Trail lock +${r2(sim.exitPremium - entryPremium)}`,
      EOD: '15:15 close',
    }[sim.exitType];
    const dayTradeNo = trades.length + 1;
    trades.push({
      id: `${day.dateKey}-${hhmm(entryMin)}-${optionType}-${strike}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      dayTradeNo,
      side: optionType,
      strike,
      signalTime: hhmm(res.bar.startMin),
      shape: res.shape,
      pair: res.pair,
      signalStrength: strength,
      prevSignalStrength: dayTradeNo > 1 ? lastStrength : null,
      candleHigh: candle.high,
      candleLow: candle.low,
      candleRange: r2(Number(res.bar.range) || candle.high - candle.low),
      entryTime: hhmm(entryMin),
      entrySpot,
      entryPremium,
      slSpot: sl,
      slDistance: sl != null ? r2(Math.abs(sl - entrySpot)) : null,
      exitType: sim.exitType,
      exitReason: reasonText,
      exitTime: `${hhmm(sim.exitMin)}:${String(sim.exitSec).padStart(2, '0')}`,
      exitSpot: r2(sim.exitSpot),
      exitPremium: r2(sim.exitPremium),
      peakPremium: r2(sim.peak),
      maxGainPts: r2(sim.peak - entryPremium),
      niftyPts: r2(isPE ? entrySpot - sim.exitSpot : sim.exitSpot - entrySpot),
      points,
      lots,
      lotSize,
      qty,
      grossPnL: r2(points * qty),
      charges: CHARGES,
      netPnL,
      isWin: netPnL > 0,
    });

    lastStrength = strength;
    afterBarEnd = barEnd;
    // Next search only after this trade is flat (one at a time).
    searchFrom = Math.max(sim.exitMin + 1, barEnd + 1);
    if (sim.exitType === 'EOD' || sim.exitMin >= EOD) break;
  }

  return { dateKey: day.dateKey, trades, ...(skipped && !trades.length ? { skipped } : {}) };
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const years = {};
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (!months[t.monthKey]) months[t.monthKey] = { key: t.monthKey, label: `${t.monthShort} ${t.monthKey.slice(2, 4)}`, trades: 0, wins: 0, pnl: 0 };
    const m = months[t.monthKey];
    m.trades += 1;
    if (t.isWin) m.wins += 1;
    m.pnl = r2(m.pnl + t.netPnL);
    const y = t.monthKey.slice(0, 4);
    if (!years[y]) years[y] = { year: y, trades: 0, wins: 0, pnl: 0 };
    years[y].trades += 1;
    if (t.isWin) years[y].wins += 1;
    years[y].pnl = r2(years[y].pnl + t.netPnL);
  }
  const wins = trades.filter((t) => t.isWin);
  const grossWin = wins.reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = -trades.filter((t) => !t.isWin).reduce((s, t) => s + t.netPnL, 0);
  const charges = trades.reduce((s, t) => s + t.charges, 0);
  const dayPnl = {};
  const dayCount = {};
  for (const t of trades) {
    dayPnl[t.date] = (dayPnl[t.date] || 0) + t.netPnL;
    dayCount[t.date] = (dayCount[t.date] || 0) + 1;
  }
  const dayVals = Object.values(dayPnl);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    netPnL: r2(equity),
    charges: r2(charges),
    avgCharges: trades.length ? r2(charges / trades.length) : 0,
    maxDrawdown: r2(maxDd),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    greenDays: dayVals.filter((p) => p > 0).length,
    redDays: dayVals.filter((p) => p <= 0).length,
    multiTradeDays: Object.values(dayCount).filter((n) => n > 1).length,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
    years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

/**
 * @param {{ from: string, to: string, rule?: object, lots?: number, tapeSource?: 'dhan'|'auto', onProgress?: Function, onPartial?: Function }} opts
 */
async function runBacktest({ from, to, rule = { mode: 'candle', capPoints: null, maxTrades: 3 }, lots = 10, tapeSource = 'dhan', onProgress, onPartial } = {}) {
  const lotCount = Math.max(1, Math.round(lots));
  const dayRule = { mode: 'candle', capPoints: null, maxTrades: 3, ...rule };
  const results = [];

  const build = (doneThrough) => {
    const trades = results.flatMap((r) => r.trades || []);
    return {
      from,
      to,
      rule: {
        ...dayRule,
        entryFrom: hhmm(TRADE_FROM),
        entryTo: hhmm(TRADE_TO),
        eod: hhmm(EOD),
        charges: CHARGES,
        maxTrades: Math.max(1, Math.round(dayRule.maxTrades || 1)),
      },
      lots: lotCount,
      qty: lotCount * niftyLotSizeOn(to),
      tapeSource,
      tradingDays: results.length,
      noSignalDays: results.filter((r) => !(r.trades || []).length && !r.skipped).map((r) => r.dateKey),
      skippedDays: results.filter((r) => r.skipped).map((r) => ({ dateKey: r.dateKey, reason: r.skipped })),
      summary: summarize(trades),
      trades,
      ...(doneThrough ? { doneThrough } : {}),
    };
  };

  const chunks = rangeChunks(from, to, { warmupDays: WARMUP_DAYS });
  for (const [ci, chunk] of chunks.entries()) {
    const report = chunkProgress(onProgress, ci, chunks.length, chunk.label, () => ({
      tradesSoFar: results.reduce((n, r) => n + (r.trades || []).length, 0),
    }));
    const fetchFrom = addDays(chunk.from, -WARMUP_DAYS);
    const live = await ensureDays(fetchFrom, chunk.to, { onProgress: report });
    const days = (await loadDays(fetchFrom, chunk.to, live)).map(indexDay);
    const total = days.filter((d) => d.dateKey >= chunk.from).length;
    let done = 0;
    for (let i = 0; i < days.length; i += 1) {
      const day = days[i];
      if (day.dateKey < chunk.from) continue;
      report({ phase: 'simulate', done, total, dateKey: day.dateKey });
      done += 1;
      let rows = null;
      let tape = 'dhan';
      if (tapeSource === 'auto') {
        rows = await archiveTape(day.dateKey);
        if (rows) tape = 'exact';
      }
      if (!rows) rows = buildTape(day, days[i - 1] || null);
      const r = runDay(day, rows, dayRule, lotCount);
      for (const t of r.trades || []) t.tape = tape;
      results.push(r);
    }
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = {
  HISTORY_START,
  runBacktest,
  buildTape,
  findEntry,
  signalStrength,
  stopLevel,
};
