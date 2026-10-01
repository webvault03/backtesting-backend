const express = require('express');
const {
  health,
  getCandles,
  getCandlesDay,
  runStrategyShortStraddleNextDay,
  getStrategyShortStraddleRunTrades,
  getStrategyShortStraddleValidation,
  postStrategyShortStraddleValidation,
  postStrategyShortStraddleValidationYear,
} = require('../controllers/backtestController');
const {
  postLogin,
  getAuthConfig,
  getAuthStatusHandler,
  getMe,
  postLogout,
  postVerifyPassword,
} = require('../controllers/authController');
const { loginRateLimit } = require('../middleware/loginRateLimit');
const { postDhanAccessToken, getDhanTokenStatus } = require('../controllers/dhanTokenController');
const {
  getStatus: getLiveStatus,
  startLive,
  stopLive,
  saveLiveSettings,
  resetWallet: resetLiveWallet,
  listTrades: listLiveTrades,
  exportTradesExcel: exportLiveTradesExcel,
  getLiveMeta,
  closeLivePosition,
} = require('../controllers/liveTradeController');
const {
  getInstrumentSummary,
  exportOptionStocksCsv,
  exportFutureStocksCsv,
} = require('../controllers/instrumentDataController');
const {
  getManualConsoleStatus,
  getManualExpiries,
  getManualQuote,
  getManualChain,
  getManualOiBoard,
  getManualOiTotals,
  getManualInstruments,
  getManualFutureQuote,
  postManualOrder,
  deleteManualOrder,
  postManualClosePosition,
  patchManualPositionRisk,
  getManualTrades,
  getManualActions,
  postManualWalletReset,
  postManualWalletTopup,
  getManualOiFlowToday,
} = require('../controllers/manualConsoleController');
const {
  getOiFlowStatus,
  getOiFlowToday,
  getOiFlowDay,
  getOiFlowArchives,
  getOiFlowArchiveDownload,
  getOiFlowHeaderSignal,
  getOiFlowSignals,
  postOiFlowSignalsBackfill,
} = require('../controllers/oiFlowController');
const {
  getLiquidityOiChaseChart,
} = require('../controllers/liquidityOiChaseController');

const router = express.Router();

router.get('/health', health);
router.post('/auth/login', loginRateLimit, postLogin);
router.get('/auth/config', getAuthConfig);
router.get('/auth/status', getAuthStatusHandler);
router.get('/auth/me', getMe);
router.post('/auth/logout', postLogout);
router.post('/auth/verify-password', postVerifyPassword);
router.get('/dhan/token-status', getDhanTokenStatus);
router.post('/dhan/access-token', postDhanAccessToken);
router.get('/data/candles', getCandles);
router.get('/data/candles/day', getCandlesDay);
router.get('/data/option-stocks.csv', exportOptionStocksCsv);
router.get('/data/future-stocks.csv', exportFutureStocksCsv);
router.get('/data/instrument-summary', getInstrumentSummary);
// Strategy 2 — short straddle (entry day + next day exit)
router.post('/strategy2/run', runStrategyShortStraddleNextDay);
router.post('/strategy2/validation', postStrategyShortStraddleValidation);
router.post('/strategy2/validation-year', postStrategyShortStraddleValidationYear);
router.get('/strategy2/runs/:runId/trades', getStrategyShortStraddleRunTrades);
router.get('/strategy2/runs/:runId/validation', getStrategyShortStraddleValidation);
// Paper live (real market data, simulated fills in DB)
router.get('/live/:strategyId/status', getLiveStatus);
router.get('/live/:strategyId/meta', getLiveMeta);
router.post('/live/:strategyId/start', startLive);
router.post('/live/:strategyId/stop', stopLive);
router.post('/live/:strategyId/settings', saveLiveSettings);
router.post('/live/:strategyId/wallet/reset', resetLiveWallet);
router.get('/live/:strategyId/trades', listLiveTrades);
router.get('/live/:strategyId/trades/export', exportLiveTradesExcel);
router.post('/live/:strategyId/close', closeLivePosition);
// Manual trading console (paper — Dhan LTP, simulated fills)
router.get('/manual-console/status', getManualConsoleStatus);
// Stock Manual desk (stock futures only, no day close)
const stockEngine = require('../controllers/manualStockController');
router.get('/manual-stock/status', stockEngine.getManualStockStatus);
router.get('/manual-stock/expiries', stockEngine.getManualStockExpiries);
router.get('/manual-stock/quote', stockEngine.getManualStockQuote);
router.get('/manual-stock/instruments', stockEngine.getManualStockInstruments);
router.get('/manual-stock/future-quote', stockEngine.getManualStockFutureQuote);
router.post('/manual-stock/orders', stockEngine.postManualStockOrder);
router.delete('/manual-stock/orders/:orderId', stockEngine.deleteManualStockOrder);
router.post('/manual-stock/positions/:tradeId/close', stockEngine.postManualStockClosePosition);
router.patch('/manual-stock/positions/:tradeId/risk', stockEngine.patchManualStockPositionRisk);
router.post('/manual-stock/wallet/reset', stockEngine.postManualStockWalletReset);
router.post('/manual-stock/wallet/topup', stockEngine.postManualStockWalletTopup);
router.get('/manual-stock/trades', stockEngine.getManualStockTrades);
router.get('/manual-stock/actions', stockEngine.getManualStockActions);
router.get('/manual-console/expiries', getManualExpiries);
router.get('/manual-console/quote', getManualQuote);
router.get('/manual-console/chain', getManualChain);
router.get('/manual-console/oi-board', getManualOiBoard);
router.get('/manual-console/oi-totals', getManualOiTotals);
router.get('/manual-console/oi-flow/today', getManualOiFlowToday);
router.get('/manual-console/instruments', getManualInstruments);
router.get('/manual-console/future-quote', getManualFutureQuote);
router.post('/manual-console/orders', postManualOrder);
router.delete('/manual-console/orders/:orderId', deleteManualOrder);
router.post('/manual-console/positions/:tradeId/close', postManualClosePosition);
router.patch('/manual-console/positions/:tradeId/risk', patchManualPositionRisk);
router.get('/manual-console/trades', getManualTrades);
router.get('/manual-console/actions', getManualActions);
router.post('/manual-console/wallet/reset', postManualWalletReset);
router.post('/manual-console/wallet/topup', postManualWalletTopup);

router.get('/oi-flow/status', getOiFlowStatus);
router.get('/oi-flow/today', getOiFlowToday);
router.get('/oi-flow/day/:dateKey', getOiFlowDay);
router.get('/oi-flow/archives', getOiFlowArchives);
router.get('/oi-flow/archives/:dateKey/download', getOiFlowArchiveDownload);
router.get('/oi-flow/header-signal', getOiFlowHeaderSignal);
router.get('/oi-flow/signals', getOiFlowSignals);
router.post('/oi-flow/signals/backfill', postOiFlowSignalsBackfill);

router.get('/liquidity-oi-chase/chart', getLiquidityOiChaseChart);

module.exports = router;
