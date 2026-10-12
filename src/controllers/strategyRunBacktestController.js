const oiTrail = require('../services/oiTrailBacktest/engine');
const ema5 = require('../services/ema5BreakoutBacktest/engine');
const shortStraddle = require('../services/shortStraddleBacktest/engine');
const starReversal = require('../services/starReversalBacktest/engine');
const cvdOi = require('../services/cvdOiBacktest/engine');
const { parseDateRange, numberIn, parseLots, jobHandlers } = require('./backtestRequest');

const oiTrailHandlers = jobHandlers(
  'oi-trail',
  (body) => ({
    ...parseDateRange(body),
    lots: parseLots(body.lots),
    rule: {
      minPremium: numberIn(body.minPremium, 0, 500, oiTrail.DEFAULT_RULE.minPremium),
      slippage: numberIn(body.slippage, 0, 5, oiTrail.DEFAULT_RULE.slippage),
    },
  }),
  oiTrail.runBacktest,
);

const ema5Handlers = jobHandlers(
  'ema5-breakout',
  (body) => {
    const d = ema5.DEFAULT_RULE;
    const dayStop = numberIn(body.dayStop, 0, 1e7, d.dayStop);
    return {
      ...parseDateRange(body),
      lots: parseLots(body.lots),
      rule: {
        slPoints: numberIn(body.slPoints, 1, 500, d.slPoints),
        trailAfter: numberIn(body.trailAfter, 0, 500, d.trailAfter),
        trailGap: numberIn(body.trailGap, 0.5, 500, d.trailGap),
        dayStop: dayStop > 0 ? dayStop : Infinity,
        slippage: numberIn(body.slippage, 0, 5, d.slippage),
      },
    };
  },
  ema5.runBacktest,
);

const shortStraddleHandlers = jobHandlers(
  'short-straddle-next-day',
  (body) => {
    const d = shortStraddle.DEFAULT_RULE;
    return {
      ...parseDateRange(body, { historyStart: '2021-01-01' }),
      lots: Math.min(50, Math.max(1, Math.round(Number(body.lots) || 1))),
      rule: {
        lotSize: Math.round(numberIn(body.lotSize, 1, 500, d.lotSize)),
        charges: numberIn(body.charges, 0, 10000, d.charges),
      },
    };
  },
  shortStraddle.runBacktest,
);

const SETUPS = new Set(['both', 'breakout', 'reversal']);
const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

const cvdOiHandlers = jobHandlers(
  'cvd-oi',
  (body) => {
    const d = cvdOi.DEFAULT_RULE;
    const minRisk = numberIn(body.minRisk, 1, 200, d.minRisk);
    return {
      ...parseDateRange(body, { historyStart: '2021-01-01' }),
      lots: parseLots(body.lots),
      rule: {
        setups: SETUPS.has(body.setups) ? body.setups : d.setups,
        lookbackBars: Math.round(numberIn(body.lookbackBars, 1, 12, d.lookbackBars)),
        rr: numberIn(body.rr, 0.5, 10, d.rr),
        minRisk,
        maxRisk: Math.max(minRisk, numberIn(body.maxRisk, 1, 300, d.maxRisk)),
        beAtR: numberIn(body.beAtR, 0, 10, d.beAtR),
        maxTrades: Math.round(numberIn(body.maxTrades, 1, 10, d.maxTrades)),
        stopAfterWin: flag(body.stopAfterWin, d.stopAfterWin),
        requireCvd: flag(body.requireCvd, d.requireCvd),
        requireOi: flag(body.requireOi, d.requireOi),
        lastEntry: d.lastEntry,
        slippage: numberIn(body.slippage, 0, 10, d.slippage),
        charges: numberIn(body.charges, 0, 10000, d.charges),
      },
    };
  },
  cvdOi.runBacktest,
);

const HHMM_RE = /^(\d{2}):(\d{2})$/;

const starReversalHandlers = jobHandlers(
  'star-reversal',
  (body) => {
    const d = starReversal.DEFAULT_RULE;
    const t = HHMM_RE.exec(String(body.lastEntry || ''));
    const lastEntryMin = t ? Number(t[1]) * 60 + Number(t[2]) : d.lastEntryMin;
    return {
      ...parseDateRange(body, { historyStart: '2021-01-01' }),
      lots: Math.min(50, Math.max(1, Math.round(Number(body.lots) || 1))),
      rule: {
        lotSize: Math.round(numberIn(body.lotSize, 1, 500, d.lotSize)),
        charges: numberIn(body.charges, 0, 10000, d.charges),
        tallFactor: numberIn(body.tallFactor, 0.5, 10, d.tallFactor),
        starMaxPct: numberIn(body.starMaxPct, 1, 100, d.starMaxPct),
        penetrationPct: numberIn(body.penetrationPct, 0, 100, d.penetrationPct),
        lastEntryMin: lastEntryMin >= 9 * 60 + 30 && lastEntryMin <= 15 * 60 + 20 ? lastEntryMin : d.lastEntryMin,
        maxTradesPerDay: Math.round(numberIn(body.maxTradesPerDay, 1, 20, d.maxTradesPerDay)),
        minPremium: numberIn(body.minPremium, 0, 500, d.minPremium),
        slippage: numberIn(body.slippage, 0, 5, d.slippage),
      },
    };
  },
  starReversal.runBacktest,
);

module.exports = {
  postStarReversalBacktestRun: starReversalHandlers.run,
  getStarReversalBacktestJob: starReversalHandlers.status,
  postCvdOiBacktestRun: cvdOiHandlers.run,
  getCvdOiBacktestJob: cvdOiHandlers.status,
  postShortStraddleBacktestRun: shortStraddleHandlers.run,
  getShortStraddleBacktestJob: shortStraddleHandlers.status,
  postOiTrailBacktestRun: oiTrailHandlers.run,
  getOiTrailBacktestJob: oiTrailHandlers.status,
  postEma5BreakoutBacktestRun: ema5Handlers.run,
  getEma5BreakoutBacktestJob: ema5Handlers.status,
};
