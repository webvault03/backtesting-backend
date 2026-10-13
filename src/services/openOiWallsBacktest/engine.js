/**
 * Open OI Walls — historical backtest of the live paper engine (strategy-16).
 *
 * Every decision uses only bars that have already finished — nothing later in the day is read:
 *   Walls: OI of the 09:15 bar (known when it closes) − previous day's closing OI, per strike (nearest weekly).
 *     Put wall = largest |Put ΔOI| → buy CE · Call wall = largest |Call ΔOI| → buy PE. Strikes within
 *     ±lookaround strikes of spot (Dhan history has ATM±10). Like live: if a side has no ΔOI yet, wait for
 *     the next minute's OI (up to 09:20), then fall back to the largest absolute OI.
 *   Entry (walls known → 10:15): a minute that opens inside ±proximity of a wall fills at that option open;
 *     a touch inside a minute fills at the next minute's option open (1-min data has no ticks — the next
 *     real price is used, never a guess from the touched minute's range). One trade per day.
 *   Exit (live trail): peak +20/+30/+40/+50/+70 locks +10/+20/+25/+30/+50, from +40 also peak − 20;
 *     option back to the lock → exit at the lock. Until armed: SL entry − 80 and exit at 11:30. Close 15:15.
 *   Average exit (until armed, optional): a minute closing with NIFTY avgExitPts on the wrong side of the
 *     running average of 1-min closes (CE below, PE above; measured from where the trade started if it
 *     began on the wrong side) → exit at the next minute's option open.
 *     Within a minute stops are checked before the minute's high raises the lock (new lock applies next
 *     minute), and a stop is checked before a rung in the same minute.
 */
const { addDays, ensureDays, loadDays } = require('./dataSource');
const { TRAIL_RUNGS, PEAK_TRAIL_GAP, computeTrailLockPoints } = require('../../utils/openOiWallsTrail');

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
  proximity: 25,
  lookaround: 12,
  emergencySl: 80,
  unarmedExit: 11 * 60 + 30,
  entryTo: 10 * 60 + 15,
  eod: 15 * 60 + 15,
  slippage: 0,
  avgExit: true,
  avgExitPts: 15,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const stamp = (dateKey, m) => `${dateKey}T${hhmm(m)}:00+05:30`;

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
  for (const w of walls) {
    const d = Math.abs(price - w.strike);
    if (d <= proximity && (!best || d < best.distance)) best = { ...w, distance: r2(d) };
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

/** How far NIFTY's close of `m` sits on the wrong side of the running average (CE: below, PE: above). */
function againstAverage(nifty, m, optionType) {
  const close = nifty.get(m)?.c;
  const avg = runningAverage(nifty, m);
  if (!Number.isFinite(close) || avg == null) return null;
  return { pts: optionType === 'CE' ? avg - close : close - avg, close, avg };
}

function runExit({ dateKey, book, nifty, optionType, entryMin, entry, startAgainst, qty, rule, events }) {
  const slPx = rule.emergencySl > 0 ? r2(entry - rule.emergencySl) : null;
  // A trade that starts on the wrong side of the average must move a further avgExitPts against it.
  const avgTrigger = rule.avgExit ? Math.max(rule.avgExitPts, (startAgainst ?? 0) + rule.avgExitPts) : null;
  let avgSignal = false;
  const milestones = TRAIL_RUNGS.map((r) => ({
    points: r.peak,
    lockPoints: r.lock,
    role: 'trail_arm',
    premium: r2(entry + r.peak),
    status: 'PENDING',
    hitAt: null,
    hitPremium: null,
    pnlAtHit: null,
  }));
  let peak = entry;
  let lock = null;
  let last = entry;
  let lastMin = entryMin;
  let missing = 0;
  const done = (type, m, premium) => ({ type, min: m, premium, peak, lock, milestones, missing });
  for (let m = entryMin; m <= rule.eod; m += 1) {
    const o = book.get(m);
    if (!o) {
      missing += 1;
      continue;
    }
    // The fill minute starts at the entry price, so only its range after the open can stop the trade.
    const open = m === entryMin ? entry : o.o;
    if (m === rule.eod) return done('DAY_CLOSE', m, open);
    if (lock != null) {
      const lockPx = r2(entry + lock);
      if (open <= lockPx) return done('TRAIL', m, open);
      if (o.l <= lockPx) return done('TRAIL', m, lockPx);
    } else {
      if (avgSignal) return done('AVG_EXIT', m, open);
      if (m >= rule.unarmedExit) return done('TIME_EXIT', m, open);
      if (slPx != null && open <= slPx) return done('SL', m, open);
      if (slPx != null && o.l <= slPx) return done('SL', m, slPx);
    }
    peak = Math.max(peak, o.h);
    const hitNow = [];
    for (const ms of milestones) {
      if (ms.status === 'PENDING' && peak - entry >= ms.points) {
        ms.status = 'HIT';
        ms.hitAt = stamp(dateKey, m);
        ms.hitPremium = ms.premium;
        ms.pnlAtHit = r2(ms.points * qty - rule.charges);
        hitNow.push(`+${ms.points}`);
      }
    }
    const raw = computeTrailLockPoints(peak - entry);
    const next = raw != null ? r2(raw) : null;
    if (next != null && (lock == null || next > lock)) {
      lock = next;
      const lockText = `lock +${lock} (₹${r2(entry + lock)})${peak - entry >= 40 ? ` · peak − ${PEAK_TRAIL_GAP} active` : ''}`;
      events.push({
        time: hhmm(m),
        text: hitNow.length
          ? `Peak ₹${r2(peak)} (+${r2(peak - entry)}) — rung ${hitNow.join(', ')} hit → ${lockText}`
          : `Peak ₹${r2(peak)} → ${lockText}`,
      });
    }
    if (lock == null && avgTrigger != null) {
      const a = againstAverage(nifty, m, optionType);
      if (a && a.pts >= avgTrigger) {
        avgSignal = true;
        events.push({
          time: hhmm(m),
          text: `Trail not armed · NIFTY closed ${r2(a.close)}, ${r2(a.pts)} pts ${optionType === 'CE' ? 'below' : 'above'} the running avg ${r2(a.avg)} (trigger ${r2(avgTrigger)}) → exit at the next minute open`,
        });
      }
    }
    last = o.c;
    lastMin = m;
  }
  return done('DAY_CLOSE', lastMin, last);
}

function runDay({ day, prev, rule, qty }) {
  const nifty = minuteMap(day.nifty);
  if (!nifty.get(CAPTURE)) return { skipped: 'no NIFTY 09:15 bar' };
  if (!prev) return { skipped: 'no previous day for ΔOI' };
  const events = [];
  const cap = captureWalls(day, prev, nifty, rule, events);
  if (!cap) return { skipped: 'no OI at 09:15' };
  const dayInfo = { walls: cap.walls, baseline: cap.baseline, spotAtCapture: cap.spotAtCapture };

  const hit = findEntry(nifty, day, cap.walls, cap.captureMin + 1, rule, events);
  if (!hit) return { skipped: `spot never within ±${rule.proximity} of a wall by ${hhmm(rule.entryTo)}`, ...dayInfo };

  const { wall } = hit;
  const book = minuteMap(day[wall.optionType][String(wall.strike)]);
  const entryPremium = r2(hit.premium + rule.slippage);
  const startAgainst = hit.avg != null ? (wall.optionType === 'CE' ? hit.avg - hit.spot : hit.spot - hit.avg) : 0;
  const exit = runExit({
    dateKey: day.dateKey,
    book,
    nifty,
    optionType: wall.optionType,
    entryMin: hit.min,
    entry: entryPremium,
    startAgainst,
    qty,
    rule,
    events,
  });
  for (const ms of exit.milestones) if (ms.status === 'PENDING') ms.status = 'MISSED';
  const exitPremium = r2(Math.max(0.05, exit.premium - rule.slippage));
  const points = r2(exitPremium - entryPremium);
  const grossPnL = r2(points * qty);
  const netPnL = r2(grossPnL - rule.charges);
  const exitSpot = nifty.get(exit.min)?.o ?? nifty.get(exit.min - 1)?.c ?? hit.spot;
  const reason = {
    TRAIL: `TRAIL lock +${exit.lock} @ ${hhmm(exit.min)}`,
    SL: `SL −${rule.emergencySl} @ ${hhmm(exit.min)}`,
    TIME_EXIT: `Not armed by ${hhmm(rule.unarmedExit)}`,
    AVG_EXIT: `NIFTY against avg @ ${hhmm(exit.min)}`,
    DAY_CLOSE: `${hhmm(rule.eod)} CLOSE`,
  }[exit.type];
  events.push({ time: hhmm(exit.min), text: `Exit ₹${exitPremium} — ${reason} · ${points >= 0 ? '+' : ''}${points} pts` });
  const month = Number(day.dateKey.slice(5, 7));
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
      walls: cap.walls,
      chain: cap.chain,
      baseline: cap.baseline,
      captureTime: hhmm(cap.captureMin),
      spotAtCapture: cap.spotAtCapture,
      distance: wall.distance,
      entryTime: hhmm(hit.min),
      entrySpot: r2(hit.spot),
      avgAtEntry: hit.avg != null ? r2(hit.avg) : null,
      entryPremium,
      peakPremium: r2(exit.peak),
      maxGainPts: r2(exit.peak - entryPremium),
      lockPts: exit.lock,
      milestones: exit.milestones,
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
 * @param {{ from: string, to: string, lots?: number, rule?: Partial<typeof DEFAULT_RULE>, onProgress?: Function }} opts
 */
async function runBacktest({ from, to, lots = 10, rule: ruleIn = {}, onProgress } = {}) {
  const rule = { ...DEFAULT_RULE, ...ruleIn };
  const qty = Math.max(1, Math.round(lots)) * rule.lotSize;
  const fetchFrom = addDays(from, -WARMUP_DAYS);
  const live = await ensureDays(fetchFrom, to, { onProgress });
  const days = loadDays(fetchFrom, to, live);

  const trades = [];
  const skippedDays = [];
  const total = days.filter((d) => d.dateKey >= from).length;
  let done = 0;
  days.forEach((day, i) => {
    if (day.dateKey < from) return;
    onProgress?.({ phase: 'simulate', done, total, dateKey: day.dateKey });
    done += 1;
    const r = runDay({ day, prev: days[i - 1], rule, qty });
    if (r.trade) trades.push(r.trade);
    else skippedDays.push({ dateKey: day.dateKey, reason: r.skipped, walls: r.walls || [], spotAtCapture: r.spotAtCapture ?? null });
  });

  return {
    from,
    to,
    lots,
    qty,
    rule: { ...rule, unarmedExit: hhmm(rule.unarmedExit), entryTo: hhmm(rule.entryTo), eod: hhmm(rule.eod) },
    tradingDays: total,
    skippedDays,
    summary: summarize(trades),
    trades,
  };
}

module.exports = { runBacktest, DEFAULT_RULE, HISTORY_START };
