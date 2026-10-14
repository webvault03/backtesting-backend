/**
 * Header OI Flow signal — session view from 09:15 through a given minute.
 * score = spot vs 09:15 (±1) + day Put Δ vs Call Δ (±1) + more Bull than Bear minutes (±1).
 * ≥ +2 CALL BUY · ≤ −2 PUT BUY · otherwise WAIT.
 */

const WAITING = {
  decision: 'WAIT',
  tone: 'flat',
  bias: 'Sideways',
  emoji: '😢',
  mood: 'Sad',
  dirMark: '⚪ →',
  reason: 'Waiting for 09:15 candles…',
  line: '😢 Sad · Sideways · Waiting for 09:15 candles…',
  asOf: null,
  minutesUsed: 0,
};

function orderedRows(rows, displayRow) {
  const byMin = new Map();
  for (const row of rows || []) {
    if (!row || row.fetchOk === false) continue;
    const m = Number(row.minutes);
    if (!Number.isFinite(m)) continue;
    byMin.set(m, row);
  }
  if (displayRow && displayRow.fetchOk !== false) {
    const m = Number(displayRow.minutes);
    if (Number.isFinite(m)) byMin.set(m, displayRow);
  }
  return [...byMin.values()].sort((a, b) => Number(a.minutes) - Number(b.minutes));
}

function minuteDir(row) {
  const calls = Number(row.callsChgOi);
  const puts = Number(row.putsChgOi);
  const chng = Number.isFinite(calls) && Number.isFinite(puts) ? puts - calls : null;
  if (!Number.isFinite(chng) || chng === 0) return 0;
  return chng > 0 ? 1 : -1;
}

function signalAt(first, last, bullMins, bearMins, count) {
  const spotOpen = Number(first.spotPrice);
  const spotNow = Number(last.spotPrice);
  const dayCall = Number(last.dayCallChgOi);
  const dayPut = Number(last.dayPutChgOi);
  const dayDiff = Number.isFinite(dayPut) && Number.isFinite(dayCall) ? dayPut - dayCall : null;

  const spotChg = Number.isFinite(spotNow) && Number.isFinite(spotOpen) ? spotNow - spotOpen : null;
  const spotScore = Number.isFinite(spotChg) ? (spotChg > 0.5 ? 1 : spotChg < -0.5 ? -1 : 0) : 0;
  const oiScore = Number.isFinite(dayDiff) ? (dayDiff > 0 ? 1 : dayDiff < 0 ? -1 : 0) : 0;
  const pathScore = bullMins === bearMins ? 0 : bullMins > bearMins ? 1 : -1;
  const score = spotScore + oiScore + pathScore;

  let decision = 'WAIT';
  let bias = 'Sideways';
  let tone = 'flat';
  let emoji = '😢';
  let mood = 'Sad';
  if (score >= 2) {
    decision = 'CALL BUY';
    bias = 'Bullish';
    tone = 'call';
    emoji = '🥳';
    mood = 'Woo';
  } else if (score <= -2) {
    decision = 'PUT BUY';
    bias = 'Bearish';
    tone = 'put';
    emoji = '🥳';
    mood = 'Woo';
  } else if (score === 1) {
    bias = 'Not very bullish';
    tone = 'callSoft';
  } else if (score === -1) {
    bias = 'Not very bearish';
    tone = 'putSoft';
  }

  const parts = [`09:15→${last.time || 'now'} · ${count}m`];
  if (Number.isFinite(spotChg)) {
    parts.push(`spot ${spotChg > 0 ? '+' : ''}${spotChg.toFixed(1)}`);
  }
  if (Number.isFinite(dayDiff)) {
    parts.push(dayDiff > 0 ? 'Puts lead ΔOI' : dayDiff < 0 ? 'Calls lead ΔOI' : 'ΔOI even');
  }
  parts.push(`${bullMins} Bull / ${bearMins} Bear`);
  const reason = parts.join(' · ');

  return {
    decision,
    tone,
    bias,
    emoji,
    mood,
    dirMark: score > 0 ? '🟢 ↑' : score < 0 ? '🔴 ↓' : '⚪ →',
    reason,
    line: `${emoji} ${mood} · ${bias} · ${reason}`,
    asOf: last.time,
    minutes: Number(last.minutes),
    spot: Number.isFinite(spotNow) ? spotNow : null,
    minutesUsed: count,
    score,
  };
}

function computeHeaderSignal(rows, displayRow) {
  const ordered = orderedRows(rows, displayRow);
  if (!ordered.length) return { ...WAITING };
  let bull = 0;
  let bear = 0;
  for (const row of ordered) {
    const d = minuteDir(row);
    if (d > 0) bull += 1;
    else if (d < 0) bear += 1;
  }
  return signalAt(ordered[0], ordered[ordered.length - 1], bull, bear, ordered.length);
}

/**
 * Replays the header signal minute by minute; one event each time the decision changes
 * (the first minute always opens an event).
 */
function replayHeaderTimeline(rows) {
  const ordered = orderedRows(rows, null);
  const events = [];
  let bull = 0;
  let bear = 0;
  ordered.forEach((row, i) => {
    const d = minuteDir(row);
    if (d > 0) bull += 1;
    else if (d < 0) bear += 1;
    const s = signalAt(ordered[0], row, bull, bear, i + 1);
    const prev = events[events.length - 1];
    if (!prev || prev.decision !== s.decision) {
      events.push({
        minutes: s.minutes,
        time: s.asOf,
        decision: s.decision,
        tone: s.tone,
        bias: s.bias,
        score: s.score,
        spot: s.spot,
        reason: s.reason,
      });
    }
  });
  return events;
}

module.exports = { computeHeaderSignal, replayHeaderTimeline };
