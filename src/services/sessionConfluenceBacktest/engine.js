/**
 * Session Confluence — historical backtest.
 *
 * Inspiration (not a clone): Open OI Walls map + OI+Candle Agree flow + Strike Flow daily gates.
 *
 * Layer A — Map (09:15–09:20): put/call ΔOI walls vs prior close. Trade only when one side is
 *   clearly +ΔOI and the other −ΔOI. Map side: +Put wall → CE, +Call wall → PE.
 * Layer B — Flow: closed 15m REAL AGREE must match the map side (Writing|Buying → PE,
 *   Short cover|Writing → CE). First matching AGREE in 09:45–13:00; optional 2nd only if stronger.
 * Layer C — Risk: NIFTY SL at signal candle (optional point cap), shared profit trail after +20,
 *   unarmed time-stop (default 60m), 15:15. Day stop / day target halt further entries.
 */
const { findLatestAgreeSignal, niftyAtmStrike } = require('../../utils/oiCandleAgreeSignal');
const { computeTrailLockPoints } = require('../../utils/openOiWallsTrail');
const { addDays, ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');
const {
  buildTape,
  signalStrength,
  stopLevel,
} = require('../oiCandleAgreeBacktest/engine');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { niftyLotSizeOn } = require('../../utils/niftyLotSize');

const HISTORY_START = '2020-08-03';
const WARMUP_DAYS = 7;

const SESSION_OPEN = 9 * 60 + 15;
const MAP_FROM = 9 * 60 + 15;
const MAP_TO = 9 * 60 + 20;
const TRADE_FROM = 9 * 60 + 45;
const TRADE_TO = 13 * 60;
const EOD = 15 * 60 + 15;
const STEP = 50;
const CHARGES = 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  mode: 'candle',
  capPoints: 40,
  fixedPoints: 30,
  maxTrades: 2,
  unarmedMin: 60,
  /** Day halt once net P&L ≤ −dayStopPts × qty (option points). 0 = off. */
  dayStopPts: 25,
  /** Day halt once net P&L ≥ +dayTargetPts × qty. 0 = off. */
  dayTargetPts: 30,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const tick = (n) => Math.round(n * 20) / 20;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

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

function lastOiBefore(byMin, minute) {
  for (let m = minute; m >= SESSION_OPEN; m -= 1) {
    const v = byMin?.get(m)?.oi;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** Top |ΔOI| put / call walls around spot at `minute`, vs previous session close. */
function captureMap(day, prevDay, minute) {
  const spot = day.nifty.get(minute)?.c ?? day.nifty.get(minute)?.o;
  if (!Number.isFinite(spot)) return null;
  const atm = Math.round(spot / STEP) * STEP;
  let put = null;
  let call = null;
  for (let k = -6; k <= 6; k += 1) {
    const strike = atm + k * STEP;
    const callOi = lastOiBefore(day.opt.CE.get(strike), minute);
    const putOi = lastOiBefore(day.opt.PE.get(strike), minute);
    const prevCall = prevDay ? lastOiBefore(prevDay.opt.CE.get(strike), 15 * 60 + 29) : null;
    const prevPut = prevDay ? lastOiBefore(prevDay.opt.PE.get(strike), 15 * 60 + 29) : null;
    const callChg = Number.isFinite(callOi) && Number.isFinite(prevCall) ? callOi - prevCall : null;
    const putChg = Number.isFinite(putOi) && Number.isFinite(prevPut) ? putOi - prevPut : null;
    if (Number.isFinite(putChg) && (!put || Math.abs(putChg) > Math.abs(put.oi))) {
      put = { strike, oi: putChg, side: 'PUT', optionType: 'CE' };
    }
    if (Number.isFinite(callChg) && (!call || Math.abs(callChg) > Math.abs(call.oi))) {
      call = { strike, oi: callChg, side: 'CALL', optionType: 'PE' };
    }
  }
  if (!put || !call) return { ok: false, reason: 'missing_wall', spot: r2(spot), put, call, captureMin: minute };
  // Strict +/− map: one writer wall building, the other shedding — else no bias.
  if (!(put.oi > 0 && call.oi < 0) && !(call.oi > 0 && put.oi < 0)) {
    return { ok: false, reason: 'no_plus_minus', spot: r2(spot), put, call, captureMin: minute };
  }
  const mapSide = put.oi > 0 && call.oi < 0 ? 'CE' : 'PE';
  const wall = mapSide === 'CE' ? put : call;
  return {
    ok: true,
    mapSide,
    spot: r2(spot),
    put,
    call,
    wall,
    captureMin: minute,
  };
}

function findMap(day, prevDay) {
  for (let m = MAP_FROM; m <= MAP_TO; m += 1) {
    const map = captureMap(day, prevDay, m);
    if (map?.ok) return map;
    if (map && m === MAP_TO) return map;
  }
  return { ok: false, reason: 'no_spot' };
}

/**
 * Fresh AGREE bar matching `mapSide`, inside confluence window.
 */
function findConfluenceEntry(rows, mapSide, { afterMin = TRADE_FROM, afterBarEnd = -Infinity } = {}) {
  const start = Math.max(TRADE_FROM, afterMin);
  for (let now = start; now <= TRADE_TO + 16; now += 1) {
    const visible = rows.filter((r) => Number(r.minutes) <= now);
    const res = findLatestAgreeSignal(visible, now);
    if (!res.ok) continue;
    if (res.optionType !== mapSide) continue;
    const barEnd = Number(res.bar?.endMin);
    if (!Number.isFinite(barEnd) || barEnd <= afterBarEnd) continue;
    if (barEnd < TRADE_FROM || barEnd > TRADE_TO || now - barEnd > 16) continue;
    return { now, res };
  }
  return null;
}

function crossFraction(from, extreme, level) {
  const span = extreme - from;
  if (!Number.isFinite(span) || span === 0) return 0;
  return Math.min(1, Math.max(0, (level - from) / span));
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

/** Minute walk: Nifty SL → trail → unarmed time-stop → 15:15. */
function simulate({ day, optionType, strike, entryMin, entryPremium, entrySpot, sl, unarmedMin }) {
  const isPE = optionType === 'PE';
  const book = day.opt[optionType].get(strike);
  let peak = entryPremium;
  let lock = null;
  let lastClose = entryPremium;
  let lastSpot = entrySpot;
  const unarmedCut = Number.isFinite(unarmedMin) && unarmedMin > 0 ? entryMin + unarmedMin : null;

  for (let m = entryMin; m <= EOD; m += 1) {
    const n = day.nifty.get(m);
    const o = book?.get(m);
    if (m === EOD) {
      return {
        exitType: 'EOD',
        exitMin: m,
        exitSec: 0,
        exitPremium: o ? o.o : lastClose,
        exitSpot: n ? n.o : lastSpot,
        peak,
        lock,
      };
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
        return {
          exitType: 'SL',
          exitMin: m,
          exitSec: Math.round(frac * 59),
          exitPremium,
          exitSpot: already ? startSpot : sl,
          peak,
          lock,
        };
      }
    }

    if (lock != null && o.l <= lock) {
      const gapped = startPrem <= lock;
      return {
        exitType: 'TRAIL',
        exitMin: m,
        exitSec: 0,
        exitPremium: gapped ? startPrem : lock,
        exitSpot: gapped ? startSpot : n.c,
        peak,
        lock,
      };
    }

    peak = Math.max(peak, o.h);
    const lockPts = computeTrailLockPoints(peak - entryPremium);
    if (lockPts != null) lock = r2(entryPremium + lockPts);

    if (unarmedCut != null && m >= unarmedCut && lock == null) {
      return {
        exitType: 'TIME',
        exitMin: m,
        exitSec: 0,
        exitPremium: o.c,
        exitSpot: n.c,
        peak,
        lock,
      };
    }

    lastClose = o.c;
    lastSpot = n.c;
  }
  return null;
}

function runDay(day, prevDay, rows, rule, lots) {
  const lotSize = niftyLotSizeOn(day.dateKey);
  const qty = lots * lotSize;
  const maxTrades = Math.max(1, Math.round(rule.maxTrades || 2));
  const month = Number(day.dateKey.slice(5, 7));
  const map = findMap(day, prevDay);
  if (!map.ok) {
    return {
      dateKey: day.dateKey,
      trades: [],
      skipped: map.reason === 'no_plus_minus' ? 'Map: no +/− wall bias' : `Map: ${map.reason || 'no bias'}`,
      map,
    };
  }

  const trades = [];
  let searchFrom = TRADE_FROM;
  let afterBarEnd = -Infinity;
  let lastStrength = -Infinity;
  let dayPnl = 0;
  const dayStopRs = (Number(rule.dayStopPts) || 0) > 0 ? Number(rule.dayStopPts) * qty : null;
  const dayTargetRs = (Number(rule.dayTargetPts) || 0) > 0 ? Number(rule.dayTargetPts) * qty : null;
  let dayHalt = null;

  while (trades.length < maxTrades) {
    if (dayHalt) break;
    if (dayStopRs != null && dayPnl <= -dayStopRs) {
      dayHalt = 'DAY_STOP';
      break;
    }
    if (dayTargetRs != null && dayPnl >= dayTargetRs) {
      dayHalt = 'DAY_TARGET';
      break;
    }

    const entry = findConfluenceEntry(rows, map.mapSide, { afterMin: searchFrom, afterBarEnd });
    if (!entry) break;
    const { now: entryMin, res } = entry;
    const barEnd = Number(res.bar.endMin);
    const strength = signalStrength(res);

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
      afterBarEnd = barEnd;
      searchFrom = Math.max(searchFrom, entryMin + 1);
      continue;
    }

    const entryPremium = entryCandle.o;
    const candle = signalCandle(day, res.bar);
    const sl = stopLevel(rule, { isPE, entrySpot, candle });
    const sim = simulate({
      day,
      optionType,
      strike,
      entryMin,
      entryPremium,
      entrySpot,
      sl,
      unarmedMin: Number(rule.unarmedMin) || 0,
    });
    if (!sim) break;

    const points = r2(sim.exitPremium - entryPremium);
    const netPnL = r2(points * qty - CHARGES);
    const reasonText = {
      SL: `Nifty SL ${sl} crossed`,
      TRAIL: `Trail lock +${r2(sim.exitPremium - entryPremium)}`,
      TIME: `Unarmed ${rule.unarmedMin}m exit`,
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
      mapSide: map.mapSide,
      mapWallStrike: map.wall?.strike ?? null,
      mapPutOi: map.put?.oi ?? null,
      mapCallOi: map.call?.oi ?? null,
      mapCapture: hhmm(map.captureMin),
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

    dayPnl = r2(dayPnl + netPnL);
    lastStrength = strength;
    afterBarEnd = barEnd;
    searchFrom = Math.max(sim.exitMin + 1, barEnd + 1);
    if (sim.exitType === 'EOD' || sim.exitMin >= EOD) break;
  }

  return {
    dateKey: day.dateKey,
    trades,
    map,
    dayHalt,
    dayPnl,
    ...(trades.length === 0
      ? { skipped: `Map ${map.mapSide} ok · no matching AGREE ${hhmm(TRADE_FROM)}–${hhmm(TRADE_TO)}` }
      : {}),
  };
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
    if (!months[t.monthKey]) {
      months[t.monthKey] = {
        key: t.monthKey,
        label: `${t.monthShort} ${t.monthKey.slice(2, 4)}`,
        trades: 0,
        wins: 0,
        pnl: 0,
      };
    }
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
  const byExit = { TRAIL: 0, SL: 0, TIME: 0, EOD: 0 };
  for (const t of trades) {
    if (byExit[t.exitType] != null) byExit[t.exitType] += 1;
  }
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
    exitBreakdown: byExit,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
    years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

/**
 * @param {{ from: string, to: string, rule?: object, lots?: number, onProgress?: Function, onPartial?: Function }} opts
 */
async function runBacktest({
  from,
  to,
  rule = {},
  lots = 10,
  onProgress,
  onPartial,
} = {}) {
  const lotCount = Math.max(1, Math.round(lots));
  const dayRule = { ...DEFAULT_RULE, ...rule };
  const results = [];

  const build = (doneThrough) => {
    const trades = results.flatMap((r) => r.trades || []);
    return {
      from,
      to,
      rule: {
        ...dayRule,
        mapFrom: hhmm(MAP_FROM),
        mapTo: hhmm(MAP_TO),
        entryFrom: hhmm(TRADE_FROM),
        entryTo: hhmm(TRADE_TO),
        eod: hhmm(EOD),
        charges: CHARGES,
        maxTrades: Math.max(1, Math.round(dayRule.maxTrades || 2)),
      },
      lots: lotCount,
      qty: lotCount * niftyLotSizeOn(to),
      tradingDays: results.length,
      mapSkipDays: results.filter((r) => r.skipped && String(r.skipped).startsWith('Map:')).map((r) => ({
        dateKey: r.dateKey,
        reason: r.skipped,
      })),
      noSignalDays: results
        .filter((r) => r.skipped && String(r.skipped).includes('no matching AGREE'))
        .map((r) => r.dateKey),
      skippedDays: results.filter((r) => r.skipped).map((r) => ({ dateKey: r.dateKey, reason: r.skipped })),
      dayHaltDays: results.filter((r) => r.dayHalt).map((r) => ({ dateKey: r.dateKey, halt: r.dayHalt, dayPnl: r.dayPnl })),
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
      const prev = days[i - 1] || null;
      const rows = buildTape(day, prev);
      results.push(runDay(day, prev, rows, dayRule, lotCount));
    }
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = {
  HISTORY_START,
  DEFAULT_RULE,
  runBacktest,
};
