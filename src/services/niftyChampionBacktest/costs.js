/**
 * Per-order-leg option costs on the trade date (brokerage, STT, exchange, SEBI, stamp duty, GST) plus adverse
 * slippage in ticks. Every leg (buy, 70% sale, runner sale) is a separate order.
 */
const { COSTS, valueOn } = require('./config');

const r2 = (n) => Number(Number(n).toFixed(2));

/** Costs of one executed order. `price` already includes slippage. */
function legCost(dateKey, side, price, qty, brokerage) {
  const turnover = price * qty;
  const exchange = turnover * valueOn(COSTS.exchange, dateKey);
  const sebi = (turnover * COSTS.sebiPerCrore) / 1e7;
  const stt = side === 'SELL' ? turnover * valueOn(COSTS.stt, dateKey) : 0;
  const stamp = side === 'BUY' ? turnover * COSTS.stampBuyRate : 0;
  const gst = (brokerage + exchange + sebi) * COSTS.gstRate;
  return { brokerage, stt, exchange, sebi, stamp, gst };
}

/**
 * legs: [{ side: 'BUY'|'SELL', price, qty }] at the raw traded prices. Returns { gross, slippage, costs, total, net }
 * where `slippage` = ticks × tick × qty on every leg (price moved against us) and `costs` are on the slipped prices.
 */
function tradeCosts(dateKey, legs, { ticks = 0, brokerage = COSTS.brokeragePerOrder } = {}) {
  const slip = ticks * COSTS.tick;
  const sum = { brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0 };
  let gross = 0;
  let slippage = 0;
  for (const leg of legs) {
    const sign = leg.side === 'BUY' ? -1 : 1;
    gross += sign * leg.price * leg.qty;
    slippage += slip * leg.qty;
    const px = leg.side === 'BUY' ? leg.price + slip : Math.max(COSTS.tick, leg.price - slip);
    const c = legCost(dateKey, leg.side, px, leg.qty, brokerage);
    for (const k of Object.keys(sum)) sum[k] += c[k];
  }
  const costs = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, r2(v)]));
  const total = r2(Object.values(sum).reduce((s, v) => s + v, 0) + slippage);
  return { gross: r2(gross), slippage: r2(slippage), costs, total, net: r2(gross - total) };
}

module.exports = { tradeCosts };
