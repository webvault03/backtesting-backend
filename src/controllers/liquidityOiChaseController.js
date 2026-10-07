const chartHistory = require('../services/liquidityChartHistoryService');
const { getTodayAvgBuySell } = require('../services/niftyAvgBuySellService');

async function getLiquidityOiChaseChart(_req, res) {
  try {
    const data = await chartHistory.getWeekChartPayload();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getNiftyAvgBuySell(req, res) {
  try {
    const data = await getTodayAvgBuySell({ refresh: req.query.refresh === '1' });
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getLiquidityOiChaseChart,
  getNiftyAvgBuySell,
};
