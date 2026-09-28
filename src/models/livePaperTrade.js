const mongoose = require('mongoose');

const livePaperTradeSchema = new mongoose.Schema(
  {
    strategyKey: { type: String, required: true, index: true },
    symbol: { type: String, required: true, index: true },
    side: { type: String, enum: ['LONG', 'SHORT', 'SELL'], required: true },
    optionType: { type: String, enum: ['CE', 'PE', 'STRADDLE', 'FUT'], required: true },
    /** OPTION (CE/PE) or FUTURE (direct stock/index future). */
    product: { type: String, enum: ['OPTION', 'FUTURE'], default: 'OPTION' },
    strike: { type: Number, required: true },
    expiryDate: { type: String, default: null },
    lotSize: { type: Number, required: true },
    lots: { type: Number, required: true, default: 1 },
    qty: { type: Number, required: true },
    entryPremium: { type: Number, required: true },
    entrySpot: { type: Number, required: true },
    entryTime: { type: Date, required: true },
    stopLossPremium: { type: Number, default: null },
    targetPremium: { type: Number, default: null },
    /** How SL/target were entered: PCT, POINTS (exact premium), or AMOUNT (₹ gross P/L). */
    stopLossMode: { type: String, enum: ['PCT', 'POINTS', 'AMOUNT'], default: null },
    targetMode: { type: String, enum: ['PCT', 'POINTS', 'AMOUNT'], default: null },
    /** When mode is AMOUNT — gross ₹ profit/loss at exit (before charges). */
    stopLossAmount: { type: Number, default: null },
    targetAmount: { type: Number, default: null },
    entryCredit: { type: Number, default: null },
    exitDebit: { type: Number, default: null },
    legs: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    entryDateKey: { type: String, default: null, index: true },
    exitDateKey: { type: String, default: null, index: true },
    refHigh: { type: Number, default: null },
    targetSpot: { type: Number, default: null },
    combinedStopSpot: { type: Number, default: null },
    exitPremium: { type: Number, default: null },
    exitSpot: { type: Number, default: null },
    exitTime: { type: Date, default: null },
    status: { type: String, enum: ['OPEN', 'CLOSED'], default: 'OPEN', index: true },
    reason: { type: String, default: null },
    /** Short human reason for why the entry was taken (scalp / signals). */
    entryReason: { type: String, default: null },
    investedAmount: { type: Number, required: true },
    /** Cash reserved from paper wallet at fill (options: premium×qty+charges; futures: margin+charges). */
    capitalLocked: { type: Number, default: null },
    creditReceived: { type: Number, default: null },
    finalValue: { type: Number, default: null },
    charges: { type: Number, default: 100 },
    pnl: { type: Number, default: null },
    pnlPct: { type: Number, default: null },
    notes: { type: String, default: null },
    entryIvProxy: { type: Number, default: null },
    medianIvProxy: { type: Number, default: null },
    highSinceEntry: { type: Number, default: null },
    lowSinceEntry: { type: Number, default: null },
    /** Latest open MTM snapshot (refreshed ~every 6s while position is open). */
    openPositionMark: { type: mongoose.Schema.Types.Mixed, default: null },
    openPositionMarkAt: { type: Date, default: null },
    /** OI Flow (and similar): matched rules / OI acts at entry for history eye popup. */
    signalSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Manual console: testing trades stay off calendar / wallet P/L / main history. */
    isTesting: { type: Boolean, default: false, index: true },
    /**
     * Legacy: fill entered after a day's ₹ target was already hit
     * (continuation book). Kept for historical trade documents.
     */
    afterDayTarget: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

livePaperTradeSchema.index({ entryTime: -1 });
livePaperTradeSchema.index({ strategyKey: 1, exitTime: 1 });

module.exports =
  mongoose.models.LivePaperTrade || mongoose.model('LivePaperTrade', livePaperTradeSchema);
