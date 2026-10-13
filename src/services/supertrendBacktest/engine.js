/**
 * Supertrend flip — historical backtest on NIFTY spot candles, executed in the nearest-weekly option.
 *
 * Signal (closed candles only):
 *   Supertrend(atrLength, factor) on NIFTY `timeframe`-minute candles, computed exactly like TradingView
 *   ta.supertrend (ATR = Wilder RMA, bands on hl2, bands only tighten, direction from the close).
 *   The line turns green (price closed above the red line) → buy CE.
 *   The line turns red (price closed below the green line) → buy PE.
 *   Only the flip candle can trigger — never in the middle of a running green / red stretch.
 * Execution:
 *   Fill at the open of the first minute after the flip candle closes (strike = ATM of that open ± steps).
 *   Exit when the line flips the other way (same fill rule), then reverse into the new side.
 *   Intraday mode closes at `eod`; overnight mode holds across days but always closes at `eod` on expiry day.
 *   Candles keep running across days (yesterday's candles warm up today's line), like the chart.
 */
const { addDays, ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { getIstClock } = require('../../utils/dateTime');

const HISTORY_START = '2020-08-03';
const STEP = 50;
const OPEN = 9 * 60 + 15;
const LAST = 15 * 60 + 29;
const WARMUP_DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  timeframe: 5,
  candleType: 'heikin',
  atrLength: 10,
  factor: 2,
  lotSize: 65,
  strikeSteps: 0,
  entryFrom: OPEN,
  entryTo: 15 * 60,
  eod: 15 * 60 + 15,
  overnight: false,
  slippage: 0,
  /** Entry filters (0 / false = off). */
  adxMin: 0,
  adxLength: 14,
  avgFilter: false,
  maxLossesPerDay: 0,
  /** Option stop loss, % below the entry premium (0 = off). */
  slPct: 0,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const colour = (dir) => (dir === 1 ? 'GREEN' : 'RED');

/** Zerodha-style F&O option charges for one buy + one sell (brokerage, STT, exchange, SEBI, GST, stamp). */
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

/** NIFTY `tf`-minute candles for the given days, in order: { dateKey, start, end, o, h, l, c, t }. */
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
  for (const c of out) c.t = Math.round(Date.parse(`${c.dateKey}T${hhmm(c.start)}:00+05:30`) / 1000);
  return out;
}

/**
 * Heikin Ashi candles (chained across days, like a continuous chart). Real OHLC kept as ro/rh/rl/rc.
 *   close = (O + H + L + C) / 4 · open = (prev HA open + prev HA close) / 2 (first: (O + C) / 2)
 *   high = max(H, HA open, HA close) · low = min(L, HA open, HA close)
 */
function toHeikinAshi(candles) {
  let prev = null;
  return candles.map((c) => {
    const close = (c.o + c.h + c.l + c.c) / 4;
    const open = prev ? (prev.o + prev.c) / 2 : (c.o + c.c) / 2;
    const ha = { ...c, ro: c.o, rh: c.h, rl: c.l, rc: c.c, o: open, h: Math.max(c.h, open, close), l: Math.min(c.l, open, close), c: close };
    prev = ha;
    return ha;
  });
}

/** Signal candles for the rule: plain NIFTY candles or Heikin Ashi. */
function signalCandles(days, timeframe, candleType, keep = () => true) {
  const plain = buildCandles(days, timeframe).filter(keep);
  return candleType === 'heikin' ? toHeikinAshi(plain) : plain;
}

/**
 * TradingView ta.supertrend on closed candles. Adds { atr, upper, lower, line, dir } to each candle;
 * dir 1 = green (line below price), −1 = red (line above price); null until ATR exists.
 */
function applySupertrend(candles, atrLength, factor) {
  let atr = null;
  let trSum = 0;
  let prev = null;
  candles.forEach((c, i) => {
    const tr = prev ? Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)) : c.h - c.l;
    if (i < atrLength) {
      trSum += tr;
      if (i === atrLength - 1) atr = trSum / atrLength;
    } else {
      atr = (atr * (atrLength - 1) + tr) / atrLength;
    }
    c.atr = atr;
    if (atr == null) {
      Object.assign(c, { upper: null, lower: null, line: null, dir: null });
      prev = c;
      return;
    }
    const mid = (c.h + c.l) / 2;
    let upper = mid + factor * atr;
    let lower = mid - factor * atr;
    if (prev?.lower != null) {
      if (!(lower > prev.lower || prev.c < prev.lower)) lower = prev.lower;
      if (!(upper < prev.upper || prev.c > prev.upper)) upper = prev.upper;
    }
    let dir;
    if (prev?.dir == null) dir = c.c > upper ? 1 : -1;
    else if (prev.dir === -1) dir = c.c > upper ? 1 : -1;
    else dir = c.c < lower ? -1 : 1;
    Object.assign(c, { upper, lower, line: dir === 1 ? lower : upper, dir });
    prev = c;
  });
  return candles;
}

/** Wilder ADX(len) on real NIFTY candles → Map `${dateKey}|${start}` → ADX of that closed candle. */
function adxByCandle(candles, len) {
  const out = new Map();
  let trS = 0;
  let pS = 0;
  let mS = 0;
  let adx = null;
  let dxCount = 0;
  let dxSum = 0;
  candles.forEach((c, i) => {
    if (i > 0) {
      const p = candles[i - 1];
      const up = c.h - p.h;
      const dn = p.l - c.l;
      const pdm = up > dn && up > 0 ? up : 0;
      const mdm = dn > up && dn > 0 ? dn : 0;
      const tr = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
      if (i <= len) {
        trS += tr;
        pS += pdm;
        mS += mdm;
      } else {
        trS = trS - trS / len + tr;
        pS = pS - pS / len + pdm;
        mS = mS - mS / len + mdm;
      }
      if (i >= len && trS > 0) {
        const pdi = (100 * pS) / trS;
        const mdi = (100 * mS) / trS;
        const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
        dxCount += 1;
        if (dxCount < len) dxSum += dx;
        else if (dxCount === len) adx = (dxSum + dx) / len;
        else adx = (adx * (len - 1) + dx) / len;
      }
    }
    out.set(`${c.dateKey}|${c.start}`, adx);
  });
  return out;
}

/** Running average of NIFTY 1-min closes from 09:15 through `throughMin`, and the last close. */
function runningAverage(nifty, throughMin) {
  let sum = 0;
  let n = 0;
  let last = null;
  for (let m = OPEN; m <= throughMin; m += 1) {
    const c = nifty.get(m)?.c;
    if (Number.isFinite(c)) {
      sum += c;
      n += 1;
      last = c;
    }
  }
  return n ? { avg: sum / n, last } : null;
}

/** Weekly NIFTY expiry weekday: Thursday until Aug 2025, Tuesday from Sep 2025. */
const expiryWeekday = (dateKey) => (dateKey >= '2025-09-01' ? 2 : 4);
const weekday = (dateKey) => new Date(`${dateKey}T00:00:00Z`).getUTCDay();

/** True when `dateKey` is the weekly expiry (holiday on the expiry weekday → the trading day before). */
function isExpiryDay(dateKey, tradingDays, knownThrough) {
  let target = dateKey;
  for (let i = 0; i < 7 && weekday(target) !== expiryWeekday(target); i += 1) target = addDays(target, 1);
  while (target > dateKey && target <= knownThrough && !tradingDays.has(target)) target = addDays(target, -1);
  return target === dateKey;
}

/** Option price at a minute: that minute's open, else the next bar within `ahead` minutes. */
function priceAt(book, minute, ahead = 5) {
  for (let m = minute; m <= Math.min(LAST, minute + ahead); m += 1) {
    const b = book.get(m);
    if (b) return { min: m, price: b.o };
  }
  return null;
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
  const wins = trades.filter((t) => t.isWin).length;
  const charges = trades.reduce((s, t) => s + t.charges, 0);
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    netPnL: r2(equity),
    charges: r2(charges),
    avgCharges: trades.length ? r2(charges / trades.length) : 0,
    maxDrawdown: r2(maxDd),
    worstTrade: trades.length ? r2(Math.min(...trades.map((t) => t.netPnL))) : 0,
    bestTrade: trades.length ? r2(Math.max(...trades.map((t) => t.netPnL))) : 0,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
    years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

/**
 * Runs in 25-day pieces (download → simulate → `onPartial`). The open position carries from piece to piece.
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function, onPartial?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress, onPartial } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * rule.lotSize;
  const trades = [];
  const flatDays = [];
  let tradingDays = 0;
  let flips = 0;
  let pos = null;
  let pendingFlip = null;
  let lastDay = null;
  const skippedSignals = [];

  const build = (doneThrough, open = null) => ({
    from,
    to,
    lots,
    qty,
    rule: { ...rule, entryFrom: hhmm(rule.entryFrom), entryTo: hhmm(rule.entryTo), eod: hhmm(rule.eod) },
    tradingDays,
    flips,
    flatDays: [...flatDays],
    skippedSignals: [...skippedSignals],
    summary: summarize(trades),
    trades: [...trades],
    openTrade: open,
    ...(doneThrough ? { doneThrough } : {}),
  });

  const books = new Map();
  const bookFor = (day, side, strike) => {
    const key = `${day.dateKey}|${side}|${strike}`;
    if (!books.has(key)) books.set(key, minuteMap(day[side]?.[String(strike)]));
    return books.get(key);
  };

  /** Track the option's high / low through `toMin` of `day` (inclusive) for the open position. */
  const track = (day, toMin) => {
    const book = bookFor(day, pos.side, pos.strike);
    const fromMin = pos.trackedDay === day.dateKey ? pos.trackedMin + 1 : OPEN;
    for (let m = fromMin; m <= toMin; m += 1) {
      const b = book.get(m);
      if (!b) continue;
      pos.peak = Math.max(pos.peak, b.h);
      pos.low = Math.min(pos.low, b.l);
      pos.last = b.c;
    }
    pos.trackedDay = day.dateKey;
    pos.trackedMin = toMin;
  };

  const closePos = (day, minute, type, text, nifty, fixed = null) => {
    track(day, minute - 1);
    const book = bookFor(day, pos.side, pos.strike);
    const px = fixed || priceAt(book, minute);
    const exitMin = px?.min ?? minute;
    const raw = px ? px.price : pos.last;
    const exitPremium = r2(Math.max(0.05, raw - rule.slippage));
    const points = r2(exitPremium - pos.entryPremium);
    const grossPnL = r2(points * qty);
    const charges = optionCharges(pos.entryPremium * qty, exitPremium * qty);
    const netPnL = r2(grossPnL - charges);
    const exitSpot = nifty.get(exitMin)?.o ?? nifty.get(exitMin - 1)?.c ?? pos.entrySpot;
    pos.events.push({
      time: `${day.dateKey === pos.date ? '' : `${day.dateKey.slice(5)} `}${hhmm(exitMin)}`,
      text: `${text} → sold ${pos.strike} ${pos.side} at ₹${fmt(exitPremium)}${px ? '' : ' (no option bar — last known price)'} · ${points >= 0 ? '+' : ''}${points} pts`,
    });
    const month = Number(pos.date.slice(5, 7));
    const heldMin = day.dateKey === pos.date ? exitMin - pos.entryMin : null;
    trades.push({
      id: `${pos.date}-${hhmm(pos.entryMin)}-${pos.side}-${pos.strike}`,
      date: pos.date,
      monthKey: pos.date.slice(0, 7),
      monthShort: MONTHS[month - 1],
      side: pos.side,
      strike: pos.strike,
      expiryDay: pos.expiryDay,
      signalTime: pos.signalTime,
      signalClose: pos.signalClose,
      signalNiftyClose: pos.signalNiftyClose,
      lineAtSignal: pos.lineAtSignal,
      atrAtSignal: pos.atrAtSignal,
      entryTime: hhmm(pos.entryMin),
      entrySpot: pos.entrySpot,
      entryPremium: pos.entryPremium,
      peakPremium: r2(Math.max(pos.peak, exitPremium)),
      lowPremium: r2(Math.min(pos.low, exitPremium)),
      maxGainPts: r2(Math.max(pos.peak, exitPremium) - pos.entryPremium),
      maxLossPts: r2(Math.min(pos.low, exitPremium) - pos.entryPremium),
      exitDate: day.dateKey,
      exitTime: hhmm(exitMin),
      exitSpot: r2(exitSpot),
      niftyPts: r2(pos.side === 'CE' ? exitSpot - pos.entrySpot : pos.entrySpot - exitSpot),
      exitPremium,
      exitType: type,
      adxAtSignal: pos.adxAtSignal,
      avgAtEntry: pos.avgAtEntry,
      exitReason: { FLIP: 'Supertrend flip', SL: `SL −${rule.slPct}%`, DAY_CLOSE: `${hhmm(rule.eod)} close`, EXPIRY: 'Expiry-day close', OPEN: 'Still open (marked)' }[type],
      heldMin,
      overnight: day.dateKey !== pos.date,
      points,
      grossPnL,
      charges,
      netPnL,
      isWin: netPnL > 0,
      events: pos.events,
    });
    pos = null;
    return netPnL;
  };

  /**
   * Option stop loss on finished minutes before `toMin`. Gap below the stop → that minute's open;
   * touched inside the minute → the stop price.
   */
  const checkSl = (day, toMin, nifty) => {
    if (!pos || !(rule.slPct > 0)) return null;
    const slPx = pos.entryPremium * (1 - rule.slPct / 100);
    const book = bookFor(day, pos.side, pos.strike);
    const fromMin = pos.slDay === day.dateKey ? pos.slMin + 1 : day.dateKey === pos.date ? pos.entryMin : OPEN;
    for (let m = fromMin; m < toMin && m <= LAST; m += 1) {
      const b = book.get(m);
      if (!b || b.l > slPx) continue;
      const open = m === pos.entryMin && day.dateKey === pos.date ? pos.entryPremium : b.o;
      const price = open <= slPx ? open : slPx;
      return closePos(day, m, 'SL', `Option fell to the −${rule.slPct}% stop ₹${fmt(slPx)}`, nifty, { min: m, price: price + rule.slippage });
    }
    pos.slDay = day.dateKey;
    pos.slMin = Math.min(toMin, LAST + 1) - 1;
    return null;
  };

  const openPos = (day, minute, flip, nifty, expiryDay, extra = {}) => {
    const spot = nifty.get(minute)?.o;
    if (!Number.isFinite(spot)) return `no NIFTY bar at ${hhmm(minute)}`;
    const side = flip.dir === 1 ? 'CE' : 'PE';
    const atm = Math.round(spot / STEP) * STEP;
    const strike = side === 'CE' ? atm - rule.strikeSteps * STEP : atm + rule.strikeSteps * STEP;
    const px = priceAt(bookFor(day, side, strike), minute, 3);
    if (!px) return `no ${strike} ${side} price at ${hhmm(minute)}`;
    const entryPremium = r2(px.price + rule.slippage);
    const entrySpot = r2(nifty.get(px.min)?.o ?? spot);
    pos = {
      date: day.dateKey,
      side,
      strike,
      expiryDay,
      entryMin: px.min,
      entrySpot,
      entryPremium,
      signalTime: `${flip.dateKey === day.dateKey ? '' : `${flip.dateKey.slice(5)} `}${hhmm(flip.start)}–${hhmm(flip.end + 1)}`,
      signalClose: r2(flip.c),
      signalNiftyClose: r2(flip.rc ?? flip.c),
      lineAtSignal: r2(flip.line),
      atrAtSignal: r2(flip.atr),
      peak: entryPremium,
      low: entryPremium,
      last: entryPremium,
      trackedDay: day.dateKey,
      trackedMin: px.min - 1,
      adxAtSignal: extra.adx != null ? r2(extra.adx) : null,
      avgAtEntry: extra.avg != null ? r2(extra.avg) : null,
      events: [
        {
          time: `${flip.dateKey === day.dateKey ? '' : `${flip.dateKey.slice(5)} `}${hhmm(flip.end + 1)}`,
          text: `${rule.timeframe}-min ${rule.candleType === 'heikin' ? `Heikin Ashi candle ${hhmm(flip.start)}–${hhmm(flip.end + 1)} (NIFTY close ${fmt(flip.rc)}) HA close` : `candle ${hhmm(flip.start)}–${hhmm(flip.end + 1)} closed`} ${fmt(flip.c)} ${flip.dir === 1 ? 'above the red' : 'below the green'} line ${fmt(flip.dir === 1 ? flip.upper : flip.lower)} → Supertrend turned ${colour(flip.dir)} (new line ${fmt(flip.line)})`,
        },
        {
          time: hhmm(px.min),
          text: `Bought ${strike} ${side}${rule.strikeSteps ? ` (${rule.strikeSteps} ITM)` : ' (ATM)'} at the ${hhmm(px.min)} open ₹${fmt(entryPremium)} · NIFTY ${fmt(entrySpot)}${expiryDay ? ' · expiry day' : ''}${rule.slPct > 0 ? ` · SL ₹${fmt(entryPremium * (1 - rule.slPct / 100))} (−${rule.slPct}%)` : ''}`,
        },
      ],
    };
    if (extra.checks?.length) pos.events.splice(1, 0, { time: hhmm(minute), text: `Filters passed: ${extra.checks.join(' · ')}` });
    return null;
  };

  const chunks = rangeChunks(from, to, { warmupDays: WARMUP_DAYS });
  for (const [ci, chunk] of chunks.entries()) {
    const report = chunkProgress(onProgress, ci, chunks.length, chunk.label, () => ({ tradesSoFar: trades.length }));
    const fetchFrom = addDays(chunk.from, -WARMUP_DAYS);
    const lookahead = addDays(chunk.to, 7) < to ? addDays(chunk.to, 7) : to;
    const live = await ensureDays(fetchFrom, lookahead, { onProgress: report });
    const all = await loadDays(fetchFrom, lookahead, live);
    const tradingSet = new Set(all.map((d) => d.dateKey));
    const knownThrough = lookahead;
    const days = all.filter((d) => d.dateKey <= chunk.to);
    const now = getIstClock(new Date());
    const candles = applySupertrend(
      signalCandles(days, rule.timeframe, rule.candleType, (c) => c.dateKey !== now.dateKey || c.end + 1 <= now.minutes),
      rule.atrLength,
      rule.factor,
    );
    const adxMap =
      rule.adxMin > 0
        ? adxByCandle(
            buildCandles(days, rule.timeframe).filter((c) => c.dateKey !== now.dateKey || c.end + 1 <= now.minutes),
            rule.adxLength,
          )
        : null;
    const byDay = new Map();
    candles.forEach((c, i) => {
      c.prevDir = candles[i - 1]?.dir ?? null;
      c.prevLine = candles[i - 1]?.line ?? null;
      if (!byDay.has(c.dateKey)) byDay.set(c.dateKey, []);
      byDay.get(c.dateKey).push(c);
    });

    const simDays = days.filter((d) => d.dateKey >= chunk.from);
    simDays.forEach((day, di) => {
      report({ phase: 'simulate', done: di, total: simDays.length, dateKey: day.dateKey });
      const nifty = minuteMap(day.nifty);
      const expiryDay = isExpiryDay(day.dateKey, tradingSet, knownThrough);
      const mustClose = !rule.overnight || expiryDay;
      const actions = [];
      if (pendingFlip) actions.push({ min: OPEN, flip: pendingFlip });
      pendingFlip = null;
      for (const c of byDay.get(day.dateKey) || []) {
        if (c.dir == null || c.prevDir == null || c.dir === c.prevDir) continue;
        flips += 1;
        if (c.end + 1 > LAST) pendingFlip = c;
        else actions.push({ min: c.end + 1, flip: c });
      }
      if (mustClose && (day.dateKey !== now.dateKey || rule.eod < now.minutes)) actions.push({ min: rule.eod, eod: true });
      actions.sort((a, b) => a.min - b.min || (a.eod ? -1 : 1));

      let closedForDay = false;
      let tradedToday = Boolean(pos);
      let lossesToday = 0;
      const countLoss = (net) => {
        if (net != null && net < 0) lossesToday += 1;
      };
      const skip = (a, side, reason) => skippedSignals.push({ dateKey: day.dateKey, time: hhmm(a.min), side, reason });
      for (const a of actions) {
        countLoss(checkSl(day, a.min, nifty));
        if (a.eod) {
          if (pos) countLoss(closePos(day, a.min, expiryDay ? 'EXPIRY' : 'DAY_CLOSE', expiryDay ? `Expiry day — ${hhmm(rule.eod)} close` : `${hhmm(rule.eod)} day close`, nifty));
          closedForDay = true;
          continue;
        }
        const { flip } = a;
        const side = flip.dir === 1 ? 'CE' : 'PE';
        if (pos && pos.side !== side) {
          countLoss(closePos(day, a.min, 'FLIP', `Supertrend turned ${colour(flip.dir)} (${hhmm(flip.start)} ${rule.candleType === 'heikin' ? 'HA candle close' : 'candle closed'} ${fmt(flip.c)}, line ${fmt(flip.dir === 1 ? flip.upper : flip.lower)})`, nifty));
        }
        if (pos || closedForDay) continue;
        if (a.min < rule.entryFrom || a.min > rule.entryTo) continue;
        if (mustClose && a.min >= rule.eod) continue;

        const checks = [];
        if (rule.maxLossesPerDay > 0 && lossesToday >= rule.maxLossesPerDay) {
          skip(a, side, `${lossesToday} losses today — stopped for the day`);
          continue;
        }
        let adx = null;
        if (rule.adxMin > 0) {
          adx = adxMap.get(`${flip.dateKey}|${flip.start}`);
          if (!(adx >= rule.adxMin)) {
            skip(a, side, `ADX ${adx != null ? r2(adx) : '—'} < ${rule.adxMin} (sideways)`);
            continue;
          }
          checks.push(`ADX ${r2(adx)} ≥ ${rule.adxMin}`);
        }
        let avg = null;
        if (rule.avgFilter) {
          const ra = runningAverage(nifty, a.min - 1);
          avg = ra?.avg ?? null;
          const ok = ra && (side === 'CE' ? ra.last > ra.avg : ra.last < ra.avg);
          if (!ok) {
            skip(a, side, ra ? `NIFTY ${r2(ra.last)} ${side === 'CE' ? 'below' : 'above'} running avg ${r2(ra.avg)}` : 'no running average yet (09:15)');
            continue;
          }
          checks.push(`NIFTY ${fmt(ra.last)} ${side === 'CE' ? 'above' : 'below'} running avg ${fmt(ra.avg)}`);
        }
        const why = openPos(day, a.min, flip, nifty, expiryDay, { adx, avg, checks });
        if (!why) tradedToday = true;
      }
      if (pos) countLoss(checkSl(day, LAST + 1, nifty));
      if (pos) track(day, LAST);
      if (!tradedToday) flatDays.push(day.dateKey);
      lastDay = day;
    });
    tradingDays += simDays.length;
    const openSnap = pos ? { date: pos.date, side: pos.side, strike: pos.strike, entryTime: hhmm(pos.entryMin), entryPremium: pos.entryPremium, last: r2(pos.last) } : null;
    onPartial?.(build(chunk.to, openSnap));
  }

  if (pos && lastDay) {
    const lastMin = Math.max(...lastDay.nifty.m.filter((m) => m <= LAST));
    closePos(lastDay, lastMin, 'OPEN', `Backtest ends with the trade still open — marked at the ${hhmm(lastMin)} price`, minuteMap(lastDay.nifty));
  }
  return build(null);
}

/** NIFTY candles + Supertrend for [from, to] (with warm-up), for the trade chart. */
async function chartCandles({ from, to, timeframe, atrLength, factor, candleType }) {
  const fetchFrom = addDays(from, -WARMUP_DAYS);
  const live = await ensureDays(fetchFrom, to);
  const days = await loadDays(fetchFrom, to, live);
  const now = getIstClock(new Date());
  const closed = signalCandles(days, timeframe, candleType, (c) => c.dateKey !== now.dateKey || c.end + 1 <= now.minutes);
  return applySupertrend(closed, atrLength, factor)
    .filter((c) => c.dateKey >= from && c.dateKey <= to)
    .map((c) => ({ t: c.t, dateKey: c.dateKey, time: hhmm(c.start), o: r2(c.o), h: r2(c.h), l: r2(c.l), c: r2(c.c), line: c.line != null ? r2(c.line) : null, dir: c.dir }));
}

module.exports = { runBacktest, chartCandles, applySupertrend, DEFAULT_RULE, HISTORY_START };
