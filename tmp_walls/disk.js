/* TEMP — read .cache/oiWalls10 days. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { addDays } = require('../src/services/oiCandleAgreeBacktest/dataSource');

const DIR = path.join(__dirname, '..', '.cache', 'oiWalls10');
const file = (d) => path.join(DIR, `${d}.json.gz`);

function readDay(d) {
  if (!fs.existsSync(file(d))) return null;
  const p = JSON.parse(zlib.gunzipSync(fs.readFileSync(file(d))).toString('utf8'));
  return p.tradingDay ? { dateKey: d, ...p } : null;
}

function loadDays(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = readDay(d);
    if (day) out.push(day);
  }
  return out;
}

function lastCached() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json.gz')).sort().pop().slice(0, 10);
}

function optionCharges(b, s) {
  const ex = (b + s) * 0.0003503;
  const sebi = (b + s) * 1e-6;
  return 40 + s * 0.001 + ex + sebi + (40 + ex + sebi) * 0.18 + b * 0.00003;
}

module.exports = { addDays, readDay, loadDays, lastCached, optionCharges };
