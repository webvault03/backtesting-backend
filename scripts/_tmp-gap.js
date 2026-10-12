require('dotenv').config();
const mongoose = require('mongoose');
const { hydrateDhanTokenFromMongo } = require('../src/services/dhanTokenPersistence');
const { runBacktest } = require('../src/services/gappingPlayBacktest/engine');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await hydrateDhanTokenFromMongo();
  const [from, to] = process.argv.slice(2);
  const t0 = Date.now();
  const r = await runBacktest({ from, to, lots: 1 });
  console.log(`took ${((Date.now() - t0) / 1000).toFixed(0)}s, ${r.tradingDays} days, ${r.signals} signals`);
  for (const t of r.trades) {
    console.log(t.date, t.direction, `impulse ${t.impulse.from}→${t.impulse.to} ${t.impulse.pct}%`, `rest ${t.rest.days}d ${t.rest.low}-${t.rest.high} (${t.rest.pct}%)`, `open ${t.dayOpen} gap ${t.gapPts}`, '→', t.strike, t.side, t.entryPremium, '→', t.exitTime, t.exitPremium, t.exitType, t.netPnL);
  }
  const { months, ...s } = r.summary;
  console.log(s, 'skipped', r.skippedDays);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
