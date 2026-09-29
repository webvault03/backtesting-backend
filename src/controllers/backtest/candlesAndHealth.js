const { getCandlesWithCache, fetchTradingDayCandles } = require('../../services/dhanDataService');

const { isPlatformReady } = require('../../serverState');

function health(_req, res) {
  res.json({
    ok: true,
    service: 'backtesting-api',
    ready: isPlatformReady(),
    build: {
      commit: process.env.GIT_COMMIT || null,
      backtestRoutes: ['strategy2'],
      liveStrategies: ['strategy-6', 'strategy-14', 'strategy-15', 'strategy-16', 'strategy-17'],
    },
  });
}

async function getCandles(req, res) {
  try {
    const symbol = String(req.query.symbol || 'BANKNIFTY').toUpperCase();
    const interval = String(req.query.interval || '1');
    const year = Number(req.query.year || 2025);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(1000, Math.max(50, Number(req.query.pageSize) || 200));
    const refresh = String(req.query.refresh || 'false') === 'true';

    const payload = await getCandlesWithCache({ symbol, interval, year, refresh });
    const totalRows = payload.rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    const currentPage = Math.min(page, totalPages);
    const start = (currentPage - 1) * pageSize;
    const candles = payload.rows.slice(start, start + pageSize);

    res.json({
      ok: true,
      source: refresh ? 'live-dhan' : 'live/cache',
      symbol,
      interval,
      year,
      fromDate: payload.fromDate,
      toDate: payload.toDate,
      pagination: { page: currentPage, pageSize, totalRows, totalPages },
      data: { candles },
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({
        ok: false,
        error: 'Dhan API error',
        details: error.response.data,
      });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getCandlesDay(req, res) {
  try {
    const symbol = String(req.query.symbol || 'NIFTY').toUpperCase();
    const interval = String(req.query.interval || '5');
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: 'Query "date" is required as YYYY-MM-DD (IST calendar day).' });
    }
    if (!['1', '5', '15'].includes(interval)) {
      return res.status(400).json({ ok: false, error: 'Query "interval" must be 1, 5, or 15.' });
    }
    const payload = await fetchTradingDayCandles({ symbol, interval, dateKey: date });
    return res.json({
      ok: true,
      symbol,
      interval,
      date,
      count: payload.rows.length,
      candles: payload.rows,
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).json({
        ok: false,
        error: 'Dhan API error',
        details: error.response.data,
      });
    }
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  health,
  getCandles,
  getCandlesDay,
};
