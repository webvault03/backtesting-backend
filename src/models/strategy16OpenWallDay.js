const mongoose = require('mongoose');

/**
 * Daily Strategy-16 Open OI Walls capture (lookaround 12 absolute max Put/Call OI).
 * Survives wallet clears so honest backtests can rebuild days correctly.
 */
const strategy16OpenWallDaySchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY', index: true },
    dateKey: { type: String, required: true, index: true },
    capturedAt: { type: Date, default: Date.now },
    captureMinutes: { type: Number, default: 555 },
    spotAtCapture: { type: Number, default: null },
    futAtCapture: { type: Number, default: null },
    expiry: { type: String, default: null },
    lookaroundStrikes: { type: Number, default: 12 },
    walls: { type: [mongoose.Schema.Types.Mixed], default: [] },
    source: { type: String, default: 'live_engine' },
    notes: { type: String, default: null },
  },
  { timestamps: true },
);

strategy16OpenWallDaySchema.index({ symbol: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('Strategy16OpenWallDay', strategy16OpenWallDaySchema);
