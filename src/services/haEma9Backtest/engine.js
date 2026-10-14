/**
 * Heikin Ashi 5-min colour change — historical backtest. Signal on NIFTY 5-min Heikin Ashi, trade + stop + target on the
 * ATM option's own 5-min candle.
 *
 * Signal (closed candles only, HA chained across days like the chart):
 *   The first candle of a new colour: RED after green → buy ATM PE · GREEN after red → buy ATM CE (doji keeps the colour).
 *   One trade per colour run: after a trade (or a skip) the next entry waits for the next colour change.
 * Entry, at the open of the first minute after the HA candle closes:
 *   Strike = NIFTY at that minute rounded to 50. The option's real 5-min candle for the same slot (e.g. 09:25–09:30)
 *   gives the stop: its LOW. Skip when that candle's high − low is above `maxCandlePts`, or when the buy price is not
 *   above the low.
 *   Risk = buy price − stop · target = buy price + risk × `rr` (1:1 by default).
 * Exits on the option's 1-min bars: stop first (sold at the stop, or the minute open if it opened below), then target
 *   (sold at the target, or the minute open if it opened above). Colour change while holding → sell at that minute's open
 *   and take the new side (same skip rules). Anything open is sold at `eod`.
 */
const { addDays, ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { getIstClock } = require('../../utils/dateTime');

const HISTORY_START = '2020-08-03';
const STEP = 50;
const OPEN = 9 * 60 + 15;
const LAST = 15 * 60 + 29;
const WARMUP_DAYS = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  timeframe: 5,
  lotSize: 65,
  /** Signal candle must close between these minutes (entry the minute it closes). */
  entryFrom: OPEN + 5,
  entryTo: 15 * 60,
  eod: 15 * 60 + 15,
  /** Skip when the option's 5-min candle (high − low) is bigger than this (option points). */
  maxCandlePts: 15,
  /** Target = risk × rr. */
  rr: 1,
  slippage: 0,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const span = (c) => `${hhmm(c.start)}–${hhmm(c.end + 1)}`;

/** F&O option charges for one buy + one sell (₹20/order brokerage, STT, exchange, SEBI, GST, stamp). */
function optionCharges(buyValue, sellValue) {
  const brokerage = 40;
  const stt = sellValue * 0.001;
  const exchange = (buyValue + sellValue) * 0.0003503;
  const sebi = (buyValue + sellValue) * 1e-6;
  const gst = (brokerage + exchange + sebi) * 0.18;
  const stamp = buyValue * 0.00003;
  return r2(brokerage + stt + exchange + sebi + gst + stamp);
}

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i] }));
  return out;
}

/** NIFTY `tf`-minute candles, in order: { dateKey, start, end, o, h, l, c }. */
function buildCandles(days, tf) {
  const out = [];
  for (const day of days) {
    const n = day.nifty;
    let cur = null;
    n.m.forEach((m, i) => {
      if (m < OPEN || m > LAST) return;
      const start = OPEN + Math.floor((m - OPEN) / tf) * tf;
      if (!cur || cur.start !== start) {
        cur = { dateKey: day.dateKey, start, end: Math.min(start + tf - 1, LAST), o: n.o[i], h: n.h[i], l: n.l[i], c: n.c[i] };
        out.push(cur);
      } else {
        cur.h = Math.max(cur.h, n.h[i]);
        cur.l = Math.min(cur.l, n.l[i]);
        cur.c = n.c[i];
      }
    });
  }
  return out;
}

/**
 * Heikin Ashi candles chained across days. Real OHLC kept as ro/rh/rl/rc.
 * colour = +1 green / −1 red (a doji keeps the previous colour); turn = first candle of a new colour.
 */
function heikinAshi(candles) {
  let prev = null;
  return candles.map((c) => {
    const close = (c.o + c.h + c.l + c.c) / 4;
    const open = prev ? (prev.o + prev.c) / 2 : (c.o + c.c) / 2;
    const dir = Math.sign(close - open);
    const colour = dir || prev?.colour || 0;
    const ha = { ...c, ro: c.o, rh: c.h, rl: c.l, rc: c.c, o: open, h: Math.max(c.h, open, close), l: Math.min(c.l, open, close), c: close, colour };
    ha.turn = Boolean(prev && dir !== 0 && prev.colour !== 0 && dir !== prev.colour);
    prev = ha;
    return ha;
  });
}

/** Option price at a minute: that minute's open, else the next bar within `ahead` minutes. */
function priceAt(book, minute, ahead = 5) {
  for (let m = minute; m <= Math.min(LAST, minute + ahead); m += 1) {
    const b = book.get(m);
    if (b) return { min: m, price: b.o };
  }
  return null;
}

/** The option's real candle over [start, end] from its 1-min bars. */
function optionCandle(book, start, end) {
  let c = null;
  for (let m = start; m <= end; m += 1) {
    const b = book.get(m);
    if (!b) continue;
    if (!c) c = { o: b.o, h: b.h, l: b.l, c: b.c };
    else {
      c.h = Math.max(c.h, b.h);
      c.l = Math.min(c.l, b.l);
      c.c = b.c;
    }
  }
  return c;
}

const EXIT_REASON = { SL: 'Stop loss (option candle low)', TARGET: 'Target', FLIP: 'Colour change — flip', EOD: 'Day close', OPEN: 'Still open (marked)' };

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const years = {};
  const dayPnl = {};
  const exits = { SL: 0, TARGET: 0, FLIP: 0, EOD: 0, OPEN: 0 };
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    exits[t.exitType] += 1;
    dayPnl[t.date] = (dayPnl[t.date] || 0) + t.netPnL;
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
    charges: r2(charges),
    avgCharges: trades.length ? r2(charges / trades.length) : 0,
    maxDrawdown: r2(maxDd),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    worstTrade: trades.length ? r2(Math.min(...trades.map((t) => t.netPnL))) : 0,
    bestTrade: trades.length ? r2(Math.max(...trades.map((t) => t.netPnL))) : 0,
    greenDays: days.filter((p) => p > 0).length,
    redDays: days.filter((p) => p <= 0).length,
    exits,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
    years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

function simulateDay({ day, dayCandles, nifty, rule, qty, lastMin, isToday, trades, skipped }) {
  const books = new Map();
  const bookFor = (side, strike) => {
    const key = `${side}-${strike}`;
    if (!books.has(key)) books.set(key, minuteMap(day[side]?.[String(strike)]));
    return books.get(key);
  };
  const signalAt = new Map();
  for (const c of dayCandles) if (c.turn) signalAt.set(c.end + 1, c);
  const endMin = Math.min(rule.eod, lastMin + 1);
  const month = Number(day.dateKey.slice(5, 7));
  let pos = null;
  let taken = 0;

  const open = (sc, side, m) => {
    const skip = (reason) => {
      skipped.push({ dateKey: day.dateKey, time: span(sc), side, reason });
      return null;
    };
    const spot = nifty.get(m)?.o;
    if (!Number.isFinite(spot)) return skip(`no NIFTY bar at ${hhmm(m)}`);
    const strike = Math.round(spot / STEP) * STEP;
    const book = bookFor(side, strike);
    const oc = optionCandle(book, sc.start, sc.end);
    if (!oc) return skip(`no ${strike} ${side} candle ${span(sc)}`);
    const candlePts = r2(oc.h - oc.l);
    if (candlePts > rule.maxCandlePts) return skip(`${strike} ${side} candle ${candlePts} pts (max ${rule.maxCandlePts})`);
    const px = priceAt(book, m, 3);
    if (!px) return skip(`no ${strike} ${side} price at ${hhmm(m)}`);
    const entryPremium = r2(px.price + rule.slippage);
    const stop = r2(oc.l);
    const risk = r2(entryPremium - stop);
    if (risk <= 0) return skip(`${strike} ${side} opened ₹${fmt(px.price)} at or below the candle low ₹${fmt(stop)}`);
    const target = r2(entryPremium + risk * rule.rr);
    const pe = side === 'PE';
    const entrySpot = r2(nifty.get(px.min)?.o ?? spot);
    return {
      sc,
      side,
      strike,
      book,
      oc,
      candlePts,
      startMin: px.min,
      entryPremium,
      entrySpot,
      stop,
      risk,
      target,
      peak: entryPremium,
      low: entryPremium,
      last: entryPremium,
      events: [
        {
          time: hhmm(sc.end + 1),
          text: `5-min Heikin Ashi turned ${pe ? 'RED' : 'GREEN'} on ${span(sc)} (HA O ${fmt(sc.o)} C ${fmt(sc.c)}) — first ${pe ? 'red' : 'green'} candle after a ${pe ? 'green' : 'red'} run`,
        },
        {
          time: hhmm(sc.end + 1),
          text: `${strike} ${side} candle ${span(sc)}: O ${fmt(oc.o)} H ${fmt(oc.h)} L ${fmt(oc.l)} C ${fmt(oc.c)} · size ${candlePts} pts (≤ ${rule.maxCandlePts})`,
        },
        {
          time: hhmm(px.min),
          text: `Bought ${strike} ${side} at the ${hhmm(px.min)} open ₹${fmt(entryPremium)} · SL ₹${fmt(stop)} (candle low, risk ${fmt(risk)} pts) · target ₹${fmt(target)} (+${fmt(risk * rule.rr)} pts) · NIFTY ${fmt(entrySpot)}`,
        },
      ],
    };
  };

  const close = (p, fill, min, type, text) => {
    const exitPremium = r2(Math.max(0.05, (fill ? fill.price : p.last) - rule.slippage));
    const exitMin = fill?.min ?? min;
    const exitSpot = r2(nifty.get(exitMin)?.o ?? nifty.get(exitMin - 1)?.c ?? p.entrySpot);
    const points = r2(exitPremium - p.entryPremium);
    const grossPnL = r2(points * qty);
    const charges = optionCharges(p.entryPremium * qty, exitPremium * qty);
    const netPnL = r2(grossPnL - charges);
    p.events.push({ time: hhmm(exitMin), text: `${text} → sold ${p.strike} ${p.side} at ₹${fmt(exitPremium)} · ${points >= 0 ? '+' : ''}${points} pts` });
    const sc = p.sc;
    trades.push({
      id: `${day.dateKey}-${hhmm(p.startMin)}-${p.side}-${p.strike}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      side: p.side,
      strike: p.strike,
      signalTime: span(sc),
      signalCandle: { o: r2(sc.o), h: r2(sc.h), l: r2(sc.l), c: r2(sc.c), ro: r2(sc.ro), rh: r2(sc.rh), rl: r2(sc.rl), rc: r2(sc.rc) },
      optionCandle: { o: r2(p.oc.o), h: r2(p.oc.h), l: r2(p.oc.l), c: r2(p.oc.c) },
      candlePts: p.candlePts,
      stop: p.stop,
      riskPts: p.risk,
      targetPremium: p.target,
      entryTime: hhmm(p.startMin),
      entrySpot: p.entrySpot,
      entryPremium: p.entryPremium,
      peakPremium: r2(Math.max(p.peak, exitPremium)),
      lowPremium: r2(Math.min(p.low, exitPremium)),
      maxGainPts: r2(Math.max(p.peak, exitPremium) - p.entryPremium),
      exitTime: hhmm(exitMin),
      exitSpot,
      niftyPts: r2(p.side === 'CE' ? exitSpot - p.entrySpot : p.entrySpot - exitSpot),
      exitPremium,
      exitType: type,
      exitReason: EXIT_REASON[type],
      points,
      grossPnL,
      charges,
      netPnL,
      isWin: netPnL > 0,
      events: p.events,
    });
  };

  for (let m = OPEN; m < endMin; m += 1) {
    const sc = signalAt.get(m);
    if (sc) {
      const side = sc.colour > 0 ? 'CE' : 'PE';
      if (pos) {
        close(pos, priceAt(pos.book, m), m, 'FLIP', `5-min HA turned ${side === 'CE' ? 'GREEN' : 'RED'} on ${span(sc)}`);
        pos = null;
      }
      if (m >= rule.entryFrom && m <= rule.entryTo) {
        pos = open(sc, side, m);
        if (pos) taken += 1;
      }
    }
    if (!pos || m < pos.startMin) continue;
    const b = pos.book.get(m);
    if (!b) continue;
    if (b.l <= pos.stop) {
      const price = b.o <= pos.stop ? b.o : pos.stop;
      pos.low = Math.min(pos.low, price);
      close(pos, { min: m, price }, m, 'SL', `Option fell to ₹${fmt(b.l)} at ${hhmm(m)} → stop ₹${fmt(pos.stop)} hit`);
      pos = null;
      continue;
    }
    if (b.h >= pos.target) {
      const price = m > pos.startMin && b.o >= pos.target ? b.o : pos.target;
      pos.peak = Math.max(pos.peak, b.h);
      close(pos, { min: m, price }, m, 'TARGET', `Option reached ₹${fmt(b.h)} at ${hhmm(m)} → target ₹${fmt(pos.target)} hit`);
      pos = null;
      continue;
    }
    pos.peak = Math.max(pos.peak, b.h);
    pos.low = Math.min(pos.low, b.l);
    pos.last = b.c;
  }
  if (pos) {
    const still = isToday && lastMin + 1 < rule.eod;
    const fill = still ? null : priceAt(pos.book, rule.eod);
    close(pos, fill, still ? lastMin : rule.eod, still ? 'OPEN' : 'EOD', still ? `Trade still open — marked at the ${hhmm(lastMin)} price` : `${hhmm(rule.eod)} day close`);
  }
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
  const skippedSignals = [];
  let tradingDays = 0;

  const build = (doneThrough) => ({
    from,
    to,
    lots: lotCount,
    qty,
    rule: { ...rule, entryFrom: hhmm(rule.entryFrom), entryTo: hhmm(rule.entryTo), eod: hhmm(rule.eod) },
    tradingDays,
    flatDays: [...flatDays],
    skippedSignals: [...skippedSignals],
    summary: summarize(trades),
    trades: [...trades],
    ...(doneThrough ? { doneThrough } : {}),
  });

  const chunks = rangeChunks(from, to, { warmupDays: WARMUP_DAYS });
  for (const [ci, chunk] of chunks.entries()) {
    const report = chunkProgress(onProgress, ci, chunks.length, chunk.label, () => ({ tradesSoFar: trades.length }));
    const fetchFrom = addDays(chunk.from, -WARMUP_DAYS);
    const live = await ensureDays(fetchFrom, chunk.to, { onProgress: report });
    const days = (await loadDays(fetchFrom, chunk.to, live)).filter((d) => d.dateKey <= chunk.to);
    const now = getIstClock(new Date());
    const closed = buildCandles(days, rule.timeframe).filter((c) => c.dateKey !== now.dateKey || c.end + 1 <= now.minutes);
    const candles = heikinAshi(closed);
    const byDay = new Map();
    for (const c of candles) {
      if (!byDay.has(c.dateKey)) byDay.set(c.dateKey, []);
      byDay.get(c.dateKey).push(c);
    }

    const simDays = days.filter((d) => d.dateKey >= chunk.from);
    simDays.forEach((day, di) => {
      report({ phase: 'simulate', done: di, total: simDays.length, dateKey: day.dateKey });
      const isToday = day.dateKey === getIstClock(new Date()).dateKey;
      const lastMin = Math.max(...day.nifty.m.filter((m) => m <= LAST && (!isToday || m < now.minutes)), OPEN);
      const taken = simulateDay({ day, dayCandles: byDay.get(day.dateKey) || [], nifty: minuteMap(day.nifty), rule, qty, lastMin, isToday, trades, skipped: skippedSignals });
      if (!taken) flatDays.push(day.dateKey);
    });
    tradingDays += simDays.length;
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START };
