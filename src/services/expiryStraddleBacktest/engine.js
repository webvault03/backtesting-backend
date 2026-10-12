/**
 * Expiry Straddle — historical backtest engine.
 *
 * NIFTY weekly options, only on the weekly expiry day and/or the trading day before it:
 *   at the entry minute sell the ATM CE + PE (spot rounded to 50), each leg has its own stop at
 *   +legSlPct% of its sell price (only that leg is bought back), whatever is open closes at the exit minute.
 * One trade per day. Fills: entry at the minute open; stop at the stop price, or at the open when a
 * minute opens beyond it; exit at the exit minute's open. Slippage is charged on every leg fill.
 */
const { addDays, ensureDays, loadDays } = require('../oiCandleAgreeBacktest/dataSource');

const LOT_SIZE = 65;
const STEP = 50;
const CHARGES = 200;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MODES = ['both', 'expiry', 'dayBefore'];

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const weekday = (dateKey) => new Date(`${dateKey}T00:00:00Z`).getUTCDay();

const DEFAULT_RULE = { entryMin: 11 * 60, exitMin: 15 * 60 + 15, legSlPct: 35, days: 'both', slippage: 0.5 };

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i] }));
  return out;
}

/**
 * Weekly NIFTY expiry: Thursday until Aug 2025, Tuesday from Sep 2025. On a holiday it moves to the
 * previous trading day. Dates after the last loaded day are assumed to be trading weekdays.
 */
function expiryCalendar(tradingDates) {
  const set = new Set(tradingDates);
  const last = tradingDates[tradingDates.length - 1];
  const isTrading = (d) => (d <= last ? set.has(d) : ![0, 6].includes(weekday(d)));
  const isExpiry = (d) => {
    const expDow = d >= '2025-09-01' ? 2 : 4;
    let target = d;
    while (weekday(target) !== expDow) target = addDays(target, 1);
    let e = target;
    while (e > d && !isTrading(e)) e = addDays(e, -1);
    return e === d;
  };
  const nextTrading = (d) => {
    let n = addDays(d, 1);
    while (!isTrading(n)) n = addDays(n, 1);
    return n;
  };
  return { isExpiry, isDayBefore: (d) => isExpiry(nextTrading(d)) };
}

function runDay({ dateKey, day, rule, qty, dayType }) {
  const nifty = minuteMap(day.nifty);
  const spotBar = nifty.get(rule.entryMin);
  if (!spotBar) return { skipped: `no NIFTY bar at ${hhmm(rule.entryMin)}` };
  const strike = Math.round(spotBar.o / STEP) * STEP;

  const legs = [];
  for (const side of ['CE', 'PE']) {
    const book = minuteMap(day[side]?.[String(strike)]);
    let entryMin = null;
    for (let m = rule.entryMin; m < rule.entryMin + 3 && entryMin == null; m += 1) if (book.get(m)) entryMin = m;
    if (entryMin == null) return { skipped: `no ${strike} ${side} data at ${hhmm(rule.entryMin)}` };
    const entry = book.get(entryMin).o;
    legs.push({ side, book, entryMin, entry, sl: r2(entry * (1 + rule.legSlPct / 100)), open: true, last: entry, exit: null, exitMin: null, reason: null });
  }

  for (let m = rule.entryMin; m < rule.exitMin; m += 1) {
    for (const leg of legs) {
      if (!leg.open) continue;
      const bar = leg.book.get(m);
      if (!bar) continue;
      if (m > leg.entryMin && bar.o >= leg.sl) Object.assign(leg, { open: false, exit: bar.o, exitMin: m, reason: 'SL' });
      else if (bar.h >= leg.sl) Object.assign(leg, { open: false, exit: leg.sl, exitMin: m, reason: 'SL' });
      else leg.last = bar.c;
    }
    if (legs.every((l) => !l.open)) break;
  }
  for (const leg of legs) {
    if (!leg.open) continue;
    Object.assign(leg, { open: false, exit: leg.book.get(rule.exitMin)?.o ?? leg.last, exitMin: rule.exitMin, reason: 'EOD' });
  }

  const [ce, pe] = legs;
  const credit = r2(ce.entry + pe.entry);
  const points = r2(ce.entry - ce.exit + pe.entry - pe.exit - rule.slippage * 4);
  const netPnL = r2(points * qty - CHARGES);
  const stops = legs.filter((l) => l.reason === 'SL').length;
  const legOut = (l) => ({ entry: r2(l.entry), sl: l.sl, exit: r2(l.exit), exitTime: hhmm(l.exitMin), reason: l.reason, points: r2(l.entry - l.exit) });
  const month = Number(dateKey.slice(5, 7));
  return {
    trade: {
      id: `${dateKey}-${strike}`,
      date: dateKey,
      monthKey: dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday(dateKey)],
      dayType,
      strike,
      entryTime: hhmm(rule.entryMin),
      entrySpot: r2(spotBar.o),
      credit,
      ce: legOut(ce),
      pe: legOut(pe),
      stops,
      exitType: stops === 2 ? 'BOTH_SL' : stops === 1 ? 'ONE_SL' : 'EOD',
      points,
      qty,
      netPnL,
      isWin: netPnL > 0,
    },
  };
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (!months[t.monthKey]) months[t.monthKey] = { key: t.monthKey, label: `${t.monthShort} ${t.monthKey.slice(2, 4)}`, trades: 0, wins: 0, pnl: 0 };
    const m = months[t.monthKey];
    m.trades += 1;
    if (t.isWin) m.wins += 1;
    m.pnl = r2(m.pnl + t.netPnL);
  }
  const wins = trades.filter((t) => t.isWin).length;
  const byType = (type) => trades.filter((t) => t.dayType === type);
  const part = (ts) => ({ trades: ts.length, wins: ts.filter((t) => t.isWin).length, netPnL: r2(ts.reduce((a, t) => a + t.netPnL, 0)) });
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    worstDay: trades.length ? r2(Math.min(...trades.map((t) => t.netPnL))) : 0,
    bestDay: trades.length ? r2(Math.max(...trades.map((t) => t.netPnL))) : 0,
    exits: {
      EOD: trades.filter((t) => t.exitType === 'EOD').length,
      ONE_SL: trades.filter((t) => t.exitType === 'ONE_SL').length,
      BOTH_SL: trades.filter((t) => t.exitType === 'BOTH_SL').length,
    },
    expiry: part(byType('expiry')),
    dayBefore: part(byType('dayBefore')),
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * LOT_SIZE;
  const live = await ensureDays(from, to, { onProgress });
  const days = await loadDays(from, to, live);
  const cal = expiryCalendar(days.map((d) => d.dateKey));

  const trades = [];
  const skippedDays = [];
  let done = 0;
  for (const day of days) {
    onProgress?.({ phase: 'simulate', done, total: days.length, dateKey: day.dateKey });
    done += 1;
    const dayType = cal.isExpiry(day.dateKey) ? 'expiry' : cal.isDayBefore(day.dateKey) ? 'dayBefore' : null;
    if (!dayType || (rule.days !== 'both' && rule.days !== dayType)) continue;
    const r = runDay({ dateKey: day.dateKey, day, rule, qty, dayType });
    if (r.trade) trades.push(r.trade);
    else skippedDays.push({ dateKey: day.dateKey, reason: r.skipped });
  }

  return {
    from,
    to,
    lots,
    qty,
    rule: { ...rule, entryTime: hhmm(rule.entryMin), exitTime: hhmm(rule.exitMin), charges: CHARGES },
    tradingDays: days.length,
    skippedDays,
    summary: summarize(trades),
    trades,
  };
}

module.exports = { runBacktest, expiryCalendar, DEFAULT_RULE, DAY_MODES };
