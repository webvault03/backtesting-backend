const path = require('path');
// port number for the backend server
const PORT = process.env.PORT || 3001;
// path to the environment file
const BACKEND_ENV_PATH = path.resolve(__dirname, '..', '..', '.env');
// cache ttl in milliseconds
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Underlyings with Dhan option-chain support.
 * Indexes = weekly (intraday king). Stocks = monthly OPTSTK but liquid for daily OI / intraday.
 * Equity security IDs from Dhan instrument master (UNDERLYING_SECURITY_ID).
 */
const PRESET_SYMBOLS = {
  // Index options (NIFTY/SENSEX weekly; BANKNIFTY/FINNIFTY monthly)
  NIFTY: { securityId: '13', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  BANKNIFTY: { securityId: '25', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  SENSEX: { securityId: '51', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  FINNIFTY: { securityId: '27', exchangeSegment: 'IDX_I', instrument: 'INDEX' },

  // Banking / finance — highest stock-option OI / premium turnover
  HDFCBANK: { securityId: '1333', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  ICICIBANK: { securityId: '4963', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  SBIN: { securityId: '3045', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  AXISBANK: { securityId: '5900', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  KOTAKBANK: { securityId: '1922', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  BAJFINANCE: { securityId: '317', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  BAJAJFINSV: { securityId: '16675', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  INDUSINDBK: { securityId: '5258', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },

  // IT
  TCS: { securityId: '11536', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  INFY: { securityId: '1594', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  HCLTECH: { securityId: '7229', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  TECHM: { securityId: '13538', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  WIPRO: { securityId: '3787', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },

  // Energy / infra / conglomerate
  RELIANCE: { securityId: '2885', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  NTPC: { securityId: '11630', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  POWERGRID: { securityId: '14977', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  ONGC: { securityId: '2475', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  COALINDIA: { securityId: '20374', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  BPCL: { securityId: '526', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  ADANIENT: { securityId: '25', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },

  // Auto (TMPV = Tata Motors Passenger Vehicles — old TATAMOTORS)
  'M&M': { securityId: '2031', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  MARUTI: { securityId: '10999', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  TMPV: { securityId: '3456', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  EICHERMOT: { securityId: '910', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  HEROMOTOCO: { securityId: '1348', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },

  // Metals
  TATASTEEL: { securityId: '3499', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  JSWSTEEL: { securityId: '11723', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  HINDALCO: { securityId: '1363', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  VEDL: { securityId: '3063', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },

  // Others — strong daily option OI
  BHARTIARTL: { securityId: '10604', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  ITC: { securityId: '1660', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  LT: { securityId: '11483', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  SUNPHARMA: { securityId: '3351', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  TITAN: { securityId: '3506', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  ASIANPAINT: { securityId: '236', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  HINDUNILVR: { securityId: '1394', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  BEL: { securityId: '383', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  HAL: { securityId: '2303', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  DLF: { securityId: '14732', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  TRENT: { securityId: '1964', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
  ULTRACEMCO: { securityId: '11532', exchangeSegment: 'NSE_EQ', instrument: 'EQUITY' },
};

const DEFAULT_LOT_SIZES = {
  NIFTY: 65,
  BANKNIFTY: 30,
  SENSEX: 20,
  FINNIFTY: 60,
};

/** Default strike spacing (refined from live chain when available). */
const DEFAULT_STRIKE_STEPS = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
  FINNIFTY: 50,
  RELIANCE: 10,
  HDFCBANK: 20,
  ICICIBANK: 20,
  SBIN: 5,
  AXISBANK: 20,
  KOTAKBANK: 20,
  BAJFINANCE: 50,
  BAJAJFINSV: 20,
  INDUSINDBK: 20,
  TCS: 20,
  INFY: 20,
  HCLTECH: 20,
  TECHM: 20,
  WIPRO: 5,
  NTPC: 5,
  POWERGRID: 5,
  ONGC: 5,
  COALINDIA: 5,
  BPCL: 5,
  ADANIENT: 20,
  'M&M': 20,
  MARUTI: 100,
  TMPV: 10,
  EICHERMOT: 50,
  HEROMOTOCO: 50,
  TATASTEEL: 5,
  JSWSTEEL: 10,
  HINDALCO: 5,
  VEDL: 5,
  BHARTIARTL: 10,
  ITC: 5,
  LT: 50,
  SUNPHARMA: 20,
  TITAN: 50,
  ASIANPAINT: 20,
  HINDUNILVR: 20,
  BEL: 10,
  HAL: 50,
  DLF: 10,
  TRENT: 50,
  ULTRACEMCO: 100,
};

module.exports = {
  PORT,
  BACKEND_ENV_PATH,
  CACHE_TTL_MS,
  PRESET_SYMBOLS,
  DEFAULT_LOT_SIZES,
  DEFAULT_STRIKE_STEPS,
};
