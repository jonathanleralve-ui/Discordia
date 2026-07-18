const db = require('../db');

// userId -> Set of socket ids (a user can have multiple tabs/devices open at once)
const onlineSockets = new Map();

async function broadcastStatus(io, userId, status) {
  await db.query('UPDATE users SET status = $1 WHERE id = $2', [status, userId]);
  io.emit('presence:update', { userId, status });
}

function addSocket(userId, socketId) {
  if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
  onlineSockets.get(userId).add(socketId);
}

// Returns true if that was the user's last open socket (i.e. they just went fully offline)
function removeSocket(userId, socketId) {
  const sockets = onlineSockets.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  const wasLast = sockets.size === 0;
  if (wasLast) onlineSockets.delete(userId);
  return wasLast;
}

module.exports = { broadcastStatus, addSocket, removeSocket };
