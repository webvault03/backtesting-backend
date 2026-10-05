/**
 * Open OI Walls profit trail.
 * Peak rungs arm a lock. After +40, also trail 20 pts behind the high.
 * Retrace to the lock → exit. No hard SL from entry.
 */
const TRAIL_RUNGS = [
  { peak: 20, lock: 10 },
  { peak: 30, lock: 20 },
  { peak: 40, lock: 25 },
  { peak: 50, lock: 30 },
  { peak: 70, lock: 50 },
];

const PEAK_TRAIL_AFTER = 40;
const PEAK_TRAIL_GAP = 20;
const OLD_LADDER_PTS = [5, 10, 15, 20, 30];

function round2(n) {
  return Number(Number(n).toFixed(2));
}

function computeTrailLockPoints(peakPts) {
  const peak = Number(peakPts);
  if (!Number.isFinite(peak) || peak < TRAIL_RUNGS[0].peak) return null;
  let floor = null;
  for (const r of TRAIL_RUNGS) {
    if (peak >= r.peak) floor = r.lock;
  }
  if (peak >= PEAK_TRAIL_AFTER) {
    floor = Math.max(floor ?? 0, peak - PEAK_TRAIL_GAP);
  }
  return floor;
}

function buildTrailMilestones(entryPremium) {
  const entry = Number(entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) return [];
  return TRAIL_RUNGS.map((r) => ({
    points: r.peak,
    lockPoints: r.lock,
    role: 'trail_arm',
    premium: round2(entry + r.peak),
    status: 'PENDING',
    hitAt: null,
    hitPremium: null,
    pnlAtHit: null,
  }));
}

function isOldRecordLadder(milestones) {
  const pts = (Array.isArray(milestones) ? milestones : [])
    .map((m) => Number(m.points))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return pts.join(',') === OLD_LADDER_PTS.join(',');
}

function isTrailMilestones(milestones) {
  const rows = Array.isArray(milestones) ? milestones : [];
  if (!rows.length) return false;
  return rows.every((m) => Number(m.lockPoints) > 0 || String(m.role || '') === 'trail_arm');
}

function peakFromTrade(trade, optionLtp) {
  const entry = Number(trade?.entryPremium) || 0;
  const highs = [Number(trade?.highSinceEntry), Number(optionLtp)];
  for (const m of trade?.targetMilestones || []) {
    highs.push(Number(m.hitPremium));
    if (String(m.status || '').toUpperCase() === 'HIT') {
      highs.push(entry + Number(m.points));
    }
  }
  const peak = Math.max(...highs.filter((n) => Number.isFinite(n) && n > 0));
  return Number.isFinite(peak) && peak > 0 ? round2(peak) : null;
}

function applyTrailToMilestones(trade, optionLtp, { qty, charges } = {}) {
  const entry = Number(trade.entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) return { changed: false, exit: false };
  let milestones = Array.isArray(trade.targetMilestones) ? trade.targetMilestones.map((m) => ({ ...m })) : [];
  if (!milestones.length || isOldRecordLadder(milestones)) {
    milestones = buildTrailMilestones(entry);
  }

  const peakPremium = peakFromTrade({ ...trade, targetMilestones: milestones }, optionLtp);
  const peakPts = peakPremium != null ? peakPremium - entry : 0;
  const now = new Date();
  const q = Number(qty != null ? qty : trade.qty) || 0;
  const ch = Math.max(0, Number(charges != null ? charges : trade.charges) || 0);
  let changed = !isTrailMilestones(trade.targetMilestones) || isOldRecordLadder(trade.targetMilestones);
  const justHit = [];

  milestones = milestones.map((m) => {
    const status = String(m.status || 'PENDING').toUpperCase();
    const peakNeed = Number(m.points);
    const already = status === 'HIT' || status === 'MISSED';
    if (already) {
      return {
        ...m,
        lockPoints: Number(m.lockPoints) || TRAIL_RUNGS.find((r) => r.peak === peakNeed)?.lock,
        role: 'trail_arm',
        status,
      };
    }
    if (!Number.isFinite(peakNeed) || peakPts < peakNeed) {
      return { ...m, lockPoints: Number(m.lockPoints) || TRAIL_RUNGS.find((r) => r.peak === peakNeed)?.lock, role: 'trail_arm', status: 'PENDING' };
    }
    changed = true;
    justHit.push(peakNeed);
    const hitPx = Number(optionLtp);
    return {
      ...m,
      lockPoints: Number(m.lockPoints) || TRAIL_RUNGS.find((r) => r.peak === peakNeed)?.lock,
      role: 'trail_arm',
      status: 'HIT',
      hitAt: now,
      hitPremium: Number.isFinite(hitPx) ? round2(hitPx) : round2(entry + peakNeed),
      pnlAtHit: Number.isFinite(hitPx) ? round2((hitPx - entry) * q - ch) : null,
    };
  });

  const lockPts = computeTrailLockPoints(peakPts);
  const lockPremium = lockPts != null ? round2(entry + lockPts) : null;
  const ltp = Number(optionLtp);
  const armed = lockPts != null;
  const exit = armed && Number.isFinite(ltp) && ltp > 0 && ltp <= lockPremium;

  const nextArm = milestones.find((m) => String(m.status || '').toUpperCase() !== 'HIT');
  const nextTarget = nextArm ? Number(nextArm.premium) : null;

  return {
    changed,
    justHit,
    milestones,
    peakPremium,
    peakPts: round2(peakPts),
    lockPts,
    lockPremium,
    nextTarget: Number.isFinite(nextTarget) ? round2(nextTarget) : null,
    exit,
    reason: exit ? 'TRAIL' : null,
  };
}

module.exports = {
  TRAIL_RUNGS,
  PEAK_TRAIL_AFTER,
  PEAK_TRAIL_GAP,
  buildTrailMilestones,
  computeTrailLockPoints,
  applyTrailToMilestones,
  isOldRecordLadder,
  isTrailMilestones,
  peakFromTrade,
};
