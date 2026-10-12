/**
 * Short straddle next day — historical backtest of the live paper engine (strategy-6).
 *
 *   09:20 on a trading day: strike = NIFTY spot rounded to 50; SELL that CE + PE of the second
 *   weekly expiry (the live engine's getNextWeeklyExpiry → future[1]).
 *   Exit: buy both back at 15:15 on the next trading day. No stop loss, no target.
 *   One position at a time, so the day the trade exits is never an entry day.
 *   P&L = (credit − buyback) × qty − charges per trade.
 *
 * Prices: entry at the 09:20 1-min open, exit at the 15:15 1-min open (nearest earlier minute if missing).
 * On the day after an expiry-day entry the held contract has become the nearest weekly, so the exit is
 * priced from that book. If the held strike has drifted outside Dhan's rolling window, the exit is
 * estimated from put-call parity and flagged (`exitApprox`).
 */
const { ensureDays, loadDays } = require('./dataSource');
const { addDays } = require('../oiCandleAgreeBacktest/dataSource');
const { getIstClock } = require('../../utils/dateTime');

const STEP = 50;
const ENTRY_MINUTES = [560, 561, 562, 563, 564];
const EXIT_MINUTE = 915;
const EXIT_FALLBACK = [914, 913, 912, 911, 910];
const TUESDAY_EXPIRY_FROM = '2025-09-01';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULT_RULE = { lotSize: 65, charges: 100 };

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const weekday = (dateKey) => new Date(`${dateKey}T00:00:00Z`).getUTCDay();

/**
 * Weekly expiry day test: Thursday until Aug 2025, Tuesday from Sep 2025, moved to the previous
 * trading day on a holiday. Dates past the loaded data count as trading on weekdays.
 */
function expiryCalendar(tradingDates, lastLoaded) {
  const trading = new Set(tradingDates);
  const isTrading = (d) => (d <= lastLoaded ? trading.has(d) : weekday(d) >= 1 && weekday(d) <= 5);
  return (dateKey) => {
    const target = dateKey >= TUESDAY_EXPIRY_FROM ? 2 : 4;
    const monday = addDays(dateKey, 1 - (weekday(dateKey) || 7));
    let expiry = addDays(monday, target - 1);
    while (expiry >= monday && !isTrading(expiry)) expiry = addDays(expiry, -1);
    return expiry === dateKey;
  };
}

/** First available [minute, price] from `minutes` in a { [minute]: [open, close] } book. */
function priceAt(bars, minutes, field) {
  if (!bars) return null;
  for (const m of minutes) {
    const bar = bars[m];
    if (bar && Number.isFinite(bar[field])) return { minute: m, price: bar[field] };
  }
  return null;
}

/** 15:15 open, else the close of the latest minute before it. */
function exitPrice(bars) {
  return priceAt(bars, [EXIT_MINUTE], 0) || priceAt(bars, EXIT_FALLBACK, 1);
}

/**
 * Straddle buyback for `strike` from one rolling book at the exit minute.
 * Missing legs (strike outside the rolling window) are estimated: forward from the nearest-to-ATM
 * strike, far-OTM leg extrapolated from the two outermost strikes, ITM leg by put-call parity.
 */
function exitQuote(book, strike) {
  const key = String(strike);
  const ce = exitPrice(book.CE[key]);
  const pe = exitPrice(book.PE[key]);
  if (ce && pe) return { ce: ce.price, pe: pe.price, minute: Math.min(ce.minute, pe.minute), approx: false };

  const chain = Object.keys(book.CE)
    .filter((k) => book.PE[k])
    .map((k) => ({ strike: Number(k), ce: exitPrice(book.CE[k]), pe: exitPrice(book.PE[k]) }))
    .filter((r) => r.ce && r.pe)
    .sort((a, b) => a.strike - b.strike);
  if (chain.length < 2) return null;

  const atm = chain.reduce((best, r) => (Math.abs(r.ce.price - r.pe.price) < Math.abs(best.ce.price - best.pe.price) ? r : best));
  const forward = atm.strike + atm.ce.price - atm.pe.price;
  const below = strike < chain[0].strike;
  const [outer, inner] = below ? [chain[0], chain[1]] : [chain[chain.length - 1], chain[chain.length - 2]];
  const leg = below ? 'pe' : 'ce';
  const ratio = Math.min(1, outer[leg].price / Math.max(0.05, inner[leg].price));
  const steps = Math.abs(strike - outer.strike) / STEP;
  const otm = Math.max(0.05, outer[leg].price * ratio ** steps);
  const itm = Math.max(0.05, Math.abs(forward - strike) + otm);
  return {
    ce: ce ? ce.price : below ? itm : otm,
    pe: pe ? pe.price : below ? otm : itm,
    minute: atm.ce.minute,
    approx: true,
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
  const pnls = trades.map((t) => t.netPnL);
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    bestTrade: pnls.length ? Math.max(...pnls) : 0,
    worstTrade: pnls.length ? Math.min(...pnls) : 0,
    avgCredit: trades.length ? r2(trades.reduce((a, t) => a + t.credit, 0) / trades.length) : 0,
    expiryDayEntries: trades.filter((t) => t.entryOnExpiry).length,
    approxExits: trades.filter((t) => t.exitApprox).length,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function }} opts
 */
async function runBacktest({ from, to, lots = 1, rule: ruleIn = {}, onProgress } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * rule.lotSize;
  const today = getIstClock(new Date()).dateKey;
  const loadTo = addDays(to, 10) < today ? addDays(to, 10) : today;

  const live = await ensureDays(from, loadTo, { onProgress });
  const days = loadDays(from, loadTo, live);
  const isExpiry = expiryCalendar(days.map((d) => d.dateKey), loadTo);

  const trades = [];
  const skippedDays = [];
  let pending = null;
  let busyThrough = '';
  const entryDays = days.filter((d) => d.dateKey <= to);

  entryDays.forEach((day, i) => {
    onProgress?.({ phase: 'simulate', done: i, total: entryDays.length, dateKey: day.dateKey });
    if (day.dateKey <= busyThrough) return;

    const spotQuote = priceAt(day.spot, ENTRY_MINUTES, 0);
    if (!spotQuote) {
      skippedDays.push({ dateKey: day.dateKey, reason: 'no NIFTY bar at 09:20' });
      return;
    }
    const strike = Math.round(spotQuote.price / STEP) * STEP;
    const ce = priceAt(day.next.CE[String(strike)], ENTRY_MINUTES, 0);
    const pe = priceAt(day.next.PE[String(strike)], ENTRY_MINUTES, 0);
    if (!ce || !pe) {
      skippedDays.push({ dateKey: day.dateKey, reason: `no ${strike} CE/PE price at 09:20` });
      return;
    }

    const exitDay = days[days.indexOf(day) + 1];
    if (!exitDay) {
      pending = { dateKey: day.dateKey, strike, credit: r2(ce.price + pe.price) };
      busyThrough = '9999-12-31';
      return;
    }
    busyThrough = exitDay.dateKey;

    const entryOnExpiry = isExpiry(day.dateKey);
    const quote = exitQuote(entryOnExpiry ? exitDay.near : exitDay.next, strike);
    if (!quote) {
      if (exitDay.dateKey === today) {
        pending = { dateKey: day.dateKey, strike, credit: r2(ce.price + pe.price) };
      } else {
        skippedDays.push({ dateKey: day.dateKey, reason: `no ${strike} prices at 15:15 on ${exitDay.dateKey}` });
      }
      return;
    }

    const credit = r2(ce.price + pe.price);
    const buyback = r2(quote.ce + quote.pe);
    const points = r2(credit - buyback);
    const grossPnL = r2(points * qty);
    const netPnL = r2(grossPnL - rule.charges);
    const exitSpot = priceAt(exitDay.spot, [EXIT_MINUTE], 0) || priceAt(exitDay.spot, EXIT_FALLBACK, 1);
    const month = Number(day.dateKey.slice(5, 7));
    trades.push({
      id: `${day.dateKey}-${strike}`,
      date: day.dateKey,
      exitDate: exitDay.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      weekday: WEEKDAYS[weekday(day.dateKey)],
      entryOnExpiry,
      strike,
      entryTime: hhmm(Math.max(ce.minute, pe.minute)),
      entrySpot: r2(spotQuote.price),
      ceEntry: r2(ce.price),
      peEntry: r2(pe.price),
      credit,
      exitTime: hhmm(quote.minute),
      exitSpot: exitSpot ? r2(exitSpot.price) : null,
      spotMove: exitSpot ? r2(exitSpot.price - spotQuote.price) : null,
      ceExit: r2(quote.ce),
      peExit: r2(quote.pe),
      buyback,
      exitApprox: quote.approx,
      points,
      grossPnL,
      netPnL,
      isWin: netPnL > 0,
    });
  });

  return {
    from,
    to,
    lots,
    qty,
    rule,
    tradingDays: entryDays.length,
    skippedDays,
    pending,
    summary: summarize(trades),
    trades,
  };
}

module.exports = { runBacktest, DEFAULT_RULE };
