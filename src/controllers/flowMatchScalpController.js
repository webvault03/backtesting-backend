const scalpEngine = require('../services/flowMatchScalpEngine');

function errMessage(error, fallback) {
  const msg = error && typeof error.message === 'string' ? error.message.trim() : '';
  return msg || fallback;
}

function jsonError(res, status, error, fallback) {
  return res.status(status).json({ ok: false, error: errMessage(error, fallback) });
}

async function getFlowMatchScalpStatus(_req, res) {
  try {
    const data = await scalpEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return jsonError(res, 500, error, 'Failed to load Flow Match Scalp status');
  }
}

async function getFlowMatchScalpBook(_req, res) {
  try {
    const data = await scalpEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return jsonError(res, 500, error, 'Failed to load Flow Match Scalp book');
  }
}

async function getFlowMatchScalpTrades(req, res) {
  try {
    const data = await scalpEngine.listTrades({
      status: req.query?.status,
      page: req.query?.page,
      pageSize: req.query?.pageSize,
      date: req.query?.date,
      month: req.query?.month,
      year: req.query?.year,
    });
    return res.json({ ok: true, ...data });
  } catch (error) {
    return jsonError(res, 500, error, 'Failed to load Flow Match Scalp trades');
  }
}

async function postFlowMatchScalpEnabled(req, res) {
  try {
    if (req.body == null || typeof req.body !== 'object' || Array.isArray(req.body) || !Object.prototype.hasOwnProperty.call(req.body, 'enabled')) {
      return res.status(400).json({ ok: false, error: 'JSON body required: { enabled: true|false }' });
    }
    const enabled = Boolean(req.body.enabled);
    const data = await scalpEngine.setEnabled(enabled);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return jsonError(res, 400, error, 'Failed to update Flow Match Scalp enabled');
  }
}

async function patchFlowMatchScalpSettings(req, res) {
  try {
    if (req.body == null || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ ok: false, error: 'JSON settings body required' });
    }
    const data = await scalpEngine.updateSettings(req.body);
    return res.json({ ok: true, ...data });
  } catch (error) {
    return jsonError(res, 400, error, 'Failed to save Flow Match Scalp settings');
  }
}

async function postFlowMatchScalpClose(_req, res) {
  try {
    const trade = await scalpEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    const status = Number(error?.status) || 400;
    return jsonError(res, status, error, 'Failed to close Flow Match Scalp trade');
  }
}

module.exports = {
  getFlowMatchScalpStatus,
  getFlowMatchScalpBook,
  getFlowMatchScalpTrades,
  postFlowMatchScalpEnabled,
  patchFlowMatchScalpSettings,
  postFlowMatchScalpClose,
};
