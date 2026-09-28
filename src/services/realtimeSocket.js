const { Server } = require('socket.io');
const { verifyAccessToken } = require('./adminAuthService');
const { resolveCorsOrigin } = require('../utils/corsOrigin');

let ioRef = null;

/**
 * Broadcast to all authenticated sockets. Safe no-op before init / on emit errors.
 */
function broadcast(event, payload) {
  if (!ioRef) return false;
  try {
    ioRef.emit(event, payload);
    return true;
  } catch (err) {
    console.warn('[Realtime] broadcast failed:', err.message);
    return false;
  }
}

const PAPER_LIVE_ROOMS = {
  'manual-console': 'paper-live:manual-console',
  'strategy-14': 'paper-live:strategy-14',
  'strategy-15': 'paper-live:strategy-15',
  'strategy-16': 'paper-live:strategy-16',
};

function paperLiveRoom(strategyId) {
  return PAPER_LIVE_ROOMS[String(strategyId || '').toLowerCase()] || null;
}

/** Live marks go only to pages that subscribed — not every open tab. */
function broadcastPaperLive(strategyId, payload) {
  const room = paperLiveRoom(strategyId);
  if (!ioRef || !room) return false;
  try {
    ioRef.to(room).emit('paper-live:mark', payload);
    return true;
  } catch (err) {
    console.warn('[Realtime] paper-live emit failed:', err.message);
    return false;
  }
}

/**
 * Attach Socket.IO to the HTTP server without changing Express routes.
 * Uses polling + websocket so AWS ALB / reverse proxies stay compatible.
 */
function initRealtime(httpServer) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: resolveCorsOrigin(),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use((socket, next) => {
    try {
      const token = String(
        socket.handshake?.auth?.token
          || socket.handshake?.headers?.authorization?.replace(/^Bearer\s+/i, '')
          || '',
      ).trim();
      const user = verifyAccessToken(token);
      if (!user) return next(new Error('Unauthorized'));
      socket.user = user;
      return next();
    } catch (err) {
      return next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    // Paper-live MTM / live mark snapshot (EOD OI Walls + Manual Console).
    socket.on('paper-live:subscribe', (msg = {}) => {
      const strategyId = String(msg?.strategyId || '').toLowerCase();
      const room = paperLiveRoom(strategyId);
      if (room) socket.join(room);
      try {
        let engine = null;
        if (strategyId === 'manual-console' || strategyId === 'manual-stock') {
          engine = require('./manualTradeEngine');
        } else if (strategyId === 'strategy-14') {
          engine = require('./liveEodOiWallsEngine');
        } else if (strategyId === 'strategy-15') {
          engine = require('./liveEodOiWallsSpotEngine');
        } else if (strategyId === 'strategy-16') {
          engine = require('./liveOpenOiWallsEngine');
        } else {
          return;
        }
        const snap = typeof engine.getLiveMarkSnapshot === 'function'
          ? engine.getLiveMarkSnapshot()
          : null;
        if (snap) socket.emit('paper-live:mark', snap);
      } catch (err) {
        console.warn('[Realtime] paper-live snapshot failed:', err.message);
      }
    });
  });

  ioRef = io;
  console.log('[Realtime] Socket.IO ready at /socket.io');
  return io;
}

module.exports = { initRealtime, broadcast, broadcastPaperLive };
