/**
 * High Probability Entry Zone — options backtest.
 *
 * Pine: "High Probability Entry Zone PRO - With Monthly Report"
 *   Signal / SL / TP1 / TP2 planned on NIFTY TF (FVG Edge, swing 3/3, body 50%,
 *   FVG 0.08×ATR, EMA100, session 09:15–15:15, Structure SL, rr1=1.5 / rr2=3.5).
 *
 * Fills & P/L: ATM CE (BUY) / PE (SELL) on Dhan *next* weekly (expiryCode 2).
 *   50/50 scale: sell half at TP1 premium, half at TP2 / SL / BE / max-hold / range-end.
 *   Never invent premiums — skip or mark open only with a real last print.
 */
const { addDays, ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { getIstClock } = require('../../utils/dateTime');

const HISTORY_START = '2021-01-01';
const DATA_START = '2020-08-03';
const EXPIRY_CODE = 2; // next weekly
const STEP = 50;
const OPEN = 9 * 60 + 15;
const LAST = 15 * 60 + 29;
const WARMUP_DAYS = 45;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  timeframe: 15,
  lotSize: 65,
  leftBars: 3,
  rightBars: 3,
  bodyPct: 0.5,
  fvgMinAtr: 0.08,
  entryMode: 'FVG Edge', // Direct Close | FVG 50% Retest | FVG Edge
  maxWaitBar: 15,
  useTrend: true,
  emaLen: 100,
  atrLen: 14,
  slMode: 'Structure',
  atrSlMult: 1.5,
  slBufAtr: 0.05,
  maxRiskAtr: 4.5,
  rr1: 1.5,
  rr2: 3.5,
  sessFrom: OPEN,
  sessTo: 15 * 60 + 15,
  maxHoldDays: 10,
  slippage: 0,
  /** Option pts above entry — table tracking only (do not exit). */
  targets: [10, 20, 30, 40, 50],
};

const r2 = (n) => Number(Number(n).toFixed(2));
const r4 = (n) => Number(Number(n).toFixed(4));
const signedPts = (n) => `${n >= 0 ? '+' : ''}${r2(n)}`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const span = (c) => `${hhmm(c.start)}–${hhmm(c.end + 1)}`;

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

/** Exact PRO Monthly annotate (validBuy / validSell + FVG edges). */
function annotate(candles, rule) {
  const { leftBars, rightBars, bodyPct, fvgMinAtr, useTrend, emaLen, atrLen, sessFrom, sessTo } = rule;
  let lastPh = null;
  let lastPl = null;
  let atr = null;
  let ema = null;
  let atrSeed = 0;
  let atrCount = 0;
  let emaSeed = 0;
  let emaCount = 0;
  const alpha = 2 / (emaLen + 1);

  return candles.map((c, i) => {
    const out = {
      ...c,
      atr: null,
      ema: null,
      lastPh,
      lastPl,
      recentHigh: null,
      recentLow: null,
      validBuy: false,
      validSell: false,
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

    if (i >= 10) {
      let hi = -Infinity;
      let lo = Infinity;
      for (let j = i - 10; j <= i - 1; j += 1) {
        hi = Math.max(hi, candles[j].h);
        lo = Math.min(lo, candles[j].l);
      }
      out.recentHigh = hi;
      out.recentLow = lo;
    }

    const prevC = i > 0 ? candles[i - 1].c : c.c;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prevC), Math.abs(c.l - prevC));
    if (atrCount < atrLen) {
      atrSeed += tr;
      atrCount += 1;
      if (atrCount === atrLen) atr = atrSeed / atrLen;
    } else if (atr != null) {
      atr = (atr * (atrLen - 1) + tr) / atrLen;
    }
    out.atr = atr == null ? null : r4(atr);

    if (emaCount < emaLen) {
      emaSeed += c.c;
      emaCount += 1;
      if (emaCount === emaLen) ema = emaSeed / emaLen;
    } else if (ema != null) {
      ema = alpha * c.c + (1 - alpha) * ema;
    }
    out.ema = ema == null ? null : r2(ema);

    if (i < 2 || atr == null) return out;

    const prev = candles[i - 1];
    const older = candles[i - 2];
    const prevRange = prev.h - prev.l;
    const strongBody1 = prevRange > 0 && Math.abs(prev.c - prev.o) >= prevRange * bodyPct;

    const gapUp = c.l - older.h;
    const gapDn = older.l - c.h;
    const bullFvg = gapUp > 0 && gapUp >= fvgMinAtr * atr;
    const bearFvg = gapDn > 0 && gapDn >= fvgMinAtr * atr;

    const bosUp =
      (lastPh != null && c.c > lastPh && prev.c <= lastPh) ||
      (out.recentHigh != null && c.c > out.recentHigh && prev.c <= out.recentHigh);
    const bosDn =
      (lastPl != null && c.c < lastPl && prev.c >= lastPl) ||
      (out.recentLow != null && c.c < out.recentLow && prev.c >= out.recentLow);

    const trendUp = !useTrend || (ema != null && c.c > ema);
    const trendDn = !useTrend || (ema != null && c.c < ema);
    const inSess = c.start >= sessFrom && c.start <= sessTo;

    out.validBuy = bullFvg && strongBody1 && bosUp && trendUp && inSess;
    out.validSell = bearFvg && strongBody1 && bosDn && trendDn && inSess;
    out.fvgTopBull = c.l;
    out.fvgBottomBull = older.h;
    out.fvgBottomBear = c.h;
    out.fvgTopBear = older.l;
    return out;
  });
}

function priceAt(book, minute, ahead = 5) {
  for (let m = minute; m <= Math.min(LAST, minute + ahead); m += 1) {
    const b = book.get(m);
    if (b && Number.isFinite(b.o)) return { min: m, price: b.o };
  }
  return null;
}

function bookForDay(dayBooks, day, side, strike) {
  const key = `${day.dateKey}-${side}-${strike}`;
  if (!dayBooks.has(key)) dayBooks.set(key, minuteMap(day[side]?.[String(strike)]));
  return dayBooks.get(key);
}

/** First 1-min in candle where NIFTY touches level (long: L≤, short: H≥). */
function firstTouchMin(nifty, candle, long, level, fromMin = null) {
  const start = fromMin != null ? Math.max(candle.start, fromMin) : candle.start;
  for (let m = start; m <= candle.end; m += 1) {
    const b = nifty.get(m);
    if (!b) continue;
    if (long ? b.l <= level : b.h >= level) return m;
  }
  return null;
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const years = {};
  const dayPnl = {};
  const exits = { SL: 0, TP1: 0, TP2: 0, BE: 0, TIME: 0, OPEN: 0 };
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    exits[t.exitType] = (exits[t.exitType] || 0) + 1;
    dayPnl[t.date] = (dayPnl[t.date] || 0) + t.netPnL;
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
  const days = Object.values(dayPnl);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    tp1Hits: trades.filter((t) => t.tp1Hit).length,
    tp2Hits: trades.filter((t) => t.exitType === 'TP2').length,
    beExits: trades.filter((t) => t.exitType === 'BE').length,
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

function simulate({ candles, dayByDate, rule, qty, rangeFrom, rangeTo, onProgress, skipped }) {
  const {
    entryMode,
    maxWaitBar,
    slMode,
    atrSlMult,
    slBufAtr,
    maxRiskAtr,
    rr1,
    rr2,
    maxHoldDays,
    slippage,
  } = rule;

  const trades = [];
  const dayBooks = new Map();
  let pending = null;
  let pos = null;

  const niftyOf = (dateKey) => {
    const day = dayByDate.get(dateKey);
    if (!day) return new Map();
    if (!day._niftyMap) day._niftyMap = minuteMap(day.nifty);
    return day._niftyMap;
  };

  const bookOf = (dateKey, side, strike) => {
    const day = dayByDate.get(dateKey);
    if (!day) return new Map();
    return bookForDay(dayBooks, day, side, strike);
  };

  const markPath = (p, dateKey, m, bar) => {
    if (!bar) return;
    const sameEntry = dateKey === p.entryDate && m === p.startMin;
    const hi = sameEntry ? Math.max(p.entryPremium, bar.h) : bar.h;
    const lo = sameEntry ? Math.min(p.entryPremium, bar.l) : bar.l;
    if (hi > p.high.px) p.high = { px: hi, min: m, date: dateKey };
    if (lo < p.low.px) p.low = { px: lo, min: m, date: dateKey };
    for (const lv of p.levels) {
      if (!lv.hit && hi >= lv.premium) Object.assign(lv, { hit: true, time: `${dateKey} ${hhmm(m)}` });
    }
    p.last = { px: bar.c, min: m, date: dateKey };
  };

  const markCandlePath = (p, c) => {
    const book = bookOf(c.dateKey, p.side, p.strike);
    const nifty = niftyOf(c.dateKey);
    const from = p.entryDate === c.dateKey ? p.startMin : c.start;
    for (let m = from; m <= c.end; m += 1) {
      const b = book.get(m);
      if (b) markPath(p, c.dateKey, m, b);
      else if (nifty.has(m) && p.last) {
        /* keep last print; no fake bars */
      }
    }
  };

  const sellPx = (p, dateKey, minute) => {
    const book = bookOf(dateKey, p.side, p.strike);
    const fill = priceAt(book, minute, 3);
    if (fill) return { min: fill.min, price: r2(Math.max(0.05, fill.price - slippage)), date: dateKey };
    if (p.last?.px != null) {
      return { min: minute, price: r2(Math.max(0.05, p.last.px - slippage)), date: dateKey, marked: true };
    }
    return null;
  };

  const finish = (p, exitFill, exitType, exitSpot, text) => {
    const halfQty = Math.floor(qty / 2);
    const restQty = qty - (p.tp1Hit ? halfQty : 0);
    const soldAtTp1 = p.tp1Hit && p.tp1ExitPremium != null;

    let grossPnL = 0;
    let charges = 0;
    let exitPremium;
    let points;

    if (soldAtTp1) {
      const g1 = r2((p.tp1ExitPremium - p.entryPremium) * halfQty);
      const g2 = r2((exitFill.price - p.entryPremium) * restQty);
      grossPnL = r2(g1 + g2);
      charges = r2(
        optionCharges(p.entryPremium * halfQty, p.tp1ExitPremium * halfQty) +
          optionCharges(p.entryPremium * restQty, exitFill.price * restQty),
      );
      // Weighted avg exit premium for display
      exitPremium = r2((p.tp1ExitPremium * halfQty + exitFill.price * restQty) / qty);
      points = r2(grossPnL / qty);
    } else {
      exitPremium = exitFill.price;
      points = r2(exitPremium - p.entryPremium);
      grossPnL = r2(points * qty);
      charges = optionCharges(p.entryPremium * qty, exitPremium * qty);
    }

    const netPnL = r2(grossPnL - charges);
    const highPx = r2(p.high.px);
    const lowPx = r2(p.low.px);
    const exitMin = exitFill.min;
    const exitDate = exitFill.date;

    if (exitPremium > highPx) p.high = { px: exitPremium, min: exitMin, date: exitDate };
    if (exitPremium < lowPx) p.low = { px: exitPremium, min: exitMin, date: exitDate };

    p.events.push({
      time: `${exitDate} ${hhmm(exitMin)}`,
      text: `${text} → sold ${soldAtTp1 ? `remaining ${restQty}` : `${qty}`} × ${p.strike} ${p.side} at ₹${fmt(exitFill.price)}${exitFill.marked ? ' (last print)' : ''} · NIFTY ${fmt(exitSpot)}`,
    });
    p.events.push({
      time: `${exitDate} ${hhmm(exitMin)}`,
      text: `Option path: high ₹${fmt(highPx)} (${signedPts(highPx - p.entryPremium)}) · low ₹${fmt(lowPx)} (${signedPts(lowPx - p.entryPremium)})${soldAtTp1 ? ` · TP1 half @ ₹${fmt(p.tp1ExitPremium)}` : ''}`,
    });

    const sc = p.sc;
    const entryMonth = Number(p.entryDate.slice(5, 7));
    trades.push({
      id: `${p.entryDate}-${hhmm(p.startMin)}-${p.side}-${p.strike}`,
      date: p.entryDate,
      exitDate,
      holdDays: p.holdDays,
      monthKey: p.entryDate.slice(0, 7),
      monthShort: MONTHS[entryMonth - 1],
      side: p.side,
      strike: p.strike,
      signalTime: span(sc),
      signalCandle: { o: r2(sc.o), h: r2(sc.h), l: r2(sc.l), c: r2(sc.c) },
      lastPh: sc.lastPh == null ? null : r2(sc.lastPh),
      lastPl: sc.lastPl == null ? null : r2(sc.lastPl),
      entryMode,
      entryTime: hhmm(p.startMin),
      entrySpot: p.entrySpot,
      entryPremium: p.entryPremium,
      niftyEntry: p.niftyEntry,
      stopSpot: p.stopInit,
      stop: p.stopInit,
      tp1: p.tp1,
      tp2: p.tp2,
      targetSpot: p.tp2,
      riskPts: p.initRisk,
      rr1,
      rr2,
      rr: rr2,
      tp1Hit: Boolean(p.tp1Hit),
      tp1ExitPremium: p.tp1ExitPremium ?? null,
      tp1ExitTime: p.tp1ExitTime ?? null,
      targetLevels: p.levels.map((l) => ({ ...l, premium: r2(l.premium) })),
      highAfterEntry: r2(p.high.px),
      highAfterTime: `${p.high.date || p.entryDate} ${hhmm(p.high.min)}`,
      maxGainPts: r2(p.high.px - p.entryPremium),
      lowAfterEntry: r2(p.low.px),
      lowAfterTime: `${p.low.date || p.entryDate} ${hhmm(p.low.min)}`,
      maxDropPts: r2(p.low.px - p.entryPremium),
      peakPremium: r2(p.high.px),
      lowPremium: r2(p.low.px),
      exitTime: hhmm(exitMin),
      exitSpot: r2(exitSpot),
      niftyPts: r2(p.side === 'CE' ? exitSpot - p.entrySpot : p.entrySpot - exitSpot),
      exitPremium,
      exitType,
      exitReason:
        exitType === 'TP2'
          ? `Sold option · TP2 ${rr2}R (50% after TP1 ${rr1}R)`
          : exitType === 'TP1'
            ? `Sold option · TP1 ${rr1}R only`
            : exitType === 'BE'
              ? 'Sold option · BE after TP1 (NIFTY SL @ entry)'
              : exitType === 'SL'
                ? 'Sold option · spot Structure SL'
                : exitType === 'TIME'
                  ? `Sold option · max hold ${maxHoldDays}d`
                  : 'Still open (marked at last print)',
      timeframe: rule.timeframe,
      points,
      grossPnL,
      charges,
      netPnL,
      isWin: netPnL > 0,
      events: p.events,
      expiryLabel: 'next weekly',
    });
  };

  const tryOpen = (pendingSetup, fillCandle, fillMin) => {
    const long = pendingSetup.dir === 1;
    const side = long ? 'CE' : 'PE';
    const nifty = niftyOf(fillCandle.dateKey);
    const spotBar = nifty.get(fillMin) || nifty.get(fillMin - 1);
    if (!spotBar || !Number.isFinite(spotBar.o)) {
      skipped.push({
        dateKey: fillCandle.dateKey,
        time: span(pendingSetup.sc),
        side,
        reason: `no NIFTY bar at ${hhmm(fillMin)}`,
      });
      return null;
    }
    const strike = Math.round(spotBar.o / STEP) * STEP;
    const book = bookOf(fillCandle.dateKey, side, strike);
    const px = priceAt(book, fillMin, 3);
    if (!px) {
      skipped.push({
        dateKey: fillCandle.dateKey,
        time: span(pendingSetup.sc),
        side,
        reason: `no ${strike} ${side} next-week premium at ${hhmm(fillMin)}`,
      });
      return null;
    }
    const entryPremium = r2(px.price + slippage);
    const entrySpot = r2(nifty.get(px.min)?.o ?? spotBar.o);
    const niftyEntry = pendingSetup.targetEntry;
    const stopInit = pendingSetup.sl;
    const risk = Math.abs(niftyEntry - stopInit);
    const levels = (rule.targets || []).map((pts) => ({
      pts,
      premium: r2(entryPremium + pts),
      hit: false,
      time: null,
    }));

    return {
      sc: pendingSetup.sc,
      side,
      strike,
      entryDate: fillCandle.dateKey,
      entryIdx: pendingSetup.setupIdx,
      startMin: px.min,
      entryPremium,
      entrySpot,
      niftyEntry,
      stopInit,
      curSl: stopInit,
      initRisk: risk,
      tp1: long ? niftyEntry + risk * rr1 : niftyEntry - risk * rr1,
      tp2: long ? niftyEntry + risk * rr2 : niftyEntry - risk * rr2,
      tp1Hit: false,
      tp1ExitPremium: null,
      tp1ExitTime: null,
      tp1ExitMin: null,
      holdDays: 1,
      lastDate: fillCandle.dateKey,
      high: { px: entryPremium, min: px.min, date: fillCandle.dateKey },
      low: { px: entryPremium, min: px.min, date: fillCandle.dateKey },
      last: { px: entryPremium, min: px.min, date: fillCandle.dateKey },
      levels,
      events: [
        {
          time: hhmm(pendingSetup.sc.start),
          text: long
            ? `BUY setup ${span(pendingSetup.sc)} · ${entryMode} · target ${fmt(niftyEntry)} · Structure SL ${fmt(stopInit)} · TP1 ${fmt(niftyEntry + risk * rr1)} (${rr1}R) · TP2 ${fmt(niftyEntry + risk * rr2)} (${rr2}R)`
            : `SELL setup ${span(pendingSetup.sc)} · ${entryMode} · target ${fmt(niftyEntry)} · Structure SL ${fmt(stopInit)} · TP1 ${fmt(niftyEntry - risk * rr1)} (${rr1}R) · TP2 ${fmt(niftyEntry - risk * rr2)} (${rr2}R)`,
        },
        {
          time: hhmm(px.min),
          text: `Bought ${strike} ${side} (next weekly) at ₹${fmt(entryPremium)} · NIFTY ${fmt(entrySpot)} · 50/50 scale at TP1 then TP2/BE/SL`,
        },
      ],
    };
  };

  for (let i = 0; i < candles.length; i += 1) {
    if (i % 200 === 0) onProgress?.({ phase: 'simulate', done: i, total: candles.length });
    const c = candles[i];
    const atr = c.atr;
    const buf = atr != null ? slBufAtr * atr : 0;
    const nifty = niftyOf(c.dateKey);
    const inRange = c.dateKey >= rangeFrom && c.dateKey <= rangeTo;

    // --- manage open trade (bars after entry) ---
    if (pos && i > pos.entryIdx) {
      if (c.dateKey !== pos.lastDate) {
        pos.holdDays += 1;
        pos.lastDate = c.dateKey;
        pos.events.push({
          time: `${c.dateKey} ${hhmm(OPEN)}`,
          text: `Overnight hold → day ${pos.holdDays} · ${pos.strike} ${pos.side}`,
        });
      }
      markCandlePath(pos, c);

      if (pos.holdDays > maxHoldDays) {
        const fill = sellPx(pos, c.dateKey, c.start) || sellPx(pos, c.dateKey, OPEN);
        if (fill) {
          finish(pos, fill, 'TIME', nifty.get(fill.min)?.o ?? pos.entrySpot, `Max hold ${maxHoldDays} trading days`);
          pos = null;
        }
      } else {
        const long = pos.side === 'CE';
        const slHit = long ? c.l <= pos.curSl : c.h >= pos.curSl;
        const t1Hit = long ? c.h >= pos.tp1 : c.l <= pos.tp1;
        const t2Hit = long ? c.h >= pos.tp2 : c.l <= pos.tp2;

        if (slHit) {
          const m = firstTouchMin(nifty, c, !long, pos.curSl) ?? c.start;
          const fill = sellPx(pos, c.dateKey, m);
          if (fill) {
            const exitSpot = r2(nifty.get(fill.min)?.[long ? 'l' : 'h'] ?? pos.curSl);
            finish(pos, fill, pos.tp1Hit ? 'BE' : 'SL', exitSpot, pos.tp1Hit
              ? `NIFTY touched BE SL ${fmt(pos.curSl)} after TP1`
              : `NIFTY touched Structure SL ${fmt(pos.curSl)}`);
            pos = null;
          }
        } else {
          if (!pos.tp1Hit && t1Hit) {
            const m = firstTouchMin(nifty, c, long, pos.tp1) ?? c.start;
            const fill = sellPx(pos, c.dateKey, m);
            if (fill) {
              pos.tp1Hit = true;
              pos.tp1ExitPremium = fill.price;
              pos.tp1ExitMin = fill.min;
              pos.tp1ExitDate = c.dateKey;
              pos.tp1ExitTime = `${c.dateKey} ${hhmm(fill.min)}`;
              pos.curSl = pos.niftyEntry;
              pos.events.push({
                time: pos.tp1ExitTime,
                text: `TP1 ${rr1}R hit · sold 50% at ₹${fmt(fill.price)} · NIFTY SL → BE ${fmt(pos.niftyEntry)}`,
              });
            }
          }
          if (pos && pos.tp1Hit && t2Hit) {
            const from =
              pos.tp1ExitDate === c.dateKey && pos.tp1ExitMin != null ? pos.tp1ExitMin : c.start;
            const m = firstTouchMin(nifty, c, long, pos.tp2, from) ?? firstTouchMin(nifty, c, long, pos.tp2) ?? c.end;
            const fill = sellPx(pos, c.dateKey, m);
            if (fill) {
              const exitSpot = r2(nifty.get(fill.min)?.[long ? 'h' : 'l'] ?? pos.tp2);
              finish(pos, fill, 'TP2', exitSpot, `NIFTY touched TP2 ${fmt(pos.tp2)} (${rr2}R)`);
              pos = null;
            }
          }
        }
      }
    }

    // --- pending timeout / invalidate ---
    if (pending) {
      if (i - pending.setupIdx > maxWaitBar) pending = null;
      else if (pending.dir === 1 && c.l <= pending.sl) pending = null;
      else if (pending.dir === -1 && c.h >= pending.sl) pending = null;
    }

    // --- new setup (only count entries inside requested range) ---
    if (!pending && !pos && atr != null && inRange) {
      if (c.validBuy) {
        const calculatedSl =
          slMode === 'Structure' ? Math.min(candles[i - 1].l, candles[i - 2].l) - buf : c.c - atrSlMult * atr;
        const fvgTop = c.fvgTopBull;
        const fvgBottom = c.fvgBottomBull;
        const targetPrice =
          entryMode === 'Direct Close' ? c.c : entryMode === 'FVG Edge' ? fvgTop : (fvgTop + fvgBottom) / 2;
        const risk = targetPrice - calculatedSl;
        if (risk > 0 && risk <= maxRiskAtr * atr) {
          pending = { dir: 1, targetEntry: r2(targetPrice), sl: r2(calculatedSl), setupIdx: i, sc: c };
        }
      } else if (c.validSell) {
        const calculatedSl =
          slMode === 'Structure' ? Math.max(candles[i - 1].h, candles[i - 2].h) + buf : c.c + atrSlMult * atr;
        const fvgBottom = c.fvgBottomBear;
        const fvgTop = c.fvgTopBear;
        const targetPrice =
          entryMode === 'Direct Close' ? c.c : entryMode === 'FVG Edge' ? fvgBottom : (fvgTop + fvgBottom) / 2;
        const risk = calculatedSl - targetPrice;
        if (risk > 0 && risk <= maxRiskAtr * atr) {
          pending = { dir: -1, targetEntry: r2(targetPrice), sl: r2(calculatedSl), setupIdx: i, sc: c };
        }
      }
    }

    // --- trigger fill ---
    if (pending && !pos && inRange) {
      const buyTrigger = pending.dir === 1 && (entryMode === 'Direct Close' || c.l <= pending.targetEntry);
      const sellTrigger = pending.dir === -1 && (entryMode === 'Direct Close' || c.h >= pending.targetEntry);
      if (buyTrigger || sellTrigger) {
        let fillMin;
        if (entryMode === 'Direct Close' && i === pending.setupIdx) {
          fillMin = Math.min(LAST, c.end + 1);
        } else {
          fillMin =
            firstTouchMin(nifty, c, pending.dir === 1, pending.targetEntry) ??
            (entryMode === 'Direct Close' ? Math.min(LAST, c.end + 1) : null);
        }
        if (fillMin != null) {
          const opened = tryOpen(pending, c, fillMin);
          if (opened) {
            opened.entryIdx = i;
            pos = opened;
            // mark path on remainder of entry candle
            markCandlePath(pos, c);
          }
          pending = null;
        }
      }
    }
  }

  // Range end — mark open with last real print only
  if (pos && pos.last?.px != null) {
    finish(
      pos,
      { min: pos.last.min, price: r2(Math.max(0.05, pos.last.px - slippage)), date: pos.last.date, marked: true },
      'OPEN',
      pos.entrySpot,
      'Range end — still open, marked at last option print',
    );
    pos = null;
  }

  return trades.filter((t) => t.date >= rangeFrom && t.date <= rangeTo);
}

async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress, onPartial } = {}) {
  const today = getIstClock(new Date()).dateKey;
  const timeframe = Number(ruleIn.timeframe) === 5 ? 5 : 15;
  const rule = {
    ...DEFAULT_RULE,
    ...ruleIn,
    timeframe,
    leftBars: Math.min(10, Math.max(2, Math.round(Number(ruleIn.leftBars) || DEFAULT_RULE.leftBars))),
    rightBars: Math.min(10, Math.max(1, Math.round(Number(ruleIn.rightBars) || DEFAULT_RULE.rightBars))),
    bodyPct: Math.min(0.95, Math.max(0.3, Number(ruleIn.bodyPct) || DEFAULT_RULE.bodyPct)),
    fvgMinAtr: Math.min(1, Math.max(0, Number(ruleIn.fvgMinAtr) || DEFAULT_RULE.fvgMinAtr)),
    entryMode: ['Direct Close', 'FVG 50% Retest', 'FVG Edge'].includes(ruleIn.entryMode)
      ? ruleIn.entryMode
      : DEFAULT_RULE.entryMode,
    maxWaitBar: Math.min(30, Math.max(3, Math.round(Number(ruleIn.maxWaitBar) || DEFAULT_RULE.maxWaitBar))),
    emaLen: Math.min(300, Math.max(20, Math.round(Number(ruleIn.emaLen) || DEFAULT_RULE.emaLen))),
    rr1: Math.min(10, Math.max(0.25, Number(ruleIn.rr1) || DEFAULT_RULE.rr1)),
    rr2: Math.min(20, Math.max(0.5, Number(ruleIn.rr2) || DEFAULT_RULE.rr2)),
    maxRiskAtr: Math.min(10, Math.max(0.5, Number(ruleIn.maxRiskAtr) || DEFAULT_RULE.maxRiskAtr)),
    slBufAtr: Math.min(1, Math.max(0, Number(ruleIn.slBufAtr) || DEFAULT_RULE.slBufAtr)),
    maxHoldDays: Math.min(20, Math.max(1, Math.round(Number(ruleIn.maxHoldDays) || DEFAULT_RULE.maxHoldDays))),
    slippage: Math.min(5, Math.max(0, Number(ruleIn.slippage) || 0)),
    useTrend: ruleIn.useTrend !== false,
    targets: Array.isArray(ruleIn.targets)
      ? [...new Set(ruleIn.targets.map(Number).filter((n) => n >= 1 && n <= 1000))].sort((a, b) => a - b).slice(0, 10)
      : DEFAULT_RULE.targets,
  };

  const rangeFrom = from < HISTORY_START ? HISTORY_START : from;
  const rangeTo = to > today ? today : to;
  const lotCount = Math.max(1, Math.round(lots));
  const qty = lotCount * rule.lotSize;
  const allTrades = [];
  const skippedSignals = [];
  const flatDays = [];
  let tradingDays = 0;

  const build = (doneThrough) => ({
    from: rangeFrom,
    to: rangeTo,
    lots: lotCount,
    qty,
    rule: {
      ...rule,
      session: '0915-1515',
      expiryCode: EXPIRY_CODE,
      expiryLabel: 'next weekly',
      scaleOut: '50/50 TP1 then TP2',
      overnight: true,
      dayClose: false,
    },
    tradingDays,
    flatDays: [...flatDays],
    skippedSignals: [...skippedSignals],
    summary: summarize(allTrades),
    trades: [...allTrades],
    ...(doneThrough ? { doneThrough } : {}),
  });

  // Fetch in chunks for progress; simulate once over the full loaded range so
  // pending / overnight positions never reset at chunk boundaries.
  let fetchFrom = addDays(rangeFrom, -WARMUP_DAYS);
  if (fetchFrom < DATA_START) fetchFrom = DATA_START;
  const chunks = rangeChunks(rangeFrom, rangeTo, { warmupDays: WARMUP_DAYS });
  let liveAcc = new Map();
  for (const [ci, chunk] of chunks.entries()) {
    const report = chunkProgress(onProgress, ci, chunks.length, chunk.label, () => ({ tradesSoFar: 0 }));
    const chunkFetchFrom = ci === 0 ? fetchFrom : chunk.from;
    const live = await ensureDays(chunkFetchFrom, chunk.to, { onProgress: report, expiryCode: EXPIRY_CODE });
    for (const [k, v] of live) liveAcc.set(k, v);
    onPartial?.(build(chunk.to));
  }

  onProgress?.({ phase: 'simulate', done: 0, total: 1 });
  const days = await loadDays(fetchFrom, rangeTo, liveAcc, { expiryCode: EXPIRY_CODE });
  const dayByDate = new Map(days.map((d) => [d.dateKey, d]));
  const now = getIstClock(new Date());
  const closed = buildCandles(days, rule.timeframe).filter(
    (c) => c.dateKey !== now.dateKey || c.end + 1 <= now.minutes,
  );
  const candles = annotate(closed, rule);
  const trades = simulate({
    candles,
    dayByDate,
    rule,
    qty,
    rangeFrom,
    rangeTo,
    onProgress,
    skipped: skippedSignals,
  });
  allTrades.push(...trades);

  const simDays = days.filter((d) => d.dateKey >= rangeFrom && d.dateKey <= rangeTo);
  tradingDays = simDays.length;
  const tradedDates = new Set(trades.map((t) => t.date));
  for (const d of simDays) {
    if (!tradedDates.has(d.dateKey)) flatDays.push(d.dateKey);
  }

  onProgress?.({ phase: 'done', done: 1, total: 1 });
  return build(null);
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START, DATA_START };
