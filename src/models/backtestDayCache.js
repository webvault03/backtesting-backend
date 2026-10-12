const mongoose = require('mongoose');

/** Gzipped per-day market data for historical backtests (one doc per source + dateKey). */
const backtestDayCacheSchema = new mongoose.Schema(
  {
    source: { type: String, required: true },
    dateKey: { type: String, required: true },
    tradingDay: { type: Boolean, default: true },
    payload: { type: Buffer, default: null },
  },
  { timestamps: true },
);

backtestDayCacheSchema.index({ source: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('BacktestDayCache', backtestDayCacheSchema);
