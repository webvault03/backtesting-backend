/**
 * Month-by-month HP zone option-% target (avoids one huge Dhan fetch).
 * Usage: node src/scripts/hpZoneOptionPctMonthly.js [year] [pct]
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { hydrateDhanTokenFromMongo } = require('../services/dhanTokenPersistence');
const { runBacktest } = require('../services/hpEntryZoneBacktest/engine');
const { getIstClock } = require('../utils/dateTime');

const r2 = (n) => Number(Number(n).toFixed(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runMonth(from, to, pct) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await runBacktest({
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
      });
    } catch (err) {
      console.warn(`  attempt ${attempt} failed: ${err.message}`);
      if (attempt === 4) throw err;
      await sleep(8000 * attempt);
    }
  }
  return null;
}

async function main() {
  const year = Number(process.argv[2]) || 2026;
  const pct = Number(process.argv[3]) || 30;
  const today = getIstClock(new Date()).dateKey;
  await mongoose.connect(process.env.MONGODB_URI);
  await hydrateDhanTokenFromMongo();

  const months = [];
  for (let m = 1; m <= 12; m += 1) {
    const from = `${year}-${String(m).padStart(2, '0')}-01`;
    if (from > today) break;
    const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
    let to = `${year}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    if (to > today) to = today;
    console.log(`\n=== ${from} → ${to} · +${pct}% ===`);
    const result = await runMonth(from, to, pct);
    const s = result.summary;
    const row = {
      month: from.slice(0, 7),
      trades: s.trades,
      wins: s.wins,
      winRate: s.trades ? r2((s.wins / s.trades) * 100) : 0,
      targetHits: s.exits?.TARGET || 0,
      sl: s.exits?.SL || 0,
      netPnL: s.netPnL,
      green: s.netPnL > 0,
    };
    months.push(row);
    console.log(
      `  trades=${row.trades} WR=${row.winRate}% targets=${row.targetHits} SL=${row.sl} PnL=₹${Math.round(row.netPnL)} ${row.green ? 'GREEN' : 'RED'}`,
    );
    await sleep(3000);
  }

  const trades = months.reduce((a, m) => a + m.trades, 0);
  const wins = months.reduce((a, m) => a + m.wins, 0);
  const targets = months.reduce((a, m) => a + m.targetHits, 0);
  const net = r2(months.reduce((a, m) => a + m.netPnL, 0));
  const report = {
    year,
    pct,
    trades,
    wins,
    winRate: trades ? r2((wins / trades) * 100) : 0,
    targetHitRate: trades ? r2((targets / trades) * 100) : 0,
    netPnL: net,
    greenMonths: months.filter((m) => m.green).length,
    redMonths: months.filter((m) => !m.green).length,
    months,
  };
  console.log('\n==== TOTAL ====');
  console.log(JSON.stringify(report, null, 2));
  const out = path.resolve(__dirname, '..', '..', 'tmp', `hp-zone-option-${pct}pct-${year}-monthly.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
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
