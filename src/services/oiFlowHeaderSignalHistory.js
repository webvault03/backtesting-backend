/**
 * Saves and serves the day's header OI-Flow signal changes (CALL BUY / PUT BUY / WAIT).
 * Events are replayed from the minute rows after each capture; past days with no saved
 * events are replayed once from the day archive.
 */
const OiFlowHeaderSignalEvent = require('../models/oiFlowHeaderSignalEvent');
const OiFlowMinuteRow = require('../models/oiFlowMinuteRow');
const { replayHeaderTimeline } = require('../utils/oiFlowHeaderSignal');
const { getIstClock } = require('../utils/dateTime');

const SYMBOL = 'NIFTY';
const SESSION_TO = 15 * 60 + 30;
const ROW_FIELDS = 'minutes time spotPrice dayCallChgOi dayPutChgOi callsChgOi putsChgOi fetchOk';
const DECISIONS = ['CALL BUY', 'PUT BUY', 'WAIT'];

const inFlight = new Map();

async function saveEvents(dateKey, symbol, events, lastMinutes) {
  if (!events.length) return;
  await OiFlowHeaderSignalEvent.bulkWrite(
    events.map((e) => ({
      updateOne: {
        filter: { symbol, dateKey, minutes: e.minutes },
        update: { $set: { ...e, symbol, dateKey } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  await OiFlowHeaderSignalEvent.deleteMany({
    symbol,
    dateKey,
    minutes: { $nin: events.map((e) => e.minutes), $lte: lastMinutes },
  });
}

async function replayFromMinuteRows(dateKey, symbol) {
  const rows = await OiFlowMinuteRow.find({ symbol, dateKey }).select(ROW_FIELDS).sort({ minutes: 1 }).lean();
  const good = rows.filter((r) => r.fetchOk !== false);
  if (!good.length) return null;
  const events = replayHeaderTimeline(good);
  const lastMinutes = Number(good[good.length - 1].minutes);
  await saveEvents(dateKey, symbol, events, lastMinutes);
  return { events, lastMinutes };
}

/** Replays today's minute rows into saved events; one run per day at a time. */
function recordDay(dateKey, symbol = SYMBOL) {
  const key = `${symbol}:${dateKey}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const p = replayFromMinuteRows(dateKey, symbol).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function replayFromArchive(dateKey, symbol) {
  const archive = require('./oiFlowDayArchiveService');
  const tape = await archive.getDayTapeForTracker(dateKey, { symbol });
  const rows = (tape?.rows || []).filter((r) => r && r.fetchOk !== false);
  if (!rows.length) return null;
  const events = replayHeaderTimeline(rows);
  const lastMinutes = Number(rows[rows.length - 1].minutes);
  await saveEvents(dateKey, symbol, events, lastMinutes);
  return { events, lastMinutes };
}

function summarize(events, endMinutes) {
  const counts = Object.fromEntries(DECISIONS.map((d) => [d, 0]));
  const minutesIn = Object.fromEntries(DECISIONS.map((d) => [d, 0]));
  const list = events.map((e, i) => {
    const next = events[i + 1];
    const until = next ? next.minutes : Math.max(endMinutes, e.minutes);
    const held = Math.max(0, until - e.minutes);
    counts[e.decision] += 1;
    minutesIn[e.decision] += held;
    return { ...e, held, untilTime: next ? next.time : null };
  });
  return { events: list, counts, minutesIn, changes: Math.max(0, events.length - 1) };
}

const toClient = (e) => ({
  minutes: e.minutes,
  time: e.time,
  decision: e.decision,
  tone: e.tone,
  bias: e.bias,
  score: e.score,
  spot: e.spot,
  reason: e.reason,
});

async function getDayHistory(dateKey, symbol = SYMBOL) {
  const clock = getIstClock(new Date());
  const isToday = dateKey === clock.dateKey;

  let replay = await recordDay(dateKey, symbol);
  let saved = await OiFlowHeaderSignalEvent.find({ symbol, dateKey }).sort({ minutes: 1 }).lean();
  if (!saved.length && !replay && !isToday) {
    replay = await replayFromArchive(dateKey, symbol).catch(() => null);
    if (replay) saved = await OiFlowHeaderSignalEvent.find({ symbol, dateKey }).sort({ minutes: 1 }).lean();
  }

  const events = saved.map(toClient);
  const lastMinutes = replay?.lastMinutes ?? (events.length ? events[events.length - 1].minutes : null);
  const live = isToday && clock.minutes <= SESSION_TO;
  const endMinutes = live ? Math.max(lastMinutes ?? 0, Math.min(clock.minutes, SESSION_TO)) : SESSION_TO;

  return { dateKey, symbol, live, ...summarize(events, endMinutes) };
}

module.exports = { recordDay, getDayHistory };
