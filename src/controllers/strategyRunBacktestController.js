const oiTrail = require('../services/oiTrailBacktest/engine');
const shortStraddle = require('../services/shortStraddleBacktest/engine');
const gappingPlay = require('../services/gappingPlayBacktest/engine');
const cvdOi = require('../services/cvdOiBacktest/engine');
const openOiWalls = require('../services/openOiWallsBacktest/engine');
const haEma9 = require('../services/haEma9Backtest/engine');
const oiStrikeFlow = require('../services/oiStrikeFlowBacktest/engine');
const strategy1Pro = require('../services/strategy1ProBacktest/engine');
const niftyChampion = require('../services/niftyChampionBacktest/engine');
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

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;
const clockIn = (value, min, max, fallback) => {
  const m = CLOCK_RE.exec(String(value || '').trim());
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  return minutes >= min && minutes <= max ? minutes : fallback;
};

const openOiWallsHandlers = jobHandlers(
  'open-oi-walls',
  (body) => {
    const d = openOiWalls.DEFAULT_RULE;
    const range = parseDateRange(body, { historyStart: '2020-01-01' });
    if (range.to < openOiWalls.HISTORY_START) throw new Error(`Option history starts ${openOiWalls.HISTORY_START}`);
    return {
      from: range.from < openOiWalls.HISTORY_START ? openOiWalls.HISTORY_START : range.from,
      to: range.to,
      lots: parseLots(body.lots),
      rule: {
        lotSize: Math.round(numberIn(body.lotSize, 1, 500, d.lotSize)),
        charges: numberIn(body.charges, 0, 10000, d.charges),
        proximity: numberIn(body.proximity, 5, 200, d.proximity),
        targets: Array.isArray(body.targets)
          ? [...new Set(body.targets.map(Number).filter((n) => n >= 1 && n <= 1000))].sort((a, b) => a - b).slice(0, 10)
          : d.targets,
        entryTo: clockIn(body.entryTo, 9 * 60 + 16, 15 * 60, d.entryTo),
        slippage: numberIn(body.slippage, 0, 5, d.slippage),
      },
    };
  },
  openOiWalls.runBacktest,
);

const haEma9Handlers = jobHandlers(
  'ha-ema9',
  (body) => {
    const range = parseDateRange(body, { historyStart: '2020-01-01' });
    if (range.to < haEma9.HISTORY_START) throw new Error(`Option history starts ${haEma9.HISTORY_START}`);
    return {
      from: range.from < haEma9.HISTORY_START ? haEma9.HISTORY_START : range.from,
      to: range.to,
      lots: parseLots(body.lots),
      rule: {
        maxCandlePts: numberIn(body.maxCandlePts, 1, 200, haEma9.DEFAULT_RULE.maxCandlePts),
        rr: numberIn(body.rr, 0.25, 10, haEma9.DEFAULT_RULE.rr),
        slippage: numberIn(body.slippage, 0, 5, haEma9.DEFAULT_RULE.slippage),
      },
    };
  },
  haEma9.runBacktest,
);

const strategy1ProHandlers = jobHandlers(
  'strategy-1-pro',
  (body) => {
    const range = parseDateRange(body, { historyStart: strategy1Pro.HISTORY_START });
    const d = strategy1Pro.DEFAULT_RULE;
    const t1Pts = numberIn(body.t1Pts, 10, 100, d.t1Pts);
    return {
      from: range.from,
      to: range.to,
      lots: parseLots(body.lots),
      brokerage: numberIn(body.brokerage, 0, 1000, strategy1Pro.COSTS.brokeragePerOrder),
      rule: {
        maxTradesPerDay: Math.round(numberIn(body.maxTrades, 1, 5, d.maxTradesPerDay)),
        t1Pts,
        breakevenAt: Math.min(d.breakevenAt, t1Pts),
        targetPts: Math.max(t1Pts, numberIn(body.targetPts, 20, 300, d.targetPts)),
        slMax: Math.max(d.slMin, numberIn(body.slMax, 10, 60, d.slMax)),
      },
    };
  },
  strategy1Pro.runBacktest,
);

const niftyChampionHandlers = jobHandlers(
  'nifty-champion',
  (body) => {
    const range = parseDateRange(body, { historyStart: niftyChampion.HISTORY_START });
    const d = niftyChampion.DEFAULT_RULE;
    const t1Pts = numberIn(body.t1Pts, 5, 100, d.t1Pts);
    return {
      from: range.from,
      to: range.to,
      lots: parseLots(body.lots),
      brokerage: numberIn(body.brokerage, 0, 1000, niftyChampion.COSTS.brokeragePerOrder),
      rule: {
        pnlMode: body.pnlMode === 'spot' ? 'spot' : 'option',
        t1Pts,
        t2Pts: Math.max(t1Pts, numberIn(body.t2Pts, 5, 200, d.t2Pts)),
        slPts: numberIn(body.slPts, 2, 50, d.slPts),
        maxTradesPerDay: Math.round(numberIn(body.maxTrades, 1, 20, d.maxTradesPerDay)),
        dailyTarget: numberIn(body.dailyTarget, 0, 10000000, d.dailyTarget),
        dailyMaxLoss: numberIn(body.dailyMaxLoss, 0, 10000000, d.dailyMaxLoss),
        tax: numberIn(body.tax, 0, 10000, d.tax),
      },
    };
  },
  niftyChampion.runBacktest,
);

const oiStrikeFlowHandlers = jobHandlers(
  'oi-strike-flow',
  (body) => {
    const d = oiStrikeFlow.DEFAULT_RULE;
    const range = parseDateRange(body, { historyStart: '2020-01-01' });
    if (range.to < oiStrikeFlow.HISTORY_START) throw new Error(`Option history starts ${oiStrikeFlow.HISTORY_START}`);
    return {
      from: range.from < oiStrikeFlow.HISTORY_START ? oiStrikeFlow.HISTORY_START : range.from,
      to: range.to,
      lots: parseLots(body.lots),
      rule: {
        ratio: numberIn(body.ratio, 1, 10, d.ratio),
        maxTrades: Math.round(numberIn(body.maxTrades, 1, 5, d.maxTrades)),
        optSl: numberIn(body.optSl, 0, 200, d.optSl),
        unarmedMin: Math.round(numberIn(body.unarmedMin, 5, 330, d.unarmedMin)),
        lastSignal: clockIn(body.lastSignal, 9 * 60 + 45, 15 * 60, d.lastSignal),
        slippage: numberIn(body.slippage, 0, 5, d.slippage),
      },
    };
  },
  oiStrikeFlow.runBacktest,
);

module.exports = {
  postNiftyChampionBacktestRun: niftyChampionHandlers.run,
  getNiftyChampionBacktestJob: niftyChampionHandlers.status,
  postStrategy1ProBacktestRun: strategy1ProHandlers.run,
  getStrategy1ProBacktestJob: strategy1ProHandlers.status,
  postOiStrikeFlowBacktestRun: oiStrikeFlowHandlers.run,
  getOiStrikeFlowBacktestJob: oiStrikeFlowHandlers.status,
  postHaEma9BacktestRun: haEma9Handlers.run,
  getHaEma9BacktestJob: haEma9Handlers.status,
  postOpenOiWallsBacktestRun: openOiWallsHandlers.run,
  getOpenOiWallsBacktestJob: openOiWallsHandlers.status,
  postGappingPlayBacktestRun: gappingPlayHandlers.run,
  getGappingPlayBacktestJob: gappingPlayHandlers.status,
  postCvdOiBacktestRun: cvdOiHandlers.run,
  getCvdOiBacktestJob: cvdOiHandlers.status,
  postShortStraddleBacktestRun: shortStraddleHandlers.run,
  getShortStraddleBacktestJob: shortStraddleHandlers.status,
  postOiTrailBacktestRun: oiTrailHandlers.run,
  getOiTrailBacktestJob: oiTrailHandlers.status,
};
