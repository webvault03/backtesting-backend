/**
 * High Probability Entry Zone — historical backtest (NIFTY 5-min or 15-min).
 *
 * Signal on NIFTY TF (Pine FVG + strong body + BOS). ATM option is the fill only.
 * Buy zone → CE · Sell zone → PE · entry at the minute after the signal candle closes.
 *
 * NIFTY SL = confirmation (signal) candle low (CE) / high (PE).
 * SL exits only when a later TF candle *closes* at/through the SL — wick touch does not cut.
 *
 * No fixed R target. Option premium trail (actual strike):
 *   +10 → lock +2 · +20 → lock +10 · then peak − 10 (+30→+20, +50→+40, …).
 * Retrace to lock → sell option. Opposite zone → flip. Open sold at eod.
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

const DEFAULT_RULE = {
  timeframe: 15,
  lotSize: 65,
  leftBars: 5,
  rightBars: 5,
  bodyRatio: 0.6,
  entryFrom: OPEN + 15,
  entryTo: 15 * 60,
  eod: 15 * 60 + 15,
  /** Skip when the NIFTY signal candle (high − low) is bigger than this. */
  maxCandlePts: 120,
  slippage: 0,
  /** Option pts above entry — recorded on the trade (table). Trail also uses these rungs. */
  targets: [10, 20, 30, 40, 50],
};

const r2 = (n) => Number(Number(n).toFixed(2));
const signedPts = (n) => `${n >= 0 ? '+' : ''}${r2(n)}`;
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const span = (c) => `${hhmm(c.start)}–${hhmm(c.end + 1)}`;

/** Option trail lock (pts above entry): +10→+2, +20→+10, then peak−10 carry-forward. */
function trailLock(gain) {
  if (gain >= 20) return Math.max(10, Math.floor(gain) - 10);
  if (gain >= 10) return 2;
  return null;
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
  SL: 'NIFTY SL (TF close)',
  TRAIL: 'Option trail lock',
  FLIP: 'Opposite zone — flip',
  EOD: 'Day close',
  OPEN: 'Still open (marked)',
};

function exitReason(type, tf) {
  if (type === 'SL') return `NIFTY SL (${tf}-min close)`;
  return EXIT_REASON[type] || type;
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const years = {};
  const dayPnl = {};
  const exits = { SL: 0, TRAIL: 0, FLIP: 0, EOD: 0, OPEN: 0 };
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

function simulateDay({ day, dayCandles, nifty, rule, qty, lastMin, isToday, trades, skipped }) {
  const tf = rule.timeframe;
  const tfLabel = `${tf}-min`;
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
  const endMin = Math.min(rule.eod, lastMin + 1);
  const month = Number(day.dateKey.slice(5, 7));
  let pos = null;
  let taken = 0;

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
    if (!px) return skip(`no ${strike} ${side} price at ${hhmm(m)}`);

    const entryPremium = r2(px.price + rule.slippage);
    const entrySpot = r2(nifty.get(px.min)?.o ?? spot);
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
      startMin: px.min,
      entryPremium,
      entrySpot,
      stopSpot,
      riskPts,
      trailLockPts: null,
      high: { px: entryPremium, min: px.min },
      low: { px: entryPremium, min: px.min },
      levels,
      last: entryPremium,
      events: [
        {
          time: hhmm(sc.end + 1),
          text: pe
            ? `SELL zone on ${span(sc)}: bearish FVG + strong body on prior bar + close ${fmt(sc.c)} below last swing low ${fmt(bos)}`
            : `BUY zone on ${span(sc)}: bullish FVG + strong body on prior bar + close ${fmt(sc.c)} above last swing high ${fmt(bos)}`,
        },
        {
          time: hhmm(sc.end + 1),
          text: `NIFTY ${tfLabel} ${span(sc)} O ${fmt(sc.o)} H ${fmt(sc.h)} L ${fmt(sc.l)} C ${fmt(sc.c)} · size ${candlePts} pts · swing H ${fmt(sc.lastPh)} / L ${fmt(sc.lastPl)}`,
        },
        {
          time: hhmm(px.min),
          text: `Bought ${strike} ${side} at ₹${fmt(entryPremium)} · NIFTY ${fmt(entrySpot)} · SL ${fmt(stopSpot)} (signal ${pe ? 'high' : 'low'}, exit only on later ${tfLabel} *close*) · trail +10→+2 / +20→+10 / then peak−10`,
        },
      ],
    };
  };

  const markPath = (p, m, bar) => {
    if (!bar) return;
    const hi = m === p.startMin ? Math.max(p.entryPremium, bar.h) : bar.h;
    const lo = m === p.startMin ? Math.min(p.entryPremium, bar.l) : bar.l;
    if (hi > p.high.px) p.high = { px: hi, min: m };
    if (lo < p.low.px) p.low = { px: lo, min: m };
    for (const lv of p.levels) {
      if (!lv.hit && hi >= lv.premium) Object.assign(lv, { hit: true, time: hhmm(m) });
    }
    const next = trailLock(hi - p.entryPremium);
    if (next != null && (p.trailLockPts == null || next > p.trailLockPts)) {
      p.trailLockPts = next;
      p.events.push({
        time: hhmm(m),
        text: `Trail armed / raised → lock +${next} pts (option ₹${fmt(p.entryPremium + next)}) · peak ${signedPts(hi - p.entryPremium)}`,
      });
    }
    p.last = bar.c;
  };

  const close = (p, fill, min, type, text, exitSpotIn) => {
    const exitPremium = r2(Math.max(0.05, (fill ? fill.price : p.last) - rule.slippage));
    const exitMin = fill?.min ?? min;
    if (exitPremium > p.high.px) p.high = { px: exitPremium, min: exitMin };
    if (exitPremium < p.low.px) p.low = { px: exitPremium, min: exitMin };
    for (const lv of p.levels) {
      if (!lv.hit && exitPremium >= lv.premium) Object.assign(lv, { hit: true, time: hhmm(exitMin) });
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
    p.events.push({ time: hhmm(exitMin), text: `${text} → sold ${p.strike} ${p.side} at ₹${fmt(exitPremium)} · ${points >= 0 ? '+' : ''}${points} pts · NIFTY ${fmt(exitSpot)}` });
    p.events.push({
      time: hhmm(exitMin),
      text: `Option path: high ₹${fmt(highPx)} (${signedPts(maxGainPts)}) at ${hhmm(p.high.min)} · low ₹${fmt(lowPx)} (${signedPts(maxDropPts)}) at ${hhmm(p.low.min)} · trail lock ${p.trailLockPts == null ? '—' : `+${p.trailLockPts}`} · levels ${(p.levels || []).map((l) => `+${l.pts}${l.hit ? ` ${l.time}` : ' no'}`).join(' · ') || 'none'}`,
    });
    const sc = p.sc;
    trades.push({
      id: `${day.dateKey}-${hhmm(p.startMin)}-${p.side}-${p.strike}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
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
      stop: p.stopSpot,
      trailLockPts: p.trailLockPts,
      trailStop: p.trailLockPts == null ? null : r2(p.entryPremium + p.trailLockPts),
      entryTime: hhmm(p.startMin),
      entrySpot: p.entrySpot,
      entryPremium: p.entryPremium,
      targetLevels: p.levels.map((l) => ({ ...l, premium: r2(l.premium) })),
      highAfterEntry: highPx,
      highAfterTime: hhmm(p.high.min),
      maxGainPts,
      lowAfterEntry: lowPx,
      lowAfterTime: hhmm(p.low.min),
      maxDropPts,
      peakPremium: highPx,
      lowPremium: lowPx,
      exitTime: hhmm(exitMin),
      exitSpot,
      niftyPts: r2(p.side === 'CE' ? exitSpot - p.entrySpot : p.entrySpot - exitSpot),
      exitPremium,
      exitType: type,
      exitReason: exitReason(type, tf),
      timeframe: tf,
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
    if (!pos || m < pos.startMin) continue;

    const b = pos.book.get(m);
    if (b) markPath(pos, m, b);

    // Option trail — on 1-min strike premium (touch lock → exit)
    if (pos.trailLockPts != null && b) {
      const lockPx = r2(pos.entryPremium + pos.trailLockPts);
      if (b.l <= lockPx) {
        const price = b.o <= lockPx ? b.o : lockPx;
        close(pos, { min: m, price }, m, 'TRAIL', `Option trailed to lock ₹${fmt(lockPx)} (+${pos.trailLockPts} pts) at ${hhmm(m)}`);
        pos = null;
        continue;
      }
    }

    // NIFTY SL — only when a *completed* TF candle closes through the stop (not wick touch)
    const closed = candleCloseAt.get(m);
    if (closed && closed.start !== pos.sc.start) {
      const pe = pos.side === 'PE';
      const slClose = pe ? closed.c >= pos.stopSpot : closed.c <= pos.stopSpot;
      if (slClose) {
        const fill = priceAt(pos.book, m, 0) || (b ? { min: m, price: b.o } : null) || priceAt(pos.book, m, 3);
        close(
          pos,
          fill,
          m,
          'SL',
          `NIFTY ${tfLabel} ${span(closed)} closed at ${fmt(closed.c)} ${pe ? '≥' : '≤'} SL ${fmt(pos.stopSpot)} (wick alone does not cut)`,
          r2(closed.c),
        );
        pos = null;
      }
    }
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
  const timeframe = Number(ruleIn.timeframe) === 5 ? 5 : 15;
  const rule = {
    ...DEFAULT_RULE,
    ...ruleIn,
    timeframe,
    // First entries after one full TF bar from open (5→09:20, 15→09:30) unless caller overrides.
    entryFrom: Number.isFinite(ruleIn.entryFrom) ? ruleIn.entryFrom : OPEN + timeframe,
  };
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
    rule: {
      ...rule,
      entryFrom: hhmm(rule.entryFrom),
      entryTo: hhmm(rule.entryTo),
      eod: hhmm(rule.eod),
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
    const live = await ensureDays(fetchFrom, chunk.to, { onProgress: report });
    const days = (await loadDays(fetchFrom, chunk.to, live)).filter((d) => d.dateKey <= chunk.to);
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
      const taken = simulateDay({
        day,
        dayCandles: byDay.get(day.dateKey) || [],
        nifty: minuteMap(day.nifty),
        rule,
        qty,
        lastMin,
        isToday,
        trades,
        skipped: skippedSignals,
      });
      if (!taken) flatDays.push(day.dateKey);
    });
    tradingDays += simDays.length;
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START, trailLock };
