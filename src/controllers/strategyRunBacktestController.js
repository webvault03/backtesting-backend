const oiTrail = require('../services/oiTrailBacktest/engine');
const shortStraddle = require('../services/shortStraddleBacktest/engine');
const gappingPlay = require('../services/gappingPlayBacktest/engine');
const cvdOi = require('../services/cvdOiBacktest/engine');
const openOiWalls = require('../services/openOiWallsBacktest/engine');
const supertrend = require('../services/supertrendBacktest/engine');
const nisonVwap = require('../services/nisonVwapBacktest/engine');
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
        emergencySl: numberIn(body.emergencySl, 0, 500, d.emergencySl),
        unarmedExit: clockIn(body.unarmedExit, 9 * 60 + 20, 15 * 60 + 25, d.unarmedExit),
        entryTo: clockIn(body.entryTo, 9 * 60 + 16, 15 * 60, d.entryTo),
        slippage: numberIn(body.slippage, 0, 5, d.slippage),
        skipSameStrike: typeof body.skipSameStrike === 'boolean' ? body.skipSameStrike : d.skipSameStrike,
      },
    };
  },
  openOiWalls.runBacktest,
);

const TIMEFRAMES = [1, 3, 5, 10, 15, 30];
const parseTimeframe = (v, fallback) => (TIMEFRAMES.includes(Number(v)) ? Number(v) : fallback);
const parseCandleType = (v, fallback) => (v === 'heikin' || v === 'normal' ? v : fallback);

const supertrendHandlers = jobHandlers(
  'supertrend',
  (body) => {
    const d = supertrend.DEFAULT_RULE;
    const range = parseDateRange(body, { historyStart: '2020-01-01' });
    if (range.to < supertrend.HISTORY_START) throw new Error(`Option history starts ${supertrend.HISTORY_START}`);
    return {
      from: range.from < supertrend.HISTORY_START ? supertrend.HISTORY_START : range.from,
      to: range.to,
      lots: parseLots(body.lots),
      rule: {
        timeframe: parseTimeframe(body.timeframe, d.timeframe),
        candleType: parseCandleType(body.candleType, d.candleType),
        atrLength: Math.round(numberIn(body.atrLength, 2, 100, d.atrLength)),
        factor: numberIn(body.factor, 0.5, 10, d.factor),
        strikeSteps: Math.round(numberIn(body.strikeSteps, -3, 5, d.strikeSteps)),
        entryFrom: clockIn(body.entryFrom, 9 * 60 + 15, 15 * 60 + 25, d.entryFrom),
        entryTo: clockIn(body.entryTo, 9 * 60 + 15, 15 * 60 + 25, d.entryTo),
        eod: clockIn(body.eod, 9 * 60 + 30, 15 * 60 + 29, d.eod),
        overnight: flag(body.overnight, d.overnight),
        slippage: numberIn(body.slippage, 0, 5, d.slippage),
        adxMin: numberIn(body.adxMin, 0, 100, d.adxMin),
        adxLength: Math.round(numberIn(body.adxLength, 2, 100, d.adxLength)),
        avgFilter: flag(body.avgFilter, d.avgFilter),
        maxLossesPerDay: Math.round(numberIn(body.maxLossesPerDay, 0, 20, d.maxLossesPerDay)),
        slPct: numberIn(body.slPct, 0, 100, d.slPct),
      },
    };
  },
  supertrend.runBacktest,
);

const nisonVwapHandlers = jobHandlers(
  'nison-vwap',
  (body) => {
    const range = parseDateRange(body, { historyStart: '2020-01-01' });
    if (range.to < nisonVwap.HISTORY_START) throw new Error(`Option history starts ${nisonVwap.HISTORY_START}`);
    return {
      from: range.from < nisonVwap.HISTORY_START ? nisonVwap.HISTORY_START : range.from,
      to: range.to,
      rule: { slippage: numberIn(body.slippage, 0, 5, nisonVwap.DEFAULT_RULE.slippage) },
    };
  },
  nisonVwap.runBacktest,
);

/** GET /backtest/supertrend/chart?from&to&timeframe&atrLength&factor — NIFTY candles + line for a trade. */
async function getSupertrendChart(req, res) {
  try {
    const { from, to } = parseDateRange(req.query, { historyStart: supertrend.HISTORY_START });
    const span = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (span > 10) throw new Error('Chart range is limited to 10 days');
    const d = supertrend.DEFAULT_RULE;
    const candles = await supertrend.chartCandles({
      from,
      to,
      timeframe: parseTimeframe(req.query.timeframe, d.timeframe),
      candleType: parseCandleType(req.query.candleType, d.candleType),
      atrLength: Math.round(numberIn(req.query.atrLength, 2, 100, d.atrLength)),
      factor: numberIn(req.query.factor, 0.5, 10, d.factor),
    });
    return res.json({ ok: true, candles });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
}

module.exports = {
  postSupertrendBacktestRun: supertrendHandlers.run,
  getSupertrendBacktestJob: supertrendHandlers.status,
  getSupertrendChart,
  postNisonVwapBacktestRun: nisonVwapHandlers.run,
  getNisonVwapBacktestJob: nisonVwapHandlers.status,
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
