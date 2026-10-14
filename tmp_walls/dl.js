/* TEMP — download Open OI Walls data (ATM±10) into .cache/oiWalls10. Resumable. Delete when done. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');

const DIR = path.join(__dirname, '..', '.cache', 'oiWalls10');
const FROM = '2026-04-01';
const TO = '2026-10-13';

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const tok = require('../src/services/dhanTokenPersistence');
  await tok.hydrateDhanTokenFromMongo();
  require('../src/routes/index.js');
  const ds = require('../src/services/openOiWallsBacktest/dataSource');
  fs.mkdirSync(DIR, { recursive: true });
  const file = (d) => path.join(DIR, `${d}.json.gz`);
  let cursor = FROM;
  while (cursor <= TO) {
    const [y, m] = cursor.split('-').map(Number);
    let monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (monthEnd > TO) monthEnd = TO;
    const dates = [];
    for (let d = cursor; d <= monthEnd; d = ds.addDays(d, 1)) dates.push(d);
    if (!dates.every((d) => fs.existsSync(file(d)))) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await ds.ensureDays(cursor, monthEnd);
          const got = new Map(ds.loadDays(cursor, monthEnd).map((x) => [x.dateKey, x]));
          for (const d of dates) {
            const day = got.get(d);
            const payload = day ? { tradingDay: true, ...day } : { tradingDay: false };
            delete payload.dateKey;
            fs.writeFileSync(`${file(d)}.tmp`, zlib.gzipSync(Buffer.from(JSON.stringify(payload))));
            fs.renameSync(`${file(d)}.tmp`, file(d));
          }
          console.log(`${cursor.slice(0, 7)} saved · trading days ${got.size}`);
          break;
        } catch (e) {
          console.log(`${cursor.slice(0, 7)} attempt ${attempt} failed: ${e.message}`);
          if (attempt >= 6) throw e;
          await new Promise((r) => setTimeout(r, 15000 * attempt));
          await tok.hydrateDhanTokenFromMongo();
        }
      }
    }
    cursor = ds.addDays(monthEnd, 1);
  }
  console.log('done');
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
