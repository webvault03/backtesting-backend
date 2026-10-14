const mongoose = require('mongoose');

/**
 * One header OI-Flow signal change (CALL BUY / PUT BUY / WAIT) during a session.
 * Kept separately from minute rows, which are purged on the next session day.
 */
const oiFlowHeaderSignalEventSchema = new mongoose.Schema(
  {
    symbol: { type: String, default: 'NIFTY', index: true },
    dateKey: { type: String, required: true, index: true },
    minutes: { type: Number, required: true },
    time: { type: String, required: true },
    decision: { type: String, enum: ['CALL BUY', 'PUT BUY', 'WAIT'], required: true },
    tone: { type: String, default: 'flat' },
    bias: { type: String, default: null },
    score: { type: Number, default: 0 },
    spot: { type: Number, default: null },
    reason: { type: String, default: '' },
  },
  { timestamps: true },
);

oiFlowHeaderSignalEventSchema.index({ symbol: 1, dateKey: 1, minutes: 1 }, { unique: true });

module.exports =
  mongoose.models.OiFlowHeaderSignalEvent ||
  mongoose.model('OiFlowHeaderSignalEvent', oiFlowHeaderSignalEventSchema);
