/**
 * Open OI Walls ladder backtest (matches live strategy-16).
 * Entry: 09:15 walls (absolute OI when available) · prox ±25 · Put→CE / Call→PE
 * Window: 09:15–10:45 · one trade/day
 * Ladder (record only, spot-pt proxy for option pts): +5 / +10 / +15 / +20 / +30
 * Exit: only day close 15:15 (or last bar) — targets never close the trade
 *
 * Usage: node scripts/backtestOpenWallLadder.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const OPEN_MIN = 555; // 09:15
const ENTRY_TO = 645; // 10:45
const CLOSE_MARK = 915; // 15:15
const PROX = 25;
const LADDER = [5, 10, 15, 20, 30];
const FROM_DATE = '2026-09-09';
/** Inclusive — today IST (override with END_DATE env if needed). */
const END_DATE = process.env.END_DATE || '2026-09-29';

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
    const spot = Number(row.spot ?? row.spotPrice);
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

    // Exit only at day close — never on ladder hits
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
    const spot = Number(last?.spot ?? last?.spotPrice);
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
  const highestHit = hitList.length ? hitList[hitList.length - 1] : 0;

  return {
    ladder: hits,
    hitCounts: Object.fromEntries(LADDER.map((p) => [p, hits[p].status === 'HIT'])),
    highestHit,
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
      wallSource: walls?.source,
      trade: null,
    };
  }

  const sim = simulateLadder(decision.side, entrySpot, entryMinutes, rowsAsc);

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
      mode: decision.mode,
      entryTime: minsToTime(entryMinutes),
      entryMinutes,
      entrySpot: Number(entrySpot.toFixed(2)),
      ...sim,
    },
  };
}

async function loadDayRows(archives, live, dateKey) {
  const doc = await archives.findOne({ dateKey });
  let rows = (doc?.payload?.rows || []).slice().sort((a, b) => a.minutes - b.minutes);
  let openProp = null;

  const liveOpen = await live
    .find({ dateKey, minutes: { $gte: OPEN_MIN } })
    .sort({ minutes: 1 })
    .limit(1)
    .next();
  if (liveOpen?.strikes?.length) openProp = { strikes: liveOpen.strikes };

  const liveRows = await live.find({ dateKey }).sort({ minutes: 1 }).toArray();
  if (liveRows.length) {
    rows = liveRows.map((r) => ({
      minutes: r.minutes,
      time: r.time,
      spot: r.spotPrice ?? r.futPrice,
      atm: r.atm,
      topPutStrike: r.topPutChgStrike ?? r.topPutStrike,
      topCallStrike: r.topCallChgStrike ?? r.topCallStrike,
    }));
  }

  return { rows, openProp, hasArchive: Boolean(doc), hasLive: liveRows.length > 0 };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);

  const archives = mongoose.connection.db.collection('oiflowdayarchives');
  const live = mongoose.connection.db.collection('oiflowminuterows');

  const archiveKeys = await archives
    .distinct('dateKey', { dateKey: { $gte: FROM_DATE, $lte: END_DATE } });
  const liveKeys = await live
    .distinct('dateKey', { dateKey: { $gte: FROM_DATE, $lte: END_DATE } });
  const dateKeys = [...new Set([...archiveKeys, ...liveKeys])].sort();

  const results = [];
  for (const dateKey of dateKeys) {
    const { rows, openProp, hasArchive, hasLive } = await loadDayRows(archives, live, dateKey);
    if (!rows.length) {
      results.push({ dateKey, skip: 'no_rows', hasArchive, hasLive });
      continue;
    }
    const day = runDay(dateKey, rows, openProp);
    day.hasArchive = hasArchive;
    day.hasLive = hasLive;
    day.dataSource = openProp?.strikes?.length
      ? 'live_strikes+rows'
      : hasLive
        ? 'live_rows'
        : 'archive';
    results.push(day);
  }

  const trades = results.filter((r) => r.trade);
  const noTrade = results.filter((r) => !r.trade && !r.skip);
  const skipped = results.filter((r) => r.skip);

  const ladderHitRates = {};
  for (const pts of LADDER) {
    const n = trades.filter((r) => r.trade.hitCounts[pts]).length;
    ladderHitRates[pts] = {
      hits: n,
      ratePct: trades.length ? Number(((n / trades.length) * 100).toFixed(1)) : 0,
    };
  }

  const net = trades.reduce((a, r) => a + Number(r.trade.pnlPts || 0), 0);
  const wins = trades.filter((r) => Number(r.trade.pnlPts) > 0);
  const losses = trades.filter((r) => Number(r.trade.pnlPts) < 0);
  const flats = trades.filter((r) => Number(r.trade.pnlPts) === 0);

  const table = results.map((r) => {
    if (r.skip) {
      return {
        date: r.dateKey,
        trade: 'SKIP',
        note: r.skip,
      };
    }
    if (!r.trade) {
      return {
        date: r.dateKey,
        open: r.openSpot,
        put: r.putWall,
        call: r.callWall,
        trade: 'NO_ENTRY',
        side: '—',
        wall: '—',
        entry: '—',
        t5: '—',
        t10: '—',
        t15: '—',
        t20: '—',
        t30: '—',
        highest: '—',
        exit: '—',
        pnlPts: '—',
        src: r.dataSource || r.wallSource,
      };
    }
    const t = r.trade;
    const mark = (pts) => (t.hitCounts[pts] ? `HIT@${t.ladder[pts].hitAt}` : 'MISS');
    return {
      date: r.dateKey,
      open: Number(r.openSpot?.toFixed?.(1) ?? r.openSpot),
      put: r.putWall,
      call: r.callWall,
      trade: 'YES',
      side: t.side,
      wall: t.wall,
      mode: t.mode,
      entry: `${t.entryTime} @ ${t.entrySpot}`,
      t5: mark(5),
      t10: mark(10),
      t15: mark(15),
      t20: mark(20),
      t30: mark(30),
      highest: t.highestHit ? `+${t.highestHit}` : 'none',
      exit: `${t.exitTime} (${t.result})`,
      pnlPts: t.pnlPts,
      maxFav: t.maxFavor,
      minFav: t.minFavor,
      holdMin: t.holdMins,
      src: r.dataSource || r.wallSource,
    };
  });

  const summary = {
    strategy: 'Open OI Walls ladder',
    from: FROM_DATE,
    to: END_DATE,
    prox: PROX,
    entryWindow: '09:15–10:45',
    exit: '15:15 day close only',
    ladder: LADDER,
    note: 'pnlPts = spot favor move at exit (proxy for option pts at ATM ~delta 1)',
    days: results.length,
    trades: trades.length,
    noEntry: noTrade.length,
    skipped: skipped.length,
    pe: trades.filter((r) => r.trade.side === 'PE').length,
    ce: trades.filter((r) => r.trade.side === 'CE').length,
    dayCloseWins: wins.length,
    dayCloseLosses: losses.length,
    dayCloseFlat: flats.length,
    netPnlPts: Number(net.toFixed(2)),
    avgPnlPts: trades.length ? Number((net / trades.length).toFixed(2)) : 0,
    ladderHitRates,
  };

  const outPath = path.join(__dirname, 'tmp_open_wall_ladder.json');
  fs.writeFileSync(outPath, JSON.stringify({ summary, table, results }, null, 2));
  console.log(JSON.stringify({ summary, table }, null, 2));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
