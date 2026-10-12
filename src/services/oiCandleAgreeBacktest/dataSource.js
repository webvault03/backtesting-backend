/**
 * Historical NIFTY + weekly option minute data for the backtests.
 *
 * Nothing is written to MongoDB: fetched past days are kept gzipped in this process's memory
 * (bounded, cleared on restart) so repeat runs of the same months do not refetch from Dhan.
 *
 * Per trading day:
 *   nifty: { m: [minute], o, h, l, c }
 *   CE / PE: { [strike]: { m: [minute], o, h, l, c, oi } }   ← rolling ATM±6, nearest weekly
 */
const zlib = require('zlib');
const axios = require('axios/dist/node/axios.cjs');
const { readLatestAccessToken, ensureValidDhanAccessToken } = require('../tokenService');
const { getDhanClientId } = require('../dhanTokenStore');
const { getIstClock } = require('../../utils/dateTime');

const DHAN = 'https://api.dhan.co/v2';
const OFFSETS = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];
const WINDOW_DAYS = 25;
const REQUEST_GAP_MS = 1100;
const MAX_IN_FLIGHT = 4;

/** Most days kept in memory (≈60 KB each gzipped); oldest-used days are dropped first. */
const MEMORY_MAX_DAYS = 800;
const memory = new Map();

function remember(dateKey, entry) {
  memory.delete(dateKey);
  memory.set(dateKey, entry);
  while (memory.size > MEMORY_MAX_DAYS) memory.delete(memory.keys().next().value);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function istParts(epochSec) {
  const d = new Date(Number(epochSec) * 1000 + 330 * 60000);
  return { dateKey: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

let nextSlotAt = 0;
async function waitForSlot() {
  const slot = Math.max(Date.now(), nextSlotAt);
  nextSlotAt = slot + REQUEST_GAP_MS;
  if (slot > Date.now()) await sleep(slot - Date.now());
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function dhanPost(path, body) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await waitForSlot();
    try {
      const res = await axios.post(`${DHAN}${path}`, body, {
        headers: { 'access-token': readLatestAccessToken(), 'client-id': getDhanClientId(), 'Content-Type': 'application/json' },
        timeout: 60000,
      });
      return res.data || {};
    } catch (err) {
      const status = err.response?.status;
      const code = err.response?.data?.errorCode;
      if (status === 401 || code === 'DH-901') {
        await ensureValidDhanAccessToken('oica-backtest');
        continue;
      }
      if (status === 429 || code === 'DH-904' || !status || status >= 500) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`Dhan ${path} ${status}: ${JSON.stringify(err.response?.data || err.message)}`);
    }
  }
  throw new Error(`Dhan ${path}: retries exhausted`);
}

function pack(obj) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
}

function unpack(buf) {
  return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
}

async function fetchWindow(from, to, onProgress) {
  const days = new Map();
  const dayOf = (dk) => {
    if (!days.has(dk)) days.set(dk, { nifty: { m: [], o: [], h: [], l: [], c: [] }, CE: {}, PE: {} });
    return days.get(dk);
  };

  const n = await dhanPost('/charts/intraday', {
    securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: '1', oi: false,
    fromDate: `${from} 09:00:00`, toDate: `${to} 15:30:00`,
  });
  (n.timestamp || []).forEach((t, i) => {
    const p = istParts(t);
    const d = dayOf(p.dateKey).nifty;
    d.m.push(p.minutes);
    d.o.push(n.open[i]);
    d.h.push(n.high[i]);
    d.l.push(n.low[i]);
    d.c.push(n.close[i]);
  });
  onProgress?.(1);

  const series = [];
  for (const type of ['CALL', 'PUT']) {
    for (const off of OFFSETS) series.push({ type, off });
  }
  const responses = new Map();
  await mapLimit(series, MAX_IN_FLIGHT, async ({ type, off }) => {
    const strike = off === 0 ? 'ATM' : off > 0 ? `ATM+${off}` : `ATM${off}`;
    const res = await dhanPost('/charts/rollingoption', {
      exchangeSegment: 'NSE_FNO', interval: '1', securityId: 13, instrument: 'OPTIDX', expiryFlag: 'WEEK',
      expiryCode: 1, strike, drvOptionType: type, requiredData: ['open', 'high', 'low', 'close', 'oi', 'strike'],
      fromDate: from, toDate: addDays(to, 1),
    });
    responses.set(`${type}${off}`, res);
    onProgress?.(1);
  });

  // Merge in fixed offset order so the result does not depend on response arrival order.
  for (const { type, off } of series) {
    const side = type === 'CALL' ? 'CE' : 'PE';
    const res = responses.get(`${type}${off}`);
    const s = (type === 'CALL' ? res.data?.ce : res.data?.pe) || {};
    (s.timestamp || []).forEach((t, i) => {
      const p = istParts(t);
      if (p.dateKey < from || p.dateKey > to) return;
      const book = dayOf(p.dateKey)[side];
      const k = String(s.strike[i]);
      // One strike shows up in several offset series as ATM moves — merge by minute.
      if (!book[k]) book[k] = new Map();
      if (!book[k].has(p.minutes)) {
        book[k].set(p.minutes, [s.open[i], s.high[i], s.low[i], s.close[i], s.oi[i]]);
      }
    });
  }

  for (const day of days.values()) {
    for (const side of ['CE', 'PE']) {
      for (const [k, byMin] of Object.entries(day[side])) {
        const mins = [...byMin.keys()].sort((a, b) => a - b);
        const col = (j) => mins.map((m) => byMin.get(m)[j]);
        day[side][k] = { m: mins, o: col(0), h: col(1), l: col(2), c: col(3), oi: col(4) };
      }
    }
  }
  return days;
}

/** Calls per fetch window (1 NIFTY + CE/PE × offsets). */
const CALLS_PER_WINDOW = 1 + OFFSETS.length * 2;

/**
 * Ensure every calendar date in [from, to] is in memory, fetching missing stretches from Dhan.
 * Today is fetched but never kept (session still running).
 */
async function ensureDays(from, to, { onProgress } = {}) {
  const today = getIstClock(new Date()).dateKey;
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const missing = dates.filter((d) => !memory.has(d) || d === today);

  const windows = [];
  for (const d of missing) {
    const last = windows[windows.length - 1];
    if (last && addDays(last.to, 1) === d && last.days < WINDOW_DAYS) {
      last.to = d;
      last.days += 1;
    } else {
      windows.push({ from: d, to: d, days: 1 });
    }
  }

  const totalCalls = windows.length * CALLS_PER_WINDOW;
  let doneCalls = 0;
  onProgress?.({ phase: 'fetch', done: 0, total: totalCalls });
  const live = new Map();
  for (const w of windows) {
    const days = await fetchWindow(w.from, w.to, (k) => {
      doneCalls += k;
      onProgress?.({ phase: 'fetch', done: doneCalls, total: totalCalls, window: w });
    });
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) {
      const data = days.get(d);
      const tradingDay = Boolean(data && data.nifty.m.length > 100);
      if (d === today) {
        if (tradingDay) live.set(d, data);
        continue;
      }
      remember(d, { tradingDay, payload: tradingDay ? pack(data) : null });
    }
  }
  return live;
}

/** Load in-memory trading days in [from, to] (ascending). `live` overrides for today. */
async function loadDays(from, to, live = new Map()) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const entry = memory.get(d);
    if (entry?.tradingDay) out.push({ dateKey: d, ...unpack(entry.payload) });
  }
  for (const [dateKey, data] of live) {
    if (dateKey >= from && dateKey <= to && !out.some((x) => x.dateKey === dateKey)) out.push({ dateKey, ...data });
  }
  return out.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
}

module.exports = {
  addDays,
  ensureDays,
  loadDays,
};
