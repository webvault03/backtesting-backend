/**
 * HP Entry Zone — option % of invested target report (real option fills).
 * Usage: node src/scripts/hpZoneOptionPctReport.js [from] [to] [pct]
 * Default: 2026-01-01 → today, 30%
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { hydrateDhanTokenFromMongo } = require('../services/dhanTokenPersistence');
const { runBacktest } = require('../services/hpEntryZoneBacktest/engine');
const { getIstClock } = require('../utils/dateTime');

const r2 = (n) => Number(Number(n).toFixed(2));
const fmtRs = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

async function main() {
  const from = process.argv[2] || '2026-01-01';
  const to = process.argv[3] || getIstClock(new Date()).dateKey;
  const pct = Number(process.argv[4]) || 30;

  await mongoose.connect(process.env.MONGODB_URI);
  await hydrateDhanTokenFromMongo();

  console.log(`Running HP zone ${from}→${to} · option +${pct}% of entry · 15m · overnight…`);
  const result = await runBacktest({
    from,
    to,
    lots: 10,
    rule: {
      timeframe: 15,
      targetMode: 'optionPct',
      optionTargetPct: pct,
      maxHoldDays: 5,
      maxCandlePts: 120,
    },
    onProgress: (p) => {
      if (p?.phase === 'fetch' && p.done != null) {
        process.stdout.write(`\r fetch ${p.done}/${p.total || '?'}   `);
      } else if (p?.phase === 'simulate' && p.dateKey) {
        process.stdout.write(`\r sim ${p.dateKey} (${p.done}/${p.total})   `);
      }
    },
  });
  process.stdout.write('\n');

  const s = result.summary;
  const months = (s.months || []).map((m) => ({
    month: m.key,
    trades: m.trades,
    wins: m.wins,
    winRate: m.trades ? r2((m.wins / m.trades) * 100) : 0,
    pnl: m.pnl,
    green: m.pnl > 0,
  }));
  const greenMonths = months.filter((m) => m.green).length;
  const byExit = s.exits || {};
  const targetHits = byExit.TARGET || 0;
  const report = {
    from,
    to,
    target: `option +${pct}% of invested (entry premium)`,
    timeframe: 15,
    lots: result.lots,
    trades: s.trades,
    wins: s.wins,
    losses: s.losses,
    winRate: s.trades ? r2((s.wins / s.trades) * 100) : 0,
    targetHitRate: s.trades ? r2((targetHits / s.trades) * 100) : 0,
    byExit,
    netPnL: s.netPnL,
    charges: s.charges,
    profitFactor: s.profitFactor,
    maxDrawdown: s.maxDrawdown,
    greenMonths,
    redMonths: months.length - greenMonths,
    months,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log('\nMonthly:');
  for (const m of months) {
    console.log(`  ${m.month}  trades=${m.trades}  WR=${m.winRate}%  PnL=${fmtRs(m.pnl)}  ${m.green ? 'GREEN' : 'RED'}`);
  }
  console.log(`\nNet ${fmtRs(report.netPnL)} · WR ${report.winRate}% · target hits ${report.targetHitRate}% · green months ${greenMonths}/${months.length}`);

  const out = path.resolve(__dirname, '..', '..', 'tmp', `hp-zone-option-${pct}pct-${from}_${to}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ report, trades: result.trades }, null, 2));
  console.log(`Wrote ${out}`);

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
