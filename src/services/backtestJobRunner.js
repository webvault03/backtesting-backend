const crypto = require('crypto');

/**
 * Background backtest jobs shared by the "run on Dhan history" strategies.
 * One run at a time across all of them — Dhan history calls are rate limited. Finished jobs kept 30 min.
 */
const jobs = new Map();
let activeJobId = null;
const JOB_TTL_MS = 30 * 60 * 1000;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

/**
 * `have` = trades the client already holds from earlier polls; a running job's partial result only
 * carries trades from that index on (`tradesOffset`), so long runs do not resend the whole list.
 */
function publicJob(job, have = 0) {
  let partial = null;
  if (job.status === 'running' && job.partial) {
    const all = job.partial.trades || [];
    const offset = Math.min(Math.max(0, have), all.length);
    partial = { ...job.partial, trades: all.slice(offset), tradesOffset: offset, tradesTotal: all.length };
  }
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    params: job.params,
    progress: job.progress,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    partial,
    result: job.status === 'done' ? job.result : null,
  };
}

/**
 * Starts `run(onProgress, onPartial)` in the background. `onPartial(result)` publishes results so far
 * (same shape as the final result). Returns `{ busy: true, job }` when another run is active.
 */
function startJob(kind, params, run) {
  pruneJobs();
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    return { busy: true, job: active ? publicJob(active) : null };
  }
  const job = {
    id: crypto.randomUUID(),
    kind,
    status: 'running',
    params,
    progress: { phase: 'start', done: 0, total: 0 },
    error: null,
    partial: null,
    result: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;

  Promise.resolve()
    .then(() => run((p) => { job.progress = p; }, (partial) => { job.partial = partial; }))
    .then((result) => {
      job.result = result;
      job.partial = null;
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

  return { busy: false, job: publicJob(job) };
}

function getJob(jobId, have = 0) {
  const job = jobs.get(jobId);
  return job ? publicJob(job, have) : null;
}

module.exports = { startJob, getJob };
