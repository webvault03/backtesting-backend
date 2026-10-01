/**
 * Strategy 16 (UI) — Open OI Walls paper live (ΔOI tops).
 * At ~09:15 capture strongest |Put ΔOI| + |Call ΔOI| strikes in lookaround
 * (near-spot flow tops — same rule as the Sep9+ ladder backtest).
 * When spot is within proximity of a wall → buy that strike (Put→CE, Call→PE).
 * One entry stays open until 15:15. Milestone targets +5/+10/+15/+20/+30 are recorded
 * (HIT/MISSED) on that same trade — they do not close the position. No SL. Entry 09:15–10:15.
 */

const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const Strategy16OpenWallDay = require('../models/strategy16OpenWallDay');
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
const { STRATEGY_SIXTEEN_OPEN_OI_WALLS_LIVE_KEY } = require('../strategies/keys');
const { broadcastPaperLive } = require('./realtimeSocket');

const STRATEGY_KEY = STRATEGY_SIXTEEN_OPEN_OI_WALLS_LIVE_KEY;

const WALLET_KEY = 'paper_live_strategy16';
const OPTION_SUBSCRIPTION_KEY = 'engine:strategy16:option';
const LOG_PREFIX = '[OpenOiWallsPaperLive]';
const SCENARIO_LABEL = 'Open OI Walls';

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

const DEFAULT_TRADE_FROM = 555; // 09:15
const DEFAULT_TRADE_TO = 615; // 10:15 morning entries
const DEFAULT_EOD = 915; // 15:15
const DEFAULT_OPEN_CAPTURE = 555; // 09:15
/** Fixed premium-point ladder — recorded on the open trade; never auto-exits. */
const TARGET_LADDER_PTS = [5, 10, 15, 20, 30];
const DEFAULT_TARGET_POINTS = 30; // last ladder rung (settings / display only)
const DEFAULT_PROXIMITY = 25;
const DEFAULT_LOOKAROUND = 12;

function buildTargetMilestones(entryPremium) {
  const entry = Number(entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) return [];
  return TARGET_LADDER_PTS.map((points) => ({
    points,
    premium: Number((entry + points).toFixed(2)),
    status: 'PENDING',
    hitAt: null,
    hitPremium: null,
    pnlAtHit: null,
  }));
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
    lotCount: 5,
    tradeFromTime: '09:15',
    tradeToTime: '10:15',
    eodExitTime: '15:15',
    openCaptureFromTime: '09:15',
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
    tradeFromTime: String(settings.tradeFromTime || '09:15'),
    tradeToTime: String(settings.tradeToTime || '10:15'),
    eodExitTime: String(settings.eodExitTime || '15:15'),
    openCaptureFromTime: String(settings.openCaptureFromTime || settings.eodCaptureFromTime || '09:15'),
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

function openCaptureMin() {
  return parseClockMinutes(engineState.settings.openCaptureFromTime, DEFAULT_OPEN_CAPTURE);
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
    wallet.strategy16OpenWalls = watchlist || null;
    wallet.markModified('strategy16OpenWalls');
    await wallet.save();
  } catch (err) {
    engineState.lastError = `Watchlist persist: ${err.message}`;
  }
  // Durable day archive — wallet can be cleared; backtests need this.
  try {
    if (watchlist?.captureDateKey && Array.isArray(watchlist.walls) && watchlist.walls.length) {
      await Strategy16OpenWallDay.findOneAndUpdate(
        { symbol: getEngineSymbol(), dateKey: String(watchlist.captureDateKey) },
        {
          $set: {
            symbol: getEngineSymbol(),
            dateKey: String(watchlist.captureDateKey),
            capturedAt: watchlist.capturedAt ? new Date(watchlist.capturedAt) : new Date(),
            captureMinutes: openCaptureMin(),
            spotAtCapture: Number.isFinite(Number(watchlist.spotAtCapture))
              ? Number(watchlist.spotAtCapture)
              : null,
            futAtCapture: Number.isFinite(Number(watchlist.futAtCapture))
              ? Number(watchlist.futAtCapture)
              : null,
            expiry: watchlist.expiry || null,
            lookaroundStrikes: Number(engineState.settings.strikeLookaround) || DEFAULT_LOOKAROUND,
            walls: watchlist.walls,
            source: 'live_engine',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    }
  } catch (err) {
    engineState.lastError = `Wall day archive: ${err.message}`;
  }
}

function loadWatchlistFromWallet(wallet) {
  const raw = wallet?.strategy16OpenWalls;
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
    targetMilestones: serializeMilestones(trade.targetMilestones),
    status: 'OPEN',
  };
  return engineState.openTradeLite;
}

function getLiveMarkSnapshot() {
  return {
    strategyId: 'strategy-16',
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
    broadcastPaperLive('strategy-16', payload);
    return;
  }
  if (engineState.liveMarkEmitTimer) return;
  engineState.liveMarkEmitTimer = setTimeout(() => {
    engineState.liveMarkEmitTimer = null;
    engineState.lastLiveMarkEmitAt = Date.now();
    broadcastPaperLive('strategy-16', getLiveMarkSnapshot());
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
    engineState.lastError = `Open OI Walls WS subscribe failed: ${err.message}`;
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
      engineState.lastError = `Open OI Walls position poll: ${err.message}`;
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
 * At ~09:15: strongest |Put ΔOI| (→ buy CE) + strongest |Call ΔOI| (→ buy PE)
 * inside the lookaround window. Matches the ΔOI-tops ladder backtest (near-spot flow).
 */
function buildWallsFromSnapshot(snapshot) {
  const strikes = Array.isArray(snapshot?.strikes) ? snapshot.strikes : [];
  let bestPut = null;
  let bestCall = null;
  for (const row of strikes) {
    const strike = Number(row.strike);
    if (!Number.isFinite(strike)) continue;
    const putChg = Number(row.putChgOi);
    const callChg = Number(row.callChgOi);
    if (Number.isFinite(putChg) && putChg !== 0) {
      const abs = Math.abs(putChg);
      if (!bestPut || abs > bestPut.abs) {
        bestPut = {
          strike,
          side: 'PUT',
          oi: putChg,
          abs,
          optionType: 'CE',
          label: 'doi_put_top',
        };
      }
    }
    if (Number.isFinite(callChg) && callChg !== 0) {
      const abs = Math.abs(callChg);
      if (!bestCall || abs > bestCall.abs) {
        bestCall = {
          strike,
          side: 'CALL',
          oi: callChg,
          abs,
          optionType: 'PE',
          label: 'doi_call_top',
        };
      }
    }
  }
  // Fallback if day-chg missing at open: absolute OI so we still lock walls.
  if (!bestPut || !bestCall) {
    for (const row of strikes) {
      const strike = Number(row.strike);
      if (!Number.isFinite(strike)) continue;
      const putOi = Number(row.putOi);
      const callOi = Number(row.callOi);
      if (
        !bestPut
        && Number.isFinite(putOi)
        && putOi > 0
      ) {
        bestPut = {
          strike,
          side: 'PUT',
          oi: putOi,
          abs: putOi,
          optionType: 'CE',
          label: 'abs_put_fallback',
        };
      } else if (
        bestPut?.label === 'abs_put_fallback'
        && Number.isFinite(putOi)
        && putOi > bestPut.oi
      ) {
        bestPut = {
          strike,
          side: 'PUT',
          oi: putOi,
          abs: putOi,
          optionType: 'CE',
          label: 'abs_put_fallback',
        };
      }
      if (
        !bestCall
        && Number.isFinite(callOi)
        && callOi > 0
      ) {
        bestCall = {
          strike,
          side: 'CALL',
          oi: callOi,
          abs: callOi,
          optionType: 'PE',
          label: 'abs_call_fallback',
        };
      } else if (
        bestCall?.label === 'abs_call_fallback'
        && Number.isFinite(callOi)
        && callOi > bestCall.oi
      ) {
        bestCall = {
          strike,
          side: 'CALL',
          oi: callOi,
          abs: callOi,
          optionType: 'PE',
          label: 'abs_call_fallback',
        };
      }
    }
  }
  const walls = [];
  if (bestPut) {
    const { abs, ...rest } = bestPut;
    walls.push(rest);
  }
  if (bestCall) {
    const { abs, ...rest } = bestCall;
    walls.push(rest);
  }
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
 * Among today's open walls, pick nearest wall within proximity of spot.
 * Put wall → CE · Call wall → PE. No OI-rise filter — walls are fixed at 09:15.
 */
function pickNearOpenWall(watchlist, fut) {
  const walls = Array.isArray(watchlist?.walls) ? watchlist.walls : [];
  const prox = Number(engineState.settings.proximityPoints) || DEFAULT_PROXIMITY;
  let best = null;
  for (const wall of walls) {
    const strike = Number(wall.strike);
    if (!Number.isFinite(strike) || !Number.isFinite(fut)) continue;
    const distance = Math.abs(fut - strike);
    if (distance > prox) continue;
    const candidate = {
      strike,
      side: String(wall.side || '').toUpperCase() === 'CALL' ? 'CALL' : 'PUT',
      optionType: String(wall.optionType || '').toUpperCase() === 'PE' ? 'PE' : 'CE',
      label: wall.label || null,
      eodOi: Number(wall.oi) || null,
      liveOi: Number(wall.oi) || null,
      rise: 0,
      distance: Number(distance.toFixed(1)),
    };
    if (!best || candidate.distance < best.distance) best = candidate;
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

async function maybeCaptureOpenWalls(clock) {
  if (engineState.capturingWalls) return;
  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) return;
  // Capture once from 09:15 through entry window end
  if (clock.minutes < openCaptureMin()) return;
  if (clock.minutes > tradeToMin()) return;

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
      spotAtCapture: Number.isFinite(pack.fut) ? Number(pack.fut) : null,
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
      status: 'WALLS_READY',
      message: `09:15 walls ready · Put ${walls.find((w) => w.side === 'PUT')?.strike || '—'} / Call ${walls.find((w) => w.side === 'CALL')?.strike || '—'}`,
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

/** Same-day open walls only (captured at/after 09:15 today). */
function activeWatchlistForToday(clock) {
  const wl = engineState.watchlist;
  if (!wl || !wl.captureDateKey) return null;
  if (String(wl.captureDateKey) !== clock.dateKey) return null;
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

  if (!wl || wl.captureDateKey !== clock.dateKey) {
    publishLiveSignal({
      ok: true,
      status: clock.minutes < openCaptureMin() ? 'PRE_OPEN' : 'CAPTURING',
      message: clock.minutes < openCaptureMin()
        ? `Waiting for ${engineState.settings.openCaptureFromTime} open OI capture`
        : 'Capturing 09:15 open OI walls…',
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
      message: 'No open walls for today yet',
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
      message: `Outside entry window ${engineState.settings.tradeFromTime}–${engineState.settings.tradeToTime}`,
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

  let liveFut = fut;
  try {
    liveFut = await refreshFutPrice({ clock });
  } catch {
    /* keep */
  }
  const risingWall = pickNearOpenWall(active, liveFut);
  const prox = Number(engineState.settings.proximityPoints) || DEFAULT_PROXIMITY;

  if (!risingWall) {
    publishLiveSignal({
      ok: false,
      status: 'FAR',
      message: `Spot not within ±${prox} of open Put/Call wall`,
      watchlist: active,
      risingWall: null,
      fut: liveFut,
    });
    return engineState.liveSignal;
  }

  publishLiveSignal({
    ok: true,
    status: 'TAKE_ENTRY',
    message: `Ready ${risingWall.optionType} ${risingWall.strike} · dist ${risingWall.distance}`,
    watchlist: active,
    risingWall,
    fut: liveFut,
  });
  return engineState.liveSignal;
}

async function recheckRisingAtFill(clock, intended, fut) {
  const active = activeWatchlistForToday(clock);
  if (!active) return { ok: false, reason: 'NO_WATCHLIST' };
  const liveFut = Number.isFinite(fut) ? fut : await refreshFutPrice({ force: true, clock });
  const rising = pickNearOpenWall(active, liveFut);
  if (!rising) return { ok: false, reason: 'FAR' };
  if (Number(rising.strike) !== Number(intended.strike)) {
    return { ok: false, reason: 'WALL_CHANGED', rising };
  }
  if (String(rising.optionType) !== String(intended.optionType)) {
    return { ok: false, reason: 'SIDE_CHANGED', rising };
  }
  return { ok: true, rising, fut: liveFut };
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
      engineState.lastError = `Open OI Walls: missing ${optionType} premium for ${strike}`;
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
    const milestones = buildTargetMilestones(entryPremium);
    const targetPremium = nextPendingTargetPremium(milestones);

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
      targetPremium: targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
      stopLossMode: null,
      targetMode: 'POINTS',
      targetMilestones: milestones,
      legs: [{ optionType, entryPremium: Number(entryPremium.toFixed(2)) }],
      entryReason: `Buy ${optionType} · Open wall ${strike} · ${wall.side}`,
      notes: `open_oi_walls; priceSource=SPOT; wall=${strike}; side=${wall.side}; oi=${wall.eodOi ?? wall.liveOi}; capture=${engineState.watchlist?.captureDateKey}; ladder=${TARGET_LADDER_PTS.join('/')}; exit=15:15; sl=off`,
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
      targetPremium,
      targetMilestones: serializeMilestones(milestones),
      stopLossPremium: null,
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

    const rising = pickNearOpenWall(active, fut);
    if (!rising) return;

    logEntry('ENTRY_TRIGGER', {
      ist: istClockLabel(clock),
      rising,
      fut,
    });
    await placeLongOption(clock, rising, fut);
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
    engineState.lastError = `Open OI Walls tick check: ${err.message}`;
  });
}

async function recordTargetMilestoneHits(trade, optionLtp) {
  const ltp = Number(optionLtp);
  if (!Number.isFinite(ltp) || ltp <= 0) return false;
  let milestones = Array.isArray(trade.targetMilestones) ? trade.targetMilestones.map((m) => ({ ...m })) : [];
  let seeded = false;
  if (!milestones.length) {
    milestones = buildTargetMilestones(trade.entryPremium);
    if (!milestones.length) return false;
    seeded = true;
  }

  const entry = Number(trade.entryPremium) || 0;
  const qty = Number(trade.qty) || 0;
  const charges = Math.max(0, Number(trade.charges) || 0);
  let changed = seeded;
  const now = new Date();
  const justHit = [];

  milestones = milestones.map((m) => {
    const status = String(m.status || 'PENDING').toUpperCase();
    if (status === 'HIT' || status === 'MISSED') return { ...m, status };
    const level = Number(m.premium);
    if (!Number.isFinite(level) || ltp < level) return { ...m, status: status || 'PENDING' };
    changed = true;
    const hitRow = {
      ...m,
      status: 'HIT',
      hitAt: now,
      hitPremium: Number(ltp.toFixed(2)),
      pnlAtHit: Number(((ltp - entry) * qty - charges).toFixed(2)),
    };
    justHit.push(hitRow.points);
    return hitRow;
  });

  if (!changed) return false;

  trade.targetMilestones = milestones;
  trade.markModified('targetMilestones');
  const nextPrem = nextPendingTargetPremium(milestones);
  if (nextPrem != null) trade.targetPremium = nextPrem;
  trade.targetMode = 'POINTS';
  await trade.save();
  cacheOpenTradeLite(trade);
  publishLiveMarkSnapshot();
  if (justHit.length) {
    logEntry('TARGET_MILESTONE', {
      tradeId: trade._id.toString(),
      optionLtp: ltp,
      hit: justHit,
      milestones: serializeMilestones(milestones),
    });
  }
  return true;
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
  if (mark.source === 'entry' && !isEodExitTime(clock.minutes)) return;

  // Record ladder hits — never close on target. Position runs to day close.
  try {
    await recordTargetMilestoneHits(trade, optionLtp);
  } catch (err) {
    engineState.lastError = `Milestone record: ${err.message}`;
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
    trade.notes = [trade.notes, `exitMark=${markSource}; pnl=${Number(pnl.toFixed(2))}; ladder=${hitSummary}`]
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
    maybeCaptureOpenWalls(clock).catch((err) => {
      engineState.lastError = `Wall capture poll: ${err.message}`;
    });
    refreshLiveSignalStatus(clock).catch((err) => {
      engineState.lastError = `Open OI Walls signal: ${err.message}`;
    });
    evaluateEntry().catch((err) => {
      engineState.lastError = `Open OI Walls entry poll: ${err.message}`;
    });
    checkOpenTrade().catch((err) => {
      engineState.lastError = `Open OI Walls exit poll: ${err.message}`;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

function applyExitPointsFromEntry(trade) {
  const entry = Number(trade.entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) return false;
  let milestones = Array.isArray(trade.targetMilestones) ? trade.targetMilestones : [];
  if (!milestones.length) {
    milestones = buildTargetMilestones(entry);
    trade.targetMilestones = milestones;
    trade.markModified('targetMilestones');
  }
  const nextPrem = nextPendingTargetPremium(milestones);
  trade.targetPremium = nextPrem;
  trade.targetMode = 'POINTS';
  // Open OI Walls: no stop loss — position runs to day close.
  trade.stopLossPremium = null;
  trade.stopLossMode = null;
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
  };
  if (!applyExitPointsFromEntry(trade)) return { ok: true, updated: 0 };
  const sameTarget = Number(before.targetPremium) === Number(trade.targetPremium);
  const sameSl =
    (before.stopLossPremium == null && trade.stopLossPremium == null)
    || Number(before.stopLossPremium) === Number(trade.stopLossPremium);
  const sameLadder = before.milestoneCount === (Array.isArray(trade.targetMilestones) ? trade.targetMilestones.length : 0);
  if (sameTarget && sameSl && sameLadder && before.milestoneCount > 0) {
    cacheOpenTradeLite(trade);
    return { ok: true, updated: 0 };
  }
  const noteBit = `exits_reapplied=${reason}; ladder=${TARGET_LADDER_PTS.join('/')}; sl=off`;
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
    const wallet = await ensureWallet();
    if (!engineState.watchlist) {
      engineState.watchlist = loadWatchlistFromWallet(wallet);
    }
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
    engineState.lastError = `Open OI Walls setup: ${err.message}`;
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
    wallet.strategy16EngineSettings = next;
    wallet.markModified('strategy16EngineSettings');
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
    const persisted = wallet.strategy16EngineSettings
      ? wallet.strategy16EngineSettings.toObject?.() || wallet.strategy16EngineSettings
      : {};
    const normalized = normalizeSettings({ ...persisted, symbol: persisted.symbol || symbol });
    wallet.strategy16EngineSettings = normalized;
    wallet.markModified('strategy16EngineSettings');
    engineState.watchlist = loadWatchlistFromWallet(wallet);
    await wallet.save();
    return startEngine({ symbol: normalized.symbol || symbol, settings: normalized });
  } catch (err) {
    engineState.lastError = `Open OI Walls boot failed: ${err.message}`;
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
