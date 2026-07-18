const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const db = require('../db');
const presence = require('./presence');
const { registerMessagingHandlers } = require('./messaging');
const { registerVoiceHandlers, leaveVoiceChannel } = require('./voice');

function initSockets(io) {
  // Every socket must present a valid JWT (same one used for the REST API) before connecting
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Missing auth token'));
      const payload = jwt.verify(token, JWT_SECRET);
      socket.userId = payload.id;
      socket.username = payload.username;
      next();
    } catch (err) {
      next(new Error('Invalid auth token'));
    }
  });

  io.on('connection', async (socket) => {
    const uid = socket.userId;

    presence.addSocket(uid, socket.id);
    presence.broadcastStatus(io, uid, 'online').catch((err) => console.error('broadcastStatus error', err));

    // Personal room for DMs, plus a room per group they belong to (for message fan-out)
    socket.join(`user:${uid}`);
    try {
      const groups = await db.query('SELECT group_id FROM group_members WHERE user_id = $1', [uid]);
      groups.rows.forEach((g) => socket.join(`group:${g.group_id}`));
    } catch (err) {
      console.error('Error joining group rooms', err);
    }

    // Explicit join used when opening a group chat, in case membership changed since connect
    socket.on('group:join', async (groupId) => {
      try {
        const isMember = await db.query(
          'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
          [Number(groupId), uid]
        );
        if (isMember.rows.length > 0) socket.join(`group:${groupId}`);
      } catch (err) {
        console.error('group:join error', err);
      }
    });

    registerMessagingHandlers(io, socket, db);
    registerVoiceHandlers(io, socket, db);

    socket.on('disconnect', () => {
      if (socket.currentVoiceGroup) {
        leaveVoiceChannel(io, socket, socket.currentVoiceGroup);
      }

      const wasLast = presence.removeSocket(uid, socket.id);
      if (wasLast) {
        presence.broadcastStatus(io, uid, 'offline').catch((err) => console.error('broadcastStatus error', err));
      }
    });
  });
}

module.exports = initSockets;
