/**
 * NIFTY-only report for Pine "High Probability Entry Zone PRO (SL/TP + Stats)".
 * Exact rules: FVG+ATR + strong body + BOS-in-pattern + EMA200 + session 0920–1500 ·
 * Structure SL · TP1 1R / TP2 2R · 50/50 scale · SL-before-target same bar · overnight OK.
 * No options — P/L from NIFTY points × lotSize × lots.
 *
 * Usage: node src/scripts/hpProNiftyReport.js [tf=15] [lots=10]
 * Writes tmp/hp-pro-nifty-*.{json,csv,md}
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
const SESS_FROM = 9 * 60 + 20;
const SESS_TO = 15 * 60; // exclusive end 15:00
const LOT_SIZE = 65;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const RULE = {
  leftBars: 5,
  rightBars: 5,
  bodyPct: 0.6,
  fvgMinAtr: 0.1,
  useTrend: true,
  emaLen: 200,
  useVol: false,
  atrLen: 14,
  slBufAtr: 0.1,
  maxRiskAtr: 3,
  rr1: 1,
  rr2: 2,
};

const r2 = (n) => Number(Number(n).toFixed(2));
const r4 = (n) => Number(Number(n).toFixed(4));
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const span = (c) => `${hhmm(c.start)}–${hhmm(c.end + 1)}`;

function istMinutes(iso) {
  const d = new Date(iso);
  const ist = new Date(d.getTime() + 330 * 60000);
  return {
    dateKey: ist.toISOString().slice(0, 10),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

function buildCandles(rows, tf) {
  const out = [];
  let cur = null;
  for (const row of rows) {
    const { dateKey, minutes: m } = istMinutes(row[0]);
    if (m < OPEN || m > LAST) continue;
    const start = OPEN + Math.floor((m - OPEN) / tf) * tf;
    if (!cur || cur.dateKey !== dateKey || cur.start !== start) {
      cur = { dateKey, start, end: Math.min(start + tf - 1, LAST), o: row[1], h: row[2], l: row[3], c: row[4] };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, row[2]);
      cur.l = Math.min(cur.l, row[3]);
      cur.c = row[4];
    }
  }
  return out;
}

/** Wilder ATR (ta.atr) + EMA + pivots + exact Pine PRO signals. */
function annotatePro(candles) {
  const {
    leftBars,
    rightBars,
    bodyPct,
    fvgMinAtr,
    useTrend,
    emaLen,
    atrLen,
    slBufAtr,
    maxRiskAtr,
  } = RULE;

  let lastPh = null;
  let lastPl = null;
  let atr = null;
  let ema = null;
  let atrSeed = 0;
  let atrCount = 0;
  let emaSeed = 0;
  let emaCount = 0;
  const alpha = 2 / (emaLen + 1);

  return candles.map((c, i) => {
    const out = {
      ...c,
      atr: null,
      ema: null,
      signal: 0,
      lastPh,
      lastPl,
      longSl: null,
      shortSl: null,
      longRisk: null,
      shortRisk: null,
    };

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

    const prevC = i > 0 ? candles[i - 1].c : c.c;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - prevC), Math.abs(c.l - prevC));
    if (atrCount < atrLen) {
      atrSeed += tr;
      atrCount += 1;
      if (atrCount === atrLen) atr = atrSeed / atrLen;
    } else if (atr != null) {
      atr = (atr * (atrLen - 1) + tr) / atrLen;
    }
    out.atr = atr == null ? null : r4(atr);

    if (emaCount < emaLen) {
      emaSeed += c.c;
      emaCount += 1;
      if (emaCount === emaLen) ema = emaSeed / emaLen;
    } else if (ema != null) {
      ema = alpha * c.c + (1 - alpha) * ema;
    }
    out.ema = ema == null ? null : r2(ema);

    if (i < 2 || atr == null) return out;

    const prev = candles[i - 1];
    const older = candles[i - 2];
    const prevRange = prev.h - prev.l;
    const strongBody1 = prevRange > 0 && Math.abs(prev.c - prev.o) > prevRange * bodyPct;

    const gapUp = c.l - older.h;
    const gapDn = older.l - c.h;
    const bullFvg = gapUp > 0 && prev.c > prev.o && gapUp >= fvgMinAtr * atr;
    const bearFvg = gapDn > 0 && prev.c < prev.o && gapDn >= fvgMinAtr * atr;

    const bosUp = lastPh != null && c.c > lastPh && older.c <= lastPh;
    const bosDn = lastPl != null && c.c < lastPl && older.c >= lastPl;

    const trendUp = !useTrend || (ema != null && c.c > ema);
    const trendDn = !useTrend || (ema != null && c.c < ema);
    const inSess = c.start >= SESS_FROM && c.start < SESS_TO;

    const buf = slBufAtr * atr;
    const longSl = Math.min(prev.l, older.l) - buf;
    const shortSl = Math.max(prev.h, older.h) + buf;
    const longRisk = c.c - longSl;
    const shortRisk = shortSl - c.c;
    out.longSl = r2(longSl);
    out.shortSl = r2(shortSl);
    out.longRisk = r2(longRisk);
    out.shortRisk = r2(shortRisk);

    const riskOkL = longRisk > 0 && longRisk <= maxRiskAtr * atr;
    const riskOkS = shortRisk > 0 && shortRisk <= maxRiskAtr * atr;

    const buy = bullFvg && strongBody1 && bosUp && trendUp && inSess && riskOkL;
    const sell = bearFvg && strongBody1 && bosDn && trendDn && inSess && riskOkS;
    if (buy && !sell) out.signal = 1;
    else if (sell) out.signal = -1;
    return out;
  });
}

/**
 * Walk candles with one position at a time (tradeDir). Pine wick SL/TP · SL first same bar.
 * 50% scale at TP1, remainder at TP2 / BE / SL.
 */
function simulate(candles, { lots, pointValue }) {
  const { rr1, rr2 } = RULE;
  const trades = [];
  let pos = null;

  const closeTrade = (exitIdx, exitType, note) => {
    const c = candles[exitIdx];
    const pts = r2(pos.pointsAcc);
    const rMult = r2(pos.rAcc);
    const pnl = r2(pts * pointValue);
    trades.push({
      id: `${pos.entryDate}-${hhmm(pos.entryStart)}-${pos.side}`,
      date: pos.entryDate,
      exitDate: c.dateKey,
      side: pos.side,
      signalTime: span(pos.sc),
      entryTime: hhmm(pos.entryStart),
      exitTime: hhmm(c.start),
      entry: pos.entry,
      stopInit: pos.stopInit,
      tp1: pos.tp1,
      tp2: pos.tp2,
      riskPts: pos.risk,
      exit: r2(pos.lastExitPx),
      exitType,
      note,
      tp1Hit: pos.tp1Hit,
      holdBars: exitIdx - pos.entryIdx,
      holdDays: pos.holdDays,
      pts,
      rMult,
      pnl,
      isWin: pts > 0,
      isBe: exitType === 'BE',
      monthKey: pos.entryDate.slice(0, 7),
    });
    pos = null;
  };

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];

    if (pos && i > pos.entryIdx) {
      if (c.dateKey !== pos.lastDate) {
        pos.holdDays += 1;
        pos.lastDate = c.dateKey;
      }

      const long = pos.side === 'BUY';
      const slHit = long ? c.l <= pos.curSl : c.h >= pos.curSl;
      const t1Hit = long ? c.h >= pos.tp1 : c.l <= pos.tp1;
      const t2Hit = long ? c.h >= pos.tp2 : c.l <= pos.tp2;

      // Pine: SL first if both on same bar
      if (slHit) {
        if (pos.tp1Hit) {
          // BE exit on remaining 50%
          const bePx = pos.entry;
          pos.pointsAcc += 0; // remaining flat vs entry
          pos.lastExitPx = bePx;
          closeTrade(i, 'BE', 'SL at breakeven after TP1');
        } else {
          const exitPx = pos.curSl;
          const signed = long ? exitPx - pos.entry : pos.entry - exitPx;
          pos.pointsAcc += signed; // full size
          pos.rAcc -= 1;
          pos.lastExitPx = exitPx;
          closeTrade(i, 'SL', 'SL before TP1 (−1R)');
        }
        // fall through — may open new signal same bar? Pine: done then tradeDir=0, new sig needs confirmed bar so same bar won't re-enter
      } else {
        if (!pos.tp1Hit && t1Hit) {
          pos.tp1Hit = true;
          const exitPx = pos.tp1;
          const signed = long ? exitPx - pos.entry : pos.entry - exitPx;
          pos.pointsAcc += 0.5 * signed;
          pos.rAcc += 0.5 * rr1;
          pos.curSl = pos.entry;
          pos.lastExitPx = exitPx;
        }
        if (pos.tp1Hit && t2Hit) {
          const exitPx = pos.tp2;
          const signed = long ? exitPx - pos.entry : pos.entry - exitPx;
          pos.pointsAcc += 0.5 * signed;
          pos.rAcc += 0.5 * rr2;
          pos.lastExitPx = exitPx;
          closeTrade(i, 'TP2', 'TP1 then TP2');
        }
      }
    }

    // New entry only when flat (Pine tradeDir == 0)
    if (!pos && c.signal) {
      const long = c.signal > 0;
      const entry = c.c;
      const stop = long ? c.longSl : c.shortSl;
      const risk = long ? c.longRisk : c.shortRisk;
      if (!(risk > 0)) continue;
      pos = {
        sc: c,
        side: long ? 'BUY' : 'SELL',
        entryIdx: i,
        entryDate: c.dateKey,
        entryStart: c.start,
        entry,
        stopInit: stop,
        curSl: stop,
        risk,
        tp1: long ? entry + risk * rr1 : entry - risk * rr1,
        tp2: long ? entry + risk * rr2 : entry - risk * rr2,
        tp1Hit: false,
        pointsAcc: 0,
        rAcc: 0,
        lastExitPx: entry,
        holdDays: 1,
        lastDate: c.dateKey,
      };
    }
  }

  if (pos) {
    const last = candles[candles.length - 1];
    const long = pos.side === 'BUY';
    const px = last.c;
    if (pos.tp1Hit) {
      const signed = long ? px - pos.entry : pos.entry - px;
      pos.pointsAcc += 0.5 * signed;
    } else {
      const signed = long ? px - pos.entry : pos.entry - px;
      pos.pointsAcc += signed;
    }
    pos.lastExitPx = px;
    closeTrade(candles.length - 1, 'OPEN', 'Range end — marked at last close');
  }

  return trades;
}

function monthSummary(trades, pointValue) {
  const map = {};
  for (const t of trades) {
    if (!map[t.monthKey]) {
      map[t.monthKey] = {
        month: t.monthKey,
        label: `${MONTHS[Number(t.monthKey.slice(5, 7)) - 1]} ${t.monthKey.slice(0, 4)}`,
        trades: 0,
        wins: 0,
        losses: 0,
        be: 0,
        tp2: 0,
        pts: 0,
        r: 0,
        pnl: 0,
      };
    }
    const m = map[t.monthKey];
    m.trades += 1;
    if (t.isWin) m.wins += 1;
    else if (t.isBe) m.be += 1;
    else m.losses += 1;
    if (t.exitType === 'TP2') m.tp2 += 1;
    m.pts = r2(m.pts + t.pts);
    m.r = r2(m.r + t.rMult);
    m.pnl = r2(m.pnl + t.pnl);
  }
  return Object.values(map)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      ...m,
      winRate: m.trades ? r2((m.wins / m.trades) * 100) : 0,
      green: m.pnl > 0,
      pointValue,
    }));
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function loadCandles(tf, fromYear, toYear) {
  const all = [];
  for (let y = fromYear - 1; y <= toYear; y += 1) {
    process.stdout.write(`  NIFTY ${tf}m ${y}… `);
    try {
      const payload = await getCandlesWithCache({ symbol: 'NIFTY', interval: String(tf), year: y, refresh: false });
      const built = buildCandles(payload.rows || [], tf);
      console.log(`${built.length} bars`);
      all.push(...built);
    } catch (err) {
      console.log(`skip (${err.message})`);
    }
  }
  // Dedupe by dateKey+start
  const seen = new Set();
  const out = [];
  for (const c of all.sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.start - b.start)) {
    const k = `${c.dateKey}-${c.start}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

async function main() {
  const tf = Number(process.argv[2]) === 5 ? 5 : 15;
  const lots = Math.max(1, Math.round(Number(process.argv[3]) || 10));
  const pointValue = LOT_SIZE * lots; // ₹ per NIFTY point
  const today = getIstClock(new Date()).dateKey;
  const fromYear = 2021;
  const toYear = Number(today.slice(0, 4));

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);
  await hydrateDhanTokenFromMongo();

  console.log(`\nHP PRO · NIFTY-only · ${tf}m · ${lots} lots (₹${pointValue}/pt) · ${fromYear} → ${today}`);
  console.log('Rules: exact Pine PRO (Structure SL · TP1 1R · TP2 2R · EMA200 · session 0920–1500 · overnight)\n');

  const raw = await loadCandles(tf, fromYear, toYear);
  const annotated = annotatePro(raw);
  const simBars = annotated.filter((c) => c.dateKey >= `${fromYear}-01-01` && c.dateKey <= today);
  // Keep warmup bars for EMA/ATR/pivots by simulating from full annotated but only counting trades with entry >= fromYear
  const allTrades = simulate(annotated, { lots, pointValue });
  const trades = allTrades.filter((t) => t.date >= `${fromYear}-01-01` && t.date <= today);

  const months = monthSummary(trades, pointValue);
  const greenMonths = months.filter((m) => m.green);
  const redMonths = months.filter((m) => !m.green);
  const wins = trades.filter((t) => t.isWin);
  const losses = trades.filter((t) => !t.isWin && !t.isBe);
  const bes = trades.filter((t) => t.isBe);
  const totalPts = r2(trades.reduce((s, t) => s + t.pts, 0));
  const totalR = r2(trades.reduce((s, t) => s + t.rMult, 0));
  const totalPnl = r2(trades.reduce((s, t) => s + t.pnl, 0));
  const byExit = {};
  for (const t of trades) byExit[t.exitType] = (byExit[t.exitType] || 0) + 1;

  const report = {
    title: 'HP Entry Zone PRO — NIFTY-only (no options)',
    asOf: today,
    timeframe: tf,
    from: `${fromYear}-01-01`,
    to: today,
    lots,
    lotSize: LOT_SIZE,
    pointValue,
    pine: { ...RULE, session: '0920-1500 Asia/Kolkata', slMode: 'Structure', useVol: false },
    definition: {
      entry: 'Signal bar close (confirmed)',
      signal: 'bull/bear FVG (≥0.1×ATR) + strong body[1] + BOS inside pattern + EMA200 + session',
      stop: 'Structure min(low[1],low[2])−buf / max(high[1],high[2])+buf · wick touch · SL before target same bar',
      targets: 'TP1 1R (50%) → SL to BE · TP2 2R (50%)',
      overnight: 'yes — no day close',
      pnl: `NIFTY points × ${LOT_SIZE} × ${lots} lots`,
    },
    summary: {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      beExits: bes.length,
      winRate: trades.length ? r2((wins.length / trades.length) * 100) : 0,
      totalPts,
      totalR,
      totalPnl,
      byExit,
      greenMonths: greenMonths.length,
      redMonths: redMonths.length,
      bestMonth: months.reduce((a, b) => (a && a.pnl >= b.pnl ? a : b), null),
      worstMonth: months.reduce((a, b) => (a && a.pnl <= b.pnl ? a : b), null),
    },
    months,
    simBars: simBars.length,
  };

  const outDir = path.resolve(__dirname, '..', '..', 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = `${fromYear}-${today.replace(/-/g, '')}-${tf}m`;
  const jsonFile = path.join(outDir, `hp-pro-nifty-${stamp}.json`);
  const csvFile = path.join(outDir, `hp-pro-nifty-trades-${stamp}.csv`);
  const monthCsv = path.join(outDir, `hp-pro-nifty-months-${stamp}.csv`);
  const mdFile = path.join(outDir, `hp-pro-nifty-report-${stamp}.md`);

  fs.writeFileSync(jsonFile, JSON.stringify({ report, trades }, null, 2));

  const tradeHeaders = [
    'Date', 'Exit date', 'Side', 'Zone', 'Entry', 'SL init', 'TP1', 'TP2', 'Risk pts',
    'Exit', 'Exit type', 'TP1 hit', 'Hold days', 'NIFTY pts', 'R', 'P/L ₹', 'Note',
  ];
  const tradeLines = [
    tradeHeaders.join(','),
    ...trades.map((t) =>
      [
        t.date, t.exitDate, t.side, t.signalTime, t.entry, t.stopInit, t.tp1, t.tp2, t.riskPts,
        t.exit, t.exitType, t.tp1Hit ? 'Y' : 'N', t.holdDays, t.pts, t.rMult, t.pnl, t.note,
      ].map(csvEscape).join(','),
    ),
  ];
  fs.writeFileSync(csvFile, '\uFEFF' + tradeLines.join('\n'));

  const monthHeaders = ['Month', 'Trades', 'Wins', 'Losses', 'BE', 'TP2', 'Win%', 'NIFTY pts', 'Total R', 'P/L ₹', 'Colour'];
  const monthLines = [
    monthHeaders.join(','),
    ...months.map((m) =>
      [m.label, m.trades, m.wins, m.losses, m.be, m.tp2, m.winRate, m.pts, m.r, m.pnl, m.green ? 'GREEN' : 'RED']
        .map(csvEscape)
        .join(','),
    ),
  ];
  fs.writeFileSync(monthCsv, '\uFEFF' + monthLines.join('\n'));

  const md = [
    `# ${report.title}`,
    '',
    `- Period: **${report.from} → ${report.to}** · TF **${tf}m** · **${lots} lots** (₹${pointValue}/pt)`,
    `- Trades: **${report.summary.trades}** · Wins **${report.summary.wins}** · Losses **${report.summary.losses}** · BE **${report.summary.beExits}** · WR **${report.summary.winRate}%**`,
    `- Total R: **${report.summary.totalR}R** · NIFTY pts **${report.summary.totalPts}** · P/L **₹${report.summary.totalPnl.toLocaleString('en-IN')}**`,
    `- Green months: **${report.summary.greenMonths}** · Red months: **${report.summary.redMonths}**`,
    `- Exits: ${JSON.stringify(report.summary.byExit)}`,
    '',
    '## Monthly',
    '',
    '| Month | Trades | WR% | Pts | R | P/L ₹ | |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...months.map(
      (m) =>
        `| ${m.label} | ${m.trades} | ${m.winRate} | ${m.pts} | ${m.r} | ${m.pnl.toLocaleString('en-IN')} | ${m.green ? '🟢' : '🔴'} |`,
    ),
    '',
    `_No options — entry/SL/TP on NIFTY TF candles only. Pine PRO Structure SL · TP1/TP2 50/50._`,
  ].join('\n');
  fs.writeFileSync(mdFile, md);

  console.log('\n========== SUMMARY ==========');
  console.log(`Trades ${report.summary.trades} · WR ${report.summary.winRate}% · Total R ${report.summary.totalR} · Pts ${report.summary.totalPts} · P/L ₹${report.summary.totalPnl.toLocaleString('en-IN')}`);
  console.log(`Green months ${report.summary.greenMonths} / ${months.length} · Red ${report.summary.redMonths}`);
  console.log('\nMonth                  Trades  WR%     Pts       R         P/L ₹');
  for (const m of months) {
    const flag = m.green ? 'G' : 'R';
    console.log(
      `${m.label.padEnd(20)} ${String(m.trades).padStart(6)} ${String(m.winRate).padStart(6)} ${String(m.pts).padStart(8)} ${String(m.r).padStart(8)} ${String(m.pnl).padStart(12)}  ${flag}`,
    );
  }
  console.log(`\nWrote:\n  ${mdFile}\n  ${monthCsv}\n  ${csvFile}\n  ${jsonFile}`);

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
