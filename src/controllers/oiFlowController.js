const oiFlowEngine = require('../services/oiFlowMinuteEngine');
const {
  listLiveSignals,
  forceBackfillLiveSignalsFromMinutes,
} = require('../services/oiFlowLiveSignalStore');
const { getIstClock } = require('../utils/dateTime');
const archiveService = require('../services/oiFlowDayArchiveService');

async function getOiFlowStatus(_req, res) {
  try {
    const data = await oiFlowEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowToday(_req, res) {
  try {
    const data = await oiFlowEngine.listTodayRows();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

/** Calendar month — which dates have archived OI JSON. */
async function getOiFlowArchives(req, res) {
  try {
    const clock = getIstClock(new Date());
    const year = Number(req.query?.year) || Number(String(clock.dateKey).slice(0, 4));
    const month = Number(req.query?.month) || Number(String(clock.dateKey).slice(5, 7));
    const data = await archiveService.listArchivedMonth({ year, month });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

/** Download archived day JSON (1m candles). */
async function getOiFlowArchiveDownload(req, res) {
  try {
    const dateKey = String(req.params?.dateKey || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({ ok: false, error: 'Invalid dateKey' });
    }
    const pack = await archiveService.getArchivePayload(dateKey);
    if (!pack) {
      return res.status(404).json({ ok: false, error: 'No OI archive for this date' });
    }
    const body = `${JSON.stringify(pack.payload, null, 2)}\n`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${pack.filename}"`);
    return res.status(200).send(body);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

/**
 * Tracker day view — today = live minutes; past = archive JSON (read-only, no DB write).
 * GET /api/oi-flow/day/:dateKey
 */
async function getOiFlowDay(req, res) {
  try {
    const dateKey = String(req.params?.dateKey || req.query?.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      return res.status(400).json({ ok: false, error: 'Invalid dateKey (YYYY-MM-DD)' });
    }
    const clock = getIstClock(new Date());
    if (dateKey === clock.dateKey) {
      const data = await oiFlowEngine.listTodayRows();
      return res.json({ ok: true, historical: false, source: 'live', ...data });
    }
    const data = await archiveService.getDayTapeForTracker(dateKey);
    if (!data) {
      return res.status(404).json({
        ok: false,
        error: `No OI archive for ${dateKey}. Pick a date from the calendar that has saved JSON.`,
      });
    }
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowHeaderSignal(_req, res) {
  try {
    const data = await oiFlowEngine.getHeaderSignal();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getOiFlowSignals(req, res) {
  try {
    const clock = getIstClock(new Date());
    const raw = String(req.query.date || '').trim();
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : clock.dateKey;
    const data = await listLiveSignals(dateKey);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postOiFlowSignalsBackfill(req, res) {
  try {
    const clock = getIstClock(new Date());
    const raw = String(req.body?.date || req.query?.date || '').trim();
    const dateKey = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : clock.dateKey;
    const data = await forceBackfillLiveSignalsFromMinutes(dateKey);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getOiFlowStatus,
  getOiFlowToday,
  getOiFlowDay,
  getOiFlowArchives,
  getOiFlowArchiveDownload,
  getOiFlowHeaderSignal,
  getOiFlowSignals,
  postOiFlowSignalsBackfill,
};
