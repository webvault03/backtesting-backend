/**
 * Normalize archive tape rows to the same Call/Put ΔOI shape as live /today.
 *
 * v2 archives already store dayCallChgOi — pass through + interval from day deltas.
 * Compact archives only stored oiVelocity + chngInDir (+ acts). Recover interval
 * Call/Put with correct signs from acts so Net ΔOI can be red (−) as well as green (+).
 */

function callActSign(act) {
  const a = String(act || '')
  if (a === 'Long build' || a === 'Writing') return 1
  if (a === 'Short cover' || a === 'Long unwind') return -1
  return null
}

function putActSign(act) {
  const a = String(act || '')
  if (a === 'Writing' || a === 'Buying') return 1
  if (a === 'Long unwind' || a === 'Short cover') return -1
  return null
}

/**
 * Archive build5mBars (step=1): oiVelocity = |c|+|p|, chngInDir = p−c.
 * Same-sign (|D| < S): unique magnitudes; sign from acts (unwind/cover → negative).
 * Opposite (|D|≈S): underdetermined → equal-|| + acts.
 */
function recoverIntervalFromVelocity(oiVelocity, chngInDir, callAct, putAct, step = 1) {
  const S = Number(oiVelocity) * Math.max(1, Number(step) || 1)
  const D = Number(chngInDir)
  if (!Number.isFinite(S) || S < 0 || !Number.isFinite(D)) {
    return { callsChgOi: null, putsChgOi: null }
  }
  if (S === 0 && D === 0) return { callsChgOi: 0, putsChgOi: 0 }

  const sc = callActSign(callAct)
  const sp = putActSign(putAct)

  // Opposite signs (or one-zero): |p−c| = |c|+|p|
  if (Math.abs(Math.abs(D) - S) <= 1) {
    if (sc != null && sp != null && sc === -sp) {
      return { callsChgOi: sc * (S / 2), putsChgOi: sp * (S / 2) }
    }
    // One side only — prefer act sign on the active leg
    if (sc != null && sp == null) {
      const calls = sc * S
      return { callsChgOi: calls, putsChgOi: 0 }
    }
    if (sp != null && sc == null) {
      const puts = sp * S
      return { callsChgOi: 0, putsChgOi: puts }
    }
    if (sc != null && sp != null && sc === sp) {
      // Same act sign but |D|≈S → all on one leg matching D
      if (D >= 0) return { callsChgOi: 0, putsChgOi: sp * S }
      return { callsChgOi: sc * S, putsChgOi: 0 }
    }
    if (D >= 0) return { callsChgOi: 0, putsChgOi: D }
    return { callsChgOi: -D, putsChgOi: 0 }
  }

  // Same sign — magnitudes from S,D; polarity from acts
  const cPos = (S - D) / 2
  const pPos = (S + D) / 2
  const cNeg = (-S - D) / 2
  const pNeg = (-S + D) / 2

  const useNegative = (() => {
    if (sc === -1 && (sp === -1 || sp == null)) return true
    if (sp === -1 && (sc === -1 || sc == null)) return true
    if (sc === 1 || sp === 1) return false
    return false
  })()

  if (useNegative && Number.isFinite(cNeg) && Number.isFinite(pNeg)) {
    return {
      callsChgOi: Math.min(0, cNeg),
      putsChgOi: Math.min(0, pNeg),
    }
  }
  if (cPos >= -1e-6 && pPos >= -1e-6) {
    return { callsChgOi: Math.max(0, cPos), putsChgOi: Math.max(0, pPos) }
  }
  if (Number.isFinite(cNeg) && Number.isFinite(pNeg)) {
    return {
      callsChgOi: Math.min(0, cNeg),
      putsChgOi: Math.min(0, pNeg),
    }
  }
  return { callsChgOi: null, putsChgOi: null }
}

function finiteOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {object[]} rawRows archive rows (any order)
 * @param {{ intervalMin?: number }} [opts]
 * @returns {{ rows: object[], oiSource: 'v2'|'reconstructed'|'mixed'|'empty' }}
 */
function hydrateArchiveRowsForTracker(rawRows, { intervalMin = 1 } = {}) {
  const step = Math.max(1, Number(intervalMin) || 1)
  const sorted = [...(rawRows || [])]
    .filter((r) => r && Number.isFinite(Number(r.minutes)))
    .sort((a, b) => Number(a.minutes) - Number(b.minutes))

  if (!sorted.length) return { rows: [], oiSource: 'empty' }

  let dayCall = 0
  let dayPut = 0
  let prevDayCall = null
  let prevDayPut = null
  let usedV2 = 0
  let usedRecover = 0

  const rows = sorted.map((r) => {
    const spot = finiteOrNull(r.spotPrice ?? r.spot)
    const storedDayC = finiteOrNull(r.dayCallChgOi)
    const storedDayP = finiteOrNull(r.dayPutChgOi)
    const hasDay = storedDayC != null && storedDayP != null

    let dayCallChgOi
    let dayPutChgOi
    let callsChgOi
    let putsChgOi

    if (hasDay) {
      usedV2 += 1
      dayCallChgOi = storedDayC
      dayPutChgOi = storedDayP
      if (prevDayCall != null && prevDayPut != null) {
        callsChgOi = dayCallChgOi - prevDayCall
        putsChgOi = dayPutChgOi - prevDayPut
      } else {
        callsChgOi = finiteOrNull(r.callsChgOi) ?? 0
        putsChgOi = finiteOrNull(r.putsChgOi) ?? 0
      }
      dayCall = dayCallChgOi
      dayPut = dayPutChgOi
    } else {
      const storedC = finiteOrNull(r.callsChgOi)
      const storedP = finiteOrNull(r.putsChgOi)
      if (storedC != null && storedP != null) {
        callsChgOi = storedC
        putsChgOi = storedP
        usedRecover += 1
      } else {
        const recovered = recoverIntervalFromVelocity(
          r.oiVelocity,
          r.chngInDir,
          r.callAct,
          r.putAct,
          step,
        )
        callsChgOi = recovered.callsChgOi
        putsChgOi = recovered.putsChgOi
        if (callsChgOi != null && putsChgOi != null) usedRecover += 1
      }

      if (Number.isFinite(callsChgOi)) dayCall += callsChgOi
      if (Number.isFinite(putsChgOi)) dayPut += putsChgOi
      dayCallChgOi =
        Number.isFinite(callsChgOi) || Number.isFinite(putsChgOi) ? dayCall : null
      dayPutChgOi =
        Number.isFinite(callsChgOi) || Number.isFinite(putsChgOi) ? dayPut : null
    }

    prevDayCall = dayCallChgOi
    prevDayPut = dayPutChgOi

    const chngInDir =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi)
        ? putsChgOi - callsChgOi
        : finiteOrNull(r.chngInDir)

    const diffInOi =
      Number.isFinite(dayPutChgOi) && Number.isFinite(dayCallChgOi)
        ? dayPutChgOi - dayCallChgOi
        : finiteOrNull(r.diffInOi)

    const netDeltaOi =
      Number.isFinite(callsChgOi) && Number.isFinite(putsChgOi)
        ? callsChgOi + putsChgOi
        : null

    const callOiTotal = finiteOrNull(r.callOiTotal)
    const putOiTotal = finiteOrNull(r.putOiTotal)
    let pcr = finiteOrNull(r.pcr)
    if (
      pcr == null
      && Number.isFinite(callOiTotal)
      && callOiTotal > 0
      && Number.isFinite(putOiTotal)
    ) {
      pcr = putOiTotal / callOiTotal
    }

    // Prefer archived acts when present (compact tape) — matches saved Bias/Strength.
    const callAct = r.callAct && r.callAct !== '—' ? r.callAct : null
    const putAct = r.putAct && r.putAct !== '—' ? r.putAct : null

    return {
      ...r,
      spotPrice: spot,
      spot: spot ?? r.spot,
      dayCallChgOi,
      dayPutChgOi,
      callsChgOi,
      putsChgOi,
      chngInDir,
      diffInOi,
      netDeltaOi,
      callOiTotal,
      putOiTotal,
      pcr,
      callAct: callAct || r.callAct || '—',
      putAct: putAct || r.putAct || '—',
      topCallChgStrike: finiteOrNull(r.topCallChgStrike ?? r.topCallStrike),
      topPutChgStrike: finiteOrNull(r.topPutChgStrike ?? r.topPutStrike),
      fetchOk: r.fetchOk !== false,
      _fromArchive: true,
    }
  })

  let oiSource = 'empty'
  if (usedV2 && usedRecover) oiSource = 'mixed'
  else if (usedV2) oiSource = 'v2'
  else if (usedRecover) oiSource = 'reconstructed'

  return { rows, oiSource }
}

module.exports = {
  hydrateArchiveRowsForTracker,
  recoverIntervalFromVelocity,
  callActSign,
  putActSign,
}
