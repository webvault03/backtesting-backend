/**
 * Backtest — VWAP + 9 EMA "Anchor Candle" scalp on NIFTY near-month futures.
 *
 * Data: Dhan /charts/intraday 1-min OHLC + volume + OI for NIFTY futures (near month per day),
 * optional option-chain OI from OiFlowDayArchive / OiFlowMinuteRow (ATM ± 3).
 *
 * Rules (defaults):
 * - Resample to --tf minutes (3). VWAP = session cumulative typical × volume. EMA(--ema 9) on TF closes.
 * - Long bias: close > VWAP and > EMA. Short bias: close < both.
 * - Anchor candle (closed TF bar): body ≥ --bodyMult × avg body of last 10 bars, body/range ≥ --bodyPct,
 *   in bias direction, AND (breaks prior --consol bars' high/low OR its wick touched EMA/VWAP).
 * - OI filter (--oi): fut = futures OI rose over the anchor bar; optTotal = ATM±3 call+put OI rose;
 *   optFlow = put ΔOI − call ΔOI agrees with direction; none.
 * - Entry: stop 1 tick beyond anchor high/low, valid for --valid TF bars after the anchor.
 * - Exit: target --tgt pts; SL = min(--sl pts, distance to anchor's opposite extreme); optional
 *   breakeven (--be pts); EOD flat --eod.
 * - Day stops after first target, or after --maxTrades trades.
 *
 * Usage: node scripts/backtestVwapEmaScalp.js [--from 2026-09-09] [--to 2026-10-06] [--tf 3]
 *        [--oi fut|optTotal|optFlow|none] [--maxTrades 3] [--tgt 5] [--sl 5] [--be 0] [--slip 0.5]
 *        [--start 09:21] [--lastEntry 15:00] [--sweep | --grid]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios/dist/node/axios.cjs');
const mongoose = require('mongoose');
const { readLatestAccessToken, ensureValidDhanAccessToken } = require('../src/services/tokenService');
const { getDhanClientId } = require('../src/services/dhanTokenStore');
const { listFutureExpiries } = require('../src/services/dhanLiveService');
const { calculateEma } = require('../src/strategies/shared/indicators');
const OiFlowDayArchive = require('../src/models/oiFlowDayArchive');
const OiFlowMinuteRow = require('../src/models/oiFlowMinuteRow');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function clockToMin(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}

const FROM = arg('from', '2026-09-09');
const TO = arg('to', '2026-10-06');
const BASE = {
  tf: Number(arg('tf', 3)),
  ema: Number(arg('ema', 9)),
  bodyMult: Number(arg('bodyMult', 1.5)),
  bodyPct: Number(arg('bodyPct', 0.6)),
  consol: Number(arg('consol', 5)),
  oi: arg('oi', 'fut'),
  valid: Number(arg('valid', 2)),
  tgt: Number(arg('tgt', 5)),
  sl: Number(arg('sl', 5)),
  be: Number(arg('be', 0)),
  tick: Number(arg('tick', 0.05)),
  slip: Number(arg('slip', 0.5)),
  maxTrades: Number(arg('maxTrades', 3)),
  path: arg('path', 'ohlc'),
  startMin: clockToMin(arg('start', '09:21')),
  lastEntryMin: clockToMin(arg('lastEntry', '15:00')),
  eodMin: clockToMin(arg('eod', '15:20')),
};
const QTY = Number(arg('qty', 65));
/** --grid: tf 3/5 × oi none/fut/optFlow × SL 3/4/5/anchor-only, 1 trade/day, at the given --tgt. */
const GRID = process.argv.includes('--grid');
const CACHE_DIR = path.join(__dirname, '.cache', 'vwapEmaScalp');
const OUT_DIR = path.join(__dirname, 'output');
const IST_MS = 330 * 60 * 1000;
const SESSION_OPEN = 555;

const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function istParts(epochMs) {
  const d = new Date(epochMs + IST_MS);
  return { day: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
function minLabel(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
function addDays(dayKey, n) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function postIntraday(body) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const res = await axios.post('https://api.dhan.co/v2/charts/intraday', body, {
        headers: {
          'access-token': readLatestAccessToken(),
          'client-id': getDhanClientId(),
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      });
      return res.data || {};
    } catch (err) {
      const status = err.response?.status;
      const code = err.response?.data?.errorCode;
      if (status === 401 || code === 'DH-901') {
        await ensureValidDhanAccessToken('vwap-scalp-auth-retry');
        continue;
      }
      if (status === 429 || code === 'DH-904' || status >= 500 || !status) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`intraday ${JSON.stringify(body)} → ${status} ${JSON.stringify(err.response?.data)}`);
    }
  }
  throw new Error(`intraday retries exhausted ${JSON.stringify(body)}`);
}

/** 1-min futures bars for one contract: [{ day, min, o, h, l, c, v, oi }] (cached; today refetched). */
async function loadFutBars(contract, from, to) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const today = istParts(Date.now()).day;
  const file = path.join(CACHE_DIR, `${contract.securityId}_${from}_${to}.json`);
  if (to < today && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = await postIntraday({
    securityId: String(contract.securityId),
    exchangeSegment: contract.exchangeSegment,
    instrument: 'FUTIDX',
    interval: '1',
    oi: true,
    fromDate: `${from} 09:15:00`,
    toDate: `${to} 15:30:00`,
  });
  const ts = raw.timestamp || [];
  const bars = [];
  for (let i = 0; i < ts.length; i += 1) {
    const epoch = Number(ts[i]) * (Number(ts[i]) < 1e12 ? 1000 : 1);
    const { day, min } = istParts(epoch);
    if (min < SESSION_OPEN || min > 929) continue;
    bars.push({
      day, min,
      o: Number(raw.open[i]), h: Number(raw.high[i]), l: Number(raw.low[i]), c: Number(raw.close[i]),
      v: Number(raw.volume?.[i]) || 0,
      oi: Number(raw.open_interest?.[i] ?? raw.oi?.[i]) || null,
    });
  }
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

/**
 * Option-chain OI per minute (ATM ± 3): Map(day → Map(min → { flow, total })).
 * flow = running sum of chngInDir (Put ΔOI − Call ΔOI) — present in every archive version.
 * total = callOiTotal + putOiTotal — only in v2 archives / live rows (null otherwise).
 */
async function loadOptionOi(from, to) {
  const rowsByDay = new Map();
  const arch = await OiFlowDayArchive.find({ symbol: 'NIFTY', dateKey: { $gte: from, $lte: to } }).lean();
  for (const a of arch) rowsByDay.set(a.dateKey, a.payload?.rows || []);
  const live = await OiFlowMinuteRow.find({ symbol: 'NIFTY', dateKey: { $gte: from, $lte: to }, fetchOk: true })
    .select('dateKey minutes callOiTotal putOiTotal chngInDir').lean();
  for (const r of live) {
    if (rowsByDay.has(r.dateKey) && !rowsByDay.get(r.dateKey).liveFill) continue;
    if (!rowsByDay.has(r.dateKey)) rowsByDay.set(r.dateKey, Object.assign([], { liveFill: true }));
    rowsByDay.get(r.dateKey).push(r);
  }

  const out = new Map();
  for (const [day, rows] of rowsByDay) {
    const asc = [...rows].sort((a, b) => Number(a.minutes) - Number(b.minutes));
    const m = new Map();
    let flow = 0;
    for (const r of asc) {
      const d = Number(r.chngInDir);
      if (Number.isFinite(d)) flow += d;
      const c = Number(r.callOiTotal);
      const p = Number(r.putOiTotal);
      const total = r.callOiTotal != null && r.putOiTotal != null && Number.isFinite(c + p) ? c + p : null;
      m.set(Number(r.minutes), { flow, total });
    }
    out.set(day, m);
  }
  return out;
}

/** Latest option OI snapshot at or before `min` (archive rows can skip minutes). */
function optOiAt(dayMap, min) {
  if (!dayMap) return null;
  for (let m = min; m >= min - 5; m -= 1) if (dayMap.has(m)) return dayMap.get(m);
  return null;
}

/**
 * TF bars with indicators for one continuous series (EMA carries across days, VWAP resets daily).
 * Bar label `min` = bucket start; bar is known at close = min + tf.
 */
function buildTfBars(oneMin, tf) {
  const bars = [];
  let cur = null;
  for (const b of oneMin) {
    const bucket = SESSION_OPEN + Math.floor((b.min - SESSION_OPEN) / tf) * tf;
    if (!cur || cur.day !== b.day || cur.min !== bucket) {
      if (cur) bars.push(cur);
      cur = { day: b.day, min: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, oiStart: b.oi, oi: b.oi };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      if (b.oi) cur.oi = b.oi;
    }
  }
  if (cur) bars.push(cur);

  const ema = calculateEma(bars.map((b) => b.c), BASE.ema);
  let day = null;
  let pv = 0;
  let vv = 0;
  bars.forEach((b, i) => {
    if (b.day !== day) { day = b.day; pv = 0; vv = 0; }
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * (b.v || 1);
    vv += b.v || 1;
    b.vwap = pv / vv;
    b.ema = ema[i];
    b.prevOi = i > 0 && bars[i - 1].day === b.day ? bars[i - 1].oi : b.oiStart;
  });
  return bars;
}

function oiConfirms(dir, anchor, cfg, optDay) {
  if (cfg.oi === 'none') return true;
  if (cfg.oi === 'fut') return Number.isFinite(anchor.oi) && Number.isFinite(anchor.prevOi) && anchor.oi > anchor.prevOi;
  const a = optOiAt(optDay, anchor.min - 1);
  const b = optOiAt(optDay, anchor.min + cfg.tf - 1);
  if (!a || !b) return false;
  if (cfg.oi === 'optTotal') return a.total != null && b.total != null && b.total > a.total;
  if (cfg.oi === 'optFlow') return dir === 'LONG' ? b.flow > a.flow : b.flow < a.flow;
  throw new Error(`unknown --oi ${cfg.oi}`);
}

function anchorSignal(tfDay, i, cfg) {
  const b = tfDay[i];
  if (!Number.isFinite(b.ema) || i < 10) return null;
  const body = Math.abs(b.c - b.o);
  const range = b.h - b.l;
  if (range <= 0 || body / range < cfg.bodyPct) return null;
  let avg = 0;
  for (let j = i - 10; j < i; j += 1) avg += Math.abs(tfDay[j].c - tfDay[j].o);
  avg /= 10;
  if (body < cfg.bodyMult * avg) return null;

  const prior = tfDay.slice(Math.max(0, i - cfg.consol), i);
  const priorHigh = Math.max(...prior.map((p) => p.h));
  const priorLow = Math.min(...prior.map((p) => p.l));
  if (b.c > b.o && b.c > b.vwap && b.c > b.ema) {
    const breakout = b.c > priorHigh;
    const bounce = b.l <= Math.max(b.ema, b.vwap) + 1;
    if (breakout || bounce) return { dir: 'LONG', kind: breakout ? 'breakout' : 'bounce' };
  }
  if (b.c < b.o && b.c < b.vwap && b.c < b.ema) {
    const breakdown = b.c < priorLow;
    const bounce = b.h >= Math.min(b.ema, b.vwap) - 1;
    if (breakdown || bounce) return { dir: 'SHORT', kind: breakdown ? 'breakout' : 'bounce' };
  }
  return null;
}

/**
 * Intrabar path for a 1-min bar: green O→L→H→C, red O→H→L→C. --path worst forces SL when the
 * entry bar's range covers the SL level, or any later bar touches both SL and target.
 */
function barPath(m) {
  return m.c >= m.o ? [m.o, m.l, m.h, m.c] : [m.o, m.h, m.l, m.c];
}

/**
 * Walk 1-min bars from the anchor close with a resting stop entry, then manage SL/target.
 * cfg.be > 0: once the trade is up cfg.be points, the stop moves to the entry price.
 */
function simulateTrade(oneMinDay, anchor, sig, cfg) {
  const isLong = sig.dir === 'LONG';
  const trigger = isLong ? anchor.h + cfg.tick : anchor.l - cfg.tick;
  const anchorStopDist = isLong ? trigger - (anchor.l - cfg.tick) : (anchor.h + cfg.tick) - trigger;
  const slDist = Math.min(cfg.sl, anchorStopDist);
  const fromMin = anchor.min + cfg.tf;
  const expireMin = fromMin + cfg.valid * cfg.tf;
  const up = (a, b) => (isLong ? a >= b : a <= b);

  let entry = null;
  let sameBarBoth = false;
  const finish = (m, exitPx, reason) => {
    const gross = isLong ? exitPx - entry.px : entry.px - exitPx;
    return {
      dir: sig.dir, kind: sig.kind,
      anchorTime: minLabel(anchor.min), entryTime: entry.time, entryPx: round2(entry.px),
      slDist: round2(slDist), exitTime: minLabel(m.min), exitPx: round2(exitPx), reason,
      gross: round2(gross), pts: round2(gross - cfg.slip), exitMin: m.min, sameBarBoth,
    };
  };

  for (const m of oneMinDay) {
    if (m.min < fromMin) continue;
    if (!entry && (m.min >= expireMin || m.min > cfg.lastEntryMin)) return null;
    const path = barPath(m);
    let prev = path[0];
    for (let k = 0; k < path.length; k += 1) {
      const p = path[k];
      if (!entry) {
        const crossed = k === 0 ? up(p, trigger) : up(p, trigger) && !up(prev, trigger);
        if (!crossed) { prev = p; continue; }
        const px = k === 0 ? p : trigger;
        entry = {
          time: minLabel(m.min), min: m.min, px,
          sl: isLong ? px - slDist : px + slDist,
          tgt: isLong ? px + cfg.tgt : px - cfg.tgt,
        };
        prev = px;
        if (entry.sl >= m.l && entry.sl <= m.h) {
          sameBarBoth = true;
          if (cfg.path === 'worst') return finish(m, entry.sl, 'SL');
        }
      }
      const lo = Math.min(prev, p);
      const hi = Math.max(prev, p);
      const slIn = entry.sl >= lo && entry.sl <= hi;
      const tgtIn = entry.tgt >= lo && entry.tgt <= hi;
      if (slIn || tgtIn) {
        const barLo = Math.min(m.l, entry.px);
        const barHi = Math.max(m.h, entry.px);
        sameBarBoth = sameBarBoth
          || (entry.sl >= barLo && entry.sl <= barHi && entry.tgt >= barLo && entry.tgt <= barHi);
        if (cfg.path === 'worst' && sameBarBoth) return finish(m, entry.sl, 'SL');
        const slFirst = slIn && (!tgtIn || Math.abs(entry.sl - prev) <= Math.abs(entry.tgt - prev));
        return slFirst ? finish(m, entry.sl, entry.beDone ? 'BE' : 'SL') : finish(m, entry.tgt, 'TGT');
      }
      if (cfg.be && !entry.beDone && (isLong ? p - entry.px : entry.px - p) >= cfg.be) {
        entry.sl = entry.px;
        entry.beDone = true;
      }
      prev = p;
    }
    if (entry && m.min >= cfg.eodMin) return finish(m, m.c, 'EOD');
  }
  if (entry) {
    const last = oneMinDay[oneMinDay.length - 1];
    return finish(last, last.c, 'EOD');
  }
  return null;
}

function simulateDay(day, oneMinDay, tfDay, optDay, cfg) {
  const trades = [];
  let busyUntil = -1;
  for (let i = 0; i < tfDay.length; i += 1) {
    const a = tfDay[i];
    const closeMin = a.min + cfg.tf;
    if (closeMin < cfg.startMin || closeMin > cfg.lastEntryMin || closeMin <= busyUntil) continue;
    const sig = anchorSignal(tfDay, i, cfg);
    if (!sig || !oiConfirms(sig.dir, a, cfg, optDay)) continue;
    const t = simulateTrade(oneMinDay, a, sig, cfg);
    if (!t) continue;
    trades.push(t);
    busyUntil = t.exitMin;
    if (t.reason === 'TGT' || trades.length >= cfg.maxTrades) break;
  }
  const pts = round2(trades.reduce((s, t) => s + t.pts, 0));
  return { day, trades, pts, hitTarget: trades.some((t) => t.reason === 'TGT') };
}

function summarize(days, cfg) {
  const trades = days.flatMap((d) => d.trades);
  const wins = trades.filter((t) => t.pts > 0).length;
  const totalPts = round2(trades.reduce((s, t) => s + t.pts, 0));
  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const d of days) {
    eq += d.pts;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }
  return {
    cfg: `tf${cfg.tf} oi=${cfg.oi} maxTrades=${cfg.maxTrades} tgt${cfg.tgt}/sl${cfg.sl} ${cfg.path}`,
    days: days.length,
    tradeDays: days.filter((d) => d.trades.length).length,
    daysTargetHit: days.filter((d) => d.hitTarget).length,
    greenDays: days.filter((d) => d.pts > 0).length,
    redDays: days.filter((d) => d.pts < 0).length,
    trades: trades.length,
    winRate: trades.length ? round2((wins / trades.length) * 100) : 0,
    totalPts,
    avgPtsPerDay: days.length ? round2(totalPts / days.length) : 0,
    maxDdPts: round2(maxDd),
    pnlRs: Math.round(totalPts * QTY),
    sameBarBoth: trades.filter((t) => t.sameBarBoth).length,
    eodExits: trades.filter((t) => t.reason === 'EOD').length,
    avgSl: trades.length ? round2(trades.reduce((s, t) => s + t.slDist, 0) / trades.length) : 0,
  };
}

function run(seriesByDay, optOi, cfg) {
  const days = [];
  for (const [day, { oneMin, contractBars }] of seriesByDay) {
    const tfDay = contractBars.get(cfg.tf).filter((b) => b.day === day);
    days.push(simulateDay(day, oneMin, tfDay, optOi.get(day), cfg));
  }
  return { days, summary: summarize(days, cfg) };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  await ensureValidDhanAccessToken('backtest-vwap-ema-scalp');

  const expiries = await listFutureExpiries('NIFTY', { includePastDays: 60 });
  const needed = expiries.filter((e) => e.expiry >= FROM).slice(0, 2);
  if (!needed.length) throw new Error('No NIFTY futures contracts found');
  console.log('contracts', needed.map((c) => `${c.tradingSymbol || c.securityId} exp ${c.expiry}`).join(' | '));

  // Warm-up a week before FROM so EMA is seeded on the first day.
  const warmFrom = addDays(FROM, -7);
  const tfs = GRID ? [3, 5] : process.argv.includes('--sweep') ? [2, 3, 5] : [BASE.tf];
  const contracts = [];
  for (const c of needed) {
    const bars = await loadFutBars(c, warmFrom, TO);
    if (!bars.length) { console.log(`  ${c.expiry}: no bars`); continue; }
    const contractBars = new Map(tfs.map((tf) => [tf, buildTfBars(bars, tf)]));
    contracts.push({ ...c, bars, contractBars });
    console.log(`  ${c.expiry}: ${bars.length} 1-min bars ${bars[0].day} → ${bars[bars.length - 1].day}, OI ${bars.some((b) => b.oi) ? 'yes' : 'NO'}`);
  }

  // Near-month contract per day (roll on expiry day to next month).
  const seriesByDay = new Map();
  const allDays = [...new Set(contracts.flatMap((c) => c.bars.map((b) => b.day)))].filter((d) => d >= FROM && d <= TO).sort();
  for (const day of allDays) {
    const c = contracts.find((x) => x.expiry > day && x.bars.some((b) => b.day === day))
      || contracts.find((x) => x.bars.some((b) => b.day === day));
    seriesByDay.set(day, { contract: c.expiry, oneMin: c.bars.filter((b) => b.day === day), contractBars: c.contractBars });
  }
  const optOi = await loadOptionOi(FROM, TO);
  console.log(`sessions ${allDays.length}; option-OI days ${optOi.size}`);

  const configs = [];
  if (GRID) {
    for (const tf of tfs) {
      for (const oi of ['none', 'fut', 'optFlow']) {
        for (const sl of [3, 4, 5, 999]) configs.push({ ...BASE, tf, oi, sl, maxTrades: 1 });
      }
    }
  } else if (process.argv.includes('--sweep')) {
    for (const tf of tfs) {
      for (const oi of ['none', 'fut', 'optTotal', 'optFlow']) {
        for (const maxTrades of [1, 3]) configs.push({ ...BASE, tf, oi, maxTrades });
      }
    }
  } else {
    configs.push(BASE, { ...BASE, path: 'worst' });
  }

  const results = configs.map((cfg) => {
    const r = run(seriesByDay, optOi, cfg);
    if (GRID) r.summary.worstPathPts = run(seriesByDay, optOi, { ...cfg, path: 'worst' }).summary.totalPts;
    return r;
  });
  console.log('\nSUMMARY (pts are NIFTY points per 1 unit, after slip', BASE.slip, 'pts/trade; Rs = ×', QTY, ')');
  console.table(results.map((r) => r.summary));

  const main = results.find((r) => r.summary.cfg.startsWith(`tf${BASE.tf} oi=${BASE.oi} maxTrades=${BASE.maxTrades} tgt${BASE.tgt}/sl${BASE.sl} `)) || results[0];
  console.log(`\nDAY-BY-DAY  ${main.summary.cfg}`);
  for (const d of main.days) {
    const contract = seriesByDay.get(d.day).contract;
    const desc = d.trades.map((t) => `${t.dir[0]} ${t.kind} anc${t.anchorTime} in${t.entryTime}@${t.entryPx} sl${t.slDist} → ${t.reason} ${t.exitTime} ${t.pts >= 0 ? '+' : ''}${t.pts}`).join(' | ');
    console.log(`${d.day} [fut ${contract}] ${String(d.pts).padStart(6)}  ${desc || '— no trade'}`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tag = `vwapEmaScalp_${FROM}_${TO}`;
  fs.writeFileSync(path.join(OUT_DIR, `${tag}.json`), JSON.stringify(results, null, 2));
  const header = 'cfg,day,dir,kind,anchorTime,entryTime,entryPx,slDist,exitTime,exitPx,reason,gross,pts';
  const lines = results.flatMap((r) => r.days.flatMap((d) => d.trades.map((t) => [
    r.summary.cfg, d.day, t.dir, t.kind, t.anchorTime, t.entryTime, t.entryPx, t.slDist, t.exitTime, t.exitPx, t.reason, t.gross, t.pts,
  ].join(','))));
  fs.writeFileSync(path.join(OUT_DIR, `${tag}.csv`), [header, ...lines].join('\n'));
  console.log(`\nsaved scripts/output/${tag}.{json,csv}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  BASE,
  round2,
  minLabel,
  addDays,
  istParts,
  buildTfBars,
  simulateDay,
  summarize,
};
