const mongoose = require('mongoose');

const liveWalletSchema = new mongoose.Schema(
  {
    walletKey: { type: String, default: 'default', unique: true, index: true },
    startingBalance: { type: Number, required: true, default: 0 },
    balance: { type: Number, required: true, default: 0 },
    realizedPnl: { type: Number, default: 0 },
    /** Sum of winning closed trade P/L (manual console cash wallet). */
    grossProfit: { type: Number, default: 0 },
    /** Sum of |losing| closed trade P/L (manual console cash wallet). */
    grossLoss: { type: Number, default: 0 },
    totalTrades: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    lastResetAt: { type: Date, default: null },
    /** Manual console: true once cash top-ups / ledger mode is active. */
    cashLedger: { type: Boolean, default: false },
    /** Manual console paper deposit ledger (amount + time). Newest first. */
    depositHistory: {
      type: [
        {
          amount: { type: Number, required: true },
          at: { type: Date, default: Date.now },
          source: { type: String, enum: ['preset', 'custom'], default: 'preset' },
        },
      ],
      default: [],
    },
    strategy4EngineSettings: {
      symbol: { type: String, default: 'NIFTY' },
      lotCount: { type: Number, default: 1 },
      entryTime: { type: String, default: '09:20' },
      entryWindowMinutes: { type: Number, default: 2 },
      dayCloseTime: { type: String, default: '15:15' },
      skipExpiryDay: { type: Boolean, default: true },
      perTradeCost: { type: Number, default: 100 },
    },
    strategy6EngineSettings: {
      symbol: { type: String, default: 'NIFTY' },
      lotCount: { type: Number, default: 1 },
      entryTime: { type: String, default: '09:20' },
      entryWindowMinutes: { type: Number, default: 2 },
      dayCloseTime: { type: String, default: '15:15' },
      skipExpiryDay: { type: Boolean, default: true },
      perTradeCost: { type: Number, default: 100 },
    },
    /** EOD OI Walls next-day: engine settings. */
    strategy14EngineSettings: {
      symbol: { type: String, default: 'NIFTY' },
      lotCount: { type: Number, default: 5 },
      tradeFromTime: { type: String, default: '09:20' },
      tradeToTime: { type: String, default: '15:10' },
      eodExitTime: { type: String, default: '15:20' },
      eodCaptureFromTime: { type: String, default: '15:15' },
      targetPoints: { type: Number, default: 8 },
      stopLossPoints: { type: Number, default: null },
      hasStopLoss: { type: Boolean, default: false },
      proximityPoints: { type: Number, default: 20 },
      strikeLookaround: { type: Number, default: 12 },
      maxTradesPerDay: { type: Number, default: 1 },
      cooldownMinutes: { type: Number, default: 2 },
      perTradeCost: { type: Number, default: 100 },
    },
    /** Yesterday's top Put+Call OI walls for next-session entry. */
    strategy14Watchlist: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    /** EOD OI Walls Spot — Nifty cash/index proximity · default +15 · no SL. */
    strategy15EngineSettings: {
      symbol: { type: String, default: 'NIFTY' },
      lotCount: { type: Number, default: 5 },
      tradeFromTime: { type: String, default: '09:20' },
      tradeToTime: { type: String, default: '15:10' },
      eodExitTime: { type: String, default: '15:20' },
      eodCaptureFromTime: { type: String, default: '15:15' },
      targetPoints: { type: Number, default: 15 },
      stopLossPoints: { type: Number, default: null },
      hasStopLoss: { type: Boolean, default: false },
      proximityPoints: { type: Number, default: 20 },
      strikeLookaround: { type: Number, default: 12 },
      maxTradesPerDay: { type: Number, default: 1 },
      cooldownMinutes: { type: Number, default: 2 },
      perTradeCost: { type: Number, default: 100 },
    },
    /** Spot variant watchlist (separate from FUT strategy-14). */
    strategy15Watchlist: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    /** OI Flow Tracker paper (Put writing→CALL / Put buying→PUT). */
    oiFlowEngineSettings: {
      enabled: { type: Boolean, default: true },
      symbol: { type: String, default: 'NIFTY' },
      lotCount: { type: Number, default: 10 },
      tradeFromTime: { type: String, default: '09:30' },
      tradeToTime: { type: String, default: '14:30' },
      eodExitTime: { type: String, default: '15:15' },
      targetPoints: { type: Number, default: 10 },
      stopLossPoints: { type: Number, default: 8 },
      maxHoldMinutes: { type: Number, default: 15 },
      minPutOi: { type: Number, default: 250000 },
      maxPutOi: { type: Number, default: 3000000 },
      requireSpotAlign: { type: Boolean, default: true },
      cooldownMinutes: { type: Number, default: 30 },
      perTradeCost: { type: Number, default: 100 },
    },
    /** Flow Scalp Prime — Bias scalp · +2/−3 · 15m after SL · day ₹ target default off. */
    flowScalpPrimeEngineSettings: {
      enabled: { type: Boolean, default: true },
      symbol: { type: String, default: 'NIFTY' },
      lotCount: { type: Number, default: 10 },
      tradeFromTime: { type: String, default: '09:30' },
      tradeToTime: { type: String, default: '14:30' },
      eodExitTime: { type: String, default: '15:15' },
      optionSlPts: { type: Number, default: 3 },
      optionTpPts: { type: Number, default: 2 },
      perTradeCost: { type: Number, default: 100 },
      /** Day ₹ profit lock at 10 lots; 0 = off (default). Scales with lotCount when set. */
      dailyTargetInrAt10Lots: { type: Number, default: 0 },
    },
    /** Liquidity OI Chase paper (sweep+break + OI fuel). */
    liquidityOiChaseEngineSettings: {
      enabled: { type: Boolean, default: true },
      symbol: { type: String, default: 'NIFTY' },
      lotCount: { type: Number, default: 1 },
      tradeFromTime: { type: String, default: '09:30' },
      tradeToTime: { type: String, default: '14:00' },
      eodExitTime: { type: String, default: '15:15' },
      swingLength: { type: Number, default: 14 },
      oiWindowMins: { type: Number, default: 15 },
      minStreak: { type: Number, default: 2 },
      slBufferPts: { type: Number, default: 8 },
      breakBufferPts: { type: Number, default: 0 },
      maxDeltaPcrFight: { type: Number, default: 0.08 },
      maxSlAtrMult: { type: Number, default: 1.5 },
      fallbackTargetPts: { type: Number, default: 40 },
      softTargetOptionPts: { type: Number, default: 12 },
      maxTradesPerDay: { type: Number, default: 2 },
      cooldownSeconds: { type: Number, default: 300 },
      perTradeCost: { type: Number, default: 100 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.LiveWallet || mongoose.model('LiveWallet', liveWalletSchema);
