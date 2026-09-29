/**
 * Day-end OI Flow JSON archive — save after session (≈15:30) and before minute purge.
 */
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const OiFlowDayArchive = require('../models/oiFlowDayArchive');
const { build5mBars } = require('../utils/oiFlow5mPatterns');
const { hydrateArchiveRowsForTracker } = require('../utils/oiFlowArchiveHydrate');
const { getIstClock } = require('../utils/dateTime');

const SYMBOL = 'NIFTY';
const INTERVAL_MIN = 1;

const inFlight = new Set();

function archiveKey(dateKey, symbol = SYMBOL) {
  return `${symbol}:${dateKey}:${INTERVAL_MIN}`;
}

/**
 * Build + upsert archive for a dateKey from live minute rows (no strikes).
 * Idempotent — safe to call many times.
 */
async function archiveDay(dateKey, { symbol = SYMBOL, force = false } = {}) {
  const dk = String(dateKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) {
    return { ok: false, skipped: true, reason: 'bad_date' };
  }

  const key = archiveKey(dk, symbol);
  if (inFlight.has(key)) {
    return { ok: true, skipped: true, reason: 'in_flight', dateKey: dk };
  }

  inFlight.add(key);
  try {
    if (!force) {
      const existing = await OiFlowDayArchive.findOne({
        symbol,
        dateKey: dk,
        intervalMin: INTERVAL_MIN,
      })
        .select('dateKey rowCount archivedAt payload.schema')
        .lean();
      const isV2 = existing?.payload?.schema === 'oi-flow-tape-v2';
      if (existing && Number(existing.rowCount) > 0 && isV2) {
        return {
          ok: true,
          skipped: true,
          reason: 'already',
          dateKey: dk,
          rowCount: existing.rowCount,
          archivedAt: existing.archivedAt,
        };
      }
      // Compact / pre-v2 archive: upgrade only while live minute rows still exist.
    }

    const sourceRows = await OiFlowMinuteRow.find({
      symbol,
      dateKey: dk,
      fetchOk: true,
    })
      .sort({ minutes: 1 })
      .select('-strikes -createdAt -updatedAt -__v')
      .lean();

    if (!sourceRows.length) {
      return { ok: false, skipped: true, reason: 'no_rows', dateKey: dk };
    }

    const barsAsc = build5mBars(sourceRows, INTERVAL_MIN);
    const byMin = new Map(sourceRows.map((r) => [Number(r.minutes), r]));

    // Merge act/strength bars with live minute totals so tracker columns match /today.
    const rowsAsc = barsAsc.map((bar) => {
      const src = byMin.get(Number(bar.minutes)) || {};
      const spot = Number(bar.spot ?? src.spotPrice ?? src.spot);
      return {
        ...bar,
        spot: Number.isFinite(spot) ? spot : bar.spot,
        spotPrice: Number.isFinite(spot) ? spot : src.spotPrice ?? null,
        // Day + interval ΔOI (same as live tracker)
        dayCallChgOi: Number.isFinite(Number(src.dayCallChgOi)) ? Number(src.dayCallChgOi) : null,
        dayPutChgOi: Number.isFinite(Number(src.dayPutChgOi)) ? Number(src.dayPutChgOi) : null,
        callsChgOi: Number.isFinite(Number(src.callsChgOi)) ? Number(src.callsChgOi) : null,
        putsChgOi: Number.isFinite(Number(src.putsChgOi)) ? Number(src.putsChgOi) : null,
        callOiTotal: Number.isFinite(Number(src.callOiTotal)) ? Number(src.callOiTotal) : null,
        putOiTotal: Number.isFinite(Number(src.putOiTotal)) ? Number(src.putOiTotal) : null,
        diffInOi: Number.isFinite(Number(src.diffInOi)) ? Number(src.diffInOi) : bar.chngInDir ?? null,
        dirOfChng: src.dirOfChng ?? null,
        // Strike tops (chg + absolute labels)
        topCallChgStrike: Number.isFinite(Number(src.topCallChgStrike))
          ? Number(src.topCallChgStrike)
          : bar.topCallStrike ?? null,
        topPutChgStrike: Number.isFinite(Number(src.topPutChgStrike))
          ? Number(src.topPutChgStrike)
          : bar.topPutStrike ?? null,
        topCallChgOi: Number.isFinite(Number(src.topCallChgOi)) ? Number(src.topCallChgOi) : null,
        topPutChgOi: Number.isFinite(Number(src.topPutChgOi)) ? Number(src.topPutChgOi) : null,
        dominantOi: Number.isFinite(Number(src.dominantOi)) ? Number(src.dominantOi) : null,
        oiMigration: src.oiMigration ?? bar.oiMigration ?? null,
        futPrice: Number.isFinite(Number(src.futPrice)) ? Number(src.futPrice) : null,
      };
    });
    const rows = [...rowsAsc].reverse();
    const payload = {
      ok: true,
      dateKey: dk,
      symbol,
      intervalMin: INTERVAL_MIN,
      archivedAt: new Date().toISOString(),
      sourceMinuteCount: sourceRows.length,
      rowCount: rows.length,
      schema: 'oi-flow-tape-v2',
      rows,
    };
    const json = JSON.stringify(payload);
    const byteSize = Buffer.byteLength(json, 'utf8');

    const doc = await OiFlowDayArchive.findOneAndUpdate(
      { symbol, dateKey: dk, intervalMin: INTERVAL_MIN },
      {
        $set: {
          symbol,
          dateKey: dk,
          intervalMin: INTERVAL_MIN,
          rowCount: rows.length,
          sourceMinuteCount: sourceRows.length,
          byteSize,
          archivedAt: new Date(),
          payload,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    // Archive no longer needs per-strike blobs — drop them from live rows to cut DB size
    // until next-day purge deletes the whole dateKey. Tracker uses day/interval totals.
    try {
      await OiFlowMinuteRow.updateMany(
        { symbol, dateKey: dk },
        { $unset: { strikes: 1 } },
      );
    } catch {
      /* best-effort space save */
    }

    return {
      ok: true,
      dateKey: dk,
      rowCount: doc.rowCount,
      sourceMinuteCount: doc.sourceMinuteCount,
      byteSize: doc.byteSize,
      archivedAt: doc.archivedAt,
    };
  } finally {
    inFlight.delete(key);
  }
}

/** After 15:30 — archive today if minute tape exists and archive missing. */
async function maybeArchiveAfterClose(dateKey, { symbol = SYMBOL } = {}) {
  const clock = getIstClock(new Date());
  const dk = dateKey || clock.dateKey;
  // Only after session end (15:30+)
  if (clock.dateKey === dk && clock.minutes <= 15 * 60 + 30) {
    return { ok: true, skipped: true, reason: 'still_in_session' };
  }
  return archiveDay(dk, { symbol });
}

/** Archive any dateKeys about to be purged from live minute collection. */
async function archiveBeforePurge(dateKeys, { symbol = SYMBOL } = {}) {
  const keys = [...new Set((dateKeys || []).map((d) => String(d).slice(0, 10)))].filter((d) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d),
  );
  const results = [];
  for (const dk of keys) {
    results.push(await archiveDay(dk, { symbol }));
  }
  return results;
}

async function listArchivedMonth({ year, month, symbol = SYMBOL } = {}) {
  const y = Math.floor(Number(year));
  const m = Math.floor(Number(month));
  if (!Number.isFinite(y) || y < 2020 || y > 2100 || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error('Invalid year/month');
  }
  const prefix = `${y}-${String(m).padStart(2, '0')}`;
  const rows = await OiFlowDayArchive.find({
    symbol,
    intervalMin: INTERVAL_MIN,
    dateKey: { $regex: `^${prefix}-` },
  })
    .select('dateKey rowCount sourceMinuteCount byteSize archivedAt')
    .sort({ dateKey: 1 })
    .lean();

  return {
    symbol,
    year: y,
    month: m,
    dates: rows.map((r) => ({
      dateKey: r.dateKey,
      rowCount: r.rowCount,
      sourceMinuteCount: r.sourceMinuteCount,
      byteSize: r.byteSize,
      archivedAt: r.archivedAt,
    })),
  };
}

async function getArchivePayload(dateKey, { symbol = SYMBOL } = {}) {
  const dk = String(dateKey || '').slice(0, 10);
  const doc = await OiFlowDayArchive.findOne({
    symbol,
    dateKey: dk,
    intervalMin: INTERVAL_MIN,
  }).lean();
  if (!doc?.payload) return null;
  return {
    dateKey: dk,
    filename: `oi-flow-candles-${dk}-1m.json`,
    payload: doc.payload,
    byteSize: doc.byteSize,
    archivedAt: doc.archivedAt,
  };
}

/**
 * Read-only day tape for OI Flow Tracker (archive JSON → table).
 * Does not write to DB. Rows normalized for the tracker UI (spotPrice, ascending).
 */
async function getDayTapeForTracker(dateKey, { symbol = SYMBOL } = {}) {
  const pack = await getArchivePayload(dateKey, { symbol });
  if (!pack?.payload) return null;

  const raw = Array.isArray(pack.payload.rows) ? pack.payload.rows : [];
  const archiveStep = Number(pack.payload.intervalMin) || INTERVAL_MIN;
  const { rows, oiSource } = hydrateArchiveRowsForTracker(
    raw.map((r) => ({
      ...r,
      dateKey: r.dateKey || pack.dateKey,
      symbol: r.symbol || symbol,
    })),
    { intervalMin: archiveStep },
  );

  const displayRow = rows.length ? { ...rows[rows.length - 1], isLastEntry: true, afterClose: true } : null;

  return {
    ok: true,
    historical: true,
    source: 'archive',
    oiSource,
    schema: pack.payload.schema || null,
    dateKey: pack.dateKey,
    symbol,
    intervalMin: archiveStep,
    rowCount: rows.length,
    expectedRows: pack.payload.rowCount || rows.length,
    archivedAt: pack.archivedAt,
    byteSize: pack.byteSize,
    running: false,
    inSession: false,
    isTradingDay: true,
    weekendHold: false,
    lastTime: displayRow?.time || null,
    nowTime: null,
    rows,
    displayRow,
    liveContext: null,
  };
}

module.exports = {
  INTERVAL_MIN,
  archiveDay,
  maybeArchiveAfterClose,
  archiveBeforePurge,
  listArchivedMonth,
  getArchivePayload,
  getDayTapeForTracker,
};
