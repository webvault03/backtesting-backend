/**
 * OI + Candle agree / fade-fake backtest
 *
 * REAL (agree):
 *   DOWN: Writing|Buying + (bear_body | upper_wick_trap | DOWN body) → PE BUY
 *   UP:   Short cover|Writing + (bull_body | lower_wick_trap | UP body) → CE BUY
 *
 * FAKE (disagree → fade):
 *   FAKE_UP:   Writing|Buying + (bull_body | lower_wick_trap | UP) → PE BUY
 *   FAKE_DOWN: Short cover|Writing + (bear_body | upper_wick_trap | DOWN) → CE BUY
 *
 * 15m closed bars · 1 open · bank ladder +5..+30 record · exit day close
 * Also report if banked at +15.
 *
 * Usage: node scripts/backtestOiCandleAgree.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const FROM = '2026-09-09';
const END = process.env.END_DATE || '2026-09-29';
const SESSION_FROM = 9 * 60 + 15;
const ENTRY_FROM = 560; // 09:20
const ENTRY_TO = 840; // 14:00
const CLOSE_MARK = 915;
const LADDER = [5, 10, 15, 20, 30];
const MODE = process.env.MODE || 'BOTH'; // REAL | FADE | BOTH
const ONE_PER_DAY = true;

function minsToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function favorMove(side, entrySpot, spot) {
  return side === 'CE' ? spot - entrySpot : entrySpot - spot;
}

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
      strength: typeof r.strength === 'string' ? r.strength : r.strength?.label || '—',
      act: r.act || '—',
    }))
    .filter((r) => Number.isFinite(r.minutes) && Number.isFinite(r.spot))
    .sort((a, b) => a.minutes - b.minutes);
}

function buildBars15(rows) {
  const step = 15;
  const byBucket = new Map();
  for (const r of rows) {
    if (r.minutes < SESSION_FROM) continue;
    const bucket = SESSION_FROM + Math.floor((r.minutes - SESSION_FROM) / step) * step;
    if (!byBucket.has(bucket)) byBucket.set(bucket, { spots: [], rows: [], startMin: bucket });
    const b = byBucket.get(bucket);
    b.spots.push(r.spot);
    b.rows.push(r);
  }
  const bars = [];
  for (const [, b] of [...byBucket.entries()].sort((a, c) => a[0] - c[0])) {
    if (b.spots.length < 2) continue;
    const open = b.spots[0];
    const close = b.spots[b.spots.length - 1];
    const high = Math.max(...b.spots);
    const low = Math.min(...b.spots);
    const range = high - low;
    const body = Math.abs(close - open);
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const bodyPct = range > 0 ? (body / range) * 100 : 0;
    const upperPct = range > 0 ? (upperWick / range) * 100 : 0;
    const lowerPct = range > 0 ? (lowerWick / range) * 100 : 0;
    const dir = close > open + 0.5 ? 'UP' : close < open - 0.5 ? 'DOWN' : 'DOJI';

    const counts = {};
    for (const r of b.rows) {
      const k = `${r.callAct}|${r.putAct}`;
      if (k === '—|—') continue;
      counts[k] = (counts[k] || 0) + 1;
    }
    const dominantPair = Object.entries(counts).sort((a, c) => c[1] - a[1])[0]?.[0] || '—|—';
    const [callAct, putAct] = dominantPair.split('|');

    let shape = 'body';
    if (range < 3) shape = 'tiny';
    else if (dir === 'DOJI' && range >= 5) shape = 'doji';
    else if (upperPct >= 55 && bodyPct <= 35) shape = 'upper_wick_trap';
    else if (lowerPct >= 55 && bodyPct <= 35) shape = 'lower_wick_trap';
    else if (bodyPct >= 60 && dir === 'UP') shape = 'bull_body';
    else if (bodyPct >= 60 && dir === 'DOWN') shape = 'bear_body';

    const last = b.rows[b.rows.length - 1];
    bars.push({
      startMin: b.startMin,
      endMin: b.startMin + step - 1,
      time: last.time || minsToTime(b.startMin + step - 1),
      open,
      high,
      low,
      close,
      range,
      dir,
      shape,
      dominantPair,
      callAct,
      putAct,
      entrySpot: close, // enter on bar close
      entryMinutes: last.minutes,
    });
  }
  return bars;
}

function matchSignal(bar) {
  const pair = bar.dominantPair;
  const { shape, dir } = bar;

  const bearCandle =
    shape === 'bear_body' || shape === 'upper_wick_trap' || dir === 'DOWN';
  const bullCandle =
    shape === 'bull_body' || shape === 'lower_wick_trap' || dir === 'UP';

  // REAL agree
  if (pair === 'Writing|Buying' && bearCandle) {
    return {
      kind: 'REAL',
      optionBuy: 'PE BUY',
      side: 'PE',
      reason: `AGREE down · ${shape} + Writing|Buying`,
    };
  }
  if (pair === 'Short cover|Writing' && bullCandle) {
    return {
      kind: 'REAL',
      optionBuy: 'CE BUY',
      side: 'CE',
      reason: `AGREE up · ${shape} + Short cover|Writing`,
    };
  }

  // FAKE fade
  if (pair === 'Writing|Buying' && bullCandle) {
    return {
      kind: 'FADE',
      optionBuy: 'PE BUY',
      side: 'PE',
      reason: `FADE fake-up · ${shape} vs Writing|Buying`,
    };
  }
  if (pair === 'Short cover|Writing' && bearCandle) {
    return {
      kind: 'FADE',
      optionBuy: 'CE BUY',
      side: 'CE',
      reason: `FADE fake-down · ${shape} vs Short cover|Writing`,
    };
  }
  return null;
}

function simulateLadder(side, entrySpot, entryMinutes, rowsAsc) {
  const hits = {};
  for (const pts of LADDER) hits[pts] = { status: 'PENDING', hitAt: null };

  let maxFavor = 0;
  let minFavor = 0;
  let exit = null;

  for (const row of rowsAsc) {
    const m = Number(row.minutes);
    if (m < entryMinutes) continue;
    const spot = Number(row.spot);
    if (!Number.isFinite(spot)) continue;
    const fav = favorMove(side, entrySpot, spot);
    if (fav > maxFavor) maxFavor = fav;
    if (fav < minFavor) minFavor = fav;

    for (const pts of LADDER) {
      if (hits[pts].status === 'HIT') continue;
      if (fav >= pts) hits[pts] = { status: 'HIT', hitAt: minsToTime(m) };
    }

    if (m >= CLOSE_MARK && !exit) {
      exit = {
        exitTime: minsToTime(m),
        pnlPts: Number(fav.toFixed(2)),
        result: 'DAY_CLOSE',
      };
      break;
    }
  }

  if (!exit) {
    const last = [...rowsAsc].reverse().find((r) => r.minutes >= entryMinutes);
    const fav = favorMove(side, entrySpot, Number(last?.spot));
    exit = {
      exitTime: minsToTime(last?.minutes),
      pnlPts: fav != null ? Number(fav.toFixed(2)) : 0,
      result: 'LAST_BAR',
    };
  }

  for (const pts of LADDER) {
    if (hits[pts].status !== 'HIT') hits[pts].status = 'MISSED';
  }

  const hitList = LADDER.filter((p) => hits[p].status === 'HIT');
  return {
    ladder: hits,
    hitCounts: Object.fromEntries(LADDER.map((p) => [p, hits[p].status === 'HIT'])),
    highestHit: hitList.length ? hitList[hitList.length - 1] : 0,
    maxFavor: Number(maxFavor.toFixed(2)),
    minFavor: Number(minFavor.toFixed(2)),
    ...exit,
  };
}

function runDay(dateKey, rows) {
  const session = rows.filter((r) => r.minutes >= SESSION_FROM);
  const bars = buildBars15(session);
  const trades = [];

  for (const bar of bars) {
    if (bar.entryMinutes < ENTRY_FROM || bar.entryMinutes > ENTRY_TO) continue;
    const sig = matchSignal(bar);
    if (!sig) continue;
    if (MODE === 'REAL' && sig.kind !== 'REAL') continue;
    if (MODE === 'FADE' && sig.kind !== 'FADE') continue;

    const sim = simulateLadder(sig.side, bar.entrySpot, bar.entryMinutes, session);
    trades.push({
      dateKey,
      optionBuy: sig.optionBuy,
      side: sig.side,
      kind: sig.kind,
      reason: sig.reason,
      shape: bar.shape,
      candleDir: bar.dir,
      pair: bar.dominantPair,
      entry: `${bar.time} @ ${Number(bar.entrySpot.toFixed(2))}`,
      entryMinutes: bar.entryMinutes,
      entrySpot: Number(bar.entrySpot.toFixed(2)),
      ...sim,
    });

    if (ONE_PER_DAY) break;
  }

  return { dateKey, trades, bars: bars.length };
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

  const all = [];
  const dayRows = [];

  for (const dateKey of keys) {
    const doc = await archives.findOne({ dateKey });
    const liveRows = await live.find({ dateKey }).sort({ minutes: 1 }).toArray();
    const rows = loadRows(doc, liveRows);
    if (!rows.length) {
      dayRows.push({ date: dateKey, trades: 0, note: 'no_rows' });
      continue;
    }
    const day = runDay(dateKey, rows);
    all.push(...day.trades);
    if (!day.trades.length) {
      dayRows.push({ date: dateKey, trades: 0, note: 'no_signal' });
    } else {
      for (const t of day.trades) {
        dayRows.push({
          date: t.dateKey,
          optionBuy: t.optionBuy,
          kind: t.kind,
          shape: t.shape,
          pair: t.pair,
          entry: t.entry,
          t5: t.hitCounts[5] ? 'HIT' : 'MISS',
          t10: t.hitCounts[10] ? 'HIT' : 'MISS',
          t15: t.hitCounts[15] ? 'HIT' : 'MISS',
          t20: t.hitCounts[20] ? 'HIT' : 'MISS',
          t30: t.hitCounts[30] ? 'HIT' : 'MISS',
          highest: t.highestHit ? `+${t.highestHit}` : 'none',
          maxFav: t.maxFavor,
          dayClose: t.pnlPts,
          reason: t.reason,
        });
      }
    }
  }

  const ladderRates = {};
  for (const pts of LADDER) {
    const n = all.filter((t) => t.hitCounts[pts]).length;
    ladderRates[pts] = {
      hits: n,
      ratePct: all.length ? Number(((n / all.length) * 100).toFixed(1)) : 0,
    };
  }

  const netClose = all.reduce((s, t) => s + t.pnlPts, 0);
  const bank15 = all.reduce((s, t) => s + (t.hitCounts[15] ? 15 : t.pnlPts), 0);
  const pe = all.filter((t) => t.side === 'PE');
  const ce = all.filter((t) => t.side === 'CE');
  const real = all.filter((t) => t.kind === 'REAL');
  const fade = all.filter((t) => t.kind === 'FADE');

  const summary = {
    strategy: 'OI + Candle AGREE / FADE',
    mode: MODE,
    onePerDay: ONE_PER_DAY,
    from: FROM,
    to: END,
    trades: all.length,
    peBuys: pe.length,
    ceBuys: ce.length,
    realEntries: real.length,
    fadeEntries: fade.length,
    dayCloseNet: Number(netClose.toFixed(2)),
    dayCloseWL: `${all.filter((t) => t.pnlPts > 0).length}/${all.filter((t) => t.pnlPts < 0).length}`,
    bankPlus15Net: Number(bank15.toFixed(2)),
    ladderHitRates: ladderRates,
    peDayCloseNet: Number(pe.reduce((s, t) => s + t.pnlPts, 0).toFixed(2)),
    ceDayCloseNet: Number(ce.reduce((s, t) => s + t.pnlPts, 0).toFixed(2)),
    realDayCloseNet: Number(real.reduce((s, t) => s + t.pnlPts, 0).toFixed(2)),
    fadeDayCloseNet: Number(fade.reduce((s, t) => s + t.pnlPts, 0).toFixed(2)),
    realBank15: Number(real.reduce((s, t) => s + (t.hitCounts[15] ? 15 : t.pnlPts), 0).toFixed(2)),
    fadeBank15: Number(fade.reduce((s, t) => s + (t.hitCounts[15] ? 15 : t.pnlPts), 0).toFixed(2)),
  };

  const outPath = path.join(__dirname, 'tmp_oi_candle_agree_report.json');
  fs.writeFileSync(outPath, JSON.stringify({ summary, dayRows, trades: all }, null, 2));

  console.log('\n========== OI + CANDLE AGREE / FADE · NIFTY ==========\n');
  console.log(`Mode: ${MODE} · 1/day · 15m bar close entry · ${FROM} → ${END}\n`);
  console.log('--- SUMMARY ---');
  console.log(`Trades: ${summary.trades} (PE ${summary.peBuys} / CE ${summary.ceBuys})`);
  console.log(`REAL: ${summary.realEntries} · FADE: ${summary.fadeEntries}`);
  console.log(`Day-close W/L: ${summary.dayCloseWL} · Net: ${summary.dayCloseNet}`);
  console.log(`If bank +15: ${summary.bankPlus15Net}`);
  console.log(`PE net close: ${summary.peDayCloseNet} · CE net close: ${summary.ceDayCloseNet}`);
  console.log(`REAL close/bank15: ${summary.realDayCloseNet} / ${summary.realBank15}`);
  console.log(`FADE close/bank15: ${summary.fadeDayCloseNet} / ${summary.fadeBank15}`);
  console.log('Ladder:');
  for (const p of LADDER) console.log(`  +${p}: ${ladderRates[p].hits}/${all.length} (${ladderRates[p].ratePct}%)`);

  console.log('\n--- TRADE TABLE ---');
  console.log(
    'Date       Option   Kind  Shape              Pair                 Entry              +5   +10  +15  +20  +30  High   DayClose'
  );
  for (const r of dayRows) {
    if (!r.optionBuy) {
      console.log(`${r.date}  —        —     —                  —                    ${r.note || ''}`);
      continue;
    }
    console.log(
      [
        r.date,
        r.optionBuy.padEnd(7),
        r.kind.padEnd(4),
        String(r.shape).padEnd(18),
        String(r.pair).padEnd(20),
        String(r.entry).padEnd(18),
        r.t5.padEnd(4),
        r.t10.padEnd(4),
        r.t15.padEnd(4),
        r.t20.padEnd(4),
        r.t30.padEnd(4),
        String(r.highest).padEnd(6),
        String(r.dayClose).padStart(8),
      ].join(' ')
    );
  }

  console.log(`\nJSON: ${outPath}\n`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
