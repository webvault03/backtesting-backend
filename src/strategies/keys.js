/**
 * MongoDB `strategyKey` values — keep stable so old runs stay readable.
 */

const STRATEGY_SIX_KEY = 'strategy6_short_straddle_next_day';
/** Legacy alias — Results/tradeQueries default still imports STRATEGY_TWO_KEY. */
const STRATEGY_TWO_KEY = STRATEGY_SIX_KEY;
const STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY = 'strategy6_short_straddle_next_day_live';
const STRATEGY_FOURTEEN_EOD_OI_WALLS_LIVE_KEY = 'strategy14_eod_oi_walls_live';
/** EOD OI Walls Spot — same walls logic, Nifty cash/index price (not FUT), default +15 / no SL. */
const STRATEGY_FIFTEEN_EOD_OI_WALLS_SPOT_LIVE_KEY = 'strategy15_eod_oi_walls_spot_live';
const MANUAL_CONSOLE_LIVE_KEY = 'manual_console_live';
/** Stock F&O manual trade desk (no day-close; separate wallet/book). */
const MANUAL_STOCK_LIVE_KEY = 'manual_stock_live';
/** OI Flow Tracker signal store key (paper auto-trade removed). */
const OI_FLOW_TRACKER_LIVE_KEY = 'oi_flow_tracker_live';
/** Flow Scalp Prime — live Bias scalp · +2/−3 · 15m after SL · day ₹ target default off. */
const FLOW_SCALP_PRIME_LIVE_KEY = 'flow_scalp_prime_live';

module.exports = {
  STRATEGY_SIX_KEY,
  STRATEGY_TWO_KEY,
  STRATEGY_SIX_SHORT_STRADDLE_LIVE_KEY,
  STRATEGY_FOURTEEN_EOD_OI_WALLS_LIVE_KEY,
  STRATEGY_FIFTEEN_EOD_OI_WALLS_SPOT_LIVE_KEY,
  MANUAL_CONSOLE_LIVE_KEY,
  MANUAL_STOCK_LIVE_KEY,
  OI_FLOW_TRACKER_LIVE_KEY,
  FLOW_SCALP_PRIME_LIVE_KEY,
};
