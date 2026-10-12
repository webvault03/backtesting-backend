/**
 * Opening OI Trail 10/20 — historical backtest engine.
 *
 *   Watch 09:15–09:44. At 09:45 pick the strike within ±150 pts of spot with the largest
 *   |ΔOI put| + |ΔOI call| over that window; net flow ΔOI put − ΔOI call ≥ 0 → buy CE, else PE.
 *   Entry at the close of the 09:45 option bar (premium must be > minPremium).
 *   Trail on the option: +10 → lock +2, +20 → lock +10, then peak − 10 in whole points.
 *   NIFTY SL: lower low (CE) / higher high (PE) of the 09:40 and 09:45 5-min candles, armed from 09:50;
 *   exit at the option close of the minute NIFTY trades beyond it. Otherwise close at 15:25.
 */
const { ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');

const LOT_SIZE = 65;
const STEP = 50;
const CHARGES = 100;
const OPEN = 9 * 60 + 15;
const WATCH_END = 9 * 60 + 44;
const ENTRY = 9 * 60 + 45;
const SL_ARMED = 9 * 60 + 50;
const EOD = 15 * 60 + 25;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = { strikeWindow: 150, minPremium: 5, slippage: 0 };

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i], oi: series.oi?.[i] }));
  return out;
}

/** OI of the first bar at/after `from` and the last bar at/before `to` (inside the window). */
function oiChange(book, from, to) {
  let first = null;
  let last = null;
  for (let m = from; m <= to; m += 1) {
    const oi = book.get(m)?.oi;
    if (!Number.isFinite(oi)) continue;
    if (first == null) first = oi;
    last = oi;
  }
  return first == null ? null : last - first;
}

function candle(nifty, start) {
  let h = -Infinity;
  let l = Infinity;
  for (let m = start; m < start + 5; m += 1) {
    const b = nifty.get(m);
    if (b) {
      h = Math.max(h, b.h);
      l = Math.min(l, b.l);
    }
  }
  return Number.isFinite(h) ? { time: hhmm(start), h: r2(h), l: r2(l) } : null;
}

/** Trail lock (points above entry) for a given max gain, or null when not armed. */
function trailLock(gain) {
  if (gain >= 20) return Math.max(10, Math.floor(gain) - 10);
  if (gain >= 10) return 2;
  return null;
}

function runDay({ dateKey, day, rule, qty }) {
  const nifty = minuteMap(day.nifty);
  const spotBar = nifty.get(WATCH_END);
  if (!spotBar) return { skipped: 'no NIFTY bar at 09:44' };
  const spot = spotBar.c;

  let pick = null;
  const lo = Math.ceil((spot - rule.strikeWindow) / STEP) * STEP;
  for (let strike = lo; strike <= spot + rule.strikeWindow; strike += STEP) {
    const dPut = oiChange(minuteMap(day.PE?.[String(strike)]), OPEN, WATCH_END);
    const dCall = oiChange(minuteMap(day.CE?.[String(strike)]), OPEN, WATCH_END);
    if (dPut == null || dCall == null) continue;
    const total = Math.abs(dPut) + Math.abs(dCall);
    if (!pick || total > pick.total) pick = { strike, dPut, dCall, total };
  }
  if (!pick) return { skipped: 'no OI data near spot for 09:15–09:44' };

  const netFlow = pick.dPut - pick.dCall;
  const side = netFlow >= 0 ? 'CE' : 'PE';
  const book = minuteMap(day[side]?.[String(pick.strike)]);
  const entryBar = book.get(ENTRY);
  if (!entryBar) return { skipped: `no ${pick.strike} ${side} bar at 09:45` };
  const entryPremium = r2(entryBar.c + rule.slippage);
  if (!(entryPremium > rule.minPremium)) return { skipped: `premium ${entryPremium} ≤ ${rule.minPremium}` };
  const entrySpot = nifty.get(ENTRY)?.c ?? spot;

  const prevCandle = candle(nifty, ENTRY - 5);
  const entryCandle = candle(nifty, ENTRY);
  if (!prevCandle || !entryCandle) return { skipped: 'missing NIFTY 5-min candles' };
  const isCE = side === 'CE';
  const usePrev = isCE ? prevCandle.l < entryCandle.l : prevCandle.h > entryCandle.h;
  const slLevel = isCE ? Math.min(prevCandle.l, entryCandle.l) : Math.max(prevCandle.h, entryCandle.h);

  let peak = entryPremium;
  let lock = null;
  let maxDip = 0;
  let last = entryBar.c;
  let exit = null;
  let sameBar = false;
  for (let m = ENTRY + 1; m <= EOD && !exit; m += 1) {
    const o = book.get(m);
    const n = nifty.get(m);
    if (m === EOD) {
      exit = { type: 'EOD', min: m, premium: o ? o.o : last };
      break;
    }
    if (!o) continue;
    const trailExit = lock != null && o.l <= entryPremium + lock ? Math.min(o.o, entryPremium + lock) : null;
    const slHit = m >= SL_ARMED && n && (isCE ? n.l < slLevel : n.h > slLevel);
    if (trailExit != null && slHit) {
      sameBar = true;
      exit = o.c < trailExit ? { type: 'SL', min: m, premium: o.c } : { type: 'TRAIL', min: m, premium: trailExit };
    } else if (trailExit != null) {
      exit = { type: 'TRAIL', min: m, premium: trailExit };
    } else if (slHit) {
      exit = { type: 'SL', min: m, premium: o.c };
    } else {
      peak = Math.max(peak, o.h);
      maxDip = Math.max(maxDip, entryPremium - o.l);
      const next = trailLock(peak - entryPremium);
      if (next != null && (lock == null || next > lock)) lock = next;
      last = o.c;
    }
  }
  if (!exit) exit = { type: 'EOD', min: EOD, premium: last };

  const exitPremium = r2(exit.premium - rule.slippage);
  const points = r2(exitPremium - entryPremium);
  const grossPnL = r2(points * qty);
  const netPnL = r2(grossPnL - CHARGES);
  const reason = {
    TRAIL: `TRAIL +${r2(exitPremium - entryPremium)} @ ${hhmm(exit.min)}`,
    SL: `NIFTY SL @ ${hhmm(exit.min)}`,
    EOD: '15:25 CLOSE',
  }[exit.type];
  const month = Number(dateKey.slice(5, 7));
  return {
    trade: {
      id: `${dateKey}-${side}-${pick.strike}`,
      date: dateKey,
      monthKey: dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      side,
      strike: pick.strike,
      dOiPut: pick.dPut,
      dOiCall: pick.dCall,
      netFlow,
      entryTime: hhmm(ENTRY),
      entryPremium,
      entrySpot: r2(entrySpot),
      prevCandle,
      entryCandle,
      slSource: usePrev ? 'PREV' : 'ENTRY',
      slLevel: r2(slLevel),
      slRiskPts: r2(Math.abs(entrySpot - slLevel)),
      trailStop: lock != null ? r2(entryPremium + lock) : null,
      peakHigh: r2(peak),
      maxGainPts: r2(peak - entryPremium),
      maxDipPts: r2(maxDip),
      exitTime: hhmm(exit.min),
      exitPremium,
      exitReason: reason,
      exitType: exit.type,
      sameBarTrailAndSl: sameBar,
      points,
      grossPnL,
      netPnL,
      isWin: netPnL > 0,
    },
  };
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (!months[t.monthKey]) months[t.monthKey] = { key: t.monthKey, label: `${t.monthShort} ${t.monthKey.slice(2, 4)}`, trades: 0, wins: 0, pnl: 0 };
    const m = months[t.monthKey];
    m.trades += 1;
    if (t.isWin) m.wins += 1;
    m.pnl = r2(m.pnl + t.netPnL);
  }
  const wins = trades.filter((t) => t.isWin).length;
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * LOT_SIZE;
  const live = await ensureDays(from, to, { onProgress });
  const days = await loadDays(from, to, live);

  const trades = [];
  const skippedDays = [];
  days.forEach((day, i) => {
    onProgress?.({ phase: 'simulate', done: i, total: days.length, dateKey: day.dateKey });
    const r = runDay({ dateKey: day.dateKey, day, rule, qty });
    if (r.trade) trades.push(r.trade);
    else skippedDays.push({ dateKey: day.dateKey, reason: r.skipped });
  });

  return { from, to, lots, qty, rule: { ...rule, charges: CHARGES }, tradingDays: days.length, skippedDays, summary: summarize(trades), trades };
}

module.exports = { runBacktest, DEFAULT_RULE };
