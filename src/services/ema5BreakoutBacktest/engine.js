/**
 * 5 EMA Candle Breakout — historical backtest engine.
 *
 *   NIFTY 5-min candles, EMA 5 of closes carried across sessions (seeded with a 5-candle SMA).
 *   CE setup: candle open < EMA, close < EMA, high < EMA → next candle trades above its high → buy ATM CE.
 *   PE setup: mirror (fully above the EMA, next candle breaks its low) → buy ATM PE.
 *   Option exit: SL entry − slPoints; once up +trailAfter the stop trails peak − trailGap (updated at the
 *   end of each minute, applied from the next). One position at a time, last breakout candle 15:00, close 15:25.
 *   No new trades once the day's closed net P&L ≤ −dayStop.
 */
const { addDays, ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');

const LOT_SIZE = 65;
const STEP = 50;
const CHARGES = 100;
const OPEN = 9 * 60 + 15;
const LAST_ENTRY = 15 * 60;
const EOD = 15 * 60 + 25;
const EMA_LEN = 5;
const WARMUP_DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = { slPoints: 20, trailAfter: 10, trailGap: 5, dayStop: 7500, slippage: 0 };

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i] }));
  return out;
}

function fiveMinCandles(nifty) {
  const candles = [];
  for (let start = OPEN; start < 15 * 60 + 30; start += 5) {
    let o = null;
    let h = -Infinity;
    let l = Infinity;
    let c = null;
    for (let m = start; m < start + 5; m += 1) {
      const b = nifty.get(m);
      if (!b) continue;
      if (o == null) o = b.o;
      h = Math.max(h, b.h);
      l = Math.min(l, b.l);
      c = b.c;
    }
    if (o != null) candles.push({ start, o, h, l, c });
  }
  return candles;
}

/** EMA state carried candle by candle: `seed` collects the first closes for the SMA start. */
function nextEma(ema, seed, close) {
  if (ema != null) return ema + (2 / (EMA_LEN + 1)) * (close - ema);
  seed.push(close);
  return seed.length === EMA_LEN ? seed.reduce((a, b) => a + b, 0) / EMA_LEN : null;
}

/** Option price at the moment NIFTY touched `level`, read at the same position inside the minute's ranges. */
function premiumAtLevel(niftyBar, optBar, level, side) {
  const span = niftyBar.h - niftyBar.l;
  if (!(span > 0)) return optBar.o;
  const fromLow = (level - niftyBar.l) / span;
  const pos = side === 'CE' ? fromLow : 1 - fromLow;
  return optBar.l + Math.min(1, Math.max(0, pos)) * (optBar.h - optBar.l);
}

function runExit({ book, entryMin, entryPremium, rule }) {
  const initialSl = entryPremium - rule.slPoints;
  let stop = initialSl;
  let peak = entryPremium;
  let last = entryPremium;
  for (let m = entryMin + 1; m <= EOD; m += 1) {
    const o = book.get(m);
    if (m === EOD) return { type: 'EOD', min: m, premium: o ? o.o : last, peak };
    if (!o) continue;
    if (o.o <= stop) return { type: stop > initialSl ? 'TRAIL' : 'SL', min: m, premium: o.o, peak };
    if (o.l <= stop) return { type: stop > initialSl ? 'TRAIL' : 'SL', min: m, premium: stop, peak };
    peak = Math.max(peak, o.h);
    if (peak - entryPremium >= rule.trailAfter) stop = Math.max(stop, peak - rule.trailGap);
    last = o.c;
  }
  return { type: 'EOD', min: EOD, premium: last, peak };
}

function runDay({ dateKey, day, candles, emaBefore, seed, rule, qty }) {
  const nifty = minuteMap(day.nifty);
  let ema = emaBefore;
  const trades = [];
  let busyUntil = 0;
  let dayPnl = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const setup = candles[i];
    ema = nextEma(ema, seed, setup.c);
    const next = candles[i + 1];
    if (ema == null || !next || dayPnl <= -rule.dayStop) continue;
    let side = null;
    if (setup.o < ema && setup.c < ema && setup.h < ema) side = 'CE';
    else if (setup.o > ema && setup.c > ema && setup.l > ema) side = 'PE';
    if (!side) continue;

    const level = side === 'CE' ? setup.h : setup.l;
    let entryMin = null;
    let entrySpot = null;
    for (let m = next.start; m < next.start + 5; m += 1) {
      const b = nifty.get(m);
      if (!b) continue;
      if (side === 'CE' ? b.h > level : b.l < level) {
        entryMin = m;
        entrySpot = side === 'CE' ? Math.max(level, b.o) : Math.min(level, b.o);
        break;
      }
    }
    if (entryMin == null || entryMin <= busyUntil || next.start > LAST_ENTRY) continue;

    const strike = Math.round(entrySpot / STEP) * STEP;
    const book = minuteMap(day[side]?.[String(strike)]);
    const optBar = book.get(entryMin);
    if (!optBar) continue;
    const entryPremium = r2(premiumAtLevel(nifty.get(entryMin), optBar, entrySpot, side) + rule.slippage);
    const exit = runExit({ book, entryMin, entryPremium, rule });
    const exitPremium = r2(exit.premium - rule.slippage);
    const points = r2(exitPremium - entryPremium);
    const grossPnL = r2(points * qty);
    const netPnL = r2(grossPnL - CHARGES);
    dayPnl = r2(dayPnl + netPnL);
    busyUntil = exit.min;
    const exitSpot = nifty.get(exit.min)?.o ?? nifty.get(exit.min - 1)?.c ?? entrySpot;
    const month = Number(dateKey.slice(5, 7));
    trades.push({
      id: `${dateKey}-${hhmm(entryMin)}-${side}`,
      date: dateKey,
      monthKey: dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      side,
      setupTime: hhmm(setup.start),
      setupHigh: r2(setup.h),
      setupLow: r2(setup.l),
      emaAtSetup: r2(ema),
      range: r2(setup.h - setup.l),
      entryTime: hhmm(entryMin),
      entrySpot: r2(entrySpot),
      exitTime: hhmm(exit.min),
      exitSpot: r2(exitSpot),
      niftyPts: r2(side === 'CE' ? exitSpot - entrySpot : entrySpot - exitSpot),
      strike,
      entryPremium,
      slPremium: r2(entryPremium - rule.slPoints),
      peakPremium: r2(exit.peak),
      maxGainPts: r2(exit.peak - entryPremium),
      exitPremium,
      exitReason: { TRAIL: `TRAIL SL @ ${hhmm(exit.min)}`, SL: `OPTION SL @ ${hhmm(exit.min)}`, EOD: 'DAY CLOSE (15:25)' }[exit.type],
      exitType: exit.type,
      points,
      grossPnL,
      netPnL,
      dayPnLAfter: dayPnl,
      isWin: netPnL > 0,
    });
  }
  return { trades, emaAfter: ema };
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const days = {};
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    days[t.date] = (days[t.date] || 0) + t.netPnL;
    if (!months[t.monthKey]) months[t.monthKey] = { key: t.monthKey, label: `${t.monthShort} ${t.monthKey.slice(2, 4)}`, trades: 0, wins: 0, pnl: 0 };
    const m = months[t.monthKey];
    m.trades += 1;
    if (t.isWin) m.wins += 1;
    m.pnl = r2(m.pnl + t.netPnL);
  }
  const wins = trades.filter((t) => t.isWin).length;
  const dayValues = Object.values(days);
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    worstDay: dayValues.length ? r2(Math.min(...dayValues)) : 0,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * LOT_SIZE;
  const fetchFrom = addDays(from, -WARMUP_DAYS);
  const live = await ensureDays(fetchFrom, to, { onProgress });
  const days = await loadDays(fetchFrom, to, live);

  let ema = null;
  const seed = [];
  const trades = [];
  const total = days.filter((d) => d.dateKey >= from).length;
  let done = 0;
  for (const day of days) {
    const candles = fiveMinCandles(minuteMap(day.nifty));
    if (day.dateKey < from) {
      for (const c of candles) ema = nextEma(ema, seed, c.c);
      continue;
    }
    onProgress?.({ phase: 'simulate', done, total, dateKey: day.dateKey });
    done += 1;
    const res = runDay({ dateKey: day.dateKey, day, candles, emaBefore: ema, seed, rule, qty });
    ema = res.emaAfter;
    trades.push(...res.trades);
  }

  return {
    from,
    to,
    lots,
    qty,
    rule: { ...rule, dayStop: Number.isFinite(rule.dayStop) ? rule.dayStop : 0, charges: CHARGES },
    tradingDays: total,
    summary: summarize(trades),
    trades,
  };
}

module.exports = { runBacktest, DEFAULT_RULE };
