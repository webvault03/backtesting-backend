const { startJob, getJob, cancelJob } = require('../services/backtestJobRunner');
const { getIstClock } = require('../utils/dateTime');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HISTORY_START = '2025-01-01';

/** `from` / `to` (YYYY-MM-DD) from a run request; `to` is capped at today. */
function parseDateRange(body = {}, { historyStart = HISTORY_START } = {}) {
  const today = getIstClock(new Date()).dateKey;
  const from = String(body.from || '');
  let to = String(body.to || '');
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('from / to must be YYYY-MM-DD');
  if (to >= today) to = today;
  if (from > to) throw new Error('from must be on or before to');
  if (from < historyStart) throw new Error(`History starts ${historyStart}`);
  return { from, to };
}

/** Number in [min, max], else `fallback`. */
function numberIn(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

const parseLots = (value) => Math.min(50, Math.max(1, Math.round(Number(value) || 10)));

/** Express handlers for POST /run and GET /jobs/:jobId of one strategy. */
function jobHandlers(kind, parseRequest, runBacktest) {
  const run = (req, res) => {
    let params;
    try {
      params = parseRequest(req.body || {});
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    const { busy, job } = startJob(kind, params, (onProgress, onPartial) => runBacktest({ ...params, onProgress, onPartial }), {
      replace: req.body?.replace === true,
    });
    if (busy) return res.status(409).json({ ok: false, error: 'A backtest is already running', job });
    return res.status(202).json({ ok: true, job });
  };
  const status = (req, res) => {
    const job = getJob(req.params.jobId, Number(req.query.have) || 0);
    if (!job) {
      return res.status(404).json({
        ok: false,
        error:
          'Job not found or expired — backend likely restarted while the backtest was still running (jobs are in memory). Keep the server up for long monthly/yearly runs, then press Run again.',
      });
    }
    return res.json({ ok: true, job });
  };
  return { run, status };
}

/** POST /backtest/jobs/:jobId/cancel — works for any strategy's job. */
function cancelBacktestJob(req, res) {
  const job = cancelJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      ok: false,
      error: 'Job not found or expired — nothing to cancel (already finished or backend restarted).',
    });
  }
  return res.json({ ok: true, job });
}

module.exports = { parseDateRange, numberIn, parseLots, jobHandlers, cancelBacktestJob };
