/**
 * Flow Scalp Prime — paper live.
 * Live / forming OI Flow Bias (Bull→CE / Bear→PE) + green strike candle ·
 * +2/−3 · 09:30–14:30 · optional day ₹ target (default off) · 15m after SL · 1 open · EOD 15:15.
 */
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { FLOW_SCALP_PRIME_LIVE_KEY } = require('../strategies/keys');
const { buildSignalFromOiFlow } = require('../strategies/flowScalpPrime/signals');
const { getIstClock, isWeekendDateKey } = require('../utils/dateTime');
const { applyEntryDateFilter } = require('../utils/tradeHistoryDateFilter');
const { round } = require('../utils/oiFlowPlaybook');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  fetchInstrumentLtp,
  getFutureLtp,
} = require('./dhanLiveService');

const STRATEGY_KEY = FLOW_SCALP_PRIME_LIVE_KEY;
const WALLET_KEY = 'paper_live_flow_scalp_prime';
const STRATEGY_ID = 'flow-scalp-prime';

const LOOP_MS = 5000;
const MIN_HOLD_MS = 15000;
/** After a STOP_LOSS, block new entries for this long. */
const SL_COOLDOWN_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  symbol: 'NIFTY',
  lotCount: 10,
  tradeFromTime: '09:30',
  tradeToTime: '14:30',
  eodExitTime: '15:15',
  /** Fixed option-premium stop / target (pts from entry LTP). */
  optionSlPts: 3,
  optionTpPts: 2,
  perTradeCost: 100,
  /**
   * Day profit lock in ₹ at 10 lots. Scales: target₹ = this × (lotCount / 10).
   * When today's realized ₹ ≥ scaled target → no new entries until next IST day.
   */
  dailyTargetInrAt10Lots: 0,
};

const engineState = {
  running: false,
  startedAt: null,
  settings: { ...DEFAULT_SETTINGS },
  loopTimer: null,
  tickInFlight: false,
  openTradeId: null,
  lastExitAtMs: 0,
  /** Timestamp of last STOP_LOSS exit — used for 15m no-entry cooldown. */
  lastStopLossAtMs: 0,
  entryArmed: true,
  lastEntryKey: null,
  lastEntryBarMinutes: null,
  lastSignal: null,
  lastTapeAt: null,
  lastError: null,
  lastEntryDebug: null,
  closingTrade: false,
  enteringTrade: false,
  lotSize: null,
  expiry: null,
  dayPtsDateKey: null,
  dayPts: 0,
  dayPnlInr: 0,
  dayLocked: false,
  dayStopReason: null,
  dayTargetInr: 0,
  /** Minute opens for strike option candles: key = `${CE|PE}:${strike}` */
  optionMinuteOpens: {},
};

function parseHhmmToMinutes(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function inWindow(clockMinutes, fromStr, toStr) {
  const from = parseHhmmToMinutes(fromStr);
  const to = parseHhmmToMinutes(toStr);
  if (from == null || to == null) return true;
  return clockMinutes >= from && clockMinutes <= to;
}

function isEod(clockMinutes, eodStr) {
  const eod = parseHhmmToMinutes(eodStr);
  return eod != null && clockMinutes >= eod;
}

/**
 * Track forming 1m option open from live LTP; green = ltp >= minute open.
 */
function updateStrikeCandle(optionType, strike, ltp, clockMinutes) {
  const ot = String(optionType || '').toUpperCase();
  const s = Number(strike);
  const px = Number(ltp);
  if (!ot || !Number.isFinite(s) || !Number.isFinite(px) || px <= 0 || !Number.isFinite(clockMinutes)) {
    return { strikeCandleOk: false, minuteOpen: null, ltp: null, note: 'No option LTP for candle' };
  }
  const key = `${ot}:${s}`;
  let slot = engineState.optionMinuteOpens[key];
  if (!slot || slot.minute !== clockMinutes) {
    slot = { minute: clockMinutes, open: px, lastLtp: px };
    engineState.optionMinuteOpens[key] = slot;
  } else {
    slot.lastLtp = px;
  }
  const ok = px >= Number(slot.open);
  return {
    strikeCandleOk: ok,
    minuteOpen: Number(slot.open),
    ltp: px,
    note: ok
      ? `Green 1m · LTP ${px.toFixed(2)} ≥ open ${Number(slot.open).toFixed(2)}`
      : `Red 1m · LTP ${px.toFixed(2)} < open ${Number(slot.open).toFixed(2)}`,
  };
}

async function probeStrikeCandle(symbol, strike, optionType, expiry, clockMinutes) {
  try {
    const inst = await resolveOptionInstrument({
      symbol,
      strike,
      expiry,
      optionType: optionType === 'PE' ? 'PE' : 'CE',
    });
    if (!inst) {
      return { strikeCandleOk: false, minuteOpen: null, ltp: null, note: 'Option instrument missing' };
    }
    const live = await fetchInstrumentLtp(inst, { maxWaitMs: 1500, forceFresh: true });
    if (!Number.isFinite(live) || live <= 0) {
      return { strikeCandleOk: false, minuteOpen: null, ltp: null, note: 'No live option LTP' };
    }
    return updateStrikeCandle(optionType, strike, live, clockMinutes);
  } catch (err) {
    return { strikeCandleOk: false, minuteOpen: null, ltp: null, note: err.message };
  }
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 0,
      balance: 0,
      realizedPnl: 0,
      cashLedger: false,
      flowScalpPrimeEngineSettings: { ...DEFAULT_SETTINGS },
    });
  }
  return wallet;
}

function normalizeSettings(raw = {}) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.enabled = Boolean(s.enabled);
  s.symbol = String(s.symbol || 'NIFTY').toUpperCase();
  s.lotCount = Math.max(1, Math.min(50, Math.floor(Number(s.lotCount) || 10)));
  s.optionSlPts = Math.max(1, Number(s.optionSlPts) || 3);
  s.optionTpPts = Math.max(1, Number(s.optionTpPts) || 2);
  s.perTradeCost = Number.isFinite(Number(s.perTradeCost)) && Number(s.perTradeCost) >= 0 ? Number(s.perTradeCost) : 100;
  {
    const n = Number(s.dailyTargetInrAt10Lots);
    s.dailyTargetInrAt10Lots =
      Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.dailyTargetInrAt10Lots;
  }
  s.tradeFromTime = String(s.tradeFromTime || '09:30');
  s.tradeToTime = String(s.tradeToTime || '14:30');
  s.eodExitTime = String(s.eodExitTime || '15:15');
  // Live Bias mode — drop legacy option-pts day-lock fields
  delete s.stepMin;
  delete s.callMinSpotDelta;
  delete s.dailyTarget;
  delete s.dailyLoss;
  delete s.riskMin;
  delete s.riskMax;
  delete s.slBufferPts;
  delete s.rMult;
  delete s.tpCap;
  delete s.maxHoldMin;
  return s;
}

/** ₹ day target for current lotCount (base is at 10 lots). */
function scaledDailyTargetInr(settings = engineState.settings) {
  const raw = Number(settings.dailyTargetInrAt10Lots);
  const base = Number.isFinite(raw) && raw >= 0 ? raw : 0;
  const lots = Math.max(1, Number(settings.lotCount) || 10);
  return Number(((base * lots) / 10).toFixed(2));
}

async function loadSettingsFromDb() {
  const wallet = await ensureWallet();
  engineState.settings = normalizeSettings(wallet.flowScalpPrimeEngineSettings || {});
  return engineState.settings;
}

async function saveSettingsToDb(partial = {}) {
  const wallet = await ensureWallet();
  const next = normalizeSettings({
    ...(wallet.flowScalpPrimeEngineSettings?.toObject?.() || wallet.flowScalpPrimeEngineSettings || {}),
    ...partial,
  });
  wallet.flowScalpPrimeEngineSettings = next;
  await wallet.save();
  engineState.settings = next;
  return next;
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
    isTesting: { $ne: true },
  }).lean();
  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  for (const t of rows) {
    const p = Number(t.pnl) || 0;
    realizedPnl += p;
    if (p > 0) wins += 1;
    else if (p < 0) losses += 1;
  }
  wallet.realizedPnl = Number(realizedPnl.toFixed(2));
  wallet.balance = wallet.realizedPnl;
  wallet.totalTrades = rows.length;
  wallet.wins = wins;
  wallet.losses = losses;
  await wallet.save();
  return wallet;
}

async function syncOpenTradeId() {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();
  engineState.openTradeId = open ? String(open._id) : null;
  return open || null;
}

function favorPtsFromTrade(trade) {
  const snap = trade?.signalSnapshot || {};
  if (Number.isFinite(Number(snap.favorPts))) return Number(snap.favorPts);
  const entryPrem = Number(trade.entryPremium);
  const exitPrem = Number(trade.exitPremium);
  if (Number.isFinite(entryPrem) && Number.isFinite(exitPrem)) {
    return round(exitPrem - entryPrem);
  }
  return 0;
}

/** Day book: option pts (display) + realized ₹ · lock when ₹ target hit. */
async function refreshDayBook(dateKey) {
  if (engineState.dayPtsDateKey !== dateKey) {
    engineState.dayPtsDateKey = dateKey;
    engineState.dayPts = 0;
    engineState.dayPnlInr = 0;
    engineState.dayLocked = false;
    engineState.dayStopReason = null;
    engineState.lastEntryBarMinutes = null;
    engineState.optionMinuteOpens = {};
  }

  const closed = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: dateKey,
    status: 'CLOSED',
    exitTime: { $ne: null },
    isTesting: { $ne: true },
  })
    .sort({ entryTime: 1 })
    .lean();

  let dayPts = 0;
  let dayPnlInr = 0;
  let lastBar = null;

  for (const t of closed) {
    const snap = t.signalSnapshot || {};
    if (Number.isFinite(Number(snap.barMinutes))) lastBar = Number(snap.barMinutes);
    let pts = favorPtsFromTrade(t);
    const reason = String(t.reason || '').toUpperCase();
    const risk = Number(snap.riskPts);
    const reward = Number(snap.rewardPts);
    if (reason === 'STOP_LOSS' && Number.isFinite(risk)) pts = -Math.abs(risk);
    if (reason === 'TARGET' && Number.isFinite(reward)) pts = Math.abs(reward);
    dayPts = round(dayPts + pts);
    const pnl = Number(t.pnl);
    if (Number.isFinite(pnl)) dayPnlInr += pnl;
  }

  dayPnlInr = Number(dayPnlInr.toFixed(2));
  const dayTargetInr = scaledDailyTargetInr();
  let dayLocked = false;
  let dayStopReason = null;
  if (dayTargetInr > 0 && dayPnlInr >= dayTargetInr) {
    dayLocked = true;
    dayStopReason = `Day target ₹${dayTargetInr} hit (₹${dayPnlInr})`;
  }

  engineState.dayPts = dayPts;
  engineState.dayPnlInr = dayPnlInr;
  engineState.dayLocked = dayLocked;
  engineState.dayStopReason = dayStopReason;
  engineState.dayTargetInr = dayTargetInr;
  engineState.lastEntryBarMinutes = lastBar;
  return {
    dayPts,
    dayPnlInr,
    dayTargetInr,
    dayLocked,
    dayStopReason,
    lastEntryBarMinutes: lastBar,
  };
}

async function resolveOptionLtp(trade) {
  const optionType = String(trade.optionType).toUpperCase() === 'PE' ? 'PE' : 'CE';
  let futSpot = null;
  try {
    const fut = await getFutureLtp({
      symbol: trade.symbol,
      expiry: trade.expiryDate,
      maxWaitMs: 1200,
    });
    if (Number.isFinite(fut?.ltp) && fut.ltp > 0) futSpot = fut.ltp;
  } catch {
    /* optional */
  }
  try {
    const inst = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType,
    });
    if (inst) {
      const ltp = await fetchInstrumentLtp(inst, { maxWaitMs: 2000, forceFresh: true });
      if (Number.isFinite(ltp) && ltp > 0) {
        return { optionLtp: ltp, spot: futSpot, source: 'marketfeed' };
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const prem = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    const ltp = optionType === 'PE' ? Number(prem.peLtp) : Number(prem.ceLtp);
    const spot =
      Number.isFinite(futSpot) && futSpot > 0
        ? futSpot
        : Number(prem.spot) > 0
          ? Number(prem.spot)
          : Number(prem.chainSpot);
    if (Number.isFinite(ltp) && ltp > 0) {
      return {
        optionLtp: ltp,
        spot: Number.isFinite(spot) && spot > 0 ? spot : null,
        source: 'chain',
      };
    }
  } catch {
    /* fall through */
  }
  return { optionLtp: null, spot: futSpot, source: 'none' };
}

function pickExitSpot(mark, trade, futFallback = null) {
  for (const raw of [mark?.spot, futFallback, trade?.entrySpot, trade?.openPositionMark?.spot]) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Number(n.toFixed(2));
  }
  return null;
}

async function finalizeTrade(trade, { exitPremium, mark, reason, futFallback = null, favorPts = null }) {
  if (engineState.closingTrade) return null;
  engineState.closingTrade = true;
  try {
    let resolved = mark;
    if (!Number.isFinite(mark?.optionLtp) || mark?.optionLtp <= 0) {
      resolved = await resolveOptionLtp(trade);
    }
    const safeExit = Math.max(
      0.05,
      Number(exitPremium) || Number(resolved?.optionLtp) || Number(trade.entryPremium) || 0.05,
    );
    const qty = Number(trade.qty) || 0;
    const invested = (Number(trade.entryPremium) || 0) * qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const finalValue = safeExit * qty;
    const pnl = finalValue - invested - charges;
    const clock = getIstClock(new Date());
    const exitSpot = pickExitSpot(resolved, trade, futFallback);

    const snap = { ...(trade.signalSnapshot || {}) };
    let pts = favorPts;
    if (!Number.isFinite(pts)) {
      const entryPrem = Number(trade.entryPremium);
      if (Number.isFinite(entryPrem) && Number.isFinite(safeExit)) {
        pts = round(safeExit - entryPrem);
      }
    }
    const r = String(reason || '').toUpperCase();
    if (r === 'STOP_LOSS' && Number.isFinite(Number(snap.riskPts))) pts = -Math.abs(Number(snap.riskPts));
    if (r === 'TARGET' && Number.isFinite(Number(snap.rewardPts))) pts = Math.abs(Number(snap.rewardPts));
    snap.favorPts = Number.isFinite(pts) ? round(pts) : 0;
    snap.exitReason = reason;

    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExit.toFixed(2));
    trade.exitSpot = exitSpot != null ? exitSpot : Number(trade.entrySpot) || undefined;
    if (!(Number(trade.exitSpot) > 0)) trade.exitSpot = undefined;
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    const investedAmount = Number(trade.investedAmount) || invested;
    trade.pnlPct = investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    trade.signalSnapshot = snap;
    trade.notes = [trade.notes, `exitMark=${resolved?.source || 'n/a'}; favorPts=${snap.favorPts}; pnl=${trade.pnl}`]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
    await trade.save();

    await recalcWalletFromTrades();
    await refreshDayBook(clock.dateKey);
    engineState.openTradeId = null;
    engineState.lastExitAtMs = Date.now();
    if (String(reason || '').toUpperCase() === 'STOP_LOSS') {
      engineState.lastStopLossAtMs = Date.now();
    }
    // Re-arm; tryEnter still respects SL 15m cooldown when lastStopLossAtMs is set
    engineState.entryArmed = true;
    return trade;
  } finally {
    engineState.closingTrade = false;
  }
}

async function checkOpenTrade(signal, tape) {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).sort({ entryTime: -1 });
  if (!open) {
    engineState.openTradeId = null;
    return;
  }
  engineState.openTradeId = String(open._id);

  const clock = getIstClock(new Date());
  const mark = await resolveOptionLtp(open);
  const spotFallback = Number(
    mark.spot
    || signal?.spot
    || tape?.displayRow?.spotPrice
    || open.entrySpot,
  );
  const spotNow = Number.isFinite(spotFallback) ? spotFallback : null;

  if (Number.isFinite(mark.optionLtp) && mark.optionLtp > 0) {
    const entryPrem = Number(open.entryPremium);
    const favor =
      Number.isFinite(entryPrem)
        ? round(Number(mark.optionLtp) - entryPrem)
        : null;
    open.openPositionMark = {
      optionLtp: Number(mark.optionLtp.toFixed(2)),
      spot: Number.isFinite(spotNow) && spotNow > 0 ? spotNow : null,
      favorPts: Number.isFinite(favor) ? favor : null,
      source: mark.source,
      at: new Date().toISOString(),
    };
    open.openPositionMarkAt = new Date();
    await open.save();
  }

  if (isEod(clock.minutes, engineState.settings.eodExitTime)) {
    await finalizeTrade(open, {
      exitPremium: mark.optionLtp,
      mark,
      reason: 'DAY_CLOSE',
      futFallback: spotNow,
    });
    return;
  }

  const heldMs = Date.now() - new Date(open.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const snap = open.signalSnapshot || {};
  const entryPrem = Number(open.entryPremium);
  const ltp = Number(mark.optionLtp);
  const slPts = Math.max(
    1,
    Number(snap.riskPts) || Number(engineState.settings.optionSlPts) || 3,
  );
  const tpPts = Math.max(
    1,
    Number(snap.rewardPts) || Number(engineState.settings.optionTpPts) || 2,
  );
  const stopPrem = Number.isFinite(Number(open.stopLossPremium))
    ? Number(open.stopLossPremium)
    : Number.isFinite(entryPrem)
      ? entryPrem - slPts
      : null;
  const targetPrem = Number.isFinite(Number(open.targetPremium))
    ? Number(open.targetPremium)
    : Number.isFinite(entryPrem)
      ? entryPrem + tpPts
      : null;

  if (Number.isFinite(ltp) && ltp > 0 && Number.isFinite(entryPrem)) {
    if (Number.isFinite(stopPrem) && ltp <= stopPrem) {
      await finalizeTrade(open, {
        exitPremium: ltp,
        mark,
        reason: 'STOP_LOSS',
        futFallback: spotNow,
        favorPts: -slPts,
      });
      return;
    }
    if (Number.isFinite(targetPrem) && ltp >= targetPrem) {
      await finalizeTrade(open, {
        exitPremium: ltp,
        mark,
        reason: 'TARGET',
        futFallback: spotNow,
        favorPts: tpPts,
      });
    }
  }
}

async function tryEnter(signal, tape) {
  if (!engineState.settings.enabled) {
    engineState.lastEntryDebug = { skip: 'disabled' };
    return;
  }
  if (engineState.openTradeId || engineState.enteringTrade || engineState.closingTrade) {
    engineState.lastEntryDebug = {
      skip: engineState.openTradeId
        ? 'already_open'
        : engineState.enteringTrade
          ? 'entering_in_flight'
          : 'closing_in_flight',
      openTradeId: engineState.openTradeId || null,
    };
    return;
  }
  if (signal?.status !== 'TAKE_ENTRY' || !signal.optionType) {
    engineState.lastEntryDebug = {
      skip: 'not_take_entry',
      status: signal?.status || null,
      optionType: signal?.optionType || null,
    };
    if (signal?.status && signal.status !== 'TAKE_ENTRY') {
      engineState.entryArmed = true;
    }
    return;
  }
  if (signal.strikeCandleOk === false) {
    engineState.lastEntryDebug = {
      skip: 'strike_candle',
      note: signal.strikeCandleNote,
    };
    return;
  }
  if (!signal.buyLive) {
    engineState.lastEntryDebug = {
      skip: 'buyLive_false',
      detail: signal.detail || null,
      strikeCandleOk: signal.strikeCandleOk,
      entryBlocked: signal.entryBlocked,
    };
    return;
  }
  if (!engineState.entryArmed) {
    engineState.lastEntryDebug = { skip: 'entry_not_armed' };
    return;
  }

  const clock = getIstClock(new Date());
  const dayBook = await refreshDayBook(clock.dateKey);
  if (dayBook.dayLocked) {
    engineState.lastEntryDebug = {
      skip: 'day_target',
      dayPnlInr: dayBook.dayPnlInr,
      dayTargetInr: dayBook.dayTargetInr,
      reason: dayBook.dayStopReason,
    };
    return;
  }

  if (engineState.lastStopLossAtMs > 0) {
    const sinceSlMs = Date.now() - engineState.lastStopLossAtMs;
    if (sinceSlMs < SL_COOLDOWN_MS) {
      const remainSec = Math.ceil((SL_COOLDOWN_MS - sinceSlMs) / 1000);
      engineState.lastEntryDebug = {
        skip: 'sl_cooldown',
        remainSec,
        needSec: Math.floor(SL_COOLDOWN_MS / 1000),
      };
      return;
    }
  }

  if (isWeekendDateKey(clock.dateKey)) {
    engineState.lastEntryDebug = { skip: 'weekend', dateKey: clock.dateKey };
    return;
  }
  if (!inWindow(clock.minutes, engineState.settings.tradeFromTime, engineState.settings.tradeToTime)) {
    engineState.lastEntryDebug = {
      skip: 'outside_window',
      minutes: clock.minutes,
      from: engineState.settings.tradeFromTime,
      to: engineState.settings.tradeToTime,
    };
    return;
  }
  if (isEod(clock.minutes, engineState.settings.eodExitTime)) {
    engineState.lastEntryDebug = {
      skip: 'eod',
      minutes: clock.minutes,
      eod: engineState.settings.eodExitTime,
    };
    return;
  }

  const existing = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).lean();
  if (existing) {
    engineState.openTradeId = String(existing._id);
    engineState.lastEntryDebug = {
      skip: 'already_open_db',
      openTradeId: engineState.openTradeId,
    };
    return;
  }

  engineState.enteringTrade = true;
  try {
    const symbol = engineState.settings.symbol || 'NIFTY';
    const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
    const strike = Number(signal.entryStrike || tape?.displayRow?.atm || signal.atm);
    const expiry = String(
      tape?.displayRow?.expiry || tape?.expiry || engineState.expiry || (await getNearestWeeklyExpiry(symbol)) || '',
    ).slice(0, 10);
    if (!Number.isFinite(strike) || !expiry) {
      engineState.lastEntryDebug = { skip: 'missing_strike_or_expiry', strike, expiry };
      return;
    }

    // Prefer fresh marketfeed LTP; fall back to chain / probe so fills don't silently stall
    let entryPremium = null;
    let entrySource = 'none';
    try {
      const inst = await resolveOptionInstrument({ symbol, strike, expiry, optionType });
      if (inst) {
        const live = await fetchInstrumentLtp(inst, { maxWaitMs: 2000, forceFresh: true });
        if (Number.isFinite(live) && live > 0) {
          entryPremium = live;
          entrySource = 'marketfeed';
        }
      }
    } catch {
      /* fall through */
    }
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      try {
        const prem = await getAtmPremiums({ symbol, strike, expiry });
        const chainLtp = optionType === 'PE' ? Number(prem.peLtp) : Number(prem.ceLtp);
        if (Number.isFinite(chainLtp) && chainLtp > 0) {
          entryPremium = chainLtp;
          entrySource = 'chain';
        }
      } catch {
        /* fall through */
      }
    }
    if ((!Number.isFinite(entryPremium) || entryPremium <= 0) && Number(signal.strikeLtp) > 0) {
      entryPremium = Number(signal.strikeLtp);
      entrySource = 'probe';
    }
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastEntryDebug = {
        skip: 'no_live_premium',
        strike,
        optionType,
        expiry,
        hint: 'Skipped — need live option LTP (marketfeed/chain/probe all empty)',
      };
      return;
    }

    const entryKey = `${clock.dateKey}:${optionType}:${strike}:${Math.round(entryPremium * 10)}`;
    const sinceExitMs = engineState.lastExitAtMs > 0 ? Date.now() - engineState.lastExitAtMs : Infinity;
    if (engineState.lastEntryKey === entryKey && sinceExitMs < 2000) {
      engineState.lastEntryDebug = { skip: 'duplicate_entry_key', entryKey };
      return;
    }

    // Candle already passed on this tick. Keep tracking open; do not re-block on fill noise.
    const candle = updateStrikeCandle(optionType, strike, entryPremium, clock.minutes);
    if (!candle.strikeCandleOk && signal.strikeCandleOk !== true) {
      engineState.lastEntryDebug = {
        skip: 'strike_candle_at_fill',
        note: candle.note,
        minuteOpen: candle.minuteOpen,
        ltp: candle.ltp,
      };
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    engineState.expiry = expiry;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 10);
    const qty = lotSize * lots;
    const charges = Math.max(0, Number(engineState.settings.perTradeCost) || 0);
    const entrySpot = Number(signal.entrySpot || signal.spot || tape?.displayRow?.spotPrice);
    const slPts = Math.max(1, Number(signal.riskPts) || Number(engineState.settings.optionSlPts) || 3);
    const tpPts = Math.max(1, Number(signal.rewardPts) || Number(engineState.settings.optionTpPts) || 2);
    const stopLossPremium = Number((entryPremium - slPts).toFixed(2));
    const targetPremium = Number((entryPremium + tpPts).toFixed(2));

    const tradeDoc = await LivePaperTrade.create({
      strategyKey: STRATEGY_KEY,
      symbol,
      side: 'LONG',
      optionType,
      product: 'OPTION',
      strike,
      expiryDate: expiry,
      lotSize,
      lots,
      qty,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySpot: Number.isFinite(entrySpot) && entrySpot > 0 ? Number(entrySpot.toFixed(2)) : undefined,
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number((entryPremium * qty).toFixed(2)),
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium,
      targetPremium,
      stopLossMode: 'POINTS',
      targetMode: 'POINTS',
      combinedStopSpot: null,
      targetSpot: null,
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason: `Flow Scalp · Bias ${signal.flowBias || ''} → ${optionType} · ${signal.flowTime || signal.barTime || ''}`,
      notes: `flow_scalp_prime; bias=${signal.flowBias}; pattern=${signal.patternId}; optionSL=${slPts}; optionTP=${tpPts}; entrySrc=${entrySource}; candle=${candle.note}`,
      signalSnapshot: {
        patternId: signal.patternId,
        patternName: signal.patternName,
        flowBias: signal.flowBias,
        chngInDir: signal.chngInDir,
        barTime: signal.barTime || signal.flowTime,
        barMinutes: signal.barMinutes,
        entryMinutes: signal.barMinutes,
        riskPts: slPts,
        rewardPts: tpPts,
        optionSlPts: slPts,
        optionTpPts: tpPts,
        stopLossPremium,
        targetPremium,
        strikeCandleOk: true,
        strikeCandleNote: candle.note,
      },
    });

    engineState.openTradeId = String(tradeDoc._id);
    engineState.entryArmed = true;
    engineState.lastEntryKey = entryKey;
    engineState.lastEntryBarMinutes = Number(signal.barMinutes);
    engineState.lastEntryDebug = {
      at: new Date().toISOString(),
      entered: true,
      tradeId: engineState.openTradeId,
      optionType,
      strike,
      entryPremium,
      entrySource,
      targetPremium,
      stopLossPremium,
      strikeCandle: candle,
      signalStatus: signal.status,
    };
  } catch (err) {
    engineState.lastError = err.message;
    engineState.lastEntryDebug = { skip: 'entry_error', error: err.message };
  } finally {
    engineState.enteringTrade = false;
  }
}

async function fetchTape() {
  const oiFlow = require('./oiFlowMinuteEngine');
  return oiFlow.listTodayRows();
}

async function tickOnce() {
  if (engineState.tickInFlight) return;
  engineState.tickInFlight = true;
  try {
    await loadSettingsFromDb();
    const clock = getIstClock(new Date());
    if (!engineState.settings.enabled) {
      await saveSettingsToDb({ enabled: true });
    }

    const dayBook = await refreshDayBook(clock.dateKey);
    const tape = await fetchTape();
    engineState.lastTapeAt = tape?.displayRow?.fetchedAt || new Date().toISOString();
    const signal = buildSignalFromOiFlow(tape, engineState.settings, {
      dayLocked: dayBook.dayLocked,
      dayPts: dayBook.dayPts,
      dayStopReason: dayBook.dayStopReason,
      lastEntryBarMinutes: dayBook.lastEntryBarMinutes,
    });

    if (dayBook.dayLocked) {
      signal.status = 'DONE';
      signal.buyLive = false;
      signal.entryBlocked = true;
      signal.headline = 'Day target done';
      signal.detail = dayBook.dayStopReason || 'Day ₹ target hit — no more entries';
      signal.why = `Today ₹${dayBook.dayPnlInr} ≥ target ₹${dayBook.dayTargetInr} · wait until next session`;
    }

    // Green strike candle filter (soft-fail: keep TAKE_ENTRY visible, clear buyLive)
    let candle = {
      strikeCandleOk: false,
      minuteOpen: null,
      ltp: null,
      note: 'Candle not checked',
    };
    if (
      !dayBook.dayLocked
      && signal?.optionType
      && (signal.status === 'TAKE_ENTRY' || signal.status === 'NEAR')
    ) {
      const optionType = signal.optionType === 'PE' ? 'PE' : 'CE';
      const strike = Number(signal.entryStrike || tape?.displayRow?.atm || signal.atm);
      let expiry = String(
        tape?.displayRow?.expiry || tape?.expiry || engineState.expiry || '',
      ).slice(0, 10);
      if (!expiry) {
        try {
          expiry = String(await getNearestWeeklyExpiry(engineState.settings.symbol || 'NIFTY') || '').slice(0, 10);
        } catch {
          /* ignore */
        }
      }
      if (Number.isFinite(strike) && expiry) {
        candle = await probeStrikeCandle(
          engineState.settings.symbol || 'NIFTY',
          strike,
          optionType,
          expiry,
          clock.minutes,
        );
      } else if (!expiry) {
        candle = {
          strikeCandleOk: false,
          minuteOpen: null,
          ltp: null,
          note: 'Expiry missing — cannot check strike candle',
        };
      }
    }
    signal.strikeCandleOk = candle.strikeCandleOk;
    signal.strikeCandleNote = candle.note;
    signal.strikeMinuteOpen = candle.minuteOpen;
    signal.strikeLtp = candle.ltp;

    if (signal.status === 'TAKE_ENTRY' && signal.buyLive) {
      if (!signal.strikeCandleOk) {
        signal.buyLive = false;
        signal.detail = `${signal.detail || 'TAKE_ENTRY'} · blocked: ${signal.strikeCandleNote || 'candle'}`;
        signal.entryBlocked = true;
        signal.blockers = [signal.strikeCandleNote || 'candle'];
      }
    }

    if (signal?.status && signal.status !== 'TAKE_ENTRY') {
      engineState.entryArmed = true;
    }

    engineState.lastSignal = {
      ...signal,
      at: engineState.lastTapeAt,
      enabled: engineState.settings.enabled,
      entryArmed: engineState.entryArmed,
      dayPts: dayBook.dayPts,
      dayPnlInr: dayBook.dayPnlInr,
      dayTargetInr: dayBook.dayTargetInr,
      dayLocked: dayBook.dayLocked,
      dayStopReason: dayBook.dayStopReason,
    };

    await checkOpenTrade(signal, tape);
    // Immediate re-entry allowed after exit (including same tick) unless day-locked / SL cooldown.
    if (!engineState.openTradeId && !dayBook.dayLocked) {
      await tryEnter(signal, tape);
    }
    engineState.lastError = null;
  } catch (err) {
    engineState.lastError = err.message;
  } finally {
    engineState.tickInFlight = false;
  }
}

function startLoop() {
  if (engineState.loopTimer) return;
  engineState.loopTimer = setInterval(() => {
    tickOnce().catch((err) => {
      engineState.lastError = err.message;
    });
  }, LOOP_MS);
}

async function hydrateLastStopLossCooldown() {
  const lastSl = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'CLOSED',
    reason: 'STOP_LOSS',
    exitTime: { $ne: null },
  })
    .sort({ exitTime: -1 })
    .select({ exitTime: 1 })
    .lean();
  if (!lastSl?.exitTime) {
    engineState.lastStopLossAtMs = 0;
    return;
  }
  const ms = new Date(lastSl.exitTime).getTime();
  if (!Number.isFinite(ms)) {
    engineState.lastStopLossAtMs = 0;
    return;
  }
  // Only keep cooldown if still inside the 15m window
  if (Date.now() - ms < SL_COOLDOWN_MS) {
    engineState.lastStopLossAtMs = ms;
  } else {
    engineState.lastStopLossAtMs = 0;
  }
}

async function ensureEngineRunning() {
  if (!engineState.running) {
    await loadSettingsFromDb();
    if (!engineState.settings.enabled) {
      await saveSettingsToDb({ enabled: true });
    }
    await syncOpenTradeId();
    await recalcWalletFromTrades();
    await hydrateLastStopLossCooldown();
    const bootClock = getIstClock(new Date());
    await refreshDayBook(bootClock.dateKey);
    engineState.running = true;
    engineState.startedAt = new Date();
    engineState.entryArmed = true;
    startLoop();
    tickOnce().catch(() => {});
    console.log('Flow Scalp Prime paper engine started');
    return { ok: true, started: true };
  }
  await syncOpenTradeId();
  return { ok: true, alreadyRunning: true };
}

async function getStatus() {
  await ensureEngineRunning();
  const wallet = await ensureWallet();
  const open = engineState.openTradeId
    ? await LivePaperTrade.findById(engineState.openTradeId).lean()
    : await LivePaperTrade.findOne({
      strategyKey: STRATEGY_KEY,
      status: 'OPEN',
      exitTime: null,
    }).lean();

  return {
    strategyId: STRATEGY_ID,
    strategyKey: STRATEGY_KEY,
    running: engineState.running,
    settings: engineState.settings,
    enabled: Boolean(engineState.settings.enabled),
    signal: engineState.lastSignal,
    openTrade: open || null,
    wallet: {
      walletKey: WALLET_KEY,
      balance: wallet.balance,
      realizedPnl: wallet.realizedPnl,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
    dayPts: engineState.dayPts,
    dayPnlInr: engineState.dayPnlInr,
    dayTargetInr: engineState.dayTargetInr,
    dayLocked: engineState.dayLocked,
    dayStopReason: engineState.dayStopReason,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    lastTapeAt: engineState.lastTapeAt,
  };
}

async function setEnabled(enabled) {
  const settings = await saveSettingsToDb({ enabled: Boolean(enabled) });
  await ensureEngineRunning();
  return { ok: true, enabled: settings.enabled, settings };
}

async function updateSettings(partial = {}) {
  const settings = await saveSettingsToDb(partial);
  return { ok: true, settings };
}

async function listTrades({ status, page = 1, pageSize = 50, date, month, year } = {}) {
  const q = { strategyKey: STRATEGY_KEY };
  if (status === 'OPEN') {
    q.status = 'OPEN';
    q.exitTime = null;
  } else if (status === 'CLOSED') {
    q.$or = [{ status: 'CLOSED' }, { exitTime: { $ne: null } }];
  }
  const dateFilter = applyEntryDateFilter(q, { date, month, year });
  const size = Math.max(1, Math.min(200, Math.floor(Number(pageSize) || 50)));
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const total = await LivePaperTrade.countDocuments(q);
  const trades = await LivePaperTrade.find(q)
    .sort({ entryTime: -1 })
    .skip((p - 1) * size)
    .limit(size)
    .lean();
  return {
    trades,
    filter: dateFilter,
    pagination: {
      page: p,
      pageSize: size,
      totalRows: total,
      totalPages: Math.max(1, Math.ceil(total / size)),
    },
  };
}

async function getBookSummary() {
  const wallet = await recalcWalletFromTrades();
  const clock = getIstClock(new Date());
  const dayBook = await refreshDayBook(clock.dateKey);
  const open = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();

  let openMtm = 0;
  for (const t of open) {
    const markLtp = Number(t.openPositionMark?.optionLtp);
    if (Number.isFinite(markLtp) && Number.isFinite(t.entryPremium)) {
      openMtm += (markLtp - Number(t.entryPremium)) * Number(t.qty) - (Number(t.charges) || 0);
    }
  }

  return {
    settings: engineState.settings,
    enabled: Boolean(engineState.settings.enabled),
    signal: engineState.lastSignal,
    lastEntryDebug: engineState.lastEntryDebug,
    slCooldown: (() => {
      if (!(engineState.lastStopLossAtMs > 0)) {
        return { active: false, remainSec: 0, needSec: Math.floor(SL_COOLDOWN_MS / 1000) };
      }
      const since = Date.now() - engineState.lastStopLossAtMs;
      const remainMs = SL_COOLDOWN_MS - since;
      if (remainMs <= 0) {
        return { active: false, remainSec: 0, needSec: Math.floor(SL_COOLDOWN_MS / 1000) };
      }
      return {
        active: true,
        remainSec: Math.ceil(remainMs / 1000),
        needSec: Math.floor(SL_COOLDOWN_MS / 1000),
      };
    })(),
    wallet: {
      walletKey: WALLET_KEY,
      balance: wallet.balance,
      realizedPnl: wallet.realizedPnl,
      totalTrades: wallet.totalTrades,
      wins: wallet.wins,
      losses: wallet.losses,
    },
    openTrades: open,
    openCount: open.length,
    closedCount: wallet.totalTrades,
    openMtm: Number(openMtm.toFixed(2)),
    dayPts: dayBook.dayPts,
    dayPnlInr: dayBook.dayPnlInr,
    dayTargetInr: dayBook.dayTargetInr,
    dayLocked: dayBook.dayLocked,
    dayStopReason: dayBook.dayStopReason,
    lastError: engineState.lastError,
  };
}

async function closeOpenTradeManual(reason = 'MANUAL_CLOSE') {
  const open = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    status: 'OPEN',
    exitTime: null,
  }).sort({ entryTime: -1 });
  if (!open) throw new Error('No open Flow Scalp Prime trade');
  const mark = await resolveOptionLtp(open);
  return finalizeTrade(open, {
    exitPremium: mark.optionLtp,
    mark,
    reason,
    futFallback: mark.spot || open.entrySpot,
  });
}

module.exports = {
  STRATEGY_KEY,
  WALLET_KEY,
  STRATEGY_ID,
  ensureEngineRunning,
  getStatus,
  setEnabled,
  updateSettings,
  listTrades,
  getBookSummary,
  closeOpenTradeManual,
  buildSignalFromOiFlow,
};
