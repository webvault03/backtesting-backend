const live = require('../services/oiStrikeLiveService');

async function getOiStrikeLive(_req, res) {
  try {
    live.ensureEngineRunning();
    return res.json(await live.getLiveReport());
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiStrikeLiveBackfill(_req, res) {
  try {
    const backfill = await live.requestBackfill();
    if (backfill.status === 'error') return res.status(502).json({ ok: false, error: backfill.error, backfill });
    return res.json({ ok: true, backfill });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = { getOiStrikeLive, postOiStrikeLiveBackfill };
