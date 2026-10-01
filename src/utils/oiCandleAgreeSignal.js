/**
 * Live/backtest helper: closed 15m OI+candle AGREE signals.
 * REAL only: Writing|Buying + bearish candle → PE
 *            Short cover|Writing + bullish candle → CE
 */
const { build5mBars } = require('./oiFlow5mPatterns');

const SESSION_FROM = 9 * 60 + 15;
const STEP = 15;

function pairOf(r) {
  return `${r.callAct || '—'}|${r.putAct || '—'}`;
}

function buildAgreeBars(minuteRows) {
  const rows = (minuteRows || [])
    .map((r) => ({
      minutes: Number(r.minutes),
      time: r.time,
      spot: Number(r.spotPrice ?? r.spot ?? r.futPrice),
      callAct: r.callAct || null,
      putAct: r.putAct || null,
      callsChgOi: r.callsChgOi,
      putsChgOi: r.putsChgOi,
    }))
    .filter((r) => Number.isFinite(r.minutes) && Number.isFinite(r.spot))
    .sort((a, b) => a.minutes - b.minutes);

  const byBucket = new Map();
  for (const r of rows) {
    if (r.minutes < SESSION_FROM) continue;
    const bucket = SESSION_FROM + Math.floor((r.minutes - SESSION_FROM) / STEP) * STEP;
    if (!byBucket.has(bucket)) {
      byBucket.set(bucket, { startMin: bucket, spots: [], rows: [] });
    }
    const b = byBucket.get(bucket);
    b.spots.push(r.spot);
    b.rows.push(r);
  }

  const bars = [];
  for (const [, b] of [...byBucket.entries()].sort((a, c) => a[0] - c[0])) {
    if (b.spots.length < 2) continue;
    const open = b.spots[0];
    const close = b.spots[b.spots.length - 1];
    const high = Math.max(...b.spots);
    const low = Math.min(...b.spots);
    const range = high - low;
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const bodyPct = range > 0 ? (body / range) * 100 : 0;
    const upperPct = range > 0 ? (upperWick / range) * 100 : 0;
    const lowerPct = range > 0 ? (lowerWick / range) * 100 : 0;
    const dir = close > open + 0.5 ? 'UP' : close < open - 0.5 ? 'DOWN' : 'DOJI';

    const counts = {};
    for (const r of b.rows) {
      if (!r.callAct || !r.putAct || r.callAct === '—' || r.putAct === '—') continue;
      const k = pairOf(r);
      counts[k] = (counts[k] || 0) + 1;
    }
    let dominantPair = Object.entries(counts).sort((a, c) => c[1] - a[1])[0]?.[0] || null;

    let shape = 'body';
    if (range < 3) shape = 'tiny';
    else if (dir === 'DOJI' && range >= 5) shape = 'doji';
    else if (upperPct >= 55 && bodyPct <= 35) shape = 'upper_wick_trap';
    else if (lowerPct >= 55 && bodyPct <= 35) shape = 'lower_wick_trap';
    else if (bodyPct >= 60 && dir === 'UP') shape = 'bull_body';
    else if (bodyPct >= 60 && dir === 'DOWN') shape = 'bear_body';

    const last = b.rows[b.rows.length - 1];
    bars.push({
      startMin: b.startMin,
      endMin: b.startMin + STEP - 1,
      time: last.time,
      open,
      high,
      low,
      close,
      range,
      dir,
      shape,
      dominantPair: dominantPair || '—|—',
      entrySpot: close,
      entryMinutes: last.minutes,
    });
  }
  return bars;
}

function matchRealAgree(bar) {
  if (!bar || !bar.dominantPair) return null;
  const pair = bar.dominantPair;
  const { shape, dir } = bar;
  const bearCandle =
    shape === 'bear_body' || shape === 'upper_wick_trap' || dir === 'DOWN';
  const bullCandle =
    shape === 'bull_body' || shape === 'lower_wick_trap' || dir === 'UP';

  if (pair === 'Writing|Buying' && bearCandle) {
    return {
      kind: 'REAL',
      optionType: 'PE',
      optionBuy: 'PE BUY',
      reason: `AGREE down · ${shape} + Writing|Buying`,
      shape,
      pair,
      dir,
    };
  }
  if (pair === 'Short cover|Writing' && bullCandle) {
    return {
      kind: 'REAL',
      optionType: 'CE',
      optionBuy: 'CE BUY',
      reason: `AGREE up · ${shape} + Short cover|Writing`,
      shape,
      pair,
      dir,
    };
  }
  return null;
}

/**
 * Enrich bars with acts from build5mBars when minute rows lack callAct/putAct (live tape).
 */
function mergeActsFromFlowBars(ohlcBars, minuteRows) {
  const flowBars = build5mBars(minuteRows, STEP);
  const byMin = new Map(flowBars.map((b) => [Number(b.minutes), b]));
  return ohlcBars.map((bar) => {
    if (bar.dominantPair && bar.dominantPair !== '—|—') return bar;
    // Flow bars are keyed by interval close (09:30 = 09:15→09:30); OHLC bar 09:15–09:29 closes at endMin + 1.
    const fb = byMin.get(bar.endMin + 1);
    if (!fb?.callAct || !fb?.putAct) return bar;
    return {
      ...bar,
      dominantPair: `${fb.callAct}|${fb.putAct}`,
      flowStrength: fb.strength?.label || null,
      flowAct: fb.act || null,
    };
  });
}

/**
 * Latest fully closed 15m bar (endMin < nowMinutes) with AGREE signal.
 * Live-safe: only the most recent closed bar can fire (no stale morning signal at 13:00).
 */
function findLatestAgreeSignal(minuteRows, nowMinutes) {
  let bars = buildAgreeBars(minuteRows);
  bars = mergeActsFromFlowBars(bars, minuteRows);
  const closed = bars.filter((b) => Number.isFinite(nowMinutes) && b.endMin < nowMinutes);
  const lastClosed = closed[closed.length - 1] || null;
  if (!lastClosed) {
    return {
      ok: false,
      signal: null,
      bar: null,
      barsCount: bars.length,
      closedCount: 0,
      waiting: null,
    };
  }
  const sig = matchRealAgree(lastClosed);
  if (sig) {
    return {
      ok: true,
      ...sig,
      bar: lastClosed,
      barsCount: bars.length,
      closedCount: closed.length,
    };
  }
  return {
    ok: false,
    signal: null,
    bar: lastClosed,
    barsCount: bars.length,
    closedCount: closed.length,
    waiting: {
      shape: lastClosed.shape,
      pair: lastClosed.dominantPair,
      dir: lastClosed.dir,
      time: lastClosed.time,
    },
  };
}

function niftyAtmStrike(spot, step = 50) {
  const s = Number(spot);
  if (!Number.isFinite(s) || s <= 0) return null;
  return Math.round(s / step) * step;
}

module.exports = {
  SESSION_FROM,
  STEP,
  buildAgreeBars,
  matchRealAgree,
  findLatestAgreeSignal,
  niftyAtmStrike,
};
