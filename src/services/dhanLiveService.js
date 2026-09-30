const axios = require('axios/dist/node/axios.cjs');
const WebSocket = require('ws');
const { readLatestAccessToken, isLikelyDhanAuthError, ensureValidDhanAccessToken } = require('./tokenService');
const { getDhanClientId } = require('./dhanTokenStore');
const { resolveSymbolConfig, getStrikeStep } = require('../utils/market');
const { parseDateOnly, formatDateOnly, addDays } = require('../utils/dateTime');
const { ensureNseHolidaysLoaded, isNseCashTradingDay } = require('./nseHolidayService');

const DHAN_BASE = process.env.DHAN_API_BASE_URL || 'https://api.dhan.co/v2';
const DHAN_WS_URL = 'wss://api-feed.dhan.co';
const INSTRUMENT_CSV_URL =
  process.env.DHAN_INSTRUMENT_CSV || 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';

// ----------------- Instrument Master (lot sizes, security ids) -----------------

const instrumentCache = {
  rows: null,
  loadedAt: 0,
  ttlMs: 6 * 60 * 60 * 1000,
};

async function loadInstrumentMaster({ force = false } = {}) {
  if (!force && instrumentCache.rows && Date.now() - instrumentCache.loadedAt < instrumentCache.ttlMs) {
    return instrumentCache.rows;
  }
  const response = await axios.get(INSTRUMENT_CSV_URL, { timeout: 60000, responseType: 'text' });
  const text = String(response.data || '');
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) throw new Error('Empty instrument master CSV');
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(',');
    const obj = {};
    for (let c = 0; c < headers.length; c += 1) {
      obj[headers[c]] = (cols[c] || '').trim();
    }
    rows.push(obj);
  }
  instrumentCache.rows = rows;
  instrumentCache.loadedAt = Date.now();
  return rows;
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== '') return row[key];
  }
  return null;
}

async function getCurrentLotSize(underlying) {
  const upper = String(underlying || '').toUpperCase();
  try {
    const rows = await loadInstrumentMaster();
    const today = new Date().toISOString().slice(0, 10);
    // Find current futures / options contracts for the underlying.
    const candidates = rows.filter((r) => {
      const instr = (pickField(r, ['INSTRUMENT', 'INSTRUMENT_TYPE', 'SEM_INSTRUMENT_NAME']) || '').toUpperCase();
      const ulName = (pickField(r, ['UNDERLYING_SYMBOL', 'SEM_TRADING_SYMBOL', 'SYMBOL_NAME']) || '').toUpperCase();
      if (!(instr === 'FUTIDX' || instr === 'FUTSTK' || instr === 'OPTIDX' || instr === 'OPTSTK')) return false;
      // Match strictly by underlying symbol so NIFTY does not accidentally pick up MIDCPNIFTY etc.
      if (instr === 'FUTIDX' || instr === 'FUTSTK' || instr === 'OPTSTK') return ulName === upper;
      // For OPTIDX the trading symbol starts with the underlying followed by a separator.
      return ulName === upper || ulName.startsWith(`${upper}-`) || ulName.startsWith(`${upper} `);
    });
    // Prefer the nearest expiry >= today.
    const withExpiry = candidates
      .map((r) => ({
        row: r,
        expiry: pickField(r, ['SEM_EXPIRY_DATE', 'EXPIRY_DATE', 'ExpiryDate']) || '',
        lotSize: Number(pickField(r, ['LOT_SIZE', 'SEM_LOT_UNITS', 'LotSize'])),
      }))
      .filter((c) => Number.isFinite(c.lotSize) && c.lotSize > 0);
    const future = withExpiry.filter((c) => c.expiry && c.expiry.slice(0, 10) >= today);
    const past = withExpiry.filter((c) => !future.includes(c));
    const sortedFuture = future.sort((a, b) => a.expiry.localeCompare(b.expiry));
    const sortedPast = past.sort((a, b) => b.expiry.localeCompare(a.expiry));
    const best = sortedFuture[0] || sortedPast[0];
    if (best) return best.lotSize;
  } catch {
    // ignore and fall back below
  }
  // Sensible 2025+ SEBI defaults if master file is unavailable.
  if (upper === 'NIFTY') return 65;
  if (upper === 'BANKNIFTY') return 30;
  if (upper === 'SENSEX') return 20;
  if (upper === 'FINNIFTY') return 60;
  if (upper === 'MIDCPNIFTY') return 120;
  return 1;
}

// ----------------- Option Chain -----------------

/** Cache dynamic equity underlyings resolved from the instrument master. */
const optionUnderlyingCache = new Map();

/**
 * Resolve Dhan option-chain UnderlyingScrip / UnderlyingSeg.
 * Indexes + liquid stocks use PRESET_SYMBOLS; any other FUTSTK/OPTSTK falls back
 * to UNDERLYING_SECURITY_ID from the instrument master (NSE_EQ).
 */
async function resolveOptionChainUnderlying(symbol) {
  const upper = String(symbol || '').toUpperCase().trim();
  if (!upper) throw new Error('Symbol required for option chain');

  const preset = resolveSymbolConfig(upper);
  if (preset.securityId && preset.exchangeSegment) {
    return {
      symbol: upper,
      securityId: String(preset.securityId),
      exchangeSegment: preset.exchangeSegment,
      instrument: preset.instrument || 'INDEX',
    };
  }

  const cached = optionUnderlyingCache.get(upper);
  if (cached && Date.now() - cached.at < instrumentCache.ttlMs) {
    return cached.value;
  }

  const rows = await loadInstrumentMaster();
  let found = null;
  for (const r of rows) {
    const instr = String(
      pickField(r, ['INSTRUMENT', 'INSTRUMENT_TYPE', 'SEM_INSTRUMENT_NAME']) || '',
    ).toUpperCase();
    if (instr !== 'FUTSTK' && instr !== 'OPTSTK') continue;
    if (normalizeExchangeSegment(r) !== 'NSE_FNO') continue;
    const ul = String(pickField(r, ['UNDERLYING_SYMBOL', 'UNDERLYING']) || '')
      .toUpperCase()
      .trim();
    if (ul !== upper) continue;
    const underlyingSecurityId = String(
      pickField(r, ['UNDERLYING_SECURITY_ID', 'UNDERLYING_SECURITY']) || '',
    ).trim();
    if (!/^\d+$/.test(underlyingSecurityId)) continue;
    found = {
      symbol: upper,
      securityId: underlyingSecurityId,
      exchangeSegment: 'NSE_EQ',
      instrument: 'EQUITY',
    };
    break;
  }

  if (!found) {
    throw new Error(`Unsupported symbol for option chain: ${upper}`);
  }
  optionUnderlyingCache.set(upper, { at: Date.now(), value: found });
  return found;
}

async function fetchExpiryList(symbol) {
  const resolved = await resolveOptionChainUnderlying(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for option chain');
  }
  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');

  const body = {
    UnderlyingScrip: Number(resolved.securityId),
    UnderlyingSeg: resolved.exchangeSegment,
  };
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
  };
  try {
    const resp = await axios.post(`${DHAN_BASE}/optionchain/expirylist`, body, { headers, timeout: 20000 });
    const list = resp.data?.data || [];
    return Array.isArray(list) ? list : [];
  } catch (error) {
    if (isLikelyDhanAuthError(error)) {
      const renewed = await ensureValidDhanAccessToken('optionchain-expiry');
      const retry = await axios.post(
        `${DHAN_BASE}/optionchain/expirylist`,
        body,
        { headers: { ...headers, 'access-token': renewed }, timeout: 20000 }
      );
      const list = retry.data?.data || [];
      return Array.isArray(list) ? list : [];
    }
    throw error;
  }
}

const OPTION_CHAIN_MIN_INTERVAL_MS = 4000;
const OPTION_CHAIN_STALE_MAX_AGE_MS = 5 * 60 * 1000;
const OPTION_CHAIN_429_COOLDOWN_MS = 90 * 1000;
const OPTION_CHAIN_5XX_COOLDOWN_MS = 12 * 1000;
/** When no warm cache exists, do not hard-block for the full cooldown — probe sooner. */
const OPTION_CHAIN_EMPTY_CACHE_PROBE_MS = 20000;
const OPTION_CHAIN_HTTP_TIMEOUT_MS = 12000;
const optionChainCache = new Map();
const optionChainInflight = new Map();
let optionChainRateLimitedUntil = 0;
let optionChainLastEmptyProbeAt = 0;

function isHttpRateLimitError(error) {
  const status = Number(error?.response?.status);
  if (status === 429) return true;
  const msg = String(error?.message || error?.response?.data?.errorMessage || '');
  return msg.includes('429') || /rate\s*limit|Too many requests|805/i.test(msg);
}

/** Dhan sometimes returns HTTP 200 with {805:"Too many requests"} and no `oc`. */
function isDhanRateLimitPayload(data) {
  if (!data || typeof data !== 'object') return false;
  if (data['805'] != null) return true;
  const blob = JSON.stringify(data);
  return /Too many requests|rate\s*limit/i.test(blob);
}

/**
 * Normalize option-chain payload. Rejects empty / rate-limit bodies so we never
 * cache `{}` and poison the OI Flow tracker with "oc empty".
 */
function normalizeOptionChainData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (isDhanRateLimitPayload(raw)) return null;
  const root = raw.oc && typeof raw.oc === 'object'
    ? raw
    : raw.data && raw.data.oc && typeof raw.data.oc === 'object'
      ? raw.data
      : null;
  if (!root?.oc || typeof root.oc !== 'object') return null;
  const ocKeys = Object.keys(root.oc);
  if (!ocKeys.length) return null;
  return {
    last_price: root.last_price ?? raw.last_price ?? null,
    oc: root.oc,
  };
}

function makeRateLimitError(detail) {
  const err = new Error(detail || 'Dhan option chain rate limited (429)');
  err.response = { status: 429, data: { message: detail } };
  return err;
}

function isTransientOptionChainError(error) {
  const status = Number(error?.response?.status);
  if ([500, 502, 503, 504].includes(status)) return true;
  const code = String(error?.code || '');
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return true;
  const msg = String(error?.message || '');
  return /timeout|network|socket|status code 5\d\d/i.test(msg);
}

function axiosStatus(error) {
  return Number(error?.response?.status) || null;
}

async function fetchOptionChain({ symbol, expiry }) {
  const resolved = await resolveOptionChainUnderlying(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for option chain');
  }
  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');

  const body = {
    UnderlyingScrip: Number(resolved.securityId),
    UnderlyingSeg: resolved.exchangeSegment,
    Expiry: String(expiry),
  };
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
  };
  const parseChainResponse = (resp) => {
    const envelope = resp?.data;
    const raw = envelope?.data !== undefined ? envelope.data : envelope;
    if (isDhanRateLimitPayload(raw) || isDhanRateLimitPayload(envelope)) {
      throw makeRateLimitError('Dhan option chain rate limited');
    }
    // Failed status with no strikes
    if (
      envelope
      && String(envelope.status || '').toLowerCase() === 'failed'
      && !normalizeOptionChainData(raw)
    ) {
      if (isDhanRateLimitPayload(envelope) || isDhanRateLimitPayload(raw)) {
        throw makeRateLimitError('Dhan option chain rate limited');
      }
      throw new Error(
        envelope.message || envelope.remarks || 'Dhan option chain request failed',
      );
    }
    const normalized = normalizeOptionChainData(raw);
    if (!normalized) {
      throw new Error('Dhan option chain has no strike rows (oc empty)');
    }
    return normalized;
  };

  try {
    const resp = await axios.post(`${DHAN_BASE}/optionchain`, body, {
      headers,
      timeout: OPTION_CHAIN_HTTP_TIMEOUT_MS,
    });
    return parseChainResponse(resp);
  } catch (error) {
    if (isLikelyDhanAuthError(error)) {
      const renewed = await ensureValidDhanAccessToken('optionchain-data');
      const retry = await axios.post(
        `${DHAN_BASE}/optionchain`,
        body,
        { headers: { ...headers, 'access-token': renewed }, timeout: OPTION_CHAIN_HTTP_TIMEOUT_MS }
      );
      return parseChainResponse(retry);
    }
    throw error;
  }
}

/** Dhan option chain is heavily rate-limited — coalesce callers and reuse stale data on 429/5xx. */
async function fetchOptionChainCached({ symbol, expiry, allowStale = true } = {}) {
  const key = `${String(symbol).toUpperCase()}|${String(expiry)}`;
  const now = Date.now();
  const cached = optionChainCache.get(key);

  if (optionChainRateLimitedUntil && now < optionChainRateLimitedUntil) {
    if (cached && allowStale) return cached.data;
    // No cache yet (common right after boot) — allow a sparse probe so engines are not stuck ~60s.
    const canProbeEmpty =
      !cached && now - optionChainLastEmptyProbeAt >= OPTION_CHAIN_EMPTY_CACHE_PROBE_MS;
    if (!canProbeEmpty) {
      const waitSec = Math.ceil(
        Math.min(
          optionChainRateLimitedUntil - now,
          Math.max(0, OPTION_CHAIN_EMPTY_CACHE_PROBE_MS - (now - optionChainLastEmptyProbeAt)),
        ) / 1000,
      );
      throw new Error(`Dhan option chain cooling down — retry in ~${Math.max(1, waitSec)}s`);
    }
    optionChainLastEmptyProbeAt = now;
    // fall through to fetch
  }

  if (cached && now - cached.at < OPTION_CHAIN_MIN_INTERVAL_MS) {
    return cached.data;
  }

  if (optionChainInflight.has(key)) {
    return optionChainInflight.get(key);
  }

  const task = (async () => {
    try {
      const data = await fetchOptionChain({ symbol, expiry });
      // Never cache empty / invalid chains (would poison every caller for MIN_INTERVAL).
      if (!data?.oc || !Object.keys(data.oc).length) {
        throw new Error('Dhan option chain has no strike rows (oc empty)');
      }
      optionChainCache.set(key, { at: Date.now(), data });
      optionChainRateLimitedUntil = 0;
      return data;
    } catch (error) {
      const status = axiosStatus(error);
      if (isHttpRateLimitError(error)) {
        optionChainRateLimitedUntil = Date.now() + OPTION_CHAIN_429_COOLDOWN_MS;
      } else if (isTransientOptionChainError(error)) {
        optionChainRateLimitedUntil = Date.now() + OPTION_CHAIN_5XX_COOLDOWN_MS;
      } else if (/oc empty/i.test(String(error?.message || ''))) {
        // Empty body often means soft rate-limit — cool down briefly.
        optionChainRateLimitedUntil = Date.now() + Math.min(OPTION_CHAIN_429_COOLDOWN_MS, 30000);
      }

      if (
        allowStale
        && cached
        && cached.data?.oc
        && Object.keys(cached.data.oc).length
        && now - cached.at < OPTION_CHAIN_STALE_MAX_AGE_MS
        && (isHttpRateLimitError(error) || isTransientOptionChainError(error) || /oc empty/i.test(String(error?.message || '')))
      ) {
        // Keep board alive on Dhan blips (500 / timeout / 429 / empty).
        cached.stale = true;
        cached.staleReason = status ? `HTTP_${status}` : String(error.code || error.message || 'ERR');
        return cached.data;
      }
      throw error;
    } finally {
      optionChainInflight.delete(key);
    }
  })();

  optionChainInflight.set(key, task);
  return task;
}

function getOptionChainRateLimitStatus() {
  const now = Date.now();
  return {
    coolingDown: Boolean(optionChainRateLimitedUntil && now < optionChainRateLimitedUntil),
    until: optionChainRateLimitedUntil || null,
  };
}

async function getNearestWeeklyExpiry(symbol) {
  const list = await fetchExpiryList(symbol);
  if (list.length === 0) return null;
  // Use IST calendar day — UTC date can be wrong near IST midnight.
  const { getIstClock } = require('../utils/dateTime');
  const today = getIstClock(new Date()).dateKey;
  const sorted = [...list].map((e) => String(e).slice(0, 10)).sort();
  for (const expiry of sorted) {
    if (expiry >= today) return expiry;
  }
  return sorted[sorted.length - 1];
}

/** Next weekly expiry after the nearest — skip the current expiry for new short-straddle entries. */
async function getNextWeeklyExpiry(symbol, dateKey) {
  const list = await fetchExpiryList(symbol);
  if (list.length === 0) return null;
  const today = String(dateKey || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const future = [...list]
    .map((expiry) => String(expiry).slice(0, 10))
    .sort()
    .filter((expiry) => expiry >= today);
  if (future.length >= 2) return future[1];
  if (future.length === 1) return future[0];
  const sorted = [...list].sort();
  return String(sorted[sorted.length - 1]).slice(0, 10);
}

/**
 * Last expiry date (YYYY-MM-DD) still blocked for new entries on `dateKey`.
 *
 * When tradingDaysAhead=1, this matches the old behavior: "skip expiry day + 1 day before"
 * using trading-day aware counting.
 */
function getNearExpiryCutoffDateKey(dateKey, tradingDaysAhead = 1) {
  const base = String(dateKey || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(base)) {
    return new Date().toISOString().slice(0, 10);
  }

  let cursor = parseDateOnly(base);
  if (Number.isNaN(cursor.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  // Move forward day-by-day and count only cash trading days.
  const target = Math.max(0, Number(tradingDaysAhead) || 0);
  let remaining = target;
  // Worst case: keep it bounded even if the holiday cache is stale.
  for (let guard = 0; guard < 60 && remaining > 0; guard += 1) {
    cursor = addDays(cursor, 1);
    const key = formatDateOnly(cursor);
    if (isNseCashTradingDay(key)) {
      remaining -= 1;
      if (remaining <= 0) return key;
    }
  }

  return formatDateOnly(cursor);
}

/** True when weekly expiry is within `tradingDaysAhead` (IST) — use next expiry for new trades. */
function isExpiryTooSoonForNewEntry(expiry, dateKey, tradingDaysAhead = 1) {
  const e = String(expiry || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) return true;
  return e <= getNearExpiryCutoffDateKey(dateKey, tradingDaysAhead);
}

async function getTradableWeeklyExpiry(symbol, dateKey, tradingDaysAhead = 1) {
  // Ensure holiday cache is ready so trading-day aware cutoff works correctly.
  await ensureNseHolidaysLoaded();

  const list = await fetchExpiryList(symbol);
  if (list.length === 0) return null;
  const today = String(dateKey || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const cutoff = getNearExpiryCutoffDateKey(today, tradingDaysAhead);
  const sorted = [...list].sort();
  for (const expiry of sorted) {
    const e = String(expiry).slice(0, 10);
    if (e > cutoff) return e;
  }
  for (const expiry of sorted) {
    if (String(expiry).slice(0, 10) >= today) return String(expiry).slice(0, 10);
  }
  return String(sorted[sorted.length - 1]).slice(0, 10);
}

function pickLegHighMark(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const candidates = [
    Number(leg.last_price),
    Number(leg.top_ask_price),
    Number(leg.top_bid_price),
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function pickLegLowMark(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const candidates = [
    Number(leg.last_price),
    Number(leg.top_bid_price),
    Number(leg.top_ask_price),
  ].filter((n) => Number.isFinite(n) && n > 0);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/** Best-effort LTP from chain leg (last traded, else bid/ask mid). */
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

async function getAtmPremiums({ symbol, strike, expiry }) {
  const chain = await fetchOptionChainCached({ symbol, expiry });
  const spot = Number(chain.last_price);
  const strikes = chain.oc || {};
  const row = findStrikeRow(strikes, strike);
  if (!row) {
    return {
      spot,
      ceLtp: null,
      peLtp: null,
      ceMarkHigh: null,
      ceMarkLow: null,
      peMarkHigh: null,
      peMarkLow: null,
      chainSpot: spot,
    };
  }
  const ce = row.ce || {};
  const pe = row.pe || {};
  const ceLast = pickLegLtp(ce);
  const peLast = pickLegLtp(pe);
  return {
    spot,
    ceLtp: ceLast,
    peLtp: peLast,
    ceMarkHigh: pickLegHighMark(ce),
    ceMarkLow: pickLegLowMark(ce),
    peMarkHigh: pickLegHighMark(pe),
    peMarkLow: pickLegLowMark(pe),
    chainSpot: spot,
  };
}

function readOiField(leg, keys) {
  if (!leg || typeof leg !== 'object') return null;
  for (const key of keys) {
    const n = Number(leg[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * Live option-chain OI snapshot (not persisted). Parses Dhan `oc` CE/PE oi + previous_oi.
 * Returns nearby strikes ranked by Put vs Call dominance for OI wall strategies.
 */
async function getOptionChainOiSnapshot({
  symbol = 'NIFTY',
  expiry,
  spotOverride = null,
  lookaroundStrikes = 5,
} = {}) {
  const chain = await fetchOptionChainCached({ symbol, expiry });
  if (!chain || typeof chain !== 'object') {
    throw new Error('Dhan option chain returned empty payload');
  }
  const spot = Number(spotOverride ?? chain.last_price);
  const strikesMap = chain.oc || {};
  if (!strikesMap || Object.keys(strikesMap).length === 0) {
    throw new Error('Dhan option chain has no strike rows (oc empty)');
  }
  const strikeStepDefault = getStrikeStep(symbol);
  // Prefer live chain spacing when available (stocks/indexes differ).
  const rawStrikeKeys = Object.keys(strikesMap)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  let strikeStep = strikeStepDefault;
  if (rawStrikeKeys.length >= 2) {
    let minGap = Infinity;
    for (let i = 1; i < rawStrikeKeys.length; i += 1) {
      const gap = rawStrikeKeys[i] - rawStrikeKeys[i - 1];
      if (gap > 0 && gap < minGap) minGap = gap;
    }
    if (Number.isFinite(minGap) && minGap > 0) strikeStep = minGap;
  }
  const atm = Number.isFinite(spot) && spot > 0
    ? Math.round(spot / strikeStep) * strikeStep
    : null;

  const rows = [];
  for (const [strikeKey, row] of Object.entries(strikesMap)) {
    const strike = Number(strikeKey);
    if (!Number.isFinite(strike)) continue;
    const ce = row?.ce || row?.CE || {};
    const pe = row?.pe || row?.PE || {};
    const callOi = readOiField(ce, ['oi', 'OI', 'open_interest', 'openInterest']);
    const putOi = readOiField(pe, ['oi', 'OI', 'open_interest', 'openInterest']);
    const callPrevOi = readOiField(ce, ['previous_oi', 'previousOi', 'prev_oi', 'previous_OI']);
    const putPrevOi = readOiField(pe, ['previous_oi', 'previousOi', 'prev_oi', 'previous_OI']);
    let callChg = readOiField(ce, [
      'oichange',
      'oi_change',
      'changeinOpenInterest',
      'change_in_oi',
      'changeInOI',
      'oiChange',
    ]);
    let putChg = readOiField(pe, [
      'oichange',
      'oi_change',
      'changeinOpenInterest',
      'change_in_oi',
      'changeInOI',
      'oiChange',
    ]);
    if (!Number.isFinite(callChg) && Number.isFinite(callOi) && Number.isFinite(callPrevOi)) {
      callChg = callOi - callPrevOi;
    }
    if (!Number.isFinite(putChg) && Number.isFinite(putOi) && Number.isFinite(putPrevOi)) {
      putChg = putOi - putPrevOi;
    }
    rows.push({
      strike,
      callOi,
      putOi,
      callPrevOi,
      putPrevOi,
      callChgOi: Number.isFinite(callChg) ? callChg : null,
      putChgOi: Number.isFinite(putChg) ? putChg : null,
      ceLtp: pickLegLtp(ce),
      peLtp: pickLegLtp(pe),
      distanceFromAtm: atm != null ? Math.abs(strike - atm) : null,
    });
  }

  rows.sort((a, b) => a.strike - b.strike);
  const near =
    atm == null
      ? rows
      : rows.filter((r) => Math.abs(r.strike - atm) <= lookaroundStrikes * strikeStep);

  // Full-chain totals (header / Sensibull-style PCR).
  let allCallOi = 0;
  let allPutOi = 0;
  let allCallChgOi = 0;
  let allPutChgOi = 0;
  let hasCallChg = false;
  let hasPutChg = false;
  for (const r of rows) {
    const c = Number(r.callOi);
    const p = Number(r.putOi);
    if (Number.isFinite(c) && c > 0) allCallOi += c;
    if (Number.isFinite(p) && p > 0) allPutOi += p;
    const cc = Number(r.callChgOi);
    const pc = Number(r.putChgOi);
    if (Number.isFinite(cc)) {
      allCallChgOi += cc;
      hasCallChg = true;
    }
    if (Number.isFinite(pc)) {
      allPutChgOi += pc;
      hasPutChg = true;
    }
  }

  // Board window totals (lookaround strikes only).
  let sumCallOi = 0;
  let sumPutOi = 0;
  let sumCallChgOi = 0;
  let sumPutChgOi = 0;
  let hasNearCallChg = false;
  let hasNearPutChg = false;
  let nearCallOi = 0;
  let nearPutOi = 0;
  const nearBand = strikeStep * 5;
  for (const r of near) {
    const c = Number(r.callOi);
    const p = Number(r.putOi);
    if (Number.isFinite(c) && c > 0) sumCallOi += c;
    if (Number.isFinite(p) && p > 0) sumPutOi += p;
    const cc = Number(r.callChgOi);
    const pc = Number(r.putChgOi);
    if (Number.isFinite(cc)) {
      sumCallChgOi += cc;
      hasNearCallChg = true;
    }
    if (Number.isFinite(pc)) {
      sumPutChgOi += pc;
      hasNearPutChg = true;
    }
    if (atm != null && Number.isFinite(r.strike) && Math.abs(r.strike - atm) <= nearBand) {
      if (Number.isFinite(c) && c > 0) nearCallOi += c;
      if (Number.isFinite(p) && p > 0) nearPutOi += p;
    }
  }
  // PCR_OI = Total Put OI ÷ Total Call OI
  const allPcr = allCallOi > 0 ? allPutOi / allCallOi : null;
  const pcr = sumCallOi > 0 ? sumPutOi / sumCallOi : null;
  const nearPcr = nearCallOi > 0 ? nearPutOi / nearCallOi : null;

  return {
    spot: Number.isFinite(spot) ? spot : null,
    chainSpot: Number.isFinite(Number(chain.last_price)) ? Number(chain.last_price) : null,
    atm,
    strikeStep,
    expiry,
    fetchedAt: new Date().toISOString(),
    strikes: near,
    allStrikeCount: rows.length,
    lookaroundStrikes,
    totals: {
      callOi: sumCallOi,
      putOi: sumPutOi,
      callChgOi: hasNearCallChg ? sumCallChgOi : null,
      putChgOi: hasNearPutChg ? sumPutChgOi : null,
      pcr: Number.isFinite(pcr) ? Number(pcr.toFixed(3)) : null,
      nearPcr: Number.isFinite(nearPcr) ? Number(nearPcr.toFixed(3)) : null,
      allCallOi,
      allPutOi,
      allPcr: Number.isFinite(allPcr) ? Number(allPcr.toFixed(3)) : null,
      allCallChgOi: hasCallChg ? allCallChgOi : null,
      allPutChgOi: hasPutChg ? allPutChgOi : null,
    },
  };
}

function parseMarginFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const directCandidates = [
    payload.totalMargin,
    payload.marginRequired,
    payload.margin,
    payload.requiredMargin,
    payload.blockedMargin,
  ]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (directCandidates.length > 0) return Math.max(...directCandidates);

  const nestedKeys = ['data', 'result', 'summary'];
  for (const key of nestedKeys) {
    const nested = payload[key];
    if (nested && typeof nested === 'object') {
      const n = parseMarginFromPayload(nested);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  const listKeys = ['scripList', 'scripts', 'orders', 'orderMargins', 'items'];
  for (const key of listKeys) {
    const arr = payload[key];
    if (!Array.isArray(arr)) continue;
    const sum = arr.reduce((acc, row) => {
      const n = parseMarginFromPayload(row);
      return acc + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
    if (sum > 0) return sum;
  }
  return null;
}

async function postWithAuthRetry(path, body, authContext) {
  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) throw new Error('Missing Dhan credentials');
  const headers = {
    'access-token': accessToken,
    'client-id': clientId,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  try {
    return await axios.post(`${DHAN_BASE}${path}`, body, { headers, timeout: 20000 });
  } catch (error) {
    if (isLikelyDhanAuthError(error)) {
      const renewed = await ensureValidDhanAccessToken(authContext);
      return axios.post(`${DHAN_BASE}${path}`, body, {
        headers: { ...headers, 'access-token': renewed },
        timeout: 20000,
      });
    }
    throw error;
  }
}

/**
 * Calculate short straddle margin from Dhan margin calculator API (multi-leg / straddle).
 * Uses MARGIN (NRML) by default for overnight holds; pass INTRADAY for same-day strategies.
 * @returns {{ margin: number, source: 'dhan_multi' }}
 */
async function estimateShortStraddleMargin({
  symbol,
  expiry,
  strike,
  lotSize,
  lots = 1,
  cePrice,
  pePrice,
  productType = 'MARGIN',
}) {
  const resolved = resolveSymbolConfig(symbol);
  const clientId = getDhanClientId();
  if (!clientId) throw new Error('Missing dhanClientId');
  const qty = Math.max(1, Number(lotSize) || 1) * Math.max(1, Number(lots) || 1);
  const ceInstrument = await resolveOptionInstrument({
    symbol,
    strike,
    expiry,
    optionType: 'CE',
  });
  const peInstrument = await resolveOptionInstrument({
    symbol,
    strike,
    expiry,
    optionType: 'PE',
  });
  const segment = ceInstrument.exchangeSegment || resolved.exchangeSegment || 'NSE_FNO';
  const safeProductType = String(productType || 'MARGIN').toUpperCase() === 'INTRADAY' ? 'INTRADAY' : 'MARGIN';
  const mkOrder = (securityId, price) => ({
    exchangeSegment: segment,
    transactionType: 'SELL',
    quantity: qty,
    productType: safeProductType,
    securityId: String(securityId),
    price: Number.isFinite(Number(price)) ? Number(price) : 0,
    triggerPrice: 0,
  });

  const multiBody = {
    includePosition: false,
    includeOrder: false,
    dhanClientId: clientId,
    scripList: [
      mkOrder(ceInstrument.securityId, cePrice),
      mkOrder(peInstrument.securityId, pePrice),
    ],
  };

  const resp = await postWithAuthRetry('/margincalculator/multi', multiBody, 'margin-calc-multi');
  const margin = parseMarginFromPayload(resp.data);
  if (Number.isFinite(margin) && margin > 0) {
    return { margin: Number(margin.toFixed(2)), source: 'dhan_multi' };
  }
  throw new Error('Margin calculator multi response missing margin values');
}

// ----------------- WebSocket (Live Index Ticker) -----------------

const wsState = {
  ws: null,
  subscribers: new Map(),
  lastPrices: new Map(),
  connecting: false,
  reconnectAttempts: 0,
  intentionalClose: false,
  reconnectTimer: null,
  rateLimitedUntil: 0,
  lastErrorWasRateLimit: false,
};

function packInstrumentSubscription({ securityId, exchangeSegmentCode }) {
  // RequestCode 15 = Ticker packet; Message format per Dhan WS v2:
  // 1 byte feedRequestCode + 1 byte instrumentCount(=1) + 1 byte exchange + 20 bytes securityId
  const buf = Buffer.alloc(23);
  buf.writeUInt8(15, 0);
  buf.writeUInt8(1, 1);
  buf.writeUInt8(exchangeSegmentCode, 2);
  buf.write(String(securityId), 3, 20, 'utf8');
  return buf;
}

function exchangeSegmentToCode(seg) {
  // Per Dhan Marketfeed protocol:
  switch (String(seg || '').toUpperCase()) {
    case 'IDX_I':
      return 0;
    case 'NSE_EQ':
      return 1;
    case 'NSE_FNO':
      return 2;
    case 'NSE_CURRENCY':
      return 3;
    case 'BSE_EQ':
      return 4;
    case 'MCX_COMM':
      return 5;
    case 'BSE_CURRENCY':
      return 7;
    case 'BSE_FNO':
      return 8;
    default:
      return 0;
  }
}

function normalizeExchangeSegment(row) {
  const exch = String(pickField(row, ['EXCH_ID', 'EXCHANGE']) || '').toUpperCase();
  const segment = String(pickField(row, ['SEGMENT', 'EXCHANGE_SEGMENT']) || '').toUpperCase();
  if (exch === 'NSE' && segment === 'D') return 'NSE_FNO';
  if (exch === 'BSE' && segment === 'D') return 'BSE_FNO';
  if (exch === 'NSE' && segment === 'E') return 'NSE_EQ';
  if (exch === 'BSE' && segment === 'E') return 'BSE_EQ';
  return segment || exch;
}

function futureInstrumentTypeForUnderlying(underlying) {
  const upper = String(underlying || '').toUpperCase();
  if (upper === 'NIFTY' || upper === 'BANKNIFTY' || upper === 'SENSEX' || upper === 'FINNIFTY' || upper === 'MIDCPNIFTY') {
    return 'FUTIDX';
  }
  return 'FUTSTK';
}

/** SENSEX futures/options live on BSE; other indexes on NSE. */
function futureExchangeAllowed(underlying, exch) {
  const upper = String(underlying || '').toUpperCase();
  const seg = String(exch || '').toUpperCase();
  if (upper === 'SENSEX') return seg === 'BSE_FNO';
  return seg === 'NSE_FNO';
}

function pickSecurityIdFromRow(row) {
  const raw = String(pickField(row, ['SEM_SMST_SECURITY_ID', 'SECURITY_ID']) || '').trim();
  return /^\d+$/.test(raw) ? raw : null;
}

/** Match futures row to underlying (UNDERLYING_SYMBOL only — not contract trading symbol). */
function futureRowMatchesUnderlying(row, upper, futInstrument) {
  const instr = String(pickField(row, ['INSTRUMENT', 'INSTRUMENT_TYPE', 'SEM_INSTRUMENT_NAME']) || '').toUpperCase();
  if (instr !== futInstrument) return false;
  const ul = String(pickField(row, ['UNDERLYING_SYMBOL', 'UNDERLYING']) || '').toUpperCase().trim();
  return ul === upper;
}

/** List NSE futures expiry dates (YYYY-MM-DD) for an underlying, nearest first. */
async function listFutureExpiries(underlying, { includePastDays = 0 } = {}) {
  const upper = String(underlying || '').toUpperCase();
  const futInstrument = futureInstrumentTypeForUnderlying(upper);
  const rows = await loadInstrumentMaster();
  const today = new Date().toISOString().slice(0, 10);
  const minDate = includePastDays > 0
    ? formatDateOnly(addDays(parseDateOnly(today), -includePastDays))
    : today;
  const byExpiry = new Map();

  for (const r of rows) {
    if (!futureRowMatchesUnderlying(r, upper, futInstrument)) continue;
    const exch = normalizeExchangeSegment(r);
    if (!futureExchangeAllowed(upper, exch)) continue;
    const exp = String(pickField(r, ['SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE', 'EXPIRY_DATE']) || '').slice(0, 10);
    if (!exp || exp < minDate) continue;
    const securityId = pickSecurityIdFromRow(r);
    if (!securityId) continue;
    const tradingSymbol = pickField(r, ['SYMBOL_NAME', 'DISPLAY_NAME', 'SEM_TRADING_SYMBOL']) || '';
    const existing = byExpiry.get(exp);
    if (!existing || String(tradingSymbol).length > String(existing.tradingSymbol).length) {
      byExpiry.set(exp, { expiry: exp, securityId, tradingSymbol, exchangeSegment: exch });
    }
  }

  return [...byExpiry.values()].sort((a, b) => a.expiry.localeCompare(b.expiry));
}

async function resolveFutureInstrument({ symbol, expiry }) {
  const upper = String(symbol || '').toUpperCase();
  const normalizedExpiry = String(expiry || '').slice(0, 10);
  if (!upper || !normalizedExpiry) {
    throw new Error('Symbol and futures expiry are required');
  }
  const futInstrument = futureInstrumentTypeForUnderlying(upper);
  const rows = await loadInstrumentMaster();
  const match = rows.find((r) => {
    if (!futureRowMatchesUnderlying(r, upper, futInstrument)) return false;
    const exch = normalizeExchangeSegment(r);
    if (!futureExchangeAllowed(upper, exch)) return false;
    const rowExpiry = String(pickField(r, ['SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE', 'EXPIRY_DATE']) || '').slice(0, 10);
    return rowExpiry === normalizedExpiry;
  });
  if (!match) {
    throw new Error(`Futures contract not found: ${upper} expiry ${normalizedExpiry}`);
  }
  const securityId = pickSecurityIdFromRow(match);
  if (!securityId) {
    throw new Error(`Invalid security id for ${upper} future ${normalizedExpiry}`);
  }
  const exchangeSegment = normalizeExchangeSegment(match)
    || (upper === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO');
  return {
    symbol: upper,
    securityId,
    exchangeSegment,
    instrument: futInstrument,
    expiry: normalizedExpiry,
    tradingSymbol: pickField(match, ['SYMBOL_NAME', 'DISPLAY_NAME', 'SEM_TRADING_SYMBOL']) || '',
    product: 'future',
  };
}

/** NSE/BSE sandbox test contracts in the Dhan master (e.g. 011NSETEST) — not real tradable stocks. */
function isTradableStockUnderlying(symbol) {
  const ul = String(symbol || '').toUpperCase().trim();
  if (!ul) return false;
  if (/NSETEST|BSETEST/.test(ul)) return false;
  return true;
}

function shouldPreferExpiry(current, candidate, today) {
  if (!candidate) return false;
  if (!current) return true;
  const curFuture = current >= today;
  const candFuture = candidate >= today;
  if (candFuture && !curFuture) return true;
  if (!candFuture && curFuture) return false;
  return candidate < current;
}

/** Build export rows for NSE stock F&O underlyings (symbol, lot, nearest expiry, underlying security id). */
async function buildStockUnderlyingMeta(instrumentType) {
  const wanted = String(instrumentType || '').toUpperCase();
  const rows = await loadInstrumentMaster();
  const today = new Date().toISOString().slice(0, 10);
  const bySymbol = new Map();

  for (const r of rows) {
    const instr = String(pickField(r, ['INSTRUMENT', 'INSTRUMENT_TYPE', 'SEM_INSTRUMENT_NAME']) || '').toUpperCase();
    if (instr !== wanted) continue;
    if (normalizeExchangeSegment(r) !== 'NSE_FNO') continue;
    const symbol = String(pickField(r, ['UNDERLYING_SYMBOL', 'UNDERLYING']) || '').toUpperCase().trim();
    if (!isTradableStockUnderlying(symbol)) continue;

    const expiry = String(pickField(r, ['SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE', 'EXPIRY_DATE']) || '').slice(0, 10);
    const lotSizeRaw = Number(pickField(r, ['LOT_SIZE', 'SEM_LOT_UNITS', 'LotSize']));
    const underlyingSecurityId = String(pickField(r, ['UNDERLYING_SECURITY_ID', 'UNDERLYING_SECURITY']) || '').trim();

    let entry = bySymbol.get(symbol);
    if (!entry) {
      entry = {
        symbol,
        underlyingSecurityId: underlyingSecurityId || null,
        lotSize: null,
        nearestExpiry: null,
      };
      bySymbol.set(symbol, entry);
    }

    if (underlyingSecurityId && !entry.underlyingSecurityId) {
      entry.underlyingSecurityId = underlyingSecurityId;
    }

    if (shouldPreferExpiry(entry.nearestExpiry, expiry, today)) {
      entry.nearestExpiry = expiry;
      if (Number.isFinite(lotSizeRaw) && lotSizeRaw > 0) {
        entry.lotSize = Math.floor(lotSizeRaw);
      }
    } else if (!entry.lotSize && Number.isFinite(lotSizeRaw) && lotSizeRaw > 0) {
      entry.lotSize = Math.floor(lotSizeRaw);
    }
  }

  return [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Batch-fetch NSE equity LTP for underlying security ids (spot / current price). */
async function fetchEquityLtpsBatch(securityIds) {
  const prices = new Map();
  const unique = [...new Set(
    (securityIds || []).map((id) => String(id)).filter((id) => /^\d+$/.test(id)),
  )];
  const chunkSize = 50;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    try {
      const data = await fetchMarketLtp({ NSE_EQ: chunk.map((id) => Number(id)) });
      const seg = data?.NSE_EQ || {};
      for (const id of chunk) {
        const node = seg[id] || seg[Number(id)] || {};
        const ltp = Number(node.last_price ?? node.ltp ?? node.LTP);
        if (Number.isFinite(ltp) && ltp > 0) {
          prices.set(String(id), Number(ltp.toFixed(2)));
        }
      }
    } catch {
      // keep partial prices when a batch fails
    }
    if (i + chunkSize < unique.length) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  return prices;
}

/** Export-ready rows: sr no, symbol, current price, lot size, nearest expiry. */
async function getStockUnderlyingExportRows(instrumentType) {
  const meta = await buildStockUnderlyingMeta(instrumentType);
  let ltpBySecurityId = new Map();
  try {
    ltpBySecurityId = await fetchEquityLtpsBatch(meta.map((row) => row.underlyingSecurityId));
  } catch {
    // CSV still useful without live prices
  }

  return meta.map((row, index) => ({
    srNo: index + 1,
    symbol: row.symbol,
    currentPrice: ltpBySecurityId.get(String(row.underlyingSecurityId)) ?? '',
    lotSize: row.lotSize ?? '',
    nearestExpiry: row.nearestExpiry ?? '',
  }));
}

/** Distinct NSE F&O stock underlyings for a given instrument type (OPTSTK / FUTSTK), sorted A→Z. */
async function listStockUnderlyings(instrumentType) {
  const meta = await buildStockUnderlyingMeta(instrumentType);
  return meta.map((row) => row.symbol);
}

/** Distinct list of NSE stock-future (FUTSTK) underlyings, sorted A→Z. */
async function listFutureUnderlyings() {
  return listStockUnderlyings('FUTSTK');
}

/** Distinct list of NSE stock-option (OPTSTK) underlyings, sorted A→Z. */
async function listOptionStockUnderlyings() {
  return listStockUnderlyings('OPTSTK');
}

/** POST /marketfeed/ltp — returns { SEGMENT: { securityId: { last_price } } }. */
async function fetchMarketLtp(segmentToIds) {
  const body = {};
  for (const [seg, ids] of Object.entries(segmentToIds || {})) {
    const nums = (ids || []).map((v) => Number(v)).filter((n) => Number.isFinite(n));
    if (nums.length) body[seg] = nums;
  }
  if (!Object.keys(body).length) return {};
  const resp = await postWithAuthRetry('/marketfeed/ltp', body, 'marketfeed-ltp');
  return resp.data?.data || resp.data || {};
}

/** Short-lived futures LTP memory (avoids 4s WS waits on every chain open). */
const futLtpMemCache = new Map();
const FUT_LTP_MEM_TTL_MS = 20_000;

function futLtpCacheKey(inst) {
  return `${inst.exchangeSegment || 'NSE_FNO'}:${String(inst.securityId)}`;
}

function readFutLtpMem(inst) {
  const hit = futLtpMemCache.get(futLtpCacheKey(inst));
  if (!hit) return null;
  if (Date.now() - hit.at > FUT_LTP_MEM_TTL_MS) {
    futLtpMemCache.delete(futLtpCacheKey(inst));
    return null;
  }
  return Number.isFinite(hit.ltp) && hit.ltp > 0 ? hit.ltp : null;
}

function writeFutLtpMem(inst, ltp) {
  const n = Number(ltp);
  if (!Number.isFinite(n) || n <= 0) return;
  futLtpMemCache.set(futLtpCacheKey(inst), { ltp: n, at: Date.now() });
}

/**
 * Resolve last price for a resolved future/instrument via REST, falling back to WS ticker.
 * `maxWaitMs` caps how long we block on WS (default 2s — was ~4s). UI chain paths pass a lower cap.
 * `forceFresh` skips mem/WS warm caches and hits marketfeed REST first (fills / manual exits).
 */
async function fetchInstrumentLtp(inst, { maxWaitMs = 2000, forceFresh = false } = {}) {
  const segment = inst.exchangeSegment || 'NSE_FNO';
  const securityId = String(inst.securityId);
  const key = `fut:${segment}:${securityId}`;

  if (!forceFresh) {
    const mem = readFutLtpMem(inst);
    if (mem != null) return mem;

    const warm = Number(getLastPrice(key)?.ltp);
    if (Number.isFinite(warm) && warm > 0) {
      writeFutLtpMem(inst, warm);
      return warm;
    }
  }

  try {
    const data = await fetchMarketLtp({ [segment]: [securityId] });
    const seg = data?.[segment] || {};
    const node = seg[securityId] || seg[Number(securityId)] || {};
    const ltp = Number(node.last_price ?? node.ltp ?? node.LTP);
    if (Number.isFinite(ltp) && ltp > 0) {
      writeFutLtpMem(inst, ltp);
      return ltp;
    }
  } catch {
    // fall back to WS ticker below
  }

  // Even on forceFresh, allow a short WS wait if REST is empty.
  subscribeLiveInstrument({ key, securityId, exchangeSegment: segment, onTick: () => {} });
  const waitMs = Math.max(0, Number(maxWaitMs) || 0);
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const last = Number(getLastPrice(key)?.ltp);
    if (Number.isFinite(last) && last > 0) {
      writeFutLtpMem(inst, last);
      return last;
    }
    if (Date.now() >= deadline) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Future LTP unavailable (no REST or WS data yet)');
}

/** Live last price for a stock/index future by underlying + (optional) expiry. */
async function getFutureLtp({ symbol, expiry, maxWaitMs, forceFresh = false } = {}) {
  const inst = await resolveFutureInstrument({ symbol, expiry });
  const ltp = await fetchInstrumentLtp(inst, {
    ...(maxWaitMs != null ? { maxWaitMs } : {}),
    forceFresh: Boolean(forceFresh),
  });
  return { ltp, instrument: inst };
}

/**
 * Cash/index LTP (NIFTY IDX_I id 13, not the future).
 * BB Bounce SL/BB must use this series — futures basis is 50–150 pts away.
 */
async function getIndexLtp({ symbol = 'NIFTY', maxWaitMs = 800, forceFresh = false } = {}) {
  const cfg = resolveSymbolConfig(symbol);
  if (!cfg?.securityId) throw new Error(`No cash/index mapping for ${symbol}`);
  const inst = {
    securityId: String(cfg.securityId),
    exchangeSegment: cfg.exchangeSegment || 'IDX_I',
  };
  const ltp = await fetchInstrumentLtp(inst, {
    ...(maxWaitMs != null ? { maxWaitMs } : {}),
    forceFresh: Boolean(forceFresh),
  });
  return { ltp, instrument: inst, source: 'index' };
}

/**
 * Quote for the futures order ticket: nearest tradable expiry, LTP, lot size and
 * the full expiry list so the UI can let the user roll to the next month.
 * Always returns expiries even when live LTP is cold (market closed / feed down).
 */
async function getFutureQuote({ symbol, expiry, maxWaitMs = 1200 } = {}) {
  const upper = String(symbol || '').toUpperCase();
  const expiries = await listFutureExpiries(upper);
  if (!expiries.length) throw new Error(`No futures contracts found for ${upper}`);
  const wanted = expiry ? String(expiry).slice(0, 10) : null;
  const inst = (wanted && expiries.find((e) => e.expiry === wanted)) || expiries[0];
  let ltp = null;
  let ltpError = null;
  const waitCap = Math.max(0, Number(maxWaitMs) || 0);
  try {
    ltp = await Promise.race([
      fetchInstrumentLtp(inst, { maxWaitMs: waitCap }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Future LTP timeout')), waitCap + 800);
      }),
    ]);
  } catch (err) {
    ltpError = err?.message || 'Future LTP unavailable';
  }
  let lotSize = 1;
  try {
    lotSize = await getCurrentLotSize(upper);
  } catch {
    lotSize = 1;
  }
  return {
    symbol: upper,
    expiry: inst.expiry,
    expiries: expiries.map((e) => e.expiry),
    ltp,
    ltpError,
    lotSize,
    securityId: inst.securityId,
    exchangeSegment: inst.exchangeSegment,
    tradingSymbol: inst.tradingSymbol,
  };
}

async function resolveOptionInstrument({ symbol, strike, expiry, optionType }) {
  const upperSymbol = String(symbol || '').toUpperCase();
  const normalizedExpiry = String(expiry || '').slice(0, 10);
  const normalizedType = String(optionType || '').toUpperCase();
  const targetStrike = Number(strike);
  if (!upperSymbol || !normalizedExpiry || !Number.isFinite(targetStrike) || !normalizedType) {
    throw new Error('Missing option instrument inputs');
  }

  const rows = await loadInstrumentMaster();
  const match = rows.find((r) => {
    const instrument = String(pickField(r, ['INSTRUMENT', 'INSTRUMENT_TYPE']) || '').toUpperCase();
    const underlying = String(pickField(r, ['UNDERLYING_SYMBOL', 'SYMBOL_NAME']) || '').toUpperCase();
    const rowExpiry = String(pickField(r, ['SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE', 'EXPIRY_DATE']) || '').slice(0, 10);
    const rowStrike = Number(pickField(r, ['STRIKE_PRICE', 'STRIKE']));
    const rowType = String(pickField(r, ['OPTION_TYPE', 'OPT_TYPE']) || '').toUpperCase();
    return (instrument === 'OPTIDX' || instrument === 'OPTSTK')
      && underlying === upperSymbol
      && rowExpiry === normalizedExpiry
      && Math.abs(rowStrike - targetStrike) < 0.5
      && rowType === normalizedType;
  });
  if (!match) {
    throw new Error(`Option instrument not found: ${upperSymbol} ${normalizedExpiry} ${targetStrike} ${normalizedType}`);
  }

  return {
    securityId: String(pickField(match, ['SECURITY_ID', 'SEM_SMST_SECURITY_ID'])),
    exchangeSegment: normalizeExchangeSegment(match),
    tradingSymbol: pickField(match, ['SYMBOL_NAME', 'DISPLAY_NAME']) || '',
  };
}

/**
 * Distinct OPTIDX expiry dates (YYYY-MM-DD) for an underlying from the instrument master,
 * sorted ascending. Note: the master only lists CURRENTLY-ACTIVE contracts, so already-expired
 * weeklies are absent — the backtest uses this to detect which days have resolvable real premiums.
 */
async function listOptionExpiriesFromMaster(symbol) {
  const upper = String(symbol || '').toUpperCase();
  const rows = await loadInstrumentMaster();
  const set = new Set();
  for (const r of rows) {
    const instrument = String(pickField(r, ['INSTRUMENT', 'INSTRUMENT_TYPE']) || '').toUpperCase();
    if (instrument !== 'OPTIDX') continue;
    const underlying = String(pickField(r, ['UNDERLYING_SYMBOL']) || '').toUpperCase().trim();
    if (underlying !== upper) continue;
    const exp = String(pickField(r, ['SM_EXPIRY_DATE', 'SEM_EXPIRY_DATE', 'EXPIRY_DATE']) || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(exp)) set.add(exp);
  }
  return [...set].sort();
}

function decodeTickerPacket(buffer) {
  // Header (8 bytes) + Ticker payload: LTP (4 byte float) + LTT (4 byte int)
  if (buffer.length < 16) return null;
  const responseCode = buffer.readUInt8(0);
  if (responseCode !== 2) return null;
  const exchangeSegmentCode = buffer.readUInt8(3);
  const securityId = String(buffer.readInt32LE(4));
  const ltp = buffer.readFloatLE(8);
  const ltt = buffer.readInt32LE(12);
  return { ltp, ltt, responseCode, exchangeSegmentCode, securityId };
}

function ensureWsConnection() {
  const now = Date.now();
  if (wsState.rateLimitedUntil && now < wsState.rateLimitedUntil) {
    return null;
  }
  if (wsState.ws && (wsState.ws.readyState === WebSocket.OPEN || wsState.ws.readyState === WebSocket.CONNECTING)) {
    return wsState.ws;
  }
  if (wsState.connecting) return null;

  const clientId = getDhanClientId();
  const accessToken = readLatestAccessToken();
  if (!clientId || !accessToken) {
    console.warn('[DhanLive] WS skipped — missing credentials');
    return null;
  }

  wsState.connecting = true;
  wsState.intentionalClose = false;
  const url = `${DHAN_WS_URL}?version=2&token=${accessToken}&clientId=${clientId}&authType=2`;
  const ws = new WebSocket(url);
  wsState.ws = ws;

  ws.on('open', () => {
    console.log('[DhanLive] WS connected');
    wsState.connecting = false;
    wsState.reconnectAttempts = 0;
    wsState.rateLimitedUntil = 0;
    wsState.lastErrorWasRateLimit = false;
    for (const sub of wsState.subscribers.values()) {
      try {
        ws.send(packInstrumentSubscription(sub));
      } catch (err) {
        console.error('[DhanLive] WS resub failed:', err.message);
      }
    }
  });

  ws.on('message', (data) => {
    if (!(data instanceof Buffer)) return;
    const decoded = decodeTickerPacket(data);
    if (!decoded || !Number.isFinite(decoded.ltp) || decoded.ltp <= 0) return;
    for (const [key, sub] of wsState.subscribers.entries()) {
      if (
        String(sub.securityId) !== decoded.securityId
        || Number(sub.exchangeSegmentCode) !== Number(decoded.exchangeSegmentCode)
      ) {
        continue;
      }
      wsState.lastPrices.set(key, { ltp: decoded.ltp, ts: Date.now() });
      if (typeof sub.onTick === 'function') {
        try {
          sub.onTick({ ltp: decoded.ltp, ltt: decoded.ltt });
        } catch (err) {
          console.error('[DhanLive] tick handler error:', err.message);
        }
      }
    }
  });

  ws.on('error', (err) => {
    const message = String(err?.message || err);
    wsState.lastErrorWasRateLimit = message.includes('429');
    if (wsState.lastErrorWasRateLimit) {
      wsState.rateLimitedUntil = Date.now() + 2 * 60 * 1000;
      console.error('[DhanLive] WS rate-limited (429). Cooling down reconnects for 2 minutes.');
      return;
    }
    console.error('[DhanLive] WS error:', message);
  });

  ws.on('close', (code) => {
    console.log('[DhanLive] WS closed', code);
    wsState.ws = null;
    wsState.connecting = false;
    if (wsState.intentionalClose) return;
    if (wsState.subscribers.size === 0) return;
    wsState.reconnectAttempts = Math.min(10, wsState.reconnectAttempts + 1);
    const rateLimitBackoff = Math.max(0, wsState.rateLimitedUntil - Date.now());
    const normalBackoff = Math.min(120000, 1000 * 2 ** wsState.reconnectAttempts);
    const backoff = wsState.lastErrorWasRateLimit ? Math.max(rateLimitBackoff, 120000) : normalBackoff;
    if (wsState.reconnectTimer) clearTimeout(wsState.reconnectTimer);
    wsState.reconnectTimer = setTimeout(() => {
      wsState.reconnectTimer = null;
      ensureWsConnection();
    }, backoff);
  });

  return ws;
}

function subscribeLiveSymbol({ key, symbol, onTick }) {
  const resolved = resolveSymbolConfig(symbol);
  if (!resolved.securityId || !resolved.exchangeSegment) {
    throw new Error('Unsupported symbol for live subscription');
  }
  wsState.subscribers.set(key, {
    securityId: resolved.securityId,
    exchangeSegmentCode: exchangeSegmentToCode(resolved.exchangeSegment),
    onTick,
  });
  if (wsState.rateLimitedUntil && Date.now() < wsState.rateLimitedUntil) {
    return;
  }
  const ws = ensureWsConnection();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(packInstrumentSubscription({
        securityId: resolved.securityId,
        exchangeSegmentCode: exchangeSegmentToCode(resolved.exchangeSegment),
      }));
    } catch (err) {
      console.error('[DhanLive] WS sub failed:', err.message);
    }
  }
}

function subscribeLiveInstrument({ key, securityId, exchangeSegment, onTick }) {
  const exchangeSegmentCode = exchangeSegmentToCode(exchangeSegment);
  wsState.subscribers.set(key, {
    securityId: String(securityId),
    exchangeSegmentCode,
    onTick,
  });
  if (wsState.rateLimitedUntil && Date.now() < wsState.rateLimitedUntil) {
    return;
  }
  const ws = ensureWsConnection();
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(packInstrumentSubscription({
        securityId: String(securityId),
        exchangeSegmentCode,
      }));
    } catch (err) {
      console.error('[DhanLive] WS sub failed:', err.message);
    }
  }
}

function unsubscribeLiveSymbol(key) {
  wsState.subscribers.delete(key);
  wsState.lastPrices.delete(key);
  if (wsState.subscribers.size === 0 && wsState.ws) {
    wsState.intentionalClose = true;
    try {
      wsState.ws.close();
    } catch {
      // ignore
    }
    wsState.ws = null;
  }
}

function getLastPrice(key) {
  return wsState.lastPrices.get(key) || null;
}

module.exports = {
  loadInstrumentMaster,
  getCurrentLotSize,
  fetchExpiryList,
  fetchOptionChain,
  fetchOptionChainCached,
  getNearestWeeklyExpiry,
  getNextWeeklyExpiry,
  getTradableWeeklyExpiry,
  getNearExpiryCutoffDateKey,
  isExpiryTooSoonForNewEntry,
  getAtmPremiums,
  getOptionChainOiSnapshot,
  pickSecurityIdFromRow,
  listFutureExpiries,
  listFutureUnderlyings,
  listOptionStockUnderlyings,
  buildStockUnderlyingMeta,
  isTradableStockUnderlying,
  getStockUnderlyingExportRows,
  resolveFutureInstrument,
  futureInstrumentTypeForUnderlying,
  fetchMarketLtp,
  fetchInstrumentLtp,
  getFutureLtp,
  getIndexLtp,
  getFutureQuote,
  resolveOptionInstrument,
  listOptionExpiriesFromMaster,
  estimateShortStraddleMargin,
  subscribeLiveInstrument,
  subscribeLiveSymbol,
  unsubscribeLiveSymbol,
  getLastPrice,
  resolveOptionChainUnderlying,
  getOptionChainRateLimitStatus,
};
