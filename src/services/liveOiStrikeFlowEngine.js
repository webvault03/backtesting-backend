/**
 * Strategy 18 — OI Strike Flow paper live.
 * Closed 5m blocks from 09:45: put/call writing imbalance on 11 strikes (ATM from 09:15 ± 5)
 * + NIFTY vs 09:19 + writers’ strike behind → buy ATM CE/PE.
 * Exit: trail after +20 · option SL −25 until armed · writers’ strike broken · not armed in 60m · 15:15.
 * Max 2 trades/day. Soft monthly gate: stop new entries at +30% / −10% of starting capital.
 */

const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes, isWeekendDateKey } = require('../utils/dateTime');
const { findLatestStrikeFlowSignal } = require('../utils/oiStrikeFlowSignal');
const { niftyAtmStrike } = require('../utils/oiCandleAgreeSignal');
const oiStrikeLive = require('./oiStrikeLiveService');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
  getIndexLtp,
} = require('./dhanLiveService');
const { STRATEGY_EIGHTEEN_OI_STRIKE_FLOW_LIVE_KEY } = require('../strategies/keys');
const { broadcastPaperLive } = require('./realtimeSocket');
const {
  TRAIL_RUNGS,
  PEAK_TRAIL_GAP,
  buildTrailMilestones,
  applyTrailToMilestones,
} = require('../utils/openOiWallsTrail');

const STRATEGY_KEY = STRATEGY_EIGHTEEN_OI_STRIKE_FLOW_LIVE_KEY;

const WALLET_KEY = 'paper_live_strategy18';
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy18:option';
const LOG_PREFIX = '[OiStrikeFlowPaperLive]';
const SCENARIO_LABEL = 'OI Strike Flow';

const POLL_INTERVAL_MS = 2000;
const POSITION_POLL_MS = 1000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 4000;
const TICK_FRESH_MAX_AGE_MS = 20000;
const STATUS_MARK_REFRESH_MIN_GAP_MS = 750;
const MARK_DB_PERSIST_MIN_GAP_MS = 2000;
const LIVE_MARK_EMIT_MIN_GAP_MS = 400;
const MIN_HOLD_MS = 2000;
const FUT_PRICE_REFRESH_MIN_GAP_MS = 2000;

const DEFAULT_TRADE_FROM = 585; // 09:45
const DEFAULT_TRADE_TO = 780; // 13:00
const DEFAULT_EOD = 915; // 15:15
const DEFAULT_TARGET_POINTS = 70;
const TRAIL_NOTE = `trail=+20→+10/+30→+20/+40→+25 then peak-${PEAK_TRAIL_GAP}`;
const DEFAULT_PROXIMITY = 25;
const DEFAULT_LOOKAROUND = 12;
/** Writers’ strike: CE exits when NIFTY closes below level; PE when above. */
function writersLevelHit(trade, spot) {
  const level = Number(trade?.spotStopLoss);
  const sp = Number(spot);
  if (!Number.isFinite(level) || level <= 0 || !Number.isFinite(sp) || sp <= 0) return false;
  return tradeOptionType(trade) === 'CE' ? sp < level : sp > level;
}

function optionHardStopHit(trade, optionLtp) {
  const entry = Number(trade?.entryPremium);
  const slPts = Number(trade?.signalSnapshot?.optSlPoints ?? engineState.settings.optSlPoints);
  const lock = Number(trade?.stopLossPremium);
  // Once trail has armed a lock, hard SL is off.
  if (Number.isFinite(lock) && lock > 0) return false;
  if (!Number.isFinite(slPts) || slPts <= 0) return false;
  if (!Number.isFinite(entry) || !Number.isFinite(optionLtp) || optionLtp <= 0) return false;
  return optionLtp <= entry - slPts;
}

function unarmedTimeoutHit(trade, clockMinutes) {
  const unarmed = Number(trade?.signalSnapshot?.unarmedMin ?? engineState.settings.unarmedMin) || 60;
  const entry = getIstClock(trade.entryTime);
  if (!Number.isFinite(entry.minutes)) return false;
  const lock = Number(trade?.stopLossPremium);
  if (Number.isFinite(lock) && lock > 0) return false; // trail armed
  return clockMinutes >= entry.minutes + unarmed;
}

function buildTargetMilestones(entryPremium) {
  return buildTrailMilestones(entryPremium);
}

function nextPendingTargetPremium(milestones) {
  if (!Array.isArray(milestones) || milestones.length === 0) return null;
  const pending = milestones.find((m) => String(m.status || '').toUpperCase() !== 'HIT');
  const row = pending || milestones[milestones.length - 1];
  const prem = Number(row?.premium);
  return Number.isFinite(prem) ? prem : null;
}

function serializeMilestones(milestones) {
  if (!Array.isArray(milestones)) return [];
  return milestones.map((m) => ({
    points: Number(m.points) || 0,
    lockPoints: m.lockPoints != null ? Number(m.lockPoints) : null,
    role: m.role || 'trail_arm',
    premium: m.premium != null ? Number(m.premium) : null,
    status: String(m.status || 'PENDING').toUpperCase(),
    hitAt: m.hitAt || null,
    hitPremium: m.hitPremium != null ? Number(m.hitPremium) : null,
    pnlAtHit: m.pnlAtHit != null ? Number(m.pnlAtHit) : null,
  }));
}

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  lastEntryDebug: null,
  openPositionMark: null,
  lastChainFetchAt: 0,
  settings: {
    symbol: 'NIFTY',
    lotCount: 10,
    tradeFromTime: '09:45',
    tradeToTime: '13:00',
    eodExitTime: '15:15',
    writingRatio: 1.5,
    optSlPoints: 25,
    unarmedMin: 60,
    maxTradesPerDay: 2,
    cooldownMinutes: 1,
    perTradeCost: 100,
    monthlyTargetPct: 30,
    monthlyStopPct: 10,
  },
  lotSize: 65,
  expiry: null,
  expiryDateKey: null,
  lastFut: null,
  lastFutFetchAt: 0,
  futExpiry: null,
  futInstrument: null,
  chainSpot: null,
  lastSpot: null,
  lastOptionTick: null,
  liveSignal: null,
  flowSignal: null,
  lastFlowBarEndMin: null,
  lastFlowBarDateKey: null,
  tradesTodayCount: 0,
  tradesTodayDateKey: null,
  lastExitAtMs: 0,
  openTradeId: null,
  openTradeLite: null,
  closingTrade: false,
  enteringTrade: false,
  evaluatingEntry: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
  lastMarkPersistAt: 0,
  lastLiveMarkEmitAt: 0,
  liveMarkEmitTimer: null,
  lastOiError: null,
  lastFutError: null,
};

function hhmmSafe(m) {
  if (!Number.isFinite(m)) return '—';
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function istClockLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function logEntry(line, payload = {}) {
  const entry = { at: new Date().toISOString(), line, ...payload };
  engineState.lastEntryDebug = entry;
  console.log(`${LOG_PREFIX} ${line}`, JSON.stringify(entry));
}

function getEngineSymbol() {
  return String(engineState.symbol || 'NIFTY').toUpperCase();
}

function syncEngineSymbolFromSettings() {
  engineState.symbol = String(engineState.settings.symbol || engineState.symbol || 'NIFTY').toUpperCase();
}

/** Refresh Nifty cash/index LTP into lastFut/lastSpot. */
async function refreshFutPrice({ force = false } = {}) {
  const now = Date.now();
  if (
    !force
    && Number.isFinite(engineState.lastFut)
    && now - engineState.lastFutFetchAt < FUT_PRICE_REFRESH_MIN_GAP_MS
  ) {
    return engineState.lastFut;
  }
  try {
    const { ltp } = await getIndexLtp({
      symbol: getEngineSymbol(),
      forceFresh: Boolean(force),
    });
    if (Number.isFinite(ltp) && ltp > 0) {
      engineState.lastFut = Number(ltp);
      engineState.lastSpot = engineState.lastFut;
      engineState.lastFutFetchAt = now;
      engineState.lastFutError = null;
      engineState.futExpiry = null;
      engineState.futInstrument = null;
      return engineState.lastFut;
    }
    throw new Error('Nifty spot LTP unavailable');
  } catch (err) {
    engineState.lastFutError = err.message || 'Spot price failed';
    if (!Number.isFinite(engineState.lastFut)) {
      throw err;
    }
    return engineState.lastFut;
  }
}

function masterPrice() {
  const fut = Number(engineState.lastFut);
  if (Number.isFinite(fut) && fut > 0) return fut;
  const spot = Number(engineState.lastSpot);
  return Number.isFinite(spot) && spot > 0 ? spot : null;
}

function normalizeSettings(settings = {}) {
  const lotCount = Math.max(1, Number(settings.lotCount) || 10);
  const maxTradesPerDay = Math.max(1, Math.min(5, Math.floor(Number(settings.maxTradesPerDay) || 2)));
  const cooldownMinutes = Math.max(0, Math.min(60, Number(settings.cooldownMinutes) || 1));
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;
  const writingRatio = Math.max(1, Math.min(10, Number(settings.writingRatio) || 1.5));
  const optSlPoints = Math.max(0, Math.min(200, Number(settings.optSlPoints) || 25));
  const unarmedMin = Math.max(5, Math.min(330, Math.floor(Number(settings.unarmedMin) || 60)));
  const monthlyTargetPct = Math.max(5, Math.min(100, Number(settings.monthlyTargetPct) || 30));
  const monthlyStopPct = Math.max(5, Math.min(50, Number(settings.monthlyStopPct) || 10));
  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount,
    tradeFromTime: String(settings.tradeFromTime || '09:45'),
    tradeToTime: String(settings.tradeToTime || '13:00'),
    eodExitTime: String(settings.eodExitTime || '15:15'),
    writingRatio,
    optSlPoints,
    unarmedMin,
    maxTradesPerDay,
    cooldownMinutes,
    perTradeCost,
    monthlyTargetPct,
    monthlyStopPct,
  };
}

async function monthPnlSoFar() {
  const wallet = await ensureWallet();
  const start = Number(wallet.startingBalance) || 100000;
  const ym = getIstClock(new Date()).dateKey.slice(0, 7);
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    exitTime: { $ne: null },
    exitDateKey: { $gte: `${ym}-01`, $lte: `${ym}-31` },
  }).lean();
  let pnl = 0;
  for (const t of rows) pnl += Number(t.pnl) || 0;
  const pct = start > 0 ? (pnl / start) * 100 : 0;
  return { pnl: Number(pnl.toFixed(2)), pct: Number(pct.toFixed(2)), start, ym };
}

function monthlyGateStatus(month) {
  const target = Number(engineState.settings.monthlyTargetPct) || 30;
  const stop = Number(engineState.settings.monthlyStopPct) || 10;
  if (month.pct >= target) return { blocked: true, reason: 'MONTH_TARGET', message: `Month +${month.pct}% ≥ target ${target}% — no new entries` };
  if (month.pct <= -stop) return { blocked: true, reason: 'MONTH_STOP', message: `Month ${month.pct}% ≤ −${stop}% — no new entries` };
  return { blocked: false, reason: null, message: null, target, stop };
}

function signalOpts() {
  return {
    ratio: Number(engineState.settings.writingRatio) || 1.5,
    lastSignalMin: tradeToMin(),
  };
}

function tradeFromMin() {
  return parseClockMinutes(engineState.settings.tradeFromTime, DEFAULT_TRADE_FROM);
}

function tradeToMin() {
  return parseClockMinutes(engineState.settings.tradeToTime, DEFAULT_TRADE_TO);
}

function eodExitMin() {
  return parseClockMinutes(engineState.settings.eodExitTime, DEFAULT_EOD);
}

function isEodExitTime(minutes) {
  return Number(minutes) >= eodExitMin();
}

function tradeOptionType(trade) {
  return String(trade?.optionType || 'CE').toUpperCase() === 'PE' ? 'PE' : 'CE';
}

function premiumFromChain(chain, optionType) {
  const type = String(optionType || 'CE').toUpperCase();
  const ltp = type === 'CE' ? Number(chain?.ceLtp) : Number(chain?.peLtp);
  return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: WALLET_KEY });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: WALLET_KEY,
      startingBalance: 100000,
      balance: 0,
      realizedPnl: 0,
    });
  }
  // Month % uses startingBalance as capital base (default ₹1L).
  if (!Number.isFinite(Number(wallet.startingBalance)) || Number(wallet.startingBalance) <= 0) {
    wallet.startingBalance = 100000;
    await wallet.save();
  }
  return wallet;
}

async function persistFlowSignal(snapshot) {
  engineState.flowSignal = snapshot || null;
  try {
    const wallet = await ensureWallet();
    wallet.strategy18FlowSignal = snapshot || null;
    wallet.markModified('strategy18FlowSignal');
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Agree signal persist: ${err.message}`;
  }
}

function loadFlowSignalFromWallet(wallet) {
  const raw = wallet?.strategy18FlowSignal;
  if (!raw) return null;
  const obj = raw.toObject?.() || raw;
  if (!obj || typeof obj !== 'object') return null;
  return obj;
}

async function getEntryExpiry(symbol, dateKey) {
  const cachedExpiry = String(engineState.expiry || '').slice(0, 10);
  const isStale = !cachedExpiry || cachedExpiry < dateKey || engineState.expiryDateKey !== dateKey;
  if (isStale) {
    engineState.expiry = await getNearestWeeklyExpiry(symbol);
    engineState.expiryDateKey = dateKey;
  }
  return engineState.expiry;
}

function optionTickIsFresh() {
  const tick = engineState.lastOptionTick;
  if (!Number.isFinite(tick?.ltp)) return false;
  return Date.now() - (tick.ts || 0) < TICK_FRESH_MAX_AGE_MS;
}

function getOptionMarkFromTrade(trade, chain = null) {
  const optionType = tradeOptionType(trade);
  const futSpot = Number(masterPrice());
  const chainLtp = premiumFromChain(chain, optionType);
  if (Number.isFinite(chainLtp) && chainLtp > 0) {
    return {
      optionLtp: chainLtp,
      spot: Number.isFinite(futSpot) ? futSpot : null,
      source: 'chain',
      optionType,
      priceSource: 'SPOT',
    };
  }
  const tickLtp = Number(engineState.lastOptionTick?.ltp);
  if (Number.isFinite(tickLtp) && tickLtp > 0) {
    return {
      optionLtp: tickLtp,
      spot: Number.isFinite(futSpot) ? futSpot : null,
      source: 'websocket',
      optionType,
      priceSource: 'SPOT',
    };
  }
  const entryPrem = Number(trade.entryPremium);
  return {
    optionLtp: Number.isFinite(entryPrem) ? entryPrem : 0.05,
    spot: Number.isFinite(futSpot) ? futSpot : trade.entrySpot,
    source: 'entry',
    optionType,
    priceSource: 'SPOT',
  };
}

async function resolveMarkForOpenTrade(trade, { preferTicks = false, allowChain = true, forceChain = false } = {}) {
  if (preferTicks || optionTickIsFresh()) {
    const tickMark = getOptionMarkFromTrade(trade, null);
    if (tickMark.source === 'websocket') return tickMark;
  }
  const now = Date.now();
  const chainGapOk = forceChain || now - engineState.lastChainFetchAt >= OPEN_MARK_CHAIN_MIN_GAP_MS;
  if (!allowChain || !chainGapOk) return getOptionMarkFromTrade(trade, null);
  try {
    engineState.lastChainFetchAt = now;
    const chain = await getAtmPremiums({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
    });
    if (Number.isFinite(chain?.chainSpot)) engineState.chainSpot = chain.chainSpot;
    return getOptionMarkFromTrade(trade, chain);
  } catch (err) {
    engineState.lastError = `Mark fetch: ${err.message}`;
    return getOptionMarkFromTrade(trade, null);
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entry = Number(trade.entryPremium) || 0;
  const ltp = Number(mark.optionLtp) || 0;
  const qty = Number(trade.qty) || 0;
  const unrealized = (ltp - entry) * qty - (Number(trade.charges) || 0);
  return {
    optionType: tradeOptionType(trade),
    optionLtp: Number(ltp.toFixed(2)),
    entryPremium: entry,
    spot: Number.isFinite(Number(mark.spot)) ? Number(Number(mark.spot).toFixed(2)) : null,
    priceSource: 'SPOT',
    source: mark.source,
    isLiveMark: mark.source === 'websocket' || mark.source === 'chain',
    unrealizedPnl: Number(unrealized.toFixed(2)),
    trailLockPremium: trade.stopLossPremium != null ? Number(trade.stopLossPremium) : null,
    spotStopLoss: trade.spotStopLoss != null ? Number(trade.spotStopLoss) : null,
    trailPeakPremium: trade.highSinceEntry != null ? Number(trade.highSinceEntry) : null,
    at: new Date().toISOString(),
    ist: istClockLabel(clock),
  };
}

async function persistOpenMarkToDb(trade, positionMark) {
  trade.openPositionMark = positionMark;
  trade.openPositionMarkAt = new Date();
  await trade.save();
}

function cacheOpenTradeLite(trade) {
  if (!trade) {
    engineState.openTradeLite = null;
    return null;
  }
  engineState.openTradeLite = {
    _id: trade._id?.toString?.() || String(trade._id || engineState.openTradeId || ''),
    id: trade._id?.toString?.() || String(trade._id || engineState.openTradeId || ''),
    symbol: trade.symbol || getEngineSymbol(),
    optionType: tradeOptionType(trade),
    strike: Number(trade.strike) || null,
    expiryDate: trade.expiryDate || null,
    entryTime: trade.entryTime || null,
    entryPremium: Number(trade.entryPremium) || 0,
    entrySpot: Number(trade.entrySpot) || null,
    qty: Number(trade.qty) || 0,
    lots: Number(trade.lots) || null,
    charges: Number(trade.charges) || 0,
    investedAmount: Number(trade.investedAmount) || null,
    targetPremium: trade.targetPremium != null ? Number(trade.targetPremium) : null,
    stopLossPremium: trade.stopLossPremium != null ? Number(trade.stopLossPremium) : null,
    spotStopLoss: trade.spotStopLoss != null ? Number(trade.spotStopLoss) : null,
    highSinceEntry: trade.highSinceEntry != null ? Number(trade.highSinceEntry) : null,
    targetMilestones: serializeMilestones(trade.targetMilestones),
    status: 'OPEN',
  };
  return engineState.openTradeLite;
}

function getLiveMarkSnapshot() {
  return {
    strategyId: 'strategy-18',
    open: Boolean(engineState.openTradeId),
    tradeId: engineState.openTradeId,
    mark: engineState.openPositionMark,
    openTradeLite: engineState.openTradeLite,
    lastFut: engineState.lastFut,
    futExpiry: engineState.futExpiry,
    liveSignal: engineState.liveSignal,
    at: new Date().toISOString(),
  };
}

function publishLiveMarkSnapshot(extra = {}) {
  const payload = { ...getLiveMarkSnapshot(), ...extra };
  const now = Date.now();
  const gap = now - engineState.lastLiveMarkEmitAt;
  if (gap >= LIVE_MARK_EMIT_MIN_GAP_MS) {
    engineState.lastLiveMarkEmitAt = now;
    broadcastPaperLive('strategy-18', payload);
    return;
  }
  if (engineState.liveMarkEmitTimer) return;
  engineState.liveMarkEmitTimer = setTimeout(() => {
    engineState.liveMarkEmitTimer = null;
    engineState.lastLiveMarkEmitAt = Date.now();
    broadcastPaperLive('strategy-18', getLiveMarkSnapshot());
  }, Math.max(20, LIVE_MARK_EMIT_MIN_GAP_MS - gap));
}

function publishOpenMark(trade, mark, clock, { persist = true, forcePersist = false } = {}) {
  const positionMark = buildOpenPositionMark(trade, mark, clock);
  engineState.openPositionMark = positionMark;
  publishLiveMarkSnapshot();
  if (!persist) return positionMark;
  const now = Date.now();
  if (!forcePersist && now - engineState.lastMarkPersistAt < MARK_DB_PERSIST_MIN_GAP_MS) {
    return positionMark;
  }
  engineState.lastMarkPersistAt = now;
  persistOpenMarkToDb(trade, positionMark).catch((err) => {
    engineState.lastError = `Mark persist: ${err.message}`;
  });
  return positionMark;
}

function publishTickMarkFast(ltp) {
  const lite = engineState.openTradeLite;
  if (!lite || !Number.isFinite(ltp) || ltp <= 0) return null;
  const entry = Number(lite.entryPremium) || 0;
  const qty = Number(lite.qty) || 0;
  const unrealized = (ltp - entry) * qty - (Number(lite.charges) || 0);
  const clock = getIstClock(new Date());
  const positionMark = {
    optionType: lite.optionType,
    optionLtp: Number(ltp.toFixed(2)),
    entryPremium: entry,
    spot: Number.isFinite(Number(masterPrice())) ? Number(Number(masterPrice()).toFixed(2)) : null,
    priceSource: 'SPOT',
    source: 'websocket',
    isLiveMark: true,
    unrealizedPnl: Number(unrealized.toFixed(2)),
    at: new Date().toISOString(),
    ist: istClockLabel(clock),
  };
  engineState.openPositionMark = positionMark;
  publishLiveMarkSnapshot();
  return positionMark;
}

async function subscribeOpenOption(trade) {
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.lastOptionTick = null;
  cacheOpenTradeLite(trade);
  const optionType = tradeOptionType(trade);
  try {
    const instrument = await resolveOptionInstrument({
      symbol: trade.symbol,
      strike: trade.strike,
      expiry: trade.expiryDate,
      optionType,
    });
    subscribeLiveInstrument({
      key: OPTION_SUBSCRIPTION_KEY,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      onTick: (tick) => onOptionTick(tick),
    });
  } catch (err) {
    engineState.lastError = `OI Strike Flow WS subscribe failed: ${err.message}`;
  }
}

function clearOpenTrade() {
  stopPositionPoll();
  unsubscribeLiveSymbol(OPTION_SUBSCRIPTION_KEY);
  engineState.openTradeId = null;
  engineState.openTradeLite = null;
  engineState.lastOptionTick = null;
  engineState.openPositionMark = null;
  publishLiveMarkSnapshot({ open: false, tradeId: null, mark: null });
}

function stopPositionPoll() {
  if (engineState.positionPollTimer) {
    clearInterval(engineState.positionPollTimer);
    engineState.positionPollTimer = null;
  }
}

function startPositionPoll() {
  stopPositionPoll();
  if (!engineState.openTradeId) return;
  const tick = () => {
    checkOpenTrade().catch((err) => {
      engineState.lastError = `OI Strike Flow position poll: ${err.message}`;
    });
  };
  tick();
  engineState.positionPollTimer = setInterval(tick, POSITION_POLL_MS);
}

async function dedupeOpenTradesInDb(clock) {
  const openRows = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({
    entryTime: -1,
  });
  if (openRows.length <= 1) return openRows[0] || null;
  const [keep, ...duplicates] = openRows;
  for (const dup of duplicates) {
    dup.status = 'CLOSED';
    dup.exitTime = new Date();
    dup.exitDateKey = clock.dateKey;
    dup.reason = 'DUPLICATE_ENTRY';
    dup.pnl = 0;
    dup.pnlPct = 0;
    await dup.save();
  }
  if (duplicates.length > 0) await recalcWalletFromTrades();
  return keep;
}

async function syncTradesToday(clock) {
  const rows = await LivePaperTrade.find({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
  })
    .select({ _id: 1 })
    .lean();
  engineState.tradesTodayCount = rows.length;
  engineState.tradesTodayDateKey = clock.dateKey;

  const last = await LivePaperTrade.findOne({
    strategyKey: STRATEGY_KEY,
    entryDateKey: clock.dateKey,
    exitTime: { $ne: null },
  })
    .sort({ exitTime: -1 })
    .select({ exitTime: 1 })
    .lean();
  engineState.lastExitAtMs = last?.exitTime ? new Date(last.exitTime).getTime() : 0;

  if (engineState.lastFlowBarDateKey !== clock.dateKey) {
    engineState.lastFlowBarEndMin = null;
    engineState.lastFlowBarDateKey = clock.dateKey;
  }
}

async function syncEngineTradeStateFromDb(clock) {
  await syncTradesToday(clock);
  const open = await LivePaperTrade.findOne({ strategyKey: STRATEGY_KEY, exitTime: null }).sort({
    entryTime: -1,
  });
  if (open) {
    engineState.openTradeId = open._id.toString();
    return;
  }
  if (engineState.openTradeId) clearOpenTrade();
}

function publishLiveSignal(next) {
  const futFallback = Number.isFinite(engineState.lastFut) ? engineState.lastFut : null;
  engineState.liveSignal = {
    ok: Boolean(next.ok),
    status: next.status || 'WATCHING',
    message: next.message || '',
    shape: next.shape != null ? next.shape : null,
    pair: next.pair != null ? next.pair : null,
    dir: next.dir != null ? next.dir : null,
    optionBuy: next.optionBuy != null ? next.optionBuy : null,
    optionType: next.optionType != null ? next.optionType : null,
    reason: next.reason != null ? next.reason : null,
    barEndMin: next.barEndMin != null ? next.barEndMin : null,
    waiting: next.waiting !== undefined ? next.waiting : null,
    agree: next.agree !== undefined ? next.agree : null,
    fut: next.fut !== undefined ? next.fut : futFallback,
    at: new Date().toISOString(),
  };
  engineState.flowSignal = engineState.liveSignal;
  publishLiveMarkSnapshot();
}

async function loadTodayStrikeDay(clock) {
  try {
    oiStrikeLive.ensureEngineRunning();
  } catch {
    /* best-effort */
  }
  const packed = await oiStrikeLive.loadTodayDay(clock.dateKey);
  return packed;
}

/** No-op — strategy-18 does not capture open walls. */
async function maybeCaptureOpenWalls() {
  return;
}

async function refreshLiveSignalStatus(clock) {
  const fut = Number.isFinite(engineState.lastFut) ? engineState.lastFut : null;

  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) {
    publishLiveSignal({
      ok: false,
      status: 'HOLIDAY',
      message: isWeekendDateKey(clock.dateKey)
        ? 'Weekend — markets closed'
        : `Holiday — ${getNseHolidayDescription(clock.dateKey) || 'NSE closed'}`,
      fut,
    });
    return engineState.liveSignal;
  }

  if (engineState.openTradeId) {
    publishLiveSignal({
      ok: true,
      status: 'HOLDING',
      message: 'Position open',
      fut,
      ...(engineState.flowSignal
        ? {
            shape: engineState.flowSignal.shape,
            pair: engineState.flowSignal.pair,
            dir: engineState.flowSignal.dir,
            optionBuy: engineState.flowSignal.optionBuy,
            optionType: engineState.flowSignal.optionType,
            reason: engineState.flowSignal.reason,
          }
        : {}),
    });
    return engineState.liveSignal;
  }

  if (clock.minutes < tradeFromMin() || clock.minutes > tradeToMin()) {
    publishLiveSignal({
      ok: false,
      status: 'WATCHING',
      message: `Outside entry window ${engineState.settings.tradeFromTime}–${engineState.settings.tradeToTime}`,
      fut,
    });
    return engineState.liveSignal;
  }

  if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) {
    publishLiveSignal({
      ok: false,
      status: 'MAXED',
      message: `${engineState.tradesTodayCount}/${engineState.settings.maxTradesPerDay} trades done`,
      fut,
    });
    return engineState.liveSignal;
  }

  let liveFut = fut;
  try {
    liveFut = await refreshFutPrice({ clock });
  } catch {
    /* keep */
  }

  let packed;
  try {
    packed = await loadTodayStrikeDay(clock);
  } catch (err) {
    engineState.lastOiError = err.message || 'Strike tape load failed';
    publishLiveSignal({
      ok: false,
      status: 'WAITING',
      message: `Strike tape unavailable: ${engineState.lastOiError}`,
      fut: liveFut,
    });
    return engineState.liveSignal;
  }

  const month = await monthPnlSoFar();
  const gate = monthlyGateStatus(month);
  if (gate.blocked) {
    publishLiveSignal({
      ok: false,
      status: 'MONTH_GATE',
      message: gate.message,
      monthPnl: month.pnl,
      monthPct: month.pct,
      fut: liveFut,
    });
    await persistFlowSignal(engineState.liveSignal);
    return engineState.liveSignal;
  }

  const result = findLatestStrikeFlowSignal(packed.day, clock.minutes, signalOpts());
  if (!result.ok) {
    const waiting = result.waiting || null;
    publishLiveSignal({
      ok: false,
      status: 'WAITING',
      message: waiting?.message || 'Waiting for closed 5m writing signal…',
      ceWriting: waiting?.ceWriting,
      peWriting: waiting?.peWriting,
      waiting,
      monthPnl: month.pnl,
      monthPct: month.pct,
      fut: liveFut,
    });
    await persistFlowSignal(engineState.liveSignal);
    return engineState.liveSignal;
  }

  const barEnd = Number(result.barEndMin);
  const usedBar =
    engineState.lastFlowBarDateKey === clock.dateKey
    && Number.isFinite(barEnd)
    && Number(engineState.lastFlowBarEndMin) === barEnd;
  if (usedBar) {
    publishLiveSignal({
      ok: false,
      status: 'USED',
      message: `Bar ${barEnd} already used today`,
      optionBuy: result.optionBuy,
      optionType: result.optionType,
      reason: result.reason,
      barEndMin: barEnd,
      flow: result,
      fut: liveFut,
    });
    await persistFlowSignal(engineState.liveSignal);
    return engineState.liveSignal;
  }

  if (!Number.isFinite(barEnd) || barEnd < tradeFromMin() || barEnd > tradeToMin()) {
    publishLiveSignal({
      ok: false,
      status: 'WATCHING',
      message: `Block ${barEnd} outside entry window`,
      optionBuy: result.optionBuy,
      optionType: result.optionType,
      reason: result.reason,
      barEndMin: barEnd,
      flow: result,
      fut: liveFut,
    });
    await persistFlowSignal(engineState.liveSignal);
    return engineState.liveSignal;
  }

  publishLiveSignal({
    ok: true,
    status: 'READY',
    message: `READY ${result.optionBuy || result.optionType} · ${result.reason || 'FLOW'}`,
    optionBuy: result.optionBuy,
    optionType: result.optionType,
    reason: result.reason,
    level: result.level,
    ceWriting: result.ceWriting,
    peWriting: result.peWriting,
    writingRatio: result.writingRatio,
    barEndMin: barEnd,
    flow: result,
    monthPnl: month.pnl,
    monthPct: month.pct,
    fut: liveFut,
  });
  await persistFlowSignal(engineState.liveSignal);
  return engineState.liveSignal;
}

async function placeLongOption(clock, signal, spot) {
  if (engineState.enteringTrade) return;
  engineState.enteringTrade = true;
  try {
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId) return;
    if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) return;

    let fillSpot = Number(spot);
    try {
      fillSpot = await refreshFutPrice({ force: true, clock });
    } catch (err) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'SPOT_FETCH_FAILED',
        atPlace: true,
        error: err.message,
      });
      return;
    }
    if (!Number.isFinite(fillSpot) || fillSpot <= 0) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'SPOT_UNAVAILABLE', atPlace: true });
      return;
    }
    engineState.lastFut = fillSpot;
    engineState.lastSpot = fillSpot;

    const symbol = getEngineSymbol();
    const optionType = String(signal.optionType || '').toUpperCase() === 'PE' ? 'PE' : 'CE';
    const strike = niftyAtmStrike(fillSpot);
    if (!Number.isFinite(strike)) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'BAD_ATM_STRIKE', fillSpot });
      return;
    }
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, optionType);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastError = `OI Strike Flow: missing ${optionType} premium for ${strike}`;
      return;
    }

    try {
      const lastSpot = await refreshFutPrice({ force: true, clock });
      if (Number.isFinite(lastSpot) && lastSpot > 0) {
        fillSpot = lastSpot;
        engineState.lastFut = fillSpot;
        engineState.lastSpot = fillSpot;
      }
    } catch {
      /* keep prior fill spot */
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 5);
    const qty = lotSize * lots;
    const invested = entryPremium * qty;
    const charges = engineState.settings.perTradeCost;
    const milestones = buildTargetMilestones(entryPremium);
    const targetPremium = nextPendingTargetPremium(milestones);
    const barEndMin = Number(signal.barEndMin);
    const spotStopLoss = Number(signal.level);
    const optSlPoints = Number(engineState.settings.optSlPoints) || 25;
    const unarmedMin = Number(engineState.settings.unarmedMin) || 60;

    const tradeDoc = await LivePaperTrade.create({
      strategyKey: STRATEGY_KEY,
      symbol,
      side: 'LONG',
      optionType,
      strike,
      expiryDate: expiry,
      lotSize,
      lots,
      qty,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySpot: Number(fillSpot.toFixed(2)),
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number(invested.toFixed(2)),
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium: null,
      spotStopLoss: Number.isFinite(spotStopLoss) ? spotStopLoss : null,
      targetPremium: targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
      stopLossMode: 'POINTS',
      targetMode: 'POINTS',
      targetMilestones: milestones,
      highSinceEntry: Number(entryPremium.toFixed(2)),
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason: `Buy ${optionType} ATM · ${signal.reason || 'FLOW'}`,
      signalSnapshot: {
        kind: 'oi_strike_flow',
        level: spotStopLoss,
        ceWriting: signal.ceWriting,
        peWriting: signal.peWriting,
        writingRatio: signal.writingRatio,
        baseSpot: signal.baseSpot,
        barEndMin,
        optSlPoints,
        unarmedMin,
        ratio: engineState.settings.writingRatio,
      },
      notes: `oi_strike_flow; atm=${strike}; level=${spotStopLoss}; ratio=${signal.writingRatio}; barEnd=${hhmmSafe(barEndMin)}; SL=-${optSlPoints} till armed; unarmed=${unarmedMin}m; ${TRAIL_NOTE}`,
    });

    if (Number.isFinite(barEndMin)) {
      engineState.lastFlowBarEndMin = barEndMin;
      engineState.lastFlowBarDateKey = clock.dateKey;
    }
    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradesTodayCount += 1;
    engineState.tradesTodayDateKey = clock.dateKey;
    engineState.lastSignalAt = new Date();
    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      optionType,
      strike,
      signal: {
        shape: signal.shape,
        pair: signal.pair,
        dir: signal.dir,
        reason: signal.reason,
        optionBuy: signal.optionBuy,
        barEndMin,
      },
      entryPremium: Number(entryPremium.toFixed(2)),
      targetPremium,
      targetMilestones: serializeMilestones(milestones),
      stopLossPremium: null,
      spotStopLoss,
    });
    publishLiveSignal({
      ok: true,
      status: 'ENTERED',
      message: `Entered ${optionType} ${strike} ATM`,
      shape: signal.shape,
      pair: signal.pair,
      dir: signal.dir,
      optionBuy: signal.optionBuy,
      optionType,
      reason: signal.reason,
      barEndMin,
      agree: signal,
      fut: fillSpot,
    });
    await persistFlowSignal(engineState.liveSignal);
    await subscribeOpenOption(tradeDoc);
    startPositionPoll();
  } catch (err) {
    engineState.lastError = err.message;
    logEntry('ENTRY_FAILED', { ist: istClockLabel(clock), error: err.message });
  } finally {
    engineState.enteringTrade = false;
  }
}

async function evaluateEntry() {
  if (engineState.evaluatingEntry) return;
  engineState.evaluatingEntry = true;
  try {
    const clock = getIstClock(new Date());
    await ensureNseHolidaysLoaded();
    if (!isNseCashTradingDay(clock.dateKey)) {
      if (clock.minutes >= tradeFromMin() && clock.minutes <= tradeToMin()) {
        logEntry('ENTRY_SKIP', {
          ist: istClockLabel(clock),
          reason: isWeekendDateKey(clock.dateKey) ? 'WEEKEND' : 'HOLIDAY',
          holiday: getNseHolidayDescription(clock.dateKey),
        });
      }
      return;
    }
    await syncEngineTradeStateFromDb(clock);
    if (engineState.openTradeId) return;
    if (clock.minutes > tradeToMin() || clock.minutes < tradeFromMin()) return;

    if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'MAX_TRADES',
        count: engineState.tradesTodayCount,
        max: engineState.settings.maxTradesPerDay,
      });
      return;
    }

    const cooldownMs = (Number(engineState.settings.cooldownMinutes) || 0) * 60 * 1000;
    if (cooldownMs > 0 && engineState.lastExitAtMs && Date.now() - engineState.lastExitAtMs < cooldownMs) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'COOLDOWN' });
      return;
    }

    const month = await monthPnlSoFar();
    const gate = monthlyGateStatus(month);
    if (gate.blocked) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: gate.reason, monthPct: month.pct });
      return;
    }

    let packed;
    try {
      packed = await loadTodayStrikeDay(clock);
    } catch (err) {
      engineState.lastError = `Strike tape: ${err.message}`;
      return;
    }

    const result = findLatestStrikeFlowSignal(packed.day, clock.minutes, signalOpts());
    if (!result.ok) {
      if (result.waiting) {
        engineState.liveSignal = {
          ...(engineState.liveSignal || {}),
          ok: false,
          status: 'WAITING',
          message: result.waiting.message || 'Waiting for 5m writing signal…',
          waiting: result.waiting,
          monthPnl: month.pnl,
          monthPct: month.pct,
          at: new Date().toISOString(),
        };
      }
      return;
    }

    const barEnd = Number(result.barEndMin);
    if (!Number.isFinite(barEnd) || barEnd < tradeFromMin() || barEnd > tradeToMin()) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'BAR_OUTSIDE_WINDOW',
        barEndMin: barEnd,
        from: tradeFromMin(),
        to: tradeToMin(),
      });
      return;
    }
    // Only act on a block that just closed (same 5m slot).
    if (clock.minutes - barEnd > 6) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'BAR_STALE',
        barEndMin: barEnd,
        nowMin: clock.minutes,
      });
      return;
    }
    if (
      engineState.lastFlowBarDateKey === clock.dateKey
      && Number(engineState.lastFlowBarEndMin) === barEnd
    ) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'BAR_ALREADY_USED', barEndMin: barEnd });
      return;
    }

    let fut;
    try {
      fut = await refreshFutPrice({ clock });
    } catch (err) {
      engineState.lastError = `SPOT: ${err.message}`;
      return;
    }

    logEntry('ENTRY_TRIGGER', {
      ist: istClockLabel(clock),
      signal: {
        optionType: result.optionType,
        reason: result.reason,
        barEndMin: barEnd,
      },
      fut,
    });
    await placeLongOption(clock, result, fut);
  } finally {
    engineState.evaluatingEntry = false;
  }
}

async function onOptionTick({ ltp }) {
  const n = Number(ltp);
  engineState.lastOptionTick = { ltp: n, ts: Date.now() };
  if (engineState.openTradeId && Number.isFinite(n) && n > 0) {
    publishTickMarkFast(n);
  }
  checkOpenTrade({ preferTicks: true }).catch((err) => {
    engineState.lastError = `OI Strike Flow tick check: ${err.message}`;
  });
}

async function recordTargetMilestoneHits(trade, optionLtp) {
  const ltp = Number(optionLtp);
  if (!Number.isFinite(ltp) || ltp <= 0) return { changed: false, exit: false };
  const applied = applyTrailToMilestones(trade, ltp);
  if (applied.peakPremium != null) {
    const prevHigh = Number(trade.highSinceEntry);
    if (!Number.isFinite(prevHigh) || applied.peakPremium > prevHigh) {
      trade.highSinceEntry = applied.peakPremium;
      applied.changed = true;
    }
  }
  if (applied.changed) {
    trade.targetMilestones = applied.milestones;
    trade.markModified('targetMilestones');
  }
  if (applied.lockPremium != null && Number(trade.stopLossPremium) !== applied.lockPremium) {
    trade.stopLossPremium = applied.lockPremium;
    trade.stopLossMode = 'POINTS';
    applied.changed = true;
  }
  if (applied.nextTarget != null) trade.targetPremium = applied.nextTarget;
  trade.targetMode = 'POINTS';
  if (applied.changed) {
    await trade.save();
    cacheOpenTradeLite(trade);
    publishLiveMarkSnapshot();
  }
  if (applied.justHit?.length) {
    logEntry('TRAIL_ARM', {
      tradeId: trade._id.toString(),
      optionLtp: ltp,
      hit: applied.justHit,
      peakPts: applied.peakPts,
      lockPts: applied.lockPts,
      lockPremium: applied.lockPremium,
      milestones: serializeMilestones(applied.milestones),
    });
  }
  return applied;
}

function sealMissedMilestones(trade) {
  const milestones = Array.isArray(trade.targetMilestones) ? trade.targetMilestones : [];
  if (!milestones.length) return false;
  let changed = false;
  for (const m of milestones) {
    const status = String(m.status || 'PENDING').toUpperCase();
    if (status === 'HIT') continue;
    if (status !== 'MISSED') {
      m.status = 'MISSED';
      changed = true;
    }
  }
  if (changed) trade.markModified('targetMilestones');
  return changed;
}

async function checkOpenTrade({ preferTicks = false } = {}) {
  if (!engineState.running || engineState.closingTrade) return;
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return;

  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) {
    clearOpenTrade();
    return;
  }
  cacheOpenTradeLite(trade);

  if (clock.dateKey !== trade.entryDateKey) {
    const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
    sealMissedMilestones(trade);
    await finalizeTrade(trade, { exitPremium: mark.optionLtp, mark, reason: 'DAY_CLOSE', forceChain: true });
    return;
  }

  try {
    await refreshFutPrice({ force: false, clock });
  } catch {
    /* keep last spot */
  }

  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks,
    allowChain: true,
    forceChain: !preferTicks && !optionTickIsFresh(),
  });
  publishOpenMark(trade, mark, clock, { persist: true, forcePersist: false });

  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return;

  const optionLtp = Number(mark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return;

  const spotNow = masterPrice();
  if (writersLevelHit(trade, spotNow)) {
    const fresh = await LivePaperTrade.findById(engineState.openTradeId);
    if (!fresh || fresh.exitTime) {
      clearOpenTrade();
      return;
    }
    logEntry('LEVEL_EXIT', {
      ist: istClockLabel(clock),
      tradeId: fresh._id.toString(),
      optionType: tradeOptionType(fresh),
      spot: spotNow,
      level: fresh.spotStopLoss,
      optionLtp,
    });
    await finalizeTrade(fresh, {
      exitPremium: null,
      mark: { ...mark, spot: spotNow },
      reason: 'LEVEL',
      forceChain: true,
    });
    return;
  }

  if (mark.source === 'entry' && !isEodExitTime(clock.minutes)) return;

  // Arm trail rungs from peak; cut if LTP falls back to the lock.
  let trail = { exit: false };
  try {
    trail = await recordTargetMilestoneHits(trade, optionLtp);
  } catch (err) {
    engineState.lastError = `Trail record: ${err.message}`;
  }

  if (!trail?.exit && optionHardStopHit(trade, optionLtp)) {
    const fresh = await LivePaperTrade.findById(engineState.openTradeId);
    if (!fresh || fresh.exitTime) {
      clearOpenTrade();
      return;
    }
    const slPx = Number(fresh.entryPremium) - (Number(fresh.signalSnapshot?.optSlPoints) || 25);
    logEntry('OPTION_SL_EXIT', { ist: istClockLabel(clock), tradeId: fresh._id.toString(), optionLtp, slPx });
    await finalizeTrade(fresh, {
      exitPremium: Math.max(0.05, slPx),
      mark: { ...mark, optionLtp: Math.max(0.05, slPx) },
      reason: 'SL',
      forceChain: false,
    });
    return;
  }

  if (!trail?.exit && unarmedTimeoutHit(trade, clock.minutes)) {
    const fresh = await LivePaperTrade.findById(engineState.openTradeId);
    if (!fresh || fresh.exitTime) {
      clearOpenTrade();
      return;
    }
    logEntry('UNARMED_EXIT', { ist: istClockLabel(clock), tradeId: fresh._id.toString(), optionLtp });
    await finalizeTrade(fresh, {
      exitPremium: optionLtp,
      mark,
      reason: 'TIME',
      forceChain: true,
    });
    return;
  }

  if (trail?.exit) {
    const fresh = await LivePaperTrade.findById(engineState.openTradeId);
    if (!fresh || fresh.exitTime) {
      clearOpenTrade();
      return;
    }
    const lockPx = Number(fresh.stopLossPremium);
    const exitPx = Number.isFinite(lockPx) ? lockPx : optionLtp;
    logEntry('TRAIL_EXIT', {
      ist: istClockLabel(clock),
      tradeId: fresh._id.toString(),
      optionLtp,
      lockPremium: lockPx,
    });
    await finalizeTrade(fresh, {
      exitPremium: exitPx,
      mark: { ...mark, optionLtp: exitPx },
      reason: 'TRAIL',
      forceChain: false,
    });
    return;
  }

  if (isEodExitTime(clock.minutes)) {
    const fresh = await LivePaperTrade.findById(engineState.openTradeId);
    if (!fresh || fresh.exitTime) {
      clearOpenTrade();
      return;
    }
    sealMissedMilestones(fresh);
    await finalizeTrade(fresh, {
      exitPremium: optionLtp,
      mark,
      reason: 'DAY_CLOSE',
      forceChain: true,
    });
  }
}

async function finalizeTrade(trade, { exitPremium, mark, reason, forceChain = false }) {
  if (engineState.closingTrade) return;
  engineState.closingTrade = true;
  try {
    let resolvedMark = mark;
    if (forceChain || !Number.isFinite(mark?.optionLtp) || mark?.source === 'entry') {
      resolvedMark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
    }
    const markSource = resolvedMark?.source || 'unknown';
    const liveExitMark = markSource === 'websocket' || markSource === 'chain';
    if (!liveExitMark && !forceChain) {
      engineState.lastError = 'Exit blocked — waiting for live Dhan LTP';
      return;
    }
    const safeExitPremium = Math.max(
      0.05,
      Number(exitPremium) || Number(resolvedMark?.optionLtp) || 0.05,
    );
    const finalValue = safeExitPremium * trade.qty;
    const invested = (Number(trade.entryPremium) || 0) * trade.qty;
    const charges = Math.max(0, Number(trade.charges) || 0);
    const pnl = finalValue - invested - charges;
    const clock = getIstClock(new Date());

    trade.status = 'CLOSED';
    trade.exitPremium = Number(safeExitPremium.toFixed(2));
    trade.exitSpot = Number(Number(resolvedMark?.spot || engineState.lastSpot || trade.entrySpot).toFixed(2));
    trade.exitTime = new Date();
    trade.exitDateKey = clock.dateKey;
    trade.reason = reason;
    trade.finalValue = Number(finalValue.toFixed(2));
    trade.pnl = Number(pnl.toFixed(2));
    const investedAmount = Number(trade.investedAmount) || invested;
    trade.pnlPct = investedAmount > 0 ? Number(((pnl / investedAmount) * 100).toFixed(2)) : 0;
    trade.openPositionMark = null;
    trade.openPositionMarkAt = null;
    sealMissedMilestones(trade);
    const hitSummary = serializeMilestones(trade.targetMilestones)
      .map((m) => `+${m.points}:${m.status}`)
      .join(',');
    trade.notes = [trade.notes, `exitMark=${markSource}; pnl=${Number(pnl.toFixed(2))}; trail=${hitSummary}`]
      .filter(Boolean)
      .join(' | ')
      .slice(0, 500);
    await trade.save();

    const wallet = await ensureWallet();
    wallet.balance += pnl;
    wallet.realizedPnl += pnl;
    wallet.totalTrades += 1;
    if (pnl > 0) wallet.wins += 1;
    else if (pnl < 0) wallet.losses += 1;
    await wallet.save();

    logEntry('EXIT_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: trade._id.toString(),
      reason,
      pnl,
      exitPremium: safeExitPremium,
    });
    engineState.lastExitAtMs = Date.now();
    clearOpenTrade();
  } catch (err) {
    engineState.lastError = `Exit failed: ${err.message}`;
  } finally {
    engineState.closingTrade = false;
  }
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => {
    const clock = getIstClock(new Date());
    refreshFutPrice({ clock }).catch((err) => {
      engineState.lastFutError = err.message || 'Spot failed';
    });
    maybeCaptureOpenWalls(clock).catch(() => {});
    refreshLiveSignalStatus(clock).catch((err) => {
      engineState.lastError = `OI Strike Flow signal: ${err.message}`;
    });
    evaluateEntry().catch((err) => {
      engineState.lastError = `OI Strike Flow entry poll: ${err.message}`;
    });
    checkOpenTrade().catch((err) => {
      engineState.lastError = `OI Strike Flow exit poll: ${err.message}`;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

function applyExitPointsFromEntry(trade, optionLtp = null) {
  const entry = Number(trade.entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) return false;
  const ltp = Number(optionLtp) || Number(trade.openPositionMark?.optionLtp) || Number(trade.highSinceEntry) || entry;
  const applied = applyTrailToMilestones(trade, ltp);
  trade.targetMilestones = applied.milestones;
  trade.markModified('targetMilestones');
  if (applied.peakPremium != null) trade.highSinceEntry = applied.peakPremium;
  trade.targetPremium = applied.nextTarget;
  trade.targetMode = 'POINTS';
  trade.stopLossPremium = applied.lockPremium;
  trade.stopLossMode = applied.lockPremium != null ? 'POINTS' : null;
  return true;
}

async function reapplyExitPointsToOpenTrade({ reason = 'SETTINGS' } = {}) {
  if (!engineState.openTradeId) return { ok: true, updated: 0 };
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return { ok: true, updated: 0 };
  const before = {
    targetPremium: trade.targetPremium,
    stopLossPremium: trade.stopLossPremium,
    milestoneCount: Array.isArray(trade.targetMilestones) ? trade.targetMilestones.length : 0,
    firstRung: Array.isArray(trade.targetMilestones) ? trade.targetMilestones[0]?.points : null,
  };
  if (!applyExitPointsFromEntry(trade)) return { ok: true, updated: 0 };
  const sameTarget = Number(before.targetPremium) === Number(trade.targetPremium);
  const sameSl =
    (before.stopLossPremium == null && trade.stopLossPremium == null)
    || Number(before.stopLossPremium) === Number(trade.stopLossPremium);
  const sameLadder =
    before.milestoneCount === (Array.isArray(trade.targetMilestones) ? trade.targetMilestones.length : 0)
    && Number(before.firstRung) === Number(trade.targetMilestones?.[0]?.points);
  if (sameTarget && sameSl && sameLadder && before.milestoneCount > 0) {
    cacheOpenTradeLite(trade);
    return { ok: true, updated: 0 };
  }
  const noteBit = `exits_reapplied=${reason}; ${TRAIL_NOTE}; spotSl=${trade.spotStopLoss ?? 'off'}`;
  trade.notes = [trade.notes, noteBit].filter(Boolean).join(' | ').slice(0, 500);
  await trade.save();
  cacheOpenTradeLite(trade);
  publishLiveMarkSnapshot();
  logEntry('EXITS_REAPPLIED', {
    tradeId: trade._id.toString(),
    entry: trade.entryPremium,
    before,
    targetPremium: trade.targetPremium,
    targetMilestones: serializeMilestones(trade.targetMilestones),
    reason,
  });
  return { ok: true, updated: 1 };
}

async function startEngine({ symbol = 'NIFTY', settings = {} } = {}) {
  if (engineState.running) {
    if (settings && Object.keys(settings).length > 0) {
      engineState.settings = normalizeSettings({ ...engineState.settings, ...settings });
      syncEngineSymbolFromSettings();
      await reapplyExitPointsToOpenTrade({ reason: 'SETTINGS_WHILE_RUNNING' });
    }
    return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
  }
  engineState.symbol = String(symbol).toUpperCase();
  engineState.settings = normalizeSettings({
    ...engineState.settings,
    ...settings,
    symbol: settings.symbol || symbol,
  });
  syncEngineSymbolFromSettings();
  engineState.lastError = null;
  logEntry('ENGINE_START', { symbol: getEngineSymbol(), settings: engineState.settings });
  try {
    engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
    const clock = getIstClock(new Date());
    await dedupeOpenTradesInDb(clock);
    engineState.expiry = await getNearestWeeklyExpiry(getEngineSymbol());
    engineState.expiryDateKey = clock.dateKey;
    const orphan = await dedupeOpenTradesInDb(clock);
    if (orphan) {
      engineState.openTradeId = orphan._id.toString();
      await subscribeOpenOption(orphan);
      startPositionPoll();
      await checkOpenTrade();
    }
  } catch (err) {
    engineState.lastError = `OI Strike Flow setup: ${err.message}`;
  }
  engineState.running = true;
  engineState.startedAt = new Date();
  startPoll();
  return { ok: true, state: getEngineSnapshot() };
}

function stopEngine() {
  if (engineState.pollTimer) {
    clearInterval(engineState.pollTimer);
    engineState.pollTimer = null;
  }
  clearOpenTrade();
  engineState.running = false;
  engineState.startedAt = null;
  return { ok: true, state: getEngineSnapshot() };
}

async function updateEngineSettings(partial = {}) {
  const prevSymbol = getEngineSymbol();
  const next = normalizeSettings({ ...engineState.settings, ...partial });
  engineState.settings = next;
  syncEngineSymbolFromSettings();
  if (getEngineSymbol() !== prevSymbol) {
    try {
      engineState.lotSize = await getCurrentLotSize(getEngineSymbol());
      engineState.expiry = null;
      engineState.expiryDateKey = null;
      engineState.futInstrument = null;
      engineState.futExpiry = null;
    } catch (err) {
      engineState.lastError = `Symbol change: ${err.message}`;
    }
  }
  try {
    const wallet = await ensureWallet();
    wallet.strategy18EngineSettings = next;
    wallet.markModified('strategy18EngineSettings');
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Settings persist failed: ${err.message}`;
  }
  await reapplyExitPointsToOpenTrade({ reason: 'SETTINGS_SAVE' });
  return { ok: true, state: getEngineSnapshot() };
}

async function bootEngineFromDb({ symbol = 'NIFTY' } = {}) {
  try {
    const wallet = await ensureWallet();
    const persisted = wallet.strategy18EngineSettings
      ? wallet.strategy18EngineSettings.toObject?.() || wallet.strategy18EngineSettings
      : {};
    const normalized = normalizeSettings({ ...persisted, symbol: persisted.symbol || symbol });
    wallet.strategy18EngineSettings = normalized;
    wallet.markModified('strategy18EngineSettings');
    engineState.flowSignal = loadFlowSignalFromWallet(wallet);
    await wallet.save();
    return startEngine({ symbol: normalized.symbol || symbol, settings: normalized });
  } catch (err) {
    engineState.lastError = `OI Strike Flow boot failed: ${err.message}`;
    return { ok: false, error: err.message };
  }
}

async function resumeOpenPositionFromDb() {
  if (!engineState.running) return { ok: false, reason: 'ENGINE_OFFLINE' };
  const clock = getIstClock(new Date());
  try {
    await syncEngineTradeStateFromDb(clock);
    if (!engineState.openTradeId) return { ok: true, resumed: false, state: getEngineSnapshot() };
    const trade = await LivePaperTrade.findById(engineState.openTradeId);
    if (!trade || trade.exitTime) {
      clearOpenTrade();
      return { ok: true, resumed: false, state: getEngineSnapshot() };
    }
    await subscribeOpenOption(trade);
    if (!engineState.positionPollTimer) startPositionPoll();
    await checkOpenTrade();
  } catch (err) {
    engineState.lastError = `Resume: ${err.message}`;
  }
  return { ok: true, resumed: Boolean(engineState.openTradeId), state: getEngineSnapshot() };
}

async function ensureEngineRunning() {
  if (!engineState.running) return bootEngineFromDb();
  const clock = getIstClock(new Date());
  try {
    const wallet = await ensureWallet();
    if (!engineState.flowSignal) {
      engineState.flowSignal = loadFlowSignalFromWallet(wallet);
    }
  } catch {
    /* ignore */
  }
  await syncEngineTradeStateFromDb(clock);
  if (engineState.openTradeId && !engineState.positionPollTimer) {
    const openInDb = await LivePaperTrade.findById(engineState.openTradeId);
    if (openInDb && !openInDb.exitTime) {
      await subscribeOpenOption(openInDb);
      startPositionPoll();
    }
  }
  return { ok: true, alreadyRunning: true, state: getEngineSnapshot() };
}

function getEngineSnapshot() {
  return {
    running: engineState.running,
    symbol: getEngineSymbol(),
    startedAt: engineState.startedAt,
    lotSize: engineState.lotSize,
    expiry: engineState.expiry,
    settings: {
      ...engineState.settings,
      trailRungs: TRAIL_RUNGS,
      trailPeakGap: PEAK_TRAIL_GAP,
    },
    priceSource: 'SPOT',
    lastFut: engineState.lastFut,
    lastSpot: engineState.lastFut ?? engineState.lastSpot,
    futExpiry: engineState.futExpiry,
    liveSignal: engineState.liveSignal,
    flowSignal: engineState.flowSignal,
    agreeSignal: engineState.flowSignal,
    tradesTodayCount: engineState.tradesTodayCount,
    openTradeId: engineState.openTradeId,
    openPositionMark: engineState.openPositionMark,
    openTradeLite: engineState.openTradeLite,
    scenarioLabel: SCENARIO_LABEL,
    lastError: engineState.lastError,
    lastEntryDebug: engineState.lastEntryDebug,
    lastOiError: engineState.lastOiError,
    lastFutError: engineState.lastFutError,
  };
}

async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  const rows = await LivePaperTrade.find({ strategyKey: STRATEGY_KEY, exitTime: { $ne: null } }).lean();
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

async function reconcileOpenTrades() {
  const clock = getIstClock(new Date());
  await dedupeOpenTradesInDb(clock);
  await syncEngineTradeStateFromDb(clock);
  if (engineState.openTradeId && engineState.running && !engineState.positionPollTimer) {
    const openInDb = await LivePaperTrade.findById(engineState.openTradeId);
    if (openInDb && !openInDb.exitTime) {
      await subscribeOpenOption(openInDb);
      startPositionPoll();
    }
  }
  return { ok: true };
}

async function closeOpenPosition() {
  const clock = getIstClock(new Date());
  await syncEngineTradeStateFromDb(clock);
  if (!engineState.openTradeId) return { ok: false, error: 'No open trade' };
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return { ok: false, error: 'No open trade' };
  const mark = await resolveMarkForOpenTrade(trade, { allowChain: true, forceChain: true });
  await finalizeTrade(trade, {
    exitPremium: mark.optionLtp,
    mark,
    reason: 'MANUAL_CLOSE',
    forceChain: true,
  });
  return { ok: true, state: getEngineSnapshot() };
}

async function refreshOpenPositionMarkForStatus() {
  if (!engineState.openTradeId) return null;
  const current = engineState.openPositionMark;
  if (current?.at) {
    const ageMs = Date.now() - new Date(current.at).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STATUS_MARK_REFRESH_MIN_GAP_MS) {
      publishLiveMarkSnapshot();
      return current;
    }
  }
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return null;
  cacheOpenTradeLite(trade);
  const clock = getIstClock(new Date());
  try {
    await refreshFutPrice({ force: false, clock });
  } catch {
    /* keep last spot */
  }
  const mark = await resolveMarkForOpenTrade(trade, {
    preferTicks: true,
    allowChain: true,
    forceChain: !optionTickIsFresh(),
  });
  return publishOpenMark(trade, mark, clock, { persist: true, forcePersist: false });
}

async function clearDailySkipState() {
  return { ok: true };
}

module.exports = {
  STRATEGY_KEY,
  startEngine,
  stopEngine,
  updateEngineSettings,
  ensureEngineRunning,
  getEngineSnapshot,
  ensureWallet,
  recalcWalletFromTrades,
  reconcileOpenTrades,
  resumeOpenPositionFromDb,
  closeOpenPosition,
  refreshOpenPositionMarkForStatus,
  clearDailySkipState,
  getLiveMarkSnapshot,
};
