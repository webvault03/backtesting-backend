/**
 * Open OI Walls — daily market-open OI report.
 *
 * Per trading day:
 *   - NIFTY 09:15 open → ATM (nearest 50) → 9 strikes ATM−4 … ATM+4.
 *   - ΔOI per strike/side = OI at the 09:15 bar − previous day's closing OI (nearest weekly,
 *     same baseline as the Open OI Walls backtest).
 *   - Top 2 OI increases and top 2 OI decreases for CE and for PE.
 *
 * Output: scripts/output/openOiWallsOpen_<from>_<to>.csv (one row per day)
 *         scripts/output/openOiWallsOpen_<from>_<to>_strikes.csv (all 9 strikes × CE/PE per day)
 *
 * Usage: node scripts/openOiWallsOpenReport.js [--from 2025-10-13] [--to 2026-10-13] [--width 4]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { ensureValidDhanAccessToken } = require('../src/services/tokenService');
const { addDays, ensureDays, loadDays } = require('../src/services/openOiWallsBacktest/dataSource');
const { pickBaseline, oiAtCapture } = require('../src/services/openOiWallsBacktest/engine');
const { getIstClock } = require('../src/utils/dateTime');

const STEP = 50;
const OPEN_MIN = 9 * 60 + 15;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const today = getIstClock(new Date()).dateKey;
const TO = arg('to', today);
const FROM = arg('from', `${Number(TO.slice(0, 4)) - 1}${TO.slice(4)}`);
const WIDTH = Number(arg('width', 4));

const pct = (chg, base) => (base > 0 ? Number(((chg / base) * 100).toFixed(2)) : null);

function analyzeDay(day, prev) {
  const i = day.nifty?.m?.indexOf(OPEN_MIN);
  if (!(i >= 0)) return { skipped: 'no NIFTY 09:15 bar' };
  if (!prev) return { skipped: 'no previous day' };
  const open = day.nifty.o[i];
  const atm = Math.round(open / STEP) * STEP;
  const { base, source } = pickBaseline(day, prev);
  if (!base) return { skipped: 'no previous-day close OI' };

  const strikes = [];
  for (let off = -WIDTH; off <= WIDTH; off += 1) {
    const strike = atm + off * STEP;
    const row = { strike, offset: off };
    for (const side of ['CE', 'PE']) {
      const now = oiAtCapture(day[side]?.[String(strike)]);
      const before = base[side]?.[String(strike)];
      row[side] = {
        prevOi: before ?? null,
        openOi: now,
        chg: now != null && before != null ? now - before : null,
        chgPct: now != null && before != null ? pct(now - before, before) : null,
      };
    }
    strikes.push(row);
  }

  const pickTop = (side) => {
    const rows = strikes.filter((s) => s[side].chg != null).map((s) => ({ strike: s.strike, ...s[side] }));
    return {
      up: rows.filter((r) => r.chg > 0).sort((a, b) => b.chg - a.chg).slice(0, 2),
      down: rows.filter((r) => r.chg < 0).sort((a, b) => a.chg - b.chg).slice(0, 2),
    };
  };
  return { open, atm, baseline: source, strikes, top: { CE: pickTop('CE'), PE: pickTop('PE') } };
}

const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  await ensureValidDhanAccessToken('open-oi-walls-open-report');

  const fetchFrom = addDays(FROM, -7);
  let lastPct = -1;
  const live = await ensureDays(fetchFrom, TO, {
    onProgress: ({ done, total }) => {
      const p = total ? Math.floor((done / total) * 100) : 100;
      if (p !== lastPct && p % 5 === 0) {
        lastPct = p;
        console.log(`fetch ${done}/${total} (${p}%)`);
      }
    },
  });
  const days = loadDays(fetchFrom, TO, live);

  const head = ['date', 'open', 'atm', 'baseline'];
  for (const side of ['CE', 'PE']) {
    for (const dir of ['up', 'down']) {
      for (const n of [1, 2]) head.push(`${side}_${dir}${n}_strike`, `${side}_${dir}${n}_chg`, `${side}_${dir}${n}_pct`);
    }
  }
  const summary = [head];
  const detail = [['date', 'open', 'atm', 'strike', 'offset', 'side', 'prevCloseOi', 'openOi', 'chg', 'chgPct']];
  const skipped = [];

  days.forEach((day, idx) => {
    if (day.dateKey < FROM) return;
    const r = analyzeDay(day, days[idx - 1]);
    if (r.skipped) {
      skipped.push(`${day.dateKey}: ${r.skipped}`);
      return;
    }
    const row = [day.dateKey, r.open, r.atm, r.baseline];
    for (const side of ['CE', 'PE']) {
      for (const dir of ['up', 'down']) {
        for (const n of [0, 1]) {
          const t = r.top[side][dir][n];
          row.push(t?.strike, t?.chg, t?.chgPct);
        }
      }
    }
    summary.push(row);
    for (const s of r.strikes) {
      for (const side of ['CE', 'PE']) {
        const v = s[side];
        detail.push([day.dateKey, r.open, r.atm, s.strike, s.offset, side, v.prevOi, v.openOi, v.chg, v.chgPct]);
      }
    }
  });

  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `openOiWallsOpen_${FROM}_${TO}`);
  fs.writeFileSync(`${base}.csv`, toCsv(summary));
  fs.writeFileSync(`${base}_strikes.csv`, toCsv(detail));

  console.log(`\nDays reported: ${summary.length - 1}, skipped: ${skipped.length}`);
  skipped.forEach((s) => console.log(`  skipped ${s}`));
  console.log(`\n${base}.csv\n${base}_strikes.csv`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
