const oiTrail = require('../services/oiTrailBacktest/engine');
const ema5 = require('../services/ema5BreakoutBacktest/engine');
const shortStraddle = require('../services/shortStraddleBacktest/engine');
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

module.exports = {
  postShortStraddleBacktestRun: shortStraddleHandlers.run,
  getShortStraddleBacktestJob: shortStraddleHandlers.status,
  postOiTrailBacktestRun: oiTrailHandlers.run,
  getOiTrailBacktestJob: oiTrailHandlers.status,
  postEma5BreakoutBacktestRun: ema5Handlers.run,
  getEma5BreakoutBacktestJob: ema5Handlers.status,
};
