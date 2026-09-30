/**
 * OI Flow minute recorder — current trading day only (LOCKED).
 * Captures every IST minute from 09:15 → 15:30.
 * On a new weekday, previous dateKeys are deleted — except Fri is kept
 * through Sat/Sun and purged when Monday (next session week) starts.
 *
 * Focus = Change in OI (ΔOI), not absolute standing OI.
 * dayCallChgOi / dayPutChgOi = ATM ± 3 day-so-far ΔOI (our "total OI")
 * callsChgOi / putsChgOi     = interval ΔOI on overlapping strikes (ignores ATM window hops)
 * chngInDir                  = Puts chng − Calls chng (interval)
 * diffInOi                   = day Put Δ − day Call Δ (+ when Puts building more)
 * dirOfChng                  = up / down / flat from chngInDir
 * callOiTotal / putOiTotal   = absolute OI stored for reference only
 */
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const {
  getIstClock,
  isWeekendDateKey,
  oiTapeDateKey,
  oiTapeRetainDateKeys,
  sleep,
} = require('../utils/dateTime');
const { isNseCashTradingDay } = require('./nseHolidayService');
const {
  getNearestWeeklyExpiry,
  getOptionChainOiSnapshot,
  getFutureLtp,
  getFutureQuote,
} = require('./dhanLiveService');
const { compactStrikes, intervalOiFromRows } = require('../utils/oiFlowIntervalOi');
const { analyticsFromStrikes } = require('../utils/oiFlowStrikeAnalytics');

const SYMBOL = 'NIFTY';
const SESSION_FROM = 9 * 60 + 15; // 09:15
const SESSION_TO = 15 * 60 + 30; // 15:30
/** ATM ± 3 strikes (3 left + ATM + 3 right). */
const LOOKAROUND_STRIKES = 3;
const LOOP_MS = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

const engineState = {
  running: false,
  startedAt: null,
  loopTimer: null,
  tickInFlight: false,
  symbol: SYMBOL,
  dateKey: null,
  lastMinutes: null,
  lastError: null,
  lastFetchedAt: null,
  lastRow: null,
  expiry: null,
};

function formatHhmm(minutes) {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function dirArrow(value) {
  if (!Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

/** Strike numbers only from an ATM-window snapshot (sorted). */
function strikeNamesFromRow(row) {
  if (!Array.isArray(row?.strikes)) return [];
  const names = [];
  const seen = new Set();
  for (const s of row.strikes) {
    const n = Number(s?.strike);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
  }
  names.sort((a, b) => a - b);
  return names;
}

async function latestSavedStrikeNames(dateKey) {
  const row = await OiFlowMinuteRow.findOne({
    symbol: engineState.symbol,
    dateKey,
    fetchOk: true,
  })
    .select({ strikes: 1, _id: 0 })
    .sort({ minutes: -1 })
    .lean();
  const fromDb = strikeNamesFromRow(row);
  if (fromDb.length) return fromDb;
  return strikeNamesFromRow(engineState.lastRow);
}

function sentimentFromDiff(chngInDir) {
  if (!Number.isFinite(chngInDir) || chngInDir === 0) return 'Neutral';
  // Chng in dir = Puts chng − Calls chng → Put-heavy = Bull, Call-heavy = Bear
  return chngInDir > 0 ? 'Bull' : 'Bear';
}

function deriveFields({
  dayCallChgOi,
  dayPutChgOi,
  strikes,
  prev,
}) {
  const interval = intervalOiFromRows({ dayCallChgOi, dayPutChgOi, strikes }, prev);
  const callsChgOi = interval.callsChgOi;
  const putsChgOi = interval.putsChgOi;

  // Chng in dir = interval Calls/Puts Δ (Puts − Calls).
  const chngInDir =
    Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi)
      ? putsChgOi - callsChgOi
      : null;

  // Diff. in OI = day Put Δ − day Call Δ (change totals, not absolute OI).
  const diffInOi =
    Number.isFinite(dayPutChgOi) && Number.isFinite(dayCallChgOi)
      ? dayPutChgOi - dayCallChgOi
      : null;

  const strikeStats = analyticsFromStrikes(strikes, prev);

  return {
    callsChgOi,
    putsChgOi,
    dayCallChgOi: Number.isFinite(dayCallChgOi) ? dayCallChgOi : null,
    dayPutChgOi: Number.isFinite(dayPutChgOi) ? dayPutChgOi : null,
    diffInOi,
    chngInDir,
    dirOfChng: dirArrow(chngInDir),
    sentiment: sentimentFromDiff(chngInDir),
    topCallChgStrike: strikeStats.topCallChgStrike,
    topCallChgOi: strikeStats.topCallChgOi,
    topPutChgStrike: strikeStats.topPutChgStrike,
    topPutChgOi: strikeStats.topPutChgOi,
    dominantSide: strikeStats.dominantSide,
    dominantStrike: strikeStats.dominantStrike,
    dominantOi: strikeStats.dominantOi,
    oiMigration: strikeStats.oiMigration,
  };
}

async function purgeOtherDays(todayKey) {
  const keep = oiTapeRetainDateKeys(todayKey);
  if (!keep.length) return 0;

  // Archive days that will be deleted so history survives purge.
  try {
    const doomed = await OiFlowMinuteRow.distinct('dateKey', { dateKey: { $nin: keep } });
    if (doomed.length) {
      const archive = require('./oiFlowDayArchiveService');
      await archive.archiveBeforePurge(doomed, { symbol: engineState.symbol || SYMBOL });
    }
  } catch (err) {
    engineState.lastError = `archive_before_purge: ${err.message}`;
  }

  // Weekday: keep today only. Weekend: keep last Friday (do not wipe Fri on Sat/Sun).
  const result = await OiFlowMinuteRow.deleteMany({
    dateKey: { $nin: keep },
  });
  try {
    const manualOi = require('./manualConsoleOiEngine');
    await manualOi.purgeOtherDays(todayKey);
  } catch {
    /* best-effort */
  }
  return result?.deletedCount || 0;
}

async function getPreviousRow(symbol, dateKey, minutes) {
  return OiFlowMinuteRow.findOne({
    symbol,
    dateKey,
    minutes: { $lt: minutes },
    fetchOk: true,
    callOiTotal: { $ne: null },
  })
    .sort({ minutes: -1 })
    .lean();
}

async function captureMinute({ dateKey, minutes, forceRetry = false } = {}) {
  const time = formatHhmm(minutes);
  const existing = await OiFlowMinuteRow.findOne({
    symbol: engineState.symbol,
    dateKey,
    minutes,
  }).lean();

  if (existing?.fetchOk && !forceRetry) {
    engineState.lastMinutes = minutes;
    engineState.lastRow = existing;
    return existing;
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      if (!engineState.expiry) {
        engineState.expiry = await getNearestWeeklyExpiry(engineState.symbol);
      }
      const snapshot = await getOptionChainOiSnapshot({
        symbol: engineState.symbol,
        expiry: engineState.expiry,
        lookaroundStrikes: LOOKAROUND_STRIKES,
      });
      // ATM ± 3 window only (not full chain).
      const callOiTotal = snapshot?.totals?.callOi;
      const putOiTotal = snapshot?.totals?.putOi;
      const dayCallChgOi = snapshot?.totals?.callChgOi;
      const dayPutChgOi = snapshot?.totals?.putChgOi;
      const strikes = compactStrikes(snapshot?.strikes);
      const spotPrice = Number.isFinite(snapshot?.spot) ? snapshot.spot : null;
      const prev = await getPreviousRow(engineState.symbol, dateKey, minutes);
      const derived = deriveFields({
        dayCallChgOi,
        dayPutChgOi,
        strikes,
        prev,
      });
      const market = await getLiveMarketContext(spotPrice);

      const doc = {
        symbol: engineState.symbol,
        dateKey,
        minutes,
        time,
        spotPrice,
        futPrice: market.futPrice ?? null,
        atm: Number.isFinite(snapshot?.atm) ? snapshot.atm : null,
        lookaroundStrikes: LOOKAROUND_STRIKES,
        strikes,
        callOiTotal: Number.isFinite(callOiTotal) ? callOiTotal : null,
        putOiTotal: Number.isFinite(putOiTotal) ? putOiTotal : null,
        dayCallChgOi: Number.isFinite(dayCallChgOi) ? dayCallChgOi : null,
        dayPutChgOi: Number.isFinite(dayPutChgOi) ? dayPutChgOi : null,
        ...derived,
        expiry: engineState.expiry || null,
        fetchOk: true,
        error: null,
        fetchedAt: new Date(),
      };

      const saved = await OiFlowMinuteRow.findOneAndUpdate(
        { symbol: engineState.symbol, dateKey, minutes },
        { $set: doc },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();

      try {
        const manualOi = require('./manualConsoleOiEngine');
        await manualOi.mirrorRow(saved);
      } catch {
        /* Manual Console mirror is best-effort */
      }

      engineState.lastMinutes = minutes;
      engineState.lastRow = saved;
      engineState.lastFetchedAt = saved.fetchedAt;
      engineState.lastError = null;
      listTodayCache.atMs = 0;
      listTodayCache.payload = null;
      return saved;
    } catch (err) {
      lastErr = err;
      engineState.lastError = err.message;
      // Don't burn Dhan quota with rapid retries while rate-limited / cooling down.
      if (/rate\s*limit|429|cooling down|Too many requests|oc empty/i.test(String(err.message || ''))) {
        break;
      }
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  const failedMsg = lastErr?.message || 'Fetch failed';
  const softFail = /rate\s*limit|429|cooling down|Too many requests|oc empty/i.test(failedMsg);

  // Soft / rate-limit failures: do not spam fetchOk:false rows (tracker hides them → empty table).
  // Keep last good row in memory; retry next tick / next minute.
  if (softFail) {
    engineState.lastError = failedMsg;
    return null;
  }

  const failed = {
    symbol: engineState.symbol,
    dateKey,
    minutes,
    time,
    spotPrice: null,
    futPrice: null,
    atm: null,
    lookaroundStrikes: LOOKAROUND_STRIKES,
    strikes: [],
    callOiTotal: null,
    putOiTotal: null,
    dayCallChgOi: null,
    dayPutChgOi: null,
    callsChgOi: null,
    putsChgOi: null,
    diffInOi: null,
    dirOfChng: null,
    chngInDir: null,
    sentiment: null,
    expiry: engineState.expiry || null,
    fetchOk: false,
    error: failedMsg,
    fetchedAt: new Date(),
  };

  const saved = await OiFlowMinuteRow.findOneAndUpdate(
    { symbol: engineState.symbol, dateKey, minutes },
    { $set: failed },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  try {
    const manualOi = require('./manualConsoleOiEngine');
    await manualOi.mirrorRow(saved);
  } catch {
    /* best-effort */
  }

  engineState.lastMinutes = minutes;
  engineState.lastRow = saved;
  engineState.lastFetchedAt = saved.fetchedAt;
  return saved;
}

async function tick() {
  if (engineState.tickInFlight) return;
  engineState.tickInFlight = true;
  try {
    const clock = getIstClock(new Date());
    const { dateKey, minutes } = clock;

    if (engineState.dateKey && engineState.dateKey !== dateKey) {
      engineState.expiry = null;
      engineState.lastMinutes = null;
      engineState.lastRow = null;
    }
    if (engineState.dateKey !== dateKey) {
      await purgeOtherDays(dateKey);
      engineState.dateKey = dateKey;
    }

    if (isWeekendDateKey(dateKey) || !isNseCashTradingDay(dateKey)) {
      engineState.lastError = isWeekendDateKey(dateKey) ? 'WEEKEND' : 'HOLIDAY';
      // Archive any live minute tapes still in DB (e.g. Friday kept into weekend).
      try {
        const archive = require('./oiFlowDayArchiveService');
        const leftover = await OiFlowMinuteRow.distinct('dateKey');
        if (leftover.length) await archive.archiveBeforePurge(leftover, { symbol: engineState.symbol || SYMBOL });
      } catch {
        /* best-effort */
      }
      return;
    }

    if (minutes < SESSION_FROM) {
      return;
    }

    // After 15:30 — stop capturing; archive today's tape once.
    if (minutes > SESSION_TO) {
      try {
        const archive = require('./oiFlowDayArchiveService');
        await archive.maybeArchiveAfterClose(dateKey, { symbol: engineState.symbol || SYMBOL });
      } catch (err) {
        engineState.lastError = `day_archive: ${err.message}`;
      }
      return;
    }

    if (engineState.lastMinutes === minutes && engineState.lastRow?.fetchOk) {
      return;
    }

    await captureMinute({ dateKey, minutes });

    // Final session minute (15:30) — archive immediately after capture.
    if (minutes === SESSION_TO) {
      try {
        const archive = require('./oiFlowDayArchiveService');
        await archive.archiveDay(dateKey, { symbol: engineState.symbol || SYMBOL });
      } catch (err) {
        engineState.lastError = `day_archive: ${err.message}`;
      }
    }
  } catch (err) {
    engineState.lastError = err.message;
  } finally {
    engineState.tickInFlight = false;
  }
}

function ensureEngineRunning() {
  if (engineState.running && engineState.loopTimer) {
    return { ok: true, already: true };
  }
  engineState.running = true;
  engineState.startedAt = new Date().toISOString();
  if (engineState.loopTimer) clearInterval(engineState.loopTimer);
  engineState.loopTimer = setInterval(() => {
    tick().catch((err) => {
      engineState.lastError = err.message;
    });
  }, LOOP_MS);
  tick().catch((err) => {
    engineState.lastError = err.message;
  });
  return { ok: true, started: true };
}

function buildRowFromSnapshot(snapshot, clock, prev, { livePreview = false, afterClose = false } = {}) {
  const callOiTotal = snapshot?.totals?.callOi;
  const putOiTotal = snapshot?.totals?.putOi;
  const dayCallChgOi = snapshot?.totals?.callChgOi;
  const dayPutChgOi = snapshot?.totals?.putChgOi;
  const strikes = compactStrikes(snapshot?.strikes);
  const spotPrice = Number.isFinite(snapshot?.spot) ? snapshot.spot : null;
  const derived = deriveFields({
    dayCallChgOi,
    dayPutChgOi,
    strikes,
    prev,
  });
  return {
    symbol: engineState.symbol,
    dateKey: clock.dateKey,
    minutes: clock.minutes,
    time: formatHhmm(clock.minutes),
    spotPrice,
    futPrice: null,
    atm: Number.isFinite(snapshot?.atm) ? snapshot.atm : null,
    lookaroundStrikes: LOOKAROUND_STRIKES,
    strikes,
    callOiTotal: Number.isFinite(callOiTotal) ? callOiTotal : null,
    putOiTotal: Number.isFinite(putOiTotal) ? putOiTotal : null,
    dayCallChgOi: Number.isFinite(dayCallChgOi) ? dayCallChgOi : null,
    dayPutChgOi: Number.isFinite(dayPutChgOi) ? dayPutChgOi : null,
    ...derived,
    expiry: engineState.expiry || null,
    fetchOk: true,
    error: null,
    fetchedAt: new Date(),
    livePreview: Boolean(livePreview),
    afterClose: Boolean(afterClose),
    isLastEntry: true,
  };
}

/** Display-only fetch after 15:30 — never written as a session minute row. */
async function buildAfterCloseLastEntry(clock, prev) {
  try {
    if (!engineState.expiry) {
      engineState.expiry = await getNearestWeeklyExpiry(engineState.symbol);
    }
    const snapshot = await getOptionChainOiSnapshot({
      symbol: engineState.symbol,
      expiry: engineState.expiry,
      lookaroundStrikes: LOOKAROUND_STRIKES,
    });
    return buildRowFromSnapshot(snapshot, clock, prev, { livePreview: true, afterClose: true });
  } catch (err) {
    engineState.lastError = err.message;
    return null;
  }
}

/** API payload — omit per-strike snapshots (large; table uses precomputed ΔOI). */
const OI_FLOW_TODAY_SELECT =
  '-strikes -createdAt -updatedAt -__v';

const FUT_CACHE_MS = 4000;
const futCache = { ltp: null, fetchedAt: 0 };
/** Short TTL so header + page + paper engines share one tape read. */
const LIST_TODAY_CACHE_MS = 2000;
const listTodayCache = { atMs: 0, payload: null };

function stripStrikes(row) {
  if (!row || typeof row !== 'object') return row;
  const { strikes: _s, ...rest } = row;
  return rest;
}

async function getLiveMarketContext(spot) {
  const now = Date.now();
  if (!futCache.ltp || now - futCache.fetchedAt > FUT_CACHE_MS) {
    try {
      let ltp = null;
      // Weekly option expiry usually has no matching FUT — try it, then nearest month.
      if (engineState.expiry) {
        try {
          const same = await getFutureLtp({
            symbol: engineState.symbol,
            expiry: engineState.expiry,
            maxWaitMs: 800,
          });
          if (Number.isFinite(Number(same?.ltp)) && Number(same.ltp) > 0) {
            ltp = Number(same.ltp);
          }
        } catch {
          /* fall through to nearest month */
        }
      }
      if (!Number.isFinite(ltp) || ltp <= 0) {
        const quote = await getFutureQuote({
          symbol: engineState.symbol,
          maxWaitMs: 1200,
        });
        if (Number.isFinite(Number(quote?.ltp)) && Number(quote.ltp) > 0) {
          ltp = Number(quote.ltp);
        }
      }
      if (Number.isFinite(ltp) && ltp > 0) {
        futCache.ltp = ltp;
        futCache.fetchedAt = now;
      }
    } catch {
      /* keep stale fut */
    }
  }
  const fut = futCache.ltp;
  const spotN = Number(spot);
  const basis = Number.isFinite(fut) && Number.isFinite(spotN) ? fut - spotN : null;
  return {
    futPrice: Number.isFinite(fut) && fut > 0 ? fut : null,
    basis: Number.isFinite(basis) ? Number(basis.toFixed(2)) : null,
  };
}

async function fetchLatestRowWithStrikes(dateKey) {
  return OiFlowMinuteRow.findOne({
    symbol: engineState.symbol,
    dateKey,
    fetchOk: true,
    'strikes.0': { $exists: true },
  })
    .sort({ minutes: -1 })
    .select('-createdAt -updatedAt -__v')
    .lean();
}

/** Attach strike snapshots for heatmap / walls (display only). */
async function enrichDisplayRow(displayRow, dateKey, { inSession } = {}) {
  if (!displayRow) return null;
  let source = null;
  if (inSession && Array.isArray(engineState.lastRow?.strikes) && engineState.lastRow.strikes.length) {
    source = engineState.lastRow;
  } else {
    source = await fetchLatestRowWithStrikes(dateKey);
  }
  if (!source?.strikes?.length) {
    return stripStrikes(displayRow);
  }
  const captureMinutes = Number(source.minutes);
  const prev =
    Number.isFinite(captureMinutes)
      ? await getPreviousRow(engineState.symbol, dateKey, captureMinutes)
      : null;
  return {
    ...stripStrikes(displayRow),
    spotPrice: displayRow.spotPrice ?? source.spotPrice,
    atm: displayRow.atm ?? source.atm,
    callOiTotal: displayRow.callOiTotal ?? source.callOiTotal,
    putOiTotal: displayRow.putOiTotal ?? source.putOiTotal,
    dayCallChgOi: displayRow.dayCallChgOi ?? source.dayCallChgOi,
    dayPutChgOi: displayRow.dayPutChgOi ?? source.dayPutChgOi,
    topCallChgStrike: displayRow.topCallChgStrike ?? source.topCallChgStrike,
    topCallChgOi: displayRow.topCallChgOi ?? source.topCallChgOi,
    topPutChgStrike: displayRow.topPutChgStrike ?? source.topPutChgStrike,
    topPutChgOi: displayRow.topPutChgOi ?? source.topPutChgOi,
    dominantSide: displayRow.dominantSide ?? source.dominantSide,
    dominantStrike: displayRow.dominantStrike ?? source.dominantStrike,
    dominantOi: displayRow.dominantOi ?? source.dominantOi,
    oiMigration: displayRow.oiMigration ?? source.oiMigration,
    strikes: source.strikes,
    prevStrikes: Array.isArray(prev?.strikes) ? prev.strikes : [],
    strikeCaptureTime: source.time,
  };
}

async function getStatus() {
  const clock = getIstClock(new Date());
  const tapeDateKey = oiTapeDateKey(clock.dateKey);
  const weekendHold = isWeekendDateKey(clock.dateKey) && tapeDateKey !== clock.dateKey;
  const count = await OiFlowMinuteRow.countDocuments({
    symbol: engineState.symbol,
    dateKey: tapeDateKey,
  });
  let lastRow = weekendHold ? null : engineState.lastRow;
  if (!lastRow) {
    lastRow = await OiFlowMinuteRow.findOne({
      symbol: engineState.symbol,
      dateKey: tapeDateKey,
      fetchOk: true,
    })
      .sort({ minutes: -1 })
      .lean();
    if (lastRow && !weekendHold) {
      engineState.lastRow = lastRow;
      engineState.lastMinutes = lastRow.minutes;
      engineState.lastFetchedAt = lastRow.fetchedAt;
    }
  }
  const lastMinutes = lastRow?.minutes ?? null;
  const lastTime = lastRow?.time || null;
  const isTradingDay = !isWeekendDateKey(clock.dateKey) && isNseCashTradingDay(clock.dateKey);
  return {
    running: engineState.running,
    startedAt: engineState.startedAt,
    symbol: engineState.symbol,
    dateKey: tapeDateKey,
    calendarDateKey: clock.dateKey,
    weekendHold,
    nowTime: formatHhmm(clock.minutes),
    sessionFrom: formatHhmm(SESSION_FROM),
    sessionTo: formatHhmm(SESSION_TO),
    inSession: isTradingDay && clock.minutes >= SESSION_FROM && clock.minutes <= SESSION_TO,
    isTradingDay,
    rowCount: count,
    expectedRows: SESSION_TO - SESSION_FROM + 1,
    lastMinutes,
    lastTime,
    lastFetchedAt: lastRow?.fetchedAt || null,
    lastError: engineState.lastError,
    lastRow: lastRow || null,
    expiry: engineState.expiry,
    lookaroundStrikes: LOOKAROUND_STRIKES,
    savedStrikes: await latestSavedStrikeNames(tapeDateKey),
  };
}

async function listTodayRows() {
  const now = Date.now();
  if (listTodayCache.payload && now - listTodayCache.atMs < LIST_TODAY_CACHE_MS) {
    return listTodayCache.payload;
  }

  const clock = getIstClock(new Date());
  const tapeDateKey = oiTapeDateKey(clock.dateKey);
  const weekendHold = isWeekendDateKey(clock.dateKey) && tapeDateKey !== clock.dateKey;
  const rows = await OiFlowMinuteRow.find({
    symbol: engineState.symbol,
    dateKey: tapeDateKey,
  })
    .select(OI_FLOW_TODAY_SELECT)
    .sort({ minutes: -1 })
    .lean();

  const lastGoodFromDb = rows.find((r) => r.fetchOk !== false) || null;
  let lastRow = weekendHold ? null : engineState.lastRow;
  // Never let a failed in-memory/DB row hide successful captures (empty tracker UI).
  if (!lastRow || lastRow.fetchOk === false) {
    lastRow = lastGoodFromDb || rows[0] || null;
  } else if (lastGoodFromDb && Number(lastGoodFromDb.minutes) > Number(lastRow.minutes)) {
    lastRow = lastGoodFromDb;
  }
  const savedStrikes = await latestSavedStrikeNames(tapeDateKey);
  if (lastRow) lastRow = stripStrikes(lastRow);

  const isTradingDay = !isWeekendDateKey(clock.dateKey) && isNseCashTradingDay(clock.dateKey);
  const inSession =
    isTradingDay && clock.minutes >= SESSION_FROM && clock.minutes <= SESSION_TO;

  const status = {
    running: engineState.running,
    startedAt: engineState.startedAt,
    symbol: engineState.symbol,
    dateKey: tapeDateKey,
    calendarDateKey: clock.dateKey,
    weekendHold,
    nowTime: formatHhmm(clock.minutes),
    sessionFrom: formatHhmm(SESSION_FROM),
    sessionTo: formatHhmm(SESSION_TO),
    inSession,
    isTradingDay,
    rowCount: rows.length,
    expectedRows: SESSION_TO - SESSION_FROM + 1,
    lastMinutes: lastRow?.minutes ?? null,
    lastTime: lastRow?.time || null,
    lastFetchedAt: lastRow?.fetchedAt || null,
    lastError: engineState.lastError,
    lastRow,
    expiry: engineState.expiry,
    lookaroundStrikes: LOOKAROUND_STRIKES,
    savedStrikes,
  };

  let displayRow = status.lastRow || rows[0] || null;

  // Outside 09:15–15:30 (or weekend hold of Friday): show last entry, Time 15:30.
  if (!status.inSession) {
    if (displayRow) {
      displayRow = {
        ...displayRow,
        time: formatHhmm(SESSION_TO),
        minutes: SESSION_TO,
        sessionCaptureTime: displayRow.time,
        afterClose: true,
        isLastEntry: true,
        livePreview: false,
      };
    } else if (!weekendHold) {
      const preview = await buildAfterCloseLastEntry(clock, null);
      if (preview) {
        displayRow = {
          ...preview,
          time: formatHhmm(SESSION_TO),
          minutes: SESSION_TO,
          afterClose: true,
          isLastEntry: true,
        };
      }
    }
  }

  displayRow = await enrichDisplayRow(displayRow, tapeDateKey, { inSession: status.inSession });

  const spotForLive = Number(displayRow?.spotPrice);
  const liveContext = await getLiveMarketContext(spotForLive);
  if (displayRow) {
    const callOi = Number(displayRow.callOiTotal);
    const putOi = Number(displayRow.putOiTotal);
    liveContext.spot = Number.isFinite(spotForLive) ? spotForLive : null;
    liveContext.atm = Number.isFinite(Number(displayRow.atm)) ? Number(displayRow.atm) : null;
    liveContext.callOiTotal = Number.isFinite(callOi) ? callOi : null;
    liveContext.putOiTotal = Number.isFinite(putOi) ? putOi : null;
    liveContext.pcr =
      Number.isFinite(callOi) && callOi > 0 && Number.isFinite(putOi) ? putOi / callOi : null;
    liveContext.dayCallChgOi = Number.isFinite(Number(displayRow.dayCallChgOi))
      ? Number(displayRow.dayCallChgOi)
      : null;
    liveContext.dayPutChgOi = Number.isFinite(Number(displayRow.dayPutChgOi))
      ? Number(displayRow.dayPutChgOi)
      : null;
    if (displayRow.expiry) {
      const exp = new Date(`${String(displayRow.expiry).slice(0, 10)}T15:30:00+05:30`);
      const today = new Date(`${clock.dateKey}T12:00:00+05:30`);
      if (!Number.isNaN(exp.getTime()) && !Number.isNaN(today.getTime())) {
        liveContext.expiryDays = Math.max(0, Math.ceil((exp - today) / 86400000));
      }
    }
  }

  const payload = { ...status, rows, displayRow, liveContext };
  listTodayCache.atMs = now;
  listTodayCache.payload = payload;
  return payload;
}

function computeHeaderSignal(rows, displayRow) {
  const byMin = new Map();
  for (const row of rows || []) {
    if (!row || row.fetchOk === false) continue;
    const m = Number(row.minutes);
    if (!Number.isFinite(m)) continue;
    byMin.set(m, row);
  }
  if (displayRow && displayRow.fetchOk !== false) {
    const m = Number(displayRow.minutes);
    if (Number.isFinite(m)) byMin.set(m, displayRow);
  }
  const ordered = [...byMin.values()].sort((a, b) => Number(a.minutes) - Number(b.minutes));
  if (!ordered.length) {
    return {
      decision: 'WAIT',
      tone: 'flat',
      bias: 'Sideways',
      emoji: '😢',
      mood: 'Sad',
      dirMark: '⚪ →',
      reason: 'Waiting for 09:15 candles…',
      line: '😢 Sad · Sideways · Waiting for 09:15 candles…',
      asOf: null,
      minutesUsed: 0,
    };
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const spotOpen = Number(first.spotPrice);
  const spotNow = Number(last.spotPrice);
  const dayCall = Number(last.dayCallChgOi);
  const dayPut = Number(last.dayPutChgOi);
  const dayDiff =
    Number.isFinite(dayPut) && Number.isFinite(dayCall) ? dayPut - dayCall : null;

  let bullMins = 0;
  let bearMins = 0;
  for (const row of ordered) {
    const calls = Number(row.callsChgOi);
    const puts = Number(row.putsChgOi);
    const chng =
      Number.isFinite(calls) && Number.isFinite(puts) ? puts - calls : null;
    if (!Number.isFinite(chng) || chng === 0) continue;
    if (chng > 0) bullMins += 1;
    else bearMins += 1;
  }

  const spotChg =
    Number.isFinite(spotNow) && Number.isFinite(spotOpen) ? spotNow - spotOpen : null;
  const spotScore = Number.isFinite(spotChg) ? (spotChg > 0.5 ? 1 : spotChg < -0.5 ? -1 : 0) : 0;
  const oiScore = Number.isFinite(dayDiff) ? (dayDiff > 0 ? 1 : dayDiff < 0 ? -1 : 0) : 0;
  const pathScore = bullMins === bearMins ? 0 : bullMins > bearMins ? 1 : -1;
  const score = spotScore + oiScore + pathScore;

  let decision = 'WAIT';
  let bias = 'Sideways';
  let tone = 'flat';
  let emoji = '😢';
  let mood = 'Sad';
  if (score >= 2) {
    decision = 'CALL BUY';
    bias = 'Bullish';
    tone = 'call';
    emoji = '🥳';
    mood = 'Woo';
  } else if (score <= -2) {
    decision = 'PUT BUY';
    bias = 'Bearish';
    tone = 'put';
    emoji = '🥳';
    mood = 'Woo';
  } else if (score === 1) {
    bias = 'Not very bullish';
    tone = 'callSoft';
  } else if (score === -1) {
    bias = 'Not very bearish';
    tone = 'putSoft';
  }

  const parts = [`09:15→${last.time || 'now'} · ${ordered.length}m`];
  if (Number.isFinite(spotChg)) {
    parts.push(`spot ${spotChg > 0 ? '+' : ''}${spotChg.toFixed(1)}`);
  }
  if (Number.isFinite(dayDiff)) {
    parts.push(dayDiff > 0 ? 'Puts lead ΔOI' : dayDiff < 0 ? 'Calls lead ΔOI' : 'ΔOI even');
  }
  parts.push(`${bullMins} Bull / ${bearMins} Bear`);
  const reason = parts.join(' · ');

  return {
    decision,
    tone,
    bias,
    emoji,
    mood,
    dirMark: score > 0 ? '🟢 ↑' : score < 0 ? '🔴 ↓' : '⚪ →',
    reason,
    line: `${emoji} ${mood} · ${bias} · ${reason}`,
    asOf: last.time,
    minutesUsed: ordered.length,
    score,
  };
}

async function getHeaderSignal() {
  const data = await listTodayRows();
  return {
    dateKey: data.dateKey,
    nowTime: data.nowTime,
    lastTime: data.lastTime,
    inSession: data.inSession,
    isTradingDay: data.isTradingDay,
    rowCount: data.rowCount,
    savedStrikes: data.savedStrikes,
    signal: computeHeaderSignal(data.rows, data.displayRow),
  };
}

module.exports = {
  ensureEngineRunning,
  getStatus,
  listTodayRows,
  getHeaderSignal,
  captureMinute,
  SESSION_FROM,
  SESSION_TO,
  LOOKAROUND_STRIKES,
};
