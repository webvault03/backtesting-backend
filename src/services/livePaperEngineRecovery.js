/**
 * After server boot (with token) or when a fresh Dhan JWT is saved, re-sync paper-live
 * engines with MongoDB open trades and re-run exit/entry checks on real Dhan marks.
 */
async function notifyDhanConnectivityRestored() {
  const strategySix = require('./liveShortStraddleEngineStrategy6');
  const strategySixteen = require('./liveOpenOiWallsEngine');
  const strategySeventeen = require('./liveOiCandleAgreeEngine');
  const strategyEighteen = require('./liveOiStrikeFlowEngine');
  const results = await Promise.allSettled([
    strategySix.resumeOpenPositionFromDb(),
    strategySixteen.resumeOpenPositionFromDb(),
    strategySeventeen.resumeOpenPositionFromDb(),
    strategyEighteen.resumeOpenPositionFromDb(),
  ]);
  return {
    strategy6: results[0].status === 'fulfilled' ? results[0].value : { ok: false, error: results[0].reason?.message },
    strategy16: results[1].status === 'fulfilled' ? results[1].value : { ok: false, error: results[1].reason?.message },
    strategy17: results[2].status === 'fulfilled' ? results[2].value : { ok: false, error: results[2].reason?.message },
    strategy18: results[3].status === 'fulfilled' ? results[3].value : { ok: false, error: results[3].reason?.message },
  };
}

module.exports = { notifyDhanConnectivityRestored };
