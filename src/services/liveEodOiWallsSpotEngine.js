/**
 * Strategy 15 (UI) — EOD OI Walls Spot paper live.
 * Same as Strategy 14, but master price is Nifty cash/index (not FUT).
 * Capture top Put (support) + Call (resistance) OI walls near close; next session enter
 * when wall OI rises and Nifty spot is within proximity of that strike. No candle confirm.
 * Default target +15 pts · no SL · EOD square-off.
 */

const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const { getIstClock, parseClockMinutes, isWeekendDateKey } = require('../utils/dateTime');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
const {
  getAtmPremiums,
  getOptionChainOiSnapshot,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  resolveOptionInstrument,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
  getIndexLtp,
} = require('./dhanLiveService');
const { STRATEGY_FIFTEEN_EOD_OI_WALLS_SPOT_LIVE_KEY } = require('../strategies/keys');
const { broadcastPaperLive } = require('./realtimeSocket');

const STRATEGY_KEY = STRATEGY_FIFTEEN_EOD_OI_WALLS_SPOT_LIVE_KEY;

const WALLET_KEY = 'paper_live_strategy15';
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy15:option';
const LOG_PREFIX = '[EodOiWallsSpotPaperLive]';
const SCENARIO_LABEL = 'EOD OI Walls Spot';

const POLL_INTERVAL_MS = 2000;
const POSITION_POLL_MS = 1000;
const OPEN_MARK_CHAIN_MIN_GAP_MS = 4000;
const TICK_FRESH_MAX_AGE_MS = 20000;
const STATUS_MARK_REFRESH_MIN_GAP_MS = 750;
const MARK_DB_PERSIST_MIN_GAP_MS = 2000;
const LIVE_MARK_EMIT_MIN_GAP_MS = 400;
const MIN_HOLD_MS = 2000;
const OI_REFRESH_MIN_GAP_MS = 5000;
const FUT_PRICE_REFRESH_MIN_GAP_MS = 2000;

const DEFAULT_TRADE_FROM = 560; // 09:20
const DEFAULT_TRADE_TO = 910; // 15:10
const DEFAULT_EOD = 920; // 15:20
const DEFAULT_EOD_CAPTURE = 915; // 15:15
const DEFAULT_TARGET_POINTS = 15;
const DEFAULT_PROXIMITY = 20;
const DEFAULT_LOOKAROUND = 12;

const engineState = {
  running: false,
  symbol: 'NIFTY',
  startedAt: null,
  lastEntryDebug: null,
  openPositionMark: null,
  lastChainFetchAt: 0,
  settings: {
    symbol: 'NIFTY',
    lotCount: 5,
    tradeFromTime: '09:20',
    tradeToTime: '15:10',
    eodExitTime: '15:20',
    eodCaptureFromTime: '15:15',
    targetPoints: DEFAULT_TARGET_POINTS,
    stopLossPoints: null,
    hasStopLoss: false,
    proximityPoints: DEFAULT_PROXIMITY,
    strikeLookaround: DEFAULT_LOOKAROUND,
    maxTradesPerDay: 1,
    cooldownMinutes: 2,
    perTradeCost: 100,
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
  watchlist: null,
  lastOiSnapshot: null,
  lastOiFetchAt: 0,
  lastOiError: null,
  lastFutError: null,
  tradesTodayCount: 0,
  tradesTodayDateKey: null,
  lastExitAtMs: 0,
  openTradeId: null,
  openTradeLite: null,
  closingTrade: false,
  enteringTrade: false,
  evaluatingEntry: false,
  capturingWalls: false,
  pollTimer: null,
  positionPollTimer: null,
  lastSignalAt: null,
  lastError: null,
  lastMarkPersistAt: 0,
  lastLiveMarkEmitAt: 0,
  liveMarkEmitTimer: null,
};

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

/** Refresh Nifty cash/index LTP into lastFut/lastSpot (master price for proximity). */
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
  const lotCount = Math.max(1, Number(settings.lotCount) || 5);
  const targetRaw = Number(settings.targetPoints ?? settings.targetPct);
  const targetPoints =
    Number.isFinite(targetRaw) && targetRaw > 0 ? Math.min(500, targetRaw) : DEFAULT_TARGET_POINTS;

  let hasStopLoss = false;
  let stopLossPoints = null;
  if (Object.prototype.hasOwnProperty.call(settings, 'stopLossPoints')) {
    const slRaw = settings.stopLossPoints;
    if (slRaw === '' || slRaw === null || slRaw === undefined) {
      hasStopLoss = false;
      stopLossPoints = null;
    } else {
      const n = Number(slRaw);
      if (!Number.isFinite(n) || n <= 0) {
        hasStopLoss = false;
        stopLossPoints = null;
      } else {
        hasStopLoss = true;
        stopLossPoints = Math.min(500, n);
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(settings, 'hasStopLoss')) {
    hasStopLoss = Boolean(settings.hasStopLoss);
    const n = Number(settings.stopLossPoints);
    stopLossPoints = hasStopLoss && Number.isFinite(n) && n > 0 ? Math.min(500, n) : null;
    if (!stopLossPoints) hasStopLoss = false;
  }

  const proximityPoints = Math.max(5, Number(settings.proximityPoints) || DEFAULT_PROXIMITY);
  const strikeLookaround = Math.max(
    1,
    Math.floor(Number(settings.strikeLookaround) || DEFAULT_LOOKAROUND),
  );
  const maxTradesPerDay = Math.max(1, Math.min(30, Math.floor(Number(settings.maxTradesPerDay) || 1)));
  const cooldownMinutes = Math.max(0, Math.min(60, Number(settings.cooldownMinutes) || 2));
  const perTradeCost =
    Number.isFinite(Number(settings.perTradeCost)) && Number(settings.perTradeCost) >= 0
      ? Number(settings.perTradeCost)
      : 100;

  return {
    symbol: String(settings.symbol || 'NIFTY').toUpperCase(),
    lotCount,
    tradeFromTime: String(settings.tradeFromTime || '09:20'),
    tradeToTime: String(settings.tradeToTime || '15:10'),
    eodExitTime: String(settings.eodExitTime || '15:20'),
    eodCaptureFromTime: String(settings.eodCaptureFromTime || '15:15'),
    targetPoints,
    stopLossPoints,
    hasStopLoss,
    proximityPoints,
    strikeLookaround,
    maxTradesPerDay,
    cooldownMinutes,
    perTradeCost,
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

function eodCaptureMin() {
  return parseClockMinutes(engineState.settings.eodCaptureFromTime, DEFAULT_EOD_CAPTURE);
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
  if (!wallet) wallet = await LiveWallet.create({ walletKey: WALLET_KEY });
  if (wallet.startingBalance !== 0 || wallet.balance !== wallet.realizedPnl) {
    wallet.startingBalance = 0;
    wallet.balance = Number(wallet.realizedPnl || 0);
    await wallet.save();
  }
  return wallet;
}

async function persistWatchlist(watchlist) {
  engineState.watchlist = watchlist || null;
  try {
    const wallet = await ensureWallet();
    wallet.strategy15Watchlist = watchlist || null;
    wallet.markModified('strategy15Watchlist');
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Watchlist persist: ${err.message}`;
  }
}

function loadWatchlistFromWallet(wallet) {
  const raw = wallet?.strategy15Watchlist;
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
    status: 'OPEN',
  };
  return engineState.openTradeLite;
}

function getLiveMarkSnapshot() {
  return {
    strategyId: 'strategy-15',
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
    broadcastPaperLive('strategy-15', payload);
    return;
  }
  if (engineState.liveMarkEmitTimer) return;
  engineState.liveMarkEmitTimer = setTimeout(() => {
    engineState.liveMarkEmitTimer = null;
    engineState.lastLiveMarkEmitAt = Date.now();
    broadcastPaperLive('strategy-15', getLiveMarkSnapshot());
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
    engineState.lastError = `EOD OI Walls WS subscribe failed: ${err.message}`;
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
      engineState.lastError = `EOD OI Walls position poll: ${err.message}`;
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

/**
 * Top 2 walls near Nifty spot: strongest Put OI (support → buy CE) + strongest Call OI (resistance → buy PE).
 */
function buildWallsFromSnapshot(snapshot) {
  const strikes = Array.isArray(snapshot?.strikes) ? snapshot.strikes : [];
  let bestPut = null;
  let bestCall = null;
  for (const row of strikes) {
    const strike = Number(row.strike);
    if (!Number.isFinite(strike)) continue;
    const putOi = Number(row.putOi);
    const callOi = Number(row.callOi);
    if (Number.isFinite(putOi) && putOi > 0 && (!bestPut || putOi > bestPut.oi)) {
      bestPut = {
        strike,
        side: 'PUT',
        oi: putOi,
        optionType: 'CE',
        label: 'support',
      };
    }
    if (Number.isFinite(callOi) && callOi > 0 && (!bestCall || callOi > bestCall.oi)) {
      bestCall = {
        strike,
        side: 'CALL',
        oi: callOi,
        optionType: 'PE',
        label: 'resistance',
      };
    }
  }
  const walls = [];
  if (bestPut) walls.push(bestPut);
  if (bestCall) walls.push(bestCall);
  return walls;
}

function liveOiForWall(row, wall) {
  if (!row || !wall) return null;
  const side = String(wall.side || '').toUpperCase();
  if (side === 'PUT') {
    const n = Number(row.putOi);
    return Number.isFinite(n) ? n : null;
  }
  if (side === 'CALL') {
    const n = Number(row.callOi);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function findStrikeRow(snapshot, strike) {
  const target = Number(strike);
  if (!Number.isFinite(target)) return null;
  const strikes = Array.isArray(snapshot?.strikes) ? snapshot.strikes : [];
  return strikes.find((r) => Number(r.strike) === target) || null;
}

/**
 * Among rising walls (liveOi > eod oi), pick largest rise. Attach distance to Nifty spot.
 */
function pickRisingWall(watchlist, snapshot, fut) {
  const walls = Array.isArray(watchlist?.walls) ? watchlist.walls : [];
  let best = null;
  for (const wall of walls) {
    const eodOi = Number(wall.oi);
    if (!Number.isFinite(eodOi)) continue;
    const row = findStrikeRow(snapshot, wall.strike);
    const liveOi = liveOiForWall(row, wall);
    if (!Number.isFinite(liveOi)) continue;
    if (!(liveOi > eodOi)) continue;
    const rise = liveOi - eodOi;
    const distance = Number.isFinite(fut) ? Math.abs(fut - Number(wall.strike)) : null;
    const candidate = {
      strike: Number(wall.strike),
      side: String(wall.side || '').toUpperCase() === 'CALL' ? 'CALL' : 'PUT',
      optionType: String(wall.optionType || '').toUpperCase() === 'PE' ? 'PE' : 'CE',
      label: wall.label || null,
      eodOi,
      liveOi,
      rise,
      distance: Number.isFinite(distance) ? Number(distance.toFixed(1)) : null,
    };
    if (!best || candidate.rise > best.rise) best = candidate;
  }
  return best;
}

function publishLiveSignal(next) {
  const futFallback = Number.isFinite(engineState.lastFut) ? engineState.lastFut : null;
  engineState.liveSignal = {
    ok: Boolean(next.ok),
    status: next.status || 'WATCHING',
    message: next.message || '',
    watchlist: next.watchlist !== undefined ? next.watchlist : engineState.watchlist,
    risingWall: next.risingWall !== undefined ? next.risingWall : null,
    fut: next.fut !== undefined ? next.fut : futFallback,
    at: new Date().toISOString(),
  };
  publishLiveMarkSnapshot();
}

async function fetchOiSnapshot(clock, { force = false, futLtp = null } = {}) {
  const now = Date.now();
  if (
    !force
    && engineState.lastOiSnapshot
    && now - engineState.lastOiFetchAt < OI_REFRESH_MIN_GAP_MS
  ) {
    return {
      snapshot: engineState.lastOiSnapshot,
      expiry: engineState.expiry,
      fut: Number.isFinite(futLtp) ? futLtp : engineState.lastFut,
      cached: true,
    };
  }
  const symbol = getEngineSymbol();
  const expiry = await getEntryExpiry(symbol, clock.dateKey);
  if (!expiry) {
    engineState.lastOiError = 'No weekly expiry from Dhan';
    return engineState.lastOiSnapshot
      ? { snapshot: engineState.lastOiSnapshot, expiry: engineState.expiry, fut: engineState.lastFut, cached: true }
      : null;
  }
  let fut = futLtp;
  if (!Number.isFinite(fut)) {
    try {
      fut = await refreshFutPrice({ clock });
    } catch (err) {
      engineState.lastFutError = err.message || 'Spot price failed';
    }
  }
  const snapshot = await getOptionChainOiSnapshot({
    symbol,
    expiry,
    lookaroundStrikes: Number(engineState.settings.strikeLookaround) || DEFAULT_LOOKAROUND,
    spotOverride: Number.isFinite(fut) ? fut : null,
  });
  engineState.lastOiFetchAt = Date.now();
  engineState.lastOiError = null;
  engineState.lastOiSnapshot = snapshot;
  if (Number.isFinite(snapshot.chainSpot)) engineState.chainSpot = snapshot.chainSpot;
  if (Number.isFinite(fut)) {
    engineState.lastFut = fut;
    engineState.lastSpot = fut;
  }
  return { snapshot, expiry, fut };
}

async function maybeCaptureEodWalls(clock) {
  if (engineState.capturingWalls) return;
  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) return;
  if (clock.minutes < eodCaptureMin()) return;

  const existing = engineState.watchlist;
  if (existing?.captureDateKey === clock.dateKey && Array.isArray(existing.walls) && existing.walls.length > 0) {
    return;
  }

  engineState.capturingWalls = true;
  try {
    const pack = await fetchOiSnapshot(clock, { force: true });
    if (!pack?.snapshot) {
      logEntry('WALL_CAPTURE_SKIP', {
        ist: istClockLabel(clock),
        reason: engineState.lastOiError || 'NO_SNAPSHOT',
      });
      return;
    }
    const walls = buildWallsFromSnapshot(pack.snapshot);
    if (walls.length === 0) {
      logEntry('WALL_CAPTURE_EMPTY', { ist: istClockLabel(clock), fut: pack.fut });
      return;
    }
    const watchlist = {
      captureDateKey: clock.dateKey,
      capturedAt: new Date().toISOString(),
      futAtCapture: Number.isFinite(pack.fut) ? Number(pack.fut) : null,
      expiry: pack.expiry,
      walls,
    };
    await persistWatchlist(watchlist);
    logEntry('WALL_CAPTURE_OK', {
      ist: istClockLabel(clock),
      walls,
      fut: pack.fut,
      expiry: pack.expiry,
    });
    publishLiveSignal({
      ok: true,
      status: 'WAITING_WALLS',
      message: `Captured ${walls.length} wall(s) for next session`,
      watchlist,
      risingWall: null,
      fut: pack.fut,
    });
  } catch (err) {
    engineState.lastOiError = err.message || 'Wall capture failed';
    engineState.lastError = `Wall capture: ${engineState.lastOiError}`;
    logEntry('WALL_CAPTURE_ERROR', { ist: istClockLabel(clock), error: engineState.lastOiError });
  } finally {
    engineState.capturingWalls = false;
  }
}

function activeWatchlistForToday(clock) {
  const wl = engineState.watchlist;
  if (!wl || !wl.captureDateKey) return null;
  if (String(wl.captureDateKey) >= clock.dateKey) return null;
  if (!Array.isArray(wl.walls) || wl.walls.length === 0) return null;
  return wl;
}

async function refreshLiveSignalStatus(clock) {
  const fut = Number.isFinite(engineState.lastFut) ? engineState.lastFut : null;
  const wl = engineState.watchlist;

  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) {
    publishLiveSignal({
      ok: false,
      status: 'HOLIDAY',
      message: isWeekendDateKey(clock.dateKey)
        ? 'Weekend — markets closed'
        : `Holiday — ${getNseHolidayDescription(clock.dateKey) || 'NSE closed'}`,
      watchlist: wl,
      risingWall: null,
      fut,
    });
    return engineState.liveSignal;
  }

  if (engineState.openTradeId) {
    publishLiveSignal({
      ok: true,
      status: 'HOLDING',
      message: 'Position open',
      watchlist: wl,
      risingWall: null,
      fut,
    });
    return engineState.liveSignal;
  }

  if (clock.minutes >= eodCaptureMin()) {
    const capturedToday = wl?.captureDateKey === clock.dateKey;
    publishLiveSignal({
      ok: true,
      status: capturedToday ? 'WAITING_WALLS' : 'WATCHING',
      message: capturedToday
        ? `Walls captured for ${wl.captureDateKey} — awaiting next session`
        : 'Capturing EOD walls…',
      watchlist: wl,
      risingWall: null,
      fut,
    });
    return engineState.liveSignal;
  }

  const active = activeWatchlistForToday(clock);
  if (!active) {
    publishLiveSignal({
      ok: false,
      status: 'WAITING_WALLS',
      message: wl?.captureDateKey === clock.dateKey
        ? 'Today\'s walls ready for next trading day'
        : 'No prior-day walls yet',
      watchlist: wl,
      risingWall: null,
      fut,
    });
    return engineState.liveSignal;
  }

  if (clock.minutes < tradeFromMin() || clock.minutes > tradeToMin()) {
    publishLiveSignal({
      ok: false,
      status: 'WATCHING',
      message: `Outside trade window ${engineState.settings.tradeFromTime}–${engineState.settings.tradeToTime}`,
      watchlist: active,
      risingWall: null,
      fut,
    });
    return engineState.liveSignal;
  }

  if (engineState.tradesTodayCount >= engineState.settings.maxTradesPerDay) {
    publishLiveSignal({
      ok: false,
      status: 'MAXED',
      message: `${engineState.tradesTodayCount}/${engineState.settings.maxTradesPerDay} trades done`,
      watchlist: active,
      risingWall: null,
      fut,
    });
    return engineState.liveSignal;
  }

  let pack = null;
  try {
    pack = await fetchOiSnapshot(clock, { futLtp: fut });
  } catch (err) {
    engineState.lastOiError = err.message || 'OI refresh failed';
  }
  const snapshot = pack?.snapshot;
  const liveFut = Number.isFinite(pack?.fut) ? pack.fut : fut;
  const risingWall = snapshot ? pickRisingWall(active, snapshot, liveFut) : null;
  const prox = Number(engineState.settings.proximityPoints) || DEFAULT_PROXIMITY;

  if (!risingWall) {
    publishLiveSignal({
      ok: false,
      status: 'NO_RISE',
      message: 'No wall with rising OI vs EOD capture',
      watchlist: active,
      risingWall: null,
      fut: liveFut,
    });
    return engineState.liveSignal;
  }

  if (!Number.isFinite(risingWall.distance) || risingWall.distance > prox) {
    publishLiveSignal({
      ok: false,
      status: 'FAR',
      message: `Rising wall ${risingWall.strike} · dist ${risingWall.distance ?? 'n/a'} > ${prox}`,
      watchlist: active,
      risingWall,
      fut: liveFut,
    });
    return engineState.liveSignal;
  }

  publishLiveSignal({
    ok: true,
    status: 'READY',
    message: `Ready ${risingWall.optionType} ${risingWall.strike} · rise ${Math.round(risingWall.rise)}`,
    watchlist: active,
    risingWall,
    fut: liveFut,
  });
  return engineState.liveSignal;
}

async function recheckRisingAtFill(clock, intended, fut) {
  const active = activeWatchlistForToday(clock);
  if (!active) return { ok: false, reason: 'NO_WATCHLIST' };
  const pack = await fetchOiSnapshot(clock, { force: true, futLtp: fut });
  if (!pack?.snapshot) return { ok: false, reason: 'OI_UNAVAILABLE' };
  const rising = pickRisingWall(active, pack.snapshot, pack.fut ?? fut);
  if (!rising) return { ok: false, reason: 'NO_RISE' };
  if (Number(rising.strike) !== Number(intended.strike)) {
    return { ok: false, reason: 'WALL_CHANGED', rising };
  }
  if (String(rising.optionType) !== String(intended.optionType)) {
    return { ok: false, reason: 'SIDE_CHANGED', rising };
  }
  const prox = Number(engineState.settings.proximityPoints) || DEFAULT_PROXIMITY;
  const dist = Math.abs(Number(pack.fut ?? fut) - Number(rising.strike));
  if (!Number.isFinite(dist) || dist > prox) {
    return { ok: false, reason: 'PROXIMITY_LOST', rising, dist };
  }
  return { ok: true, rising, fut: pack.fut ?? fut };
}

async function placeLongOption(clock, risingWall, spot) {
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

    const prox = Number(engineState.settings.proximityPoints) || DEFAULT_PROXIMITY;
    const dist = Math.abs(fillSpot - Number(risingWall.strike));
    if (dist > prox) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'PROXIMITY_LOST_AT_FILL',
        fut: fillSpot,
        strike: risingWall.strike,
        dist: Number(dist.toFixed(1)),
        need: prox,
      });
      return;
    }

    let fillCheck;
    try {
      fillCheck = await recheckRisingAtFill(clock, risingWall, fillSpot);
    } catch (err) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'OI_RECHECK_FAILED',
        atPlace: true,
        error: err.message,
      });
      return;
    }
    if (!fillCheck.ok) {
      logEntry('ENTRY_SKIP_RECHECK', {
        ist: istClockLabel(clock),
        reason: fillCheck.reason,
        intended: risingWall,
        atPlace: true,
      });
      return;
    }
    const wall = fillCheck.rising || risingWall;
    if (Number.isFinite(fillCheck.fut)) {
      fillSpot = fillCheck.fut;
      engineState.lastFut = fillSpot;
      engineState.lastSpot = fillSpot;
    }

    const symbol = getEngineSymbol();
    const optionType = wall.optionType === 'PE' ? 'PE' : 'CE';
    const strike = Number(wall.strike);
    if (!Number.isFinite(strike)) {
      logEntry('ENTRY_SKIP', { ist: istClockLabel(clock), reason: 'BAD_STRIKE', wall });
      return;
    }
    const expiry = await getEntryExpiry(symbol, clock.dateKey);
    const premiums = await getAtmPremiums({ symbol, strike, expiry });
    const entryPremium = premiumFromChain(premiums, optionType);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      engineState.lastError = `EOD OI Walls: missing ${optionType} premium for ${strike}`;
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
    const lastDist = Math.abs(fillSpot - strike);
    if (lastDist > prox) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'PROXIMITY_LOST_AFTER_PREMIUM',
        fut: fillSpot,
        strike,
        dist: Number(lastDist.toFixed(1)),
        need: prox,
      });
      return;
    }

    // Final rising re-check after premium fetch latency.
    try {
      const lateCheck = await recheckRisingAtFill(clock, wall, fillSpot);
      if (!lateCheck.ok) {
        logEntry('ENTRY_SKIP_RECHECK', {
          ist: istClockLabel(clock),
          reason: lateCheck.reason,
          afterPremium: true,
        });
        return;
      }
    } catch (err) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'OI_RECHECK_AFTER_PREMIUM_FAILED',
        error: err.message,
      });
      return;
    }

    const lotSize = engineState.lotSize || (await getCurrentLotSize(symbol));
    engineState.lotSize = lotSize;
    const lots = Math.max(1, Number(engineState.settings.lotCount) || 5);
    const qty = lotSize * lots;
    const invested = entryPremium * qty;
    const charges = engineState.settings.perTradeCost;
    const targetPoints = engineState.settings.targetPoints;
    const hasSl = engineState.settings.hasStopLoss;
    const stopLossPoints = engineState.settings.stopLossPoints;
    const targetPremium = entryPremium + targetPoints;
    const stopLossPremium = hasSl && Number.isFinite(stopLossPoints) && stopLossPoints > 0
      ? Math.max(0.05, entryPremium - stopLossPoints)
      : null;

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
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossMode: hasSl ? 'POINTS' : null,
      targetMode: 'POINTS',
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason: `Buy ${optionType} · EOD wall ${strike} · ${wall.side} · rise ${Math.round(wall.rise || 0)}`,
      notes: `eod_oi_walls_spot; priceSource=SPOT; wall=${strike}; side=${wall.side}; eodOi=${wall.eodOi}; liveOi=${wall.liveOi}; rise=${wall.rise}; capture=${engineState.watchlist?.captureDateKey}; tg=${targetPoints}pts; sl=${hasSl ? `${stopLossPoints}pts` : 'off'}`,
    });

    engineState.openTradeId = tradeDoc._id.toString();
    engineState.tradesTodayCount += 1;
    engineState.tradesTodayDateKey = clock.dateKey;
    engineState.lastSignalAt = new Date();
    logEntry('ENTRY_SUCCESS', {
      ist: istClockLabel(clock),
      tradeId: tradeDoc._id.toString(),
      optionType,
      strike,
      wall,
      entryPremium: Number(entryPremium.toFixed(2)),
      targetPremium: Number(targetPremium.toFixed(2)),
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
    });
    publishLiveSignal({
      ok: true,
      status: 'ENTERED',
      message: `Entered ${optionType} ${strike}`,
      watchlist: engineState.watchlist,
      risingWall: wall,
      fut: fillSpot,
    });
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

    const active = activeWatchlistForToday(clock);
    if (!active) return;

    let fut;
    try {
      fut = await refreshFutPrice({ clock });
    } catch (err) {
      engineState.lastError = `SPOT: ${err.message}`;
      return;
    }

    let pack;
    try {
      pack = await fetchOiSnapshot(clock, { futLtp: fut });
    } catch (err) {
      engineState.lastOiError = err.message || 'OI failed';
      return;
    }
    if (!pack?.snapshot) return;

    const rising = pickRisingWall(active, pack.snapshot, pack.fut ?? fut);
    if (!rising) return;

    const prox = Number(engineState.settings.proximityPoints) || DEFAULT_PROXIMITY;
    if (!Number.isFinite(rising.distance) || rising.distance > prox) {
      logEntry('ENTRY_SKIP', {
        ist: istClockLabel(clock),
        reason: 'FAR',
        rising,
        need: prox,
      });
      return;
    }

    logEntry('ENTRY_TRIGGER', {
      ist: istClockLabel(clock),
      rising,
      fut: pack.fut ?? fut,
    });
    await placeLongOption(clock, rising, pack.fut ?? fut);
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
    engineState.lastError = `EOD OI Walls tick check: ${err.message}`;
  });
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
  if (mark.source === 'entry' && !isEodExitTime(clock.minutes)) return;

  if (trade.stopLossPremium != null && optionLtp <= Number(trade.stopLossPremium)) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.stopLossPremium),
      mark,
      reason: 'STOP_LOSS',
    });
    return;
  }
  if (trade.targetPremium != null && optionLtp >= Number(trade.targetPremium)) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.targetPremium),
      mark,
      reason: 'TARGET',
    });
    return;
  }
  if (isEodExitTime(clock.minutes)) {
    await finalizeTrade(trade, {
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
    trade.notes = [trade.notes, `exitMark=${markSource}; pnl=${Number(pnl.toFixed(2))}`]
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
    maybeCaptureEodWalls(clock).catch((err) => {
      engineState.lastError = `Wall capture poll: ${err.message}`;
    });
    refreshLiveSignalStatus(clock).catch((err) => {
      engineState.lastError = `EOD OI Walls signal: ${err.message}`;
    });
    evaluateEntry().catch((err) => {
      engineState.lastError = `EOD OI Walls entry poll: ${err.message}`;
    });
    checkOpenTrade().catch((err) => {
      engineState.lastError = `EOD OI Walls exit poll: ${err.message}`;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

function applyExitPointsFromEntry(trade) {
  const entry = Number(trade.entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) return false;
  const targetPoints = Number(engineState.settings.targetPoints);
  const hasSl = Boolean(engineState.settings.hasStopLoss);
  const stopLossPoints = Number(engineState.settings.stopLossPoints);
  trade.targetPremium = Number((entry + targetPoints).toFixed(2));
  trade.targetMode = 'POINTS';
  if (hasSl && Number.isFinite(stopLossPoints) && stopLossPoints > 0) {
    trade.stopLossPremium = Number(Math.max(0.05, entry - stopLossPoints).toFixed(2));
    trade.stopLossMode = 'POINTS';
  } else {
    trade.stopLossPremium = null;
    trade.stopLossMode = null;
  }
  return true;
}

async function reapplyExitPointsToOpenTrade({ reason = 'SETTINGS' } = {}) {
  if (!engineState.openTradeId) return { ok: true, updated: 0 };
  const trade = await LivePaperTrade.findById(engineState.openTradeId);
  if (!trade || trade.exitTime) return { ok: true, updated: 0 };
  const before = {
    targetPremium: trade.targetPremium,
    stopLossPremium: trade.stopLossPremium,
  };
  if (!applyExitPointsFromEntry(trade)) return { ok: true, updated: 0 };
  const sameTarget = Number(before.targetPremium) === Number(trade.targetPremium);
  const sameSl =
    (before.stopLossPremium == null && trade.stopLossPremium == null)
    || Number(before.stopLossPremium) === Number(trade.stopLossPremium);
  if (sameTarget && sameSl) {
    cacheOpenTradeLite(trade);
    return { ok: true, updated: 0 };
  }
  const s = engineState.settings;
  const noteBit = `exits_reapplied=${reason}; tg=${s.targetPoints} sl=${s.hasStopLoss ? s.stopLossPoints : 'off'}`;
  trade.notes = [trade.notes, noteBit].filter(Boolean).join(' | ').slice(0, 500);
  await trade.save();
  cacheOpenTradeLite(trade);
  publishLiveMarkSnapshot();
  logEntry('EXITS_REAPPLIED', {
    tradeId: trade._id.toString(),
    entry: trade.entryPremium,
    before,
    targetPremium: trade.targetPremium,
    stopLossPremium: trade.stopLossPremium,
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
    engineState.lastError = `EOD OI Walls setup: ${err.message}`;
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
    wallet.strategy15EngineSettings = next;
    wallet.markModified('strategy15EngineSettings');
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
    const persisted = wallet.strategy15EngineSettings
      ? wallet.strategy15EngineSettings.toObject?.() || wallet.strategy15EngineSettings
      : {};
    const normalized = normalizeSettings({ ...persisted, symbol: persisted.symbol || symbol });
    wallet.strategy15EngineSettings = normalized;
    wallet.markModified('strategy15EngineSettings');
    engineState.watchlist = loadWatchlistFromWallet(wallet);
    await wallet.save();
    return startEngine({ symbol: normalized.symbol || symbol, settings: normalized });
  } catch (err) {
    engineState.lastError = `EOD OI Walls boot failed: ${err.message}`;
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
    if (!engineState.watchlist) {
      engineState.watchlist = loadWatchlistFromWallet(wallet);
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
    settings: engineState.settings,
    priceSource: 'SPOT',
    lastFut: engineState.lastFut,
    lastSpot: engineState.lastFut ?? engineState.lastSpot,
    futExpiry: engineState.futExpiry,
    liveSignal: engineState.liveSignal,
    watchlist: engineState.watchlist,
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
