/**
 * Per-strike ΔOI analytics for OI Flow minute rows (ATM ± lookaround).
 */

function strikeSideDelta(curr, prev, chgKey, oiKey) {
  const cChg = Number(curr?.[chgKey]);
  const pChg = Number(prev?.[chgKey]);
  if (Number.isFinite(cChg) && Number.isFinite(pChg)) return cChg - pChg;
  const cOi = Number(curr?.[oiKey]);
  const pOi = Number(prev?.[oiKey]);
  if (Number.isFinite(cOi) && Number.isFinite(pOi)) return cOi - pOi;
  return null;
}

function intervalStrikeDeltas(currStrikes, prevStrikes) {
  if (!Array.isArray(currStrikes) || !Array.isArray(prevStrikes)) return [];
  const prevBy = new Map(prevStrikes.map((r) => [Number(r.strike), r]));
  const out = [];
  for (const curr of currStrikes) {
    const strike = Number(curr?.strike);
    if (!Number.isFinite(strike)) continue;
    const prev = prevBy.get(strike);
    if (!prev) continue;
    const callChg = strikeSideDelta(curr, prev, 'callChgOi', 'callOi');
    const putChg = strikeSideDelta(curr, prev, 'putChgOi', 'putOi');
    out.push({
      strike,
      callChgOi: Number.isFinite(callChg) ? callChg : null,
      putChgOi: Number.isFinite(putChg) ? putChg : null,
      callOi: Number.isFinite(Number(curr.callOi)) ? Number(curr.callOi) : null,
      putOi: Number.isFinite(Number(curr.putOi)) ? Number(curr.putOi) : null,
    });
  }
  return out;
}

function pickTopSide(deltas, side) {
  const key = side === 'call' ? 'callChgOi' : 'putChgOi';
  let best = null;
  let bestAbs = 0;
  for (const row of deltas) {
    const v = Number(row?.[key]);
    if (!Number.isFinite(v) || v === 0) continue;
    const abs = Math.abs(v);
    if (abs > bestAbs) {
      bestAbs = abs;
      best = { strike: row.strike, oi: v };
    }
  }
  return best;
}

function migrationDir(prevStrike, nextStrike) {
  const a = Number(prevStrike);
  const b = Number(nextStrike);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return 'flat';
  return b > a ? 'up' : 'down';
}

/**
 * Interval top strikes + OI migration vs previous minute row.
 */
function analyticsFromStrikes(strikes, prev) {
  const deltas = intervalStrikeDeltas(strikes, prev?.strikes);
  const topCall = pickTopSide(deltas, 'call');
  const topPut = pickTopSide(deltas, 'put');

  let dominantSide = null;
  let dominantStrike = null;
  let dominantOi = null;
  if (topCall && topPut) {
    if (Math.abs(topCall.oi) >= Math.abs(topPut.oi)) {
      dominantSide = 'call';
      dominantStrike = topCall.strike;
      dominantOi = topCall.oi;
    } else {
      dominantSide = 'put';
      dominantStrike = topPut.strike;
      dominantOi = topPut.oi;
    }
  } else if (topCall) {
    dominantSide = 'call';
    dominantStrike = topCall.strike;
    dominantOi = topCall.oi;
  } else if (topPut) {
    dominantSide = 'put';
    dominantStrike = topPut.strike;
    dominantOi = topPut.oi;
  }

  const prevDom = prev?.dominantStrike != null ? Number(prev.dominantStrike) : null;
  const oiMigration =
    dominantStrike != null && prevDom != null
      ? migrationDir(prevDom, dominantStrike)
      : null;

  return {
    topCallChgStrike: topCall?.strike ?? null,
    topCallChgOi: topCall?.oi ?? null,
    topPutChgStrike: topPut?.strike ?? null,
    topPutChgOi: topPut?.oi ?? null,
    dominantSide,
    dominantStrike,
    dominantOi,
    oiMigration,
    strikeDeltas: deltas,
  };
}

/** ΔOI wall bias for one strike. */
function biasFromStrikeRow(row, minOiRatio = 1.2) {
  if (!row || !Number.isFinite(Number(row.strike))) return null;
  const putChg = Number(row.putChgOi);
  const callChg = Number(row.callChgOi);
  if (!Number.isFinite(putChg) || !Number.isFinite(callChg)) return null;
  const oiMass = Math.max(0, putChg) + Math.max(0, callChg);
  if (!(oiMass > 0)) return null;

  const putDom = putChg >= callChg;
  const ratio = putDom
    ? Math.max(putChg, 0) / Math.max(Math.max(callChg, 0), 1)
    : Math.max(callChg, 0) / Math.max(Math.max(putChg, 0), 1);
  const clear = ratio >= minOiRatio;

  let deltaOk = true;
  if (putDom && callChg > putChg * 1.25 && callChg > 0) deltaOk = false;
  if (!putDom && putChg > callChg * 1.25 && putChg > 0) deltaOk = false;

  return {
    strike: Number(row.strike),
    dominantSide: putDom ? 'PUT' : 'CALL',
    optionType: putDom ? 'CE' : 'PE',
    putChgOi: putChg,
    callChgOi: callChg,
    ratio: Number(ratio.toFixed(2)),
    clear,
    deltaOk,
    oiMass,
  };
}

function findOiWalls(strikes, spot, { minOiRatio = 1.2 } = {}) {
  const rows = Array.isArray(strikes) ? strikes : [];
  const spotN = Number(spot);
  let ceWall = null;
  let peWall = null;

  for (const row of rows) {
    const bias = biasFromStrikeRow(row, minOiRatio);
    if (!bias?.clear || !bias.deltaOk) continue;
    const strike = bias.strike;
    if (bias.dominantSide === 'CALL') {
      if (!ceWall || bias.callChgOi > ceWall.callChgOi) {
        ceWall = { ...bias, dist: Number.isFinite(spotN) ? strike - spotN : null };
      }
    } else if (!peWall || bias.putChgOi > peWall.putChgOi) {
      peWall = { ...bias, dist: Number.isFinite(spotN) ? strike - spotN : null };
    }
  }

  return { ceWall, peWall };
}

module.exports = {
  intervalStrikeDeltas,
  analyticsFromStrikes,
  biasFromStrikeRow,
  findOiWalls,
};
