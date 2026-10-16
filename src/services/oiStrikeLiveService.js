/**
 * OI Strike Report — live, current session day only.
 *
 * Recorder: every few seconds during 09:15–15:30 the nearest weekly NIFTY option chain is read and folded
 *   into a 1-minute bar (NIFTY + CE / PE price OHLC, last OI and previous-day closing OI for ATM ± 12 strikes),
 *   upserted into `oi_strike_live_minutes`. When a new session day starts, older days are deleted
 *   (Friday is kept through Sat / Sun, wiped on Monday — same as the Index Manual OI tape).
 * Late start: if the server comes up after 09:15 with minutes missing, today's earlier minutes are filled
 *   once from Dhan intraday history (only missing minutes; live minutes are never overwritten).
 * Report: today's tape in the same day shape the OI Strike Report sends, so the browser builds the
 *   long / writing / short covering / long unwinding table with the same code.
 */
const OiStrikeLiveMinute = require('../models/oiStrikeLiveMinute');
const {
  getIstClock,
  isWeekendDateKey,
  oiTapeDateKey,
  oiTapeRetainDateKeys,
} = require('../utils/dateTime');
const { isNseCashTradingDay } = require('./nseHolidayService');
const { getNearestWeeklyExpiry, getOptionChainOiSnapshot } = require('./dhanLiveService');

const SYMBOL = 'NIFTY';
const SESSION_FROM = 9 * 60 + 15;
const SESSION_TO = 15 * 60 + 30;
const STEP = 50;
const SPAN = 5;
const LOOKAROUND = 12;
const LOOP_MS = 5000;
const BACKFILL_MIN_GAP = 3;

const state = {
  running: false,
  startedAt: null,
  timer: null,
  inFlight: false,
  dateKey: null,
  expiry: null,
  bar: null,
  lastTickAt: null,
  lastError: null,
  backfill: { dateKey: null, status: 'idle', at: null, inserted: 0, error: null },
};

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function sessionInfo(clock = getIstClock(new Date())) {
  const isTradingDay = !isWeekendDateKey(clock.dateKey) && isNseCashTradingDay(clock.dateKey);
  const tapeDateKey = oiTapeDateKey(clock.dateKey);
  return {
    clock,
    isTradingDay,
    tapeDateKey,
    weekendHold: isWeekendDateKey(clock.dateKey) && tapeDateKey !== clock.dateKey,
    inSession: isTradingDay && clock.minutes >= SESSION_FROM && clock.minutes <= SESSION_TO,
  };
}

async function purgeOtherDays(todayKey) {
  const keep = oiTapeRetainDateKeys(todayKey);
  if (!keep.length) return 0;
  const res = await OiStrikeLiveMinute.deleteMany({ dateKey: { $nin: keep } });
  return res?.deletedCount || 0;
}

function foldPrice(ohlc, px) {
  if (!Number.isFinite(px) || px <= 0) return ohlc;
  if (!ohlc) return { o: px, h: px, l: px, c: px };
  return { o: ohlc.o, h: Math.max(ohlc.h, px), l: Math.min(ohlc.l, px), c: px };
}

const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);

function foldSnapshot(bar, snapshot) {
  bar.nifty = foldPrice(bar.nifty, Number(snapshot.spot));
  for (const row of snapshot.strikes || []) {
    for (const side of ['CE', 'PE']) {
      const key = `${side}${row.strike}`;
      const prev = bar.legs.get(key);
      const ohlc = foldPrice(prev, Number(side === 'CE' ? row.ceLtp : row.peLtp));
      if (!ohlc) continue;
      bar.legs.set(key, {
        strike: row.strike,
        side,
        o: ohlc.o,
        h: ohlc.h,
        l: ohlc.l,
        c: ohlc.c,
        oi: positive(Number(side === 'CE' ? row.callOi : row.putOi)) ?? prev?.oi ?? null,
        prevOi: positive(Number(side === 'CE' ? row.callPrevOi : row.putPrevOi)) ?? prev?.prevOi ?? null,
      });
    }
  }
  bar.ticks += 1;
}

async function saveBar(bar) {
  if (!bar?.nifty) return;
  await OiStrikeLiveMinute.updateOne(
    { symbol: SYMBOL, dateKey: bar.dateKey, minutes: bar.minutes },
    {
      $set: {
        time: hhmm(bar.minutes),
        expiry: bar.expiry,
        nifty: bar.nifty,
        legs: [...bar.legs.values()],
        ticks: bar.ticks,
        source: 'live_chain',
      },
    },
    { upsert: true },
  );
}

/** Fill minutes missing before `beforeMin` from Dhan intraday history (never overwrites live minutes). */
async function backfillToday(dateKey, beforeMin) {
  state.backfill = { dateKey, status: 'running', at: new Date(), inserted: 0, error: null };
  try {
    const { ensureDays } = require('./openOiWallsBacktest/dataSource');
    const live = await ensureDays(dateKey, dateKey);
    const day = live.get(dateKey);
    if (!day) throw new Error('Dhan returned no data for today yet');
    const have = new Set(
      (await OiStrikeLiveMinute.find({ symbol: SYMBOL, dateKey }).select({ minutes: 1 }).lean()).map((d) => d.minutes),
    );
    const legsByMin = new Map();
    for (const side of ['CE', 'PE']) {
      for (const [k, s] of Object.entries(day[side] || {})) {
        s.m.forEach((m, i) => {
          if (!legsByMin.has(m)) legsByMin.set(m, []);
          legsByMin.get(m).push({ strike: Number(k), side, o: s.o[i], h: s.h[i], l: s.l[i], c: s.c[i], oi: s.oi?.[i] ?? null, prevOi: null });
        });
      }
    }
    const ops = [];
    day.nifty.m.forEach((m, i) => {
      if (m < SESSION_FROM || m >= beforeMin || have.has(m)) return;
      ops.push({
        updateOne: {
          filter: { symbol: SYMBOL, dateKey, minutes: m },
          update: {
            $setOnInsert: {
              time: hhmm(m),
              expiry: state.expiry,
              nifty: { o: day.nifty.o[i], h: day.nifty.h[i], l: day.nifty.l[i], c: day.nifty.c[i] },
              legs: legsByMin.get(m) || [],
              ticks: 0,
              source: 'dhan_history',
            },
          },
          upsert: true,
        },
      });
    });
    if (ops.length) await OiStrikeLiveMinute.bulkWrite(ops, { ordered: false });
    state.backfill = { dateKey, status: 'done', at: new Date(), inserted: ops.length, error: null };
  } catch (err) {
    state.backfill = { dateKey, status: 'error', at: new Date(), inserted: 0, error: err.message };
  }
  return state.backfill;
}

async function maybeBackfill(dateKey, minutes) {
  if (state.backfill.dateKey === dateKey && state.backfill.status !== 'idle') return;
  const count = await OiStrikeLiveMinute.countDocuments({ symbol: SYMBOL, dateKey, minutes: { $lt: minutes } });
  if (minutes - SESSION_FROM - count < BACKFILL_MIN_GAP) {
    state.backfill = { dateKey, status: 'not_needed', at: new Date(), inserted: 0, error: null };
    return;
  }
  backfillToday(dateKey, minutes).catch(() => {});
}

async function tick() {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const { clock, inSession } = sessionInfo();
    if (state.dateKey !== clock.dateKey) {
      await purgeOtherDays(clock.dateKey);
      state.dateKey = clock.dateKey;
      state.expiry = null;
      state.bar = null;
    }
    if (!inSession) return;

    if (!state.expiry) state.expiry = await getNearestWeeklyExpiry(SYMBOL);
    const snapshot = await getOptionChainOiSnapshot({ symbol: SYMBOL, expiry: state.expiry, lookaroundStrikes: LOOKAROUND });
    if (!Number.isFinite(Number(snapshot?.spot))) throw new Error('Option chain has no NIFTY price');

    const now = getIstClock(new Date());
    if (now.minutes > SESSION_TO) return;
    if (!state.bar || state.bar.minutes !== now.minutes || state.bar.dateKey !== now.dateKey) {
      state.bar = { dateKey: now.dateKey, minutes: now.minutes, expiry: state.expiry, nifty: null, legs: new Map(), ticks: 0 };
    }
    foldSnapshot(state.bar, snapshot);
    await saveBar(state.bar);
    state.lastTickAt = new Date();
    state.lastError = null;
    await maybeBackfill(now.dateKey, now.minutes);
  } catch (err) {
    state.lastError = err.message;
  } finally {
    state.inFlight = false;
  }
}

function ensureEngineRunning() {
  if (state.running && state.timer) return { ok: true, already: true };
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.timer = setInterval(() => {
    tick().catch((err) => {
      state.lastError = err.message;
    });
  }, LOOP_MS);
  tick().catch((err) => {
    state.lastError = err.message;
  });
  return { ok: true, started: true };
}

/** One leg in the report's shape: { prevOi, open, m, c, oi } (minutes with both OI and price). */
function legOf(docs, side, strike) {
  const out = { prevOi: null, open: null, m: [], c: [], oi: [] };
  for (const d of docs) {
    const leg = (d.legs || []).find((l) => l.side === side && l.strike === strike);
    if (!leg) continue;
    if (out.prevOi == null && Number.isFinite(leg.prevOi)) out.prevOi = leg.prevOi;
    if (out.open == null && Number.isFinite(leg.o)) out.open = leg.o;
    if (!Number.isFinite(leg.oi) || !Number.isFinite(leg.c)) continue;
    out.m.push(d.minutes);
    out.c.push(leg.c);
    out.oi.push(leg.oi);
  }
  return out.m.length && out.open != null ? out : null;
}

/** Today's tape → one OI Strike Report day (ATM from the 09:15 open ± 5 strikes). */
function reportDay(dateKey, docs) {
  const withSpot = docs.filter((d) => Number.isFinite(d.nifty?.o));
  if (!withSpot.length) return null;
  const first = withSpot[0];
  const open = first.nifty.o;
  const atm = Math.round(open / STEP) * STEP;
  const strikes = [];
  for (let off = -SPAN; off <= SPAN; off += 1) {
    const strike = atm + off * STEP;
    strikes.push({ strike, offset: off, CE: legOf(docs, 'CE', strike), PE: legOf(docs, 'PE', strike) });
  }
  return {
    id: dateKey,
    date: dateKey,
    niftyOpen: r2(open),
    openTime: first.time,
    nifty: { m: withSpot.map((d) => d.minutes), c: withSpot.map((d) => d.nifty.c) },
    atm,
    strikes,
  };
}

async function getLiveReport() {
  const { clock, isTradingDay, tapeDateKey, weekendHold, inSession } = sessionInfo();
  const docs = await OiStrikeLiveMinute.find({ symbol: SYMBOL, dateKey: tapeDateKey }).sort({ minutes: 1 }).lean();
  const lastDoc = docs[docs.length - 1] || null;
  return {
    ok: true,
    symbol: SYMBOL,
    dateKey: tapeDateKey,
    calendarDateKey: clock.dateKey,
    nowTime: hhmm(clock.minutes),
    isTradingDay,
    inSession,
    weekendHold,
    sessionFrom: hhmm(SESSION_FROM),
    sessionTo: hhmm(SESSION_TO),
    span: SPAN,
    step: STEP,
    tape: {
      collection: 'oi_strike_live_minutes',
      rows: docs.length,
      expectedRows: SESSION_TO - SESSION_FROM + 1,
      firstTime: docs[0]?.time || null,
      lastTime: lastDoc?.time || null,
      lastNifty: lastDoc?.nifty?.c ?? null,
      expiry: lastDoc?.expiry || state.expiry || null,
      backfilledRows: docs.filter((d) => d.source === 'dhan_history').length,
    },
    engine: {
      running: state.running,
      startedAt: state.startedAt,
      lastTickAt: state.lastTickAt,
      lastError: state.lastError,
      backfill: state.backfill,
    },
    day: reportDay(tapeDateKey, docs),
  };
}

async function requestBackfill() {
  const { clock, isTradingDay } = sessionInfo();
  if (!isTradingDay || clock.minutes <= SESSION_FROM) throw new Error('Filling only runs on a trading day after 09:15');
  return backfillToday(clock.dateKey, Math.min(clock.minutes, SESSION_TO + 1));
}

/** Today's tape as a report-shaped day (for paper-live signal engines). */
async function loadTodayDay(dateKey) {
  const key = dateKey || sessionInfo().tapeDateKey;
  const docs = await OiStrikeLiveMinute.find({ symbol: SYMBOL, dateKey: key }).sort({ minutes: 1 }).lean();
  return { dateKey: key, docs, day: reportDay(key, docs), rowCount: docs.length };
}

module.exports = {
  ensureEngineRunning,
  getLiveReport,
  requestBackfill,
  purgeOtherDays,
  loadTodayDay,
};
