/**
 * Nison VWAP + EMA — historical backtest (NIFTY 5-min signals, nearest weekly ATM option, Dhan 1-min history).
 *
 * Every decision uses only 5-min candles that have closed; the fill is the next minute's real option open.
 *
 * Volume: NIFTY index has no volume history, so a minute's volume = ATM CE volume + ATM PE volume
 *   (ATM = that minute's NIFTY close rounded to 50).
 * VWAP: Σ(typical price × volume) / Σ volume from 09:15, typical = (high + low + close) / 3 of the NIFTY minute.
 * EMA 20 / 50: on 5-min closes, running across days (previous days warm the EMAs up, like a chart).
 *
 * Trend at the signal candle close:  Bullish = close > VWAP and EMA20 > EMA50 → only CE.
 *                                    Bearish = close < VWAP and EMA20 < EMA50 → only PE.  Else nothing.
 * Patterns on the closed signal candle (first match wins, in this order):
 *   Hammer (bull)          low ≤ EMA20, close > EMA20, lower wick ≥ 2 × body and ≥ half the range, upper wick ≤ ¼ range.
 *   Shooting star (bear)   high ≥ EMA20, close < EMA20, upper wick ≥ 2 × body and ≥ half the range, lower wick ≤ ¼ range.
 *   Bullish engulfing      previous candle red, this candle green, body engulfs the previous body, VWAP inside either candle's range.
 *   Bearish engulfing      mirror.
 *   Spring (bull)          low < morning-range low and close back above it.   Upthrust (bear): mirror on the high.
 *   Volume breakout        close crosses above the morning-range high (bull) / below the low (bear) with volume ≥ the
 *                          average of the previous 5 candles.
 *   Morning range = high / low of 09:15–09:44 (first six 5-min candles).
 * Entries: signal candles closing 09:45 → 14:45; buy at the next minute open. One trade at a time.
 *
 * Position: 10 lots = 7 lots scalp (target +8.5) + 3 lots runner (target +16), option premium points.
 *   SL entry − 7 for both. Once the option has been +6, SL moves to entry + 2 (from the next minute).
 *   Inside a minute: stop first (worst case), then targets; the minute's high moves the SL from the next minute.
 *   Anything still open closes at 15:15.
 * Day rules: realised net ≥ +₹7,500 → close what is open at the next minute open and stop for the day.
 *   Realised net ≤ −₹6,500 or 2 stop-loss hits → stop for the day. Max 6 trades.
 *   Cooldown: the 5-min candle the trade closed in and the next 2 candles cannot give a signal.
 */
const { addDays } = require('../oiCandleAgreeBacktest/dataSource');
const { ensureDays, loadDay, SESSION_FIRST, SESSION_LAST } = require('../cvdOiBacktest/dataSource');
const { getIstClock } = require('../../utils/dateTime');

const HISTORY_START = '2020-08-03';
const STEP = 50;
const BAR = 5;
const OR_BARS = 6;
const N = SESSION_LAST - SESSION_FIRST + 1;
const WARMUP_DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PATTERN_LABEL = {
  HAMMER: 'Hammer at EMA 20',
  SHOOTING_STAR: 'Shooting star at EMA 20',
  BULL_ENGULF: 'Bullish engulfing at VWAP',
  BEAR_ENGULF: 'Bearish engulfing at VWAP',
  SPRING: 'Spring (false break below morning low)',
  UPTHRUST: 'Upthrust (false break above morning high)',
  VOL_BREAKOUT_UP: 'Volume breakout above morning high',
  VOL_BREAKOUT_DOWN: 'Volume breakdown below morning low',
};

const DEFAULT_RULE = {
  lotSize: 65,
  scalpLots: 7,
  runnerLots: 3,
  scalpTarget: 8.5,
  runnerTarget: 16,
  stopLoss: 7,
  beTrigger: 6,
  beLock: 2,
  dayProfitLock: 7500,
  dayLossLimit: 6500,
  maxSlHits: 2,
  maxTrades: 6,
  cooldownBars: 2,
  entryFrom: 9 * 60 + 45,
  entryTo: 14 * 60 + 45,
  eod: 15 * 60 + 15,
  emaFast: 20,
  emaSlow: 50,
  slippage: 0,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const at = (idx) => hhmm(SESSION_FIRST + idx);
const atmOf = (spot) => Math.round(spot / STEP) * STEP;

/** F&O option charges for one buy order and `sells` sell orders (brokerage ₹20/order, STT, exchange, SEBI, GST, stamp). */
function optionCharges(dateKey, buyValue, sellValue, sells) {
  const newRates = dateKey >= '2024-10-01';
  const brokerage = 20 * (1 + sells);
  const stt = sellValue * (newRates ? 0.001 : 0.000625);
  const exchange = (buyValue + sellValue) * (newRates ? 0.0003503 : 0.00053);
  const sebi = (buyValue + sellValue) * 1e-6;
  const gst = (brokerage + exchange + sebi) * 0.18;
  const stamp = buyValue * 0.00003;
  return r2(brokerage + stt + exchange + sebi + gst + stamp);
}

function toIndexed(series, fields, lastIdx) {
  const out = new Array(N);
  if (!series?.m) return out;
  series.m.forEach((m, i) => {
    const idx = m - SESSION_FIRST;
    if (idx < 0 || idx >= N || idx > lastIdx) return;
    const bar = {};
    for (const f of fields) bar[f] = series[f][i];
    out[idx] = bar;
  });
  return out;
}

/** Minute arrays + 5-min candles with VWAP and volume. `lastIdx` drops minutes still forming (today). */
function prepareDay(raw, lastIdx = N - 1) {
  const nifty = toIndexed(raw.nifty, ['o', 'h', 'l', 'c'], lastIdx);
  const opt = { CE: new Map(), PE: new Map() };
  for (const side of ['CE', 'PE']) {
    for (const [strike, s] of Object.entries(raw[side] || {})) opt[side].set(Number(strike), toIndexed(s, ['o', 'h', 'l', 'c', 'v'], lastIdx));
  }
  const vol = new Float64Array(N);
  const vwap = new Array(N).fill(null);
  let pv = 0;
  let vv = 0;
  for (let i = 0; i < N; i += 1) {
    const n = nifty[i];
    if (n) {
      const atm = atmOf(n.c);
      vol[i] = (Number(opt.CE.get(atm)?.[i]?.v) || 0) + (Number(opt.PE.get(atm)?.[i]?.v) || 0);
      pv += ((n.h + n.l + n.c) / 3) * vol[i];
      vv += vol[i];
    }
    vwap[i] = vv > 0 ? pv / vv : null;
  }
  const candles = [];
  for (let start = 0; start + BAR - 1 < N; start += BAR) {
    const end = start + BAR - 1;
    if (end > lastIdx) break;
    let o = null;
    let h = -Infinity;
    let l = Infinity;
    let c = null;
    let v = 0;
    for (let i = start; i <= end; i += 1) {
      const b = nifty[i];
      if (!b) continue;
      if (o == null) o = b.o;
      h = Math.max(h, b.h);
      l = Math.min(l, b.l);
      c = b.c;
      v += vol[i];
    }
    if (o != null) candles.push({ dateKey: raw.dateKey, start, end, o, h, l, c, v, vwap: vwap[end] });
  }
  return { dateKey: raw.dateKey, nifty, opt, candles, lastIdx };
}

/** EMA fast / slow on every candle, carried across days through `state`. */
function applyEmas(candles, state, rule) {
  const af = 2 / (rule.emaFast + 1);
  const as = 2 / (rule.emaSlow + 1);
  for (const c of candles) {
    state.fast = state.fast == null ? c.c : state.fast + af * (c.c - state.fast);
    state.slow = state.slow == null ? c.c : state.slow + as * (c.c - state.slow);
    state.count += 1;
    c.emaFast = state.fast;
    c.emaSlow = state.slow;
    c.emaReady = state.count >= rule.emaSlow;
  }
}

/** Trend + pattern on closed candle `i` of the day. */
function signalAt(candles, i, morning) {
  const c = candles[i];
  const p = candles[i - 1];
  if (!c || !p || !c.emaReady || c.vwap == null) return null;
  const bull = c.c > c.vwap && c.emaFast > c.emaSlow;
  const bear = c.c < c.vwap && c.emaFast < c.emaSlow;
  if (!bull && !bear) return null;
  const range = c.h - c.l;
  const body = Math.abs(c.c - c.o);
  const lowerWick = Math.min(c.o, c.c) - c.l;
  const upperWick = c.h - Math.max(c.o, c.c);
  const avg5 = i >= 5 ? candles.slice(i - 5, i).reduce((s, x) => s + x.v, 0) / 5 : null;
  const vwapIn = (x) => x.l <= c.vwap && c.vwap <= x.h;

  let pattern = null;
  if (bull) {
    if (range > 0 && c.l <= c.emaFast && c.c > c.emaFast && lowerWick >= 2 * body && lowerWick >= range / 2 && upperWick <= range / 4) pattern = 'HAMMER';
    else if (p.c < p.o && c.c > c.o && c.c >= p.o && c.o <= p.c && (c.c - c.o) > (p.o - p.c) && (vwapIn(c) || vwapIn(p))) pattern = 'BULL_ENGULF';
    else if (c.l < morning.low && c.c > morning.low) pattern = 'SPRING';
    else if (p.c <= morning.high && c.c > morning.high && avg5 > 0 && c.v >= avg5) pattern = 'VOL_BREAKOUT_UP';
  } else {
    if (range > 0 && c.h >= c.emaFast && c.c < c.emaFast && upperWick >= 2 * body && upperWick >= range / 2 && lowerWick <= range / 4) pattern = 'SHOOTING_STAR';
    else if (p.c > p.o && c.c < c.o && c.c <= p.o && c.o >= p.c && (c.o - c.c) > (p.c - p.o) && (vwapIn(c) || vwapIn(p))) pattern = 'BEAR_ENGULF';
    else if (c.h > morning.high && c.c < morning.high) pattern = 'UPTHRUST';
    else if (p.c >= morning.low && c.c < morning.low && avg5 > 0 && c.v >= avg5) pattern = 'VOL_BREAKOUT_DOWN';
  }
  if (!pattern) return null;
  return { side: bull ? 'CE' : 'PE', pattern, candle: c, prev: p, avg5 };
}

/**
 * Minute walk on the option. Legs close on target / SL; SL moves to entry + beLock after +beTrigger.
 * `lockGross(i, grossSoFar)` → true when the day profit lock is reached after a leg closes in minute i.
 */
function manage({ book, entryIdx, entry, rule, eodIdx, lastIdx, events, dayNetBefore }) {
  const legs = [
    { name: 'Scalp', lots: rule.scalpLots, target: entry + rule.scalpTarget, open: true },
    { name: 'Runner', lots: rule.runnerLots, target: entry + rule.runnerTarget, open: true },
  ].filter((l) => l.lots > 0);
  let sl = entry - rule.stopLoss;
  let be = false;
  let peak = entry;
  let low = entry;
  let last = entry;
  let lockAt = null;
  const closeLeg = (leg, i, px, why) => {
    leg.open = false;
    leg.exitIdx = i;
    leg.exitPx = r2(Math.max(0.05, px - rule.slippage));
    leg.why = why;
    leg.pts = r2(leg.exitPx - entry);
    events.push({ time: at(i), text: `${leg.name} (${leg.lots} lots) sold at ₹${leg.exitPx} — ${why} · ${leg.pts >= 0 ? '+' : ''}${leg.pts} pts` });
  };
  const realisedGross = () => legs.filter((l) => !l.open).reduce((s, l) => s + l.pts * l.lots * rule.lotSize, 0);

  for (let i = entryIdx; i <= Math.min(eodIdx, lastIdx); i += 1) {
    const open = legs.filter((l) => l.open);
    if (!open.length) break;
    const b = book[i];
    if (i === eodIdx) {
      for (const l of open) closeLeg(l, i, b ? b.o : last, `${hhmm(rule.eod)} close`);
      break;
    }
    if (!b) continue;
    const o = i === entryIdx ? entry : b.o;
    if (lockAt != null && i >= lockAt) {
      for (const l of open) closeLeg(l, i, o, `day profit lock ₹${rule.dayProfitLock.toLocaleString('en-IN')} reached`);
      break;
    }
    if (o <= sl || b.l <= sl) {
      const px = o <= sl ? o : sl;
      for (const l of open) closeLeg(l, i, px, be ? `breakeven shield (entry + ${rule.beLock})` : `stop loss −${rule.stopLoss}`);
      break;
    }
    let closedNow = false;
    for (const l of open) {
      if (o >= l.target) {
        closeLeg(l, i, o, `target +${r2(l.target - entry)} (opened above)`);
        closedNow = true;
      } else if (b.h >= l.target) {
        closeLeg(l, i, l.target, `target +${r2(l.target - entry)}`);
        closedNow = true;
      }
    }
    peak = Math.max(peak, b.h);
    low = Math.min(low, b.l);
    last = b.c;
    if (!be && peak - entry >= rule.beTrigger) {
      be = true;
      sl = entry + rule.beLock;
      if (legs.some((l) => l.open)) {
        events.push({ time: at(i), text: `Option reached +${r2(peak - entry)} → breakeven shield: SL moved to ₹${r2(sl)} (entry + ${rule.beLock}) from the next minute` });
      }
    }
    if (closedNow && legs.some((l) => l.open) && dayNetBefore + realisedGross() >= rule.dayProfitLock) {
      lockAt = i + 1;
      events.push({ time: at(i), text: `Day profit reached ₹${Math.round(dayNetBefore + realisedGross()).toLocaleString('en-IN')} ≥ ₹${rule.dayProfitLock.toLocaleString('en-IN')} → closing the rest at the next minute open` });
    }
  }
  const stillOpen = legs.filter((l) => l.open);
  if (stillOpen.length) {
    const idx = Math.min(eodIdx, lastIdx);
    for (const l of stillOpen) closeLeg(l, idx, last, 'still open — marked at the latest price');
  }
  return { legs, peak, low, be, open: stillOpen.length > 0 };
}

function runDay(day, rule, qty, skipped) {
  const { candles } = day;
  const trades = [];
  if (candles.length < OR_BARS + 1 || candles.slice(0, OR_BARS).length < OR_BARS || candles[OR_BARS - 1].start !== (OR_BARS - 1) * BAR) return trades;
  const morning = { high: Math.max(...candles.slice(0, OR_BARS).map((c) => c.h)), low: Math.min(...candles.slice(0, OR_BARS).map((c) => c.l)) };
  const fromIdx = rule.entryFrom - SESSION_FIRST;
  const toIdx = rule.entryTo - SESSION_FIRST;
  const eodIdx = rule.eod - SESSION_FIRST;
  let dayNet = 0;
  let slHits = 0;
  let stopReason = null;
  let nextAllowedStart = 0;

  for (let ci = OR_BARS; ci < candles.length; ci += 1) {
    const c = candles[ci];
    const entryIdx = c.end + 1;
    if (entryIdx < fromIdx) continue;
    if (entryIdx > toIdx) break;
    const sig = signalAt(candles, ci, morning);
    if (!sig) continue;
    const skip = (reason) => skipped.push({ dateKey: day.dateKey, time: at(entryIdx), side: sig.side, pattern: PATTERN_LABEL[sig.pattern], reason });
    if (stopReason) {
      skip(stopReason);
      continue;
    }
    if (c.start < nextAllowedStart) {
      skip('cooldown (2 candles after the last trade)');
      continue;
    }
    if (trades.length >= rule.maxTrades) {
      skip(`max ${rule.maxTrades} trades reached`);
      continue;
    }
    const spot = day.nifty[entryIdx]?.o;
    if (!Number.isFinite(spot)) {
      skip('no NIFTY bar at the entry minute');
      continue;
    }
    const strike = atmOf(spot);
    const book = day.opt[sig.side].get(strike);
    const bar = book?.[entryIdx];
    if (!bar) {
      skip(`no ${strike} ${sig.side} price at ${at(entryIdx)}`);
      continue;
    }
    const entry = r2(bar.o + rule.slippage);
    const s = sig.candle;
    const events = [
      {
        time: at(c.end + 1),
        text: `5-min candle ${at(s.start)}–${at(s.end + 1)} closed (O ${r2(s.o)} H ${r2(s.h)} L ${r2(s.l)} C ${r2(s.c)}) · ${sig.side === 'CE' ? 'Bullish' : 'Bearish'}: close ${r2(s.c)} ${sig.side === 'CE' ? '>' : '<'} VWAP ${r2(s.vwap)} and EMA20 ${r2(s.emaFast)} ${sig.side === 'CE' ? '>' : '<'} EMA50 ${r2(s.emaSlow)} · ${PATTERN_LABEL[sig.pattern]}`,
      },
      { time: at(entryIdx), text: `Bought ${strike} ${sig.side} (ATM) at the ${at(entryIdx)} open ₹${entry} · NIFTY ${r2(spot)} · SL ₹${r2(entry - rule.stopLoss)} · scalp target ₹${r2(entry + rule.scalpTarget)} · runner target ₹${r2(entry + rule.runnerTarget)}` },
    ];
    const res = manage({ book, entryIdx, entry, rule, eodIdx, lastIdx: day.lastIdx, events, dayNetBefore: dayNet });
    const { legs } = res;
    const exitIdx = Math.max(...legs.map((l) => l.exitIdx));
    const grossPnL = r2(legs.reduce((sum, l) => sum + l.pts * l.lots * rule.lotSize, 0));
    const sellValue = legs.reduce((sum, l) => sum + l.exitPx * l.lots * rule.lotSize, 0);
    const sells = new Set(legs.map((l) => `${l.exitIdx}|${l.exitPx}`)).size;
    const charges = optionCharges(day.dateKey, entry * qty, sellValue, sells);
    const netPnL = r2(grossPnL - charges);
    const lastLeg = legs.reduce((a, b) => (b.exitIdx >= a.exitIdx ? b : a));
    const exitType = res.open
      ? 'OPEN'
      : /stop loss/.test(lastLeg.why)
      ? 'SL'
      : /breakeven/.test(lastLeg.why)
        ? 'BE'
        : /profit lock/.test(lastLeg.why)
          ? 'LOCK'
          : /close/.test(lastLeg.why) && !/target/.test(lastLeg.why)
            ? 'EOD'
            : 'TARGET';
    if (exitType === 'SL') slHits += 1;
    dayNet = r2(dayNet + netPnL);
    const points = r2(grossPnL / qty);
    const month = Number(day.dateKey.slice(5, 7));
    const exitSpot = day.nifty[exitIdx]?.o ?? day.nifty[exitIdx - 1]?.c ?? spot;
    trades.push({
      id: `${day.dateKey}-${at(entryIdx)}-${sig.side}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      tradeNo: trades.length + 1,
      side: sig.side,
      strike,
      pattern: sig.pattern,
      patternLabel: PATTERN_LABEL[sig.pattern],
      signalTime: `${at(s.start)}–${at(s.end + 1)}`,
      signalCandle: { o: r2(s.o), h: r2(s.h), l: r2(s.l), c: r2(s.c), v: Math.round(s.v) },
      prevCandle: { o: r2(sig.prev.o), h: r2(sig.prev.h), l: r2(sig.prev.l), c: r2(sig.prev.c), v: Math.round(sig.prev.v) },
      avgVol5: sig.avg5 != null ? Math.round(sig.avg5) : null,
      vwap: r2(s.vwap),
      emaFast: r2(s.emaFast),
      emaSlow: r2(s.emaSlow),
      morningHigh: r2(morning.high),
      morningLow: r2(morning.low),
      entryTime: at(entryIdx),
      entrySpot: r2(spot),
      entryPremium: entry,
      peakPremium: r2(res.peak),
      lowPremium: r2(res.low),
      maxGainPts: r2(res.peak - entry),
      beArmed: res.be,
      legs: legs.map((l) => ({ name: l.name, lots: l.lots, qty: l.lots * rule.lotSize, target: r2(l.target), exitTime: at(l.exitIdx), exitPremium: l.exitPx, points: l.pts, reason: l.why, pnl: r2(l.pts * l.lots * rule.lotSize) })),
      exitTime: at(exitIdx),
      exitSpot: r2(exitSpot),
      exitPremium: lastLeg.exitPx,
      exitType,
      exitReason: legs.map((l) => `${l.name} ${l.pts >= 0 ? '+' : ''}${l.pts}`).join(' · '),
      points,
      grossPnL,
      charges,
      netPnL,
      isWin: netPnL > 0,
      dayNetAfter: dayNet,
      events,
    });

    if (dayNet >= rule.dayProfitLock) stopReason = `day profit lock ₹${rule.dayProfitLock.toLocaleString('en-IN')} reached`;
    else if (dayNet <= -rule.dayLossLimit) stopReason = `day loss limit −₹${rule.dayLossLimit.toLocaleString('en-IN')} reached`;
    else if (slHits >= rule.maxSlHits) stopReason = `${rule.maxSlHits} stop losses today`;
    if (stopReason) events.push({ time: at(exitIdx), text: `Day net ₹${Math.round(dayNet).toLocaleString('en-IN')} → ${stopReason}: no more trades today` });
    const exitCandleStart = Math.floor(exitIdx / BAR) * BAR;
    nextAllowedStart = exitCandleStart + (rule.cooldownBars + 1) * BAR;
    while (ci + 1 < candles.length && candles[ci + 1].end + 1 <= exitIdx) ci += 1;
  }
  return trades;
}

function summarize(trades) {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const months = {};
  const years = {};
  const days = {};
  for (const t of trades) {
    equity += t.netPnL;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    days[t.date] = (days[t.date] || 0) + t.netPnL;
    if (!months[t.monthKey]) months[t.monthKey] = { key: t.monthKey, label: `${t.monthShort} ${t.monthKey.slice(2, 4)}`, trades: 0, wins: 0, pnl: 0 };
    const m = months[t.monthKey];
    m.trades += 1;
    if (t.isWin) m.wins += 1;
    m.pnl = r2(m.pnl + t.netPnL);
    const y = t.date.slice(0, 4);
    if (!years[y]) years[y] = { year: y, trades: 0, wins: 0, pnl: 0 };
    years[y].trades += 1;
    if (t.isWin) years[y].wins += 1;
    years[y].pnl = r2(years[y].pnl + t.netPnL);
  }
  const wins = trades.filter((t) => t.isWin);
  const losses = trades.filter((t) => !t.isWin);
  const grossWin = wins.reduce((a, t) => a + t.netPnL, 0);
  const grossLoss = losses.reduce((a, t) => a + t.netPnL, 0);
  const dayValues = Object.values(days);
  const charges = trades.reduce((a, t) => a + t.charges, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    avgWin: wins.length ? r2(grossWin / wins.length) : 0,
    avgLoss: losses.length ? r2(grossLoss / losses.length) : 0,
    profitFactor: grossLoss < 0 ? r2(grossWin / -grossLoss) : null,
    tradeDays: dayValues.length,
    greenDays: dayValues.filter((v) => v > 0).length,
    worstDay: dayValues.length ? r2(Math.min(...dayValues)) : 0,
    bestDay: dayValues.length ? r2(Math.max(...dayValues)) : 0,
    charges: r2(charges),
    avgCharges: trades.length ? r2(charges / trades.length) : 0,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
    years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

/**
 * @param {{ from: string, to: string, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function, onPartial?: Function }} opts
 */
async function runBacktest({ from, to, rule: ruleIn = {}, onProgress, onPartial } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const lots = rule.scalpLots + rule.runnerLots;
  const qty = lots * rule.lotSize;
  const fetchFrom = addDays(from, -WARMUP_DAYS);
  const live = await ensureDays(fetchFrom, to, { onProgress });
  const now = getIstClock(new Date());

  const dates = [];
  for (let d = fetchFrom; d <= to; d = addDays(d, 1)) dates.push(d);
  const total = dates.filter((d) => d >= from).length;
  const trades = [];
  const skippedSignals = [];
  const noTradeDays = [];
  const emaState = { fast: null, slow: null, count: 0 };
  let tradingDays = 0;
  let done = 0;
  const build = () => ({
    from,
    to,
    lots,
    qty,
    rule: { ...rule, entryFrom: hhmm(rule.entryFrom), entryTo: hhmm(rule.entryTo), eod: hhmm(rule.eod) },
    tradingDays,
    noTradeDays: [...noTradeDays],
    skippedSignals: skippedSignals.slice(-2000),
    summary: summarize(trades),
    trades: [...trades],
  });
  for (const d of dates) {
    if (d >= from) {
      done += 1;
      onProgress?.({ phase: 'simulate', done, total, dateKey: d });
    }
    const raw = loadDay(d, live);
    if (!raw) continue;
    const lastIdx = d === now.dateKey ? now.minutes - SESSION_FIRST - 1 : N - 1;
    const day = prepareDay(raw, lastIdx);
    applyEmas(day.candles, emaState, rule);
    if (d < from) continue;
    tradingDays += 1;
    const dayTrades = runDay(day, rule, qty, skippedSignals);
    if (!dayTrades.length) noTradeDays.push(d);
    trades.push(...dayTrades);
    if (done % 20 === 0) onPartial?.({ ...build(), doneThrough: d });
  }
  return build();
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START, PATTERN_LABEL };
