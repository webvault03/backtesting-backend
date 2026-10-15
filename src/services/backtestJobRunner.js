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
 * Stops a running job. The engine notices on its next progress / partial callback (which then throws),
 * so a Dhan call already in flight may still finish, but the slot is free for a new run right away.
 */
function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status === 'running') {
    job.cancelled = true;
    job.status = 'cancelled';
    job.partial = null;
    job.finishedAt = Date.now();
    if (activeJobId === job.id) activeJobId = null;
  }
  return publicJob(job);
}

/**
 * Starts `run(onProgress, onPartial)` in the background. `onPartial(result)` publishes results so far
 * (same shape as the final result). Returns `{ busy: true, job }` when another run is active, unless
 * `replace` is set and the active run is the same `kind` — then that run is cancelled first.
 */
function startJob(kind, params, run, { replace = false } = {}) {
  pruneJobs();
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (!(replace && active?.kind === kind)) return { busy: true, job: active ? publicJob(active) : null };
    cancelJob(active.id);
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

  const guard = (fn) => (value) => {
    if (job.cancelled) throw new Error('Backtest cancelled');
    fn(value);
  };

  Promise.resolve()
    .then(() => run(guard((p) => { job.progress = p; }), guard((partial) => { job.partial = partial; })))
    .then((result) => {
      if (job.cancelled) return;
      job.result = result;
      job.partial = null;
      job.status = 'done';
    })
    .catch((err) => {
      if (job.cancelled) return;
      job.error = err.message;
      job.status = 'error';
    })
    .finally(() => {
      if (!job.finishedAt) job.finishedAt = Date.now();
      if (activeJobId === job.id) activeJobId = null;
    });

  return { busy: false, job: publicJob(job) };
}

function getJob(jobId, have = 0) {
  const job = jobs.get(jobId);
  return job ? publicJob(job, have) : null;
}

module.exports = { startJob, getJob, cancelJob };
