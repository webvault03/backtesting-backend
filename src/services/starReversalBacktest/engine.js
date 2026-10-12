/**
 * Evening star / Morning star (NIFTY 5-min) — historical backtest.
 *
 *   Pattern on three completed 5-min candles of the same day:
 *     Evening star: 1) tall white body, 2) small body (star) at / above candle 1's close,
 *                   3) black candle closing below the given % of candle 1's body → BUY ATM PE.
 *     Morning star: mirror (tall black, small star at / below, white closing back into it) → BUY ATM CE.
 *     "Tall" = body ≥ tallFactor × average body of the earlier candles that day; a star whose body is
 *     ≤ 10% of its range is reported as a doji star.
 *   Entry: open of the first 1-min bar after candle 3 (nearest weekly expiry, strike = spot rounded to 50).
 *   Stop: NIFTY trades beyond the pattern high (evening) / low (morning) → exit at that minute's option close.
 *   Trail on the option: +10 → lock +2, +20 → lock +10, then peak − 10. Otherwise close at 15:25.
 *   One position at a time; scanning resumes after the exit.
 */
const { ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');

const STEP = 50;
const OPEN = 9 * 60 + 15;
const EOD = 15 * 60 + 25;
const CANDLE = 5;
const MIN_PRIOR_CANDLES = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  lotSize: 65,
  charges: 100,
  tallFactor: 1.5,
  starMaxPct: 30,
  penetrationPct: 50,
  lastEntryMin: 14 * 60 + 45,
  maxTradesPerDay: 2,
  minPremium: 5,
  slippage: 0,
};

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
  for (let start = OPEN; start < EOD + CANDLE; start += CANDLE) {
    let c = null;
    for (let m = start; m < start + CANDLE; m += 1) {
      const b = nifty.get(m);
      if (!b) continue;
      if (!c) c = { start, o: b.o, h: b.h, l: b.l, c: b.c };
      else {
        c.h = Math.max(c.h, b.h);
        c.l = Math.min(c.l, b.l);
        c.c = b.c;
      }
    }
    if (c) candles.push(c);
  }
  return candles;
}

const body = (c) => Math.abs(c.c - c.o);

/** Pattern ending at candles[i], or null. */
function detect(candles, i, rule) {
  if (i < 2 + MIN_PRIOR_CANDLES) return null;
  const [c1, c2, c3] = [candles[i - 2], candles[i - 1], candles[i]];
  const prior = candles.slice(0, i - 2);
  const avgBody = prior.reduce((a, c) => a + body(c), 0) / prior.length;
  const b1 = body(c1);
  if (!(b1 > 0) || b1 < rule.tallFactor * avgBody) return null;
  if (body(c2) > (rule.starMaxPct / 100) * b1) return null;
  const doji = body(c2) <= 0.1 * Math.max(c2.h - c2.l, 0.05);
  const depth = (rule.penetrationPct / 100) * b1;

  if (c1.c > c1.o && Math.min(c2.o, c2.c) >= c1.c && c3.c < c3.o && c3.c <= c1.c - depth) {
    return { kind: 'EVENING', side: 'PE', doji, stop: Math.max(c1.h, c2.h, c3.h), c1, c2, c3, avgBody };
  }
  if (c1.c < c1.o && Math.max(c2.o, c2.c) <= c1.c && c3.c > c3.o && c3.c >= c1.c + depth) {
    return { kind: 'MORNING', side: 'CE', doji, stop: Math.min(c1.l, c2.l, c3.l), c1, c2, c3, avgBody };
  }
  return null;
}

function trailLock(gain) {
  if (gain >= 20) return Math.max(10, Math.floor(gain) - 10);
  if (gain >= 10) return 2;
  return null;
}

const candleView = (c) => ({ time: hhmm(c.start), o: r2(c.o), h: r2(c.h), l: r2(c.l), c: r2(c.c) });

function simulate({ day, nifty, pattern, entryMin, rule, qty }) {
  const spotBar = nifty.get(entryMin);
  if (!spotBar) return { skipped: `no NIFTY bar at ${hhmm(entryMin)}` };
  const strike = Math.round(spotBar.o / STEP) * STEP;
  const book = minuteMap(day[pattern.side]?.[String(strike)]);
  const entryBar = book.get(entryMin);
  if (!entryBar) return { skipped: `no ${strike} ${pattern.side} bar at ${hhmm(entryMin)}` };
  const entryPremium = r2(entryBar.o + rule.slippage);
  if (!(entryPremium > rule.minPremium)) return { skipped: `premium ${entryPremium} ≤ ${rule.minPremium}` };

  const isEvening = pattern.kind === 'EVENING';
  let peak = entryPremium;
  let lock = null;
  let last = entryBar.c;
  let exit = null;
  for (let m = entryMin; m <= EOD && !exit; m += 1) {
    const o = book.get(m);
    const n = nifty.get(m);
    if (m === EOD) {
      exit = { type: 'EOD', min: m, premium: o ? o.o : last };
      break;
    }
    if (!o) continue;
    const trailExit = lock != null && o.l <= entryPremium + lock ? Math.min(o.o, entryPremium + lock) : null;
    const slHit = n && (isEvening ? n.h > pattern.stop : n.l < pattern.stop);
    if (trailExit != null && slHit) {
      exit = o.c < trailExit ? { type: 'SL', min: m, premium: o.c } : { type: 'TRAIL', min: m, premium: trailExit };
    } else if (trailExit != null) {
      exit = { type: 'TRAIL', min: m, premium: trailExit };
    } else if (slHit) {
      exit = { type: 'SL', min: m, premium: o.c };
    } else {
      peak = Math.max(peak, o.h);
      const next = trailLock(peak - entryPremium);
      if (next != null && (lock == null || next > lock)) lock = next;
      last = o.c;
    }
  }
  if (!exit) exit = { type: 'EOD', min: EOD, premium: last };

  const exitPremium = r2(exit.premium - rule.slippage);
  const points = r2(exitPremium - entryPremium);
  const grossPnL = r2(points * qty);
  const netPnL = r2(grossPnL - rule.charges);
  const month = Number(day.dateKey.slice(5, 7));
  return {
    exitMin: exit.min,
    trade: {
      id: `${day.dateKey}-${hhmm(entryMin)}-${pattern.side}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      pattern: pattern.kind,
      doji: pattern.doji,
      candles: [candleView(pattern.c1), candleView(pattern.c2), candleView(pattern.c3)],
      side: pattern.side,
      strike,
      entryTime: hhmm(entryMin),
      entrySpot: r2(spotBar.o),
      entryPremium,
      slLevel: r2(pattern.stop),
      slRiskPts: r2(Math.abs(spotBar.o - pattern.stop)),
      peakHigh: r2(peak),
      maxGainPts: r2(peak - entryPremium),
      trailStop: lock != null ? r2(entryPremium + lock) : null,
      exitTime: hhmm(exit.min),
      exitPremium,
      exitType: exit.type,
      exitReason: { TRAIL: `TRAIL @ ${hhmm(exit.min)}`, SL: `NIFTY SL @ ${hhmm(exit.min)}`, EOD: '15:25 CLOSE' }[exit.type],
      points,
      grossPnL,
      netPnL,
      isWin: netPnL > 0,
    },
  };
}

function runDay(day, rule, qty) {
  const nifty = minuteMap(day.nifty);
  const candles = fiveMinCandles(nifty);
  const trades = [];
  const skipped = [];
  let freeFrom = OPEN;
  for (let i = 0; i < candles.length && trades.length < rule.maxTradesPerDay; i += 1) {
    const entryMin = candles[i].start + CANDLE;
    if (entryMin > rule.lastEntryMin) break;
    if (entryMin <= freeFrom) continue;
    const pattern = detect(candles, i, rule);
    if (!pattern) continue;
    const r = simulate({ day, nifty, pattern, entryMin, rule, qty });
    if (r.trade) {
      trades.push(r.trade);
      freeFrom = r.exitMin;
    } else {
      skipped.push({ dateKey: day.dateKey, reason: `${pattern.kind.toLowerCase()} star ${hhmm(entryMin)}: ${r.skipped}` });
    }
  }
  return { trades, skipped };
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
  const bySide = (kind) => {
    const list = trades.filter((t) => t.pattern === kind);
    return { trades: list.length, wins: list.filter((t) => t.isWin).length, pnl: r2(list.reduce((a, t) => a + t.netPnL, 0)) };
  };
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    evening: bySide('EVENING'),
    morning: bySide('MORNING'),
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function }} opts
 */
async function runBacktest({ from, to, lots = 1, rule: ruleIn = {}, onProgress } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * rule.lotSize;
  const live = await ensureDays(from, to, { onProgress });
  const days = await loadDays(from, to, live);

  const trades = [];
  const skippedDays = [];
  days.forEach((day, i) => {
    onProgress?.({ phase: 'simulate', done: i, total: days.length, dateKey: day.dateKey });
    const r = runDay(day, rule, qty);
    trades.push(...r.trades);
    skippedDays.push(...r.skipped);
  });

  return { from, to, lots, qty, rule, tradingDays: days.length, skippedDays, summary: summarize(trades), trades };
}

module.exports = { runBacktest, DEFAULT_RULE };
