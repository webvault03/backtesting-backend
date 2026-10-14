/* TEMP — Option 2: the real Open OI Walls engine (unchanged) on the disk cache, exit/filter variants, all years. */
const path = require('path');
const Module = require('module');
const disk = require('./disk');

// Point the engine's './dataSource' at the disk cache for this process only (engine file untouched).
const dsPath = require.resolve('../src/services/openOiWallsBacktest/dataSource');
const fake = new Module(dsPath);
fake.filename = dsPath;
fake.loaded = true;
fake.exports = { addDays: disk.addDays, ensureDays: async () => new Map(), loadDays: (f, t) => disk.loadDays(f, t) };
require.cache[dsPath] = fake;
const { runBacktest, pickBaseline } = require('../src/services/openOiWallsBacktest/engine');

const FROM = '2021-01-04';
const TO = disk.lastCached();
const STEP = 50;

const oiAt = (s, m) => {
  if (!s?.m) return null;
  for (let x = m; x > m - 3; x -= 1) {
    const i = s.m.indexOf(x);
    if (i >= 0 && Number.isFinite(s.oi[i])) return s.oi[i];
  }
  return null;
};

// Writers-against-us at entry, from finished minutes only.
//  A = intraday ΔOI since 09:15 on wall strike ±2; B = ΔOI vs previous close on wall strike ±2.
function writerFlags(t) {
  const day = disk.readDay(t.date);
  let prevD = disk.addDays(t.date, -1);
  let prev = null;
  for (let k = 0; k < 10 && !prev; k += 1) {
    prev = disk.readDay(prevD);
    prevD = disk.addDays(prevD, -1);
  }
  const [hh, mm] = t.entryTime.split(':').map(Number);
  const lastClosed = hh * 60 + mm - 1;
  const ours = t.side; // option we buy
  const other = ours === 'CE' ? 'PE' : 'CE';
  const { base } = pickBaseline(day, prev);
  let aOurs = 0, aOther = 0, bOurs = 0, bOther = 0;
  for (let k = -2; k <= 2; k += 1) {
    const K = String(t.strike + k * STEP);
    for (const [side, isOurs] of [[ours, true], [other, false]]) {
      const now = oiAt(day[side]?.[K], lastClosed);
      const open = oiAt(day[side]?.[K], 555);
      const pc = base?.[side]?.[K];
      if (now != null && open != null) {
        if (isOurs) aOurs += now - open; else aOther += now - open;
      }
      if (now != null && pc != null) {
        if (isOurs) bOurs += now - pc; else bOther += now - pc;
      }
    }
  }
  return { A: aOurs > 0 && aOurs > aOther, B: bOurs > 0 && bOurs > bOther };
}

const years = ['2021', '2022', '2023', '2024', '2025', '2026'];
const k = (x) => `${x < 0 ? '-' : ''}₹${Math.round(Math.abs(x) / 1000)}k`;

(async () => {
  console.log(`Open OI Walls (real engine) ${FROM} → ${TO} · 10 lots (650) · REAL charges (engine's flat ₹100 replaced)`);
  const flagCache = new Map();
  for (const sl of [80, 40, 25]) {
    for (const ux of [[11 * 60 + 30, '11:30'], [10 * 60 + 30, '10:30'], [10 * 60, '10:00']]) {
      const res = await runBacktest({ from: FROM, to: TO, lots: 10, rule: { emergencySl: sl, unarmedExit: ux[0] } });
      const qty = res.qty;
      const trades = res.trades.map((t) => ({
        ...t,
        net: t.points * qty - disk.optionCharges(t.entryPremium * qty, t.exitPremium * qty),
      }));
      for (const t of trades) if (!flagCache.has(t.id)) flagCache.set(t.id, writerFlags(t));
      for (const [fname, keep] of [['no filter', () => true], ['skip A (intraday writers vs us)', (t) => !flagCache.get(t.id).A], ['skip B (writers vs us since prev close)', (t) => !flagCache.get(t.id).B]]) {
        const ts = trades.filter(keep);
        const part = (lo, hi) => {
          const xs = ts.filter((t) => t.date >= lo && t.date <= hi);
          const net = xs.reduce((s, t) => s + t.net, 0);
          const gw = xs.filter((t) => t.net > 0).reduce((s, t) => s + t.net, 0);
          const gl = -xs.filter((t) => t.net <= 0).reduce((s, t) => s + t.net, 0);
          const months = new Map();
          xs.forEach((t) => months.set(t.monthKey, (months.get(t.monthKey) || 0) + t.net));
          const green = [...months.values()].filter((v) => v > 0).length;
          return { n: xs.length, net, pf: gl ? gw / gl : 99, green, months: months.size, worst: Math.min(0, ...months.values()) };
        };
        const tr = part('2021-01-01', '2023-12-31');
        const te = part('2024-01-01', '2026-12-31');
        const by = years.map((y) => part(`${y}-01-01`, `${y}-12-31`).net);
        console.log(
          `SL −${String(sl).padEnd(2)} · unarmed ${ux[1]} · ${fname.padEnd(40)} | 21-23: ${String(tr.n).padStart(3)}t ${k(tr.net).padStart(7)} PF ${tr.pf.toFixed(2)} green ${tr.green}/${tr.months} | 24-26: ${String(te.n).padStart(3)}t ${k(te.net).padStart(7)} PF ${te.pf.toFixed(2)} green ${te.green}/${te.months} worstM ${k(te.worst)} | ${by.map((x, i) => `${years[i].slice(2)}:${k(x)}`).join(' ')}`,
        );
      }
    }
  }
})();
