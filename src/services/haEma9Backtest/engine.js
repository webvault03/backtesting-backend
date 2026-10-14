/**
 * Heikin Ashi EMA 9 stretch — historical backtest on NIFTY 15-min Heikin Ashi candles, traded in the ATM option.
 *
 * Signal (closed candles only):
 *   EMA 9 on the Heikin Ashi close, candles chained across days like the chart.
 *   PE: the first red HA candle of a run that sits fully above EMA 9 (its HA low does not touch the line).
 *   CE: the first green HA candle of a run that sits fully below EMA 9 (its HA high does not touch the line).
 *   A run resets when a candle touches / crosses EMA 9.
 * Execution:
 *   Buy the ATM option at the open of the first minute after the signal candle closes. One trade per day.
 *   Optional big-candle filter: skip the signal when its HA high − low exceeds `maxCandlePts` (the day's trade stays free).
 *   Optional NIFTY stop (niftySl): PE → signal candle real NIFTY high, CE → real NIFTY low. Checked first every minute
 *   on NIFTY 1-min bars; when NIFTY trades through it the option is sold at the next minute open (that minute's open
 *   when NIFTY opened beyond the stop).
 *   Option-price exits, each on its own switch:
 *   - trail (default on): best +10 → lock +5 (still +5 at +15), then every +10 → lock 10 below it
 *     (+20 → +10, +30 → +20, +40 → +30 …). A new lock is used from the next minute; falling to it sells at the
 *     lock (that minute's open if it opened below).
 *   - useTarget (default off = no target): entry + `target` option points (default 10); sold at the target
 *     (that minute's open when the option opened above it).
 *   Anything open is sold at `eod`.
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
  timeframe: 15,
  emaLength: 9,
  lotSize: 65,
  /** Signal candle must close at or before this minute (entry the minute after). */
  entryTo: 15 * 60,
  eod: 15 * 60 + 15,
  maxTradesPerDay: 1,
  /** Stop loss on NIFTY at the signal candle's real high (PE) / low (CE). */
  niftySl: false,
  /** Trail the option profit (see trailLock). */
  trail: true,
  /** Fixed target in option points above the buy price; off = no target. Works with or without the trail. */
  useTarget: false,
  target: 10,
  /** When on, a signal candle whose HA high − low is above maxCandlePts (NIFTY pts) is not traded. */
  skipBigCandle: false,
  maxCandlePts: 40,
  slippage: 0,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const span = (c) => `${hhmm(c.start)}–${hhmm(c.end + 1)}`;

/** Locked option points for a best gain: <10 → none, 10–19.99 → 5, then floor to 10s minus 10 (20 → 10, 30 → 20 …). */
function trailLock(gain) {
  if (gain < 10) return null;
  if (gain < 20) return 5;
  return Math.floor(gain / 10) * 10 - 10;
}

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

/** Heikin Ashi (chained across days) + EMA on the HA close. Real OHLC kept as ro/rh/rl/rc. */
function haWithEma(candles, length) {
  const k = 2 / (length + 1);
  let prev = null;
  let ema = null;
  return candles.map((c, i) => {
    const close = (c.o + c.h + c.l + c.c) / 4;
    const open = prev ? (prev.o + prev.c) / 2 : (c.o + c.c) / 2;
    ema = ema == null ? close : close * k + ema * (1 - k);
    const ha = {
      ...c,
      ro: c.o,
      rh: c.h,
      rl: c.l,
      rc: c.c,
      o: open,
      h: Math.max(c.h, open, close),
      l: Math.min(c.l, open, close),
      c: close,
      ema: i >= length - 1 ? ema : null,
    };
    prev = ha;
    return ha;
  });
}

/**
 * Marks signal candles: sig = 'PE' | 'CE' on the first red-above / green-below candle of each run.
 * A candle touching EMA 9 (low ≤ EMA ≤ high) ends the run.
 */
function markSignals(candles) {
  let usedAbove = false;
  let usedBelow = false;
  for (const c of candles) {
    c.sig = null;
    if (c.ema == null) continue;
    const above = c.l > c.ema;
    const below = c.h < c.ema;
    if (!above) usedAbove = false;
    if (!below) usedBelow = false;
    if (above && c.c < c.o && !usedAbove) {
      c.sig = 'PE';
      usedAbove = true;
    } else if (below && c.c > c.o && !usedBelow) {
      c.sig = 'CE';
      usedBelow = true;
    }
  }
  return candles;
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
  const wins = trades.filter((t) => t.isWin);
  const losses = trades.filter((t) => !t.isWin);
  const grossWin = wins.reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.netPnL, 0);
  const charges = trades.reduce((s, t) => s + t.charges, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    netPnL: r2(equity),
    charges: r2(charges),
    avgCharges: trades.length ? r2(charges / trades.length) : 0,
    maxDrawdown: r2(maxDd),
    profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : null,
    worstTrade: trades.length ? r2(Math.min(...trades.map((t) => t.netPnL))) : 0,
    bestTrade: trades.length ? r2(Math.max(...trades.map((t) => t.netPnL))) : 0,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
    years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
  };
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
    rule: { ...rule, entryTo: hhmm(rule.entryTo), eod: hhmm(rule.eod) },
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
    const candles = markSignals(haWithEma(closed, rule.emaLength));
    const byDay = new Map();
    for (const c of candles) {
      if (!byDay.has(c.dateKey)) byDay.set(c.dateKey, []);
      byDay.get(c.dateKey).push(c);
    }

    const simDays = days.filter((d) => d.dateKey >= chunk.from);
    simDays.forEach((day, di) => {
      report({ phase: 'simulate', done: di, total: simDays.length, dateKey: day.dateKey });
      const nifty = minuteMap(day.nifty);
      const dayCandles = byDay.get(day.dateKey) || [];
      const isToday = day.dateKey === now.dateKey;
      const lastMin = Math.max(...day.nifty.m.filter((m) => m <= LAST && (!isToday || m < now.minutes)), OPEN);
      let taken = 0;

      for (let ci2 = 0; ci2 < dayCandles.length; ci2 += 1) {
        const sc = dayCandles[ci2];
        if (!sc.sig) continue;
        const entryMin = sc.end + 1;
        const side = sc.sig;
        const skip = (reason) => skippedSignals.push({ dateKey: day.dateKey, time: span(sc), side, reason });
        if (taken >= rule.maxTradesPerDay) {
          skip(`already ${rule.maxTradesPerDay} trade today`);
          continue;
        }
        if (entryMin > rule.entryTo) {
          skip(`candle closes after ${hhmm(rule.entryTo)}`);
          continue;
        }
        const candlePts = r2(sc.h - sc.l);
        if (rule.skipBigCandle && candlePts > rule.maxCandlePts) {
          skip(`big candle ${candlePts} pts (max ${rule.maxCandlePts})`);
          continue;
        }
        const spot = nifty.get(entryMin)?.o;
        if (!Number.isFinite(spot)) {
          skip(`no NIFTY bar at ${hhmm(entryMin)}`);
          continue;
        }
        const strike = Math.round(spot / STEP) * STEP;
        const book = minuteMap(day[side]?.[String(strike)]);
        const px = priceAt(book, entryMin, 3);
        if (!px) {
          skip(`no ${strike} ${side} price at ${hhmm(entryMin)}`);
          continue;
        }
        taken += 1;

        const pe = side === 'PE';
        const entryPremium = r2(px.price + rule.slippage);
        const entrySpot = r2(nifty.get(px.min)?.o ?? spot);
        const targetPx = rule.useTarget ? r2(entryPremium + rule.target) : null;
        const stop = rule.niftySl ? (pe ? sc.rh : sc.rl) : null;
        const risk = stop != null ? r2(Math.abs(stop - entrySpot)) : null;
        let lockPts = null;
        let lockPx = null;
        const events = [
          {
            time: hhmm(entryMin),
            text: `15-min Heikin Ashi candle ${span(sc)} closed ${pe ? 'RED' : 'GREEN'} (HA O ${fmt(sc.o)} C ${fmt(sc.c)} · H ${fmt(sc.h)} L ${fmt(sc.l)}) fully ${pe ? `above EMA 9 ${fmt(sc.ema)} (low ${fmt(sc.l)} not touching)` : `below EMA 9 ${fmt(sc.ema)} (high ${fmt(sc.h)} not touching)`}`,
          },
          {
            time: hhmm(px.min),
            text: `Bought ${strike} ${side} (ATM) at the ${hhmm(px.min)} open ₹${fmt(entryPremium)} · NIFTY ${fmt(entrySpot)} · ${rule.trail ? 'trail: +10 → lock +5, +20 → +10, +30 → +20 …' : 'no trail'} · ${targetPx != null ? `target +${rule.target} option pts = ₹${fmt(targetPx)}` : 'no target'} · ${stop != null ? `SL on NIFTY ${fmt(stop)} = signal candle ${pe ? 'high' : 'low'} (risk ${fmt(risk)} NIFTY pts)` : 'no stop loss'}`,
          },
        ];

        let peak = entryPremium;
        let low = entryPremium;
        let last = entryPremium;
        let exit = null;
        const endMin = Math.min(rule.eod, lastMin + 1);
        for (let m = px.min; m < endMin; m += 1) {
          const n = stop != null ? nifty.get(m) : null;
          if (n) {
            const gapped = pe ? n.o >= stop : n.o <= stop;
            const touched = pe ? n.h >= stop : n.l <= stop;
            if (gapped || touched) {
              const fill = gapped ? priceAt(book, m) : priceAt(book, m + 1);
              exit = {
                fill,
                min: fill?.min ?? m,
                type: 'SL',
                text: `NIFTY ${gapped ? `opened ${hhmm(m)} at ${fmt(n.o)}` : `${pe ? 'rose' : 'fell'} to ${fmt(pe ? n.h : n.l)} at ${hhmm(m)}`} → stop loss ${fmt(stop)} hit`,
              };
              break;
            }
          }
          const b = book.get(m);
          if (!b) continue;
          if (rule.trail) {
            if (lockPx != null && b.l <= lockPx) {
              const price = b.o <= lockPx ? b.o : lockPx;
              low = Math.min(low, price);
              exit = { fill: { min: m, price }, min: m, type: 'TRAIL', text: `Option fell back to the trailing lock ₹${fmt(lockPx)} (+${lockPts} pts, best ₹${fmt(peak)})` };
              break;
            }
            const gain = b.h - entryPremium;
            const pts = trailLock(gain);
            if (pts != null && (lockPts == null || pts > lockPts)) {
              lockPts = pts;
              lockPx = r2(entryPremium + pts);
              events.push({ time: hhmm(m), text: `Option high ₹${fmt(b.h)} (+${r2(gain)} pts) → trailing lock +${pts} pts = ₹${fmt(lockPx)}` });
            }
          }
          if (targetPx != null && b.h >= targetPx) {
            const price = m > px.min && b.o >= targetPx ? b.o : targetPx;
            peak = Math.max(peak, b.h);
            low = Math.min(low, b.o, price);
            exit = { fill: { min: m, price }, min: m, type: 'TARGET', text: `Option reached ₹${fmt(b.h)} → target ₹${fmt(targetPx)} (+${rule.target} pts) hit` };
            break;
          }
          peak = Math.max(peak, b.h);
          low = Math.min(low, b.l);
          last = b.c;
        }
        if (!exit) {
          const open = isToday && lastMin + 1 < rule.eod;
          const fill = open ? null : priceAt(book, rule.eod);
          exit = {
            fill,
            min: open ? lastMin : (fill?.min ?? rule.eod),
            type: open ? 'OPEN' : 'EOD',
            text: open ? `Trade still open — marked at the ${hhmm(lastMin)} price` : `${hhmm(rule.eod)} day close`,
          };
        }
        const exitPremium = r2(Math.max(0.05, (exit.fill ? exit.fill.price : last) - rule.slippage));
        const exitSpot = r2(nifty.get(exit.min)?.o ?? nifty.get(exit.min - 1)?.c ?? entrySpot);
        const points = r2(exitPremium - entryPremium);
        const grossPnL = r2(points * qty);
        const charges = optionCharges(entryPremium * qty, exitPremium * qty);
        const netPnL = r2(grossPnL - charges);
        events.push({ time: hhmm(exit.min), text: `${exit.text} → sold ${strike} ${side} at ₹${fmt(exitPremium)} · ${points >= 0 ? '+' : ''}${points} pts` });
        const month = Number(day.dateKey.slice(5, 7));
        trades.push({
          id: `${day.dateKey}-${hhmm(px.min)}-${side}-${strike}`,
          date: day.dateKey,
          monthKey: day.dateKey.slice(0, 7),
          monthShort: MONTHS[month - 1],
          side,
          strike,
          signalTime: span(sc),
          signalCandle: { o: r2(sc.o), h: r2(sc.h), l: r2(sc.l), c: r2(sc.c), ro: r2(sc.ro), rh: r2(sc.rh), rl: r2(sc.rl), rc: r2(sc.rc) },
          candlePts,
          ema: r2(sc.ema),
          gapFromEma: r2(side === 'PE' ? sc.l - sc.ema : sc.ema - sc.h),
          stop: stop != null ? r2(stop) : null,
          riskPts: risk,
          targetPremium: targetPx,
          lockPts,
          lockPremium: lockPx,
          entryTime: hhmm(px.min),
          entrySpot,
          entryPremium,
          peakPremium: r2(Math.max(peak, exitPremium)),
          lowPremium: r2(Math.min(low, exitPremium)),
          maxGainPts: r2(Math.max(peak, exitPremium) - entryPremium),
          exitTime: hhmm(exit.min),
          exitSpot,
          niftyPts: r2(side === 'CE' ? exitSpot - entrySpot : entrySpot - exitSpot),
          exitPremium,
          exitType: exit.type,
          exitReason: { SL: 'Stop loss (NIFTY)', TARGET: `Target +${rule.target}`, TRAIL: `Trailing lock +${lockPts}`, EOD: `${hhmm(rule.eod)} close`, OPEN: 'Still open (marked)' }[exit.type],
          points,
          grossPnL,
          charges,
          netPnL,
          isWin: netPnL > 0,
          events,
        });
      }
      if (!taken) flatDays.push(day.dateKey);
    });
    tradingDays += simDays.length;
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START };
