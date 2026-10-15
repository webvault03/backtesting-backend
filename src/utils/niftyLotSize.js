/** NIFTY lot size by date (verify against NSE circulars / contract master). */
const NIFTY_LOT_SIZES = [
  { from: '2000-01-01', value: 75 },
  { from: '2021-07-30', value: 50 },
  { from: '2024-04-26', value: 25 },
  { from: '2024-11-20', value: 75 },
  { from: '2025-12-31', value: 65 },
];

const valueOn = (table, dateKey) => table.reduce((v, x) => (dateKey >= x.from ? x.value : v), table[0].value);
const niftyLotSizeOn = (dateKey) => valueOn(NIFTY_LOT_SIZES, dateKey);

module.exports = { NIFTY_LOT_SIZES, valueOn, niftyLotSizeOn };
