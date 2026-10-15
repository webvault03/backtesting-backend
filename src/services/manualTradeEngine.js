/**
 * Personal manual trading console — paper long CE/PE with market/limit entry,
 * optional SL/target, EOD exit, action logging.
 */
const { AsyncLocalStorage } = require('async_hooks');
const LivePaperTrade = require('../models/livePaperTrade');
const LiveWallet = require('../models/liveWallet');
const ManualPendingOrder = require('../models/manualPendingOrder');
const ManualTradeAction = require('../models/manualTradeAction');
const { MANUAL_CONSOLE_LIVE_KEY, MANUAL_STOCK_LIVE_KEY } = require('../strategies/keys');
const { getIstClock, isWeekendDateKey } = require('../utils/dateTime');
const { getStrikeStep } = require('../utils/market');
const {
  ensureNseHolidaysLoaded,
  isNseCashTradingDay,
  getNseHolidayDescription,
} = require('./nseHolidayService');
const {
  getAtmPremiums,
  getCurrentLotSize,
  getNearestWeeklyExpiry,
  fetchExpiryList,
  fetchOptionChainCached,
  getOptionChainOiSnapshot,
  listFutureUnderlyings,
  getFutureLtp,
  getFutureQuote,
  isTradableStockUnderlying,
  resolveOptionInstrument,
  resolveFutureInstrument,
  fetchInstrumentLtp,
  subscribeLiveInstrument,
  unsubscribeLiveSymbol,
  getLastPrice,
} = require('./dhanLiveService');

/** Dual desks: index options (day-close) + stock options (carry forward, exit at expiry). Separate strategyKey + walletKey. */
const DESK_INDEX = {
  strategyKey: MANUAL_CONSOLE_LIVE_KEY,
  walletKey: 'paper_live_manual',
  dayClose: true,
  strategyId: 'manual-console',
  label: 'Index Manual',
};
const DESK_STOCK = {
  strategyKey: MANUAL_STOCK_LIVE_KEY,
  walletKey: 'paper_live_manual_stock',
  dayClose: false,
  strategyId: 'manual-stock',
  label: 'Stock Manual',
};

const DESKS = { index: DESK_INDEX, stock: DESK_STOCK };
const DESK_NAMES = { index: 'index', stock: 'stock' };

/** Per-request desk isolation so concurrent index/stock HTTP + poll never share the wrong wallet. */
const deskAls = new AsyncLocalStorage();

const engineState = {
  running: false,
  startedAt: null,
  loopTimer: null,
  tickInFlight: false,
  desk: 'index',
  strategyKey: DESK_INDEX.strategyKey,
  walletKey: DESK_INDEX.walletKey,
  dayClose: DESK_INDEX.dayClose,
  strategyId: DESK_INDEX.strategyId,
  label: DESK_INDEX.label,
  symbol: 'NIFTY',
  dateKey: null,
  lastMinutes: null,
  lastError: null,
  lastFetchedAt: null,
  lastRow: null,
  expiry: null,
  lastPollAt: null,
  pollTimer: null,
  lastLiveMarkEmitAt: 0,
  liveMarkEmitTimer: null,
};

/** Engine loop is cheap once marks come from WS — keep snappy for SL/TG + UI marks. */
const POLL_INTERVAL_MS = 1000;
const EOD_EXIT = 920; // 15:20 IST
const MIN_HOLD_MS = 5000;
const WS_FRESH_MS = 12000;
const CLOSED_STATS_SYNC_MS = 5 * 60 * 1000;
const REPAIR_TESTING_MS = 10 * 60 * 1000;
/** Per-desk timers so index/stock wallets stay independent. */
const lastClosedStatsSyncAtByDesk = Object.create(null);
const lastRepairTestingAtByDesk = Object.create(null);
const LIVE_MARK_EMIT_MIN_GAP_MS = 400;
const ALLOWED_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY']);
/** Index desk only — stock FUT is on the separate Stock Manual desk. */
const INDEX_SYMBOLS = ALLOWED_SYMBOLS;
/** Virtual top-up presets (paper only — not real money). */
const TOPUP_AMOUNTS = Object.freeze([5000, 10000, 50000]);
/** Custom top-up must be greater than this (presets may equal min). */
const MIN_CUSTOM_TOPUP = 5000;
const MAX_TOPUP = 1000000;
const MAX_DEPOSIT_HISTORY = 100;
/** Futures: lock ~12% of notional so ₹5k/10k/50k top-ups remain usable. */
const FUTURE_MARGIN_PCT = 0.12;

function parseIsTesting(value) {
  return value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true';
}

function resolveDeskName(deskName) {
  const raw = deskName || deskAls.getStore() || engineState.desk || 'index';
  return DESKS[raw] ? raw : 'index';
}

function getDeskConfig(deskName) {
  return DESKS[resolveDeskName(deskName)] || DESK_INDEX;
}

function getStrategyKey() {
  return getDeskConfig().strategyKey;
}

function getWalletKey() {
  return getDeskConfig().walletKey;
}

function getDayCloseEnabled() {
  return Boolean(getDeskConfig().dayClose);
}

function getStrategyId() {
  return getDeskConfig().strategyId;
}

function selectDesk(deskName = 'index') {
  const name = resolveDeskName(deskName);
  const desk = DESKS[name] || DESK_INDEX;
  engineState.desk = name;
  engineState.strategyKey = desk.strategyKey;
  engineState.walletKey = desk.walletKey;
  engineState.dayClose = desk.dayClose;
  engineState.strategyId = desk.strategyId;
  engineState.label = desk.label;
  return desk;
}

/** Run async work bound to a desk — safe under concurrent index/stock requests. */
function runWithDesk(deskName, fn) {
  const name = resolveDeskName(deskName);
  selectDesk(name);
  return deskAls.run(name, fn);
}

/**
 * Testing is excluded from main available cash / wallet P/L / calendar.
 * Explicit isTesting flag wins; notes may still carry "; testing=1" for legacy rows.
 */
function isTestingTrade(trade) {
  if (!trade) return false;
  if (trade.isTesting === true) return true;
  if (trade.isTesting === false) return false;
  const notes = String(trade.notes || '');
  return /testing\s*=\s*1/i.test(notes);
}

function isMainTrade(trade) {
  return !isTestingTrade(trade);
}

/**
 * Repair testing flags so main book never mixes testing into wallet P/L.
 * - notes with testing=1 → isTesting true
 * - open/closed without testing notes → isTesting false (main)
 */
async function repairTestingFlags() {
  const strategyKey = getStrategyKey();
  const testingNotes = await LivePaperTrade.find({
    strategyKey,
    notes: { $regex: /testing\s*=\s*1/i },
  })
    .select({ _id: 1, isTesting: 1, notes: 1 })
    .lean();
  const testingIds = testingNotes
    .filter((t) => t.isTesting !== true)
    .map((t) => t._id);

  // Main trades: ensure explicit false so book filters stay stable.
  const mainIds = await LivePaperTrade.find({
    strategyKey,
    isTesting: { $exists: false },
    notes: { $not: { $regex: /testing\s*=\s*1/i } },
  })
    .select({ _id: 1 })
    .limit(5000)
    .lean()
    .then((rows) => rows.map((t) => t._id));

  if (testingIds.length) {
    await LivePaperTrade.updateMany(
      { _id: { $in: testingIds }, isTesting: { $ne: true } },
      { $set: { isTesting: true } },
    );
  }
  if (mainIds.length) {
    await LivePaperTrade.updateMany(
      { _id: { $in: mainIds }, isTesting: { $ne: false } },
      { $set: { isTesting: false } },
    );
  }
  return { taggedTesting: testingIds.length, taggedMain: mainIds.length };
}

// engineState already defined above with desk + running fields.
// Keep poll/timer fields here-compatible by extending the primary engineState.

/** tradeId -> { key, lastTick: { ltp, ts }, instrument, tradeLite } */
const liveSubs = new Map();
const tickExitInflight = new Set();
const markPersistAt = new Map();
/** tradeId -> latest openPositionMark (in-memory for instant UI) */
const latestMarks = new Map();
const MARK_PERSIST_MIN_MS = 2000;
const OI_BOARD_CACHE_MS = 3500;
const oiBoardMemo = new Map();

const { broadcastPaperLive } = require('./realtimeSocket');

function istLabel(clock) {
  const h = Math.floor(clock.minutes / 60);
  const m = clock.minutes % 60;
  return `${clock.dateKey} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} IST`;
}

function isEodExitTime(minutes) {
  return minutes >= EOD_EXIT;
}

/** Carry-forward desks exit on expiry day at EOD_EXIT (or immediately if expiry already passed). */
function isExpiryExitDue(trade, clock) {
  const exp = String(trade?.expiryDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp)) return false;
  if (clock.dateKey > exp) return true;
  return clock.dateKey === exp && isEodExitTime(clock.minutes);
}

function normalizeSymbol(symbol) {
  const s = String(symbol || 'NIFTY').toUpperCase();
  if (getDayCloseEnabled()) {
    // Index desk
    if (!ALLOWED_SYMBOLS.has(s)) {
      throw new Error('Symbol must be NIFTY, BANKNIFTY, SENSEX or FINNIFTY');
    }
    return s;
  }
  // Stock desk — F&O stock underlyings only
  if (ALLOWED_SYMBOLS.has(s) || !isTradableStockUnderlying(s)) {
    throw new Error(`Symbol must be a tradable F&O stock (not index): ${s}`);
  }
  return s;
}

function normalizeOptionType(optionType) {
  const t = String(optionType || 'CE').toUpperCase();
  if (t !== 'CE' && t !== 'PE') throw new Error('optionType must be CE or PE');
  return t;
}

function normalizeProduct(product) {
  return String(product || 'OPTION').toUpperCase() === 'FUTURE' ? 'FUTURE' : 'OPTION';
}

function normalizeSide(side) {
  return String(side || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
}

function isFutureTrade(trade) {
  return normalizeProduct(trade?.product) === 'FUTURE' || String(trade?.optionType).toUpperCase() === 'FUT';
}

/** Direction sign: LONG profits when price rises (+1), SHORT when price falls (-1). */
function directionSign(trade) {
  return String(trade?.side).toUpperCase() === 'SHORT' ? -1 : 1;
}

/** Validate a futures underlying exists in the instrument master. */
async function normalizeFutureSymbol(symbol) {
  const upper = String(symbol || '').toUpperCase().trim();
  if (!upper) throw new Error('Futures symbol required');
  if (!isTradableStockUnderlying(upper)) {
    throw new Error(`Test/sandbox symbol not allowed: ${upper}`);
  }
  if (engineState.desk === 'stock') {
    if (ALLOWED_SYMBOLS.has(upper)) {
      throw new Error(`Index underlyings not allowed on Stock Manual: ${upper}`);
    }
    const list = await listFutureUnderlyings();
    if (!list.includes(upper)) throw new Error(`No stock future found for ${upper}`);
    return upper;
  }
  if (ALLOWED_SYMBOLS.has(upper)) return upper;
  const list = await listFutureUnderlyings();
  if (!list.includes(upper)) throw new Error(`No stock future found for ${upper}`);
  return upper;
}

function parsePremiumPoints(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(5000, n);
}

function parseAmount(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(50_000_000, n);
}

function normalizeRiskMode(mode) {
  const m = String(mode || '').toUpperCase();
  if (m === 'PCT') return 'PCT';
  if (m === 'AMOUNT' || m === 'INR' || m === 'RS') return 'AMOUNT';
  return 'POINTS';
}

/** Parse a positive % value (1..99 for SL, 1..1000 for target). */
function parsePct(raw, { max = 1000 } = {}) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, n);
}

/**
 * Resolve SL/target exit premium from entry + configured mode.
 * - PCT: offset = entry * pct / 100, then SL/TG placed vs entry by side (dir).
 * - POINTS: `points` is the exact absolute premium / price level.
 * - AMOUNT: gross ₹ P/L (before charges) → premium offset = amount / qty.
 */
function exitPremiumFromConfig({
  mode,
  points,
  pct,
  amount,
  entryPremium,
  leg,
  dir = 1,
  qty = 1,
}) {
  const m = normalizeRiskMode(mode);
  if (m === 'PCT') {
    if (pct == null || !Number.isFinite(entryPremium) || entryPremium <= 0) return null;
    const safePct = leg === 'SL' ? Math.min(99, pct) : pct;
    const offset = (entryPremium * safePct) / 100;
    const prem = leg === 'SL' ? entryPremium - dir * offset : entryPremium + dir * offset;
    return Math.max(0.05, prem);
  }
  if (m === 'AMOUNT') {
    if (amount == null || !Number.isFinite(entryPremium) || entryPremium <= 0) return null;
    const q = Math.max(1, Number(qty) || 1);
    const ptOffset = Number(amount) / q;
    const prem = leg === 'SL' ? entryPremium - dir * ptOffset : entryPremium + dir * ptOffset;
    return Math.max(0.05, prem);
  }
  if (points == null || !Number.isFinite(points) || points <= 0) return null;
  return Math.max(0.05, points);
}

function parseRiskInputs({ mode, rawValue, leg }) {
  const m = normalizeRiskMode(mode);
  if (rawValue === '' || rawValue === null || rawValue === undefined) {
    return { mode: m, pct: null, points: null, amount: null, configured: false };
  }
  const pct = m === 'PCT' ? parsePct(rawValue, { max: leg === 'SL' ? 99 : 1000 }) : null;
  const points = m === 'POINTS' ? parsePremiumPoints(rawValue) : null;
  const amount = m === 'AMOUNT' ? parseAmount(rawValue) : null;
  const configured = pct != null || points != null || amount != null;
  return { mode: m, pct, points, amount, configured };
}

function premiumFromChain(chain, optionType) {
  const type = normalizeOptionType(optionType);
  const ltp = type === 'CE' ? Number(chain?.ceLtp) : Number(chain?.peLtp);
  return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
}

function atmStrikeFromSpot(spot, symbol) {
  const step = getStrikeStep(symbol);
  // Bottom ATM: strike at or below live price (never round up to the upper strike).
  return Math.floor(Number(spot) / step) * step;
}

/** Manual console strike pick — ATM uses bottom (floor) strike, same as create-order chain. */
function pickManualStrike({ entrySpot, symbol, optionType, strikeMode }) {
  const step = getStrikeStep(symbol);
  const atm = atmStrikeFromSpot(entrySpot, symbol);
  const type = normalizeOptionType(optionType);
  const mode = String(strikeMode || 'ATM').toUpperCase();
  if (mode === 'ITM') {
    return type === 'CE' ? atm - step : atm + step;
  }
  if (mode === 'OTM') {
    return type === 'CE' ? atm + step : atm - step;
  }
  return atm;
}

function sortedChainStrikes(chain) {
  return Object.keys(chain?.oc || {})
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

/** Index of the bottom-ATM strike (highest listed strike at or below spot). */
function chainAtmIndex(strikeKeys, spot) {
  if (!strikeKeys.length) return -1;
  let idx = 0;
  for (let i = 0; i < strikeKeys.length; i += 1) {
    if (strikeKeys[i] <= spot) idx = i;
    else break;
  }
  return idx;
}

/** Stock strikes have uneven spacing, so ITM/OTM step by listed strikes, not a fixed step. */
function pickChainStrike({ strikeKeys, spot, optionType, strikeMode }) {
  const atmIdx = chainAtmIndex(strikeKeys, spot);
  if (atmIdx < 0) return null;
  const type = normalizeOptionType(optionType);
  const mode = String(strikeMode || 'ATM').toUpperCase();
  let idx = atmIdx;
  if (mode === 'ITM') idx = type === 'CE' ? atmIdx - 1 : atmIdx + 1;
  if (mode === 'OTM') idx = type === 'CE' ? atmIdx + 1 : atmIdx - 1;
  idx = Math.max(0, Math.min(strikeKeys.length - 1, idx));
  return strikeKeys[idx];
}

/**
 * Underlying price for index options = futures LTP (not cash NIFTY/BANKNIFTY).
 * Prefer same expiry if a FUT contract exists; otherwise nearest futures.
 * `maxWaitMs` keeps UI paths (create-order chain) from blocking ~4s on cold WS.
 */
async function resolveIndexFutLtp(symbol, preferredExpiry = null, { maxWaitMs = 2000 } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const wanted = preferredExpiry ? String(preferredExpiry).slice(0, 10) : null;
  const waitOpts = { maxWaitMs };

  if (wanted) {
    try {
      const { ltp } = await getFutureLtp({ symbol: sym, expiry: wanted, ...waitOpts });
      if (Number.isFinite(ltp) && ltp > 0) {
        return { ltp: Number(ltp), expiry: wanted, source: 'fut_same_expiry' };
      }
    } catch {
      // Weekly option expiry often has no matching FUT — use nearest futures below.
    }
  }

  const quote = await getFutureQuote({ symbol: sym, maxWaitMs });
  const ltp = Number(quote?.ltp);
  if (!Number.isFinite(ltp) || ltp <= 0) {
    throw new Error(`Future LTP unavailable for ${sym}`);
  }
  return {
    ltp,
    expiry: quote.expiry ? String(quote.expiry).slice(0, 10) : null,
    source: 'fut_nearest',
  };
}

async function logAction({ action, tradeId = null, orderId = null, symbol = null, message = null, details = null }) {
  try {
    await ManualTradeAction.create({
      strategyKey: getStrategyKey(),
      action,
      tradeId,
      orderId,
      symbol,
      message,
      details,
    });
  } catch (err) {
    engineState.lastError = `Action log failed: ${err.message}`;
  }
}

async function ensureWallet() {
  let wallet = await LiveWallet.findOne({ walletKey: getWalletKey() });
  if (!wallet) {
    wallet = await LiveWallet.create({
      walletKey: getWalletKey(),
      startingBalance: 0,
      balance: 0,
      realizedPnl: 0,
      grossProfit: 0,
      grossLoss: 0,
      cashLedger: true,
    });
  }
  // One-time migrate off the old "balance === realizedPnl" PnL-only wallet.
  if (!wallet.cashLedger) {
    wallet.cashLedger = true;
    wallet.startingBalance = Math.max(0, Number(wallet.startingBalance) || 0);
    // Preserve any positive realized PnL as available cash seed; never invent capital.
    const realized = Number(wallet.realizedPnl) || 0;
    if (!(Number(wallet.startingBalance) > 0) && !(Number(wallet.balance) > 0)) {
      wallet.balance = Math.max(0, realized);
    }
    if (wallet.grossProfit == null) wallet.grossProfit = 0;
    if (wallet.grossLoss == null) wallet.grossLoss = 0;
    await wallet.save();
  }
  return wallet;
}

/** Capital required to open a paper position (options: full premium; futures: margin). */
function estimateCapitalRequired({ product, premium, qty, charges = 100 }) {
  const px = Number(premium);
  const q = Math.max(0, Number(qty) || 0);
  const fee = Math.max(0, Number(charges) || 0);
  if (!Number.isFinite(px) || px <= 0 || q <= 0) return null;
  const notional = px * q;
  const capital =
    String(product || 'OPTION').toUpperCase() === 'FUTURE'
      ? notional * FUTURE_MARGIN_PCT
      : notional;
  return Number((capital + fee).toFixed(2));
}

function formatInsufficientFunds(need, have) {
  const n = Number(need) || 0;
  const h = Number(have) || 0;
  return `Insufficient balance — need ₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })} · available ₹${h.toLocaleString('en-IN', { maximumFractionDigits: 2 })}. Top up ₹5,000 / ₹10,000 / ₹50,000.`;
}

async function assertSufficientBalance(need) {
  const wallet = await ensureWallet();
  const have = Number(wallet.balance) || 0;
  const required = Number(need) || 0;
  if (!(required > 0)) throw new Error('Cannot estimate order cost');
  if (have + 1e-9 < required) {
    throw new Error(formatInsufficientFunds(required, have));
  }
  return wallet;
}

async function debitWallet(amount, { reason = 'DEBIT' } = {}) {
  const need = Number(amount) || 0;
  if (!(need > 0)) return ensureWallet();
  const wallet = await assertSufficientBalance(need);
  wallet.balance = Number((Number(wallet.balance) - need).toFixed(2));
  await wallet.save();
  return wallet;
}

async function creditWallet(amount) {
  const add = Number(amount) || 0;
  if (!(add > 0)) return ensureWallet();
  const wallet = await ensureWallet();
  wallet.balance = Number((Number(wallet.balance) + add).toFixed(2));
  await wallet.save();
  return wallet;
}

function serializeWallet(wallet, extras = {}) {
  const balance = Number(wallet.balance) || 0;
  const startingBalance = Number(wallet.startingBalance) || 0;
  const realizedPnl = Number(wallet.realizedPnl) || 0;
  const grossProfit = Number(wallet.grossProfit) || 0;
  const grossLoss = Number(wallet.grossLoss) || 0;
  const rawHistory = Array.isArray(wallet.depositHistory) ? wallet.depositHistory : [];
  const depositHistory = rawHistory
    .map((row) => ({
      amount: Number(row.amount) || 0,
      at: row.at ? new Date(row.at).toISOString() : null,
      source: row.source === 'custom' ? 'custom' : 'preset',
    }))
    .filter((row) => row.amount > 0 && row.at)
    .slice(0, MAX_DEPOSIT_HISTORY);
  return {
    balance,
    available: balance,
    startingBalance,
    realizedPnl,
    grossProfit,
    grossLoss,
    totalTrades: wallet.totalTrades || 0,
    wins: wallet.wins || 0,
    losses: wallet.losses || 0,
    cashLedger: Boolean(wallet.cashLedger),
    topupOptions: [...TOPUP_AMOUNTS],
    minCustomTopup: MIN_CUSTOM_TOPUP,
    maxTopup: MAX_TOPUP,
    depositHistory,
    ...extras,
  };
}

function normalizeTopupAmount(rawAmount) {
  const amount = Math.round(Number(rawAmount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Enter a valid deposit amount');
  }
  if (TOPUP_AMOUNTS.includes(amount)) {
    return { amount, source: 'preset' };
  }
  // Custom: must be more than ₹5,000
  if (amount <= MIN_CUSTOM_TOPUP) {
    throw new Error(`Custom amount must be more than ₹${MIN_CUSTOM_TOPUP.toLocaleString('en-IN')}`);
  }
  if (amount > MAX_TOPUP) {
    throw new Error(`Max deposit is ₹${MAX_TOPUP.toLocaleString('en-IN')}`);
  }
  return { amount, source: 'custom' };
}

async function topUpWallet(rawAmount) {
  const { amount, source } = normalizeTopupAmount(rawAmount);
  const wallet = await ensureWallet();
  wallet.startingBalance = Number((Number(wallet.startingBalance || 0) + amount).toFixed(2));
  wallet.balance = Number((Number(wallet.balance || 0) + amount).toFixed(2));
  wallet.cashLedger = true;
  const entry = { amount, at: new Date(), source };
  const prev = Array.isArray(wallet.depositHistory) ? wallet.depositHistory : [];
  wallet.depositHistory = [entry, ...prev].slice(0, MAX_DEPOSIT_HISTORY);
  wallet.markModified('depositHistory');
  await wallet.save();
  await logAction({
    action: 'WALLET_TOPUP',
    message: `Top-up ₹${amount.toLocaleString('en-IN')}`,
    details: {
      amount,
      source,
      balance: wallet.balance,
      startingBalance: wallet.startingBalance,
      at: entry.at.toISOString(),
    },
  });
  return serializeWallet(wallet);
}

/** If depositHistory is empty but action logs exist, seed once from WALLET_TOPUP actions. */
async function ensureDepositHistoryBackfill(wallet) {
  if (Array.isArray(wallet.depositHistory) && wallet.depositHistory.length > 0) return wallet;
  const actions = await ManualTradeAction.find({
    strategyKey: getStrategyKey(),
    action: 'WALLET_TOPUP',
  })
    .sort({ createdAt: -1 })
    .limit(MAX_DEPOSIT_HISTORY)
    .lean();
  if (!actions.length) return wallet;
  wallet.depositHistory = actions
    .map((a) => {
      const amount = Number(a.details?.amount);
      if (!(amount > 0)) return null;
      return {
        amount,
        at: a.createdAt || new Date(),
        source: TOPUP_AMOUNTS.includes(amount) ? 'preset' : 'custom',
      };
    })
    .filter(Boolean);
  if (!wallet.depositHistory.length) return wallet;
  wallet.markModified('depositHistory');
  await wallet.save();
  return wallet;
}

/**
 * Rebuild wallet from MAIN book only.
 * Testing trades never touch realized P/L, wins, losses, or available cash.
 * Balance formula: starting + main realized − open main capital − pending holds
 * (open testing capital still locked in cash, so it is included in lockedOpen).
 */
async function rebuildMainWalletLedger(wallet) {
  const closed = await LivePaperTrade.find({
    strategyKey: getStrategyKey(),
    $or: [{ exitTime: { $ne: null } }, { status: 'CLOSED' }],
  }).lean();
  const open = await LivePaperTrade.find({
    strategyKey: getStrategyKey(),
    exitTime: null,
    status: { $ne: 'CLOSED' },
  }).lean();
  const pending = await ManualPendingOrder.find({
    strategyKey: getStrategyKey(),
    status: 'PENDING',
    heldAmount: { $gt: 0 },
  }).lean();

  let realizedPnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let mainCount = 0;
  for (const t of closed) {
    if (isTestingTrade(t)) continue;
    const pnl = Number(t.pnl);
    if (!Number.isFinite(pnl)) continue;
    mainCount += 1;
    realizedPnl += pnl;
    if (pnl > 0) {
      wins += 1;
      grossProfit += pnl;
    } else if (pnl < 0) {
      losses += 1;
      grossLoss += Math.abs(pnl);
    }
  }

  // Capital reserved by open MAIN positions only (testing never locks main cash).
  let lockedOpen = 0;
  for (const t of open) {
    if (isTestingTrade(t)) continue;
    const locked = Number(t.capitalLocked);
    if (Number.isFinite(locked) && locked > 0) lockedOpen += locked;
    else {
      const fallback = (Number(t.investedAmount) || 0) + Math.max(0, Number(t.charges) || 0);
      lockedOpen += fallback;
    }
  }
  let heldPending = 0;
  for (const o of pending) {
    heldPending += Number(o.heldAmount) || 0;
  }

  const starting = Number(wallet.startingBalance) || 0;
  wallet.realizedPnl = Number(realizedPnl.toFixed(2));
  wallet.grossProfit = Number(grossProfit.toFixed(2));
  wallet.grossLoss = Number(grossLoss.toFixed(2));
  wallet.totalTrades = mainCount;
  wallet.wins = wins;
  wallet.losses = losses;
  wallet.balance = Number(Math.max(0, starting + realizedPnl - lockedOpen - heldPending).toFixed(2));
  wallet.cashLedger = true;
  await wallet.save();
  return wallet;
}

/** Keep legacy name — full rebuild of main-only cash ledger. */
async function recalcWalletFromTrades() {
  const wallet = await ensureWallet();
  return rebuildMainWalletLedger(wallet);
}

async function assertMarketOpen(clock) {
  await ensureNseHolidaysLoaded();
  if (!isNseCashTradingDay(clock.dateKey)) {
    if (isWeekendDateKey(clock.dateKey)) {
      throw new Error('Market closed — weekend');
    }
    const holiday = getNseHolidayDescription(clock.dateKey);
    throw new Error(holiday ? `Market closed — ${holiday}` : 'Market closed — NSE holiday');
  }
  if (getDayCloseEnabled() && isEodExitTime(clock.minutes)) {
    throw new Error('New entries blocked after 15:20 IST');
  }
}

function buildOpenPositionMark(trade, mark, clock) {
  const entryPremium = Number(trade.entryPremium) || 0;
  const optionLtp = Number(mark?.optionLtp) || 0;
  const qty = Number(trade.qty) || 0;
  const invested = entryPremium * qty;
  const finalValue = optionLtp * qty;
  const dir = directionSign(trade);
  const grossPnl = (optionLtp - entryPremium) * qty * dir;
  const source = mark?.source || 'chain';
  const optionType = isFutureTrade(trade) ? 'FUT' : normalizeOptionType(trade.optionType);
  const isLive = source === 'chain' || source === 'websocket' || source === 'marketfeed';

  return {
    at: new Date().toISOString(),
    source,
    isLiveMark: isLive,
    priceSourceLabel: isLive ? 'LIVE' : 'STALE',
    optionType,
    optionLtp: Number.isFinite(optionLtp) ? Number(optionLtp.toFixed(2)) : null,
    entryPremium: Number(entryPremium.toFixed(2)),
    investedAmount: Number(invested.toFixed(2)),
    currentValue: Number(finalValue.toFixed(2)),
    grossPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnl: Number(grossPnl.toFixed(2)),
    unrealizedPnlPct: invested > 0 ? Number(((grossPnl / invested) * 100).toFixed(2)) : 0,
    stopLossPremium: trade.stopLossPremium,
    targetPremium: trade.targetPremium,
    spot: Number.isFinite(mark?.spot) ? Number(Number(mark.spot).toFixed(2)) : null,
    isProfitable: grossPnl > 0,
    phase: clock.dateKey === trade.entryDateKey ? 'INTRADAY_HOLD' : 'MISSED_EOD',
  };
}

function tradeSubKey(tradeId) {
  return `manual:${String(tradeId)}`;
}

function cacheTradeLite(trade) {
  if (!trade?._id) return null;
  const id = String(trade._id);
  const lite = {
    _id: id,
    symbol: trade.symbol,
    side: trade.side,
    product: trade.product,
    optionType: trade.optionType,
    strike: trade.strike,
    expiryDate: trade.expiryDate,
    entryPremium: trade.entryPremium,
    qty: trade.qty,
    lots: trade.lots,
    investedAmount: trade.investedAmount,
    stopLossPremium: trade.stopLossPremium,
    targetPremium: trade.targetPremium,
    entryDateKey: trade.entryDateKey,
    entryTime: trade.entryTime,
  };
  const prev = liveSubs.get(id) || { key: tradeSubKey(id) };
  liveSubs.set(id, { ...prev, tradeLite: lite });
  return lite;
}

function getLiveMarkSnapshot() {
  const marks = {};
  for (const [id, mark] of latestMarks.entries()) {
    marks[id] = mark;
  }
  return {
    strategyId: getStrategyId(),
    open: latestMarks.size > 0,
    marks,
    at: new Date().toISOString(),
  };
}

function publishManualMarkSnapshot(extra = {}) {
  const now = Date.now();
  const gap = now - engineState.lastLiveMarkEmitAt;
  const payload = { ...getLiveMarkSnapshot(), ...extra };
  if (gap >= LIVE_MARK_EMIT_MIN_GAP_MS) {
    engineState.lastLiveMarkEmitAt = now;
    if (engineState.liveMarkEmitTimer) {
      clearTimeout(engineState.liveMarkEmitTimer);
      engineState.liveMarkEmitTimer = null;
    }
    broadcastPaperLive(getStrategyId(), payload);
    return;
  }
  if (engineState.liveMarkEmitTimer) return;
  engineState.liveMarkEmitTimer = setTimeout(() => {
    engineState.liveMarkEmitTimer = null;
    engineState.lastLiveMarkEmitAt = Date.now();
    broadcastPaperLive(getStrategyId(), getLiveMarkSnapshot());
  }, Math.max(20, LIVE_MARK_EMIT_MIN_GAP_MS - gap));
}

function publishTradeMark(tradeId, positionMark, extra = {}) {
  const id = String(tradeId);
  if (positionMark && Number(positionMark.optionLtp) > 0) {
    latestMarks.set(id, { ...positionMark, tradeId: id });
  }
  publishManualMarkSnapshot({
    tradeId: id,
    mark: latestMarks.get(id) || positionMark || null,
    ...extra,
  });
}

function getFreshWsTick(tradeId) {
  const sub = liveSubs.get(String(tradeId));
  const tick = sub?.lastTick;
  if (!tick) {
    const cached = getLastPrice(tradeSubKey(tradeId));
    if (cached && Date.now() - cached.ts <= WS_FRESH_MS) {
      return { ltp: Number(cached.ltp), ts: cached.ts };
    }
    return null;
  }
  if (Date.now() - tick.ts > WS_FRESH_MS) return null;
  return tick;
}

function rememberTick(tradeId, ltp) {
  const id = String(tradeId);
  const prev = liveSubs.get(id) || { key: tradeSubKey(id) };
  liveSubs.set(id, {
    ...prev,
    lastTick: { ltp: Number(ltp), ts: Date.now() },
  });
}

async function persistMarkThrottled(trade, positionMark) {
  const id = String(trade._id);
  const now = Date.now();
  const last = markPersistAt.get(id) || 0;
  if (now - last < MARK_PERSIST_MIN_MS) return;
  markPersistAt.set(id, now);
  await LivePaperTrade.updateOne(
    { _id: trade._id, exitTime: null },
    { $set: { openPositionMark: positionMark, openPositionMarkAt: new Date(positionMark.at || now) } },
  );
}

async function evaluateExitsFromMark(trade, mark, clock) {
  const heldMs = Date.now() - new Date(trade.entryTime).getTime();
  if (heldMs < MIN_HOLD_MS) return false;

  const optionLtp = Number(mark.optionLtp);
  if (!Number.isFinite(optionLtp) || optionLtp <= 0) return false;

  const dir = directionSign(trade);
  const slHit =
    trade.stopLossPremium != null &&
    (dir === 1
      ? optionLtp <= Number(trade.stopLossPremium)
      : optionLtp >= Number(trade.stopLossPremium));
  if (slHit) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.stopLossPremium),
      mark,
      reason: 'STOP_LOSS',
    });
    return true;
  }

  const tgHit =
    trade.targetPremium != null &&
    (dir === 1
      ? optionLtp >= Number(trade.targetPremium)
      : optionLtp <= Number(trade.targetPremium));
  if (tgHit) {
    await finalizeTrade(trade, {
      exitPremium: Number(trade.targetPremium),
      mark,
      reason: 'TARGET',
    });
    return true;
  }

  if (getDayCloseEnabled()) {
    if (isEodExitTime(clock.minutes)) {
      await finalizeTrade(trade, { exitPremium: optionLtp, mark, reason: 'DAY_CLOSE' });
      return true;
    }
    return false;
  }

  if (isExpiryExitDue(trade, clock)) {
    await finalizeTrade(trade, { exitPremium: optionLtp, mark, reason: 'EXPIRY' });
    return true;
  }
  return false;
}

async function onManualOptionTick(tradeId, ltp) {
  const id = String(tradeId);
  const n = Number(ltp);
  if (!Number.isFinite(n) || n <= 0) return;
  rememberTick(id, n);

  // Instant UI path — no DB wait.
  const lite = liveSubs.get(id)?.tradeLite;
  if (lite) {
    const clock = getIstClock(new Date());
    const mark = { optionLtp: n, spot: null, source: 'websocket' };
    const positionMark = buildOpenPositionMark(lite, mark, clock);
    publishTradeMark(id, positionMark);
    persistMarkThrottled(lite, positionMark).catch(() => {});
  }

  if (tickExitInflight.has(id)) return;
  tickExitInflight.add(id);
  try {
    const trade = await LivePaperTrade.findOne({
      _id: id,
      strategyKey: getStrategyKey(),
      exitTime: null,
    });
    if (!trade) {
      dropTradeSubscription(id);
      latestMarks.delete(id);
      publishManualMarkSnapshot({ tradeId: id, mark: null, open: latestMarks.size > 0 });
      return;
    }
    cacheTradeLite(trade);
    const clock = getIstClock(new Date());
    const mark = { optionLtp: n, spot: null, source: 'websocket' };
    const positionMark = buildOpenPositionMark(trade, mark, clock);
    publishTradeMark(id, positionMark);
    await persistMarkThrottled(trade, positionMark);
    await evaluateExitsFromMark(trade, mark, clock);
  } catch (err) {
    engineState.lastError = `WS tick ${id}: ${err.message}`;
  } finally {
    tickExitInflight.delete(id);
  }
}

function dropTradeSubscription(tradeId) {
  const id = String(tradeId);
  const sub = liveSubs.get(id);
  unsubscribeLiveSymbol(sub?.key || tradeSubKey(id));
  liveSubs.delete(id);
  markPersistAt.delete(id);
  tickExitInflight.delete(id);
  latestMarks.delete(id);
}

async function ensureTradeSubscription(trade) {
  const id = String(trade._id);
  cacheTradeLite(trade);
  if (liveSubs.has(id) && liveSubs.get(id)?.instrument) return;

  const key = tradeSubKey(id);
  try {
    let instrument;
    if (isFutureTrade(trade)) {
      instrument = await resolveFutureInstrument({
        symbol: trade.symbol,
        expiry: trade.expiryDate,
      });
    } else {
      instrument = await resolveOptionInstrument({
        symbol: trade.symbol,
        strike: trade.strike,
        expiry: trade.expiryDate,
        optionType: normalizeOptionType(trade.optionType),
      });
    }

    const prev = liveSubs.get(id) || { key };
    liveSubs.set(id, { ...prev, key, instrument, lastTick: prev.lastTick || null });
    subscribeLiveInstrument({
      key,
      securityId: instrument.securityId,
      exchangeSegment: instrument.exchangeSegment,
      onTick: (tick) => {
        onManualOptionTick(id, tick.ltp).catch(() => {});
      },
    });

    // Seed an immediate LTP so UI is not blank waiting for the first WS packet.
    try {
      const seeded = await fetchInstrumentLtp(instrument);
      if (Number.isFinite(seeded) && seeded > 0) {
        rememberTick(id, seeded);
        const clock = getIstClock(new Date());
        const mark = { optionLtp: seeded, spot: null, source: 'marketfeed' };
        const positionMark = buildOpenPositionMark(trade, mark, clock);
        publishTradeMark(id, positionMark);
        persistMarkThrottled(trade, positionMark).catch(() => {});
      }
    } catch {
      // WS ticks will populate shortly
    }
  } catch (err) {
    engineState.lastError = `Manual WS subscribe ${id}: ${err.message}`;
  }
}

async function syncLiveSubscriptions(openTrades) {
  const openIds = new Set(openTrades.map((t) => String(t._id)));
  for (const id of [...liveSubs.keys()]) {
    if (!openIds.has(id)) dropTradeSubscription(id);
  }
  await Promise.all(openTrades.map((t) => ensureTradeSubscription(t)));
}

async function resolveMarkForTrade(trade) {
  const wsTick = getFreshWsTick(trade._id);
  if (wsTick) {
    return { spot: null, optionLtp: wsTick.ltp, source: 'websocket' };
  }

  // Ensure we are subscribed even if this trade appeared mid-session.
  await ensureTradeSubscription(trade);
  const afterSub = getFreshWsTick(trade._id);
  if (afterSub) {
    return { spot: null, optionLtp: afterSub.ltp, source: 'websocket' };
  }

  // Prefer single-instrument LTP over full option-chain (chain is cached ~4s).
  const sub = liveSubs.get(String(trade._id));
  if (sub?.instrument) {
    try {
      const seeded = await fetchInstrumentLtp(sub.instrument);
      if (Number.isFinite(seeded) && seeded > 0) {
        rememberTick(trade._id, seeded);
        return { spot: null, optionLtp: Number(seeded), source: 'marketfeed' };
      }
    } catch {
      // fall through to futures / chain
    }
  }

  if (isFutureTrade(trade)) {
    const { ltp } = await getFutureLtp({ symbol: trade.symbol, expiry: trade.expiryDate });
    const price = Number.isFinite(ltp) && ltp > 0 ? ltp : null;
    if (price != null) rememberTick(trade._id, price);
    return { spot: price, optionLtp: price, source: price != null ? 'marketfeed' : 'entry' };
  }

  const chain = await getAtmPremiums({
    symbol: trade.symbol,
    strike: trade.strike,
    expiry: trade.expiryDate,
  });
  const optionType = normalizeOptionType(trade.optionType);
  const optionLtp = premiumFromChain(chain, optionType);
  if (optionLtp != null) rememberTick(trade._id, optionLtp);

  let spot = null;
  try {
    const fut = await resolveIndexFutLtp(trade.symbol, trade.expiryDate);
    spot = fut.ltp;
  } catch {
    const cash = Number(chain.chainSpot || chain.spot);
    spot = Number.isFinite(cash) && cash > 0 ? cash : null;
  }

  return {
    spot,
    optionLtp,
    source: optionLtp != null ? 'chain' : 'entry',
  };
}

async function fillOrderToTrade(order, { entryPremium, spot, clock }) {
  const qty = order.lotSize * order.lots;
  const invested = entryPremium * qty;
  const product = normalizeProduct(order.product);
  const side = product === 'FUTURE' ? normalizeSide(order.side) : 'LONG';
  const dir = side === 'SHORT' ? -1 : 1;
  const charges = Number(order.perTradeCost || 100);
  const capitalNeeded = estimateCapitalRequired({
    product,
    premium: entryPremium,
    qty,
    charges,
  });
  if (capitalNeeded == null) throw new Error('Cannot estimate capital for fill');

  // Testing never locks main available cash.
  const testing = parseIsTesting(order.isTesting);
  if (!testing) {
    const held = Number(order.heldAmount) || 0;
    if (held > 0) {
      // LIMIT hold already debited — settle difference vs actual capital.
      const delta = Number((capitalNeeded - held).toFixed(2));
      if (delta > 0) {
        await debitWallet(delta, { reason: 'FILL_TOPUP' });
      } else if (delta < 0) {
        await creditWallet(-delta);
      }
      order.heldAmount = 0;
    } else {
      await debitWallet(capitalNeeded, { reason: 'FILL' });
    }
  }

  const slConfigured = order.stopLossMode != null || order.stopLossPoints != null || order.stopLossPct != null || order.stopLossAmount != null;
  const tgConfigured = order.targetMode != null || order.targetProfitPoints != null || order.targetPct != null || order.targetAmount != null;
  const stopLossPremium = exitPremiumFromConfig({
    mode: order.stopLossMode,
    points: order.stopLossPoints,
    pct: order.stopLossPct,
    amount: order.stopLossAmount,
    entryPremium,
    leg: 'SL',
    dir,
    qty,
  });
  const targetPremium = exitPremiumFromConfig({
    mode: order.targetMode,
    points: order.targetProfitPoints,
    pct: order.targetPct,
    amount: order.targetAmount,
    entryPremium,
    leg: 'TG',
    dir,
    qty,
  });

  let tradeDoc;
  try {
    tradeDoc = await LivePaperTrade.create({
      strategyKey: getStrategyKey(),
      symbol: order.symbol,
      side,
      optionType: product === 'FUTURE' ? 'FUT' : order.optionType,
      product,
      strike: order.strike,
      expiryDate: order.expiryDate,
      lotSize: order.lotSize,
      lots: order.lots,
      qty,
      entryPremium: Number(entryPremium.toFixed(2)),
      entrySpot: Number(spot.toFixed(2)),
      entryTime: new Date(),
      entryDateKey: clock.dateKey,
      status: 'OPEN',
      investedAmount: Number(invested.toFixed(2)),
      capitalLocked: capitalNeeded,
      creditReceived: 0,
      charges: Number(charges.toFixed(2)),
      stopLossPremium: stopLossPremium != null ? Number(stopLossPremium.toFixed(2)) : null,
      targetPremium: targetPremium != null ? Number(targetPremium.toFixed(2)) : null,
      stopLossMode: stopLossPremium != null && slConfigured ? normalizeRiskMode(order.stopLossMode) : null,
      targetMode: targetPremium != null && tgConfigured ? normalizeRiskMode(order.targetMode) : null,
      stopLossAmount: stopLossPremium != null && normalizeRiskMode(order.stopLossMode) === 'AMOUNT'
        ? Number(order.stopLossAmount)
        : null,
      targetAmount: targetPremium != null && normalizeRiskMode(order.targetMode) === 'AMOUNT'
        ? Number(order.targetAmount)
        : null,
      legs: [{ optionType: product === 'FUTURE' ? 'FUT' : order.optionType, side, entryPremium: Number(entryPremium.toFixed(2)) }],
      notes: `manual; order=${order._id}; product=${product}; side=${side}; type=${order.orderType}; capital=${capitalNeeded}; sl=${stopLossPremium ?? 'off'}; tg=${targetPremium ?? 'eod'}${order.isTesting ? '; testing=1' : ''}`,
      isTesting: Boolean(order.isTesting),
    });
  } catch (err) {
    await creditWallet(capitalNeeded);
    throw err;
  }

  order.status = 'FILLED';
  order.tradeId = tradeDoc._id;
  order.filledAt = new Date();
  await order.save();

  await logAction({
    action: 'ORDER_FILLED',
    orderId: order._id,
    tradeId: tradeDoc._id,
    symbol: order.symbol,
    message: `${order.optionType} ${order.strike} filled @ ${entryPremium.toFixed(2)} · locked ₹${capitalNeeded.toFixed(2)}`,
    details: {
      orderType: order.orderType,
      entryPremium,
      spot,
      capitalLocked: capitalNeeded,
      stopLossPremium,
      targetPremium,
    },
  });

  // Subscribe immediately so LTP/MTM update via WS without waiting for next poll.
  ensureTradeSubscription(tradeDoc).catch(() => {});
  rememberTick(tradeDoc._id, entryPremium);
  {
    const seedMark = buildOpenPositionMark(
      tradeDoc,
      { optionLtp: entryPremium, spot, source: 'entry' },
      clock,
    );
    publishTradeMark(tradeDoc._id, seedMark);
  }

  return tradeDoc;
}

async function createMarketFill(order, clock) {
  if (normalizeProduct(order.product) === 'FUTURE') {
    const { ltp } = await getFutureLtp({
      symbol: order.symbol,
      expiry: order.expiryDate,
      forceFresh: true,
      maxWaitMs: 2500,
    });
    if (!Number.isFinite(ltp) || ltp <= 0) {
      throw new Error(`Future LTP unavailable for ${order.symbol}`);
    }
    return fillOrderToTrade(order, { entryPremium: ltp, spot: ltp, clock });
  }

  // Market buy: always hit live marketfeed for this CE/PE — not the UI/chain cache.
  const optionType = normalizeOptionType(order.optionType);
  const instrument = await resolveOptionInstrument({
    symbol: order.symbol,
    strike: order.strike,
    expiry: order.expiryDate,
    optionType,
  });
  let entryPremium = null;
  try {
    entryPremium = await fetchInstrumentLtp(instrument, { forceFresh: true, maxWaitMs: 2500 });
  } catch (err) {
    // Last resort only — chain can be up to ~4s stale.
    const chain = await getAtmPremiums({
      symbol: order.symbol,
      strike: order.strike,
      expiry: order.expiryDate,
    });
    entryPremium = premiumFromChain(chain, optionType);
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      throw new Error(
        `${optionType} live LTP unavailable for strike ${order.strike}: ${err.message || 'no price'}`,
      );
    }
  }
  if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
    throw new Error(`${optionType} LTP unavailable for strike ${order.strike}`);
  }

  let spot = null;
  try {
    const fut = await resolveIndexFutLtp(order.symbol, order.expiryDate, { maxWaitMs: 1500 });
    spot = fut.ltp;
  } catch {
    spot = null;
  }
  if (!Number.isFinite(spot) || spot <= 0) {
    spot = Number(order.entrySpot) || entryPremium;
  }

  return fillOrderToTrade(order, { entryPremium: Number(entryPremium), spot, clock });
}

async function holdFundsForLimitOrder(order, premium) {
  // Testing never locks main available cash.
  if (parseIsTesting(order.isTesting)) {
    order.heldAmount = 0;
    await order.save();
    return 0;
  }
  const qty = order.lotSize * order.lots;
  const charges = Number(order.perTradeCost || 100);
  const need = estimateCapitalRequired({
    product: order.product,
    premium,
    qty,
    charges,
  });
  if (need == null) throw new Error('Cannot estimate capital for limit order');
  await debitWallet(need, { reason: 'LIMIT_HOLD' });
  order.heldAmount = need;
  await order.save();
  return need;
}

async function releaseHeldFunds(order) {
  const held = Number(order.heldAmount) || 0;
  if (!(held > 0)) return;
  await creditWallet(held);
  order.heldAmount = 0;
}

async function createOrder(payload) {
  const clock = getIstClock(new Date());
  await assertMarketOpen(clock);

  // Desk is selected by the controller (index vs stock). Do not auto-switch here.
  // Both desks trade options; legacy FUT positions are still managed until closed.
  if (normalizeProduct(payload.product) === 'FUTURE') {
    throw new Error('Futures orders are disabled — pick a CE/PE strike from the option chain');
  }

  const symbol = normalizeSymbol(payload.symbol);
  const optionType = normalizeOptionType(payload.optionType);
  const orderType = String(payload.orderType || 'MARKET').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
  const lots = Math.max(1, Math.floor(Number(payload.lots) || 1));
  const lotSize = Math.max(1, Number(payload.lotSize) || (await getCurrentLotSize(symbol)));
  const perTradeCost = Number.isFinite(Number(payload.perTradeCost)) && Number(payload.perTradeCost) >= 0
    ? Number(payload.perTradeCost)
    : 100;
  const riskMode = normalizeRiskMode(payload.stopLossMode || payload.targetMode);
  const stopLossMode = riskMode;
  const targetMode = riskMode;
  const slRawValue = payload.stopLossValue != null ? payload.stopLossValue : payload.stopLossPoints;
  const tgRawValue = payload.targetValue != null ? payload.targetValue : payload.targetProfitPoints;
  const slParsed = parseRiskInputs({ mode: stopLossMode, rawValue: slRawValue, leg: 'SL' });
  const tgParsed = parseRiskInputs({ mode: targetMode, rawValue: tgRawValue, leg: 'TG' });
  const slConfigured = slParsed.configured;
  const tgConfigured = tgParsed.configured;

  let expiryDate = String(payload.expiryDate || '').slice(0, 10);
  if (!expiryDate) {
    expiryDate = await getNearestWeeklyExpiry(symbol);
  }
  if (!expiryDate) throw new Error('Could not resolve option expiry from Dhan');

  const fut = await resolveIndexFutLtp(symbol, expiryDate);
  const spot = fut.ltp;
  if (!Number.isFinite(spot) || spot <= 0) throw new Error('Live index futures LTP unavailable');

  let strike = Number(payload.strike);
  if (!Number.isFinite(strike) || strike <= 0) {
    const strikeMode = String(payload.strikeMode || 'ATM').toUpperCase();
    if (getDayCloseEnabled()) {
      strike = pickManualStrike({ entrySpot: spot, symbol, optionType, strikeMode });
    } else {
      const chain = await fetchOptionChainCached({ symbol, expiry: expiryDate });
      strike = pickChainStrike({ strikeKeys: sortedChainStrikes(chain), spot, optionType, strikeMode });
    }
    if (!Number.isFinite(strike) || strike <= 0) throw new Error('Could not resolve strike from option chain');
  }

  let limitPremium = null;
  if (orderType === 'LIMIT') {
    limitPremium = parsePremiumPoints(payload.limitPremium);
    if (limitPremium == null) throw new Error('Limit premium is required for LIMIT orders');
  }

  // Pre-check cash before creating the order row (main only — testing free).
  {
    const isTesting = parseIsTesting(payload.isTesting);
    if (!isTesting) {
      let px = limitPremium;
      if (orderType === 'MARKET') {
        const chain = await getAtmPremiums({ symbol, strike, expiry: expiryDate });
        px = premiumFromChain(chain, optionType);
      }
      const need = estimateCapitalRequired({
        product: 'OPTION',
        premium: px,
        qty: lotSize * lots,
        charges: perTradeCost,
      });
      await assertSufficientBalance(need);
    }
  }

  const order = await ManualPendingOrder.create({
    strategyKey: getStrategyKey(),
    symbol,
    optionType,
    strike,
    expiryDate,
    orderType,
    limitPremium,
    lots,
    lotSize,
    perTradeCost,
    stopLossPoints: slParsed.points,
    targetProfitPoints: tgParsed.points,
    stopLossMode: slConfigured ? slParsed.mode : null,
    targetMode: tgConfigured ? tgParsed.mode : null,
    stopLossPct: slParsed.pct,
    targetPct: tgParsed.pct,
    stopLossAmount: slParsed.amount,
    targetAmount: tgParsed.amount,
    status: 'PENDING',
    sessionDateKey: clock.dateKey,
    isTesting: parseIsTesting(payload.isTesting),
  });

  await logAction({
    action: 'ORDER_CREATED',
    orderId: order._id,
    symbol,
    message: `${orderType} ${optionType} ${strike} x${lots}`,
    details: {
      orderType,
      limitPremium,
      stopLoss: slConfigured ? { mode: slParsed.mode, ...slParsed } : 'off',
      target: tgConfigured ? { mode: tgParsed.mode, ...tgParsed } : 'eod',
      expiryDate,
    },
  });

  if (orderType === 'LIMIT') {
    try {
      await holdFundsForLimitOrder(order, limitPremium);
    } catch (err) {
      order.status = 'CANCELLED';
      order.cancelReason = err.message;
      await order.save();
      throw err;
    }
  }

  if (orderType === 'MARKET') {
    try {
      const trade = await createMarketFill(order, clock);
      return { order, trade, filled: true };
    } catch (err) {
      order.status = 'CANCELLED';
      order.cancelReason = err.message;
      await order.save();
      await logAction({
        action: 'ORDER_FAILED',
        orderId: order._id,
        symbol,
        message: err.message,
      });
      throw err;
    }
  }

  return { order, trade: null, filled: false };
}

async function cancelOrder(orderId, reason = 'USER_CANCEL') {
  const order = await ManualPendingOrder.findOne({
    _id: orderId,
    strategyKey: getStrategyKey(),
    status: 'PENDING',
  });
  if (!order) throw new Error('Pending order not found');
  await releaseHeldFunds(order);
  order.status = 'CANCELLED';
  order.cancelReason = reason;
  await order.save();
  await logAction({
    action: 'ORDER_CANCELLED',
    orderId: order._id,
    symbol: order.symbol,
    message: reason,
  });
  return order;
}

async function finalizeTrade(trade, { exitPremium, mark, reason }) {
  const safeExit = Math.max(0.05, Number(exitPremium) || Number(mark?.optionLtp) || 0.05);
  const finalValue = safeExit * trade.qty;
  const entryPremium = Number(trade.entryPremium) || 0;
  const invested = entryPremium * trade.qty;
  const charges = Math.max(0, Number(trade.charges) || 0);
  const dir = directionSign(trade);
  const pnl = (safeExit - entryPremium) * trade.qty * dir - charges;
  const clock = getIstClock(new Date());
  const locked =
    Number(trade.capitalLocked) > 0
      ? Number(trade.capitalLocked)
      : Number((invested + charges).toFixed(2));

  trade.status = 'CLOSED';
  trade.exitPremium = Number(safeExit.toFixed(2));
  trade.exitSpot = Number(Number(mark?.spot || trade.entrySpot).toFixed(2));
  trade.exitTime = new Date();
  trade.exitDateKey = clock.dateKey;
  trade.reason = reason;
  trade.finalValue = Number(finalValue.toFixed(2));
  trade.pnl = Number(pnl.toFixed(2));
  trade.pnlPct = trade.investedAmount > 0 ? Number(((pnl / trade.investedAmount) * 100).toFixed(2)) : 0;
  trade.openPositionMark = null;
  trade.openPositionMarkAt = null;
  await trade.save();
  dropTradeSubscription(trade._id);
  publishManualMarkSnapshot({
    tradeId: String(trade._id),
    mark: null,
    open: latestMarks.size > 0,
    closed: true,
    reason,
  });

  const wallet = await ensureWallet();
  const testing = isTestingTrade(trade);
  // Testing: return capital if it was locked, but never add main P/L.
  // Main: release capital + add PnL to available cash.
  if (testing) {
    wallet.balance = Number((Number(wallet.balance) + locked).toFixed(2));
  } else {
    wallet.balance = Number((Number(wallet.balance) + locked + pnl).toFixed(2));
    wallet.realizedPnl = Number((Number(wallet.realizedPnl) + pnl).toFixed(2));
    wallet.totalTrades += 1;
    if (pnl > 0) {
      wallet.wins += 1;
      wallet.grossProfit = Number((Number(wallet.grossProfit || 0) + pnl).toFixed(2));
    } else if (pnl < 0) {
      wallet.losses += 1;
      wallet.grossLoss = Number((Number(wallet.grossLoss || 0) + Math.abs(pnl)).toFixed(2));
    }
  }
  await wallet.save();
  // Keep durable rebuild in sync after every close (cheap vs every tick).
  await rebuildMainWalletLedger(wallet);
  lastClosedStatsSyncAtByDesk[resolveDeskName()] = Date.now();

  await logAction({
    action: reason === 'MANUAL_CLOSE' ? 'POSITION_CLOSED_MANUAL' : `POSITION_CLOSED_${reason}`,
    tradeId: trade._id,
    symbol: trade.symbol,
    message: `Exit @ ${safeExit.toFixed(2)} P/L ₹${pnl.toFixed(2)}`,
    details: { reason, exitPremium: safeExit, pnl, capitalReleased: locked },
  });

  return trade;
}

async function closePositionById(tradeId, { reason = 'MANUAL_CLOSE' } = {}) {
  const trade = await LivePaperTrade.findOne({
    _id: tradeId,
    strategyKey: getStrategyKey(),
    exitTime: null,
  });
  if (!trade) throw new Error('Open position not found');

  // Manual exit: fetch exact live market price now — not the LTP shown in the open table.
  let optionLtp = null;
  let spot = null;
  let source = 'marketfeed';
  try {
    if (isFutureTrade(trade)) {
      const { ltp } = await getFutureLtp({
        symbol: trade.symbol,
        expiry: trade.expiryDate,
        forceFresh: true,
        maxWaitMs: 2500,
      });
      optionLtp = ltp;
      spot = ltp;
    } else {
      const optionType = normalizeOptionType(trade.optionType);
      const instrument = await resolveOptionInstrument({
        symbol: trade.symbol,
        strike: trade.strike,
        expiry: trade.expiryDate,
        optionType,
      });
      optionLtp = await fetchInstrumentLtp(instrument, { forceFresh: true, maxWaitMs: 2500 });
      try {
        const fut = await resolveIndexFutLtp(trade.symbol, trade.expiryDate, { maxWaitMs: 1500 });
        spot = fut.ltp;
      } catch {
        spot = Number(trade.entrySpot) || null;
      }
    }
  } catch (err) {
    // Fallback only if live feed fails entirely.
    const mark = await resolveMarkForTrade(trade);
    optionLtp = mark.optionLtp;
    spot = mark.spot;
    source = mark.source || 'fallback';
    if (!Number.isFinite(optionLtp) || optionLtp <= 0) {
      throw new Error(
        `Cannot close — live LTP unavailable from Dhan (${err.message || 'no price'})`,
      );
    }
  }

  if (!Number.isFinite(optionLtp) || optionLtp <= 0) {
    throw new Error('Cannot close — option LTP unavailable from Dhan');
  }

  rememberTick(trade._id, optionLtp);
  const mark = { optionLtp: Number(optionLtp), spot, source };
  return finalizeTrade(trade, { exitPremium: Number(optionLtp), mark, reason });
}

function parseRiskPointsInput(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(5000, n);
}

/**
 * Update SL / target on an open position. Pass stopLossPoints / targetProfitPoints
 * (premium pts from entry). Send null or '' to clear and use EOD-only for that leg.
 */
async function updatePositionRisk(tradeId, payload = {}) {
  const trade = await LivePaperTrade.findOne({
    _id: tradeId,
    strategyKey: getStrategyKey(),
    exitTime: null,
  });
  if (!trade) throw new Error('Open position not found');

  const entry = Number(trade.entryPremium);
  if (!Number.isFinite(entry) || entry <= 0) {
    throw new Error('Invalid entry premium on open trade');
  }

  const dir = directionSign(trade);
  const qty = Math.max(1, Number(trade.qty) || 1);
  const prev = {
    stopLossPremium: trade.stopLossPremium,
    targetPremium: trade.targetPremium,
  };
  const changes = {};

  function applyRiskLeg(leg, hasKey, rawKey, legacyKey, modeKey) {
    if (!hasKey) return;
    const premField = leg === 'SL' ? 'stopLossPremium' : 'targetPremium';
    const modeField = leg === 'SL' ? 'stopLossMode' : 'targetMode';
    const amountField = leg === 'SL' ? 'stopLossAmount' : 'targetAmount';
    const raw = Object.prototype.hasOwnProperty.call(payload, rawKey)
      ? payload[rawKey]
      : payload[legacyKey];
    if (raw === '' || raw === null || raw === undefined) {
      trade[premField] = null;
      trade[modeField] = null;
      trade[amountField] = null;
      changes[premField] = null;
      changes[modeField] = null;
      changes[amountField] = null;
      return;
    }
    const parsed = parseRiskInputs({
      mode: payload[modeKey],
      rawValue: raw,
      leg,
    });
    const prem = exitPremiumFromConfig({
      mode: parsed.mode,
      points: parsed.points,
      pct: parsed.pct,
      amount: parsed.amount,
      entryPremium: entry,
      leg,
      dir,
      qty,
    });
    if (prem == null) {
      trade[premField] = null;
      trade[modeField] = null;
      trade[amountField] = null;
      changes[premField] = null;
      changes[modeField] = null;
      changes[amountField] = null;
      return;
    }
    if (leg === 'SL' ? (dir === 1 ? prem >= entry : prem <= entry) : (dir === 1 ? prem <= entry : prem >= entry)) {
      throw new Error(
        leg === 'SL'
          ? `Stop loss must be ${dir === 1 ? 'below' : 'above'} entry`
          : `Target must be ${dir === 1 ? 'above' : 'below'} entry`,
      );
    }
    trade[premField] = Number(prem.toFixed(2));
    trade[modeField] = parsed.mode;
    trade[amountField] = parsed.mode === 'AMOUNT' ? parsed.amount : null;
    changes[premField] = trade[premField];
    changes[modeField] = trade[modeField];
    changes[amountField] = trade[amountField];
  }

  const hasSl =
    Object.prototype.hasOwnProperty.call(payload, 'stopLossValue') ||
    Object.prototype.hasOwnProperty.call(payload, 'stopLossPoints');
  const hasTg =
    Object.prototype.hasOwnProperty.call(payload, 'targetValue') ||
    Object.prototype.hasOwnProperty.call(payload, 'targetProfitPoints');

  applyRiskLeg('SL', hasSl, 'stopLossValue', 'stopLossPoints', 'stopLossMode');
  applyRiskLeg('TG', hasTg, 'targetValue', 'targetProfitPoints', 'targetMode');

  // Keep SL & Target unit modes in sync when both are configured.
  if (trade.stopLossMode && trade.targetMode && trade.stopLossMode !== trade.targetMode) {
    const synced = hasTg ? trade.targetMode : trade.stopLossMode;
    if (trade.stopLossMode !== synced) {
      trade.stopLossMode = synced;
      changes.stopLossMode = synced;
    }
    if (trade.targetMode !== synced) {
      trade.targetMode = synced;
      changes.targetMode = synced;
    }
  }

  if (!Object.keys(changes).length) {
    throw new Error('Send stopLoss and/or target to update');
  }

  trade.notes = [
    trade.notes,
    `risk@${new Date().toISOString()}; sl=${trade.stopLossPremium ?? 'off'}; tg=${trade.targetPremium ?? 'eod'}`,
  ]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 500);
  await trade.save();
  cacheTradeLite(trade);

  await logAction({
    action: 'POSITION_RISK_UPDATED',
    tradeId: trade._id,
    symbol: trade.symbol,
    message: `SL ${prev.stopLossPremium ?? 'off'} → ${trade.stopLossPremium ?? 'off'}; TG ${prev.targetPremium ?? 'eod'} → ${trade.targetPremium ?? 'eod'}`,
    details: { prev, next: changes, entryPremium: entry },
  });

  return trade;
}

async function checkPendingOrders(clock) {
  const pending = await ManualPendingOrder.find({
    strategyKey: getStrategyKey(),
    status: 'PENDING',
    orderType: 'LIMIT',
  }).sort({ createdAt: 1 });

  for (const order of pending) {
    if (order.sessionDateKey && order.sessionDateKey !== clock.dateKey) {
      await releaseHeldFunds(order);
      order.status = 'EXPIRED';
      order.cancelReason = 'SESSION_ENDED';
      await order.save();
      await logAction({
        action: 'ORDER_EXPIRED',
        orderId: order._id,
        symbol: order.symbol,
        message: 'Limit order expired — new session',
      });
      continue;
    }
    try {
      if (normalizeProduct(order.product) === 'FUTURE') {
        const { ltp } = await getFutureLtp({ symbol: order.symbol, expiry: order.expiryDate });
        if (!Number.isFinite(ltp) || ltp <= 0) continue;
        // LONG fills when price drops to/below limit; SHORT fills when price rises to/above limit.
        const fill = normalizeSide(order.side) === 'SHORT'
          ? ltp >= Number(order.limitPremium)
          : ltp <= Number(order.limitPremium);
        if (fill) {
          await fillOrderToTrade(order, { entryPremium: ltp, spot: ltp, clock });
        }
        continue;
      }
      const chain = await getAtmPremiums({
        symbol: order.symbol,
        strike: order.strike,
        expiry: order.expiryDate,
      });
      const ltp = premiumFromChain(chain, order.optionType);
      if (!Number.isFinite(ltp) || ltp <= 0) continue;
      if (ltp <= Number(order.limitPremium)) {
        const fut = await resolveIndexFutLtp(order.symbol, order.expiryDate);
        await fillOrderToTrade(order, { entryPremium: ltp, spot: fut.ltp, clock });
      }
    } catch (err) {
      engineState.lastError = `Limit order poll: ${err.message}`;
    }
  }
}

async function checkOpenPositions(clock) {
  const openTrades = await LivePaperTrade.find({
    strategyKey: getStrategyKey(),
    exitTime: null,
  }).sort({ entryTime: 1 });

  await syncLiveSubscriptions(openTrades);

  for (const trade of openTrades) {
    try {
      if (getDayCloseEnabled() && clock.dateKey !== trade.entryDateKey) {
        const mark = await resolveMarkForTrade(trade);
        await finalizeTrade(trade, {
          exitPremium: mark.optionLtp,
          mark,
          reason: 'DAY_CLOSE',
        });
        continue;
      }

      const tradeExpiry = String(trade.expiryDate || '').slice(0, 10);
      if (!getDayCloseEnabled() && tradeExpiry && clock.dateKey > tradeExpiry) {
        let mark = null;
        try {
          mark = await resolveMarkForTrade(trade);
        } catch {
          mark = null;
        }
        const lastLtp = Number(mark?.optionLtp) > 0
          ? Number(mark.optionLtp)
          : Number(trade.openPositionMark?.optionLtp) || Number(trade.entryPremium);
        await finalizeTrade(trade, {
          exitPremium: lastLtp,
          mark: { ...(mark || {}), optionLtp: lastLtp },
          reason: 'EXPIRY',
        });
        continue;
      }

      const mark = await resolveMarkForTrade(trade);
      const positionMark = buildOpenPositionMark(trade, mark, clock);
      cacheTradeLite(trade);
      publishTradeMark(trade._id, positionMark);
      await persistMarkThrottled(trade, positionMark);
      await evaluateExitsFromMark(trade, mark, clock);
    } catch (err) {
      engineState.lastError = `Position check ${trade._id}: ${err.message}`;
    }
  }
}

async function pollOnce() {
  const clock = getIstClock(new Date());
  engineState.lastPollAt = new Date();
  if (!engineState.running) return;
  // Dual desk: process index + stock futures each tick with isolated desk context.
  for (const deskName of Object.keys(DESKS)) {
    try {
      await runWithDesk(deskName, async () => {
        await processDeskClock(deskName, clock);
      });
    } catch (err) {
      engineState.lastError = `${deskName} poll: ${err.message}`;
    }
  }
}

async function processDeskClock(deskName, clock) {
  // Keep helper for dual-desk ticks. Real work lives in checkPendingOrders / checkOpenPositions.
  await checkPendingOrders(clock);
  await checkOpenPositions(clock);
}

function startPoll() {
  if (engineState.pollTimer) clearInterval(engineState.pollTimer);
  const tick = () => {
    pollOnce().catch((err) => {
      engineState.lastError = err.message;
    });
  };
  tick();
  engineState.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}

async function ensureEngineRunning(deskName = 'index') {
  const name = resolveDeskName(deskName);
  selectDesk(name);
  if (!engineState.running) {
    engineState.running = true;
    engineState.startedAt = new Date();
    startPoll();
    await runWithDesk(name, async () => {
      await logAction({
        action: 'ENGINE_STARTED',
        message: `${getDeskConfig(name).label} engine online`,
      });
    });
    // Warm WS for open positions on BOTH desks.
    for (const d of Object.keys(DESKS)) {
      const key = DESKS[d].strategyKey;
      LivePaperTrade.find({ strategyKey: key, exitTime: null })
        .then((open) => syncLiveSubscriptions(open))
        .catch((err) => {
          engineState.lastError = `WS warm-up ${d}: ${err.message}`;
        });
    }
  }
  return { ok: true, state: getEngineSnapshot(), desk: name };
}

function getEngineSnapshot() {
  return {
    running: engineState.running,
    startedAt: engineState.startedAt,
    lastError: engineState.lastError,
    lastPollAt: engineState.lastPollAt,
    liveSubscriptions: liveSubs.size,
  };
}

async function getQuote({ symbol, expiry, strike, optionType }) {
  const sym = normalizeSymbol(symbol);
  const exp = String(expiry || (await getNearestWeeklyExpiry(sym)) || '').slice(0, 10);
  if (!exp) throw new Error('Expiry required');
  const chain = await getAtmPremiums({ symbol: sym, strike: Number(strike) || 0, expiry: exp });
  const fut = await resolveIndexFutLtp(sym, exp);
  const spot = fut.ltp;
  const atm = atmStrikeFromSpot(spot, sym);
  const type = normalizeOptionType(optionType);
  const ltp = premiumFromChain(chain, type);
  return {
    symbol: sym,
    expiry: exp,
    spot,
    futExpiry: fut.expiry,
    atmStrike: atm,
    strike: Number(strike) || atm,
    optionType: type,
    ltp,
    ceLtp: chain.ceLtp,
    peLtp: chain.peLtp,
  };
}

async function getExpiries(symbol) {
  const sym = normalizeSymbol(symbol);
  const list = (await fetchExpiryList(sym)).map((d) => String(d).slice(0, 10));
  const today = getIstClock(new Date()).dateKey;
  const future = [...list].sort().filter((d) => d >= today);
  const nearest = future[0] || list[0] || null;
  return { symbol: sym, expiries: future.length ? future : list, nearest };
}

/** Symbol picker data: index underlyings (desk=index) or F&O stock underlyings (desk=stock). */
async function getInstrumentUniverse() {
  const desk = resolveDeskName();
  if (desk === 'stock') {
    let underlyings = [];
    try {
      underlyings = await listFutureUnderlyings();
    } catch {
      underlyings = [];
    }
    const stockOptions = underlyings.filter((s) => !ALLOWED_SYMBOLS.has(s) && isTradableStockUnderlying(s));
    stockOptions.sort((a, b) => a.localeCompare(b));
    return { indexOptions: [], stockOptions };
  }
  // Index Manual: index underlyings only (stocks live on Stock Manual).
  const indexOptions = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY'].filter((s) => ALLOWED_SYMBOLS.has(s));
  return { indexOptions, stockOptions: [] };
}

/** Live quote for a stock/index future order ticket. */
async function getFuture({ symbol, expiry } = {}) {
  const sym = await normalizeFutureSymbol(symbol);
  return getFutureQuote({ symbol: sym, expiry });
}

function pickLegLtp(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const last = Number(leg.last_price);
  if (Number.isFinite(last) && last > 0) return last;
  const bid = Number(leg.top_bid_price);
  const ask = Number(leg.top_ask_price);
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
    return Number(((bid + ask) / 2).toFixed(2));
  }
  if (Number.isFinite(ask) && ask > 0) return ask;
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

function findStrikeRow(strikes, strike) {
  const target = Number(strike);
  if (!Number.isFinite(target)) return null;
  const keys = Object.keys(strikes || {});
  let bestKey = null;
  let bestDiff = Infinity;
  for (const k of keys) {
    const diff = Math.abs(Number(k) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestKey = k;
    }
  }
  if (bestKey == null || bestDiff > 1) return null;
  return strikes[bestKey];
}

async function getChainAroundAtm({ symbol, expiry }) {
  const sym = normalizeSymbol(symbol);
  const exp = String(expiry || (await getNearestWeeklyExpiry(sym)) || '').slice(0, 10);
  const chain = await fetchOptionChainCached({ symbol: sym, expiry: exp });

  // Prefer futures LTP for ATM, but never block create-order on cold FUT feed —
  // option-chain last_price is enough to render the strike grid immediately.
  let spot = Number(chain?.last_price);
  let futExpiry = null;
  try {
    const fut = await resolveIndexFutLtp(sym, exp, { maxWaitMs: 400 });
    if (Number.isFinite(fut.ltp) && fut.ltp > 0) {
      spot = fut.ltp;
      futExpiry = fut.expiry;
    }
  } catch {
    // keep chain cash spot
  }
  if (!Number.isFinite(spot) || spot <= 0) {
    throw new Error('Underlying price unavailable for option chain');
  }

  const lotSize = Math.max(1, Number(await getCurrentLotSize(sym)) || 1);
  const strikes = chain.oc || {};
  let atm;
  let strikeList;
  if (getDayCloseEnabled()) {
    const step = getStrikeStep(sym);
    atm = atmStrikeFromSpot(spot, sym);
    strikeList = [];
    for (let i = -5; i <= 5; i += 1) strikeList.push(atm + i * step);
  } else {
    const keys = sortedChainStrikes(chain);
    const atmIdx = chainAtmIndex(keys, spot);
    if (atmIdx < 0) throw new Error(`Option chain has no strikes for ${sym}`);
    atm = keys[atmIdx];
    strikeList = keys.slice(Math.max(0, atmIdx - 5), atmIdx + 6);
  }
  const rows = [];
  for (const k of strikeList) {
    const row = findStrikeRow(strikes, k);
    if (!row) continue;
    rows.push({
      strike: k,
      ceLtp: pickLegLtp(row.ce),
      peLtp: pickLegLtp(row.pe),
    });
  }
  return {
    symbol: sym,
    expiry: exp,
    spot,
    futExpiry,
    atmStrike: atm,
    lotSize,
    strikes: rows,
  };
}

/** Live OI Chain board shape (FUT-anchored ATM + ΔOI). */
async function buildLiveOiBoard({ symbol, expiry, lookaroundStrikes = 10 } = {}) {
  const clock = getIstClock(new Date());
  const raw = String(symbol || 'NIFTY').toUpperCase().trim() || 'NIFTY';
  let sym = 'NIFTY';
  if (ALLOWED_SYMBOLS.has(raw)) {
    sym = raw;
  } else {
    sym = await normalizeFutureSymbol(raw);
  }
  const exp = String(expiry || (await getNearestWeeklyExpiry(sym)) || '').slice(0, 10);
  if (!exp) throw new Error('No weekly expiry from Dhan');

  let futLtp = null;
  let futExpiry = null;
  try {
    const fut = await resolveIndexFutLtp(sym, exp);
    futLtp = fut.ltp;
    futExpiry = fut.expiry;
  } catch {
    // snapshot can still use chain cash as fallback via spotOverride null
  }

  const lookaround = Math.max(5, Math.min(20, Math.floor(Number(lookaroundStrikes) || 10)));
  const snapshot = await getOptionChainOiSnapshot({
    symbol: sym,
    expiry: exp,
    lookaroundStrikes: lookaround,
    spotOverride: Number.isFinite(futLtp) ? futLtp : null,
  });

  const strikes = (snapshot.strikes || []).map((r) => ({
    strike: r.strike,
    putOi: r.putOi,
    callOi: r.callOi,
    putChgOi: r.putChgOi,
    callChgOi: r.callChgOi,
    totalOi: (Number(r.putOi) || 0) + (Number(r.callOi) || 0),
    ceLtp: r.ceLtp,
    peLtp: r.peLtp,
    distanceFromAtm: r.distanceFromAtm,
  }));

  let maxPut = null;
  let maxCall = null;
  let maxTotal = null;
  for (const row of strikes) {
    if (Number.isFinite(row.putOi) && (!maxPut || row.putOi > maxPut.putOi)) maxPut = row;
    if (Number.isFinite(row.callOi) && (!maxCall || row.callOi > maxCall.callOi)) maxCall = row;
    if (!maxTotal || row.totalOi > maxTotal.totalOi) maxTotal = row;
  }

  const totals = snapshot.totals || {};
  const boardPcr = Number(totals.pcr); // lookaround Put÷Call
  const nearPcr = Number(totals.nearPcr);
  const allPcr = Number(totals.allPcr); // full-chain Put÷Call
  const pcr = Number.isFinite(allPcr) ? allPcr : boardPcr;
  let pcrBias = 'NEUTRAL';
  // Prefer full-chain PCR for bias when available.
  const biasPcr = Number.isFinite(pcr) ? pcr : nearPcr;
  if (Number.isFinite(biasPcr)) {
    if (biasPcr >= 1.1) pcrBias = 'PUT_HEAVY';
    else if (biasPcr <= 0.9) pcrBias = 'CALL_HEAVY';
  }

  let callChgSum = 0;
  let putChgSum = 0;
  let sawCallChg = false;
  let sawPutChg = false;
  for (const row of strikes) {
    if (Number.isFinite(row.putChgOi)) {
      putChgSum += row.putChgOi;
      sawPutChg = true;
    }
    if (Number.isFinite(row.callChgOi)) {
      callChgSum += row.callChgOi;
      sawCallChg = true;
    }
  }

  return {
    at: new Date().toISOString(),
    dateKey: clock.dateKey,
    priceSource: 'FUT',
    symbol: sym,
    spot: snapshot.spot,
    fut: Number.isFinite(futLtp) ? futLtp : snapshot.spot,
    futExpiry,
    chainSpot: snapshot.chainSpot ?? null,
    atm: snapshot.atm,
    expiry: exp,
    strikeStep: snapshot.strikeStep,
    strikes,
    totals: {
      callOi: totals.callOi ?? null,
      putOi: totals.putOi ?? null,
      allCallOi: totals.allCallOi ?? null,
      allPutOi: totals.allPutOi ?? null,
      callChgOi: sawCallChg ? Math.round(callChgSum) : null,
      putChgOi: sawPutChg ? Math.round(putChgSum) : null,
      totalChgOi: (sawCallChg || sawPutChg)
        ? Math.round((sawCallChg ? callChgSum : 0) + (sawPutChg ? putChgSum : 0))
        : null,
      pcr: Number.isFinite(boardPcr) ? boardPcr : null,
      nearPcr: Number.isFinite(nearPcr) ? nearPcr : null,
      allPcr: Number.isFinite(allPcr) ? allPcr : null,
      pcrBias,
    },
    highlight: {
      maxPutStrike: maxPut?.strike ?? null,
      maxCallStrike: maxCall?.strike ?? null,
      maxTotalStrike: maxTotal?.strike ?? null,
    },
  };
}

async function getLiveOiBoard(opts = {}) {
  const lookaround = Math.max(5, Math.min(20, Math.floor(Number(opts.lookaroundStrikes) || 10)));
  const raw = String(opts.symbol || 'NIFTY').toUpperCase().trim() || 'NIFTY';
  const expHint = String(opts.expiry || '').slice(0, 10);
  const key = `${raw}|${expHint}|${lookaround}`;
  const hit = oiBoardMemo.get(key);
  if (hit?.board && Date.now() - hit.at < OI_BOARD_CACHE_MS) return hit.board;
  if (hit?.pending) return hit.pending;
  const pending = buildLiveOiBoard({ ...opts, lookaroundStrikes: lookaround })
    .then((board) => {
      const rec = { at: Date.now(), board, pending: null };
      oiBoardMemo.set(key, rec);
      const exact = `${board.symbol}|${String(board.expiry || '').slice(0, 10)}|${lookaround}`;
      if (exact !== key) oiBoardMemo.set(exact, rec);
      return board;
    })
    .catch((err) => {
      const prev = oiBoardMemo.get(key);
      oiBoardMemo.set(key, { at: prev?.at || 0, board: prev?.board || null, pending: null });
      throw err;
    });
  oiBoardMemo.set(key, { at: hit?.at || 0, board: hit?.board || null, pending });
  return pending;
}

async function getOiBoardTotals(opts = {}) {
  const board = await getLiveOiBoard({ ...opts, lookaroundStrikes: 15 });
  const totals = board?.totals || {};
  const putOi = Number(Number.isFinite(Number(totals.allPutOi)) ? totals.allPutOi : totals.putOi);
  const callOi = Number(Number.isFinite(Number(totals.allCallOi)) ? totals.allCallOi : totals.callOi);
  const pcr = Number.isFinite(callOi) && callOi > 0 && Number.isFinite(putOi) ? putOi / callOi : null;
  return {
    at: board.at,
    symbol: board.symbol,
    atm: board.atm,
    fut: board.fut ?? board.spot,
    spot: board.chainSpot ?? board.spot,
    putOi: Number.isFinite(putOi) ? putOi : null,
    callOi: Number.isFinite(callOi) ? callOi : null,
    pcr: Number.isFinite(pcr) ? pcr : null,
  };
}

async function syncClosedTradeStats(wallet) {
  // Full main-only rebuild so wallet tiles never mix testing into available cash.
  return rebuildMainWalletLedger(wallet);
}

async function getStatus() {
  const deskName = resolveDeskName();
  await ensureEngineRunning(deskName);
  const now = Date.now();
  if (
    !lastRepairTestingAtByDesk[deskName]
    || now - lastRepairTestingAtByDesk[deskName] > REPAIR_TESTING_MS
  ) {
    await repairTestingFlags();
    lastRepairTestingAtByDesk[deskName] = now;
  }
  const clock = getIstClock(new Date());
  let wallet = await ensureWallet();
  // Repair wallet profit/loss from closed book occasionally (not every poll).
  if (
    !lastClosedStatsSyncAtByDesk[deskName]
    || now - lastClosedStatsSyncAtByDesk[deskName] > CLOSED_STATS_SYNC_MS
  ) {
    wallet = await syncClosedTradeStats(wallet);
    lastClosedStatsSyncAtByDesk[deskName] = now;
  }
  wallet = await ensureDepositHistoryBackfill(wallet);
  const openTrades = await LivePaperTrade.find({
    strategyKey: getStrategyKey(),
    exitTime: null,
  })
    .sort({ entryTime: -1 })
    .lean();
  const pendingOrders = await ManualPendingOrder.find({
    strategyKey: getStrategyKey(),
    status: 'PENDING',
  })
    .sort({ createdAt: -1 })
    .lean();

  // Overlay freshest in-memory / WS marks so /status is never stale vs Socket ticks.
  let unrealizedPnl = 0;
  let openMainCapital = 0;
  for (const t of openTrades) {
    const id = String(t._id);
    const mem = latestMarks.get(id);
    const wsTick = getFreshWsTick(id);
    if (mem && Number(mem.optionLtp) > 0) {
      t.openPositionMark = mem;
      t.openPositionMarkAt = mem.at ? new Date(mem.at) : t.openPositionMarkAt;
    } else if (wsTick) {
      t.openPositionMark = buildOpenPositionMark(
        t,
        { optionLtp: wsTick.ltp, spot: t.openPositionMark?.spot ?? null, source: 'websocket' },
        clock,
      );
      t.openPositionMarkAt = new Date(wsTick.ts);
      latestMarks.set(id, t.openPositionMark);
    }
    // Main book only for available-cash MTM / capital summary.
    if (isMainTrade(t)) {
      unrealizedPnl += Number(t.openPositionMark?.unrealizedPnl) || 0;
      const locked = Number(t.capitalLocked);
      openMainCapital += Number.isFinite(locked) && locked > 0
        ? locked
        : (Number(t.investedAmount) || 0) + Math.max(0, Number(t.charges) || 0);
    }
  }

  const desk = getDeskConfig(deskName);
  return {
    desk: deskName,
    strategyKey: desk.strategyKey,
    walletKey: desk.walletKey,
    engine: getEngineSnapshot(),
    istDateKey: clock.dateKey,
    wallet: serializeWallet(wallet, {
      openCapitalLocked: openMainCapital,
      pendingHeld: pendingOrders.reduce((sum, o) => sum + (Number(o.heldAmount) || 0), 0),
    }),
    openTrades,
    pendingOrders,
    openUnrealizedPnl: Number(unrealizedPnl.toFixed(2)),
    liveFeed: {
      subscribed: liveSubs.size,
      wsFreshMs: WS_FRESH_MS,
    },
  };
}

async function listTrades({ page = 1, pageSize = 50, status = 'ALL', book = 'all' } = {}) {
  await repairTestingFlags();
  const filter = { strategyKey: getStrategyKey() };
  const statusQ = String(status || 'ALL').toUpperCase();
  const bookQ = String(book || 'all').toLowerCase();
  if (statusQ === 'OPEN') {
    filter.exitTime = null;
    filter.status = { $ne: 'CLOSED' };
  } else if (statusQ === 'CLOSED') {
    filter.$or = [{ exitTime: { $ne: null } }, { status: 'CLOSED' }];
  }
  if (bookQ === 'testing') {
    filter.isTesting = true;
  } else if (bookQ === 'main') {
    filter.isTesting = { $ne: true };
  }
  const totalRows = await LivePaperTrade.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const skip = (currentPage - 1) * pageSize;
  const trades = await LivePaperTrade.find(filter)
    .sort({ entryTime: -1 })
    .skip(skip)
    .limit(pageSize)
    .lean();
  const tradesWithSr = trades.map((t, i) => ({ ...t, srNo: skip + i + 1 }));
  let bookPnl = null;
  if (statusQ === 'CLOSED') {
    const agg = await LivePaperTrade.aggregate([
      { $match: filter },
      { $group: { _id: null, pnl: { $sum: '$pnl' } } },
    ]);
    bookPnl = Number(agg[0]?.pnl) || 0;
  }
  return {
    trades: tradesWithSr,
    pagination: { page: currentPage, pageSize, totalRows, totalPages },
    book: bookQ,
    bookPnl,
  };
}

async function listActions({ page = 1, pageSize = 50 }) {
  const filter = { strategyKey: getStrategyKey() };
  const totalRows = await ManualTradeAction.countDocuments(filter);
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const actions = await ManualTradeAction.find(filter)
    .sort({ createdAt: -1 })
    .skip((currentPage - 1) * pageSize)
    .limit(pageSize)
    .lean();
  return { actions, pagination: { page: currentPage, pageSize, totalRows, totalPages } };
}

async function resetWallet() {
  for (const id of [...liveSubs.keys()]) dropTradeSubscription(id);
  // Refund any pending limit holds before wiping orders.
  const pending = await ManualPendingOrder.find({
    strategyKey: getStrategyKey(),
    status: 'PENDING',
    heldAmount: { $gt: 0 },
  });
  for (const order of pending) {
    await releaseHeldFunds(order);
    await order.save();
  }
  await LivePaperTrade.deleteMany({ strategyKey: getStrategyKey() });
  await ManualPendingOrder.deleteMany({ strategyKey: getStrategyKey() });
  const wallet = await ensureWallet();
  // Keep topped-up capital; clear P/L and free all cash back to deposits.
  wallet.balance = Number(wallet.startingBalance || 0);
  wallet.realizedPnl = 0;
  wallet.grossProfit = 0;
  wallet.grossLoss = 0;
  wallet.totalTrades = 0;
  wallet.wins = 0;
  wallet.losses = 0;
  wallet.lastResetAt = new Date();
  wallet.cashLedger = true;
  await wallet.save();
  await logAction({ action: 'WALLET_RESET', message: 'Manual console trades cleared — capital kept' });
  return serializeWallet(wallet);
}

module.exports = {
  DESKS,
  DESK_INDEX,
  DESK_STOCK,
  getStrategyKey,
  getWalletKey,
  getDayCloseEnabled,
  getStrategyId,
  selectDesk,
  runWithDesk,
  TOPUP_AMOUNTS,
  ensureEngineRunning,
  getEngineSnapshot,
  createOrder,
  cancelOrder,
  closePositionById,
  updatePositionRisk,
  getStatus,
  getQuote,
  getExpiries,
  getInstrumentUniverse,
  getFuture,
  getChainAroundAtm,
  getLiveOiBoard,
  getOiBoardTotals,
  listTrades,
  listActions,
  resetWallet,
  topUpWallet,
  recalcWalletFromTrades,
  logAction,
  getLiveMarkSnapshot,
};
