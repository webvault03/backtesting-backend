/**
 * Parse trade-history date filters from API query params.
 * Precedence: date (YYYY-MM-DD) > month (YYYY-MM) > year (YYYY) > all.
 * Filters on LivePaperTrade.entryDateKey (IST calendar day).
 */
function applyEntryDateFilter(q, { date, month, year } = {}) {
  const d = String(date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    q.entryDateKey = d;
    return { mode: 'date', value: d };
  }

  const mRaw = String(month || '').trim();
  if (/^\d{4}-\d{2}$/.test(mRaw)) {
    q.entryDateKey = { $regex: `^${mRaw}` };
    return { mode: 'month', value: mRaw };
  }

  const yNum = Number(year);
  const mNum = Number(month);
  if (Number.isFinite(yNum) && yNum >= 2000 && yNum <= 2100) {
    if (Number.isFinite(mNum) && mNum >= 1 && mNum <= 12) {
      const ym = `${yNum}-${String(mNum).padStart(2, '0')}`;
      q.entryDateKey = { $regex: `^${ym}` };
      return { mode: 'month', value: ym };
    }
    q.entryDateKey = { $regex: `^${yNum}` };
    return { mode: 'year', value: String(yNum) };
  }

  return { mode: 'all', value: null };
}

module.exports = { applyEntryDateFilter };
