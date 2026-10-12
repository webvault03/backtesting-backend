const { runBacktest, DEFAULT_RULE, DAY_MODES } = require('../services/expiryStraddleBacktest/engine');
const { parseDateRange, numberIn, parseLots, jobHandlers } = require('./backtestRequest');

const TIME_RE = /^(\d{2}):(\d{2})$/;

function parseTime(value, fallback, label) {
  if (value == null || value === '') return fallback;
  const m = TIME_RE.exec(String(value));
  if (!m) throw new Error(`${label} must be HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseRequest(body) {
  const entryMin = parseTime(body.entryTime, DEFAULT_RULE.entryMin, 'entryTime');
  const exitMin = parseTime(body.exitTime, DEFAULT_RULE.exitMin, 'exitTime');
  if (entryMin < 9 * 60 + 16 || entryMin > 15 * 60) throw new Error('entryTime must be between 09:16 and 15:00');
  if (exitMin <= entryMin || exitMin > 15 * 60 + 25) throw new Error('exitTime must be after entryTime and by 15:25');
  return {
    ...parseDateRange(body),
    lots: parseLots(body.lots),
    rule: {
      entryMin,
      exitMin,
      legSlPct: numberIn(body.legSlPct, 5, 300, DEFAULT_RULE.legSlPct),
      days: DAY_MODES.includes(body.days) ? body.days : DEFAULT_RULE.days,
      slippage: numberIn(body.slippage, 0, 5, DEFAULT_RULE.slippage),
    },
  };
}

const { run, status } = jobHandlers('expiry-straddle', parseRequest, runBacktest);

module.exports = {
  postExpiryStraddleBacktestRun: run,
  getExpiryStraddleBacktestJob: status,
};
