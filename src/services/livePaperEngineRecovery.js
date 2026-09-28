/**
 * After server boot (with token) or when a fresh Dhan JWT is saved, re-sync paper-live
 * engines with MongoDB open trades and re-run exit/entry checks on real Dhan marks.
 */
async function notifyDhanConnectivityRestored() {
  const strategySix = require('./liveShortStraddleEngineStrategy6');
  const strategyFourteen = require('./liveEodOiWallsEngine');
  const strategyFifteen = require('./liveEodOiWallsSpotEngine');
  const results = await Promise.allSettled([
    strategySix.resumeOpenPositionFromDb(),
    strategyFourteen.resumeOpenPositionFromDb(),
    strategyFifteen.resumeOpenPositionFromDb(),
  ]);
  return {
    strategy6: results[0].status === 'fulfilled' ? results[0].value : { ok: false, error: results[0].reason?.message },
    strategy14: results[1].status === 'fulfilled' ? results[1].value : { ok: false, error: results[1].reason?.message },
    strategy15: results[2].status === 'fulfilled' ? results[2].value : { ok: false, error: results[2].reason?.message },
  };
}

module.exports = { notifyDhanConnectivityRestored };
