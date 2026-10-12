const crypto = require('crypto');
const { runBacktest } = require('../services/oiCandleAgreeBacktest/engine');
const { getIstClock } = require('../utils/dateTime');

/** One run at a time — Dhan history calls are rate limited. Finished jobs kept for 30 min. */
const jobs = new Map();
let activeJobId = null;
const JOB_TTL_MS = 30 * 60 * 1000;

const SL_MODES = new Set(['candle', 'mid', 'fixed', 'none']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function parseRequest(body = {}) {
  const today = getIstClock(new Date()).dateKey;
  const from = String(body.from || '');
  let to = String(body.to || '');
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('from / to must be YYYY-MM-DD');
  if (to >= today) to = today;
  if (from > to) throw new Error('from must be on or before to');
  if (from < '2025-01-01') throw new Error('History starts 2025-01-01');

  const mode = String(body.slMode || 'candle');
  if (!SL_MODES.has(mode)) throw new Error(`slMode must be one of ${[...SL_MODES].join(', ')}`);
  const cap = Number(body.capPoints);
  const fixed = Number(body.fixedPoints);
  const lots = Math.min(50, Math.max(1, Math.round(Number(body.lots) || 10)));
  return {
    from,
    to,
    lots,
    tapeSource: body.tapeSource === 'dhan' ? 'dhan' : 'auto',
    rule: {
      mode,
      capPoints: Number.isFinite(cap) && cap > 0 ? cap : null,
      fixedPoints: Number.isFinite(fixed) && fixed > 0 ? fixed : 30,
    },
  };
}

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    params: job.params,
    progress: job.progress,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.status === 'done' ? job.result : null,
  };
}

async function postOiCandleAgreeBacktestRun(req, res) {
  pruneJobs();
  let params;
  try {
    params = parseRequest(req.body);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    return res.status(409).json({ ok: false, error: 'A backtest is already running', job: active ? publicJob(active) : null });
  }

  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    params,
    progress: { phase: 'start', done: 0, total: 0 },
    error: null,
    result: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;

  runBacktest({ ...params, onProgress: (p) => { job.progress = p; } })
    .then((result) => {
      job.result = result;
      job.status = 'done';
    })
    .catch((err) => {
      job.error = err.message;
      job.status = 'error';
    })
    .finally(() => {
      job.finishedAt = Date.now();
      activeJobId = null;
    });

  return res.status(202).json({ ok: true, job: publicJob(job) });
}

function getOiCandleAgreeBacktestJob(req, res) {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found or expired' });
  return res.json({ ok: true, job: publicJob(job) });
}

module.exports = {
  postOiCandleAgreeBacktestRun,
  getOiCandleAgreeBacktestJob,
};
