/**
 * Stock Manual desk (stock options from the option chain, carry forward, auto-exit at expiry).
 * Separate paper wallet + trades from Index Manual (walletKey paper_live_manual_stock).
 */
const stockEngine = require('../services/manualTradeEngine');

function parsePage(raw, fallback = 1) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function parsePageSize(raw, fallback = 25, max = 500) {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : fallback;
}

/** Keep entire request on Stock desk context (isolated from Index Manual wallet). */
function withStockDesk(fn) {
  return stockEngine.runWithDesk('stock', fn);
}

async function getManualStockStatus(_req, res) {
  try {
    const data = await withStockDesk(async () => {
      await stockEngine.ensureEngineRunning('stock');
      return stockEngine.getStatus();
    });
    return res.json({ ok: true, desk: 'stock', ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualStockExpiries(req, res) {
  try {
    const data = await withStockDesk(() =>
      stockEngine.getExpiries(req.query?.symbol || 'RELIANCE'),
    );
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualStockQuote(req, res) {
  try {
    const data = await withStockDesk(() =>
      stockEngine.getQuote({
        symbol: req.query?.symbol || 'RELIANCE',
        expiry: req.query?.expiry,
        strike: req.query?.strike,
        optionType: req.query?.optionType,
      }),
    );
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function getManualStockInstruments(_req, res) {
  try {
    const data = await withStockDesk(() => stockEngine.getInstrumentUniverse());
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualStockFutureQuote(req, res) {
  try {
    const data = await withStockDesk(() =>
      stockEngine.getFuture({
        symbol: req.query?.symbol,
        expiry: req.query?.expiry,
      }),
    );
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function getManualStockChain(req, res) {
  try {
    const data = await withStockDesk(() =>
      stockEngine.getChainAroundAtm({
        symbol: req.query?.symbol,
        expiry: req.query?.expiry,
      }),
    );
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postManualStockOrder(req, res) {
  try {
    const body = { ...(req.body || {}), product: 'OPTION' };
    const result = await withStockDesk(async () => {
      await stockEngine.ensureEngineRunning('stock');
      return stockEngine.createOrder(body);
    });
    return res.json({
      ok: true,
      order: result.order,
      trade: result.trade,
      filled: result.filled,
      message: result.filled
        ? `Filled ${result.trade?.optionType || 'FUT'} ${result.trade?.strike || result.trade?.symbol} @ ₹${result.trade?.entryPremium}`
        : 'Limit order placed — fills when LTP reaches your price',
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function deleteManualStockOrder(req, res) {
  try {
    const order = await withStockDesk(async () => {
      await stockEngine.ensureEngineRunning('stock');
      return stockEngine.cancelOrder(req.params.orderId);
    });
    return res.json({ ok: true, order, message: 'Order cancelled' });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postManualStockClosePosition(req, res) {
  try {
    const trade = await withStockDesk(async () => {
      await stockEngine.ensureEngineRunning('stock');
      return stockEngine.closePositionById(req.params.tradeId, { reason: 'MANUAL_CLOSE' });
    });
    return res.json({
      ok: true,
      trade,
      message: trade?.pnl != null ? `Closed. P/L ₹${Number(trade.pnl).toFixed(2)}` : 'Position closed',
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function patchManualStockPositionRisk(req, res) {
  try {
    const tradeId = String(req.params?.tradeId || '').trim();
    if (!tradeId) return res.status(400).json({ ok: false, error: 'tradeId required' });
    const body = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const riskPayload = {};
    if (has('stopLossValue')) {
      riskPayload.stopLossValue = body.stopLossValue;
      riskPayload.stopLossMode = body.stopLossMode;
    } else if (has('stopLossPoints')) {
      riskPayload.stopLossPoints = body.stopLossPoints;
    }
    if (has('targetValue')) {
      riskPayload.targetValue = body.targetValue;
      riskPayload.targetMode = body.targetMode;
    } else if (has('targetProfitPoints')) {
      riskPayload.targetProfitPoints = body.targetProfitPoints;
    }
    const trade = await withStockDesk(async () => {
      await stockEngine.ensureEngineRunning('stock');
      return stockEngine.updatePositionRisk(tradeId, riskPayload);
    });
    return res.json({
      ok: true,
      trade,
      message: `Updated — SL ${trade.stopLossPremium != null ? `₹${trade.stopLossPremium}` : 'off'}, target ${trade.targetPremium != null ? `₹${trade.targetPremium}` : 'hold open'}`,
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function postManualStockWalletReset(req, res) {
  try {
    const wallet = await withStockDesk(async () => {
      await stockEngine.ensureEngineRunning('stock');
      return stockEngine.resetWallet();
    });
    return res.json({ ok: true, wallet, message: 'Stock Manual history cleared — capital kept' });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function postManualStockWalletTopup(req, res) {
  try {
    const wallet = await withStockDesk(async () => {
      await stockEngine.ensureEngineRunning('stock');
      return stockEngine.topUpWallet(req.body?.amount);
    });
    return res.json({
      ok: true,
      wallet,
      message: `Added ₹${Number(req.body?.amount).toLocaleString('en-IN')} to paper balance`,
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
}

async function getManualStockTrades(req, res) {
  try {
    const data = await withStockDesk(() =>
      stockEngine.listTrades({
        page: parsePage(req.query?.page),
        pageSize: parsePageSize(req.query?.pageSize, 50),
        status: req.query?.status,
        book: req.query?.book,
      }),
    );
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

async function getManualStockActions(req, res) {
  try {
    const data = await withStockDesk(() =>
      stockEngine.listActions({
        page: parsePage(req.query?.page),
        pageSize: parsePageSize(req.query?.pageSize, 50, 200),
      }),
    );
    return res.json({ ok: true, ...data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
}

module.exports = {
  getManualStockStatus,
  getManualStockExpiries,
  getManualStockQuote,
  getManualStockInstruments,
  getManualStockFutureQuote,
  getManualStockChain,
  postManualStockOrder,
  deleteManualStockOrder,
  postManualStockClosePosition,
  patchManualStockPositionRisk,
  postManualStockWalletReset,
  postManualStockWalletTopup,
  getManualStockTrades,
  getManualStockActions,
};
