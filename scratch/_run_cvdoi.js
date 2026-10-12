require('dotenv').config();
const mongoose = require('mongoose');
const { hydrateDhanTokenFromMongo } = require('../src/services/dhanTokenPersistence');
const { runBacktest } = require('../src/services/cvdOiBacktest/engine');
const [from, to, json] = process.argv.slice(2);
const rule = json ? JSON.parse(json) : {};
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await hydrateDhanTokenFromMongo();
  let last = 0;
  const t0 = Date.now();
  const r = await runBacktest({ from, to, rule, onProgress: (p) => { if (p.phase === 'fetch' && Date.now() - last > 20000) { last = Date.now(); console.log('fetch', p.done, '/', p.total); } } });
  const s = r.summary;
  console.log(`${from}..${to} ${JSON.stringify(rule)} days ${r.tradingDays} trades ${s.trades} W ${s.wins} L ${s.losses} net ${s.netPnL} PF ${s.profitFactor} avgW ${s.avgWin} avgL ${s.avgLoss} maxDD ${s.maxDrawdown} green ${s.greenMonths}/${s.months.length} (${((Date.now()-t0)/1000).toFixed(0)}s)`);
  console.log(s.years.map(y => `${y.year}: ${Math.round(y.pnl)} (${y.greenMonths}/${y.months} green, ${y.wins}/${y.trades})`).join(' | '));
  console.log(s.months.map(m => `${m.label} ${Math.round(m.pnl)}`).join(' | '));
  if (process.env.SHOW_TRADES) for (const t of r.trades.slice(0, 15)) console.log(t.date, t.setup, t.level, t.side, t.entryTime, t.entrySpot, 'sl', t.slSpot, 'tg', t.targetSpot, t.exitType, t.exitTime, 'prem', t.entryPremium, '->', t.exitPremium, t.netPnL, 'cvd', t.cvdSlope, 'oi', t.callDoi, t.putDoi);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
