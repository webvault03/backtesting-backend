/**
 * Deep OI Flow market autopsy — every minute 2026-09-09 → today.
 * Analyzes callAct/putAct, Match/Fight, strength, migration, fakeouts vs real booms.
 *
 * Usage: node scripts/analyzeOiFlowDeep.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const FROM = '2026-09-09';
const END = process.env.END_DATE || '2026-09-29';
const SESSION_FROM = 9 * 60 + 15;
const SESSION_TO = 15 * 60 + 15;
const LOOKAHEADS = [3, 5, 10, 15, 30];
const BOOM = 10;

function loadRows(doc, liveRows) {
  const src = liveRows?.length
    ? liveRows
    : doc?.payload?.rows || [];
  return src
    .map((r) => {
      const spot = Number(r.spotPrice ?? r.spot ?? r.futPrice);
      const strength =
        typeof r.strength === 'string'
          ? r.strength
          : r.strength?.label || null;
      return {
        minutes: Number(r.minutes),
        time: r.time,
        spot,
        spotDelta: Number(r.spotDelta),
        flowBias: r.flowBias || '—',
        callAct: r.callAct || '—',
        putAct: r.putAct || '—',
        act: r.act || '—',
        strength: strength || '—',
        strengthScore: Number(r.strength?.score) || null,
        oiMigration: r.oiMigration || '—',
        streak: Number(r.streak) || 0,
        strengthStreak: Number(r.strengthStreak) || 0,
        chngInDir: Number(r.chngInDir),
        oiVelocity: Number(r.oiVelocity),
        deltaPcr: Number(r.deltaPcr),
        pcr: Number(r.pcr),
        dominantSide: r.dominantSide || '—',
        topCall: Number(r.topCallStrike ?? r.topCallChgStrike),
        topPut: Number(r.topPutStrike ?? r.topPutChgStrike),
      };
    })
    .filter(
      (r) =>
        Number.isFinite(r.minutes) &&
        Number.isFinite(r.spot) &&
        r.minutes >= SESSION_FROM &&
        r.minutes <= SESSION_TO
    )
    .sort((a, b) => a.minutes - b.minutes);
}

function bump(map, key, w = 1) {
  map[key] = (map[key] || 0) + w;
}

function ensureCombo(map, key) {
  if (!map[key]) {
    map[key] = {
      n: 0,
      days: new Set(),
      nextUp: 0,
      nextDown: 0,
      nextFlat: 0,
      boomUp: 0,
      boomDown: 0,
      fakeUpThenDown: 0, // favor then reverse within lookahead window
      sumMove10: 0,
      sumAbs10: 0,
      mfe10: 0,
      mae10: 0,
      samples: [],
    };
  }
  return map[key];
}

function pathStats(rowsByMin, m0, spot0, la) {
  let mfeUp = 0;
  let mfeDown = 0;
  let endMove = null;
  for (let t = 1; t <= la; t += 1) {
    const r = rowsByMin.get(m0 + t);
    if (!r || !Number.isFinite(r.spot)) continue;
    const d = r.spot - spot0;
    if (d > mfeUp) mfeUp = d;
    if (d < mfeDown) mfeDown = d;
    if (t === la) endMove = d;
  }
  // if exact la missing, use nearest later <= la+2
  if (endMove == null) {
    for (let t = la; t <= la + 2; t += 1) {
      const r = rowsByMin.get(m0 + t);
      if (r && Number.isFinite(r.spot)) {
        endMove = r.spot - spot0;
        break;
      }
    }
  }
  return { mfeUp, mfeDown, endMove };
}

function topEntries(obj, n = 15) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ key: k, n: v }));
}

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const archives = db.collection('oiflowdayarchives');
  const live = db.collection('oiflowminuterows');

  const archKeys = await archives.distinct('dateKey', { dateKey: { $gte: FROM, $lte: END } });
  const liveKeys = await live.distinct('dateKey', { dateKey: { $gte: FROM, $lte: END } });
  const dateKeys = [...new Set([...archKeys, ...liveKeys])].sort();

  const callActCount = {};
  const putActCount = {};
  const actPairCount = {}; // CE|PE
  const matchFightCount = {};
  const strengthCount = {};
  const biasCount = {};
  const migrationCount = {};
  const dominantCount = {};

  const pairFollow = {}; // CE|PE → forward stats
  const tripleFollow = {}; // Match/Fight + CE|PE + strength
  const sequenceFollow = {}; // prevPair → currPair → move
  const fakeMoveBook = []; // notable fakeouts
  const realBoomBook = []; // clean booms
  const daySummaries = [];

  let totalMinutes = 0;
  let minutesWithActs = 0;

  for (const dateKey of dateKeys) {
    const doc = await archives.findOne({ dateKey });
    const liveRows = await live.find({ dateKey }).sort({ minutes: 1 }).toArray();
    const rows = loadRows(doc, liveRows.length ? liveRows : null);
    if (rows.length < 30) {
      daySummaries.push({ dateKey, skip: 'thin', rows: rows.length });
      continue;
    }

    const byMin = new Map(rows.map((r) => [r.minutes, r]));
    let dayBoomUp = 0;
    let dayBoomDown = 0;
    let dayFake = 0;
    let dayReal = 0;

    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      totalMinutes += 1;

      bump(callActCount, r.callAct);
      bump(putActCount, r.putAct);
      bump(matchFightCount, r.act);
      bump(strengthCount, r.strength);
      bump(biasCount, r.flowBias);
      bump(migrationCount, r.oiMigration);
      bump(dominantCount, r.dominantSide);

      const pair = `${r.callAct} | ${r.putAct}`;
      bump(actPairCount, pair);
      if (r.callAct !== '—' && r.putAct !== '—') minutesWithActs += 1;

      // forward path at +10m (primary)
      const ps = pathStats(byMin, r.minutes, r.spot, 10);
      if (ps.endMove == null) continue;

      const c = ensureCombo(pairFollow, pair);
      c.n += 1;
      c.days.add(dateKey);
      c.sumMove10 += ps.endMove;
      c.sumAbs10 += Math.abs(ps.endMove);
      c.mfe10 += ps.mfeUp;
      c.mae10 += ps.mfeDown;
      if (ps.endMove > 1) c.nextUp += 1;
      else if (ps.endMove < -1) c.nextDown += 1;
      else c.nextFlat += 1;
      if (ps.endMove >= BOOM) c.boomUp += 1;
      if (ps.endMove <= -BOOM) c.boomDown += 1;

      // fake: first 3–5m goes one way >=8, then 10m closes opposite >=8
      const p5 = pathStats(byMin, r.minutes, r.spot, 5);
      const fakeBull =
        p5.mfeUp >= 8 && ps.endMove <= -8;
      const fakeBear =
        p5.mfeDown <= -8 && ps.endMove >= 8;
      if (fakeBull || fakeBear) {
        c.fakeUpThenDown += 1;
        dayFake += 1;
        if (fakeMoveBook.length < 80) {
          fakeMoveBook.push({
            dateKey,
            time: r.time,
            pair,
            act: r.act,
            strength: r.strength,
            bias: r.flowBias,
            type: fakeBull ? 'FAKE_UP_THEN_DOWN' : 'FAKE_DOWN_THEN_UP',
            mfe5: Number((fakeBull ? p5.mfeUp : p5.mfeDown).toFixed(1)),
            end10: Number(ps.endMove.toFixed(1)),
          });
        }
      }

      // real boom: MFE and end same direction, |end|>=10, MAE shallow
      const realUp = ps.endMove >= BOOM && ps.mfeUp >= BOOM && ps.mfeDown > -6;
      const realDown = ps.endMove <= -BOOM && ps.mfeDown <= -BOOM && ps.mfeUp < 6;
      if (realUp || realDown) {
        dayReal += 1;
        if (realUp) dayBoomUp += 1;
        if (realDown) dayBoomDown += 1;
        if (realBoomBook.length < 100) {
          realBoomBook.push({
            dateKey,
            time: r.time,
            pair,
            act: r.act,
            strength: r.strength,
            bias: r.flowBias,
            mig: r.oiMigration,
            dir: realUp ? 'UP' : 'DOWN',
            end10: Number(ps.endMove.toFixed(1)),
            mfe: Number((realUp ? ps.mfeUp : ps.mfeDown).toFixed(1)),
          });
        }
      }

      // triple: act + pair + strength
      const triple = `${r.act} · ${r.strength} · ${pair}`;
      const t = ensureCombo(tripleFollow, triple);
      t.n += 1;
      t.days.add(dateKey);
      t.sumMove10 += ps.endMove;
      t.sumAbs10 += Math.abs(ps.endMove);
      t.mfe10 += ps.mfeUp;
      t.mae10 += ps.mfeDown;
      if (ps.endMove > 1) t.nextUp += 1;
      else if (ps.endMove < -1) t.nextDown += 1;
      else t.nextFlat += 1;
      if (ps.endMove >= BOOM) t.boomUp += 1;
      if (ps.endMove <= -BOOM) t.boomDown += 1;
      if (fakeBull || fakeBear) t.fakeUpThenDown += 1;

      // sequence: previous act pair → current
      if (i > 0) {
        const prev = rows[i - 1];
        const prevPair = `${prev.callAct} | ${prev.putAct}`;
        if (prevPair !== pair && prev.callAct !== '—' && r.callAct !== '—') {
          const seq = `${prevPair}  →  ${pair}`;
          const s = ensureCombo(sequenceFollow, seq);
          s.n += 1;
          s.days.add(dateKey);
          s.sumMove10 += ps.endMove;
          s.sumAbs10 += Math.abs(ps.endMove);
          if (ps.endMove > 1) s.nextUp += 1;
          else if (ps.endMove < -1) s.nextDown += 1;
          else s.nextFlat += 1;
          if (ps.endMove >= BOOM) s.boomUp += 1;
          if (ps.endMove <= -BOOM) s.boomDown += 1;
        }
      }
    }

    const open = rows[0]?.spot;
    const close = rows[rows.length - 1]?.spot;
    daySummaries.push({
      dateKey,
      rows: rows.length,
      dayMove: Number.isFinite(open) && Number.isFinite(close) ? Number((close - open).toFixed(1)) : null,
      boomUpMinutes: dayBoomUp,
      boomDownMinutes: dayBoomDown,
      fakeMinutes: dayFake,
      realBoomMinutes: dayReal,
      fakeToRealRatio:
        dayReal > 0 ? Number((dayFake / dayReal).toFixed(2)) : null,
    });
  }

  // Fix typo in comboReport - I had a syntax error with ` : 0`
  function comboReportFixed(map, minN = 25) {
    return Object.entries(map)
      .map(([key, c]) => {
        const n = c.n;
        const directed = c.nextUp + c.nextDown || 1;
        const upRate = c.nextUp / directed;
        const boomN = c.boomUp + c.boomDown;
        const boomUpRate = boomN ? c.boomUp / boomN : 0;
        const avgMove10 = n ? c.sumMove10 / n : 0;
        const avgAbs10 = n ? c.sumAbs10 / n : 0;
        // directional edge: how often boom matches the act "textbook" side
        let textbook = null;
        if (key.includes('Short cover') && key.includes('Writing') && !key.includes('Long')) {
          // CE short cover + PE writing = bullish textbook
          textbook = 'UP';
        } else if (
          (key.includes('Long build') && key.includes('Buying')) ||
          (key.includes('Writing') && key.includes('Buying') && key.startsWith('Writing'))
        ) {
          textbook = 'DOWN';
        } else if (key.includes('Long build') && key.includes('Long unwind')) {
          textbook = 'mixed';
        }

        const boomAlign =
          textbook === 'UP'
            ? c.boomUp / Math.max(1, boomN)
            : textbook === 'DOWN'
              ? c.boomDown / Math.max(1, boomN)
              : null;

        return {
          key,
          n,
          days: c.days.size,
          avgMove10: Number(avgMove10.toFixed(2)),
          avgAbs10: Number(avgAbs10.toFixed(2)),
          upRatePct: Number((upRate * 100).toFixed(1)),
          boomUp: c.boomUp,
          boomDown: c.boomDown,
          boomN,
          boomUpRatePct: Number((boomUpRate * 100).toFixed(1)),
          textbook,
          textbookBoomAlignPct:
            boomAlign != null ? Number((boomAlign * 100).toFixed(1)) : null,
          fakeRatePct: Number(((c.fakeUpThenDown / n) * 100).toFixed(1)),
          avgMfe10: Number((c.mfe10 / n).toFixed(2)),
          avgMae10: Number((c.mae10 / n).toFixed(2)),
          expectancy: Number(avgMove10.toFixed(2)),
        };
      })
      .filter((x) => x.n >= minN)
      .sort((a, b) => Math.abs(b.expectancy) - Math.abs(a.expectancy));
  }

  const pairRanked = comboReportFixed(pairFollow, 40);
  const tripleRanked = comboReportFixed(tripleFollow, 25);
  const seqRanked = comboReportFixed(sequenceFollow, 15);

  // Best "crack" candidates: textbook boom align high + fake rate low + |expectancy| decent
  const crackCandidates = pairRanked
    .filter((x) => x.textbook && x.textbook !== 'mixed' && x.boomN >= 15)
    .map((x) => ({
      ...x,
      crackScore: Number(
        (
          (x.textbookBoomAlignPct || 0) * 0.4 +
          (100 - x.fakeRatePct) * 0.25 +
          Math.min(30, Math.abs(x.expectancy) * 3) * 0.2 +
          Math.min(20, x.days) * 0.15
        ).toFixed(1)
      ),
    }))
    .sort((a, b) => b.crackScore - a.crackScore);

  const tripleCrack = tripleRanked
    .filter((x) => x.boomN >= 10 && Math.abs(x.expectancy) >= 1.5)
    .slice(0, 25);

  // Aggregate: when Match vs Fight, what happens
  const matchVsFight = {};
  for (const [k, c] of Object.entries(tripleFollow)) {
    const head = k.split(' · ')[0]; // Match / Fight / —
    if (!matchVsFight[head]) {
      matchVsFight[head] = { n: 0, sum: 0, boomUp: 0, boomDown: 0, fake: 0 };
    }
    matchVsFight[head].n += c.n;
    matchVsFight[head].sum += c.sumMove10;
    matchVsFight[head].boomUp += c.boomUp;
    matchVsFight[head].boomDown += c.boomDown;
    matchVsFight[head].fake += c.fakeUpThenDown;
  }
  const matchFightSummary = Object.entries(matchVsFight).map(([k, v]) => ({
    act: k,
    n: v.n,
    avgMove10: Number((v.sum / v.n).toFixed(2)),
    boomUp: v.boomUp,
    boomDown: v.boomDown,
    fakeRatePct: Number(((v.fake / v.n) * 100).toFixed(1)),
  }));

  const out = {
    meta: {
      from: FROM,
      to: END,
      days: dateKeys.length,
      dateKeys,
      totalMinutes,
      minutesWithActs,
      note: 'Forward stats = spot move from minute T to T+10. Boom = |move|≥10. Fake = MFE≥8 one way in 5m then close opposite ≥8 at 10m.',
    },
    distributions: {
      callAct: topEntries(callActCount, 20),
      putAct: topEntries(putActCount, 20),
      actPair: topEntries(actPairCount, 25),
      matchFight: topEntries(matchFightCount, 10),
      strength: topEntries(strengthCount, 15),
      flowBias: topEntries(biasCount, 10),
      oiMigration: topEntries(migrationCount, 10),
      dominantSide: topEntries(dominantCount, 10),
    },
    matchFightSummary,
    daySummaries,
    topActPairsByExpectancy: pairRanked.slice(0, 20),
    crackCandidates: crackCandidates.slice(0, 15),
    topTriples: tripleCrack,
    topSequences: seqRanked.slice(0, 20),
    sampleFakes: fakeMoveBook.slice(0, 25),
    sampleRealBooms: realBoomBook.slice(0, 25),
  };

  const outPath = path.join(__dirname, 'tmp_oi_deep_autopsy.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  // Console digest
  console.log('\n========== OI FLOW DEEP AUTOPSY · NIFTY ==========\n');
  console.log(`Range ${FROM} → ${END} | days ${dateKeys.length} | minutes ${totalMinutes} | with acts ${minutesWithActs}`);
  console.log('Forward window: +10m spot | Boom ≥10pts | Fake = stab one way then reverse\n');

  console.log('--- CALL ACT ---');
  for (const x of out.distributions.callAct) console.log(`  ${x.key.padEnd(14)} ${x.n}`);
  console.log('--- PUT ACT ---');
  for (const x of out.distributions.putAct) console.log(`  ${x.key.padEnd(14)} ${x.n}`);
  console.log('--- MATCH / FIGHT ---');
  for (const x of matchFightSummary) {
    console.log(
      `  ${x.act.padEnd(6)} n=${x.n} avg10=${x.avgMove10} boom↑${x.boomUp} boom↓${x.boomDown} fake%=${x.fakeRatePct}`
    );
  }

  console.log('\n--- TOP CE|PE PAIRS BY |EXPECTANCY| (+10m) ---');
  console.log('Pair                                      n   days  avg10  boom↑ boom↓  fake%  textbook align%');
  for (const x of pairRanked.slice(0, 15)) {
    console.log(
      `${x.key.padEnd(40)} ${String(x.n).padStart(4)}  ${String(x.days).padStart(2)}  ${String(x.avgMove10).padStart(6)}  ${String(x.boomUp).padStart(5)} ${String(x.boomDown).padStart(5)}  ${String(x.fakeRatePct).padStart(5)}  ${String(x.textbook || '—').padEnd(6)} ${x.textbookBoomAlignPct ?? '—'}`
    );
  }

  console.log('\n--- CRACK CANDIDATES (textbook + low fake + days) ---');
  for (const x of crackCandidates.slice(0, 10)) {
    console.log(
      `score ${x.crackScore} | ${x.key} | n=${x.n} days=${x.days} avg10=${x.avgMove10} →${x.textbook} align=${x.textbookBoomAlignPct}% fake=${x.fakeRatePct}%`
    );
  }

  console.log('\n--- TOP TRIPLES (Match/Fight · Strength · CE|PE) ---');
  for (const x of tripleCrack.slice(0, 12)) {
    console.log(
      `${x.key.slice(0, 70).padEnd(70)} n=${x.n} avg10=${x.avgMove10} ↑${x.boomUp} ↓${x.boomDown} fake=${x.fakeRatePct}%`
    );
  }

  console.log('\n--- TOP ACT TRANSITIONS (prev → curr) ---');
  for (const x of seqRanked.slice(0, 12)) {
    console.log(
      `${x.key.slice(0, 72).padEnd(72)} n=${x.n} avg10=${x.avgMove10} ↑${x.boomUp} ↓${x.boomDown}`
    );
  }

  console.log('\n--- DAY FAKE vs REAL ---');
  for (const d of daySummaries) {
    if (d.skip) {
      console.log(`${d.dateKey} SKIP ${d.skip}`);
      continue;
    }
    console.log(
      `${d.dateKey} move=${d.dayMove} realBoomMin=${d.realBoomMinutes} fakeMin=${d.fakeMinutes} ratio=${d.fakeToRealRatio}`
    );
  }

  console.log(`\nJSON: ${outPath}\n`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
