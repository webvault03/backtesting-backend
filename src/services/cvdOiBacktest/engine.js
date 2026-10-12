/**
 * CVD + ΔOI — historical backtest engine (NIFTY weekly options, Dhan 1-minute history).
 *
 * CVD (estimated — Dhan has no aggressor side):
 *   Per option strike and minute: delta = volume × (close-location + tick-rule) / 2
 *     close-location = (2·close − high − low) / (high − low)        ∈ [−1, 1]
 *     tick-rule      = sign(close − previous close), flat → previous sign
 *   Market delta (minute) = Σ call delta − Σ put delta over strikes ATM±2; CVD = running sum from 09:15.
 *
 * ΔOI over the lookback (ATM±2 at the signal minute): OI score = put ΔOI − call ΔOI.
 *   > 0 → put writing / call unwinding dominates (bullish), < 0 → call writing dominates (bearish).
 *
 * Setups on closed 5-min NIFTY bars (09:15–09:44 = opening range):
 *   BREAKOUT  CE: close crosses above OR high / previous day high, CVD rising, OI score > 0.  PE mirror.
 *             SL = signal bar low (CE) / high (PE) ∓ 2.
 *   REVERSAL  CE: bar makes a new session low at/under OR low or previous day low and closes back above it,
 *             CVD at that low is higher than at the earlier session low (≥15 min before), OI score > 0. PE mirror.
 *             SL = the new low − 2 (CE) / new high + 2 (PE).
 * Entry: ATM option at the next minute's open (+ slippage). Risk outside [minRisk, maxRisk] NIFTY pts:
 *   below → widened to minRisk, above → trade skipped.
 * Exit on NIFTY: target = rr × risk, SL, stop moved to entry once NIFTY is beAtR × risk in profit, 15:15 close.
 */
const { addDays } = require('../oiCandleAgreeBacktest/dataSource');
const { ensureDays, loadDay, SESSION_FIRST, SESSION_LAST } = require('./dataSource');

const STEP = 50;
const LOT_SIZE = 65;
const BAR = 5;
const OR_BARS = 6;
const STRIKE_BAND = 2;
const SL_BUFFER = 2;
const TOUCH_BUFFER = 5;
const DIVERGENCE_GAP_MIN = 15;
const EOD = 15 * 60 + 15;
const N = SESSION_LAST - SESSION_FIRST + 1;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  setups: 'both',
  lookbackBars: 3,
  rr: 2,
  minRisk: 10,
  maxRisk: 40,
  beAtR: 1,
  maxTrades: 2,
  stopAfterWin: true,
  requireCvd: true,
  requireOi: true,
  lastEntry: 14 * 60 + 30,
  slippage: 1,
  charges: 100,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const atmOf = (spot) => Math.round(spot / STEP) * STEP;

/** Minute index (0 = 09:15) → { o, h, l, c } / option fields; missing minutes stay undefined. */
function toIndexed(series, fields) {
  const out = new Array(N);
  if (!series?.m) return out;
  series.m.forEach((m, i) => {
    const idx = m - SESSION_FIRST;
    if (idx < 0 || idx >= N) return;
    const bar = {};
    for (const f of fields) bar[f] = series[f][i];
    out[idx] = bar;
  });
  return out;
}

/** Per-strike estimated delta per minute and forward-filled OI. */
function strikeFlow(bars) {
  const delta = new Float64Array(N);
  const oi = new Array(N).fill(null);
  let prevClose = null;
  let prevSign = 0;
  let lastOi = null;
  for (let i = 0; i < N; i += 1) {
    const b = bars[i];
    if (b) {
      const span = b.h - b.l;
      const clv = span > 0 ? (2 * b.c - b.h - b.l) / span : 0;
      let sign = prevSign;
      if (prevClose != null && b.c !== prevClose) sign = b.c > prevClose ? 1 : -1;
      const tickPart = prevClose == null ? clv : sign;
      delta[i] = (Number(b.v) || 0) * ((clv + tickPart) / 2);
      prevClose = b.c;
      prevSign = sign;
      if (Number.isFinite(b.oi) && b.oi > 0) lastOi = b.oi;
    }
    oi[i] = lastOi;
  }
  return { bars, delta, oi };
}

function prepareDay(raw) {
  const nifty = toIndexed(raw.nifty, ['o', 'h', 'l', 'c']);
  const opt = { CE: new Map(), PE: new Map() };
  for (const side of ['CE', 'PE']) {
    for (const [strike, s] of Object.entries(raw[side] || {})) {
      opt[side].set(Number(strike), strikeFlow(toIndexed(s, ['o', 'h', 'l', 'c', 'v', 'oi'])));
    }
  }

  const spot = new Array(N).fill(null);
  let last = null;
  for (let i = 0; i < N; i += 1) {
    if (nifty[i]) last = nifty[i].c;
    spot[i] = last;
  }

  const cvd = new Float64Array(N);
  let run = 0;
  for (let i = 0; i < N; i += 1) {
    if (spot[i] != null) {
      const atm = atmOf(spot[i]);
      for (let k = -STRIKE_BAND; k <= STRIKE_BAND; k += 1) {
        const strike = atm + k * STEP;
        run += (opt.CE.get(strike)?.delta[i] || 0) - (opt.PE.get(strike)?.delta[i] || 0);
      }
    }
    cvd[i] = run;
  }

  const bars = [];
  for (let start = 0; start + BAR - 1 < N; start += BAR) {
    let o = null;
    let h = -Infinity;
    let l = Infinity;
    let c = null;
    let hIdx = start;
    let lIdx = start;
    for (let i = start; i < start + BAR; i += 1) {
      const b = nifty[i];
      if (!b) continue;
      if (o == null) o = b.o;
      if (b.h > h) {
        h = b.h;
        hIdx = i;
      }
      if (b.l < l) {
        l = b.l;
        lIdx = i;
      }
      c = b.c;
    }
    bars.push(o == null ? null : { start, end: start + BAR - 1, o, h, l, c, hIdx, lIdx });
  }

  const valid = bars.filter(Boolean);
  return {
    dateKey: raw.dateKey,
    nifty,
    opt,
    spot,
    cvd,
    bars,
    high: valid.length ? Math.max(...valid.map((b) => b.h)) : null,
    low: valid.length ? Math.min(...valid.map((b) => b.l)) : null,
  };
}

/** OI score over (from, to] on strikes ATM±2 at `to`: put ΔOI − call ΔOI, plus the two legs. */
function oiFlow(day, fromIdx, toIdx) {
  const atm = atmOf(day.spot[toIdx]);
  let callDoi = 0;
  let putDoi = 0;
  for (let k = -STRIKE_BAND; k <= STRIKE_BAND; k += 1) {
    const strike = atm + k * STEP;
    const ce = day.opt.CE.get(strike);
    const pe = day.opt.PE.get(strike);
    if (ce?.oi[toIdx] != null && ce.oi[fromIdx] != null) callDoi += ce.oi[toIdx] - ce.oi[fromIdx];
    if (pe?.oi[toIdx] != null && pe.oi[fromIdx] != null) putDoi += pe.oi[toIdx] - pe.oi[fromIdx];
  }
  return { callDoi, putDoi, score: putDoi - callDoi };
}

/** First signal on a closed bar after `afterIdx`, or null. */
function findSignal(day, prev, rule, afterIdx) {
  const { bars, cvd } = day;
  const orBars = bars.slice(0, OR_BARS).filter(Boolean);
  if (orBars.length < OR_BARS) return null;
  const orHigh = Math.max(...orBars.map((b) => b.h));
  const orLow = Math.min(...orBars.map((b) => b.l));
  const lookback = rule.lookbackBars * BAR;
  const lastEntryIdx = rule.lastEntry - SESSION_FIRST;

  let sessHigh = orHigh;
  let sessLow = orLow;
  let sessHighIdx = orBars.find((b) => b.h === orHigh).hIdx;
  let sessLowIdx = orBars.find((b) => b.l === orLow).lIdx;

  for (let bi = OR_BARS; bi < bars.length; bi += 1) {
    const bar = bars[bi];
    const prevBar = bars[bi - 1];
    if (!bar) continue;
    const e = bar.end;
    const usable = e + 1 > afterIdx && e + 1 <= lastEntryIdx && prevBar;

    if (usable) {
      const from = Math.max(0, e - lookback);
      const cvdSlope = cvd[e] - cvd[from];
      const flow = oiFlow(day, from, e);
      const cvdOk = (dir) => !rule.requireCvd || (dir > 0 ? cvdSlope > 0 : cvdSlope < 0);
      const oiOk = (dir) => !rule.requireOi || (dir > 0 ? flow.score > 0 : flow.score < 0);
      const base = { barIdx: bi, signalIdx: e, cvdSlope, ...flow };

      if (rule.setups !== 'reversal') {
        const upLevels = [['OR high', orHigh], ['Prev high', prev?.high]];
        const downLevels = [['OR low', orLow], ['Prev low', prev?.low]];
        const up = upLevels.find(([, lv]) => Number.isFinite(lv) && prevBar.c <= lv && bar.c > lv);
        if (up && cvdOk(1) && oiOk(1)) {
          return { ...base, side: 'CE', setup: 'BREAKOUT', level: up[0], levelPrice: up[1], stop: bar.l - SL_BUFFER };
        }
        const down = downLevels.find(([, lv]) => Number.isFinite(lv) && prevBar.c >= lv && bar.c < lv);
        if (down && cvdOk(-1) && oiOk(-1)) {
          return { ...base, side: 'PE', setup: 'BREAKOUT', level: down[0], levelPrice: down[1], stop: bar.h + SL_BUFFER };
        }
      }

      if (rule.setups !== 'breakout') {
        const supports = [['OR low', orLow], ['Prev low', prev?.low]];
        const resistances = [['OR high', orHigh], ['Prev high', prev?.high]];
        if (bar.l <= sessLow && bar.lIdx - sessLowIdx >= DIVERGENCE_GAP_MIN) {
          const s = supports.find(([, lv]) => Number.isFinite(lv) && bar.l <= lv + TOUCH_BUFFER && bar.c > lv);
          const divergence = cvd[bar.lIdx] > cvd[sessLowIdx];
          if (s && (!rule.requireCvd || divergence) && oiOk(1)) {
            return { ...base, side: 'CE', setup: 'REVERSAL', level: s[0], levelPrice: s[1], stop: bar.l - SL_BUFFER };
          }
        }
        if (bar.h >= sessHigh && bar.hIdx - sessHighIdx >= DIVERGENCE_GAP_MIN) {
          const r = resistances.find(([, lv]) => Number.isFinite(lv) && bar.h >= lv - TOUCH_BUFFER && bar.c < lv);
          const divergence = cvd[bar.hIdx] < cvd[sessHighIdx];
          if (r && (!rule.requireCvd || divergence) && oiOk(-1)) {
            return { ...base, side: 'PE', setup: 'REVERSAL', level: r[0], levelPrice: r[1], stop: bar.h + SL_BUFFER };
          }
        }
      }
    }

    if (bar.h > sessHigh) {
      sessHigh = bar.h;
      sessHighIdx = bar.hIdx;
    }
    if (bar.l < sessLow) {
      sessLow = bar.l;
      sessLowIdx = bar.lIdx;
    }
  }
  return null;
}

/** Option price at the moment NIFTY touched `level`, read at the same position inside the minute's ranges. */
function premiumAtLevel(niftyBar, optBar, level, side) {
  const span = niftyBar.h - niftyBar.l;
  if (!(span > 0)) return optBar.o;
  const fromLow = (level - niftyBar.l) / span;
  const pos = side === 'CE' ? fromLow : 1 - fromLow;
  return optBar.l + Math.min(1, Math.max(0, pos)) * (optBar.h - optBar.l);
}

/** Minute walk on NIFTY from the entry minute: stop first when both levels sit in one minute. */
function simulate({ day, side, book, entryIdx, entrySpot, entryPremium, stop, target, risk, rule }) {
  const dir = side === 'CE' ? 1 : -1;
  const eodIdx = EOD - SESSION_FIRST;
  let sl = stop;
  let movedToBe = false;
  let peak = entryPremium;
  let lastPrem = entryPremium;
  let lastSpot = entrySpot;
  for (let i = entryIdx; i <= eodIdx; i += 1) {
    const n = day.nifty[i];
    const o = book.bars[i];
    if (i === eodIdx) {
      return { type: 'EOD', idx: i, premium: o ? o.o : lastPrem, spot: n ? n.o : lastSpot, peak };
    }
    if (!n || !o) continue;
    const open = i === entryIdx ? entrySpot : n.o;
    const adverse = dir > 0 ? n.l : n.h;
    const favourable = dir > 0 ? n.h : n.l;
    if (dir > 0 ? adverse <= sl : adverse >= sl) {
      const gapped = dir > 0 ? open <= sl : open >= sl;
      const premium = gapped ? o.o : premiumAtLevel(n, o, sl, side);
      return { type: movedToBe ? 'BE' : 'SL', idx: i, premium, spot: gapped ? open : sl, peak };
    }
    if (dir > 0 ? favourable >= target : favourable <= target) {
      const gapped = dir > 0 ? open >= target : open <= target;
      const premium = gapped ? o.o : premiumAtLevel(n, o, target, side);
      return { type: 'TARGET', idx: i, premium, spot: gapped ? open : target, peak: Math.max(peak, premium) };
    }
    peak = Math.max(peak, o.h);
    if (!movedToBe && rule.beAtR > 0 && dir * (favourable - entrySpot) >= rule.beAtR * risk) {
      sl = entrySpot;
      movedToBe = true;
    }
    lastPrem = o.c;
    lastSpot = n.c;
  }
  return null;
}

function runDay(day, prev, rule, qty) {
  const trades = [];
  let afterIdx = -1;
  for (let t = 0; t < rule.maxTrades; t += 1) {
    const sig = findSignal(day, prev, rule, afterIdx);
    if (!sig) break;
    const entryIdx = sig.signalIdx + 1;
    const entryBar = day.nifty[entryIdx];
    if (!entryBar) {
      afterIdx = entryIdx;
      t -= 1;
      continue;
    }
    const entrySpot = entryBar.o;
    const dir = sig.side === 'CE' ? 1 : -1;
    let stop = sig.stop;
    let risk = dir * (entrySpot - stop);
    if (risk > rule.maxRisk) {
      afterIdx = entryIdx;
      t -= 1;
      continue;
    }
    if (risk < rule.minRisk) {
      risk = rule.minRisk;
      stop = entrySpot - dir * risk;
    }
    const target = entrySpot + dir * rule.rr * risk;
    const strike = atmOf(entrySpot);
    const book = day.opt[sig.side].get(strike);
    const optBar = book?.bars[entryIdx];
    if (!optBar) {
      afterIdx = entryIdx;
      t -= 1;
      continue;
    }
    const entryPremium = r2(optBar.o + rule.slippage);
    const exit = simulate({ day, side: sig.side, book, entryIdx, entrySpot, entryPremium, stop, target, risk, rule });
    if (!exit) break;

    const exitPremium = r2(Math.max(0.05, exit.premium - rule.slippage));
    const points = r2(exitPremium - entryPremium);
    const netPnL = r2(points * qty - rule.charges);
    const month = Number(day.dateKey.slice(5, 7));
    trades.push({
      id: `${day.dateKey}-${hhmm(SESSION_FIRST + entryIdx)}-${sig.side}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: `${MONTHS[month - 1]} ${day.dateKey.slice(2, 4)}`,
      side: sig.side,
      setup: sig.setup,
      level: sig.level,
      levelPrice: r2(sig.levelPrice),
      signalTime: hhmm(SESSION_FIRST + day.bars[sig.barIdx].start),
      cvdSlope: Math.round(sig.cvdSlope),
      callDoi: Math.round(sig.callDoi),
      putDoi: Math.round(sig.putDoi),
      entryTime: hhmm(SESSION_FIRST + entryIdx),
      entrySpot: r2(entrySpot),
      slSpot: r2(stop),
      targetSpot: r2(target),
      risk: r2(risk),
      strike,
      entryPremium,
      peakPremium: r2(exit.peak),
      maxGainPts: r2(exit.peak - entryPremium),
      exitTime: hhmm(SESSION_FIRST + exit.idx),
      exitSpot: r2(exit.spot),
      exitPremium,
      exitType: exit.type,
      exitReason: { TARGET: `Target ${rule.rr}R`, SL: 'NIFTY SL', BE: 'Breakeven stop', EOD: '15:15 close' }[exit.type],
      niftyPts: r2(dir * (exit.spot - entrySpot)),
      points,
      netPnL,
      isWin: netPnL > 0,
    });
    afterIdx = exit.idx;
    if (rule.stopAfterWin && netPnL > 0) break;
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
    if (!months[t.monthKey]) months[t.monthKey] = { key: t.monthKey, label: t.monthShort, trades: 0, wins: 0, pnl: 0 };
    const m = months[t.monthKey];
    m.trades += 1;
    if (t.isWin) m.wins += 1;
    m.pnl = r2(m.pnl + t.netPnL);
    const y = t.date.slice(0, 4);
    if (!years[y]) years[y] = { year: y, trades: 0, wins: 0, pnl: 0, months: 0, greenMonths: 0 };
    years[y].trades += 1;
    if (t.isWin) years[y].wins += 1;
    years[y].pnl = r2(years[y].pnl + t.netPnL);
  }
  const monthList = Object.values(months).sort((a, b) => a.key.localeCompare(b.key));
  for (const m of monthList) {
    const y = years[m.key.slice(0, 4)];
    y.months += 1;
    if (m.pnl > 0) y.greenMonths += 1;
  }
  const wins = trades.filter((t) => t.isWin);
  const losses = trades.filter((t) => !t.isWin);
  const grossWin = wins.reduce((a, t) => a + t.netPnL, 0);
  const grossLoss = losses.reduce((a, t) => a + t.netPnL, 0);
  const dayValues = Object.values(days);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    avgWin: wins.length ? r2(grossWin / wins.length) : 0,
    avgLoss: losses.length ? r2(grossLoss / losses.length) : 0,
    profitFactor: grossLoss < 0 ? r2(grossWin / -grossLoss) : null,
    worstDay: dayValues.length ? r2(Math.min(...dayValues)) : 0,
    greenMonths: monthList.filter((m) => m.pnl > 0).length,
    months: monthList,
    years: Object.values(years).sort((a, b) => a.year.localeCompare(b.year)),
  };
}

/**
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * LOT_SIZE;
  const fetchFrom = addDays(from, -7);
  const live = await ensureDays(fetchFrom, to, { onProgress });

  const dates = [];
  for (let d = fetchFrom; d <= to; d = addDays(d, 1)) dates.push(d);
  const total = dates.filter((d) => d >= from).length;
  const trades = [];
  let tradingDays = 0;
  let prev = null;
  let done = 0;
  for (const d of dates) {
    if (d >= from) {
      done += 1;
      onProgress?.({ phase: 'simulate', done, total, dateKey: d });
    }
    const raw = loadDay(d, live);
    if (!raw) continue;
    const day = prepareDay(raw);
    if (d >= from) {
      tradingDays += 1;
      trades.push(...runDay(day, prev, rule, qty));
    }
    prev = { high: day.high, low: day.low };
  }

  return {
    from,
    to,
    lots,
    qty,
    rule,
    tradingDays,
    summary: summarize(trades),
    trades,
  };
}

module.exports = { runBacktest, DEFAULT_RULE };
