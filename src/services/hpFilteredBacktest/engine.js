/**
 * High Probability Entry Zone (Filtered) — historical backtest.
 *
 * Pine "High Probability Entry Zone (Filtered)":
 *   FVG + strong prior body + BOS through last swing · consecutive same-side filter.
 *
 * Plan on NIFTY TF · fill ATM on Dhan *next* weekly (expiryCode 2).
 *   BUY zone → CE · SELL → PE · next minute open after signal candle closes.
 *
 * SL = confirmation (signal) candle low (CE) / high (PE) on NIFTY.
 *   Exit only when a later TF candle *closes* at/through SL.
 *
 * Target = option premium trail (not NIFTY R):
 *   Peak +50 → lock +0 · +60 → +10 · +70 → +20 … (lock = peak − 50 once peak ≥ 50).
 *   Exit when option low ≤ entry + lock.
 *
 * Overnight OK · no 15:15 day close · flip / max hold days.
 */
const { addDays, ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { getIstClock } = require('../../utils/dateTime');

const HISTORY_START = '2020-08-03';
const STEP = 50;
const OPEN = 9 * 60 + 15;
const LAST = 15 * 60 + 29;
const WARMUP_DAYS = 5;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Option pts behind peak once trail is armed. Peak 50→lock 0, 60→10, 70→20. */
const TRAIL_ARM_PTS = 50;

const DEFAULT_RULE = {
  timeframe: 15,
  lotSize: 65,
  leftBars: 5,
  rightBars: 5,
  bodyRatio: 0.6,
  entryFrom: OPEN + 5,
  entryTo: 15 * 60,
  eod: 15 * 60 + 15,
  maxCandlePts: 120,
  trailArmPts: TRAIL_ARM_PTS,
  maxHoldDays: 5,
  slippage: 0,
  targets: [10, 20, 30, 40, 50],
  /** Always next weekly for overnight. */
  expiryCode: 2,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const signedPts = (n) => `${n >= 0 ? '+' : ''}${r2(n)}`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const span = (c) => `${hhmm(c.start)}–${hhmm(c.end + 1)}`;

/** Peak option pts → trail lock pts (null until armed). */
function trailLockPts(peakPts, armAt = TRAIL_ARM_PTS) {
  const peak = Number(peakPts);
  const arm = Number(armAt) || TRAIL_ARM_PTS;
  if (!Number.isFinite(peak) || peak < arm) return null;
  return r2(peak - arm);
}

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

/** Exact Pine Filtered signal (no ATR / no BOS-inside-pattern). */
function annotateSignals(candles, { leftBars, rightBars, bodyRatio }) {
  let lastPh = null;
  let lastPl = null;
  let lastSignal = 0;

  return candles.map((c, i) => {
    const out = {
      ...c,
      signal: 0,
      lastPh,
      lastPl,
      strongBody: false,
      bullishFvg: false,
      bearishFvg: false,
    };

    const pivotAt = i - rightBars;
    if (pivotAt >= leftBars) {
      const ph = candles[pivotAt].h;
      let isHigh = true;
      let isLow = true;
      for (let j = pivotAt - leftBars; j <= pivotAt + rightBars; j += 1) {
        if (j === pivotAt) continue;
        if (candles[j].h >= ph) isHigh = false;
        if (candles[j].l <= candles[pivotAt].l) isLow = false;
      }
      if (isHigh) lastPh = ph;
      if (isLow) lastPl = candles[pivotAt].l;
    }
    out.lastPh = lastPh;
    out.lastPl = lastPl;

    if (i < 2) return out;

    const prev = candles[i - 1];
    const older = candles[i - 2];
    const range = c.h - c.l;
    const prevRange = prev.h - prev.l;
    const strongPrev = prevRange > 0 && Math.abs(prev.c - prev.o) > prevRange * bodyRatio;
    out.strongBody = range > 0 && Math.abs(c.c - c.o) > range * bodyRatio;

    const bullishFvg = c.l > older.h && prev.c > prev.o;
    const bearishFvg = c.h < older.l && prev.c < prev.o;
    out.bullishFvg = bullishFvg;
    out.bearishFvg = bearishFvg;

    const buyZone = bullishFvg && strongPrev && lastPh != null && c.c > lastPh;
    const sellZone = bearishFvg && strongPrev && lastPl != null && c.c < lastPl;
    const finalBuy = buyZone && lastSignal !== 1;
    const finalSell = sellZone && lastSignal !== -1;
    if (finalBuy) lastSignal = 1;
    if (finalSell) lastSignal = -1;
    if (finalBuy && !finalSell) out.signal = 1;
    else if (finalSell) out.signal = -1;
    return out;
  });
}

function priceAt(book, minute, ahead = 5) {
  for (let m = minute; m <= Math.min(LAST, minute + ahead); m += 1) {
    const b = book.get(m);
    if (b) return { min: m, price: b.o };
  }
  return null;
}

const EXIT_REASON = {
  SL: 'Sold option · spot SL (signal candle)',
  TRAIL: 'Sold option · premium trail',
  FLIP: 'Sold option · flip',
  TIME: 'Sold option · max hold',
  OPEN: 'Still open (marked)',
};

function exitReason(type, tf, lockPts) {
  if (type === 'SL') return `Sold option · spot SL (${tf}-min close)`;
  if (type === 'TRAIL') return `Sold option · trail lock +${lockPts ?? 0}`;
  return EXIT_REASON[type] || type;
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const years = {};
  const dayPnl = {};
  const exits = { SL: 0, TRAIL: 0, FLIP: 0, TIME: 0, OPEN: 0 };
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    exits[t.exitType] = (exits[t.exitType] || 0) + 1;
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

function simulateDay({ day, dayCandles, nifty, rule, qty, lastMin, isToday, trades, skipped, carry }) {
  const tf = rule.timeframe;
  const tfLabel = `${tf}-min`;
  const armAt = rule.trailArmPts;
  const books = new Map();
  const bookFor = (side, strike) => {
    const key = `${side}-${strike}`;
    if (!books.has(key)) books.set(key, minuteMap(day[side]?.[String(strike)]));
    return books.get(key);
  };
  const signalAt = new Map();
  const candleCloseAt = new Map();
  for (const c of dayCandles) {
    candleCloseAt.set(c.end + 1, c);
    if (c.signal) signalAt.set(c.end + 1, c);
  }
  const endMin = Math.min(LAST + 1, lastMin + 1);
  let pos = carry || null;
  let taken = 0;

  if (pos) {
    pos.book = bookFor(pos.side, pos.strike);
    pos.holdDays = (pos.holdDays || 1) + 1;
    const lockTxt = pos.lockPts != null ? `trail lock +${pos.lockPts}` : `trail arms at +${armAt}`;
    pos.events.push({
      time: `${day.dateKey} ${hhmm(OPEN)}`,
      text: `Overnight hold → day ${pos.holdDays} · ${pos.strike} ${pos.side} · next weekly · SL ${fmt(pos.stopSpot)} · ${lockTxt}`,
    });
  }

  const open = (sc, side, m) => {
    const skip = (reason) => {
      skipped.push({ dateKey: day.dateKey, time: span(sc), side, reason });
      return null;
    };
    const pe = side === 'PE';
    const candlePts = r2(sc.h - sc.l);
    if (candlePts > rule.maxCandlePts) {
      return skip(`NIFTY candle ${candlePts} pts (max ${rule.maxCandlePts})`);
    }

    const spot = nifty.get(m)?.o;
    if (!Number.isFinite(spot)) return skip(`no NIFTY bar at ${hhmm(m)}`);
    const strike = Math.round(spot / STEP) * STEP;
    const book = bookFor(side, strike);
    const px = priceAt(book, m, 3);
    if (!px) return skip(`no ${strike} ${side} price at ${hhmm(m)} (next weekly)`);

    const entryPremium = r2(px.price + rule.slippage);
    const entrySpot = r2(nifty.get(px.min)?.o ?? spot);
    // Signal candle H/L — confirmation candle SL on NIFTY
    const stopSpot = pe ? r2(sc.h) : r2(sc.l);
    const riskPts = pe ? r2(stopSpot - entrySpot) : r2(entrySpot - stopSpot);
    if (riskPts <= 0) {
      return skip(
        pe
          ? `NIFTY ${fmt(entrySpot)} already at/above signal high ${fmt(stopSpot)}`
          : `NIFTY ${fmt(entrySpot)} already at/below signal low ${fmt(stopSpot)}`,
      );
    }
    const bos = pe ? sc.lastPl : sc.lastPh;
    const levels = (rule.targets || []).map((pts) => ({ pts, premium: r2(entryPremium + pts), hit: false, time: null }));

    return {
      sc,
      side,
      strike,
      book,
      candlePts,
      entryDate: day.dateKey,
      holdDays: 1,
      startMin: px.min,
      entryPremium,
      entrySpot,
      stopSpot,
      riskPts,
      peakPts: 0,
      lockPts: null,
      high: { px: entryPremium, min: px.min, date: day.dateKey },
      low: { px: entryPremium, min: px.min, date: day.dateKey },
      levels,
      last: entryPremium,
      events: [
        {
          time: hhmm(sc.end + 1),
          text: pe
            ? `SELL zone on ${span(sc)}: bearish FVG + strong body on prior bar + close ${fmt(sc.c)} below swing L ${fmt(bos)}`
            : `BUY zone on ${span(sc)}: bullish FVG + strong body on prior bar + close ${fmt(sc.c)} above swing H ${fmt(bos)}`,
        },
        {
          time: hhmm(sc.end + 1),
          text: `NIFTY ${tfLabel} ${span(sc)} O ${fmt(sc.o)} H ${fmt(sc.h)} L ${fmt(sc.l)} C ${fmt(sc.c)} · size ${candlePts} pts · SL = signal ${pe ? 'high' : 'low'} ${fmt(stopSpot)}`,
        },
        {
          time: hhmm(px.min),
          text: `Bought ${strike} ${side} (next weekly) at ₹${fmt(entryPremium)} · NIFTY ${fmt(entrySpot)} · spot SL ${fmt(stopSpot)} (${tfLabel} close) · option trail arms at +${armAt} → lock 0/+10/+20… · overnight OK`,
        },
      ],
    };
  };

  const markPath = (p, m, bar) => {
    if (!bar) return;
    const hi = m === p.startMin && p.entryDate === day.dateKey ? Math.max(p.entryPremium, bar.h) : bar.h;
    const lo = m === p.startMin && p.entryDate === day.dateKey ? Math.min(p.entryPremium, bar.l) : bar.l;
    if (hi > p.high.px) p.high = { px: hi, min: m, date: day.dateKey };
    if (lo < p.low.px) p.low = { px: lo, min: m, date: day.dateKey };
    for (const lv of p.levels) {
      if (!lv.hit && hi >= lv.premium) Object.assign(lv, { hit: true, time: `${day.dateKey} ${hhmm(m)}` });
    }
    p.last = bar.c;
    const peakPts = r2(p.high.px - p.entryPremium);
    p.peakPts = peakPts;
    const nextLock = trailLockPts(peakPts, armAt);
    if (nextLock != null && (p.lockPts == null || nextLock > p.lockPts)) {
      if (p.lockPts == null) {
        p.events.push({
          time: `${day.dateKey} ${hhmm(m)}`,
          text: `Trail armed · option peak +${peakPts} ≥ +${armAt} · lock +${nextLock} (₹${fmt(p.entryPremium + nextLock)})`,
        });
      } else if (nextLock > p.lockPts) {
        p.events.push({
          time: `${day.dateKey} ${hhmm(m)}`,
          text: `Trail raised · peak +${peakPts} · lock +${p.lockPts} → +${nextLock}`,
        });
      }
      p.lockPts = nextLock;
    }
  };

  const close = (p, fill, min, type, text, exitSpotIn) => {
    const exitPremium = r2(Math.max(0.05, (fill ? fill.price : p.last) - rule.slippage));
    const exitMin = fill?.min ?? min;
    if (exitPremium > p.high.px) p.high = { px: exitPremium, min: exitMin, date: day.dateKey };
    if (exitPremium < p.low.px) p.low = { px: exitPremium, min: exitMin, date: day.dateKey };
    for (const lv of p.levels) {
      if (!lv.hit && exitPremium >= lv.premium) Object.assign(lv, { hit: true, time: `${day.dateKey} ${hhmm(exitMin)}` });
    }
    const exitSpot = r2(exitSpotIn ?? nifty.get(exitMin)?.o ?? nifty.get(exitMin - 1)?.c ?? p.entrySpot);
    const points = r2(exitPremium - p.entryPremium);
    const grossPnL = r2(points * qty);
    const charges = optionCharges(p.entryPremium * qty, exitPremium * qty);
    const netPnL = r2(grossPnL - charges);
    const highPx = r2(p.high.px);
    const lowPx = r2(p.low.px);
    const maxGainPts = r2(highPx - p.entryPremium);
    const maxDropPts = r2(lowPx - p.entryPremium);
    const entryMonth = Number(p.entryDate.slice(5, 7));
    p.events.push({
      time: `${day.dateKey} ${hhmm(exitMin)}`,
      text: `${text} → sold ${p.strike} ${p.side} at ₹${fmt(exitPremium)} · ${points >= 0 ? '+' : ''}${points} pts · NIFTY ${fmt(exitSpot)} · held ${p.holdDays}d`,
    });
    p.events.push({
      time: `${day.dateKey} ${hhmm(exitMin)}`,
      text: `Option path: high ₹${fmt(highPx)} (${signedPts(maxGainPts)}) · low ₹${fmt(lowPx)} (${signedPts(maxDropPts)}) · trail lock ${p.lockPts != null ? `+${p.lockPts}` : 'not armed'} · levels ${(p.levels || []).map((l) => `+${l.pts}${l.hit ? ` ${l.time}` : ' no'}`).join(' · ') || 'none'}`,
    });
    const sc = p.sc;
    trades.push({
      id: `${p.entryDate}-${hhmm(p.startMin)}-${p.side}-${p.strike}`,
      date: p.entryDate,
      exitDate: day.dateKey,
      holdDays: p.holdDays,
      monthKey: p.entryDate.slice(0, 7),
      monthShort: MONTHS[entryMonth - 1],
      side: p.side,
      strike: p.strike,
      signal: sc.signal,
      signalTime: span(sc),
      signalCandle: { o: r2(sc.o), h: r2(sc.h), l: r2(sc.l), c: r2(sc.c) },
      lastPh: sc.lastPh == null ? null : r2(sc.lastPh),
      lastPl: sc.lastPl == null ? null : r2(sc.lastPl),
      bullishFvg: Boolean(sc.bullishFvg),
      bearishFvg: Boolean(sc.bearishFvg),
      candlePts: p.candlePts,
      stopSpot: p.stopSpot,
      riskPts: p.riskPts,
      trailArmPts: armAt,
      lockPts: p.lockPts,
      peakPts: p.peakPts,
      stop: p.stopSpot,
      entryTime: hhmm(p.startMin),
      entrySpot: p.entrySpot,
      entryPremium: p.entryPremium,
      targetLevels: p.levels.map((l) => ({ ...l, premium: r2(l.premium) })),
      highAfterEntry: highPx,
      highAfterTime: `${p.high.date || p.entryDate} ${hhmm(p.high.min)}`,
      maxGainPts,
      lowAfterEntry: lowPx,
      lowAfterTime: `${p.low.date || p.entryDate} ${hhmm(p.low.min)}`,
      maxDropPts,
      peakPremium: highPx,
      lowPremium: lowPx,
      exitTime: hhmm(exitMin),
      exitSpot,
      niftyPts: r2(p.side === 'CE' ? exitSpot - p.entrySpot : p.entrySpot - exitSpot),
      exitPremium,
      exitType: type,
      exitReason: exitReason(type, tf, p.lockPts),
      timeframe: tf,
      points,
      grossPnL,
      charges,
      netPnL,
      isWin: netPnL > 0,
      events: p.events,
    });
  };

  if (pos && pos.holdDays > rule.maxHoldDays) {
    const fill = priceAt(pos.book, OPEN, 10) || (pos.last != null ? { min: OPEN, price: pos.last } : null);
    close(pos, fill, OPEN, 'TIME', `Max hold ${rule.maxHoldDays} trading days — force exit at open`);
    pos = null;
  }

  for (let m = OPEN; m < endMin; m += 1) {
    const sc = signalAt.get(m);
    if (sc) {
      const side = sc.signal > 0 ? 'CE' : 'PE';
      if (pos) {
        const flipLabel = side === 'CE' ? 'BUY zone' : 'SELL zone';
        close(pos, priceAt(pos.book, m), m, 'FLIP', `Opposite ${flipLabel} on ${span(sc)}`);
        pos = null;
      }
      if (m >= rule.entryFrom && m <= rule.entryTo) {
        pos = open(sc, side, m);
        if (pos) taken += 1;
      }
    }
    if (!pos) continue;
    if (pos.entryDate === day.dateKey && m < pos.startMin) continue;

    const b = pos.book.get(m);
    if (b) markPath(pos, m, b);

    const pe = pos.side === 'PE';

    // 1) NIFTY signal-candle SL — later TF close only
    const closed = candleCloseAt.get(m);
    if (closed && !(pos.entryDate === day.dateKey && closed.start === pos.sc.start)) {
      const slClose = pe ? closed.c >= pos.stopSpot : closed.c <= pos.stopSpot;
      if (slClose) {
        const fill = priceAt(pos.book, m, 0) || (b ? { min: m, price: b.o } : null) || priceAt(pos.book, m, 3);
        close(
          pos,
          fill,
          m,
          'SL',
          `NIFTY ${tfLabel} ${span(closed)} closed at ${fmt(closed.c)} ${pe ? '≥' : '≤'} signal-candle SL ${fmt(pos.stopSpot)}`,
          r2(closed.c),
        );
        pos = null;
        continue;
      }
    }

    // 2) Option premium trail — once armed, exit if low ≤ entry + lock
    if (pos.lockPts != null && b) {
      const lockPx = r2(pos.entryPremium + pos.lockPts);
      if (b.l <= lockPx) {
        const gapped = b.o <= lockPx;
        const fill = { min: m, price: gapped ? b.o : lockPx };
        close(
          pos,
          fill,
          m,
          'TRAIL',
          `Option low ₹${fmt(b.l)} ≤ trail lock +${pos.lockPts} (₹${fmt(lockPx)}) · peak was +${pos.peakPts}`,
          nifty.get(m)?.o,
        );
        pos = null;
      }
    }
  }

  if (pos && isToday && lastMin + 1 < rule.eod) {
    close(pos, null, lastMin, 'OPEN', `Trade still open — marked at the ${hhmm(lastMin)} price`);
    return { taken, carry: null };
  }
  return { taken, carry: pos };
}

async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress, onPartial } = {}) {
  const timeframe = Number(ruleIn.timeframe) === 5 ? 5 : 15;
  const maxHoldDays = Math.min(20, Math.max(1, Math.round(Number(ruleIn.maxHoldDays) || DEFAULT_RULE.maxHoldDays)));
  const trailArmPts = Math.min(200, Math.max(10, Number(ruleIn.trailArmPts) || DEFAULT_RULE.trailArmPts));
  const rule = {
    ...DEFAULT_RULE,
    ...ruleIn,
    timeframe,
    maxHoldDays,
    trailArmPts,
    expiryCode: 2,
    entryFrom: Number.isFinite(ruleIn.entryFrom) ? ruleIn.entryFrom : OPEN + 5,
  };
  const lotCount = Math.max(1, Math.round(lots));
  const qty = lotCount * rule.lotSize;
  const trades = [];
  const flatDays = [];
  const skippedSignals = [];
  let tradingDays = 0;
  let carry = null;

  const build = (doneThrough) => ({
    from,
    to,
    lots: lotCount,
    qty,
    rule: {
      ...rule,
      entryFrom: hhmm(rule.entryFrom),
      entryTo: hhmm(rule.entryTo),
      eod: hhmm(rule.eod),
      overnight: true,
      dayClose: false,
      expiry: 'next-weekly',
      trail: `+${rule.trailArmPts} arms → lock peak−${rule.trailArmPts}`,
    },
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
    const live = await ensureDays(fetchFrom, chunk.to, { onProgress: report, expiryCode: 2 });
    const days = (await loadDays(fetchFrom, chunk.to, live, { expiryCode: 2 })).filter((d) => d.dateKey <= chunk.to);
    const now = getIstClock(new Date());
    const closed = buildCandles(days, rule.timeframe).filter((c) => c.dateKey !== now.dateKey || c.end + 1 <= now.minutes);
    const candles = annotateSignals(closed, rule);
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
      const { taken, carry: next } = simulateDay({
        day,
        dayCandles: byDay.get(day.dateKey) || [],
        nifty: minuteMap(day.nifty),
        rule,
        qty,
        lastMin,
        isToday,
        trades,
        skipped: skippedSignals,
        carry,
      });
      carry = next;
      if (!taken && !carry) flatDays.push(day.dateKey);
    });
    tradingDays += simDays.length;
    onPartial?.(build(chunk.to));
  }

  if (carry) {
    const dayKey = carry.entryDate;
    const month = Number(dayKey.slice(5, 7));
    const exitPremium = r2(Math.max(0.05, carry.last - rule.slippage));
    const points = r2(exitPremium - carry.entryPremium);
    const grossPnL = r2(points * qty);
    const charges = optionCharges(carry.entryPremium * qty, exitPremium * qty);
    const netPnL = r2(grossPnL - charges);
    const highPx = r2(carry.high.px);
    const lowPx = r2(carry.low.px);
    carry.events.push({ time: to, text: `Range end — still open, marked at ₹${fmt(exitPremium)}` });
    trades.push({
      id: `${carry.entryDate}-${hhmm(carry.startMin)}-${carry.side}-${carry.strike}`,
      date: carry.entryDate,
      exitDate: to,
      holdDays: carry.holdDays,
      monthKey: carry.entryDate.slice(0, 7),
      monthShort: MONTHS[month - 1],
      side: carry.side,
      strike: carry.strike,
      signal: carry.sc.signal,
      signalTime: span(carry.sc),
      signalCandle: { o: r2(carry.sc.o), h: r2(carry.sc.h), l: r2(carry.sc.l), c: r2(carry.sc.c) },
      lastPh: carry.sc.lastPh == null ? null : r2(carry.sc.lastPh),
      lastPl: carry.sc.lastPl == null ? null : r2(carry.sc.lastPl),
      bullishFvg: Boolean(carry.sc.bullishFvg),
      bearishFvg: Boolean(carry.sc.bearishFvg),
      candlePts: carry.candlePts,
      stopSpot: carry.stopSpot,
      riskPts: carry.riskPts,
      trailArmPts: rule.trailArmPts,
      lockPts: carry.lockPts,
      peakPts: carry.peakPts,
      stop: carry.stopSpot,
      entryTime: hhmm(carry.startMin),
      entrySpot: carry.entrySpot,
      entryPremium: carry.entryPremium,
      targetLevels: carry.levels.map((l) => ({ ...l, premium: r2(l.premium) })),
      highAfterEntry: highPx,
      highAfterTime: `${carry.high.date || carry.entryDate} ${hhmm(carry.high.min)}`,
      maxGainPts: r2(highPx - carry.entryPremium),
      lowAfterEntry: lowPx,
      lowAfterTime: `${carry.low.date || carry.entryDate} ${hhmm(carry.low.min)}`,
      maxDropPts: r2(lowPx - carry.entryPremium),
      peakPremium: highPx,
      lowPremium: lowPx,
      exitTime: 'EOD',
      exitSpot: carry.entrySpot,
      niftyPts: 0,
      exitPremium,
      exitType: 'OPEN',
      exitReason: EXIT_REASON.OPEN,
      timeframe: rule.timeframe,
      points,
      grossPnL,
      charges,
      netPnL,
      isWin: netPnL > 0,
      events: carry.events,
    });
  }

  return build(null);
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START, trailLockPts };
