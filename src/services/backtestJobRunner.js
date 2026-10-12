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

function publicJob(job) {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    params: job.params,
    progress: job.progress,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.status === 'done' ? job.result : null,
  };
}

/** Starts `run(onProgress)` in the background. Returns `{ busy: true, job }` when another run is active. */
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
    result: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  activeJobId = job.id;

  Promise.resolve()
    .then(() => run((p) => { job.progress = p; }))
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

  return { busy: false, job: publicJob(job) };
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  return job ? publicJob(job) : null;
}

module.exports = { startJob, getJob };
