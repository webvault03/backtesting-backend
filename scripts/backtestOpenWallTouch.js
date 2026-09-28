/**
 * Backtest: 09:15 open OI walls near spot → touch → buy CE/PE → +15 pts out.
 * Data: oiflowdayarchives from 2026-09-09+ (no per-strike absolute OI in archives).
 * 2026-09-28 uses live minute rows + absolute OI strikes when present.
 *
 * Usage: node scripts/backtestOpenWallTouch.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const OPEN_MIN = 555; // 09:15
const ENTRY_TO = 630; // 10:30 morning entries
const PROX = 10;
/** Spot pts in favor ≈ option target when ATM delta ~1 short-term proxy. */
const TARGET_SPOT_PTS = 15;
const ONE_TRADE_PER_DAY = true;

function minsToTime(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function pickWallsFromStrikes(strikes) {
  if (!Array.isArray(strikes) || !strikes.length) return null;
  let putWall = null;
  let callWall = null;
  for (const s of strikes) {
    const strike = Number(s.strike);
    const putOi = Number(s.putOi);
    const callOi = Number(s.callOi);
    if (!Number.isFinite(strike)) continue;
    if (Number.isFinite(putOi) && (!putWall || putOi > putWall.oi)) {
      putWall = { strike, oi: putOi, side: 'PUT' };
    }
    if (Number.isFinite(callOi) && (!callWall || callOi > callWall.oi)) {
      callWall = { strike, oi: callOi, side: 'CALL' };
    }
  }
  return { putWall, callWall, source: 'absolute_oi_strikes' };
}

function pickWallsFromArchiveRow(row) {
  const put = Number(row.topPutStrike);
  const call = Number(row.topCallStrike);
  return {
    putWall: Number.isFinite(put) ? { strike: put, oi: null, side: 'PUT' } : null,
    callWall: Number.isFinite(call) ? { strike: call, oi: null, side: 'CALL' } : null,
    source: 'archive_topPutCallStrike',
  };
}

function runDay(dateKey, rowsAsc, openProp) {
  const firstOpen = rowsAsc.find((r) => Number(r.minutes) >= OPEN_MIN) || rowsAsc[0];
  if (!firstOpen) return { dateKey, skip: 'no_rows' };
  const openSpot = Number(firstOpen.spot ?? firstOpen.spotPrice);
  if (!Number.isFinite(openSpot)) return { dateKey, skip: 'no_open_spot' };

  const walls = openProp?.strikes?.length
    ? pickWallsFromStrikes(openProp.strikes)
    : pickWallsFromArchiveRow(firstOpen);
  if (!walls?.putWall && !walls?.callWall) {
    return { dateKey, skip: 'no_walls', openSpot };
  }

  const putStrike = walls.putWall?.strike;
  const callStrike = walls.callWall?.strike;
  let trade = null;

  for (const row of rowsAsc) {
    const m = Number(row.minutes);
    if (!Number.isFinite(m) || m < OPEN_MIN) continue;
    const spot = Number(row.spot ?? row.spotPrice);
    if (!Number.isFinite(spot)) continue;

    if (!trade && m <= ENTRY_TO) {
      const nearPut = Number.isFinite(putStrike) && Math.abs(spot - putStrike) <= PROX;
      const nearCall = Number.isFinite(callStrike) && Math.abs(spot - callStrike) <= PROX;
      if (nearPut || nearCall) {
        let side;
        let wall;
        if (nearPut && nearCall) {
          const dp = Math.abs(spot - putStrike);
          const dc = Math.abs(spot - callStrike);
          if (dp <= dc) {
            side = 'CE';
            wall = putStrike;
          } else {
            side = 'PE';
            wall = callStrike;
          }
        } else if (nearPut) {
          side = 'CE';
          wall = putStrike;
        } else {
          side = 'PE';
          wall = callStrike;
        }
        trade = {
          side,
          wall,
          wallType: side === 'CE' ? 'PUT_SUPPORT' : 'CALL_RESISTANCE',
          entryMinutes: m,
          entryTime: minsToTime(m),
          entrySpot: spot,
          targetSpot: side === 'CE' ? spot + TARGET_SPOT_PTS : spot - TARGET_SPOT_PTS,
        };
        if (!ONE_TRADE_PER_DAY) {
          /* reserved */
        }
      }
    }

    if (trade && !trade.exitTime) {
      const hit =
        (trade.side === 'CE' && spot >= trade.targetSpot)
        || (trade.side === 'PE' && spot <= trade.targetSpot);
      if (hit && m > trade.entryMinutes) {
        trade.exitMinutes = m;
        trade.exitTime = minsToTime(m);
        trade.exitSpot = spot;
        trade.result = 'TARGET_15';
        trade.holdMins = m - trade.entryMinutes;
        trade.spotMove = Number((spot - trade.entrySpot).toFixed(2));
      }
    }
  }

  if (trade && !trade.exitTime) {
    const last = [...rowsAsc].reverse().find((r) => Number(r.minutes) >= trade.entryMinutes);
    const spot = Number(last?.spot ?? last?.spotPrice);
    trade.exitMinutes = Number(last?.minutes);
    trade.exitTime = minsToTime(trade.exitMinutes);
    trade.exitSpot = spot;
    trade.result = 'NO_TARGET_EOD';
    trade.holdMins = trade.exitMinutes - trade.entryMinutes;
    trade.spotMove = Number.isFinite(spot) ? Number((spot - trade.entrySpot).toFixed(2)) : null;
  }

  return {
    dateKey,
    openTime: minsToTime(firstOpen.minutes),
    openSpot,
    putWall: putStrike ?? null,
    callWall: callStrike ?? null,
    wallSource: walls.source,
    trade,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);

  const archives = mongoose.connection.db.collection('oiflowdayarchives');
  const live = mongoose.connection.db.collection('oiflowminuterows');
  const docs = await archives.find({ dateKey: { $gte: '2026-09-09' } }).sort({ dateKey: 1 }).toArray();
  const results = [];

  for (const d of docs) {
    const rows = (d.payload?.rows || []).slice().sort((a, b) => a.minutes - b.minutes);
    if (d.dateKey === '2026-09-28') {
      const liveOpen = await live.find({ dateKey: '2026-09-28', minutes: { $gte: 555 } })
        .sort({ minutes: 1 })
        .limit(1)
        .next();
      const openProp = liveOpen?.strikes?.length ? { strikes: liveOpen.strikes } : null;
      const liveRows = await live.find({ dateKey: '2026-09-28' }).sort({ minutes: 1 }).toArray();
      if (liveRows.length) {
        const mapped = liveRows.map((r) => ({
          minutes: r.minutes,
          time: r.time,
          spot: r.spotPrice ?? r.futPrice,
          atm: r.atm,
          topPutStrike: r.topPutChgStrike,
          topCallStrike: r.topCallChgStrike,
        }));
        results.push(runDay(d.dateKey, mapped, openProp));
        continue;
      }
    }
    results.push(runDay(d.dateKey, rows, null));
  }

  const trades = results.filter((r) => r.trade);
  const hits = trades.filter((r) => r.trade.result === 'TARGET_15');
  const misses = trades.filter((r) => r.trade.result !== 'TARGET_15');
  const ce = trades.filter((r) => r.trade.side === 'CE');
  const pe = trades.filter((r) => r.trade.side === 'PE');

  const summary = {
    assumption:
      'Target = +15 spot pts in option direction (archives lack option LTP). '
      + 'Walls: archive topPut/topCall at first morning minute; 2026-09-28 uses absolute OI strikes when available. '
      + 'Touch = spot within 10 pts of wall. Entry window 09:15–10:30. One trade/day. Put wall→CE, Call wall→PE.',
    days: results.length,
    daysWithTrade: trades.length,
    daysNoTrade: results.filter((r) => !r.trade && !r.skip).length,
    skipped: results.filter((r) => r.skip).map((r) => `${r.dateKey}:${r.skip}`),
    targetHits: hits.length,
    noTarget: misses.length,
    hitRatePct: trades.length ? Number(((hits.length / trades.length) * 100).toFixed(1)) : 0,
    ceTrades: ce.length,
    peTrades: pe.length,
    avgHoldMinsOnHit: hits.length
      ? Number((hits.reduce((a, r) => a + r.trade.holdMins, 0) / hits.length).toFixed(1))
      : null,
  };

  const out = { summary, results };
  const outPath = path.join(__dirname, 'tmp_open_wall_backtest.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log('\n--- trades ---');
  for (const r of results) {
    if (!r.trade) {
      console.log(`${r.dateKey} | NO TRADE | open=${r.openSpot} put=${r.putWall} call=${r.callWall} (${r.wallSource || r.skip})`);
      continue;
    }
    const t = r.trade;
    console.log(
      `${r.dateKey} | ${t.side} @${t.entryTime} wall=${t.wall}(${t.wallType}) entrySpot=${t.entrySpot}`
      + ` → ${t.result} @${t.exitTime} exitSpot=${t.exitSpot} hold=${t.holdMins}m move=${t.spotMove}`
      + ` | open=${r.openSpot} putW=${r.putWall} callW=${r.callWall} src=${r.wallSource}`,
    );
  }
  console.log(`\nWrote ${outPath}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
