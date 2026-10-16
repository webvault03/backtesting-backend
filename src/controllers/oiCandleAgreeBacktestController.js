const oiCandleAgree = require('../services/oiCandleAgreeBacktest/engine');
const { parseDateRange, numberIn, parseLots, jobHandlers } = require('./backtestRequest');

const SL_MODES = ['candle', 'mid', 'fixed', 'none'];

const handlers = jobHandlers(
  'oi-candle-agree',
  (body) => {
    const range = parseDateRange(body, { historyStart: oiCandleAgree.HISTORY_START });
    const mode = String(body.slMode || 'candle');
    if (!SL_MODES.includes(mode)) throw new Error(`slMode must be one of ${SL_MODES.join(', ')}`);
    return {
      from: range.from,
      to: range.to,
      lots: parseLots(body.lots),
      tapeSource: body.tapeSource === 'auto' ? 'auto' : 'dhan',
      rule: {
        mode,
        capPoints: numberIn(body.capPoints, 1, 500, null),
        fixedPoints: numberIn(body.fixedPoints, 1, 500, 30),
        maxTrades: Math.round(numberIn(body.maxTrades, 1, 10, 3)),
      },
    };
  },
  oiCandleAgree.runBacktest,
);

module.exports = {
  postOiCandleAgreeBacktestRun: handlers.run,
  getOiCandleAgreeBacktestJob: handlers.status,
};
