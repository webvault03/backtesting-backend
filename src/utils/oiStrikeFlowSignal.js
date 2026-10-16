/**
 * OI Strike Flow — signal from the live minute tape (same rules as the backtest idea).
 *
 * Strikes: ATM from NIFTY's 09:15 open ± 5 (11 strikes).
 * Flow from 09:20 in finished 5-minute blocks:
 *   OI ↑ price ↓ = writing · OI ↑ price ↑ = long · OI ↓ price ↑ = short covering · OI ↓ price ↓ = long unwinding.
 * CE: put writing ≥ ratio × call writing · spot > 09:19 close · heaviest put strike below spot · no heavy call near ATM.
 * PE: the mirror.
 */

const STEP = 50;
const SPAN = 5;
const OPEN = 9 * 60 + 15;
const FLOW_FROM = 9 * 60 + 20;
const FIRST_SIGNAL = 9 * 60 + 45;
const BLOCK = 5;
const NEAR = 1;
const HEAVY_SHARE = 0.6;

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function legFlow(series, upTo) {
  const flow = { long: 0, writing: 0, shortCovering: 0, longUnwinding: 0 };
  if (!series?.m?.length) return flow;
  let lastOi = null;
  let lastPx = null;
  let lastBlockEnd = FLOW_FROM;
  for (let i = 0; i < series.m.length; i += 1) {
    const m = series.m[i];
    if (m < FLOW_FROM) {
      if (Number.isFinite(series.oi[i]) && Number.isFinite(series.c[i])) {
        lastOi = series.oi[i];
        lastPx = series.c[i];
      }
      continue;
    }
    if (m >= upTo) break;
    const blockEnd = FLOW_FROM + Math.floor((m - FLOW_FROM) / BLOCK) * BLOCK + BLOCK;
    if (blockEnd > lastBlockEnd && Number.isFinite(series.oi[i]) && Number.isFinite(series.c[i])) {
      if (lastOi != null) {
        const dOi = series.oi[i] - lastOi;
        const dPx = series.c[i] - lastPx;
        if (dOi > 0 && dPx > 0) flow.long += dOi;
        else if (dOi > 0 && dPx < 0) flow.writing += dOi;
        else if (dOi < 0 && dPx > 0) flow.shortCovering -= dOi;
        else if (dOi < 0 && dPx < 0) flow.longUnwinding -= dOi;
      }
      lastOi = series.oi[i];
      lastPx = series.c[i];
      lastBlockEnd = blockEnd;
    }
  }
  return flow;
}

function niftyAt(day, minute) {
  const { m, c } = day.nifty || {};
  if (!m?.length) return null;
  let last = null;
  for (let i = 0; i < m.length; i += 1) {
    if (m[i] < minute) last = c[i];
    else break;
  }
  return Number.isFinite(last) ? last : null;
}

function niftyOpen915(day) {
  const { m, c } = day.nifty || {};
  // Prefer open from day.niftyOpen if present; else first bar at/after 09:15.
  if (Number.isFinite(day.niftyOpen)) return day.niftyOpen;
  if (!m?.length) return null;
  for (let i = 0; i < m.length; i += 1) {
    if (m[i] >= OPEN && Number.isFinite(c[i])) return c[i];
  }
  return Number.isFinite(c[0]) ? c[0] : null;
}

function base919(day) {
  return niftyAt(day, FLOW_FROM);
}

/**
 * @param {object} day — report-shaped day from oiStrikeLiveService (nifty + strikes with CE/PE series)
 * @param {number} nowMinutes — IST minutes; only finished block closes ≤ nowMinutes are considered
 * @param {{ ratio?: number, lastSignalMin?: number }} [opts]
 */
function findLatestStrikeFlowSignal(day, nowMinutes, opts = {}) {
  const ratio = Number(opts.ratio) > 0 ? Number(opts.ratio) : 1.5;
  const lastSignal = Number.isFinite(opts.lastSignalMin) ? opts.lastSignalMin : 13 * 60;
  if (!day?.strikes?.length) {
    return { ok: false, waiting: { message: 'Waiting for 09:15 tape…' } };
  }
  const open = niftyOpen915(day);
  const base = base919(day);
  if (!Number.isFinite(open) || !Number.isFinite(base)) {
    return { ok: false, waiting: { message: 'Need NIFTY 09:15 open and 09:19 close' } };
  }
  const atm = Math.round(open / STEP) * STEP;
  const byStrike = new Map(day.strikes.map((s) => [s.strike, s]));

  let latest = null;
  let waiting = null;
  for (let t = FIRST_SIGNAL; t <= lastSignal && t <= nowMinutes; t += BLOCK) {
    const spot = niftyAt(day, t);
    if (!Number.isFinite(spot)) continue;
    const rows = [];
    for (let off = -SPAN; off <= SPAN; off += 1) {
      const strike = atm + off * STEP;
      const s = byStrike.get(strike);
      rows.push({
        strike,
        CE: s?.CE ? legFlow(s.CE, t) : { writing: 0 },
        PE: s?.PE ? legFlow(s.PE, t) : { writing: 0 },
      });
    }
    const ceW = rows.reduce((n, r) => n + (r.CE.writing || 0), 0);
    const peW = rows.reduce((n, r) => n + (r.PE.writing || 0), 0);
    const topOf = (side) => rows.reduce((best, r) => ((r[side]?.writing || 0) > (best?.[side]?.writing || 0) ? r : best), null);
    const ceTop = topOf('CE');
    const peTop = topOf('PE');
    const atmNow = Math.round(spot / STEP) * STEP;
    const nearHeavy = (side) => {
      const top = (side === 'CE' ? ceTop : peTop)?.[side]?.writing || 0;
      if (!top) return null;
      const hit = rows.find(
        (r) => Math.abs(r.strike - atmNow) <= NEAR * STEP && (r[side]?.writing || 0) >= top * HEAVY_SHARE,
      );
      return hit?.strike ?? null;
    };

    const view = {
      t,
      time: hhmm(t),
      spot: r2(spot),
      baseSpot: r2(base),
      ceWriting: ceW,
      peWriting: peW,
      ceTop: ceTop?.strike ?? null,
      peTop: peTop?.strike ?? null,
      atmFixed: atm,
      open915: r2(open),
      rows,
    };

    if (peW > 0 && peW >= ratio * ceW) {
      if (!(spot > base)) {
        waiting = { ...view, why: `Put writing heavy but NIFTY not above 09:19 (${r2(base)})` };
        continue;
      }
      if (!(peTop.strike < spot)) {
        waiting = { ...view, why: `Heaviest put writing ${peTop.strike} not below NIFTY` };
        continue;
      }
      const against = nearHeavy('CE');
      if (against != null) {
        waiting = { ...view, why: `Heavy call writing near ATM at ${against}` };
        continue;
      }
      latest = { ...view, side: 'CE', optionType: 'CE', level: peTop.strike, why: null };
      continue;
    }
    if (ceW > 0 && ceW >= ratio * peW) {
      if (!(spot < base)) {
        waiting = { ...view, why: `Call writing heavy but NIFTY not below 09:19 (${r2(base)})` };
        continue;
      }
      if (!(ceTop.strike > spot)) {
        waiting = { ...view, why: `Heaviest call writing ${ceTop.strike} not above NIFTY` };
        continue;
      }
      const against = nearHeavy('PE');
      if (against != null) {
        waiting = { ...view, why: `Heavy put writing near ATM at ${against}` };
        continue;
      }
      latest = { ...view, side: 'PE', optionType: 'PE', level: ceTop.strike, why: null };
      continue;
    }
    waiting = { ...view, why: 'Writing balanced' };
  }

  if (!latest) {
    return {
      ok: false,
      waiting: waiting
        ? {
            message: waiting.why || 'Waiting for writing imbalance…',
            time: waiting.time,
            ceWriting: waiting.ceWriting,
            peWriting: waiting.peWriting,
            spot: waiting.spot,
            baseSpot: waiting.baseSpot,
          }
        : { message: nowMinutes < FIRST_SIGNAL ? 'First check at 09:45' : 'No signal yet' },
    };
  }

  const writingRatio = latest.side === 'CE'
    ? (latest.ceWriting > 0 ? latest.peWriting / latest.ceWriting : Infinity)
    : (latest.peWriting > 0 ? latest.ceWriting / latest.peWriting : Infinity);

  return {
    ok: true,
    optionType: latest.optionType,
    optionBuy: latest.optionType,
    side: latest.side,
    level: latest.level,
    barEndMin: latest.t,
    time: latest.time,
    spot: latest.spot,
    baseSpot: latest.baseSpot,
    ceWriting: latest.ceWriting,
    peWriting: latest.peWriting,
    writingRatio: Number.isFinite(writingRatio) ? r2(writingRatio) : null,
    atmFixed: latest.atmFixed,
    open915: latest.open915,
    reason: latest.side === 'CE'
      ? `Put writing ${r2(writingRatio)}× · support ${latest.level}`
      : `Call writing ${r2(writingRatio)}× · resistance ${latest.level}`,
    flow: latest,
  };
}

module.exports = {
  findLatestStrikeFlowSignal,
  STEP,
  SPAN,
  OPEN,
  FLOW_FROM,
  FIRST_SIGNAL,
  BLOCK,
};
