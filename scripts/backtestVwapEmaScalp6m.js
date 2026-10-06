/**
 * 6-month version of backtestVwapEmaScalp — same rules, different data (expired futures are not
 * in the Dhan instrument master):
 * - Price: NIFTY index 1-min OHLC (Dhan intraday, via getCandlesWithCache).
 * - VWAP volume: ATM CE + PE 1-min volume of the nearest weekly (Dhan /charts/rollingoption).
 * - Option OI flow: ATM ± 3 call/put OI from rollingoption (shared openOiWalls cache), ΔOI on
 *   overlapping strikes per minute, running sum of (Put ΔOI − Call ΔOI).
 *
 * Usage: node scripts/backtestVwapEmaScalp6m.js [--from 2026-04-06] [--to 2026-10-05] [--slip 0.5]
 *        [--detail "5:optFlow:10:5"]   tf:oi:tgt:sl for the monthly breakdown
 *        [--grid2 [--split 2026-07-01]]  stop < target grid with breakeven / morning window
 *        [--one "5:none:30:10:09:30:11:30"]  single rule, full trade list to output JSON
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios/dist/node/axios.cjs');
const mongoose = require('mongoose');
const { readLatestAccessToken, ensureValidDhanAccessToken } = require('../src/services/tokenService');
const { getDhanClientId } = require('../src/services/dhanTokenStore');
const { getCandlesWithCache } = require('../src/services/dhanDataService');
const {
  BASE, round2, addDays, istParts, buildTfBars, simulateDay, summarize,
} = require('./backtestVwapEmaScalp');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = arg('from', '2026-04-06');
const TO = arg('to', '2026-10-05');
const DETAIL = arg('detail', '5:optFlow:10:5');
const ROLL_CACHE = path.join(__dirname, '.cache', 'openOiWalls');
const VOL_CACHE = path.join(__dirname, '.cache', 'vwapEmaScalp');
/** 30-day window grid anchored here so the shared rollingoption cache files are reused. */
const WINDOW_ANCHOR = '2025-09-29';
const LOOK = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toMin = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

function windows(from, to) {
  const out = [];
  let start = WINDOW_ANCHOR;
  while (start <= to) {
    let end = addDays(start, 29);
    if (end > to) end = to;
    if (end >= from) out.push([start, end]);
    start = addDays(end, 1);
  }
  return out;
}

function offsetLabel(o) {
  if (o === 0) return 'ATM';
  return o > 0 ? `ATM+${o}` : `ATM${o}`;
}

async function postRolling(body) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const res = await axios.post('https://api.dhan.co/v2/charts/rollingoption', body, {
        headers: { 'access-token': readLatestAccessToken(), 'client-id': getDhanClientId(), 'Content-Type': 'application/json' },
        timeout: 60000,
      });
      return res.data?.data || {};
    } catch (err) {
      const status = err.response?.status;
      const code = err.response?.data?.errorCode;
      if (status === 401 || code === 'DH-901') { await ensureValidDhanAccessToken('vwap6m-auth-retry'); continue; }
      if (status === 429 || code === 'DH-904' || status >= 500 || !status) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(`rollingoption → ${status} ${JSON.stringify(err.response?.data)}`);
    }
  }
  throw new Error('rollingoption retries exhausted');
}

/** Rolling series for one offset/type; reads the cache file if present, else fetches and caches. */
async function rolling({ type, offset, from, to, fields, cacheDir, file }) {
  const p = path.join(cacheDir, file);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.mkdirSync(cacheDir, { recursive: true });
  const data = await postRolling({
    exchangeSegment: 'NSE_FNO', interval: '1', securityId: 13, instrument: 'OPTIDX', expiryFlag: 'WEEK',
    expiryCode: 1, strike: offsetLabel(offset), drvOptionType: type, requiredData: fields, fromDate: from, toDate: to,
  });
  const raw = (type === 'CALL' ? data.ce : data.pe) || { timestamp: [] };
  const out = { t: raw.timestamp || [], k: raw.strike || [], oi: raw.oi || [], s: raw.spot || [], v: raw.volume || [],
    o: raw.open || [], h: raw.high || [], l: raw.low || [], c: raw.close || [] };
  fs.writeFileSync(p, JSON.stringify(out));
  await sleep(250);
  return out;
}

/** day → Map(min → { flow, total }) from ATM±3 OI; day → Map(min → ATM CE+PE volume). */
async function loadOptionData(from, to) {
  const oiByMin = new Map();
  const volByMin = new Map();
  const at = (m, day) => { if (!m.has(day)) m.set(day, new Map()); return m.get(day); };
  for (const [wFrom, wTo] of windows(from, to)) {
    process.stdout.write(`  options ${wFrom} → ${wTo} `);
    for (const type of ['CALL', 'PUT']) {
      for (let offset = -LOOK; offset <= LOOK; offset += 1) {
        const s = await rolling({
          type, offset, from: wFrom, to: wTo, fields: ['open', 'high', 'low', 'close', 'oi', 'strike', 'spot'],
          cacheDir: ROLL_CACHE, file: `1_${type}_${offset}_${wFrom}_${wTo}.json`,
        });
        for (let i = 0; i < s.t.length; i += 1) {
          const { day, min } = istParts(s.t[i] * 1000);
          if (min < 555 || min > 929) continue;
          const minMap = at(oiByMin, day);
          if (!minMap.has(min)) minMap.set(min, { CALL: new Map(), PUT: new Map() });
          minMap.get(min)[type].set(Number(s.k[i]), Number(s.oi[i]));
        }
      }
      const v = await rolling({
        type, offset: 0, from: wFrom, to: wTo, fields: ['volume', 'strike'],
        cacheDir: VOL_CACHE, file: `vol_${type}_${wFrom}_${wTo}.json`,
      });
      for (let i = 0; i < v.t.length; i += 1) {
        const { day, min } = istParts(v.t[i] * 1000);
        const m = at(volByMin, day);
        m.set(min, (m.get(min) || 0) + (Number(v.v[i]) || 0));
      }
    }
    console.log('ok');
  }

  const flowByDay = new Map();
  for (const [day, minMap] of oiByMin) {
    const mins = [...minMap.keys()].sort((a, b) => a - b);
    const out = new Map();
    let flow = 0;
    let prev = null;
    for (const min of mins) {
      const cur = minMap.get(min);
      if (prev) {
        let dCall = 0;
        let dPut = 0;
        for (const [k, oi] of cur.CALL) if (prev.CALL.has(k) && Number.isFinite(oi)) dCall += oi - prev.CALL.get(k);
        for (const [k, oi] of cur.PUT) if (prev.PUT.has(k) && Number.isFinite(oi)) dPut += oi - prev.PUT.get(k);
        flow += dPut - dCall;
      }
      let total = 0;
      for (const oi of cur.CALL.values()) total += oi || 0;
      for (const oi of cur.PUT.values()) total += oi || 0;
      out.set(min, { flow, total });
      prev = cur;
    }
    flowByDay.set(day, out);
  }
  return { flowByDay, volByMin };
}

async function loadIndexBars(from, to, volByMin) {
  const bars = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) {
    const { rows } = await getCandlesWithCache({ symbol: 'NIFTY', interval: '1', year: y });
    for (const [iso, o, h, l, c] of rows) {
      const { day, min } = istParts(new Date(iso).getTime());
      if (day < from || day > to || min < 555 || min > 929) continue;
      bars.push({ day, min, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: volByMin.get(day)?.get(min) || 0, oi: null });
    }
  }
  bars.sort((a, b) => (a.day === b.day ? a.min - b.min : a.day < b.day ? -1 : 1));
  return bars;
}

function runAll(bars, flowByDay, cfg, from, to) {
  const tfBars = buildTfBars(bars, cfg.tf);
  const oneByDay = new Map();
  for (const b of bars) {
    if (!oneByDay.has(b.day)) oneByDay.set(b.day, []);
    oneByDay.get(b.day).push(b);
  }
  const tfByDay = new Map();
  for (const b of tfBars) {
    if (!tfByDay.has(b.day)) tfByDay.set(b.day, []);
    tfByDay.get(b.day).push(b);
  }
  const days = [];
  for (const day of [...oneByDay.keys()].sort()) {
    if (day < from || day > to) continue;
    if (cfg.oi === 'optFlow' && !flowByDay.has(day)) continue;
    days.push(simulateDay(day, oneByDay.get(day), tfByDay.get(day) || [], flowByDay.get(day), cfg));
  }
  return { days, summary: summarize(days, cfg) };
}

function monthly(days) {
  const by = new Map();
  for (const d of days) {
    const m = d.day.slice(0, 7);
    if (!by.has(m)) by.set(m, { month: m, sessions: 0, trades: 0, wins: 0, losses: 0, pts: 0 });
    const g = by.get(m);
    g.sessions += 1;
    for (const t of d.trades) {
      g.trades += 1;
      if (t.pts > 0) g.wins += 1; else g.losses += 1;
      g.pts = round2(g.pts + t.pts);
    }
  }
  return [...by.values()];
}

/**
 * --grid2: stop smaller than target, wider stops, breakeven, morning-only window.
 * Ranks by the worst-case fill total; split = first vs second half to catch curve-fitting.
 */
function runGrid2(bars, flowByDay) {
  const SPLIT = arg('split', '2026-07-01');
  const pairs = [[10, 5], [15, 5], [20, 5], [15, 7], [20, 7], [30, 7], [20, 10], [30, 10]];
  const windowsCfg = [['all', '09:21', '15:00'], ['morning', '09:30', '11:30']];
  const rows = [];
  for (const tf of [3, 5]) {
    for (const oi of ['none', 'optFlow']) {
      for (const [tgt, sl] of pairs) {
        for (const be of [0, sl]) {
          for (const [wName, wFrom, wTo] of windowsCfg) {
            const cfg = { ...BASE, tf, oi, tgt, sl, be, maxTrades: 1, path: 'ohlc', startMin: toMin(wFrom), lastEntryMin: toMin(wTo) };
            const r = runAll(bars, flowByDay, cfg, FROM, TO);
            const w = runAll(bars, flowByDay, { ...cfg, path: 'worst' }, FROM, TO);
            const half = (days, a, b) => round2(days.filter((d) => d.day >= a && d.day < b).reduce((s, d) => s + d.pts, 0));
            const trades = r.days.flatMap((d) => d.trades);
            rows.push({
              rule: `tf${tf} ${oi} T${tgt}/S${sl}${be ? ' BE' : ''} ${wName}`,
              trades: trades.length,
              win: r.summary.winRate,
              pts: r.summary.totalPts,
              worstPts: w.summary.totalPts,
              h1: half(r.days, FROM, SPLIT),
              h2: half(r.days, SPLIT, '9999'),
              h1Worst: half(w.days, FROM, SPLIT),
              h2Worst: half(w.days, SPLIT, '9999'),
              maxDd: r.summary.maxDdPts,
              unclear: r.summary.sameBarBoth,
              eod: r.summary.eodExits,
              rs10: Math.round(r.summary.totalPts * 650 - trades.length * 100),
              rs10Worst: Math.round(w.summary.totalPts * 650 - trades.length * 100),
            });
          }
        }
      }
    }
  }
  rows.sort((a, b) => b.worstPts - a.worstPts);
  console.log(`\nGRID2 — ${rows.length} rules, 1 trade/day, ranked by worst-case points. h1 = ${FROM}…${SPLIT}, h2 = ${SPLIT}…${TO}`);
  console.table(rows.slice(0, 25));
  const robust = rows.filter((r) => r.h1Worst > 0 && r.h2Worst > 0);
  console.log(`\nRules positive in BOTH halves even with worst-case fills: ${robust.length}`);
  if (robust.length) console.table(robust);
  const out = path.join(__dirname, 'output', `vwapEmaScalp6m_grid2_${FROM}_${TO}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`saved ${path.relative(__dirname, out)}`);
}

/** --one tf:oi:tgt:sl:HH:MM:HH:MM — single rule, monthly table + full trade list (normal and worst fills). */
function runOne(bars, flowByDay, spec) {
  const [tf, oi, tgt, sl, h1, m1, h2, m2] = spec.split(':');
  const cfg = {
    ...BASE, tf: Number(tf), oi, tgt: Number(tgt), sl: Number(sl), be: 0, maxTrades: 1, path: 'ohlc',
    startMin: toMin(`${h1}:${m1}`), lastEntryMin: toMin(`${h2}:${m2}`),
  };
  const r = runAll(bars, flowByDay, cfg, FROM, TO);
  const w = runAll(bars, flowByDay, { ...cfg, path: 'worst' }, FROM, TO);
  const worstByDay = new Map(w.days.map((d) => [d.day, d.trades[0] || null]));
  console.table([r.summary, w.summary]);
  console.table(monthly(r.days).map((m) => ({ ...m, rs10Lots: Math.round(m.pts * 650 - m.trades * 100) })));
  let streak = 0;
  let maxStreak = 0;
  for (const d of r.days) {
    for (const t of d.trades) {
      streak = t.pts > 0 ? 0 : streak + 1;
      maxStreak = Math.max(maxStreak, streak);
    }
  }
  console.log(`longest losing streak: ${maxStreak}`);
  const out = path.join(__dirname, 'output', `vwapEmaScalp6m_one_${spec.replace(/:/g, '-')}_${FROM}_${TO}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    spec, summary: r.summary, worstSummary: w.summary, maxLosingStreak: maxStreak, monthly: monthly(r.days),
    days: r.days.map((d) => ({ day: d.day, trade: d.trades[0] || null, worst: worstByDay.get(d.day) })),
  }, null, 2));
  console.log(`saved ${path.relative(__dirname, out)}`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  await ensureValidDhanAccessToken('backtest-vwap-6m');
  const warmFrom = addDays(FROM, -10);
  console.log(`loading ${FROM} → ${TO}`);
  const { flowByDay, volByMin } = await loadOptionData(warmFrom, TO);
  const bars = await loadIndexBars(warmFrom, TO, volByMin);
  const sessions = new Set(bars.filter((b) => b.day >= FROM).map((b) => b.day)).size;
  const noVol = new Set(bars.filter((b) => b.day >= FROM && !volByMin.has(b.day)).map((b) => b.day));
  console.log(`index 1-min bars ${bars.length}, sessions ${sessions}, option-OI days ${flowByDay.size}, days without volume ${noVol.size}`);

  if (process.argv.includes('--grid2')) {
    runGrid2(bars, flowByDay);
    await mongoose.disconnect();
    return;
  }
  const one = arg('one', null);
  if (one) {
    runOne(bars, flowByDay, one);
    await mongoose.disconnect();
    return;
  }

  const configs = [];
  for (const tf of [3, 5]) {
    for (const oi of ['none', 'optFlow']) {
      for (const [tgt, sl] of [[5, 5], [10, 5], [10, 999]]) configs.push({ ...BASE, tf, oi, tgt, sl, maxTrades: 1, path: 'ohlc' });
    }
  }
  const rows = [];
  const results = new Map();
  for (const cfg of configs) {
    const r = runAll(bars, flowByDay, cfg, FROM, TO);
    const w = runAll(bars, flowByDay, { ...cfg, path: 'worst' }, FROM, TO);
    results.set(`${cfg.tf}:${cfg.oi}:${cfg.tgt}:${cfg.sl}`, r);
    const s = r.summary;
    rows.push({
      cfg: s.cfg.replace(' maxTrades=1', '').replace(' ohlc', ''), days: s.days, trades: s.trades, winRate: s.winRate,
      totalPts: s.totalPts, worstPathPts: w.summary.totalPts, maxDdPts: s.maxDdPts, avgSl: s.avgSl, eod: s.eodExits,
      rs10Lots: Math.round(s.totalPts * 650 - s.trades * 100),
    });
  }
  console.log('\nSUMMARY — 1 trade/day, pts after', BASE.slip, 'slip; rs10Lots = pts × 650 − ₹100/trade');
  console.table(rows);

  const d = results.get(DETAIL);
  if (d) {
    console.log(`\nMONTHLY  ${DETAIL}`);
    console.table(monthly(d.days).map((m) => ({ ...m, rs10Lots: Math.round(m.pts * 650 - m.trades * 100) })));
    const out = path.join(__dirname, 'output', `vwapEmaScalp6m_${FROM}_${TO}_${DETAIL.replace(/:/g, '-')}.json`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ rows, monthly: monthly(d.days), days: d.days }, null, 2));
    console.log(`saved ${path.relative(__dirname, out)}`);
  }
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
