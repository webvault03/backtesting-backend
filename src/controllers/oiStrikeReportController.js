const oiStrikeReport = require('../services/oiStrikeReport/engine');
const { parseDateRange, jobHandlers } = require('./backtestRequest');

const handlers = jobHandlers(
  'oi-strikes',
  (body) => {
    const range = parseDateRange(body, { historyStart: '2020-01-01' });
    const start = oiStrikeReport.HISTORY_START;
    if (range.to < start) throw new Error(`Option history starts ${start}`);
    const from = range.from < start ? start : range.from;
    const spanDays = (Date.parse(range.to) - Date.parse(from)) / 86400000 + 1;
    if (spanDays > oiStrikeReport.MAX_RANGE_DAYS) throw new Error(`Pick at most ${oiStrikeReport.MAX_RANGE_DAYS} days at a time`);
    return { from, to: range.to };
  },
  oiStrikeReport.runReport,
);

module.exports = {
  postOiStrikeReportRun: handlers.run,
  getOiStrikeReportJob: handlers.status,
};
