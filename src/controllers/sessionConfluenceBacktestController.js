const sessionConfluence = require('../services/sessionConfluenceBacktest/engine');
const { parseDateRange, numberIn, parseLots, jobHandlers } = require('./backtestRequest');

const SL_MODES = ['candle', 'mid', 'fixed', 'none'];

const handlers = jobHandlers(
  'session-confluence',
  (body) => {
    const range = parseDateRange(body, { historyStart: sessionConfluence.HISTORY_START });
    const mode = String(body.slMode || 'candle');
    if (!SL_MODES.includes(mode)) throw new Error(`slMode must be one of ${SL_MODES.join(', ')}`);
    return {
      from: range.from,
      to: range.to,
      lots: parseLots(body.lots),
      rule: {
        mode,
        capPoints: numberIn(body.capPoints, 1, 500, 40),
        fixedPoints: numberIn(body.fixedPoints, 1, 500, 30),
        maxTrades: Math.round(numberIn(body.maxTrades, 1, 5, 2)),
        unarmedMin: Math.round(numberIn(body.unarmedMin, 0, 180, 60)),
        dayStopPts: numberIn(body.dayStopPts, 0, 200, 25),
        dayTargetPts: numberIn(body.dayTargetPts, 0, 200, 30),
      },
    };
  },
  sessionConfluence.runBacktest,
);

module.exports = {
  postSessionConfluenceBacktestRun: handlers.run,
  getSessionConfluenceBacktestJob: handlers.status,
};
