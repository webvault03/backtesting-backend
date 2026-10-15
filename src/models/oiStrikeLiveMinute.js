const mongoose = require('mongoose');

/**
 * OI Strike Report (live) — minute tape for the current session day only.
 * One document per IST minute: NIFTY 1-min OHLC + nearest weekly CE / PE price OHLC, last OI and the
 * previous day's closing OI per strike. Older days are deleted when a new session day starts
 * (Friday is kept through Sat / Sun, wiped on Monday).
 */
const legSchema = new mongoose.Schema(
  {
    strike: { type: Number, required: true },
    side: { type: String, enum: ['CE', 'PE'], required: true },
    o: Number,
    h: Number,
    l: Number,
    c: Number,
    oi: { type: Number, default: null },
    prevOi: { type: Number, default: null },
  },
  { _id: false },
);

const oiStrikeLiveMinuteSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY' },
    dateKey: { type: String, required: true },
    minutes: { type: Number, required: true },
    time: { type: String, required: true },
    expiry: { type: String, default: null },
    nifty: {
      o: Number,
      h: Number,
      l: Number,
      c: Number,
    },
    legs: { type: [legSchema], default: [] },
    ticks: { type: Number, default: 0 },
    /** live_chain = recorded from the option chain · dhan_history = filled after a late start. */
    source: { type: String, default: 'live_chain' },
  },
  { timestamps: true, collection: 'oi_strike_live_minutes' },
);

oiStrikeLiveMinuteSchema.index({ symbol: 1, dateKey: 1, minutes: 1 }, { unique: true });

module.exports =
  mongoose.models.OiStrikeLiveMinute
  || mongoose.model('OiStrikeLiveMinute', oiStrikeLiveMinuteSchema);
