/**
 * OI Strike Flow — backtest on Dhan history (nearest weekly NIFTY options, 1-minute OI + prices).
 *
 * Strikes: ATM from NIFTY's 09:15 open ± 5 strikes (11 strikes, like the OI Strike Report).
 * Flow: from 09:20 (the 09:15–09:19 OI is stale — Dhan catches up after the open), every finished
 *   5-minute block puts each leg's OI change in one bucket by its option price move:
 *   OI ↑ price ↓ = writing · OI ↑ price ↑ = long · OI ↓ price ↑ = short covering · OI ↓ price ↓ = long unwinding.
 * Signal, checked at each block close from 09:45 to the last signal time (only finished minutes):
 *   CE: put writing ≥ ratio × call writing · NIFTY above its 09:19 close · the heaviest put-writing strike is
 *       below NIFTY (support) · no heavy call writing on the 3 strikes around ATM.
 *   PE: the mirror image (call writing heavy, NIFTY below 09:19, resistance above, no heavy put writing near ATM).
 *   "Heavy" = at least 60% of that side's top strike, as on the report.
 * Entry: ATM option at the open of the minute the block closes. At most `maxTrades` per day, one at a time.
 * Exit: a NIFTY 1-min close through the support / resistance strike → next minute's open · option SL until the
 *   trail arms · Open OI Walls trail (+20/+30/+40/+50/+70 lock +10/+20/+25/+30/+50, from +40 also peak − 20) ·
 *   not armed within `unarmedMin` minutes → out · 15:15 close. Within a minute: stops before the high raises the lock.
 */
const { ensureDays, loadDays } = require('../openOiWallsBacktest/dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');
const { computeTrailLockPoints } = require('../../utils/openOiWallsTrail');
const { getIstClock } = require('../../utils/dateTime');

const HISTORY_START = '2020-08-03';
const STEP = 50;
const OPEN = 9 * 60 + 15;
const FLOW_FROM = 9 * 60 + 20;
const FIRST_SIGNAL = 9 * 60 + 45;
const BLOCK = 5;
const SPAN = 5;
const NEAR = 1;
const HEAVY_SHARE = 0.6;
const WARMUP_DAYS = 0;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  lotSize: 65,
  ratio: 1.5,
  maxTrades: 2,
  optSl: 25,
  unarmedMin: 60,
  lastSignal: 13 * 60,
  eod: 15 * 60 + 15,
  slippage: 0,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

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
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i], oi: series.oi?.[i] }));
  return out;
}

/** Last option bar with OI strictly before `minute`, or null. */
function lastBefore(book, minute, from = OPEN) {
  for (let m = minute - 1; m >= from; m -= 1) {
    const b = book.get(m);
    if (b && Number.isFinite(b.oi)) return b;
  }
  return null;
}

/** Last NIFTY bar strictly before `minute`, or null. */
function lastSpot(nifty, minute) {
  for (let m = minute - 1; m >= OPEN; m -= 1) {
    const b = nifty.get(m);
    if (b) return b;
  }
  return null;
}

/** Flow buckets for one leg over finished 5-min blocks in [FLOW_FROM, upTo). */
function legFlow(book, upTo) {
  const flow = { long: 0, writing: 0, shortCovering: 0, longUnwinding: 0 };
  let last = lastBefore(book, FLOW_FROM);
  for (let end = FLOW_FROM + BLOCK; end <= upTo; end += BLOCK) {
    const b = lastBefore(book, end, end - BLOCK);
    if (!b) continue;
    if (last) {
      const dOi = b.oi - last.oi;
      const dPx = b.c - last.c;
      if (dOi > 0 && dPx > 0) flow.long += dOi;
      else if (dOi > 0 && dPx < 0) flow.writing += dOi;
      else if (dOi < 0 && dPx > 0) flow.shortCovering -= dOi;
      else if (dOi < 0 && dPx < 0) flow.longUnwinding -= dOi;
    }
    last = b;
  }
  return flow;
}

const EXIT_REASON = {
  LEVEL: 'NIFTY closed through the writers’ strike',
  SL: 'Option stop loss',
  TRAIL: 'Trail lock',
  TIME: 'Not armed in time',
  EOD: 'Day close',
  OPEN: 'Still open (marked)',
};

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const years = {};
  const dayPnl = {};
  const exits = { LEVEL: 0, SL: 0, TRAIL: 0, TIME: 0, EOD: 0, OPEN: 0 };
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

/** Flow on the 11 strikes at block close `t` and the signal it gives (or why not). */
function readFlow({ books, strikes, nifty, baseSpot, t, rule }) {
  const spot = lastSpot(nifty, t)?.c;
  if (!Number.isFinite(spot)) return null;
  const rows = strikes.map((k) => ({
    strike: k,
    CE: books.CE.has(k) ? legFlow(books.CE.get(k), t) : null,
    PE: books.PE.has(k) ? legFlow(books.PE.get(k), t) : null,
  }));
  const total = (side) => rows.reduce((s, r) => s + (r[side]?.writing || 0), 0);
  const ceW = total('CE');
  const peW = total('PE');
  const topOf = (side) => rows.reduce((best, r) => ((r[side]?.writing || 0) > (best?.[side]?.writing || 0) ? r : best), null);
  const ceTop = topOf('CE');
  const peTop = topOf('PE');
  const atmNow = Math.round(spot / STEP) * STEP;
  const nearHeavy = (side) => {
    const top = (side === 'CE' ? ceTop : peTop)?.[side]?.writing || 0;
    if (!top) return null;
    return rows.find((r) => Math.abs(r.strike - atmNow) <= NEAR * STEP && (r[side]?.writing || 0) >= top * HEAVY_SHARE)?.strike ?? null;
  };
  const view = { t, spot: r2(spot), baseSpot: r2(baseSpot), ceWriting: ceW, peWriting: peW, ceTop: ceTop?.strike ?? null, peTop: peTop?.strike ?? null, rows };

  if (peW > 0 && peW >= rule.ratio * ceW) {
    if (!(spot > baseSpot)) return { ...view, why: `put writing ${ratioText(peW, ceW)} × call but NIFTY not above 09:19 (${r2(baseSpot)})` };
    if (!(peTop.strike < spot)) return { ...view, why: `heaviest put writing ${peTop.strike} is not below NIFTY` };
    const against = nearHeavy('CE');
    if (against != null) return { ...view, why: `heavy call writing near ATM at ${against} — writers against a CE` };
    return { ...view, side: 'CE', level: peTop.strike };
  }
  if (ceW > 0 && ceW >= rule.ratio * peW) {
    if (!(spot < baseSpot)) return { ...view, why: `call writing ${ratioText(ceW, peW)} × put but NIFTY not below 09:19 (${r2(baseSpot)})` };
    if (!(ceTop.strike > spot)) return { ...view, why: `heaviest call writing ${ceTop.strike} is not above NIFTY` };
    const against = nearHeavy('PE');
    if (against != null) return { ...view, why: `heavy put writing near ATM at ${against} — writers against a PE` };
    return { ...view, side: 'PE', level: ceTop.strike };
  }
  return { ...view, why: 'writing balanced' };
}

const ratioText = (a, b) => (b > 0 ? (a / b).toFixed(2) : '∞');
const oiText = (n) => (Math.abs(n) >= 1e7 ? `${(n / 1e7).toFixed(2)} Cr` : `${(n / 1e5).toFixed(1)} L`);

function runTrade({ day, nifty, sig, rule, qty, lastMin, isToday }) {
  const entryMin = sig.t;
  const strike = Math.round(nifty.get(entryMin).o / STEP) * STEP;
  const book = minuteMap(day[sig.side]?.[String(strike)]);
  const first = book.get(entryMin);
  if (!first) return { skip: `no ${strike} ${sig.side} price at ${hhmm(entryMin)}` };
  const entry = r2(first.o + rule.slippage);
  const entrySpot = nifty.get(entryMin).o;
  const events = [
    {
      time: hhmm(entryMin),
      text: `Block closed: CE writing ${oiText(sig.ceWriting)} · PE writing ${oiText(sig.peWriting)} since 09:20 · NIFTY ${sig.spot} vs 09:19 ${sig.baseSpot} · ${sig.side === 'CE' ? 'support' : 'resistance'} ${sig.level}`,
    },
    { time: hhmm(entryMin), text: `Bought ${strike} ${sig.side} at the ${hhmm(entryMin)} open ₹${entry} · NIFTY ${r2(entrySpot)}` },
  ];
  const stopPx = rule.optSl > 0 ? r2(entry - rule.optSl) : null;
  const armBy = entryMin + rule.unarmedMin;
  let peak = entry;
  let lock = null;
  let exit = null;
  let levelHit = false;
  let last = { m: entryMin, px: entry };
  for (let m = entryMin; m <= Math.min(rule.eod, lastMin); m += 1) {
    const o = book.get(m);
    const n = nifty.get(m);
    if (!o) continue;
    const open = m === entryMin ? entry : o.o;
    if (m === rule.eod) {
      exit = { type: 'EOD', m, px: open };
      break;
    }
    if (levelHit) {
      exit = { type: 'LEVEL', m, px: open };
      break;
    }
    if (lock != null) {
      const lockPx = r2(entry + lock);
      if (open <= lockPx) { exit = { type: 'TRAIL', m, px: open }; break; }
      if (o.l <= lockPx) { exit = { type: 'TRAIL', m, px: lockPx }; break; }
    } else {
      if (m >= armBy) { exit = { type: 'TIME', m, px: open }; break; }
      if (stopPx != null && open <= stopPx) { exit = { type: 'SL', m, px: open }; break; }
      if (stopPx != null && o.l <= stopPx) { exit = { type: 'SL', m, px: stopPx }; break; }
    }
    if (n && (sig.side === 'CE' ? n.c < sig.level : n.c > sig.level)) {
      levelHit = true;
      events.push({ time: hhmm(m), text: `NIFTY closed ${r2(n.c)} ${sig.side === 'CE' ? 'below support' : 'above resistance'} ${sig.level} → exit at the next open` });
    }
    peak = Math.max(peak, o.h);
    const nx = computeTrailLockPoints(peak - entry);
    if (nx != null && (lock == null || nx > lock)) {
      lock = r2(nx);
      events.push({ time: hhmm(m), text: `Peak ₹${r2(peak)} (+${r2(peak - entry)}) → lock +${lock} (₹${r2(entry + lock)})` });
    }
    last = { m, px: o.c };
  }
  if (!exit) exit = isToday ? { type: 'OPEN', m: last.m, px: last.px } : { type: 'EOD', m: last.m, px: last.px };

  const exitPremium = r2(Math.max(0.05, exit.px - rule.slippage));
  const points = r2(exitPremium - entry);
  const grossPnL = r2(points * qty);
  const charges = optionCharges(entry * qty, exitPremium * qty);
  const netPnL = r2(grossPnL - charges);
  const exitSpot = nifty.get(exit.m)?.o ?? lastSpot(nifty, exit.m + 1)?.c ?? entrySpot;
  const reason = exit.type === 'TRAIL' ? `Trail lock +${lock}` : exit.type === 'SL' ? `Option SL −${rule.optSl}` : exit.type === 'TIME' ? `Not armed in ${rule.unarmedMin} min` : EXIT_REASON[exit.type];
  events.push({ time: hhmm(exit.m), text: `Exit ₹${exitPremium} — ${reason} · ${points >= 0 ? '+' : ''}${points} pts` });
  const month = Number(day.dateKey.slice(5, 7));
  return {
    trade: {
      id: `${day.dateKey}-${hhmm(entryMin)}-${sig.side}-${strike}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      side: sig.side,
      strike,
      signalTime: hhmm(entryMin),
      entryTime: hhmm(entryMin),
      entrySpot: r2(entrySpot),
      entryPremium: entry,
      level: sig.level,
      baseSpot: sig.baseSpot,
      ceWriting: sig.ceWriting,
      peWriting: sig.peWriting,
      writingRatio: sig.side === 'CE' ? ratioText(sig.peWriting, sig.ceWriting) : ratioText(sig.ceWriting, sig.peWriting),
      flowRows: sig.rows,
      peakPremium: r2(peak),
      maxGainPts: r2(peak - entry),
      lockPts: lock,
      exitTime: hhmm(exit.m),
      exitMin: exit.m,
      exitSpot: r2(exitSpot),
      exitPremium,
      exitType: exit.type,
      exitReason: reason,
      points,
      grossPnL,
      charges,
      netPnL,
      isWin: netPnL > 0,
      events,
    },
  };
}

function simulateDay({ day, rule, qty, now, trades, skipped }) {
  const nifty = minuteMap(day.nifty);
  const open = nifty.get(OPEN)?.o;
  const base = lastSpot(nifty, FLOW_FROM);
  if (!Number.isFinite(open) || !base) return 0;
  const isToday = day.dateKey === now.dateKey;
  const lastMin = isToday ? now.minutes - 1 : 15 * 60 + 29;
  const atm = Math.round(open / STEP) * STEP;
  const strikes = Array.from({ length: SPAN * 2 + 1 }, (_, i) => atm + (i - SPAN) * STEP);
  const books = { CE: new Map(), PE: new Map() };
  for (const k of strikes) {
    for (const side of ['CE', 'PE']) {
      const s = day[side]?.[String(k)];
      if (s) books[side].set(k, minuteMap(s));
    }
  }
  let taken = 0;
  let freeFrom = FIRST_SIGNAL;
  for (let t = FIRST_SIGNAL; t <= rule.lastSignal && t <= lastMin; t += BLOCK) {
    if (taken >= rule.maxTrades) break;
    if (t < freeFrom || !nifty.get(t)) continue;
    const sig = readFlow({ books, strikes, nifty, baseSpot: base.c, t, rule });
    if (!sig?.side) continue;
    const r = runTrade({ day, nifty, sig, rule, qty, lastMin, isToday });
    if (r.skip) {
      skipped.push({ dateKey: day.dateKey, time: hhmm(t), side: sig.side, reason: r.skip });
      continue;
    }
    trades.push(r.trade);
    taken += 1;
    freeFrom = r.trade.exitMin + 1;
  }
  return taken;
}

/**
 * Runs in 25-day pieces: each piece is downloaded, simulated and published via `onPartial`.
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
    rule: { ...rule, lastSignal: hhmm(rule.lastSignal), eod: hhmm(rule.eod), flowFrom: hhmm(FLOW_FROM), firstSignal: hhmm(FIRST_SIGNAL) },
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
    const live = await ensureDays(chunk.from, chunk.to, { onProgress: report });
    const days = loadDays(chunk.from, chunk.to, live);
    const now = getIstClock(new Date());
    days.forEach((day, di) => {
      report({ phase: 'simulate', done: di, total: days.length, dateKey: day.dateKey });
      const taken = simulateDay({ day, rule, qty, now, trades, skipped: skippedSignals });
      if (!taken) flatDays.push(day.dateKey);
    });
    tradingDays += days.length;
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START };
