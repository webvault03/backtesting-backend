/**
 * Strategy 1 Pro — "big player" version: opening-range breakouts and traps, confirmed by option OI, few trades,
 * wide stop, big targets and a trailing runner.
 */
const VERSION = 'S1P-3.0 (2026-10-15)';
const HISTORY_START = '2020-08-03';

const DEFAULT_RULE = {
  /** Opening range = 09:15–09:45; entries on candles closing 09:50–14:00. */
  entryFrom: 9 * 60 + 45,
  entryTo: 14 * 60,
  eod: 15 * 60 + 15,
  maxTradesPerDay: 2,
  /** Breakout: first close beyond the opening range by this much, body at least `breakoutBody`. */
  breakoutBuffer: 3,
  breakoutBody: 8,
  /** Stop beyond the signal candle (± 2), kept between slMin and slMax NIFTY points from entry. */
  slBuffer: 2,
  slMin: 10,
  slMax: 25,
  /** +breakevenAt → stop to entry · +t1Pts → sell t1Share · runner trails behind the last `trailCandles` candles · +targetPts → runner sold. */
  breakevenAt: 20,
  t1Pts: 30,
  t1Share: 0.5,
  trailCandles: 3,
  targetPts: 80,
  legacyLotSize: 65,
};

/** NIFTY lot size by date (verify against NSE circulars / contract master). */
const LOT_SIZES = [
  { from: '2000-01-01', value: 75 },
  { from: '2021-07-30', value: 50 },
  { from: '2024-04-26', value: 25 },
  { from: '2024-11-20', value: 75 },
  { from: '2025-12-31', value: 65 },
];

/** Option costs per executed order leg, by effective date (verify against a contract note). */
const COSTS = {
  brokeragePerOrder: 20,
  gstRate: 0.18,
  sebiPerCrore: 10,
  stampBuyRate: 0.00003,
  tick: 0.05,
  stt: [
    { from: '2000-01-01', value: 0.0005 },
    { from: '2023-04-01', value: 0.000625 },
    { from: '2024-10-01', value: 0.001 },
    { from: '2026-04-01', value: 0.0015 },
  ],
  exchange: [
    { from: '2000-01-01', value: 0.00053 },
    { from: '2024-10-01', value: 0.0003503 },
  ],
};

const FILTERS = {
  /** OI change over the 15 min ending at the signal candle's last minute. */
  oi: { windowMin: 15, minChange: 0.02, maxAgeMin: 2 },
  /** India VIX previous close above this percentile of 2021–2023 closes = extreme day (no trades). */
  vix: { trainFrom: '2021-01-01', trainTo: '2023-12-31', extreme: 0.95 },
};

const valueOn = (table, dateKey) => table.reduce((v, x) => (dateKey >= x.from ? x.value : v), table[0].value);
const lotSizeOn = (dateKey) => valueOn(LOT_SIZES, dateKey);

module.exports = { VERSION, HISTORY_START, DEFAULT_RULE, LOT_SIZES, COSTS, FILTERS, valueOn, lotSizeOn };
