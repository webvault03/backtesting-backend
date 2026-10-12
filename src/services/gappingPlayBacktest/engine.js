/**
 * Gapping Play (NIFTY daily setup, intraday option trade) — historical backtest.
 *
 *   Setup on daily candles before day D:
 *     Impulse: close-to-close move of ≥ impulseMinPct % over 1–3 days.
 *     Rest: the next restMin–restMax days (longest qualifying rest is used) (ending the day before D) stay in a tight range —
 *           (range high − range low) ≤ maxRangePct % — without giving back more than half the impulse.
 *   Window: D opens above the range high (after a rally) or below the range low (after a fall).
 *   Trade on D: at 09:20, if NIFTY is still outside the range, buy the ATM CE (gap up) / PE (gap down)
 *   of the nearest weekly expiry. Stop: a NIFTY 1-min close back inside the range (gap filled).
 *   Trail on the option: +10 → lock +2, +20 → lock +10, then peak − 10. Otherwise close at 15:25.
 *
 * Daily candles come from one Dhan call; 1-min option data is fetched only for gap days.
 */
const { addDays, dhanPost, ensureDays, istParts, loadDays } = require('../oiCandleAgreeBacktest/dataSource');
const { getIstClock } = require('../../utils/dateTime');

const STEP = 50;
const ENTRY = 9 * 60 + 20;
const EOD = 15 * 60 + 25;
const MAX_IMPULSE_DAYS = 3;
const LOOKBACK_CALENDAR_DAYS = 45;
const FETCH_WINDOW_DAYS = 25;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  lotSize: 65,
  charges: 100,
  impulseMinPct: 1.5,
  restMin: 2,
  restMax: 8,
  maxRangePct: 2,
  sides: 'both',
  minPremium: 5,
  slippage: 0,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function dailyCandles(from, to) {
  const res = await dhanPost('/charts/historical', {
    securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', expiryCode: 0, oi: false,
    fromDate: from, toDate: addDays(to, 1),
  });
  const out = [];
  (res.timestamp || []).forEach((t, i) => {
    const dateKey = istParts(t).dateKey;
    if (dateKey < from || dateKey > to) return;
    out.push({ dateKey, o: res.open[i], h: res.high[i], l: res.low[i], c: res.close[i] });
  });
  return out.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

/** Setup that ends the day before candles[i] and whose window D = candles[i] opens through, or null. */
function findSetup(candles, i, rule) {
  const today = candles[i];
  for (let len = rule.restMax; len >= rule.restMin; len -= 1) {
    const restStart = i - len;
    const impulseEnd = restStart - 1;
    if (impulseEnd - 1 < 0) continue;
    const rest = candles.slice(restStart, i);
    const high = Math.max(...rest.map((c) => c.h));
    const low = Math.min(...rest.map((c) => c.l));
    const base = candles[impulseEnd].c;
    if (((high - low) / base) * 100 > rule.maxRangePct) continue;

    for (let k = 1; k <= MAX_IMPULSE_DAYS && impulseEnd - k >= 0; k += 1) {
      const start = candles[impulseEnd - k];
      const move = base - start.c;
      if ((Math.abs(move) / start.c) * 100 < rule.impulseMinPct) continue;
      const bullish = move > 0;
      if (bullish && rule.sides === 'down') continue;
      if (!bullish && rule.sides === 'up') continue;
      if (bullish ? low < base - move / 2 : high > base - move / 2) continue;
      if (bullish ? today.o <= high : today.o >= low) continue;
      return {
        side: bullish ? 'CE' : 'PE',
        direction: bullish ? 'UP' : 'DOWN',
        impulse: { from: start.dateKey, to: candles[impulseEnd].dateKey, days: k, pct: r2((move / start.c) * 100), points: r2(move) },
        rest: { from: rest[0].dateKey, to: rest[rest.length - 1].dateKey, days: len, high: r2(high), low: r2(low), pct: r2(((high - low) / base) * 100) },
        level: bullish ? high : low,
        dayOpen: today.o,
      };
    }
  }
  return null;
}

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i] }));
  return out;
}

function trailLock(gain) {
  if (gain >= 20) return Math.max(10, Math.floor(gain) - 10);
  if (gain >= 10) return 2;
  return null;
}

function simulate(day, setup, rule, qty) {
  const nifty = minuteMap(day.nifty);
  const spotBar = nifty.get(ENTRY);
  if (!spotBar) return { skipped: 'no NIFTY bar at 09:20' };
  const isUp = setup.side === 'CE';
  if (isUp ? spotBar.o <= setup.level : spotBar.o >= setup.level) return { skipped: 'gap filled before 09:20' };

  const strike = Math.round(spotBar.o / STEP) * STEP;
  const book = minuteMap(day[setup.side]?.[String(strike)]);
  const entryBar = book.get(ENTRY);
  if (!entryBar) return { skipped: `no ${strike} ${setup.side} bar at 09:20` };
  const entryPremium = r2(entryBar.o + rule.slippage);
  if (!(entryPremium > rule.minPremium)) return { skipped: `premium ${entryPremium} ≤ ${rule.minPremium}` };

  let peak = entryPremium;
  let lock = null;
  let last = entryBar.c;
  let exit = null;
  for (let m = ENTRY; m <= EOD && !exit; m += 1) {
    const o = book.get(m);
    const n = nifty.get(m);
    if (m === EOD) {
      exit = { type: 'EOD', min: m, premium: o ? o.o : last };
      break;
    }
    if (!o) continue;
    const trailExit = lock != null && o.l <= entryPremium + lock ? Math.min(o.o, entryPremium + lock) : null;
    const slHit = n && (isUp ? n.c < setup.level : n.c > setup.level);
    if (trailExit != null && slHit) {
      exit = o.c < trailExit ? { type: 'SL', min: m, premium: o.c } : { type: 'TRAIL', min: m, premium: trailExit };
    } else if (trailExit != null) {
      exit = { type: 'TRAIL', min: m, premium: trailExit };
    } else if (slHit) {
      exit = { type: 'SL', min: m, premium: o.c };
    } else {
      peak = Math.max(peak, o.h);
      const next = trailLock(peak - entryPremium);
      if (next != null && (lock == null || next > lock)) lock = next;
      last = o.c;
    }
  }
  if (!exit) exit = { type: 'EOD', min: EOD, premium: last };

  const exitPremium = r2(exit.premium - rule.slippage);
  const points = r2(exitPremium - entryPremium);
  const grossPnL = r2(points * qty);
  const netPnL = r2(grossPnL - rule.charges);
  const month = Number(day.dateKey.slice(5, 7));
  return {
    trade: {
      id: `${day.dateKey}-${setup.side}-${strike}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      direction: setup.direction,
      side: setup.side,
      impulse: setup.impulse,
      rest: setup.rest,
      gapLevel: r2(setup.level),
      dayOpen: r2(setup.dayOpen),
      gapPts: r2(Math.abs(setup.dayOpen - setup.level)),
      strike,
      entryTime: hhmm(ENTRY),
      entrySpot: r2(spotBar.o),
      entryPremium,
      peakHigh: r2(peak),
      maxGainPts: r2(peak - entryPremium),
      trailStop: lock != null ? r2(entryPremium + lock) : null,
      exitTime: hhmm(exit.min),
      exitPremium,
      exitType: exit.type,
      exitReason: { TRAIL: `TRAIL @ ${hhmm(exit.min)}`, SL: `GAP FILLED @ ${hhmm(exit.min)}`, EOD: '15:25 CLOSE' }[exit.type],
      points,
      grossPnL,
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
  const byDirection = (direction) => {
    const list = trades.filter((t) => t.direction === direction);
    return { trades: list.length, wins: list.filter((t) => t.isWin).length, pnl: r2(list.reduce((a, t) => a + t.netPnL, 0)) };
  };
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    up: byDirection('UP'),
    down: byDirection('DOWN'),
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/** Download 1-min data for the signal days: one range fetch when that is fewer Dhan calls. */
async function loadSignalDays(signalDates, from, to, onProgress) {
  const windows = Math.ceil((Number(new Date(`${to}T00:00:00Z`)) - Number(new Date(`${from}T00:00:00Z`))) / 86400000 / FETCH_WINDOW_DAYS) + 1;
  const live = new Map();
  if (signalDates.length > windows) {
    for (const [k, v] of await ensureDays(from, to, { onProgress })) live.set(k, v);
  } else {
    for (let i = 0; i < signalDates.length; i += 1) {
      const d = signalDates[i];
      const dayLive = await ensureDays(d, d, {
        onProgress: (p) => onProgress?.({ ...p, done: i * (p.total || 1) + p.done, total: signalDates.length * (p.total || 1) }),
      });
      for (const [k, v] of dayLive) live.set(k, v);
    }
  }
  const days = new Map();
  for (const d of signalDates) {
    const [day] = await loadDays(d, d, live);
    if (day) days.set(d, day);
  }
  return days;
}

/**
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function }} opts
 */
async function runBacktest({ from, to, lots = 1, rule: ruleIn = {}, onProgress } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * rule.lotSize;
  onProgress?.({ phase: 'fetch', done: 0, total: 0 });

  const candles = await dailyCandles(addDays(from, -LOOKBACK_CALENDAR_DAYS), to);
  const signals = [];
  candles.forEach((c, i) => {
    if (c.dateKey < from) return;
    const setup = findSetup(candles, i, rule);
    if (setup) signals.push({ dateKey: c.dateKey, setup });
  });
  const tradingDays = candles.filter((c) => c.dateKey >= from).length;

  const today = getIstClock(new Date()).dateKey;
  const days = await loadSignalDays(signals.map((s) => s.dateKey).filter((d) => d <= today), from, to, onProgress);

  const trades = [];
  const skippedDays = [];
  signals.forEach((s, i) => {
    onProgress?.({ phase: 'simulate', done: i, total: signals.length, dateKey: s.dateKey });
    const day = days.get(s.dateKey);
    if (!day) {
      skippedDays.push({ dateKey: s.dateKey, reason: 'no 1-min data' });
      return;
    }
    const r = simulate(day, s.setup, rule, qty);
    if (r.trade) trades.push(r.trade);
    else skippedDays.push({ dateKey: s.dateKey, reason: `${s.setup.direction === 'UP' ? 'gap up' : 'gap down'}: ${r.skipped}` });
  });

  return {
    from,
    to,
    lots,
    qty,
    rule,
    tradingDays,
    signals: signals.length,
    skippedDays,
    summary: summarize(trades),
    trades,
  };
}

module.exports = { runBacktest, DEFAULT_RULE };
