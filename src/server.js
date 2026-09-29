require('dotenv').config();
const http = require('http');
const mongoose = require('mongoose');
const app = require('./app');
const { PORT } = require('./config/constants');
const { setPlatformReady } = require('./serverState');
const { scheduleDhanTokenMaintenance } = require('./services/dhanTokenScheduler');
const { hydrateDhanTokenFromMongo } = require('./services/dhanTokenPersistence');
const { scheduleNseHolidayRefresh } = require('./services/nseHolidayService');
const { initRealtime } = require('./services/realtimeSocket');
const strategySixPaperEngine = require('./services/liveShortStraddleEngineStrategy6');
const strategyFourteenPaperEngine = require('./services/liveEodOiWallsEngine');
const strategyFifteenPaperEngine = require('./services/liveEodOiWallsSpotEngine');
const strategySixteenPaperEngine = require('./services/liveOpenOiWallsEngine');
const strategySeventeenPaperEngine = require('./services/liveOiCandleAgreeEngine');

async function bootBackgroundServices() {
  try {
    const s6 = require('./services/liveShortStraddleEngineStrategy6');
    await s6.reconcileOpenTrades();
    await require('./services/liveEodOiWallsEngine').reconcileOpenTrades();
    await require('./services/liveEodOiWallsSpotEngine').reconcileOpenTrades();
    await require('./services/liveOpenOiWallsEngine').reconcileOpenTrades();
    await require('./services/liveOiCandleAgreeEngine').reconcileOpenTrades();
  } catch (err) {
    console.warn('Paper-live open-trade reconcile:', err.message);
  }

  await hydrateDhanTokenFromMongo();
  scheduleDhanTokenMaintenance();
  scheduleNseHolidayRefresh();

  try {
    const LivePaperTrade = require('./models/livePaperTrade');
    await LivePaperTrade.syncIndexes();
  } catch (err) {
    console.warn('LivePaperTrade index sync:', err.message);
  }

  try {
    const manualEngine = require('./services/manualTradeEngine');
    await manualEngine.ensureEngineRunning();
    console.log('Manual trading console engine started');
  } catch (err) {
    console.warn('Manual console engine boot:', err.message);
  }

  try {
    const flowScalpPrime = require('./services/flowScalpPrimeEngine');
    await flowScalpPrime.ensureEngineRunning();
  } catch (err) {
    console.warn('Flow Scalp Prime engine boot:', err.message);
  }

  try {
    const oiFlow = require('./services/oiFlowMinuteEngine');
    const boot = oiFlow.ensureEngineRunning();
    if (boot.ok) {
      console.log('OI flow minute recorder started (current day only)');
    }
  } catch (err) {
    console.warn('OI flow minute engine boot:', err.message);
  }

  try {
    // Rolling 7 trading-day NIFTY 5m candles in Mongo for the Liquidity Map chart.
    const liqChart = require('./services/liquidityChartHistoryService');
    liqChart.startHistoryLoop();
    console.log('Liquidity Map chart history started');
  } catch (err) {
    console.warn('Liquidity Map chart history boot:', err.message);
  }

  try {
    const boot = await strategySixPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Short straddle paper-live engine started (strategy-6)');
    } else {
      console.warn('Short straddle paper-live engine boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Short straddle paper-live engine boot failed:', err.message);
  }

  try {
    const boot = await strategyFourteenPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('EOD OI Walls paper-live started (strategy-14)');
    } else {
      console.warn('EOD OI Walls paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('EOD OI Walls paper-live boot failed:', err.message);
  }

  try {
    const boot = await strategyFifteenPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('EOD OI Walls Spot paper-live started (strategy-15)');
    } else {
      console.warn('EOD OI Walls Spot paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('EOD OI Walls Spot paper-live boot failed:', err.message);
  }

  try {
    const boot = await strategySixteenPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('Open OI Walls paper-live started (strategy-16)');
    } else {
      console.warn('Open OI Walls paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('Open OI Walls paper-live boot failed:', err.message);
  }

  try {
    const boot = await strategySeventeenPaperEngine.ensureEngineRunning();
    if (boot.ok) {
      console.log('OI + Candle Agree paper-live started (strategy-17)');
    } else {
      console.warn('OI + Candle Agree paper-live boot:', boot.error || 'unknown');
    }
  } catch (err) {
    console.warn('OI + Candle Agree paper-live boot failed:', err.message);
  }

  try {
    const { notifyDhanConnectivityRestored } = require('./services/livePaperEngineRecovery');
    const resume = await notifyDhanConnectivityRestored();
    if (
      resume.strategy6?.resumed
      || resume.strategy14?.resumed
      || resume.strategy15?.resumed
      || resume.strategy16?.resumed
      || resume.strategy17?.resumed
    ) {
      console.log('Paper-live resumed open positions from MongoDB after boot', resume);
    }
  } catch (err) {
    console.warn('Paper-live post-boot resume:', err.message);
  }

  setPlatformReady(true);
  console.log('[SERVER] Platform boot complete (paper-live + Dhan scheduler).');
}

async function start() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI missing in backend .env');
  }

  await mongoose.connect(mongoUri);
  console.log('MongoDB connected');

  try {
    const { ensurePlatformAdmin } = require('./services/adminAuthService');
    await ensurePlatformAdmin();
  } catch (err) {
    console.error('[AUTH] Admin check failed:', err.message);
    throw err;
  }

  // HTTP server so Socket.IO can share the same port (AWS / ALB friendly).
  const httpServer = http.createServer(app);
  initRealtime(httpServer);

  // Listen immediately so the frontend proxy never gets ECONNREFUSED during long engine boot.
  await new Promise((resolve) => {
    httpServer.listen(PORT, () => {
      console.log(`Backend listening on http://localhost:${PORT}`);
      resolve();
    });
  });

  bootBackgroundServices().catch((err) => {
    console.error('[SERVER] Background boot failed:', err.message);
  });
}

start().catch((error) => {
  console.error('Failed to start backend:', error.message);
  process.exit(1);
});
