const oiTrail = require('../services/oiTrailBacktest/engine');
const ema5 = require('../services/ema5BreakoutBacktest/engine');
const shortStraddle = require('../services/shortStraddleBacktest/engine');
const gappingPlay = require('../services/gappingPlayBacktest/engine');
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

const GAP_SIDES = new Set(['both', 'up', 'down']);

const gappingPlayHandlers = jobHandlers(
  'gapping-play',
  (body) => {
    const d = gappingPlay.DEFAULT_RULE;
    const restMin = Math.round(numberIn(body.restMin, 1, 20, d.restMin));
    return {
      ...parseDateRange(body, { historyStart: '2021-01-01' }),
      lots: Math.min(50, Math.max(1, Math.round(Number(body.lots) || 1))),
      rule: {
        lotSize: Math.round(numberIn(body.lotSize, 1, 500, d.lotSize)),
        charges: numberIn(body.charges, 0, 10000, d.charges),
        impulseMinPct: numberIn(body.impulseMinPct, 0.2, 20, d.impulseMinPct),
        restMin,
        restMax: Math.max(restMin, Math.round(numberIn(body.restMax, 1, 20, d.restMax))),
        maxRangePct: numberIn(body.maxRangePct, 0.1, 20, d.maxRangePct),
        sides: GAP_SIDES.has(body.sides) ? body.sides : d.sides,
        minPremium: numberIn(body.minPremium, 0, 500, d.minPremium),
        slippage: numberIn(body.slippage, 0, 5, d.slippage),
      },
    };
  },
  gappingPlay.runBacktest,
);

module.exports = {
  postGappingPlayBacktestRun: gappingPlayHandlers.run,
  getGappingPlayBacktestJob: gappingPlayHandlers.status,
  postCvdOiBacktestRun: cvdOiHandlers.run,
  getCvdOiBacktestJob: cvdOiHandlers.status,
  postShortStraddleBacktestRun: shortStraddleHandlers.run,
  getShortStraddleBacktestJob: shortStraddleHandlers.status,
  postOiTrailBacktestRun: oiTrailHandlers.run,
  getOiTrailBacktestJob: oiTrailHandlers.status,
  postEma5BreakoutBacktestRun: ema5Handlers.run,
  getEma5BreakoutBacktestJob: ema5Handlers.status,
};
