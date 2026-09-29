/**
 * Deep OI + Candle autopsy (same clock as OI tape).
 * Builds 1m/5m/15m OHLC from minute spots, joins acts, scores fake vs real.
 *
 * Usage: node scripts/analyzeOiCandleDeep.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const FROM = '2026-09-09';
const END = process.env.END_DATE || '2026-09-29';
const SESSION_FROM = 9 * 60 + 15;
const SESSION_TO = 15 * 60 + 15;

function loadRows(doc, liveRows) {
  const arch = doc?.payload?.rows || [];
  const archHasActs = arch.some((r) => r.callAct && r.callAct !== '—');
  const src = archHasActs ? arch : liveRows?.length ? liveRows : arch;
  return src
    .map((r) => ({
      minutes: Number(r.minutes),
      time: r.time,
      spot: Number(r.spotPrice ?? r.spot ?? r.futPrice),
      callAct: r.callAct || '—',
      putAct: r.putAct || '—',
      act: r.act || '—',
      strength: typeof r.strength === 'string' ? r.strength : r.strength?.label || '—',
      flowBias: r.flowBias || '—',
      oiMigration: r.oiMigration || '—',
      oiVelocity: Number(r.oiVelocity),
      chngInDir: Number(r.chngInDir),
      deltaPcr: Number(r.deltaPcr),
    }))
    .filter(
      (r) =>
        Number.isFinite(r.minutes) &&
        Number.isFinite(r.spot) &&
        r.minutes >= SESSION_FROM &&
        r.minutes <= SESSION_TO
    )
    .sort((a, b) => a.minutes - b.minutes);
}

function pairOf(r) {
  return `${r.callAct}|${r.putAct}`;
}

/** Aggregate 1m spots into step-minute OHLC bars; attach last-minute OI acts. */
function buildBars(rows, step) {
  const byBucket = new Map();
  for (const r of rows) {
    if (r.minutes < SESSION_FROM) continue;
    const bucket = SESSION_FROM + Math.floor((r.minutes - SESSION_FROM) / step) * step;
    const endMin = bucket + step - 1;
    if (!byBucket.has(bucket)) {
      byBucket.set(bucket, {
        startMin: bucket,
        endMin,
        opens: [],
        spots: [],
        rows: [],
      });
    }
    const b = byBucket.get(bucket);
    b.spots.push(r.spot);
    b.rows.push(r);
  }

  const bars = [];
  for (const [, b] of [...byBucket.entries()].sort((a, c) => a[0] - c[0])) {
    if (!b.spots.length) continue;
    const open = b.spots[0];
    const close = b.spots[b.spots.length - 1];
    const high = Math.max(...b.spots);
    const low = Math.min(...b.spots);
    const range = high - low;
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const dir = close > open + 0.5 ? 'UP' : close < open - 0.5 ? 'DOWN' : 'DOJI';
    const last = b.rows[b.rows.length - 1];
    // dominant act pair inside bar (mode)
    const counts = {};
    for (const r of b.rows) {
      const k = pairOf(r);
      if (k === '—|—') continue;
      counts[k] = (counts[k] || 0) + 1;
    }
    const dominantPair =
      Object.entries(counts).sort((a, c) => c[1] - a[1])[0]?.[0] || '—|—';

    const bodyPct = range > 0 ? (body / range) * 100 : 0;
    const upperPct = range > 0 ? (upperWick / range) * 100 : 0;
    const lowerPct = range > 0 ? (lowerWick / range) * 100 : 0;

    let shape = 'body';
    if (range < 3) shape = 'tiny';
    else if (dir === 'DOJI' && range >= 5) shape = 'doji';
    else if (upperPct >= 55 && bodyPct <= 35) shape = 'upper_wick_trap'; // rejection up / sellers
    else if (lowerPct >= 55 && bodyPct <= 35) shape = 'lower_wick_trap'; // rejection down / buyers
    else if (bodyPct >= 60 && dir === 'UP') shape = 'bull_body';
    else if (bodyPct >= 60 && dir === 'DOWN') shape = 'bear_body';

    bars.push({
      step,
      startMin: b.startMin,
      endMin: b.endMin,
      time: last.time,
      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      range: Number(range.toFixed(2)),
      body: Number(body.toFixed(2)),
      bodyPct: Number(bodyPct.toFixed(1)),
      upperPct: Number(upperPct.toFixed(1)),
      lowerPct: Number(lowerPct.toFixed(1)),
      dir,
      shape,
      dominantPair,
      callAct: last.callAct,
      putAct: last.putAct,
      act: last.act,
      strength: last.strength,
      flowBias: last.flowBias,
      oiMigration: last.oiMigration,
      oiVelocity: last.oiVelocity,
      chngInDir: last.chngInDir,
    });
  }
  return bars;
}

function fwdMove(bars, i, n) {
  if (i + n >= bars.length) return null;
  return bars[i + n].close - bars[i].close;
}

function ensure(map, key) {
  if (!map[key]) {
    map[key] = { n: 0, days: new Set(), sumFwd1: 0, sumFwd2: 0, up: 0, down: 0, boomUp: 0, boomDown: 0 };
  }
  return map[key];
}

function rank(map, minN = 8) {
  return Object.entries(map)
    .map(([key, v]) => {
      const n = v.n;
      return {
        key,
        n,
        days: v.days.size,
        avgNext1: Number((v.sumFwd1 / n).toFixed(2)),
        avgNext2: Number((v.sumFwd2 / n).toFixed(2)),
        upPct: Number(((v.up / n) * 100).toFixed(1)),
        boomUp: v.boomUp,
        boomDown: v.boomDown,
      };
    })
    .filter((x) => x.n >= minN)
    .sort((a, b) => Math.abs(b.avgNext1) - Math.abs(a.avgNext1));
}

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const archives = db.collection('oiflowdayarchives');
  const live = db.collection('oiflowminuterows');

  const keys = [
    ...new Set([
      ...(await archives.distinct('dateKey', { dateKey: { $gte: FROM, $lte: END } })),
      ...(await live.distinct('dateKey', { dateKey: { $gte: FROM, $lte: END } })),
    ]),
  ].sort();

  // Focus 15m for "big player" structure; also 5m
  const combo15 = {}; // shape|pair
  const combo5 = {};
  const diverge15 = {}; // candle dir vs OI pair textbook
  const fakePatterns = []; // upper wick + bull OI then down, etc.
  const realPatterns = [];
  const dayNotes = [];

  // textbook OI lean
  function oiLean(pair) {
    if (pair === 'Writing|Buying') return 'DOWN';
    if (pair === 'Short cover|Writing') return 'UP';
    if (pair === 'Long build|Buying') return 'DOWN';
    if (pair === 'Long build|Writing') return 'MIX';
    if (pair === 'Writing|Short cover') return 'UP';
    return 'MIX';
  }

  for (const dateKey of keys) {
    const doc = await archives.findOne({ dateKey });
    const liveRows = await live.find({ dateKey }).sort({ minutes: 1 }).toArray();
    const rows = loadRows(doc, liveRows);
    if (rows.length < 50) continue;

    const bars15 = buildBars(rows, 15);
    const bars5 = buildBars(rows, 5);

    let dayFake = 0;
    let dayReal = 0;

    for (let i = 0; i < bars15.length - 2; i += 1) {
      const b = bars15[i];
      const f1 = fwdMove(bars15, i, 1);
      const f2 = fwdMove(bars15, i, 2);
      if (f1 == null) continue;

      const key = `${b.shape} · ${b.dominantPair}`;
      const c = ensure(combo15, key);
      c.n += 1;
      c.days.add(dateKey);
      c.sumFwd1 += f1;
      c.sumFwd2 += f2 || 0;
      if (f1 > 2) c.up += 1;
      if (f1 < -2) c.down += 1;
      if (f1 >= 10) c.boomUp += 1;
      if (f1 <= -10) c.boomDown += 1;

      const lean = oiLean(b.dominantPair);
      const divKey = `candle:${b.dir}/${b.shape} + oi:${lean}/${b.dominantPair}`;
      const d = ensure(diverge15, divKey);
      d.n += 1;
      d.days.add(dateKey);
      d.sumFwd1 += f1;
      d.sumFwd2 += f2 || 0;
      if (f1 > 2) d.up += 1;
      if (f1 < -2) d.down += 1;
      if (f1 >= 10) d.boomUp += 1;
      if (f1 <= -10) d.boomDown += 1;

      // FAKE UP: bull body or lower rejection fails → next bar down hard, OI was Writing|Buying
      const fakeUp =
        (b.dir === 'UP' || b.shape === 'lower_wick_trap') &&
        lean === 'DOWN' &&
        f1 <= -8;
      // FAKE DOWN: bear body then reverse up, OI lean UP
      const fakeDown =
        (b.dir === 'DOWN' || b.shape === 'upper_wick_trap') &&
        lean === 'UP' &&
        f1 >= 8;

      // REAL: candle + OI same side, next continues
      const realDown =
        lean === 'DOWN' &&
        (b.dir === 'DOWN' || b.shape === 'upper_wick_trap' || b.shape === 'bear_body') &&
        f1 <= -8;
      const realUp =
        lean === 'UP' &&
        (b.dir === 'UP' || b.shape === 'lower_wick_trap' || b.shape === 'bull_body') &&
        f1 >= 8;

      if (fakeUp || fakeDown) {
        dayFake += 1;
        if (fakePatterns.length < 60) {
          fakePatterns.push({
            dateKey,
            time: b.time,
            type: fakeUp ? 'FAKE_UP_then_DOWN' : 'FAKE_DOWN_then_UP',
            shape: b.shape,
            candleDir: b.dir,
            pair: b.dominantPair,
            oiLean: lean,
            next15: Number(f1.toFixed(1)),
            range: b.range,
          });
        }
      }
      if (realUp || realDown) {
        dayReal += 1;
        if (realPatterns.length < 60) {
          realPatterns.push({
            dateKey,
            time: b.time,
            type: realUp ? 'REAL_UP' : 'REAL_DOWN',
            shape: b.shape,
            candleDir: b.dir,
            pair: b.dominantPair,
            oiLean: lean,
            next15: Number(f1.toFixed(1)),
            range: b.range,
          });
        }
      }
    }

    for (let i = 0; i < bars5.length - 2; i += 1) {
      const b = bars5[i];
      const f1 = fwdMove(bars5, i, 2); // next ~10m
      if (f1 == null) continue;
      const key = `${b.shape} · ${b.dominantPair}`;
      const c = ensure(combo5, key);
      c.n += 1;
      c.days.add(dateKey);
      c.sumFwd1 += f1;
      c.sumFwd2 += 0;
      if (f1 > 2) c.up += 1;
      if (f1 < -2) c.down += 1;
      if (f1 >= 10) c.boomUp += 1;
      if (f1 <= -10) c.boomDown += 1;
    }

    dayNotes.push({
      dateKey,
      bars15: bars15.length,
      bars5: bars5.length,
      fakeAligned: dayFake,
      realAligned: dayReal,
    });
  }

  // Master combined rules candidates
  const master15 = rank(combo15, 6).slice(0, 25);
  const master5 = rank(combo5, 10).slice(0, 20);
  const divergeRank = rank(diverge15, 5).slice(0, 25);

  // Specific: Writing|Buying + candle shapes
  const wbShapes = master15.filter((x) => x.key.includes('Writing|Buying'));
  const scwShapes = master15.filter((x) => x.key.includes('Short cover|Writing'));

  const out = {
    meta: {
      from: FROM,
      to: END,
      days: keys.length,
      idea: 'Candles built from same OI minute spots (synced clock). Join shape + dominant CE|PE act → next bar move.',
      howToRead: {
        upper_wick_trap: 'sellers rejected highs (mold up then dump)',
        lower_wick_trap: 'buyers rejected lows (mold down then lift)',
        bear_body: 'strong down body',
        bull_body: 'strong up body',
        Writing_Buying: 'OI lean DOWN (call write + put buy)',
        Short_cover_Writing: 'OI lean UP',
      },
    },
    dayNotes,
    top15m_shape_plus_oi: master15,
    writingBuying_with_candle: wbShapes,
    shortCoverWriting_with_candle: scwShapes,
    top5m_shape_plus_oi: master5,
    candle_vs_oi_combos: divergeRank,
    sampleFakes: fakePatterns.slice(0, 20),
    sampleReals: realPatterns.slice(0, 20),
  };

  const outPath = path.join(__dirname, 'tmp_oi_candle_deep.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log('\n========== OI + CANDLE DEEP · NIFTY ==========\n');
  console.log(`${FROM} → ${END} | days ${keys.length}`);
  console.log('Candles from OI minute spots · join shape + CE|PE acts · next 15m move\n');

  console.log('--- Writing|Buying + CANDLE SHAPE (next 15m) ---');
  for (const x of wbShapes) {
    console.log(
      `  ${x.key.padEnd(45)} n=${x.n} days=${x.days} avgNext=${x.avgNext1} boom↑${x.boomUp} boom↓${x.boomDown}`
    );
  }

  console.log('\n--- TOP 15m SHAPE · OI PAIRS ---');
  for (const x of master15.slice(0, 15)) {
    console.log(
      `  ${x.key.slice(0, 50).padEnd(50)} n=${String(x.n).padStart(3)} avg=${String(x.avgNext1).padStart(7)} ↑${x.boomUp} ↓${x.boomDown}`
    );
  }

  console.log('\n--- CANDLE vs OI (divergence / alignment) ---');
  for (const x of divergeRank.slice(0, 12)) {
    console.log(
      `  ${x.key.slice(0, 72).padEnd(72)} n=${x.n} avg=${x.avgNext1}`
    );
  }

  console.log('\n--- DAY FAKE vs REAL (15m aligned) ---');
  for (const d of dayNotes) {
    console.log(`${d.dateKey} fake=${d.fakeAligned} real=${d.realAligned}`);
  }

  console.log('\n--- SAMPLE FAKES ---');
  for (const f of fakePatterns.slice(0, 8)) {
    console.log(
      `  ${f.dateKey} ${f.time} ${f.type} shape=${f.shape} pair=${f.pair} next15=${f.next15}`
    );
  }

  console.log(`\nJSON: ${outPath}\n`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
