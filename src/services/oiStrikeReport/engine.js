/**
 * OI Strike Report — per trading day, the 11 NIFTY strikes around the 09:15 open (ATM ± 5 strikes,
 * nearest weekly) with their 1-minute OI and option price, plus the previous day's closing OI.
 *
 * Strikes: ATM = 09:15 NIFTY open rounded to 50; the 11 strikes are fixed for the day.
 * The browser turns the minutes into the report for any time window of the day (long buildup, writing,
 * short covering, long unwinding), so changing the window needs no new run.
 */
const { addDays, ensureDays, loadDays } = require('../openOiWallsBacktest/dataSource');
const { pickBaseline, HISTORY_START } = require('../openOiWallsBacktest/engine');
const { rangeChunks, chunkProgress } = require('../backtestChunks');

const STEP = 50;
const SPAN = 5;
const OPEN_MIN = 9 * 60 + 15;
const WARMUP_DAYS = 7;
/** Every day carries ~22 × 375 minutes; keeps one response a few MB. */
const MAX_RANGE_DAYS = 62;

const r2 = (n) => Number(Number(n).toFixed(2));

/** Minutes with both OI and close; `open` = first 09:15-onward option open. */
function legSeries(series, prevOi) {
  if (!series?.m?.length) return null;
  const out = { prevOi: Number.isFinite(prevOi) ? prevOi : null, open: null, m: [], c: [], oi: [] };
  series.m.forEach((m, i) => {
    if (out.open == null && Number.isFinite(series.o[i])) out.open = series.o[i];
    if (!Number.isFinite(series.oi[i]) || !Number.isFinite(series.c[i])) return;
    out.m.push(m);
    out.c.push(series.c[i]);
    out.oi.push(series.oi[i]);
  });
  return out.m.length && out.open != null ? out : null;
}

function runDay(day, prev) {
  const i = day.nifty.m.indexOf(OPEN_MIN);
  if (i < 0) return { skipped: 'no NIFTY 09:15 bar' };
  const open = day.nifty.o[i];
  const atm = Math.round(open / STEP) * STEP;
  const { base, source } = pickBaseline(day, prev);
  const strikes = [];
  for (let off = -SPAN; off <= SPAN; off += 1) {
    const strike = atm + off * STEP;
    const k = String(strike);
    strikes.push({
      strike,
      offset: off,
      CE: legSeries(day.CE?.[k], base?.CE?.[k]),
      PE: legSeries(day.PE?.[k], base?.PE?.[k]),
    });
  }
  if (strikes.every((s) => !s.CE && !s.PE)) return { skipped: 'no option OI for the 11 strikes' };
  return {
    id: day.dateKey,
    date: day.dateKey,
    niftyOpen: r2(open),
    nifty: { m: day.nifty.m, c: day.nifty.c },
    atm,
    baseline: source,
    strikes,
  };
}

/** @param {{ from: string, to: string, onProgress?: Function, onPartial?: Function }} opts */
async function runReport({ from, to, onProgress, onPartial } = {}) {
  const days = [];
  const skippedDays = [];
  const build = (doneThrough) => ({
    from,
    to,
    span: SPAN,
    step: STEP,
    skippedDays: [...skippedDays],
    trades: [...days],
    ...(doneThrough ? { doneThrough } : {}),
  });

  const chunks = rangeChunks(from, to, { warmupDays: WARMUP_DAYS });
  for (const [ci, chunk] of chunks.entries()) {
    const report = chunkProgress(onProgress, ci, chunks.length, chunk.label, () => ({ tradesSoFar: days.length }));
    const fetchFrom = addDays(chunk.from, -WARMUP_DAYS);
    const live = await ensureDays(fetchFrom, chunk.to, { onProgress: report });
    const loaded = loadDays(fetchFrom, chunk.to, live);
    const total = loaded.filter((d) => d.dateKey >= chunk.from).length;
    let done = 0;
    loaded.forEach((day, i) => {
      if (day.dateKey < chunk.from) return;
      report({ phase: 'simulate', done, total, dateKey: day.dateKey });
      done += 1;
      const r = runDay(day, loaded[i - 1]);
      if (r.skipped) skippedDays.push({ dateKey: day.dateKey, reason: r.skipped });
      else days.push(r);
    });
    onPartial?.(build(chunk.to));
  }
  return build(null);
}

module.exports = { runReport, HISTORY_START, MAX_RANGE_DAYS };
