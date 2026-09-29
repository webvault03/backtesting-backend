/**
 * Master OI act backtest: CE Writing + PE Buying → PUT
 * Ladder record +5/+10/+15/+20/+30 · exit day-close 15:15
 * Entry: first Writing|Buying in 09:20–14:00 (one trade/day)
 *
 * Usage: node scripts/backtestOiWritingBuying.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const FROM = '2026-09-09';
const END = process.env.END_DATE || '2026-09-29';
const OPEN_MIN = 555; // 09:15
const ENTRY_FROM = 560; // 09:20 — skip open noise
const ENTRY_TO = 840; // 14:00
const CLOSE_MARK = 915; // 15:15
const LADDER = [5, 10, 15, 20, 30];

function minsToTime(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function favorMove(side, entrySpot, spot) {
  if (!Number.isFinite(spot) || !Number.isFinite(entrySpot)) return null;
  return side === 'CE' || side === 'CALL' ? spot - entrySpot : entrySpot - spot;
}

function loadRows(doc, liveRows) {
  const src = liveRows?.length ? liveRows : doc?.payload?.rows || [];
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
    }))
    .filter((r) => Number.isFinite(r.minutes) && Number.isFinite(r.spot))
    .sort((a, b) => a.minutes - b.minutes);
}

function isSignal(row) {
  return row.callAct === 'Writing' && row.putAct === 'Buying';
}

function simulateLadder(side, entrySpot, entryMinutes, rowsAsc) {
  const hits = {};
  for (const pts of LADDER) {
    hits[pts] = { status: 'PENDING', hitAt: null, favorAtHit: null };
  }

  let maxFavor = 0;
  let minFavor = 0;
  let exit = null;

  for (const row of rowsAsc) {
    const m = Number(row.minutes);
    if (!Number.isFinite(m) || m < entryMinutes) continue;
    const spot = Number(row.spot);
    if (!Number.isFinite(spot)) continue;
    const fav = favorMove(side, entrySpot, spot);
    if (fav == null) continue;

    if (fav > maxFavor) maxFavor = fav;
    if (fav < minFavor) minFavor = fav;

    for (const pts of LADDER) {
      if (hits[pts].status === 'HIT') continue;
      if (fav >= pts) {
        hits[pts] = {
          status: 'HIT',
          hitAt: minsToTime(m),
          favorAtHit: Number(fav.toFixed(2)),
        };
      }
    }

    if (m >= CLOSE_MARK && !exit) {
      exit = {
        exitMinutes: m,
        exitTime: minsToTime(m),
        exitSpot: spot,
        exitFavor: Number(fav.toFixed(2)),
        result: 'DAY_CLOSE',
        pnlPts: Number(fav.toFixed(2)),
      };
      break;
    }
  }

  if (!exit) {
    const last = [...rowsAsc].reverse().find((r) => Number(r.minutes) >= entryMinutes);
    const spot = Number(last?.spot);
    const fav = favorMove(side, entrySpot, spot);
    const m = Number(last?.minutes);
    exit = {
      exitMinutes: m,
      exitTime: minsToTime(m),
      exitSpot: spot,
      exitFavor: fav != null ? Number(fav.toFixed(2)) : null,
      result: m >= CLOSE_MARK ? 'DAY_CLOSE' : 'LAST_BAR',
      pnlPts: fav != null ? Number(fav.toFixed(2)) : 0,
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
    holdMins: exit.exitMinutes - entryMinutes,
    ...exit,
  };
}

function runDay(dateKey, rows) {
  const session = rows.filter((r) => r.minutes >= OPEN_MIN);
  if (!session.length) return { dateKey, skip: 'no_rows' };

  let entry = null;
  for (const row of session) {
    if (row.minutes < ENTRY_FROM || row.minutes > ENTRY_TO) continue;
    if (!isSignal(row)) continue;
    entry = row;
    break;
  }

  if (!entry) {
    return {
      dateKey,
      openSpot: session[0].spot,
      trade: null,
      note: 'no Writing|Buying in window',
    };
  }

  const side = 'PUT';
  const sim = simulateLadder(side, entry.spot, entry.minutes, session);

  return {
    dateKey,
    openSpot: session[0].spot,
    trade: {
      side,
      signal: 'CE Writing + PE Buying',
      strength: entry.strength,
      act: entry.act,
      bias: entry.flowBias,
      mig: entry.oiMigration,
      entryTime: entry.time || minsToTime(entry.minutes),
      entryMinutes: entry.minutes,
      entrySpot: Number(entry.spot.toFixed(2)),
      ...sim,
    },
  };
}

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const archives = db.collection('oiflowdayarchives');
  const live = db.collection('oiflowminuterows');

  const archKeys = await archives.distinct('dateKey', { dateKey: { $gte: FROM, $lte: END } });
  const liveKeys = await live.distinct('dateKey', { dateKey: { $gte: FROM, $lte: END } });
  const dateKeys = [...new Set([...archKeys, ...liveKeys])].sort();

  const results = [];
  for (const dateKey of dateKeys) {
    const doc = await archives.findOne({ dateKey });
    const liveRows = await live.find({ dateKey }).sort({ minutes: 1 }).toArray();
    // Prefer archive when it has callAct/putAct (live minute rows often omit acts).
    const archRows = doc?.payload?.rows || [];
    const archHasActs = archRows.some((r) => r.callAct && r.callAct !== '—');
    const liveHasActs = liveRows.some((r) => r.callAct && r.callAct !== '—');
    const rows = loadRows(
      doc,
      liveHasActs ? liveRows : archHasActs ? null : liveRows.length ? liveRows : null
    );
    if (!rows.length) {
      results.push({ dateKey, skip: 'no_rows' });
      continue;
    }
    const day = runDay(dateKey, rows);
    day.dataSource = liveHasActs ? 'live_acts' : archHasActs ? 'archive_acts' : 'live_no_acts';
    results.push(day);
  }

  const trades = results.filter((r) => r.trade);
  const noTrade = results.filter((r) => !r.trade && !r.skip);

  const ladderHitRates = {};
  for (const pts of LADDER) {
    const n = trades.filter((r) => r.trade.hitCounts[pts]).length;
    ladderHitRates[pts] = {
      hits: n,
      miss: trades.length - n,
      ratePct: trades.length ? Number(((n / trades.length) * 100).toFixed(1)) : 0,
    };
  }

  const net = trades.reduce((a, r) => a + Number(r.trade.pnlPts || 0), 0);
  const wins = trades.filter((r) => Number(r.trade.pnlPts) > 0);
  const losses = trades.filter((r) => Number(r.trade.pnlPts) < 0);

  // If exited at each ladder level (hypothetical bank)
  const bankIfExitAt = {};
  for (const pts of LADDER) {
    let sum = 0;
    for (const r of trades) {
      sum += r.trade.hitCounts[pts] ? pts : Number(r.trade.pnlPts || 0);
    }
    bankIfExitAt[pts] = Number(sum.toFixed(1));
  }

  const table = results.map((r) => {
    if (r.skip) return { date: r.dateKey, trade: 'SKIP', note: r.skip };
    if (!r.trade) {
      return {
        date: r.dateKey,
        trade: 'NO_ENTRY',
        note: r.note,
        t5: '—',
        t10: '—',
        t15: '—',
        t20: '—',
        t30: '—',
        dayClose: '—',
      };
    }
    const t = r.trade;
    const mark = (pts) => (t.hitCounts[pts] ? `HIT@${t.ladder[pts].hitAt}` : 'MISS');
    return {
      date: r.dateKey,
      side: t.side,
      strength: t.strength,
      act: t.act,
      entry: `${t.entryTime} @ ${t.entrySpot}`,
      t5: mark(5),
      t10: mark(10),
      t15: mark(15),
      t20: mark(20),
      t30: mark(30),
      highest: t.highestHit ? `+${t.highestHit}` : 'none',
      maxFav: t.maxFavor,
      minFav: t.minFavor,
      dayClose: t.pnlPts,
      exit: `${t.exitTime} (${t.result})`,
    };
  });

  const summary = {
    strategy: 'Master OI · Writing|Buying → PUT',
    symbol: 'NIFTY',
    from: FROM,
    to: END,
    entryWindow: '09:20–14:00 first signal',
    exit: '15:15 day close only (ladder = record)',
    ladder: LADDER,
    days: results.length,
    trades: trades.length,
    noEntry: noTrade.length,
    dayCloseWins: wins.length,
    dayCloseLosses: losses.length,
    netDayClosePts: Number(net.toFixed(2)),
    avgDayClosePts: trades.length ? Number((net / trades.length).toFixed(2)) : 0,
    ladderHitRates,
    /** If you banked ladder pts when hit, else day-close */
    hypotheticalBankIfExitAtLadder: bankIfExitAt,
  };

  const outPath = path.join(__dirname, 'tmp_writing_buying_ladder.json');
  fs.writeFileSync(outPath, JSON.stringify({ summary, table, results }, null, 2));

  console.log('\n========== WRITING|BUYING → PUT · NIFTY LADDER ==========\n');
  console.log(`Range: ${FROM} → ${END}`);
  console.log('Signal: CE Writing + PE Buying → PUT (first in 09:20–14:00)');
  console.log('Exit: day close 15:15 · ladder +5/+10/+15/+20/+30 record only\n');

  console.log('--- SUMMARY ---');
  console.log(`Days: ${summary.days} | Trades: ${summary.trades} | No entry: ${summary.noEntry}`);
  console.log(`Day-close W/L: ${summary.dayCloseWins}/${summary.dayCloseLosses}`);
  console.log(`Net day-close: ${summary.netDayClosePts} pts · Avg: ${summary.avgDayClosePts}`);
  console.log('\nLadder hit rate:');
  for (const pts of LADDER) {
    const x = ladderHitRates[pts];
    console.log(`  +${pts}: ${x.hits}/${trades.length} (${x.ratePct}%)`);
  }
  console.log('\nIf banked at ladder (hit→+N else day-close):');
  for (const pts of LADDER) {
    console.log(`  exit@+${pts}: ${bankIfExitAt[pts]} pts total`);
  }

  console.log('\n--- DAY TABLE ---');
  console.log(
    'Date       Entry              +5   +10  +15  +20  +30  Highest  MaxFav  MinFav  DayClose'
  );
  for (const row of table) {
    if (row.trade === 'SKIP' || row.trade === 'NO_ENTRY') {
      console.log(`${row.date}  ${row.trade}  ${row.note || ''}`);
      continue;
    }
    const short = (s) => (String(s).startsWith('HIT') ? 'HIT' : 'MISS');
    console.log(
      [
        row.date,
        String(row.entry).padEnd(18),
        short(row.t5).padEnd(4),
        short(row.t10).padEnd(4),
        short(row.t15).padEnd(4),
        short(row.t20).padEnd(4),
        short(row.t30).padEnd(4),
        String(row.highest).padEnd(8),
        String(row.maxFav).padStart(6),
        String(row.minFav).padStart(6),
        String(row.dayClose).padStart(8),
      ].join(' ')
    );
  }

  console.log('\n--- DETAIL (hit times) ---');
  for (const row of table) {
    if (!row.entry || row.trade === 'NO_ENTRY') continue;
    console.log(
      `${row.date} ${row.side} ${row.strength} | ${row.entry} | 5:${row.t5} 10:${row.t10} 15:${row.t15} 20:${row.t20} 30:${row.t30} | close ${row.dayClose}`
    );
  }

  console.log(`\nJSON: ${outPath}\n`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
