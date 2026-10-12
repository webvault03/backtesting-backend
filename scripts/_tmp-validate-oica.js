require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { hydrateDhanTokenFromMongo } = require('../src/services/dhanTokenPersistence');
const { runBacktest } = require('../src/services/oiCandleAgreeBacktest/engine');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await hydrateDhanTokenFromMongo();
  const t0 = Date.now();
  let lastLog = 0;
  const onProgress = (p) => {
    if (Date.now() - lastLog > 15000) {
      lastLog = Date.now();
      console.log('progress', JSON.stringify(p));
    }
  };
  const out = {};
  for (const [key, rule] of [
    ['cap40', { mode: 'candle', capPoints: 40 }],
    ['candle', { mode: 'candle', capPoints: null }],
    ['mid', { mode: 'mid', capPoints: null }],
    ['none', { mode: 'none' }],
  ]) {
    const r = await runBacktest({ from: '2026-01-01', to: '2026-10-09', rule, tapeSource: 'auto', onProgress });
    out[key] = r;
    console.log(`\n== ${key} total ${r.summary.netPnL} trades ${r.summary.trades} W ${r.summary.wins} L ${r.summary.losses} maxDD ${r.summary.maxDrawdown} days ${r.tradingDays} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    console.log(r.summary.months.map((m) => `${m.label} ${m.pnl} (${m.wins}/${m.trades})`).join(' | '));
    if (r.skippedDays.length) console.log('skipped', JSON.stringify(r.skippedDays));
  }
  fs.writeFileSync(path.join(__dirname, 'output', 'oica_fullyear.json'), JSON.stringify(out, null, 1));
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
