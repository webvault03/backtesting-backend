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

const valueOn = (table, dateKey) => table.reduce((v, x) => (dateKey >= x.from ? x.value : v), table[0].value);
const lotSizeOn = (dateKey) => valueOn(LOT_SIZES, dateKey);

module.exports = { LOT_SIZES, COSTS, valueOn, lotSizeOn };
