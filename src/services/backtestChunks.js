/**
 * Piece-by-piece backtest runs: download + simulate one stretch of days at a time so trades can be
 * published (`onPartial`) while later stretches are still downloading. Stretches match the Dhan
 * download window (25 days), so splitting adds no extra history calls.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHUNK_DAYS = 25;

function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const dayLabel = (dateKey) => `${Number(dateKey.slice(8, 10))} ${MONTHS[Number(dateKey.slice(5, 7)) - 1]}`;

/**
 * [{ from, to, label }] — consecutive stretches covering [from, to]. The first stretch is `warmupDays`
 * shorter, because the engine also downloads that many days before `from`.
 */
function rangeChunks(from, to, { days = CHUNK_DAYS, warmupDays = 0 } = {}) {
  const chunks = [];
  let start = from;
  let len = Math.max(1, days - warmupDays);
  while (start <= to) {
    const end = addDays(start, len - 1) < to ? addDays(start, len - 1) : to;
    chunks.push({ from: start, to: end, label: `${dayLabel(start)} – ${dayLabel(end)} ${end.slice(0, 4)}` });
    start = addDays(end, 1);
    len = days;
  }
  return chunks;
}

/**
 * Wraps `onProgress` for chunk `index` of `count`: adds the chunk label and an overall `pct`
 * (download ≈ 90% of a chunk's share, simulation the rest).
 */
function chunkProgress(onProgress, index, count, label, extra = () => ({})) {
  return (p = {}) => {
    const frac = p.total ? p.done / p.total : 1;
    const within = p.phase === 'simulate' ? 0.9 + 0.1 * frac : 0.9 * frac;
    onProgress?.({
      ...p,
      chunk: index + 1,
      chunks: count,
      chunkLabel: label,
      pct: Math.min(100, Math.round(((index + within) / count) * 1000) / 10),
      ...extra(),
    });
  };
}

module.exports = { rangeChunks, chunkProgress };
