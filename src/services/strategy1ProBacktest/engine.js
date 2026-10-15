/**
 * Strategy 1 Pro — "big player" version (see config.js).
 *
 * Setups on closed NIFTY 5-min candles (opening range = 09:15–09:45, entries on candles closing 09:50–14:00):
 *   Breakout — first close above ORB high + 3 (green, body ≥ 8, close ≥ VWAP) → CE; mirror below ORB low → PE.
 *   Trap — Spring: low below ORB low, close back inside, long lower wick → CE; Upthrust mirror → PE.
 * Confirmation: option OI at signal time must show writing / unwinding the trade's way and no opposing writing at
 *   ATM. No trades on extreme India VIX days. Max 2 trades a day, one at a time.
 * Exits on NIFTY: stop beyond the signal candle (10–25 pts) · +20 → stop to entry · +30 → 50% sold · runner trails
 *   behind the low (CE) / high (PE) of the last 3 closed 5-min candles · +80 → runner sold · 15:15 square-off.
 *
 * No look-ahead: while a trade is open each 5-min candle is replayed on Dhan's 1-minute NIFTY candles (stop first
 * inside a minute; a stop moved in a minute counts from the next minute; the trail moves only when a 5-min candle has
 * closed). The option is bought at the open of the minute the signal candle closes; every sale is at the option's
 * open of the minute after NIFTY reached the level. Costs per order leg (brokerage, STT, exchange, SEBI, stamp, GST).
 */
const { loadCandles, loadVixDaily, TF } = require('./dataSource');
const { ensureDays, loadDays, addDays } = require('../oiCandleAgreeBacktest/dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { tradeCosts } = require('./costs');
const { VERSION, HISTORY_START, DEFAULT_RULE, COSTS, FILTERS, lotSizeOn } = require('./config');

const STEP = 50;
const LAST = 15 * 60 + 29;
const NO_VOLUME = 100000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const span = (b) => `${hhmm(b.min)}–${hhmm(b.min + TF)}`;
const fmt = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const pct = (n) => `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`;

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

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], c: series.c[i], oi: series.oi?.[i] || 0 }));
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

/** Breakout or trap on closed candle i. Returns { side, setup } or null. */
function setupAt(c, i, orb, vwap, rule) {
  const b = c[i];
  const p = c[i - 1];
  const body = Math.abs(b.c - b.o);
  const lowerWick = Math.min(b.o, b.c) - b.l;
  const upperWick = b.h - Math.max(b.o, b.c);
  const up = orb.high + rule.breakoutBuffer;
  const dn = orb.low - rule.breakoutBuffer;
  const breakUp = b.c > up && p.c <= up && b.c > b.o && body >= rule.breakoutBody && b.c >= vwap;
  const breakDown = b.c < dn && p.c >= dn && b.c < b.o && body >= rule.breakoutBody && b.c <= vwap;
  const spring = b.l < orb.low && b.c >= orb.low && lowerWick >= 1.4 * body && b.c < vwap + 5;
  const upthrust = b.h > orb.high && b.c <= orb.high && upperWick >= 1.4 * body && b.c > vwap - 5;
  const buy = breakUp ? 'ORB breakout' : spring ? 'Spring (trap)' : null;
  const sell = breakDown ? 'ORB breakdown' : upthrust ? 'Upthrust (trap)' : null;
  if (buy && sell) return null;
  if (buy) return { side: 'BUY', setup: buy };
  if (sell) return { side: 'SELL', setup: sell };
  return null;
}

/**
 * OI from minutes up to `end` (the signal candle's last minute) vs `end − 15`. CE signal: put writing below spot
 * (PE OI at ATM, −50, −100 up ≥ 2%, premium down) or call unwinding (CE OI at ATM, +50, +100 down ≥ 2%, premium up);
 * rejected on call writing at ATM (CE OI at ATM, +50 up ≥ 2%, premium down). PE signal: mirror.
 */
function oiEvidence(bookFor, side, strike, end) {
  const F = FILTERS.oi;
  const dir = side === 'BUY' ? 1 : -1;
  const look = (opt, k, m) => {
    const book = bookFor(opt, k);
    for (let x = m; x >= m - F.maxAgeMin; x -= 1) {
      const v = book.get(x);
      if (v && v.oi > 0) return v;
    }
    return null;
  };
  const group = (opt, strikes) => {
    const g = { oi0: 0, oi1: 0, p0: 0, p1: 0 };
    for (const k of strikes) {
      const a = look(opt, k, end - F.windowMin);
      const b = look(opt, k, end);
      if (!a || !b) return null;
      g.oi0 += a.oi;
      g.oi1 += b.oi;
      g.p0 += a.c;
      g.p1 += b.c;
    }
    return { chg: (g.oi1 - g.oi0) / g.oi0, px: g.p1 - g.p0 };
  };
  const supOpt = dir > 0 ? 'PE' : 'CE';
  const oppOpt = dir > 0 ? 'CE' : 'PE';
  const sup = group(supOpt, [strike, strike - dir * STEP, strike - dir * 2 * STEP]);
  const opp = group(oppOpt, [strike, strike + dir * STEP, strike + dir * 2 * STEP]);
  const near = group(oppOpt, [strike, strike + dir * STEP]);
  if (!sup || !opp || !near) return { ok: false, reason: 'OI not available at signal time', text: 'OI not available at signal time' };
  const writing = sup.chg >= F.minChange && sup.px < 0;
  const unwinding = opp.chg <= -F.minChange && opp.px > 0;
  const opposing = near.chg >= F.minChange && near.px < 0;
  const text = `OI ${hhmm(end - F.windowMin)}→${hhmm(end)}: ${supOpt} writing ${pct(sup.chg)}${writing ? ' ✓' : ''} · ${oppOpt} unwinding ${pct(opp.chg)}${unwinding ? ' ✓' : ''} · ${oppOpt} ATM writing ${pct(near.chg)}${opposing ? ' ✗' : ''}`;
  if (opposing) return { ok: false, reason: 'opposing OI writing at ATM', text };
  if (!writing && !unwinding) return { ok: false, reason: 'no OI confirmation', text };
  return { ok: true, text };
}

const EXIT_REASON = {
  TARGET: 'NIFTY +80 — runner target',
  TRAIL: 'Runner stopped by the trail',
  BE: 'Breakeven stop (after +20)',
  SL: 'Stop loss',
  EOD: '15:15 square-off',
  OPEN: 'Still open (marked at last price)',
};

function eodExit(t, b, rule) {
  if (b.min < rule.eod) return null;
  t.events.push({ time: hhmm(rule.eod), text: `15:15 — square-off of everything still open (NIFTY ${fmt(b.o)})` });
  return { type: 'EOD', px: b.o, min: b.min - 1 };
}

/** Stop / breakeven / 50% / target on one NIFTY candle; the stop in force at its open is checked first. */
function step(t, b, rule, len) {
  const dir = t.side === 'BUY' ? 1 : -1;
  const time = `${hhmm(b.min)}–${hhmm(b.min + len)}`;
  const lastMin = b.min + len - 1;
  const reached = (pts) => (dir > 0 ? b.h >= t.entry + pts : b.l <= t.entry - pts);
  const stopTouched = dir > 0 ? b.l <= t.stop : b.h >= t.stop;
  if (stopTouched) {
    t.events.push({ time, text: `NIFTY ${dir > 0 ? `low ${fmt(b.l)}` : `high ${fmt(b.h)}`} reached the stop ${fmt(t.stop)}` });
    return { type: t.t1Hit ? 'TRAIL' : t.be ? 'BE' : 'SL', px: t.stop, min: lastMin };
  }
  const lock = (level) => {
    if (dir > 0 ? level > t.stop : level < t.stop) t.stop = level;
  };
  if (!t.be && reached(rule.breakevenAt)) {
    t.be = true;
    lock(t.entry);
    t.events.push({ time, text: `NIFTY +${rule.breakevenAt} → stop moved to entry ${fmt(t.stop)}` });
  }
  if (!t.t1Hit && reached(rule.t1Pts)) {
    t.t1Hit = true;
    t.be = true;
    lock(t.entry);
    t.scalp = sellAt(t.book, lastMin);
    t.events.push({
      time,
      text: `NIFTY +${rule.t1Pts} → sold ${t.q.scalp} qty ${t.strike} ${t.option} at ${t.scalp ? `₹${fmt(t.scalp.price)} (${hhmm(t.scalp.min)})` : '—'} · runner ${t.q.runner} qty now trails behind the last ${rule.trailCandles} candles`,
    });
  }
  if (t.t1Hit && reached(rule.targetPts)) {
    t.events.push({ time, text: `NIFTY +${rule.targetPts} → runner target` });
    return { type: 'TARGET', px: t.entry + dir * rule.targetPts, min: lastMin };
  }
  return null;
}

/** One 5-min candle of management; after it closes the runner's trail may move. */
function manage(t, c, i, rule) {
  const b = c[i];
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
  if (t.t1Hit) {
    const dir = t.side === 'BUY' ? 1 : -1;
    const last = c.slice(Math.max(0, i - rule.trailCandles + 1), i + 1);
    const trail = dir > 0 ? Math.min(...last.map((k) => k.l)) : Math.max(...last.map((k) => k.h));
    if (dir > 0 ? trail > t.stop : trail < t.stop) {
      t.stop = trail;
      t.events.push({ time: hhmm(b.min + TF), text: `Trail: stop raised to ${fmt(trail)} (${dir > 0 ? 'low' : 'high'} of the last ${rule.trailCandles} candles)` });
    }
  }
  return null;
}

function finishTrade(t, x, dateKey, brokerage) {
  const dir = t.side === 'BUY' ? 1 : -1;
  const sale = sellAt(t.book, x.min) || { min: x.min, price: t.premium, late: true };
  const scalp = t.t1Hit ? t.scalp || sale : null;
  const legs = [{ side: 'BUY', price: t.premium, qty: t.q.total }];
  if (t.t1Hit) {
    legs.push({ side: 'SELL', price: scalp.price, qty: t.q.scalp });
    if (t.q.runner > 0) legs.push({ side: 'SELL', price: sale.price, qty: t.q.runner });
  } else {
    legs.push({ side: 'SELL', price: sale.price, qty: t.q.total });
  }
  const pnl = tradeCosts(dateKey, legs, { brokerage });
  const month = Number(dateKey.slice(5, 7));
  return {
    id: `${dateKey}-${t.entryTime}-${t.option}-${t.strike}`,
    date: dateKey,
    monthKey: dateKey.slice(0, 7),
    monthShort: MONTHS[month - 1],
    side: t.side,
    option: t.option,
    strike: t.strike,
    setup: t.setup,
    signalCandle: t.signal,
    orb: t.orb,
    vwap: t.vwap,
    oi: t.oi,
    vix: t.vix,
    q: t.q,
    lotSize: t.lotSize,
    entryTime: hhmm(t.buyMin),
    entry: r2(t.entry),
    stopInit: t.stopInit,
    slPts: t.slPts,
    entryPremium: r2(t.premium),
    scalpPremium: scalp ? r2(scalp.price) : null,
    exitPremium: r2(sale.price),
    t1Hit: t.t1Hit,
    exitTime: hhmm(sale.min),
    exit: r2(x.px),
    exitType: x.type,
    exitReason: EXIT_REASON[x.type],
    niftyPts: r2(dir * (x.px - t.entry)),
    points: r2(pnl.gross / t.q.total),
    grossPnL: pnl.gross,
    costs: pnl.costs,
    charges: pnl.total,
    netPnL: pnl.net,
    isWin: pnl.net > 0,
    stale: Boolean(sale.late || scalp?.late),
    delayed: Boolean(t.buyDelayed || sale.delayed || scalp?.delayed),
    events: [
      ...t.events,
      {
        time: hhmm(sale.min),
        text: `Sold ${t.q[t.t1Hit ? 'runner' : 'total']} qty ${t.strike} ${t.option} at ₹${fmt(sale.price)} (${hhmm(sale.min)}${sale.late ? ' STALE last price' : ''}) — ${EXIT_REASON[x.type]} · gross ₹${fmt(pnl.gross)} − ₹${fmt(pnl.total)} costs = ₹${fmt(pnl.net)}`,
      },
    ],
  };
}

function simulateDay(d, rule, brokerage, trades) {
  const { c, orb, vwap } = d;
  let t = null;
  let count = 0;
  for (let i = 1; i < c.length; i += 1) {
    const b = c[i];
    if (t) {
      const x = manage(t, c, i, rule);
      if (x) {
        trades.push(finishTrade(t, x, d.dateKey, brokerage));
        t = null;
      }
      continue;
    }
    if (count >= rule.maxTradesPerDay || d.vix.state === 'extreme') continue;
    if (b.min < rule.entryFrom || b.min + TF > rule.entryTo) continue;
    const s = setupAt(c, i, orb, vwap[i], rule);
    if (!s) continue;
    const dir = s.side === 'BUY' ? 1 : -1;
    const option = dir > 0 ? 'CE' : 'PE';
    const strike = Math.round(b.c / STEP) * STEP;
    const book = d.bookFor(option, strike);
    const buy = openAt(book, b.min + TF, 2);
    if (!buy) continue;
    const oi = oiEvidence(d.bookFor, s.side, strike, b.min + TF - 1);
    if (!oi.ok) continue;
    const raw = dir > 0 ? b.l - rule.slBuffer : b.h + rule.slBuffer;
    const slPts = Math.min(rule.slMax, Math.max(rule.slMin, Math.abs(b.c - raw)));
    const stop = b.c - dir * slPts;
    count += 1;
    t = {
      side: s.side,
      option,
      strike,
      book,
      setup: s.setup,
      orb: { high: r2(orb.high), low: r2(orb.low) },
      vwap: r2(vwap[i]),
      oi: oi.text,
      vix: d.vix,
      signal: { time: span(b), o: r2(b.o), h: r2(b.h), l: r2(b.l), c: r2(b.c) },
      entry: b.c,
      premium: buy.price,
      buyMin: buy.min,
      buyDelayed: buy.delayed,
      stop,
      stopInit: r2(stop),
      slPts: r2(slPts),
      be: false,
      t1Hit: false,
      scalp: null,
      q: d.q,
      lotSize: d.lotSize,
      events: [
        { time: span(b), text: `${s.setup} on ${span(b)} (O ${fmt(b.o)} H ${fmt(b.h)} L ${fmt(b.l)} C ${fmt(b.c)}) · ORB ${fmt(orb.low)}–${fmt(orb.high)} · VWAP ${fmt(vwap[i])}` },
        { time: span(b), text: oi.text },
        {
          time: hhmm(buy.min),
          text: `Bought ${d.q.total} qty ${strike} ${option} at ₹${fmt(buy.price)} (${hhmm(buy.min)}) · NIFTY ${fmt(b.c)} · stop ${fmt(stop)} (${slPts.toFixed(1)} pts) · +${rule.breakevenAt} stop to entry · +${rule.t1Pts} sell ${d.q.scalp} · trail runner · +${rule.targetPts} target`,
        },
      ],
    };
  }
  if (t) {
    const last = c[c.length - 1];
    trades.push(finishTrade(t, { type: 'OPEN', px: last.c, min: last.min + TF - 1 }, d.dateKey, brokerage));
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

async function loadVix(from, to) {
  const V = FILTERS.vix;
  try {
    const start = addDays(from, -10) < V.trainFrom ? addDays(from, -10) : V.trainFrom;
    const map = await loadVixDaily(start, to);
    const train = [...map].filter(([d]) => d >= V.trainFrom && d <= V.trainTo).map(([, v]) => v).sort((a, b) => a - b);
    if (train.length < 200) return { available: false };
    return { available: true, map, dates: [...map.keys()], extreme: percentile(train, V.extreme) };
  } catch {
    return { available: false };
  }
}

function vixOn(vix, dateKey) {
  if (!vix.available) return { prev: null, state: 'unknown' };
  let found = -1;
  let lo = 0;
  let hi = vix.dates.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (vix.dates[mid] < dateKey) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return { prev: null, state: 'unknown' };
  const prev = vix.map.get(vix.dates[found]);
  return { prev: r2(prev), state: prev > vix.extreme ? 'extreme' : 'normal' };
}

/**
 * @param {{ from: string, to: string, lots?: number, brokerage?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function, onPartial?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, brokerage = COSTS.brokeragePerOrder, rule: ruleIn = {}, onProgress, onPartial } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const lotCount = Math.max(1, Math.round(lots));
  const firstLots = Math.min(lotCount, Math.max(1, Math.round(lotCount * rule.t1Share)));
  const split = (lotSize) => ({ total: lotCount * lotSize, scalp: firstLots * lotSize, runner: (lotCount - firstLots) * lotSize });
  const trades = [];
  let tradingDays = 0;
  const vix = await loadVix(from, to);

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
    const live = await ensureDays(chunk.from, chunk.to, { onProgress: report });
    const options = new Map((await loadDays(chunk.from, chunk.to, live)).map((d) => [d.dateKey, d]));
    const days = await loadCandles(chunk.from, chunk.to);
    days.forEach((day, di) => {
      report({ phase: 'simulate', done: di, total: days.length, dateKey: day.dateKey });
      const c = day.candles;
      const orbBars = c.filter((x) => x.min < rule.entryFrom);
      const opt = options.get(day.dateKey);
      if (!orbBars.length || !opt) return;
      tradingDays += 1;
      const books = new Map();
      const lotSize = lotSizeOn(day.dateKey);
      simulateDay(
        {
          dateKey: day.dateKey,
          c,
          orb: { high: Math.max(...orbBars.map((x) => x.h)), low: Math.min(...orbBars.map((x) => x.l)) },
          vwap: vwapSeries(c),
          vix: vixOn(vix, day.dateKey),
          lotSize,
          q: split(lotSize),
          bookFor: (option, strike) => {
            const key = `${option}-${strike}`;
            if (!books.has(key)) books.set(key, minuteMap(opt[option]?.[String(strike)]));
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

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START, COSTS };
