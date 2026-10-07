const mongoose = require('mongoose');

/**
 * One IST trading day's average buying / selling price for NIFTY, estimated from
 * NIFTY futures 1-min OHLC + volume (close-location volume split).
 * Upserted on every refresh during the session; last write after 15:30 is the final summary.
 */
const niftyAvgBuySellDaySchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true, default: 'NIFTY' },
    dateKey: { type: String, required: true },
    futures: {
      securityId: String,
      expiry: String,
      tradingSymbol: String,
    },
    summary: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** Per-minute running values: { t, futClose, spot, avgBuy, avgSell, vwap, buyVol, sellVol } */
    points: { type: mongoose.Schema.Types.Mixed, default: [] },
    barCount: { type: Number, default: 0 },
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

niftyAvgBuySellDaySchema.index({ symbol: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('NiftyAvgBuySellDay', niftyAvgBuySellDaySchema);
