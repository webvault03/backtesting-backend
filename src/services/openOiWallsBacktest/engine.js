/**
 * Open OI Walls — historical backtest of the live paper engine (strategy-16).
 *
 * Every decision uses only bars that have already finished — nothing later in the day is read:
 *   Walls: OI of the 09:15 bar (known when it closes) − previous day's closing OI, per strike (nearest weekly).
 *     Put wall = largest |Put ΔOI| → buy CE · Call wall = largest |Call ΔOI| → buy PE. Strikes within
 *     ±lookaround strikes of spot (Dhan history has ATM±10). Like live: if a side has no ΔOI yet, wait for
 *     the next minute's OI (up to 09:20), then fall back to the largest absolute OI.
 *   +/− rule (backtest only): a day is traded only when one wall has + ΔOI and the other − ΔOI; only the
 *     + wall can be entered, the − wall never. Both +, both −, or an absolute-OI fallback wall → no trade.
 *   Entry (walls known → 10:15): a minute that opens inside ±proximity of a wall fills at that option open;
 *     a touch inside a minute fills at the next minute's option open (1-min data has no ticks — the next
 *     real price is used, never a guess from the touched minute's range). One trade per day.
 *   Exit (backtest, not live): the 15:15 close only — no target, no stop loss, no trail. Every level in
 *     `targets` and the option's high / low are tracked from entry to 15:15.
 */
const { addDays, ensureDays, loadDays } = require('./dataSource');
const { rangeChunks, chunkProgress } = require('../backtestChunks');

/** First day Dhan has weekly NIFTY option minute history. */
const HISTORY_START = '2020-08-03';
const STEP = 50;
const CAPTURE = 9 * 60 + 15;
const DOI_WAIT_MINUTES = 5;
const WARMUP_DAYS = 7;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_RULE = {
  lotSize: 65,
  charges: 100,
  proximity: 5,
  lookaround: 12,
  targets: [10, 20, 30, 40, 50],
  entryTo: 10 * 60 + 15,
  eod: 15 * 60 + 15,
  slippage: 0,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const signedPts = (n) => `${n >= 0 ? '+' : ''}${r2(n)}`;

function minuteMap(series) {
  const out = new Map();
  if (!series?.m) return out;
  series.m.forEach((m, i) => out.set(m, { o: series.o[i], h: series.h[i], l: series.l[i], c: series.c[i], oi: series.oi?.[i] }));
  return out;
}

const oiAt = (series, minute) => {
  const i = series?.m?.indexOf(minute);
  return i >= 0 && Number.isFinite(series.oi[i]) ? series.oi[i] : null;
};

/**
 * Yesterday's closing OI for today's nearest contract. Normally yesterday's nearest weekly; the day after
 * an expiry it is yesterday's second weekly — whichever continues into today's 09:15 OI.
 */
function pickBaseline(day, prev) {
  const near = prev?.closeOi?.near;
  const next = prev?.closeOi?.next;
  if (!near) return { base: null, source: null };
  const score = (base) => {
    let diff = 0;
    let size = 0;
    for (const side of ['CE', 'PE']) {
      for (const k of Object.keys(next?.[side] || {})) {
        const now = oiAt(day[side][k], CAPTURE);
        if (now == null || near[side][k] == null || base[side][k] == null) continue;
        diff += Math.abs(now - base[side][k]);
        size += now;
      }
    }
    return size > 0 ? diff / size : null;
  };
  const nearScore = score(near);
  const nextScore = next ? score(next) : null;
  if (nearScore != null && nextScore != null && nextScore < nearScore) return { base: next, source: 'next' };
  return { base: near, source: 'near' };
}

/** Option chain as seen at the close of `minute` (strikes within the lookaround). */
function chainAt(day, base, minute, spot, rule) {
  const span = rule.lookaround * STEP;
  const strikes = new Set([...Object.keys(day.CE || {}), ...Object.keys(day.PE || {})].map(Number));
  const rows = [];
  for (const strike of [...strikes].sort((a, b) => a - b)) {
    if (Math.abs(strike - spot) > span) continue;
    const k = String(strike);
    const callOi = oiAt(day.CE?.[k], minute);
    const putOi = oiAt(day.PE?.[k], minute);
    if (callOi == null && putOi == null) continue;
    const prevCall = base?.CE?.[k];
    const prevPut = base?.PE?.[k];
    rows.push({
      strike,
      callOi,
      callChg: callOi != null && prevCall != null ? callOi - prevCall : null,
      putOi,
      putChg: putOi != null && prevPut != null ? putOi - prevPut : null,
    });
  }
  return rows;
}

/** Live `buildWallsFromSnapshot`: top |ΔOI| per side, absolute-OI fallback when a side has no ΔOI. */
function wallsFromChain(rows) {
  let put = null;
  let call = null;
  for (const r of rows) {
    if (r.putChg && (!put || Math.abs(r.putChg) > Math.abs(put.oi))) put = { strike: r.strike, oi: r.putChg, label: 'doi_put_top' };
    if (r.callChg && (!call || Math.abs(r.callChg) > Math.abs(call.oi))) call = { strike: r.strike, oi: r.callChg, label: 'doi_call_top' };
  }
  for (const r of rows) {
    if ((!put || put.label === 'abs_put_fallback') && r.putOi > 0 && (!put || r.putOi > put.oi)) {
      put = { strike: r.strike, oi: r.putOi, label: 'abs_put_fallback' };
    }
    if ((!call || call.label === 'abs_call_fallback') && r.callOi > 0 && (!call || r.callOi > call.oi)) {
      call = { strike: r.strike, oi: r.callOi, label: 'abs_call_fallback' };
    }
  }
  const walls = [];
  if (put) walls.push({ side: 'PUT', optionType: 'CE', ...put });
  if (call) walls.push({ side: 'CALL', optionType: 'PE', ...call });
  return walls;
}

function captureWalls(day, prev, nifty, rule, events) {
  const { base, source } = pickBaseline(day, prev);
  for (let m = CAPTURE; m <= CAPTURE + DOI_WAIT_MINUTES; m += 1) {
    const spot = nifty.get(m)?.c;
    if (!Number.isFinite(spot)) continue;
    const chain = chainAt(day, base, m, spot, rule);
    const walls = wallsFromChain(chain);
    const fallback = walls.some((w) => w.label.startsWith('abs_'));
    if (walls.length && (!fallback || m === CAPTURE + DOI_WAIT_MINUTES)) {
      events.push({
        time: hhmm(m),
        text: `Walls captured from the ${hhmm(m)} bar close · spot ${r2(spot)} · Put ${walls.find((w) => w.side === 'PUT')?.strike ?? '—'} / Call ${walls.find((w) => w.side === 'CALL')?.strike ?? '—'}${source === 'next' ? ' · ΔOI vs previous day’s second weekly (day after expiry)' : ''}${fallback ? ' · absolute-OI fallback' : ''}`,
      });
      return { walls, chain, baseline: source, captureMin: m, spotAtCapture: r2(spot) };
    }
    if (walls.length) events.push({ time: hhmm(m), text: 'ΔOI missing on a side — waiting for the next minute (live waits up to 5 min)' });
  }
  return null;
}

/** Nearest wall inside ±proximity of `price`. */
function nearestWall(walls, price, proximity) {
  let best = null;
  let bestD = Infinity;
  for (const w of walls) {
    const d = Math.abs(price - w.strike);
    if (d <= proximity && d < bestD) {
      bestD = d;
      best = { ...w, distance: r2(d) };
    }
  }
  return best;
}

/** Running average of NIFTY 1-min closes from 09:15 through `throughMin` (finished minutes only). */
function runningAverage(nifty, throughMin) {
  let sum = 0;
  let n = 0;
  for (let m = CAPTURE; m <= throughMin; m += 1) {
    const c = nifty.get(m)?.c;
    if (Number.isFinite(c)) {
      sum += c;
      n += 1;
    }
  }
  return n ? sum / n : null;
}

/** First wall touch once the walls are known; fill at a real option open, never inside the touched minute. */
function findEntry(nifty, day, walls, fromMin, rule, events) {
  for (let m = fromMin; m <= rule.entryTo; m += 1) {
    const n = nifty.get(m);
    if (!n) continue;
    const atOpen = nearestWall(walls, n.o, rule.proximity);
    if (atOpen) {
      const bar = minuteMap(day[atOpen.optionType]?.[String(atOpen.strike)]).get(m);
      if (!bar) continue;
      // At a minute's open only the minutes before it have closed.
      const avgAtOpen = runningAverage(nifty, m - 1);
      events.push({ time: hhmm(m), text: `NIFTY opened ${r2(n.o)} — ${atOpen.distance} pts from the ${atOpen.strike} ${atOpen.side} wall → buy ${atOpen.optionType} at the ${hhmm(m)} open${avgAtOpen != null ? ` · running avg ${r2(avgAtOpen)}` : ''}` });
      return { wall: atOpen, min: m, spot: n.o, premium: bar.o, avg: avgAtOpen };
    }
    let touched = null;
    for (const w of walls) {
      if (n.h < w.strike - rule.proximity || n.l > w.strike + rule.proximity) continue;
      const fromOpen = Math.abs(n.o - w.strike);
      if (!touched || fromOpen < touched.fromOpen) touched = { ...w, fromOpen };
    }
    if (!touched) continue;
    const fill = m + 1;
    const fillSpot = nifty.get(fill)?.o;
    const bar = minuteMap(day[touched.optionType]?.[String(touched.strike)]).get(fill);
    if (!bar || !Number.isFinite(fillSpot)) continue;
    const avgAtFill = runningAverage(nifty, m);
    events.push({ time: hhmm(m), text: `NIFTY ${r2(n.l)}–${r2(n.h)} reached ±${rule.proximity} of the ${touched.strike} ${touched.side} wall` });
    events.push({ time: hhmm(fill), text: `Filled ${touched.optionType} ${touched.strike} at the ${hhmm(fill)} open (next real price after the touch) · NIFTY ${r2(fillSpot)} · running avg ${r2(avgAtFill)}` });
    return { wall: { ...touched, distance: r2(Math.abs(fillSpot - touched.strike)) }, min: fill, spot: fillSpot, premium: bar.o, avg: avgAtFill };
  }
  return null;
}

/** Day open / high / low / close of one option series (09:15 → 15:29), or null. */
function dayOhlc(series) {
  if (!series?.m?.length) return null;
  let o = null;
  let h = -Infinity;
  let l = Infinity;
  let c = null;
  series.m.forEach((m, i) => {
    if (m < CAPTURE || m > 15 * 60 + 29) return;
    if (o == null) o = series.o[i];
    h = Math.max(h, series.h[i]);
    l = Math.min(l, series.l[i]);
    c = series.c[i];
  });
  return o == null ? null : { o: r2(o), h: r2(h), l: r2(l), c: r2(c) };
}

/**
 * Exit at the 15:15 close only — no target, no stop. `high` / `low` and every level in `levels` (first time reached) cover entry → 15:15.
 */
function runExit({ book, entryMin, entry, rule }) {
  const levels = rule.targets.map((pts) => ({ pts, premium: r2(entry + pts), hit: false, time: null }));
  let exit = null;
  let high = { px: entry, min: entryMin };
  let low = { px: entry, min: entryMin };
  let last = entry;
  let lastMin = entryMin;
  let missing = 0;
  for (let m = entryMin; m <= rule.eod; m += 1) {
    const o = book.get(m);
    if (!o) {
      missing += 1;
      continue;
    }
    // The fill minute starts at the entry price, so only its range after the open counts.
    const open = m === entryMin ? entry : o.o;
    if (m === rule.eod) {
      if (open > high.px) high = { px: open, min: m };
      if (open < low.px) low = { px: open, min: m };
      if (!exit) exit = { type: 'DAY_CLOSE', min: m, premium: open };
      break;
    }
    if (o.h > high.px) high = { px: o.h, min: m };
    if (o.l < low.px) low = { px: o.l, min: m };
    for (const lv of levels) {
      if (!lv.hit && o.h >= lv.premium) Object.assign(lv, { hit: true, time: hhmm(m) });
    }
    last = o.c;
    lastMin = m;
  }
  return { ...(exit || { type: 'DAY_CLOSE', min: lastMin, premium: last }), levels, high, low, missing };
}

function runDay({ day, prev, rule, qty }) {
  const nifty = minuteMap(day.nifty);
  if (!nifty.get(CAPTURE)) return { skipped: 'no NIFTY 09:15 bar' };
  if (!prev) return { skipped: 'no previous day for ΔOI' };
  const events = [];
  const cap = captureWalls(day, prev, nifty, rule, events);
  if (!cap) return { skipped: 'no OI at 09:15' };
  const dayInfo = { walls: cap.walls, baseline: cap.baseline, spotAtCapture: cap.spotAtCapture };
  const putWall = cap.walls.find((w) => w.side === 'PUT');
  const callWall = cap.walls.find((w) => w.side === 'CALL');
  const fmt = (w) => `${w.side} ${w.strike} ${w.label.startsWith('doi_') ? `ΔOI ${w.oi > 0 ? '+' : ''}${w.oi.toLocaleString('en-IN')}` : '(no ΔOI)'}`;
  const sign = (w) => (w?.label.startsWith('doi_') ? Math.sign(w.oi) : 0);
  if (!putWall || !callWall) return { skipped: 'only one wall found — need one + and one − wall', ...dayInfo };
  if (sign(putWall) === 0 || sign(callWall) === 0) {
    return { skipped: `wall without ΔOI (${fmt(putWall)} / ${fmt(callWall)}) — need one + and one − wall`, ...dayInfo };
  }
  if (sign(putWall) === sign(callWall)) {
    const both = sign(putWall) > 0 ? 'both walls +' : 'both walls −';
    return { skipped: `${both} (${fmt(putWall)} / ${fmt(callWall)}) — need one + and one − wall`, ...dayInfo };
  }
  const plus = sign(putWall) > 0 ? putWall : callWall;
  const minus = plus === putWall ? callWall : putWall;
  events.push({ time: hhmm(cap.captureMin), text: `+/− rule: trade only ${fmt(plus)} → ${plus.optionType}; never ${fmt(minus)}` });

  const hit = findEntry(nifty, day, [plus], cap.captureMin + 1, rule, events);
  if (!hit) {
    return { skipped: `spot never within ±${rule.proximity} of the + wall ${plus.side} ${plus.strike} by ${hhmm(rule.entryTo)}`, ...dayInfo };
  }

  const { wall } = hit;
  const book = minuteMap(day[wall.optionType][String(wall.strike)]);
  const entryPremium = r2(hit.premium + rule.slippage);
  const exit = runExit({ book, entryMin: hit.min, entry: entryPremium, rule });
  const exitPremium = r2(Math.max(0.05, exit.premium - rule.slippage));
  const points = r2(exitPremium - entryPremium);
  const grossPnL = r2(points * qty);
  const netPnL = r2(grossPnL - rule.charges);
  const exitSpot = nifty.get(exit.min)?.o ?? nifty.get(exit.min - 1)?.c ?? hit.spot;
  const reason = `${hhmm(rule.eod)} CLOSE`;
  events.push({ time: hhmm(exit.min), text: `Exit ₹${exitPremium} — ${reason} · ${points >= 0 ? '+' : ''}${points} pts` });
  events.push({
    time: hhmm(rule.eod),
    text: `Entry → ${hhmm(rule.eod)}: high ₹${r2(exit.high.px)} (${signedPts(exit.high.px - entryPremium)}) at ${hhmm(exit.high.min)} · low ₹${r2(exit.low.px)} (${signedPts(exit.low.px - entryPremium)}) at ${hhmm(exit.low.min)}`,
  });
  const month = Number(day.dateKey.slice(5, 7));
  const wallsWithOhlc = cap.walls.map((w) => ({ ...w, ohlc: dayOhlc(day[w.optionType]?.[String(w.strike)]) }));
  return {
    ...dayInfo,
    trade: {
      id: `${day.dateKey}-${wall.optionType}-${wall.strike}`,
      date: day.dateKey,
      monthKey: day.dateKey.slice(0, 7),
      monthShort: MONTHS[month - 1],
      side: wall.optionType,
      strike: wall.strike,
      wallSide: wall.side,
      wallOi: wall.oi,
      wallLabel: wall.label,
      walls: wallsWithOhlc,
      chain: cap.chain,
      baseline: cap.baseline,
      captureTime: hhmm(cap.captureMin),
      spotAtCapture: cap.spotAtCapture,
      distance: wall.distance,
      entryTime: hhmm(hit.min),
      entrySpot: r2(hit.spot),
      avgAtEntry: hit.avg != null ? r2(hit.avg) : null,
      entryPremium,
      targetLevels: exit.levels,
      highAfterEntry: r2(exit.high.px),
      highAfterTime: hhmm(exit.high.min),
      maxGainPts: r2(exit.high.px - entryPremium),
      lowAfterEntry: r2(exit.low.px),
      lowAfterTime: hhmm(exit.low.min),
      maxDropPts: r2(exit.low.px - entryPremium),
      missingBars: exit.missing,
      exitTime: hhmm(exit.min),
      exitSpot: r2(exitSpot),
      exitPremium,
      exitType: exit.type,
      exitReason: reason,
      points,
      grossPnL,
      netPnL,
      isWin: netPnL > 0,
      events,
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
  return {
    trades: trades.length,
    wins,
    losses: trades.length - wins,
    netPnL: r2(equity),
    maxDrawdown: r2(maxDd),
    worstTrade: trades.length ? r2(Math.min(...trades.map((t) => t.netPnL))) : 0,
    months: Object.values(months).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * Runs in 25-day pieces: each piece is downloaded, simulated and published via `onPartial` before the
 * next piece is fetched.
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function, onPartial?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress, onPartial } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * rule.lotSize;
  const trades = [];
  const skippedDays = [];
  let tradingDays = 0;
  const build = (doneThrough) => ({
    from,
    to,
    lots,
    qty,
    rule: { ...rule, entryTo: hhmm(rule.entryTo), eod: hhmm(rule.eod) },
    tradingDays,
    skippedDays: [...skippedDays],
    summary: summarize(trades),
    trades: [...trades],
    ...(doneThrough ? { doneThrough } : {}),
  });

  const chunks = rangeChunks(from, to, { warmupDays: WARMUP_DAYS });
  for (const [ci, chunk] of chunks.entries()) {
    const report = chunkProgress(onProgress, ci, chunks.length, chunk.label, () => ({ tradesSoFar: trades.length }));
    const fetchFrom = addDays(chunk.from, -WARMUP_DAYS);
    const live = await ensureDays(fetchFrom, chunk.to, { onProgress: report });
    const days = loadDays(fetchFrom, chunk.to, live);
    const total = days.filter((d) => d.dateKey >= chunk.from).length;
    let done = 0;
    days.forEach((day, i) => {
      if (day.dateKey < chunk.from) return;
      report({ phase: 'simulate', done, total, dateKey: day.dateKey });
      done += 1;
      const r = runDay({ day, prev: days[i - 1], rule, qty });
      if (r.trade) trades.push(r.trade);
      else skippedDays.push({ dateKey: day.dateKey, reason: r.skipped, walls: r.walls || [], spotAtCapture: r.spotAtCapture ?? null });
    });
    tradingDays += total;
    onPartial?.(build(chunk.to));
  }

  return build(null);
}

module.exports = { runBacktest, pickBaseline, DEFAULT_RULE, HISTORY_START };
