/* TEMP — Option 1: how NIFTY behaves at the 09:15 OI walls (ATM±10 data), all years. */
const disk = require('./disk');
const { computeTrailLockPoints } = require('../src/utils/openOiWallsTrail');
const Module = require('module');

const dsPath = require.resolve('../src/services/openOiWallsBacktest/dataSource');
const fake = new Module(dsPath);
fake.filename = dsPath;
fake.loaded = true;
fake.exports = { addDays: disk.addDays, ensureDays: async () => new Map(), loadDays: disk.loadDays };
require.cache[dsPath] = fake;
const { pickBaseline } = require('../src/services/openOiWallsBacktest/engine');

const FROM = '2021-01-04';
const TO = disk.lastCached();
const STEP = 50;
const CAP = 555;
const PROX = 25;
const LAST_TOUCH = 870; // 14:30
const EOD = 915;
const QTY = 650;
const MOVE = 30; // NIFTY pts for held / broke

const idx = (s) => {
  const m = new Map();
  s?.m?.forEach((x, i) => m.set(x, i));
  return m;
};
const oiAt = (s, m) => {
  if (!s?.m) return null;
  for (let x = m; x > m - 3; x -= 1) {
    const i = s.m.indexOf(x);
    if (i >= 0 && Number.isFinite(s.oi[i])) return s.oi[i];
  }
  return null;
};

// same wall definition as the engine: top |ΔOI vs prev close| per side within ±12 strikes of spot at 09:15 close
function walls(day, base, spot) {
  let put = null;
  let call = null;
  const strikes = new Set([...Object.keys(day.CE || {}), ...Object.keys(day.PE || {})].map(Number));
  for (const K of strikes) {
    if (Math.abs(K - spot) > 12 * STEP) continue;
    const k = String(K);
    const p = oiAt(day.PE?.[k], CAP);
    const c = oiAt(day.CE?.[k], CAP);
    const pc = p != null && base?.PE?.[k] != null ? p - base.PE[k] : null;
    const cc = c != null && base?.CE?.[k] != null ? c - base.CE[k] : null;
    if (pc && (!put || Math.abs(pc) > Math.abs(put.chg))) put = { strike: K, chg: pc };
    if (cc && (!call || Math.abs(cc) > Math.abs(call.chg))) call = { strike: K, chg: cc };
  }
  const out = [];
  if (put) out.push({ kind: 'PUT', strike: put.strike, chg: put.chg, support: 1, wallSide: 'PE', otherSide: 'CE' });
  if (call) out.push({ kind: 'CALL', strike: call.strike, chg: call.chg, support: -1, wallSide: 'CE', otherSide: 'PE' });
  return out;
}

// Buy ATM `side` at minute e open: SL −25, Open OI Walls trail, exit if not armed in 60 min, 15:15. Real charges.
function buy(day, nifty, ni, side, e) {
  if (!ni.has(e)) return null;
  const K = String(Math.round(nifty.o[ni.get(e)] / STEP) * STEP);
  const s = day[side]?.[K];
  const si = idx(s);
  if (!si.has(e)) return null;
  const entry = s.o[si.get(e)];
  let peak = entry;
  let lock = null;
  let exit = null;
  let last = entry;
  for (let m = e; m <= EOD; m += 1) {
    if (!si.has(m)) continue;
    const i = si.get(m);
    const o = m === e ? entry : s.o[i];
    if (m === EOD) { exit = o; break; }
    if (lock != null) {
      if (o <= entry + lock) { exit = o; break; }
      if (s.l[i] <= entry + lock) { exit = entry + lock; break; }
    } else {
      if (m >= e + 60) { exit = o; break; }
      if (o <= entry - 25) { exit = o; break; }
      if (s.l[i] <= entry - 25) { exit = entry - 25; break; }
    }
    peak = Math.max(peak, s.h[i]);
    const nx = computeTrailLockPoints(peak - entry);
    if (nx != null && (lock == null || nx > lock)) lock = nx;
    last = s.c[i];
  }
  if (exit == null) exit = last;
  return (exit - entry) * QTY - disk.optionCharges(entry * QTY, exit * QTY);
}

const rows = [];
let prev = null;
for (let d = FROM; d <= TO; d = disk.addDays(d, 1)) {
  const day = disk.readDay(d);
  if (!day) continue;
  const n = day.nifty;
  const ni = idx(n);
  if (!prev || !ni.has(CAP)) { prev = day; continue; }
  const { base } = pickBaseline(day, prev);
  const ws = walls(day, base, n.c[ni.get(CAP)]);
  for (const w of ws) {
    // first touch after capture (closed minute), entry/outcome from the next minute's open
    let t = null;
    for (let m = CAP + 1; m <= LAST_TOUCH; m += 1) {
      if (!ni.has(m)) continue;
      const i = ni.get(m);
      if (n.l[i] <= w.strike + PROX && n.h[i] >= w.strike - PROX) { t = m; break; }
    }
    if (t == null || !ni.has(t + 1)) continue;
    const k = String(w.strike);
    const wallNow = oiAt(day[w.wallSide][k], t);
    const wallCap = oiAt(day[w.wallSide][k], CAP);
    const othNow = oiAt(day[w.otherSide][k], t);
    const othCap = oiAt(day[w.otherSide][k], CAP);
    if (wallNow == null || wallCap == null || othNow == null || othCap == null) continue;
    const dWall = wallNow - wallCap;
    const dOther = othNow - othCap;
    const e0 = n.o[ni.get(t + 1)];
    let res = 'neither';
    for (let m = t + 1; m <= Math.min(EOD, t + 60); m += 1) {
      if (!ni.has(m)) continue;
      const i = ni.get(m);
      const up = w.support > 0 ? n.h[i] - e0 : e0 - n.l[i];
      const dn = w.support > 0 ? e0 - n.l[i] : n.h[i] - e0;
      if (dn >= MOVE && up >= MOVE) { res = 'broke'; break; } // same minute → assume worst for bounce
      if (up >= MOVE) { res = 'held'; break; }
      if (dn >= MOVE) { res = 'broke'; break; }
    }
    const bounceSide = w.support > 0 ? 'CE' : 'PE';
    const breakSide = w.support > 0 ? 'PE' : 'CE';
    rows.push({
      d,
      y: d.slice(0, 4),
      kind: w.kind,
      win: t <= 615 ? 'touch ≤10:15' : t <= 720 ? 'touch 10:15–12:00' : 'touch 12:00–14:30',
      writers: dWall === 0 && dOther === 0 ? 'no OI change yet (instant touch)' : dWall > 0 ? (dOther > dWall ? 'wall growing, other side growing more' : 'wall DEFENDED (growing most)') : (dOther > 0 ? 'wall SHRINKING + other side writing' : 'wall shrinking, other side shrinking'),
      built: w.chg > 0 ? 'wall BUILT overnight (ΔOI > 0)' : 'wall UNWOUND overnight (ΔOI < 0)',
      dist: t === CAP + 1 ? 'touch at 09:16 (already at wall)' : 'touch later (price travelled to wall)',
      res,
      bounce: buy(day, n, ni, bounceSide, t + 1),
      brk: buy(day, n, ni, breakSide, t + 1),
    });
  }
  prev = day;
}

const years = ['2021', '2022', '2023', '2024', '2025', '2026'];
const k = (x) => `${x < 0 ? '-' : ''}₹${Math.round(Math.abs(x) / 1000)}k`;
function table(title, key) {
  console.log(`\n### ${title}`);
  const g = new Map();
  rows.forEach((r) => {
    const v = typeof key === 'function' ? key(r) : r[key];
    if (!g.has(v)) g.set(v, []);
    g.get(v).push(r);
  });
  for (const [name, rs] of [...g.entries()].sort()) {
    const pct = (x) => `${((rs.filter((r) => r.res === x).length / rs.length) * 100).toFixed(0)}%`;
    const pl = (f) => {
      const xs = rs.filter((r) => r[f] != null);
      const net = xs.reduce((s, r) => s + r[f], 0);
      const tr = xs.filter((r) => r.y < '2024').reduce((s, r) => s + r[f], 0);
      const te = xs.filter((r) => r.y >= '2024').reduce((s, r) => s + r[f], 0);
      const by = years.map((y) => xs.filter((r) => r.y === y).reduce((s, r) => s + r[f], 0));
      return `${k(net).padStart(7)} (21-23 ${k(tr)}, 24-26 ${k(te)}, yrs+ ${by.filter((x) => x > 0).length}/6)`;
    };
    console.log(`${name.padEnd(44)} ${String(rs.length).padStart(4)}  held ${pct('held').padStart(4)} broke ${pct('broke').padStart(4)} neither ${pct('neither').padStart(4)} | bounce-buy ${pl('bounce')} | break-buy ${pl('brk')}`);
  }
}

console.log(`Wall touches ${FROM} → ${TO}: ${rows.length} · held/broke = NIFTY moves ${MOVE} pts away / through within 60 min after the touch`);
console.log('bounce-buy = buy ATM option in the wall direction at the next minute open · break-buy = opposite · SL −25, Open OI Walls trail, out if not armed in 60 min, 15:15, 650 qty, real charges');
table('ALL by year', 'y');
table('Wall type', 'kind');
table('Touch time', 'win');
table('What writers did between 09:15 and the touch (at the wall strike)', 'writers');
table('Wall built vs unwound overnight', 'built');
table('Already at the wall at 09:16 vs price travelled to it', 'dist');
table('Built/unwound × wall type', (r) => `${r.built.split(' ')[1]} · ${r.kind}`);
table('Built/unwound × 09:16 or later', (r) => `${r.built.split(' ')[1]} · ${r.dist.split(' (')[0]}`);
table('Writers (later touches only)', (r) => (r.dist.startsWith('touch later') ? r.writers : 'zz 09:16 touches'));
