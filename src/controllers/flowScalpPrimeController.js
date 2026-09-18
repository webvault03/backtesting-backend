const scalpEngine = require('../services/flowScalpPrimeEngine');

async function getFlowScalpPrimeStatus(_req, res) {
  try {
    const data = await scalpEngine.getStatus();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getFlowScalpPrimeBook(_req, res) {
  try {
    const data = await scalpEngine.getBookSummary();
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getFlowScalpPrimeTrades(req, res) {
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
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postFlowScalpPrimeEnabled(req, res) {
  try {
    const enabled = Boolean(req.body?.enabled);
    const data = await scalpEngine.setEnabled(enabled);
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchFlowScalpPrimeSettings(req, res) {
  try {
    const data = await scalpEngine.updateSettings(req.body || {});
    return res.json(data);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postFlowScalpPrimeClose(_req, res) {
  try {
    const trade = await scalpEngine.closeOpenTradeManual('MANUAL_CLOSE');
    return res.json({ ok: true, trade });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getFlowScalpPrimeStatus,
  getFlowScalpPrimeBook,
  getFlowScalpPrimeTrades,
  postFlowScalpPrimeEnabled,
  patchFlowScalpPrimeSettings,
  postFlowScalpPrimeClose,
};
