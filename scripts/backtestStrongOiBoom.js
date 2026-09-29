/**
 * Backtest: Strong OI Flow boom pattern (live E/B playbook)
 * CALL = Strong Bull + Spot↑≥5 + Match
 * PUT  = Strong Bear + Spot↓ + Match
 *
 * Uses archived precomputed strength/act/spotDelta (archive has no raw OI totals).
 * 15m closed bars · SL candle±2 clamp 6..12 · TP 1.5R cap +15 · hold 30m
 * Daily +5 / −10 · one open at a time
 *
 * Usage: node scripts/backtestStrongOiBoom.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const {
  STEP,
  riskLevels,
  walkExit,
  round,
  DAILY_TARGET,
  DAILY_LOSS,
  MAX_HOLD,
} = require('../src/utils/oiFlowPlaybook');
const { matchLivePattern, LIVE_STEP } = require('../src/utils/oiFlow5mPatterns');

const FROM = '2026-09-09';
const END = process.env.END_DATE || '2026-09-29';
const SESSION_FROM = 9 * 60 + 15;

function normalizeRows(rows) {
  return (rows || [])
    .map((r) => {
      const spot = Number(r.spotPrice ?? r.spot ?? r.futPrice);
      const strengthLabel =
        typeof r.strength === 'string' ? r.strength : r.strength?.label || null;
      return {
        minutes: Number(r.minutes),
        time: r.time,
        dateKey: r.dateKey,
        symbol: r.symbol || 'NIFTY',
        spot,
        spotPrice: spot,
        atm: r.atm,
        spotDelta: Number(r.spotDelta),
        flowBias: r.flowBias,
        callAct: r.callAct,
        putAct: r.putAct,
        act: r.act,
        oiMigration: r.oiMigration,
        streak: r.streak,
        strengthStreak: r.strengthStreak,
        strength: strengthLabel
          ? {
              label: strengthLabel,
              tone: r.strength?.tone || null,
              score: r.strength?.score ?? null,
            }
          : null,
        fetchOk: r.fetchOk !== false,
      };
    })
    .filter((r) => Number.isFinite(r.minutes) && Number.isFinite(r.spot))
    .sort((a, b) => a.minutes - b.minutes);
}

function isClosedBar(minutes, step = LIVE_STEP) {
  if (!Number.isFinite(minutes) || minutes < SESSION_FROM) return false;
  return (minutes - SESSION_FROM) % step === 0;
}

function attachCandleRange(bars, rawByMin) {
  for (let i = 0; i < bars.length; i += 1) {
    const cur = bars[i];
    const prevMin = i > 0 ? bars[i - 1].minutes : cur.minutes - STEP;
    const spots = [];
    for (let m = prevMin + 1; m <= cur.minutes; m += 1) {
      const s = Number(rawByMin.get(m)?.spot);
      if (Number.isFinite(s)) spots.push(s);
    }
    if (!spots.length && Number.isFinite(Number(cur.spot))) spots.push(Number(cur.spot));
    cur.high = Math.max(...spots);
    cur.low = Math.min(...spots);
    cur.range = round(cur.high - cur.low);
  }
  return bars;
}

/**
 * Prefer archive precomputed fields on closed 15m minutes.
 * Fall back: rebuild via live fields if strength missing (live minute rows).
 */
function buildSignalBars(raw) {
  const rawByMin = new Map(raw.map((r) => [Number(r.minutes), r]));
  const closed = raw.filter((r) => isClosedBar(Number(r.minutes), LIVE_STEP));
  const withStrength = closed.filter((r) => r.strength?.label);
  if (withStrength.length >= 3) {
    const bars = withStrength.map((r, idx) => {
      const prev = idx > 0 ? withStrength[idx - 1] : null;
      // Bar spotDelta = closed 15m move (not the archive's 1m spotDelta)
      const barDelta =
        prev && Number.isFinite(prev.spot) && Number.isFinite(r.spot)
          ? r.spot - prev.spot
          : r.spotDelta;
      return {
        time: r.time,
        minutes: r.minutes,
        dateKey: r.dateKey,
        symbol: r.symbol,
        spot: r.spot,
        spotDelta: barDelta,
        flowBias: r.flowBias,
        callAct: r.callAct,
        putAct: r.putAct,
        act: r.act,
        oiMigration: r.oiMigration,
        streak: r.streak,
        strengthStreak: r.strengthStreak,
        strength: r.strength,
      };
    });
    return attachCandleRange(bars, rawByMin);
  }
  return null;
}

function simulateDay(rawRows) {
  const raw = normalizeRows(rawRows);
  const bars = buildSignalBars(raw);
  if (!bars || !bars.length) {
    return { bars: 0, trades: [], dayPts: 0, dayStopReason: 'no_signal_bars' };
  }

  const trades = [];
  let dayPts = 0;
  let dayStopReason = null;
  let i = 0;

  while (i < bars.length) {
    if (dayStopReason) break;
    const bar = bars[i];
    // Need prior closed bar for 15m spotDelta; skip late entries
    if (i === 0 || Number(bar.minutes) > 14 * 60 + 45) {
      i += 1;
      continue;
    }

    const match = matchLivePattern(bar);
    if (!match) {
      i += 1;
      continue;
    }

    const side = match.side;
    const lv = riskLevels(bar, side);
    const ex = walkExit(raw, bar.minutes, Number(bar.spot), side, lv.stopSpot, lv.targetSpot, MAX_HOLD);
    if (!ex?.exitTime) {
      i += 1;
      continue;
    }

    let pts = Number(ex.favorPts);
    if (ex.exitReason === 'SL') pts = -lv.risk;
    if (ex.exitReason === 'TP') pts = lv.reward;
    pts = round(pts);

    const trade = {
      entryTime: bar.time,
      entryMinutes: bar.minutes,
      exitTime: ex.exitTime,
      exitMinutes: ex.exitMinutes,
      side,
      decision: match.decision,
      patternId: match.patternId,
      patternName: match.patternName,
      shortName: match.shortName,
      strength: bar.strength?.label || null,
      spotDelta: round(bar.spotDelta),
      act: bar.act,
      callAct: bar.callAct,
      putAct: bar.putAct,
      entrySpot: lv.entry,
      exitSpot: Number.isFinite(Number(ex.exitSpot)) ? round(Number(ex.exitSpot), 1) : null,
      riskPts: lv.risk,
      rewardPts: lv.reward,
      stopSpot: lv.stopSpot,
      targetSpot: lv.targetSpot,
      favorPts: pts,
      exitReason: ex.exitReason,
      holdMin: ex.holdMin,
      mae: round(ex.mae),
      mfe: round(ex.mfe),
      dayPtsAfter: null,
    };

    dayPts = round(dayPts + pts);
    trade.dayPtsAfter = dayPts;
    trades.push(trade);

    if (dayPts >= DAILY_TARGET) {
      dayStopReason = `Daily target +${DAILY_TARGET}`;
      trade.dayStopReason = dayStopReason;
    } else if (dayPts <= -Math.abs(DAILY_LOSS)) {
      dayStopReason = `Daily loss −${DAILY_LOSS}`;
      trade.dayStopReason = dayStopReason;
    }

    const exitMin = Number(ex.exitMinutes);
    if (!Number.isFinite(exitMin)) {
      i += 1;
      continue;
    }
    i = bars.findIndex((b) => b.minutes > exitMin);
    if (i < 0) break;
  }

  return { bars: bars.length, trades, dayPts: round(dayPts), dayStopReason };
}

async function loadDayRows(archives, live, dateKey) {
  const liveRows = await live.find({ dateKey }).sort({ minutes: 1 }).toArray();
  if (liveRows.length) {
    // Live rows may lack precomputed strength — still try; engine usually has fields
    return { rows: liveRows, source: 'live' };
  }
  const doc = await archives.findOne({ dateKey });
  return {
    rows: doc?.payload?.rows || [],
    source: doc ? 'archive' : 'none',
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

  const dayReports = [];
  const allTrades = [];

  for (const dateKey of dateKeys) {
    const { rows, source } = await loadDayRows(archives, live, dateKey);
    if (!rows.length) {
      dayReports.push({ dateKey, source, tradeCount: 0, dayPts: 0, stop: 'no_rows', trades: [] });
      continue;
    }
    const sim = simulateDay(rows);
    const trades = (sim.trades || []).map((t) => ({ dateKey, ...t }));
    allTrades.push(...trades);
    dayReports.push({
      dateKey,
      source,
      bars: sim.bars,
      tradeCount: trades.length,
      dayPts: sim.dayPts,
      stop: sim.dayStopReason || '—',
      trades,
    });
  }

  const wins = allTrades.filter((t) => Number(t.favorPts) > 0);
  const losses = allTrades.filter((t) => Number(t.favorPts) < 0);
  const flats = allTrades.filter((t) => Number(t.favorPts) === 0);
  const net = allTrades.reduce((s, t) => s + Number(t.favorPts || 0), 0);
  const calls = allTrades.filter((t) => t.side === 'CALL');
  const puts = allTrades.filter((t) => t.side === 'PUT');
  const tp = allTrades.filter((t) => t.exitReason === 'TP');
  const sl = allTrades.filter((t) => t.exitReason === 'SL');
  const timeEx = allTrades.filter((t) => t.exitReason === 'TIME');

  const summary = {
    strategy: 'Strong OI Boom (E/B playbook)',
    symbol: 'NIFTY',
    pattern: {
      CALL: 'Strong Bull + Spot↑≥5 + Match',
      PUT: 'Strong Bear + Spot↓ + Match',
    },
    rules: {
      bar: '15m closed (archived strength/act)',
      sl: 'candle H/L ±2, risk clamp 6..12 pts',
      tp: '1.5R capped +15 pts',
      maxHold: '30 min',
      dailyStop: `+${DAILY_TARGET} / −${DAILY_LOSS}`,
      pnl: 'spot favor-move pts',
    },
    from: FROM,
    to: END,
    days: dateKeys.length,
    daysWithTrades: dayReports.filter((d) => d.tradeCount > 0).length,
    trades: allTrades.length,
    calls: calls.length,
    puts: puts.length,
    wins: wins.length,
    losses: losses.length,
    flats: flats.length,
    winRatePct: allTrades.length
      ? Number(((wins.length / allTrades.length) * 100).toFixed(1))
      : 0,
    netPnlPts: round(net),
    avgPnlPts: allTrades.length ? round(net / allTrades.length) : 0,
    avgMfe: allTrades.length
      ? round(allTrades.reduce((s, t) => s + Number(t.mfe || 0), 0) / allTrades.length)
      : 0,
    avgMae: allTrades.length
      ? round(allTrades.reduce((s, t) => s + Number(t.mae || 0), 0) / allTrades.length)
      : 0,
    exits: { TP: tp.length, SL: sl.length, TIME: timeEx.length },
    callNet: round(calls.reduce((s, t) => s + Number(t.favorPts || 0), 0)),
    putNet: round(puts.reduce((s, t) => s + Number(t.favorPts || 0), 0)),
  };

  const tradeTable = allTrades.map((t, i) => ({
    n: i + 1,
    date: t.dateKey,
    side: t.side,
    pattern: t.shortName,
    strength: t.strength,
    act: t.act,
    ce: t.callAct,
    pe: t.putAct,
    spotDelta: t.spotDelta,
    entry: `${t.entryTime} @ ${t.entrySpot}`,
    exit: `${t.exitTime} (${t.exitReason}) @ ${t.exitSpot}`,
    holdMin: t.holdMin,
    risk: t.riskPts,
    reward: t.rewardPts,
    mfe: t.mfe,
    mae: t.mae,
    pnlPts: t.favorPts,
    dayPtsAfter: t.dayPtsAfter,
  }));

  const dayTable = dayReports.map((d) => ({
    date: d.dateKey,
    src: d.source,
    bars: d.bars || 0,
    trades: d.tradeCount,
    dayPts: d.dayPts,
    stop: d.stop,
    detail:
      (d.trades || [])
        .map((t) => `${t.side} ${t.favorPts >= 0 ? '+' : ''}${t.favorPts}`)
        .join(', ') || '—',
  }));

  const outPath = path.join(__dirname, 'tmp_strong_oi_boom_report.json');
  fs.writeFileSync(outPath, JSON.stringify({ summary, dayTable, trades: tradeTable }, null, 2));

  console.log('\n========== STRONG OI BOOM · NIFTY ==========\n');
  console.log(`Range: ${FROM} → ${END}`);
  console.log('CALL: Strong Bull + Spot↑≥5 + Match');
  console.log('PUT:  Strong Bear + Spot↓ + Match');
  console.log(`Bars: 15m · SL 6–12 · TP 1.5R cap +15 · hold ${MAX_HOLD}m · day +${DAILY_TARGET}/−${DAILY_LOSS}\n`);

  console.log('--- SUMMARY ---');
  console.log(`Days: ${summary.days} | With trades: ${summary.daysWithTrades}`);
  console.log(`Trades: ${summary.trades} (CALL ${summary.calls} / PUT ${summary.puts})`);
  console.log(`W/L/F: ${summary.wins}/${summary.losses}/${summary.flats} · win ${summary.winRatePct}%`);
  console.log(`Net P/L: ${summary.netPnlPts} pts · Avg/trade: ${summary.avgPnlPts}`);
  console.log(`Avg MFE: ${summary.avgMfe} · Avg MAE: ${summary.avgMae}`);
  console.log(`Exits: TP ${summary.exits.TP} · SL ${summary.exits.SL} · TIME ${summary.exits.TIME}`);
  console.log(`CALL net: ${summary.callNet} · PUT net: ${summary.putNet}\n`);

  console.log('--- DAY TABLE ---');
  console.log('Date       N  DayPts  Detail');
  for (const d of dayTable) {
    console.log(
      `${d.date}  ${String(d.trades).padStart(2)}  ${String(d.dayPts).padStart(6)}  ${d.detail}${
        d.stop && d.stop !== '—' ? ' | ' + d.stop : ''
      }`
    );
  }

  console.log('\n--- TRADE LOG ---');
  console.log(
    'N  Date       Side  Pattern        Entry              Exit                         Hold Risk Rew  MFE  MAE   P/L'
  );
  for (const t of tradeTable) {
    console.log(
      [
        String(t.n).padStart(2),
        t.date,
        t.side.padEnd(4),
        String(t.pattern || '').padEnd(13),
        String(t.entry).padEnd(18),
        String(t.exit).padEnd(28),
        String(t.holdMin).padStart(4),
        String(t.risk).padStart(4),
        String(t.reward).padStart(4),
        String(t.mfe).padStart(5),
        String(t.mae).padStart(5),
        String(t.pnlPts).padStart(5),
      ].join(' ')
    );
  }

  console.log(`\nJSON: ${outPath}\n`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
