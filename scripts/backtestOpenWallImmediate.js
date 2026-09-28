/**
 * Open-wall immediate backtest with hard +15 spot-pt target exit.
 * Usage: node scripts/backtestOpenWallImmediate.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const OPEN_MIN = 555;
const ENTRY_TO = 645;
const CLOSE_MARK = 915; // 15:15 flat if target not hit
const PROX = 25;
const TARGET_PTS = 20;
const CHECKS = [5, 10, 15, 20, 25, 30];

function minsToTime(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function favorMove(side, entrySpot, spot) {
  if (!Number.isFinite(spot) || !Number.isFinite(entrySpot)) return null;
  return side === 'CE' ? spot - entrySpot : entrySpot - spot;
}

function pickWallsFromStrikes(strikes, openSpot) {
  if (!Array.isArray(strikes) || !strikes.length) return null;
  const near = strikes
    .map((s) => ({
      strike: Number(s.strike),
      putOi: Number(s.putOi),
      callOi: Number(s.callOi),
    }))
    .filter((s) => Number.isFinite(s.strike) && Math.abs(s.strike - openSpot) <= 200);
  const pool = near.length
    ? near
    : strikes
      .map((s) => ({
        strike: Number(s.strike),
        putOi: Number(s.putOi),
        callOi: Number(s.callOi),
      }))
      .filter((s) => Number.isFinite(s.strike));

  let putWall = null;
  let callWall = null;
  for (const s of pool) {
    if (Number.isFinite(s.putOi) && (!putWall || s.putOi > putWall.oi)) {
      putWall = { strike: s.strike, oi: s.putOi };
    }
    if (Number.isFinite(s.callOi) && (!callWall || s.callOi > callWall.oi)) {
      callWall = { strike: s.strike, oi: s.callOi };
    }
  }
  return { putWall, callWall, source: 'absolute_oi_strikes' };
}

function pickWallsFromArchiveRow(row, openSpot) {
  let put = Number(row.topPutStrike);
  let call = Number(row.topCallStrike);
  const atm = Number(row.atm);
  if ((!Number.isFinite(put) || put <= 0) && Number.isFinite(atm)) put = atm;
  if ((!Number.isFinite(call) || call <= 0) && Number.isFinite(atm)) call = atm;
  const round50 = (x) => Math.round(x / 50) * 50;
  if (Number.isFinite(put) && Math.abs(put - openSpot) > 150) put = round50(openSpot);
  if (Number.isFinite(call) && Math.abs(call - openSpot) > 150) call = round50(openSpot);
  return {
    putWall: Number.isFinite(put) && put > 0 ? { strike: put, oi: null } : null,
    callWall: Number.isFinite(call) && call > 0 ? { strike: call, oi: null } : null,
    source: 'archive_topPutCallStrike',
  };
}

function decideImmediate(openSpot, putStrike, callStrike) {
  const nearPut = Number.isFinite(putStrike) && Math.abs(openSpot - putStrike) <= PROX;
  const nearCall = Number.isFinite(callStrike) && Math.abs(openSpot - callStrike) <= PROX;
  if (nearCall && nearPut) {
    const dp = Math.abs(openSpot - putStrike);
    const dc = Math.abs(openSpot - callStrike);
    if (dc <= dp) {
      return { side: 'PE', wall: callStrike, wallType: 'CALL_RESISTANCE', mode: 'open_immediate' };
    }
    return { side: 'CE', wall: putStrike, wallType: 'PUT_SUPPORT', mode: 'open_immediate' };
  }
  if (nearCall) {
    return { side: 'PE', wall: callStrike, wallType: 'CALL_RESISTANCE', mode: 'open_immediate' };
  }
  if (nearPut) {
    return { side: 'CE', wall: putStrike, wallType: 'PUT_SUPPORT', mode: 'open_immediate' };
  }
  return null;
}

function decideLaterTouch(rowsAsc, fromMin, putStrike, callStrike) {
  for (const row of rowsAsc) {
    const m = Number(row.minutes);
    if (!Number.isFinite(m) || m < fromMin || m > ENTRY_TO) continue;
    const spot = Number(row.spot ?? row.spotPrice);
    if (!Number.isFinite(spot)) continue;
    const nearPut = Number.isFinite(putStrike) && Math.abs(spot - putStrike) <= PROX;
    const nearCall = Number.isFinite(callStrike) && Math.abs(spot - callStrike) <= PROX;
    if (!nearPut && !nearCall) continue;
    if (nearCall && (!nearPut || Math.abs(spot - callStrike) <= Math.abs(spot - putStrike))) {
      return {
        side: 'PE',
        wall: callStrike,
        wallType: 'CALL_RESISTANCE',
        mode: 'later_touch',
        entryMinutes: m,
        entrySpot: spot,
      };
    }
    return {
      side: 'CE',
      wall: putStrike,
      wallType: 'PUT_SUPPORT',
      mode: 'later_touch',
      entryMinutes: m,
      entrySpot: spot,
    };
  }
  return null;
}

function simulateTrade(side, entrySpot, entryMinutes, rowsAsc) {
  const checks = {};
  for (const pts of CHECKS) checks[pts] = false;

  let maxFavor = 0;
  let minFavor = 0;
  let exit = null;

  for (const row of rowsAsc) {
    const m = Number(row.minutes);
    if (!Number.isFinite(m) || m < entryMinutes) continue;
    const spot = Number(row.spot ?? row.spotPrice);
    if (!Number.isFinite(spot)) continue;
    const fav = favorMove(side, entrySpot, spot);
    if (fav == null) continue;

    if (fav > maxFavor) maxFavor = fav;
    if (fav < minFavor) minFavor = fav;
    for (const pts of CHECKS) {
      if (!checks[pts] && fav >= pts) checks[pts] = true;
    }

    // Hard +15 target — exit on first hit after entry bar
    if (m > entryMinutes && fav >= TARGET_PTS && !exit) {
      exit = {
        exitMinutes: m,
        exitTime: minsToTime(m),
        exitSpot: spot,
        exitFavor: Number(fav.toFixed(2)),
        result: 'TARGET_HIT',
        pnlPts: TARGET_PTS,
      };
      break;
    }

    // 15:15 day flat if still open
    if (m >= CLOSE_MARK && !exit) {
      exit = {
        exitMinutes: m,
        exitTime: minsToTime(m),
        exitSpot: spot,
        exitFavor: Number(fav.toFixed(2)),
        result: fav >= 0 ? 'DAY_CLOSE_WIN' : 'DAY_CLOSE_LOSS',
        pnlPts: Number(fav.toFixed(2)),
      };
      break;
    }
  }

  if (!exit) {
    const last = [...rowsAsc].reverse().find((r) => Number(r.minutes) >= entryMinutes);
    const spot = Number(last?.spot ?? last?.spotPrice);
    const fav = favorMove(side, entrySpot, spot);
    exit = {
      exitMinutes: Number(last?.minutes),
      exitTime: minsToTime(Number(last?.minutes)),
      exitSpot: spot,
      exitFavor: fav != null ? Number(fav.toFixed(2)) : null,
      result: fav != null && fav >= 0 ? 'EOD_WIN' : 'EOD_LOSS',
      pnlPts: fav != null ? Number(fav.toFixed(2)) : 0,
    };
  }

  return {
    checks,
    maxFavor: Number(maxFavor.toFixed(2)),
    minFavor: Number(minFavor.toFixed(2)),
    holdMins: exit.exitMinutes - entryMinutes,
    ...exit,
  };
}

function runDay(dateKey, rowsAsc, openProp) {
  const openRow = rowsAsc.find((r) => Number(r.minutes) >= OPEN_MIN) || rowsAsc[0];
  if (!openRow) return { dateKey, skip: 'no_rows' };
  const openSpot = Number(openRow.spot ?? openRow.spotPrice);
  const openMinutes = Number(openRow.minutes);
  if (!Number.isFinite(openSpot)) return { dateKey, skip: 'no_open_spot' };

  const walls = openProp?.strikes?.length
    ? pickWallsFromStrikes(openProp.strikes, openSpot)
    : pickWallsFromArchiveRow(openRow, openSpot);
  const putStrike = walls?.putWall?.strike ?? null;
  const callStrike = walls?.callWall?.strike ?? null;

  let decision = decideImmediate(openSpot, putStrike, callStrike);
  let entryMinutes = openMinutes;
  let entrySpot = openSpot;

  if (!decision) {
    const later = decideLaterTouch(rowsAsc, openMinutes + 1, putStrike, callStrike);
    if (later) {
      decision = later;
      entryMinutes = later.entryMinutes;
      entrySpot = later.entrySpot;
    }
  }

  if (!decision) {
    return {
      dateKey,
      openTime: minsToTime(openMinutes),
      openSpot,
      putWall: putStrike,
      callWall: callStrike,
      trade: null,
    };
  }

  const sim = simulateTrade(decision.side, entrySpot, entryMinutes, rowsAsc);

  return {
    dateKey,
    openTime: minsToTime(openMinutes),
    openSpot,
    putWall: putStrike,
    callWall: callStrike,
    wallSource: walls?.source,
    trade: {
      side: decision.side,
      wall: decision.wall,
      wallType: decision.wallType,
      resMark: decision.side === 'PE' ? decision.wall : '—',
      supMark: decision.side === 'CE' ? decision.wall : '—',
      mode: decision.mode,
      entryTime: minsToTime(entryMinutes),
      entryMinutes,
      entrySpot: Number(entrySpot.toFixed(2)),
      ...sim,
    },
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
    let rows = (d.payload?.rows || []).slice().sort((a, b) => a.minutes - b.minutes);
    let openProp = null;
    if (d.dateKey === '2026-09-28') {
      const liveOpen = await live.find({ dateKey: '2026-09-28', minutes: { $gte: 555 } })
        .sort({ minutes: 1 })
        .limit(1)
        .next();
      if (liveOpen?.strikes?.length) openProp = { strikes: liveOpen.strikes };
      const liveRows = await live.find({ dateKey: '2026-09-28' }).sort({ minutes: 1 }).toArray();
      if (liveRows.length) {
        rows = liveRows.map((r) => ({
          minutes: r.minutes,
          time: r.time,
          spot: r.spotPrice ?? r.futPrice,
          atm: r.atm,
          topPutStrike: r.topPutChgStrike,
          topCallStrike: r.topCallChgStrike,
        }));
      }
    }
    results.push(runDay(d.dateKey, rows, openProp));
  }

  const trades = results.filter((r) => r.trade);
  const hits = trades.filter((r) => r.trade.result === 'TARGET_HIT');
  const losses = trades.filter((r) => Number(r.trade.pnlPts) < 0);
  const wins = trades.filter((r) => Number(r.trade.pnlPts) > 0);
  const net = trades.reduce((a, r) => a + Number(r.trade.pnlPts || 0), 0);

  const summary = {
    targetPts: TARGET_PTS,
    days: results.length,
    trades: trades.length,
    noTrade: results.length - trades.length,
    pe: trades.filter((r) => r.trade.side === 'PE').length,
    ce: trades.filter((r) => r.trade.side === 'CE').length,
    targetHits: hits.length,
    targetHitRatePct: trades.length ? Number(((hits.length / trades.length) * 100).toFixed(1)) : 0,
    otherWins: wins.length - hits.length,
    losses: losses.length,
    netPnlPts: Number(net.toFixed(2)),
    avgHoldMinsOnTarget: hits.length
      ? Number((hits.reduce((a, r) => a + r.trade.holdMins, 0) / hits.length).toFixed(1))
      : null,
  };

  const outPath = path.join(__dirname, 'tmp_open_wall_target15.json');
  fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify({ summary, results }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
