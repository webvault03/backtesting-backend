/**
 * NIFTY Champion 8-Setup — the `1_pro.cjs` rules on real Dhan data.
 *
 * Signals on closed NIFTY 5-min candles that start 09:45–14:45 (opening range = first 6 candles 09:15–09:45):
 *   CE — Wyckoff spring · hammer at EMA 20 · bullish engulfing at VWAP · volume breakout above ORB high.
 *   PE — Wyckoff upthrust · shooting star at EMA 20 · bearish engulfing at VWAP · volume breakdown below ORB low.
 *   Trend = close vs VWAP and EMA 20 vs EMA 35 (EMAs on the day's closes only). CE wins a tie.
 * Exits on NIFTY: SL −6.5 · +5 → stop to entry +2 · +8.5 → 70% sold, stop to entry +4 · +16 → runner sold ·
 *   8 candles held → everything sold at the 8th candle's close · 15:15 square-off.
 * Day: stop after net ≥ +₹10,000 or ≤ −₹6,500 or 6 trades · 2 candles cooldown after every exit · one trade at a time.
 *
 * No look-ahead: entry at the signal candle's close; while a trade is open every 5-min candle is replayed on Dhan's
 * 1-minute NIFTY candles (stop first inside a minute; a stop moved in a minute counts from the next minute).
 * P&L mode `option`: the ATM option is bought at the open of the minute the signal candle closes and every sale is at
 * the option's open of the minute after NIFTY reached the level, minus real per-order costs.
 * P&L mode `spot`: NIFTY points × quantity minus a flat charge per trade (the original script's math).
 */
const { loadCandles, TF } = require('./dataSource');
const { ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { tradeCosts } = require('./costs');
const { COSTS, lotSizeOn } = require('./config');

const VERSION = 'NC8-1.0 (2026-10-15)';
const HISTORY_START = '2020-08-03';

const DEFAULT_RULE = {
  pnlMode: 'option',
  entryFrom: 9 * 60 + 45,
  entryTo: 14 * 60 + 45,
  eod: 15 * 60 + 15,
  slPts: 6.5,
  beAt: 5,
  beLock: 2,
  t1Pts: 8.5,
  t1Lock: 4,
  t2Pts: 16,
  t1Share: 0.7,
  timeBars: 8,
  dailyTarget: 10000,
  dailyMaxLoss: 6500,
  maxTradesPerDay: 6,
  cooldownBars: 2,
  tax: 100,
};

const STEP = 50;
const LAST = 15 * 60 + 29;
const NO_VOLUME = 100000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const span = (b) => `${hhmm(b.min)}–${hhmm(b.min + TF)}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

function vwapSeries(c) {
  const out = [];
  let pv = 0;
  let vol = 0;
  for (const x of c) {
    const v = x.v || NO_VOLUME;
    pv += ((x.h + x.l + x.c) / 3) * v;
    vol += v;
    out.push(vol > 0 ? pv / vol : x.c);
  }
  return out;
}

/** EMA of values[0..i] for every i (SMA seed); null until `period` values exist. */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let ema = null;
  let sum = 0;
  values.forEach((v, i) => {
    if (i < period - 1) {
      sum += v;
      out.push(null);
    } else if (i === period - 1) {
      sum += v;
      ema = sum / period;
      out.push(ema);
    } else {
      ema = v * k + ema * (1 - k);
      out.push(ema);
    }
  });
  return out;
}

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], c: series.c[i] }));
  return out;
}

/** Option open at `minute`, else the next minute with a candle within `ahead` minutes. */
function openAt(book, minute, ahead) {
  for (let m = minute; m <= Math.min(LAST, minute + ahead); m += 1) {
    const b = book.get(m);
    if (b) return { min: m, price: b.o, delayed: m > minute };
  }
  return null;
}

/** Sale after NIFTY reached a level in minute `min`: next traded open within 3 minutes, else last traded close (stale). */
function sellAt(book, min) {
  const next = openAt(book, min + 1, 3);
  if (next) return next;
  for (let m = min; m >= min - 60; m -= 1) {
    const b = book.get(m);
    if (b) return { min: m, price: b.c, late: true };
  }
  return null;
}

/** The 8 setups on closed candle i. Returns { side, setups: [names] } or null (CE wins a tie). */
function setupAt(c, i, d) {
  const b = c[i];
  const p = c[i - 1];
  const vwap = d.vwap[i];
  const ema20 = d.ema20[i];
  const ema35 = d.ema35[i];
  const { orb } = d;
  const body = Math.abs(b.c - b.o);
  const lowerWick = Math.min(b.o, b.c) - b.l;
  const upperWick = b.h - Math.max(b.o, b.c);
  const range = b.h - b.l;
  const prevBody = Math.abs(p.c - p.o);
  const prevRed = p.c < p.o;
  const prevGreen = p.c > p.o;

  const bull = ema20 != null && ema35 != null && b.c >= vwap && ema20 >= ema35;
  const bear = ema20 != null && ema35 != null && b.c <= vwap && ema20 <= ema35;

  const recent = c.slice(Math.max(0, i - 5), i).map((x) => x.v || NO_VOLUME);
  const avgVol = recent.reduce((s, v) => s + v, 0) / recent.length;
  const volOk = (b.v || NO_VOLUME) >= avgVol;

  const ce = [];
  if (b.l < orb.low && b.c >= orb.low && lowerWick >= 1.4 * body && b.c < vwap + 5) ce.push('Wyckoff spring');
  if (bull && b.l <= ema20 + 5 && b.c >= ema20 - 3 && lowerWick >= 1.5 * body && prevRed && range >= 9 && range <= 30) ce.push('Hammer @ EMA 20');
  if (bull && Math.abs(b.l - vwap) <= 8 && b.c > b.o && prevRed && b.c > p.o && b.o < p.c && body > prevBody * 1.2 && range >= 10) ce.push('Bullish engulfing @ VWAP');
  if (volOk && bull && b.c > orb.high + 3 && b.o < b.c && lowerWick <= body && body >= 10) ce.push('Volume breakout');
  if (ce.length) return { side: 'BUY', setups: ce, trend: { bull, bear, ema20, ema35, vwap } };

  const pe = [];
  if (b.h > orb.high && b.c <= orb.high && upperWick >= 1.4 * body && b.c > vwap - 5) pe.push('Wyckoff upthrust');
  if (bear && b.h >= ema20 - 5 && b.c <= ema20 + 3 && upperWick >= 1.5 * body && prevGreen && range >= 9 && range <= 30) pe.push('Shooting star @ EMA 20');
  if (bear && Math.abs(b.h - vwap) <= 8 && b.c < b.o && prevGreen && b.c < p.o && b.o > p.c && body > prevBody * 1.2 && range >= 10) pe.push('Bearish engulfing @ VWAP');
  if (volOk && bear && b.c < orb.low - 3 && b.o > b.c && upperWick <= body && body >= 10) pe.push('Volume breakdown');
  if (pe.length) return { side: 'SELL', setups: pe, trend: { bull, bear, ema20, ema35, vwap } };
  return null;
}

const EXIT_REASON = {
  TARGET: 'Runner target hit',
  T1: 'First target (all sold — no runner)',
  T1_STOP: 'Runner stopped at entry +4 (after first target)',
  BE: 'Breakeven shield stop (entry +2)',
  SL: 'Stop loss',
  TIME: '8-candle time stop',
  EOD: '15:15 square-off',
  OPEN: 'Still open (marked at last price)',
};

/** Stop / shield / first target / runner target on one NIFTY candle; the stop in force at its open is checked first. */
function step(t, b, rule, len) {
  const dir = t.side === 'BUY' ? 1 : -1;
  const time = `${hhmm(b.min)}–${hhmm(b.min + len)}`;
  const lastMin = b.min + len - 1;
  const reached = (pts) => (dir > 0 ? b.h >= t.entry + pts : b.l <= t.entry - pts);
  const stopTouched = dir > 0 ? b.l <= t.stop : b.h >= t.stop;
  if (stopTouched) {
    t.events.push({ time, text: `NIFTY ${dir > 0 ? `low ${fmt(b.l)}` : `high ${fmt(b.h)}`} reached the stop ${fmt(t.stop)}` });
    return { type: t.t1Hit ? 'T1_STOP' : t.be ? 'BE' : 'SL', px: t.stop, min: lastMin };
  }
  const lock = (level) => {
    if (dir > 0 ? level > t.stop : level < t.stop) t.stop = level;
  };
  if (!t.be && reached(rule.beAt)) {
    t.be = true;
    lock(t.entry + dir * rule.beLock);
    t.events.push({ time, text: `NIFTY +${rule.beAt} → breakeven shield: stop moved to ${fmt(t.stop)} (entry ${dir > 0 ? '+' : '−'}${rule.beLock})` });
  }
  if (!t.t1Hit && reached(rule.t1Pts)) {
    t.t1Hit = true;
    t.be = true;
    lock(t.entry + dir * rule.t1Lock);
    t.scalpMin = lastMin;
    t.scalp = t.book ? sellAt(t.book, lastMin) : null;
    t.events.push({
      time,
      text: `NIFTY +${rule.t1Pts} → sold ${t.q.scalp} qty${t.scalp ? ` at ₹${fmt(t.scalp.price)} (${hhmm(t.scalp.min)})` : ''} · runner ${t.q.runner} qty stop now ${fmt(t.stop)}`,
    });
    if (t.q.runner === 0) return { type: 'T1', px: t.entry + dir * rule.t1Pts, min: lastMin };
  }
  if (t.t1Hit && reached(rule.t2Pts)) {
    t.events.push({ time, text: `NIFTY +${rule.t2Pts} → runner target` });
    return { type: 'TARGET', px: t.entry + dir * rule.t2Pts, min: lastMin };
  }
  return null;
}

function eodExit(t, b, rule) {
  if (b.min < rule.eod) return null;
  t.events.push({ time: hhmm(rule.eod), text: `15:15 — square-off of everything still open (NIFTY ${fmt(b.o)})` });
  return { type: 'EOD', px: b.o, min: b.min - 1 };
}

/** One 5-min candle of management; after it closes the 8-candle time stop may fire. */
function manage(t, b, rule) {
  let x = null;
  if (b.m?.length) {
    for (const m of b.m) {
      if (m.min < t.buyMin) continue;
      x = eodExit(t, m, rule) || step(t, m, rule, 1);
      if (x) return x;
    }
  } else {
    x = eodExit(t, b, rule) || step(t, b, rule, TF);
    if (x) return x;
  }
  t.barsHeld += 1;
  if (t.barsHeld >= rule.timeBars) {
    t.events.push({ time: hhmm(b.min + TF), text: `${rule.timeBars} candles held without the runner target or a stop → exit at the close ${fmt(b.c)}` });
    return { type: 'TIME', px: b.c, min: b.min + TF - 1 };
  }
  return null;
}

function finishTrade(t, x, dateKey, rule, brokerage) {
  const dir = t.side === 'BUY' ? 1 : -1;
  const exitPts = dir * (x.px - t.entry);
  const runnerQty = t.t1Hit ? t.q.runner : t.q.total;
  const spotGross = r2((t.t1Hit ? rule.t1Pts * t.q.scalp : 0) + exitPts * runnerQty);

  let option = null;
  let sale = null;
  let scalp = null;
  if (t.book) {
    sale = sellAt(t.book, x.min) || { min: x.min, price: t.premium, late: true };
    scalp = t.t1Hit ? t.scalp || sale : null;
    const legs = [{ side: 'BUY', price: t.premium, qty: t.q.total }];
    if (t.t1Hit) {
      legs.push({ side: 'SELL', price: scalp.price, qty: t.q.scalp });
      if (t.q.runner > 0) legs.push({ side: 'SELL', price: sale.price, qty: t.q.runner });
    } else {
      legs.push({ side: 'SELL', price: sale.price, qty: t.q.total });
    }
    option = tradeCosts(dateKey, legs, { brokerage });
  }

  const optionMode = rule.pnlMode === 'option';
  const grossPnL = optionMode ? option.gross : spotGross;
  const charges = optionMode ? option.total : rule.tax;
  const netPnL = r2(grossPnL - charges);
  const exitMin = optionMode ? sale.min : x.min;
  const month = Number(dateKey.slice(5, 7));
  return {
    id: `${dateKey}-${t.signal.time}-${t.side}`,
    date: dateKey,
    monthKey: dateKey.slice(0, 7),
    monthShort: MONTHS[month - 1],
    side: t.side,
    option: t.option,
    strike: t.strike,
    setup: t.setups.join(' + '),
    setups: t.setups,
    signalCandle: t.signal,
    orb: t.orb,
    trend: t.trend,
    q: t.q,
    lotSize: t.lotSize,
    entryTime: hhmm(t.buyMin),
    entry: r2(t.entry),
    stopInit: r2(t.stopInit),
    entryPremium: t.book ? r2(t.premium) : null,
    scalpPremium: scalp ? r2(scalp.price) : null,
    exitPremium: sale ? r2(sale.price) : null,
    t1Hit: t.t1Hit,
    exitTime: hhmm(exitMin),
    exit: r2(x.px),
    exitType: x.type,
    exitReason: EXIT_REASON[x.type],
    niftyPts: r2(exitPts),
    spotGross,
    spotNet: r2(spotGross - rule.tax),
    optionGross: option ? option.gross : null,
    optionNet: option ? option.net : null,
    points: r2(grossPnL / t.q.total),
    grossPnL: r2(grossPnL),
    costs: optionMode ? option.costs : { tax: rule.tax },
    charges: r2(charges),
    netPnL,
    isWin: netPnL > 0,
    stale: Boolean(sale?.late || scalp?.late),
    delayed: Boolean(t.buyDelayed || sale?.delayed || scalp?.delayed),
    dayTradeNo: t.dayTradeNo,
    events: [
      ...t.events,
      {
        time: hhmm(exitMin),
        text: optionMode
          ? `Sold ${t.t1Hit ? t.q.runner : t.q.total} qty ${t.strike} ${t.option} at ₹${fmt(sale.price)} (${hhmm(sale.min)}${sale.late ? ' STALE last price' : ''}) — ${EXIT_REASON[x.type]} · gross ₹${fmt(option.gross)} − ₹${fmt(option.total)} costs = ₹${fmt(option.net)}`
          : `Exit NIFTY ${fmt(x.px)} (${exitPts >= 0 ? '+' : ''}${fmt(exitPts)} pts) — ${EXIT_REASON[x.type]} · gross ₹${fmt(spotGross)} − ₹${fmt(rule.tax)} flat charge = ₹${fmt(netPnL)}`,
      },
    ],
  };
}

function simulateDay(d, rule, brokerage, trades) {
  const { c } = d;
  let t = null;
  let count = 0;
  let dayNet = 0;
  let lastExit = -Infinity;
  let halt = null;
  const optionMode = rule.pnlMode === 'option';

  for (let i = 1; i < c.length; i += 1) {
    const b = c[i];
    if (t) {
      const x = manage(t, b, rule);
      if (x) {
        const trade = finishTrade(t, x, d.dateKey, rule, brokerage);
        dayNet = r2(dayNet + trade.netPnL);
        trade.dayNet = dayNet;
        count += 1;
        lastExit = i;
        t = null;
        if (rule.dailyTarget > 0 && dayNet >= rule.dailyTarget) halt = `Daily profit lock (≥ ₹${rule.dailyTarget})`;
        else if (rule.dailyMaxLoss > 0 && dayNet <= -rule.dailyMaxLoss) halt = `Daily max loss (≤ −₹${rule.dailyMaxLoss})`;
        else if (count >= rule.maxTradesPerDay) halt = `Max ${rule.maxTradesPerDay} trades`;
        if (halt) trade.dayHalt = halt;
        trades.push(trade);
      }
      continue;
    }
    if (halt) break;
    if (b.min < rule.entryFrom || b.min > rule.entryTo) continue;
    if (i - lastExit < rule.cooldownBars) continue;
    const s = setupAt(c, i, d);
    if (!s) continue;

    const dir = s.side === 'BUY' ? 1 : -1;
    const option = dir > 0 ? 'CE' : 'PE';
    const strike = Math.round(b.c / STEP) * STEP;
    const buyMin = b.min + TF;
    let book = null;
    let buy = null;
    if (optionMode) {
      book = d.bookFor(option, strike);
      buy = openAt(book, buyMin, 2);
      if (!buy) continue;
    }
    const stop = b.c - dir * rule.slPts;
    t = {
      side: s.side,
      option,
      strike,
      book,
      setups: s.setups,
      trend: {
        vwap: r2(s.trend.vwap),
        ema20: s.trend.ema20 == null ? null : r2(s.trend.ema20),
        ema35: s.trend.ema35 == null ? null : r2(s.trend.ema35),
        state: s.trend.bull ? 'bullish' : s.trend.bear ? 'bearish' : 'none',
      },
      orb: { high: r2(d.orb.high), low: r2(d.orb.low) },
      signal: { time: span(b), o: r2(b.o), h: r2(b.h), l: r2(b.l), c: r2(b.c), v: b.v || 0 },
      entry: b.c,
      premium: buy ? buy.price : null,
      buyMin: buy ? buy.min : buyMin,
      buyDelayed: Boolean(buy?.delayed),
      stop,
      stopInit: stop,
      be: false,
      t1Hit: false,
      scalp: null,
      barsHeld: 0,
      q: d.q,
      lotSize: d.lotSize,
      dayTradeNo: count + 1,
      events: [
        {
          time: span(b),
          text: `${s.setups.join(' + ')} on ${span(b)} (O ${fmt(b.o)} H ${fmt(b.h)} L ${fmt(b.l)} C ${fmt(b.c)}) · ORB ${fmt(d.orb.low)}–${fmt(d.orb.high)} · VWAP ${fmt(s.trend.vwap)}${s.trend.ema20 != null ? ` · EMA20 ${fmt(s.trend.ema20)}` : ''}${s.trend.ema35 != null ? ` · EMA35 ${fmt(s.trend.ema35)}` : ''}`,
        },
        {
          time: hhmm(buy ? buy.min : buyMin),
          text: `${buy ? `Bought ${d.q.total} qty ${strike} ${option} at ₹${fmt(buy.price)} (${hhmm(buy.min)})` : `Entry ${s.side === 'BUY' ? 'long' : 'short'} ${d.q.total} qty`} · NIFTY ${fmt(b.c)} · SL ${fmt(stop)} (${rule.slPts} pts) · +${rule.beAt} → stop entry ${dir > 0 ? '+' : '−'}${rule.beLock} · +${rule.t1Pts} sell ${d.q.scalp} · +${rule.t2Pts} runner`,
        },
      ],
    };
  }
  if (t) {
    const last = c[c.length - 1];
    const trade = finishTrade(t, { type: 'OPEN', px: last.c, min: last.min + TF - 1 }, d.dateKey, rule, brokerage);
    trade.dayNet = r2(dayNet + trade.netPnL);
    trades.push(trade);
  }
}

/**
 * @param {{ from: string, to: string, lots?: number, brokerage?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function, onPartial?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, brokerage = COSTS.brokeragePerOrder, rule: ruleIn = {}, onProgress, onPartial } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const optionMode = rule.pnlMode === 'option';
  const lotCount = Math.max(1, Math.round(lots));
  const firstLots = Math.min(lotCount, Math.max(1, Math.round(lotCount * rule.t1Share)));
  const split = (lotSize) => ({ total: lotCount * lotSize, scalp: firstLots * lotSize, runner: (lotCount - firstLots) * lotSize });
  const trades = [];
  let tradingDays = 0;

  const build = (doneThrough) => {
    const net = trades.reduce((s, t) => s + t.netPnL, 0);
    return {
      version: VERSION,
      from,
      to,
      lots: lotCount,
      rule: { ...rule, entryFrom: hhmm(rule.entryFrom), entryTo: hhmm(rule.entryTo), eod: hhmm(rule.eod), brokerage },
      tradingDays,
      summary: { trades: trades.length, wins: trades.filter((t) => t.isWin).length, netPnL: r2(net) },
      trades: [...trades],
      ...(doneThrough ? { doneThrough } : {}),
    };
  };

  const chunks = rangeChunks(from, to);
  for (const [ci, chunk] of chunks.entries()) {
    const report = chunkProgress(onProgress, ci, chunks.length, chunk.label, () => ({ tradesSoFar: trades.length }));
    let options = new Map();
    if (optionMode) {
      const live = await ensureDays(chunk.from, chunk.to, { onProgress: report });
      options = new Map((await loadDays(chunk.from, chunk.to, live)).map((d) => [d.dateKey, d]));
    } else {
      report({ phase: 'fetch', done: 0, total: 0 });
    }
    const days = await loadCandles(chunk.from, chunk.to);
    days.forEach((day, di) => {
      report({ phase: 'simulate', done: di, total: days.length, dateKey: day.dateKey });
      const c = day.candles;
      const orbBars = c.filter((x) => x.min < rule.entryFrom);
      const opt = options.get(day.dateKey);
      if (!orbBars.length || (optionMode && !opt)) return;
      tradingDays += 1;
      const books = new Map();
      const lotSize = lotSizeOn(day.dateKey);
      const closes = c.map((x) => x.c);
      simulateDay(
        {
          dateKey: day.dateKey,
          c,
          orb: { high: Math.max(...orbBars.map((x) => x.h)), low: Math.min(...orbBars.map((x) => x.l)) },
          vwap: vwapSeries(c),
          ema20: emaSeries(closes, 20),
          ema35: emaSeries(closes, 35),
          lotSize,
          q: split(lotSize),
          bookFor: (option, strike) => {
            const key = `${option}-${strike}`;
            if (!books.has(key)) books.set(key, minuteMap(opt?.[option]?.[String(strike)]));
            return books.get(key);
          },
        },
        rule,
        brokerage,
        trades,
      );
    });
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START, COSTS, VERSION };
