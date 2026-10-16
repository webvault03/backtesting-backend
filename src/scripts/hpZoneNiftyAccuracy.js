/**
 * NIFTY-only accuracy for HP Entry Zone signals (no options).
 * Usage: node src/scripts/hpZoneNiftyAccuracy.js [year] [tf]
 * Default: year=2026, tf=15
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { hydrateDhanTokenFromMongo } = require('../services/dhanTokenPersistence');
const { getCandlesWithCache } = require('../services/dhanDataService');
const { getIstClock } = require('../utils/dateTime');

const OPEN = 9 * 60 + 15;
const LAST = 15 * 60 + 29;
const EOD = 15 * 60 + 15;

const r2 = (n) => Number(Number(n).toFixed(2));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function istMinutes(iso) {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + 330 * 60000);
  return {
    dateKey: ist.toISOString().slice(0, 10),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

/** Build TF candles from year rows [iso,o,h,l,c,...]. */
function buildCandles(rows, tf) {
  const out = [];
  let cur = null;
  for (const row of rows) {
    const { dateKey, minutes: m } = istMinutes(row[0]);
    if (m < OPEN || m > LAST) continue;
    const start = OPEN + Math.floor((m - OPEN) / tf) * tf;
    if (!cur || cur.dateKey !== dateKey || cur.start !== start) {
      cur = {
        dateKey,
        start,
        end: Math.min(start + tf - 1, LAST),
        o: row[1],
        h: row[2],
        l: row[3],
        c: row[4],
      };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, row[2]);
      cur.l = Math.min(cur.l, row[3]);
      cur.c = row[4];
    }
  }
  return out;
}

function annotateSignals(candles, { leftBars = 5, rightBars = 5, bodyRatio = 0.6 } = {}) {
  let lastPh = null;
  let lastPl = null;
  let lastSignal = 0;
  return candles.map((c, i) => {
    const out = { ...c, signal: 0, lastPh, lastPl };
    const pivotAt = i - rightBars;
    if (pivotAt >= leftBars) {
      const ph = candles[pivotAt].h;
      let isHigh = true;
      let isLow = true;
      for (let j = pivotAt - leftBars; j <= pivotAt + rightBars; j += 1) {
        if (j === pivotAt) continue;
        if (candles[j].h >= ph) isHigh = false;
        if (candles[j].l <= candles[pivotAt].l) isLow = false;
      }
      if (isHigh) lastPh = ph;
      if (isLow) lastPl = candles[pivotAt].l;
    }
    out.lastPh = lastPh;
    out.lastPl = lastPl;
    if (i < 2) return out;
    const prev = candles[i - 1];
    const older = candles[i - 2];
    const prevRange = prev.h - prev.l;
    const strongPrev = prevRange > 0 && Math.abs(prev.c - prev.o) > prevRange * bodyRatio;
    const bullishFvg = c.l > older.h && prev.c > prev.o;
    const bearishFvg = c.h < older.l && prev.c < prev.o;
    const buyZone = bullishFvg && strongPrev && lastPh != null && c.c > lastPh;
    const sellZone = bearishFvg && strongPrev && lastPl != null && c.c < lastPl;
    const finalBuy = buyZone && lastSignal !== 1;
    const finalSell = sellZone && lastSignal !== -1;
    if (finalBuy) lastSignal = 1;
    if (finalSell) lastSignal = -1;
    if (finalBuy && !finalSell) out.signal = 1;
    else if (finalSell) out.signal = -1;
    return out;
  });
}

/**
 * Simulate one signal on NIFTY TF bars only (new rules).
 * Entry = signal close. Fixed rr target (TF wick touch). SL = later TF *close* only.
 * Overnight OK — no day close. Flip / maxHoldDays exits.
 */
function evaluateSignal(candles, idx, maxCandlePts, { rr = 2, maxHoldDays = 5 } = {}) {
  const sc = candles[idx];
  const buy = sc.signal > 0;
  const candlePts = r2(sc.h - sc.l);
  if (candlePts > maxCandlePts) {
    return { skipped: true, reason: `candle ${candlePts} > max ${maxCandlePts}` };
  }
  const entry = sc.c;
  const stop = buy ? sc.l : sc.h;
  const risk = buy ? entry - stop : stop - entry;
  if (risk <= 0) return { skipped: true, reason: 'zero risk' };
  const target = buy ? entry + risk * rr : entry - risk * rr;

  let mfe = 0;
  let mae = 0;
  let hit05 = false;
  let hit1 = false;
  let hit15 = false;
  let hit2 = false;
  let nextDir = null;
  let exit = null;
  let exitType = 'OPEN';
  let exitIdx = idx;
  let holdDays = 1;
  let lastDate = sc.dateKey;

  for (let j = idx + 1; j < candles.length; j += 1) {
    const c = candles[j];
    if (c.dateKey !== lastDate) {
      holdDays += 1;
      lastDate = c.dateKey;
      if (holdDays > maxHoldDays) {
        exit = c.o;
        exitType = 'TIME';
        exitIdx = j;
        break;
      }
    }

    if (j === idx + 1) {
      nextDir = buy ? c.c > entry : c.c < entry;
    }

    const fav = buy ? c.h - entry : entry - c.l;
    const adv = buy ? entry - c.l : c.h - entry;
    mfe = Math.max(mfe, fav);
    mae = Math.max(mae, adv);
    if (mfe >= risk * 0.5) hit05 = true;
    if (mfe >= risk) hit1 = true;
    if (mfe >= risk * 1.5) hit15 = true;
    if (mfe >= risk * 2) hit2 = true;

    // Fixed R target — TF wick touch (proxy for 1-min touch on TF bars)
    const tgtHit = buy ? c.h >= target : c.l <= target;
    if (tgtHit) {
      exit = target;
      exitType = 'TARGET';
      exitIdx = j;
      break;
    }

    // Close-only SL
    const slClose = buy ? c.c <= stop : c.c >= stop;
    if (slClose) {
      exit = c.c;
      exitType = 'SL';
      exitIdx = j;
      break;
    }
    // Opposite zone flip
    if (c.signal && c.signal !== sc.signal) {
      exit = c.c;
      exitType = 'FLIP';
      exitIdx = j;
      break;
    }
  }

  if (exit == null) {
    exit = candles[candles.length - 1]?.c ?? entry;
    exitType = 'OPEN';
    exitIdx = candles.length - 1;
  }

  const pts = buy ? r2(exit - entry) : r2(entry - exit);
  const rMult = r2(pts / risk);
  return {
    skipped: false,
    date: sc.dateKey,
    exitDate: candles[exitIdx]?.dateKey || sc.dateKey,
    holdDays,
    time: `${hhmm(sc.start)}–${hhmm(sc.end + 1)}`,
    side: buy ? 'BUY' : 'SELL',
    entry: r2(entry),
    stop: r2(stop),
    target: r2(target),
    risk: r2(risk),
    candlePts,
    exit: r2(exit),
    exitType,
    pts,
    rMult,
    mfe: r2(mfe),
    mae: r2(mae),
    mfeR: r2(mfe / risk),
    nextDir,
    hit05,
    hit1,
    hit15,
    hit2,
    win: pts > 0,
  };
}

function summarize(trades, year, tf, meta = {}) {
  const n = trades.length;
  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);
  const buys = trades.filter((t) => t.side === 'BUY');
  const sells = trades.filter((t) => t.side === 'SELL');
  const overnight = trades.filter((t) => t.holdDays > 1);
  const pct = (k) => (n ? r2((k / n) * 100) : 0);
  const avg = (arr, key) => (arr.length ? r2(arr.reduce((s, t) => s + t[key], 0) / arr.length) : 0);
  const byExit = {};
  for (const t of trades) byExit[t.exitType] = (byExit[t.exitType] || 0) + 1;
  const months = {};
  for (const t of trades) {
    const mk = t.date.slice(0, 7);
    if (!months[mk]) months[mk] = { month: mk, trades: 0, wins: 0, pts: 0, targets: 0 };
    months[mk].trades += 1;
    if (t.win) months[mk].wins += 1;
    months[mk].pts = r2(months[mk].pts + t.pts);
    if (t.exitType === 'TARGET') months[mk].targets += 1;
  }
  const monthRows = Object.values(months)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      ...m,
      winRate: m.trades ? r2((m.wins / m.trades) * 100) : 0,
      targetRate: m.trades ? r2((m.targets / m.trades) * 100) : 0,
    }));

  return {
    year,
    timeframe: tf,
    rules: meta,
    asOf: getIstClock(new Date()).dateKey,
    signals: n,
    buy: buys.length,
    sell: sells.length,
    wins: wins.length,
    losses: losses.length,
    winRate: pct(wins.length),
    buyWinRate: buys.length ? r2((buys.filter((t) => t.win).length / buys.length) * 100) : 0,
    sellWinRate: sells.length ? r2((sells.filter((t) => t.win).length / sells.length) * 100) : 0,
    targetHitRate: pct(trades.filter((t) => t.exitType === 'TARGET').length),
    overnightTrades: overnight.length,
    overnightRate: pct(overnight.length),
    avgHoldDays: avg(trades, 'holdDays'),
    nextCandleDirRate: pct(trades.filter((t) => t.nextDir).length),
    hit05R: pct(trades.filter((t) => t.hit05).length),
    hit1R: pct(trades.filter((t) => t.hit1).length),
    hit15R: pct(trades.filter((t) => t.hit15).length),
    hit2R: pct(trades.filter((t) => t.hit2).length),
    avgPts: avg(trades, 'pts'),
    avgWinPts: avg(wins, 'pts'),
    avgLossPts: avg(losses, 'pts'),
    avgMfeR: avg(trades, 'mfeR'),
    avgR: avg(trades, 'rMult'),
    totalPts: r2(trades.reduce((s, t) => s + t.pts, 0)),
    byExit,
    months: monthRows,
  };
}

async function main() {
  const year = Number(process.argv[2]) || 2026;
  const tf = Number(process.argv[3]) === 5 ? 5 : 15;
  const rr = Number(process.argv[4]) || 2;
  const maxHoldDays = Number(process.argv[5]) || 5;
  const maxCandlePts = tf === 5 ? 80 : 120;
  const entryFrom = OPEN + tf;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);
  await hydrateDhanTokenFromMongo();

  const fetchTf = tf === 5 || tf === 15 ? String(tf) : '5';
  console.log(`Fetching NIFTY ${fetchTf}m ${year} · ${rr}R · maxHold ${maxHoldDays}d…`);
  const payload = await getCandlesWithCache({ symbol: 'NIFTY', interval: fetchTf, year, refresh: false });
  let candles = buildCandles(payload.rows || [], tf);
  try {
    const prev = await getCandlesWithCache({ symbol: 'NIFTY', interval: fetchTf, year: year - 1, refresh: false });
    const warm = buildCandles(prev.rows || [], tf).filter((c) => c.dateKey >= `${year - 1}-12-01`);
    candles = [...warm, ...candles.filter((c) => c.dateKey >= `${year}-01-01`)];
  } catch {
    candles = candles.filter((c) => c.dateKey >= `${year}-01-01`);
  }

  const today = getIstClock(new Date()).dateKey;
  candles = candles.filter((c) => c.dateKey <= today && c.dateKey.startsWith(String(year)));
  const annotated = annotateSignals(candles);
  const trades = [];
  const skipped = [];
  for (let i = 0; i < annotated.length; i += 1) {
    const c = annotated[i];
    if (!c.signal) continue;
    const signalMin = c.end + 1;
    if (signalMin < entryFrom || signalMin > 15 * 60) continue;
    const ev = evaluateSignal(annotated, i, maxCandlePts, { rr, maxHoldDays });
    if (ev.skipped) skipped.push({ date: c.dateKey, time: hhmm(c.start), side: c.signal > 0 ? 'BUY' : 'SELL', reason: ev.reason });
    else trades.push(ev);
  }

  const report = {
    ...summarize(trades, year, tf, { rr, maxHoldDays, maxCandlePts, overnight: true, dayClose: false }),
    skipped: skipped.length,
    skipReasons: skipped.slice(0, 20),
    definition: {
      signal: 'FVG + strong prior body + BOS (consecutive filter)',
      entry: 'signal candle close',
      stop: 'signal low (BUY) / high (SELL)',
      target: `${rr}R on NIFTY (TF wick touch)`,
      slRule: 'later TF candle *closes* through stop',
      overnight: `yes · max ${maxHoldDays} trading days · no day close`,
      win: 'NIFTY points in signal direction > 0 at exit',
    },
  };

  const outDir = path.resolve(__dirname, '..', '..', 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `hp-zone-nifty-accuracy-${year}-${tf}m.json`);
  fs.writeFileSync(outFile, JSON.stringify({ report, trades }, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outFile} (${trades.length} trades)`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
