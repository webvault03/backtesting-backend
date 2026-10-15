/**
 * Price Action Scalp (ORB · VWAP · EMA 20/35) — historical backtest buying the ATM NIFTY option.
 *
 * Signals on closed NIFTY 5-min candles. CE setup → buy ATM CE, PE setup → buy ATM PE (strike = signal candle
 * close rounded to 50, nearest weekly). SL / breakeven / T1 / T2 / runner lock are option-premium points, replayed on
 * the option's 1-min bars. P&L = premium points × qty, flat tax per round trip.
 *
 * Day setup: ORB = first 6 candles (09:15–09:45). VWAP = Σ(typical × vol) / Σ vol with vol || 100000 (index
 *   volume is 0 in history). EMA 20 / EMA 35 on the day's closes up to candle i (seeded with the day's first close).
 *   Bullish trend: close ≥ VWAP and EMA20 ≥ EMA35 · bearish: close ≤ VWAP and EMA20 ≤ EMA35.
 * Setups (closed candle i, no open trade): CE — Spring, Hammer @ EMA20, Bullish engulfing @ VWAP, Volume breakout ·
 *   PE — Upthrust, Shooting star @ EMA20, Bearish engulfing @ VWAP, Volume breakdown. Long wins a tie.
 * Entry at the option's close of the signal candle's last minute (09:50 … 14:45 closes only). Management starts on
 *   the next 1-min bar: SL −6.5 · at +5 SL → entry +2 · T1 +8.5 on 70% then runner SL → entry +4 · T2 +16 on 30% ·
 *   time stop: T1 not hit after 8 bars (40 min) → exit at the 8th bar's close · 15:15 square-off.
 *   Inside one 1-min bar the stop is checked first; stop moves made in a bar apply from the next bar.
 *   A bar that opens beyond a level fills at its open (gap), otherwise at the level.
 * Day limits (net after tax): ≥ +10,000 or ≤ −6,500 halts the day · max 6 trades · 10 min cooldown after an exit.
 */
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { getIstClock } = require('../../utils/dateTime');
const { ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');

const HISTORY_START = '2020-08-03';
const STEP = 50;
const OPEN = 9 * 60 + 15;
const LAST = 15 * 60 + 29;
const TF = 5;
const ORB_CANDLES = 6;
const FALLBACK_VOL = 100000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  lotSize: 65,
  scalpShare: 0.7,
  t1Pts: 8.5,
  t2Pts: 16,
  slPts: 6.5,
  beTriggerPts: 5,
  beLockPts: 2,
  runnerLockPts: 4,
  timeStopBars: 8,
  /** Entry minute (= signal candle close) must be in [entryFrom, entryTo]. */
  entryFrom: 9 * 60 + 45,
  entryTo: 14 * 60 + 45,
  eod: 15 * 60 + 15,
  profitLock: 10000,
  maxLoss: 6500,
  maxTrades: 6,
  cooldownBars: 2,
  taxPerTrade: 100,
};

const SETUP_LABEL = {
  SPRING: 'Wyckoff Spring (ORB low reversal)',
  HAMMER: 'Hammer @ EMA 20 pullback',
  BULL_ENGULF: 'Bullish engulfing @ VWAP',
  VOL_BREAKOUT: 'Volume breakout',
  UPTHRUST: 'Wyckoff Upthrust (ORB high reversal)',
  SHOOTING_STAR: 'Shooting star @ EMA 20 pullback',
  BEAR_ENGULF: 'Bearish engulfing @ VWAP',
  VOL_BREAKDOWN: 'Volume breakdown',
};

const EXIT_REASON = {
  T2: 'T2 hit (runner)',
  LOCK: 'T1 + runner stopped at entry +4',
  BE: 'Breakeven stop (entry +2)',
  SL: 'Stop loss −6.5',
  TIME: 'Time stop (8 bars)',
  EOD: '15:15 square-off',
  OPEN: 'Still open (marked)',
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const span = (c) => `${hhmm(c.start)}–${hhmm(c.end + 1)}`;
/** One day's NIFTY 5-min candles: { start, end, o, h, l, c, v }. */
function buildCandles(n) {
  const out = [];
  let cur = null;
  n.m.forEach((m, i) => {
    if (m < OPEN || m > LAST) return;
    const start = OPEN + Math.floor((m - OPEN) / TF) * TF;
    const v = n.v?.[i] || 0;
    if (!cur || cur.start !== start) {
      cur = { start, end: Math.min(start + TF - 1, LAST), o: n.o[i], h: n.h[i], l: n.l[i], c: n.c[i], v };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, n.h[i]);
      cur.l = Math.min(cur.l, n.l[i]);
      cur.c = n.c[i];
      cur.v += v;
    }
  });
  return out;
}

/** Adds vwap, ema20, ema35, avgVol5 (previous 5 candles) to each candle; returns ORB. */
function addIndicators(candles) {
  let pv = 0;
  let vol = 0;
  let ema20 = null;
  let ema35 = null;
  const k20 = 2 / 21;
  const k35 = 2 / 36;
  candles.forEach((c, i) => {
    const v = c.v || FALLBACK_VOL;
    pv += ((c.h + c.l + c.c) / 3) * v;
    vol += v;
    c.vwap = pv / vol;
    ema20 = ema20 === null ? c.c : c.c * k20 + ema20 * (1 - k20);
    ema35 = ema35 === null ? c.c : c.c * k35 + ema35 * (1 - k35);
    c.ema20 = ema20;
    c.ema35 = ema35;
    const prev = candles.slice(Math.max(0, i - 5), i);
    c.avgVol5 = prev.length ? prev.reduce((s, p) => s + (p.v || FALLBACK_VOL), 0) / prev.length : v;
  });
  const orb = candles.slice(0, ORB_CANDLES);
  return orb.length === ORB_CANDLES ? { high: Math.max(...orb.map((c) => c.h)), low: Math.min(...orb.map((c) => c.l)) } : null;
}

/** Setup that fires on candle i: { side, setup } or null. Long has priority. */
function detectSignal(candles, i, orb) {
  const c = candles[i];
  const p = candles[i - 1];
  if (!p) return null;
  const body = Math.abs(c.c - c.o);
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const upperWick = c.h - Math.max(c.o, c.c);
  const range = c.h - c.l;
  const vol = c.v || FALLBACK_VOL;
  const prevBody = Math.abs(p.c - p.o);
  const prevRed = p.c < p.o;
  const prevGreen = p.c > p.o;
  const bull = c.c >= c.vwap && c.ema20 >= c.ema35;
  const bear = c.c <= c.vwap && c.ema20 <= c.ema35;

  const longs = [
    ['SPRING', c.l < orb.low && c.c >= orb.low && lowerWick >= 1.4 * body && c.c < c.vwap + 5],
    ['HAMMER', bull && c.l <= c.ema20 + 5 && c.c >= c.ema20 - 3 && lowerWick >= 1.5 * body && prevRed && range >= 9 && range <= 30],
    ['BULL_ENGULF', bull && Math.abs(c.l - c.vwap) <= 8 && c.c > c.o && prevRed && c.c > p.o && c.o < p.c && body > prevBody * 1.2 && range >= 10],
    ['VOL_BREAKOUT', vol >= c.avgVol5 && bull && c.c > orb.high + 3 && c.o < c.c && lowerWick <= body && body >= 10],
  ];
  const shorts = [
    ['UPTHRUST', c.h > orb.high && c.c <= orb.high && upperWick >= 1.4 * body && c.c > c.vwap - 5],
    ['SHOOTING_STAR', bear && c.h >= c.ema20 - 5 && c.c <= c.ema20 + 3 && upperWick >= 1.5 * body && prevGreen && range >= 9 && range <= 30],
    ['BEAR_ENGULF', bear && Math.abs(c.h - c.vwap) <= 8 && c.c < c.o && prevGreen && c.c < p.o && c.o > p.c && body > prevBody * 1.2 && range >= 10],
    ['VOL_BREAKDOWN', vol >= c.avgVol5 && bear && c.c < orb.low - 3 && c.o > c.c && upperWick <= body && body >= 10],
  ];
  const long = longs.find(([, ok]) => ok);
  if (long) return { side: 'CE', setup: long[0] };
  const short = shorts.find(([, ok]) => ok);
  if (short) return { side: 'PE', setup: short[0] };
  return null;
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const years = {};
  const dayPnl = {};
  const exits = Object.fromEntries(Object.keys(EXIT_REASON).map((k) => [k, 0]));
  const setups = Object.fromEntries(Object.keys(SETUP_LABEL).map((k) => [k, { setup: k, label: SETUP_LABEL[k], trades: 0, wins: 0, pnl: 0 }]));
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    exits[t.exitType] += 1;
    dayPnl[t.date] = (dayPnl[t.date] || 0) + t.netPnL;
    const st = setups[t.setup];
    st.trades += 1;
    if (t.isWin) st.wins += 1;
    st.pnl = r2(st.pnl + t.netPnL);
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
  const days = Object.values(dayPnl);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    netPnL: r2(equity),
    points: r2(trades.reduce((s, t) => s + t.points, 0)),
    charges: r2(charges),
    avgCharges: trades.length ? r2(charges / trades.length) : 0,
    maxDrawdown: r2(maxDd),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    worstTrade: trades.length ? r2(Math.min(...trades.map((t) => t.netPnL))) : 0,
    bestTrade: trades.length ? r2(Math.max(...trades.map((t) => t.netPnL))) : 0,
    greenDays: days.filter((p) => p > 0).length,
    redDays: days.filter((p) => p <= 0).length,
    exits,
    setups: Object.values(setups),
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
    years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i] }));
  return out;
}

/** Option price at a minute: that minute's open, else the next bar within `ahead` minutes. */
function priceAt(book, minute, ahead = 5) {
  for (let m = minute; m <= Math.min(LAST, minute + ahead); m += 1) {
    const b = book.get(m);
    if (b) return { min: m, price: b.o };
  }
  return null;
}

function simulateDay({ day, rule, qty, lastMin, isToday, trades, halts, skipped }) {
  const candles = buildCandles(day.nifty);
  const orb = addIndicators(candles);
  if (!orb) return 0;
  const nifty = minuteMap(day.nifty);
  const books = new Map();
  const bookFor = (side, strike) => {
    const key = `${side}-${strike}`;
    if (!books.has(key)) books.set(key, minuteMap(day[side]?.[String(strike)]));
    return books.get(key);
  };
  const spotAt = (m) => nifty.get(m)?.o ?? nifty.get(m - 1)?.c ?? null;
  const signalAt = new Map();
  candles.forEach((c, i) => {
    if (i >= ORB_CANDLES && c.end + 1 <= lastMin + 1) signalAt.set(c.end + 1, i);
  });

  const scalpQty = Math.round(qty * rule.scalpShare);
  const runnerQty = qty - scalpQty;
  const month = Number(day.dateKey.slice(5, 7));
  const endMin = Math.min(rule.eod, lastMin + 1);
  let pos = null;
  let taken = 0;
  let dayNet = 0;
  let halted = null;
  let lastExit = -Infinity;

  const open = (i, sig, m) => {
    const c = candles[i];
    const strike = Math.round(c.c / STEP) * STEP;
    const book = bookFor(sig.side, strike);
    const closeBar = book.get(c.end);
    const px = closeBar ? { min: m, price: closeBar.c } : priceAt(book, m, 2);
    if (!px) {
      skipped.push({ dateKey: day.dateKey, time: span(c), side: sig.side, reason: `${SETUP_LABEL[sig.setup]} · no ${strike} ${sig.side} price at ${hhmm(m)}` });
      return null;
    }
    const entry = r2(px.price);
    return {
      c,
      side: sig.side,
      setup: sig.setup,
      strike,
      book,
      entryMin: px.min,
      entry,
      entrySpot: r2(c.c),
      stop: r2(entry - rule.slPts),
      t1: r2(entry + rule.t1Pts),
      t2: r2(entry + rule.t2Pts),
      beDone: false,
      t1Hit: null,
      best: 0,
      worst: 0,
      last: entry,
      legs: [],
      events: [
        {
          time: hhmm(m),
          text: `${SETUP_LABEL[sig.setup]} on ${span(c)} · NIFTY O ${fmt(c.o)} H ${fmt(c.h)} L ${fmt(c.l)} C ${fmt(c.c)} · VWAP ${fmt(c.vwap)} · EMA20 ${fmt(c.ema20)} · EMA35 ${fmt(c.ema35)} · ORB ${fmt(orb.low)}–${fmt(orb.high)}`,
        },
        {
          time: hhmm(px.min),
          text: `Bought ${qty} qty ${strike} ${sig.side} at ₹${fmt(entry)} · SL ₹${fmt(entry - rule.slPts)} · T1 ₹${fmt(entry + rule.t1Pts)} (${scalpQty} qty) · T2 ₹${fmt(entry + rule.t2Pts)} (${runnerQty} qty)`,
        },
      ],
    };
  };

  const leg = (p, label, legQty, price, min) => {
    const pts = r2(price - p.entry);
    p.legs.push({ label, qty: legQty, price: r2(price), pts, pnl: r2(pts * legQty), time: hhmm(min) });
  };

  const finish = (p, type, rawPrice, min, text) => {
    const price = r2(Math.max(0.05, rawPrice));
    leg(p, p.t1Hit ? 'Runner' : 'Full', p.t1Hit ? runnerQty : qty, price, min);
    p.events.push({ time: hhmm(min), text: `${text} → sold ${p.strike} ${p.side} at ₹${fmt(price)}` });
    const grossPnL = r2(p.legs.reduce((s, l) => s + l.pnl, 0));
    const charges = rule.taxPerTrade;
    const netPnL = r2(grossPnL - charges);
    const points = r2(grossPnL / qty);
    dayNet = r2(dayNet + netPnL);
    lastExit = min;
    trades.push({
      id: `${day.dateKey}-${hhmm(p.entryMin)}-${p.side}-${p.strike}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      side: p.side,
      strike: p.strike,
      setup: p.setup,
      setupLabel: SETUP_LABEL[p.setup],
      signalTime: span(p.c),
      signalCandle: { o: r2(p.c.o), h: r2(p.c.h), l: r2(p.c.l), c: r2(p.c.c), v: p.c.v },
      indicators: { vwap: r2(p.c.vwap), ema20: r2(p.c.ema20), ema35: r2(p.c.ema35), orbHigh: r2(orb.high), orbLow: r2(orb.low) },
      entryTime: hhmm(p.entryMin),
      entrySpot: p.entrySpot,
      entryPremium: p.entry,
      initialStop: r2(p.entry - rule.slPts),
      t1Price: p.t1,
      t2Price: p.t2,
      t1Hit: Boolean(p.t1Hit),
      t1Time: p.t1Hit ? hhmm(p.t1Hit) : null,
      exitTime: hhmm(min),
      exitSpot: r2(spotAt(min) ?? p.entrySpot),
      exitPremium: price,
      exitType: type,
      exitReason: EXIT_REASON[type],
      legs: p.legs,
      bestPts: r2(p.best),
      worstPts: r2(p.worst),
      points,
      grossPnL,
      charges,
      netPnL,
      dayNetAfter: dayNet,
      isWin: netPnL > 0,
      events: p.events,
    });
    if (!halted) {
      if (dayNet >= rule.profitLock) halted = { reason: `Profit lock: day net ₹${fmt(dayNet)} ≥ ₹${fmt(rule.profitLock)}`, time: hhmm(min) };
      else if (dayNet <= -rule.maxLoss) halted = { reason: `Max loss: day net ₹${fmt(dayNet)} ≤ −₹${fmt(rule.maxLoss)}`, time: hhmm(min) };
      else if (taken >= rule.maxTrades) halted = { reason: `Max ${rule.maxTrades} trades`, time: hhmm(min) };
    }
  };

  for (let m = OPEN; m < endMin; m += 1) {
    const ci = signalAt.get(m);
    if (!pos && !halted && taken < rule.maxTrades && ci !== undefined && m >= rule.entryFrom && m <= rule.entryTo && m - lastExit >= rule.cooldownBars * TF) {
      const sig = detectSignal(candles, ci, orb);
      if (sig) {
        pos = open(ci, sig, m);
        if (pos) taken += 1;
      }
    }
    if (!pos || m < pos.entryMin) continue;
    const b = pos.book.get(m);
    if (!b) {
      if (!pos.t1Hit && m + 1 >= pos.entryMin + rule.timeStopBars * TF) {
        finish(pos, 'TIME', pos.last, m + 1, `${rule.timeStopBars} bars held without T1 or stop — last price`);
        pos = null;
      }
      continue;
    }

    if (b.l <= pos.stop) {
      const type = pos.t1Hit ? 'LOCK' : pos.beDone ? 'BE' : 'SL';
      const price = b.o <= pos.stop ? b.o : pos.stop;
      pos.worst = Math.min(pos.worst, price - pos.entry);
      finish(pos, type, price, m, `Option low ₹${fmt(b.l)} at ${hhmm(m)} hit the stop ₹${fmt(pos.stop)}`);
      pos = null;
      continue;
    }
    pos.best = Math.max(pos.best, b.h - pos.entry);
    pos.worst = Math.min(pos.worst, b.l - pos.entry);
    if (!pos.t1Hit && b.h >= pos.t1) {
      pos.t1Hit = m;
      leg(pos, 'Scalp (T1)', scalpQty, b.o >= pos.t1 ? b.o : pos.t1, m);
      pos.stop = r2(pos.entry + rule.runnerLockPts);
      pos.beDone = true;
      pos.events.push({ time: hhmm(m), text: `T1 ₹${fmt(pos.t1)} hit → sold ${scalpQty} qty · runner SL → entry +${rule.runnerLockPts} (₹${fmt(pos.stop)})` });
    }
    if (pos.t1Hit && b.h >= pos.t2) {
      finish(pos, 'T2', b.o >= pos.t2 ? b.o : pos.t2, m, `T2 ₹${fmt(pos.t2)} hit`);
      pos = null;
      continue;
    }
    if (!pos.beDone && b.h >= pos.entry + rule.beTriggerPts) {
      pos.beDone = true;
      pos.stop = r2(pos.entry + rule.beLockPts);
      pos.events.push({ time: hhmm(m), text: `Option +${rule.beTriggerPts} reached → SL moved to entry +${rule.beLockPts} (₹${fmt(pos.stop)})` });
    }
    pos.last = b.c;
    if (!pos.t1Hit && m + 1 >= pos.entryMin + rule.timeStopBars * TF) {
      finish(pos, 'TIME', b.c, m + 1, `${rule.timeStopBars} bars held without T1 or stop — ${hhmm(m + 1)} close`);
      pos = null;
    }
  }
  if (pos) {
    const still = isToday && lastMin + 1 < rule.eod;
    const exitMin = still ? lastMin : rule.eod;
    const price = still ? pos.last : priceAt(pos.book, rule.eod)?.price ?? pos.last;
    finish(pos, still ? 'OPEN' : 'EOD', price, exitMin, still ? `Trade still open — marked at ${hhmm(lastMin)}` : `${hhmm(rule.eod)} square-off`);
  }
  if (halted) halts.push({ dateKey: day.dateKey, ...halted, dayNet });
  return taken;
}

/**
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function, onPartial?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress, onPartial } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const lotCount = Math.max(1, Math.round(lots));
  const qty = lotCount * rule.lotSize;
  const trades = [];
  const flatDays = [];
  const haltedDays = [];
  const skippedSignals = [];
  let tradingDays = 0;

  const build = (doneThrough) => ({
    from,
    to,
    lots: lotCount,
    qty,
    scalpQty: Math.round(qty * rule.scalpShare),
    runnerQty: qty - Math.round(qty * rule.scalpShare),
    rule: { ...rule, entryFrom: hhmm(rule.entryFrom), entryTo: hhmm(rule.entryTo), eod: hhmm(rule.eod) },
    tradingDays,
    flatDays: [...flatDays],
    haltedDays: [...haltedDays],
    skippedSignals: [...skippedSignals],
    summary: summarize(trades),
    trades: [...trades],
    ...(doneThrough ? { doneThrough } : {}),
  });

  const chunks = rangeChunks(from, to);
  for (const [ci, chunk] of chunks.entries()) {
    const report = chunkProgress(onProgress, ci, chunks.length, chunk.label, () => ({ tradesSoFar: trades.length }));
    const live = await ensureDays(chunk.from, chunk.to, { onProgress: report });
    const days = await loadDays(chunk.from, chunk.to, live);
    const now = getIstClock(new Date());
    days.forEach((day, di) => {
      report({ phase: 'simulate', done: di, total: days.length, dateKey: day.dateKey });
      const isToday = day.dateKey === now.dateKey;
      const lastMin = Math.max(...day.nifty.m.filter((m) => m <= LAST && (!isToday || m < now.minutes)), OPEN);
      const taken = simulateDay({ day, rule, qty, lastMin, isToday, trades, halts: haltedDays, skipped: skippedSignals });
      if (!taken) flatDays.push(day.dateKey);
    });
    tradingDays += days.length;
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START, detectSignal, addIndicators, buildCandles };
