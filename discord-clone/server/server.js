const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const { JWT_SECRET, PORT } = require('./config');
const db = require('./db');

const authRoutes = require('./routes/auth');
const friendRoutes = require('./routes/friends');
const groupRoutes = require('./routes/groups');
const messageRoutes = require('./routes/messages');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/messages', messageRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to the SPA for any non-API route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Socket.io realtime layer ---
// Map of userId -> Set of socket ids (a user can have multiple tabs open)
const onlineSockets = new Map();

async function broadcastStatus(userId, status) {
  await db.query('UPDATE users SET status = $1 WHERE id = $2', [status, userId]);
  io.emit('presence:update', { userId, status });
}

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

  if (!onlineSockets.has(uid)) onlineSockets.set(uid, new Set());
  onlineSockets.get(uid).add(socket.id);
  broadcastStatus(uid, 'online').catch((err) => console.error('broadcastStatus error', err));

  // Join a personal room for DMs, plus a room per group they belong to
  socket.join(`user:${uid}`);
  try {
    const groups = await db.query('SELECT group_id FROM group_members WHERE user_id = $1', [uid]);
    groups.rows.forEach((g) => socket.join(`group:${g.group_id}`));
  } catch (err) {
    console.error('Error joining group rooms', err);
  }

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

  socket.on('dm:send', async ({ recipientId, content }) => {
    try {
      const text = String(content || '').trim().slice(0, 4000);
      if (!text) return;
      const rid = Number(recipientId);

      const friendship = await db.query(
        `SELECT * FROM friendships WHERE status = 'accepted' AND
         ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
        [uid, rid]
      );
      if (friendship.rows.length === 0) {
        socket.emit('error:message', { error: 'You are not friends with this user' });
        return;
      }

      const inserted = await db.query(
        'INSERT INTO messages (sender_id, recipient_id, content) VALUES ($1, $2, $3) RETURNING id, created_at',
        [uid, rid, text]
      );

      const senderResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [uid]);
      const sender = senderResult.rows[0];

      const payload = {
        id: inserted.rows[0].id,
        content: text,
        createdAt: inserted.rows[0].created_at,
        senderId: uid,
        senderName: sender.display_name,
        senderColor: sender.avatar_color,
        recipientId: rid
      };

      io.to(`user:${uid}`).to(`user:${rid}`).emit('dm:message', payload);
    } catch (err) {
      console.error('dm:send error', err);
      socket.emit('error:message', { error: 'Failed to send message' });
    }
  });

  socket.on('group:send', async ({ groupId, content }) => {
    try {
      const text = String(content || '').trim().slice(0, 4000);
      if (!text) return;
      const gid = Number(groupId);

      const isMember = await db.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [gid, uid]
      );
      if (isMember.rows.length === 0) {
        socket.emit('error:message', { error: 'Not a member of this group' });
        return;
      }

      const inserted = await db.query(
        'INSERT INTO messages (sender_id, group_id, content) VALUES ($1, $2, $3) RETURNING id, created_at',
        [uid, gid, text]
      );

      const senderResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [uid]);
      const sender = senderResult.rows[0];

      const payload = {
        id: inserted.rows[0].id,
        content: text,
        createdAt: inserted.rows[0].created_at,
        senderId: uid,
        senderName: sender.display_name,
        senderColor: sender.avatar_color,
        groupId: gid
      };

      io.to(`group:${gid}`).emit('group:message', payload);
    } catch (err) {
      console.error('group:send error', err);
      socket.emit('error:message', { error: 'Failed to send message' });
    }
  });

  socket.on('typing', ({ scope, id }) => {
    // scope: 'dm' | 'group', id: recipientId or groupId
    if (scope === 'dm') {
      io.to(`user:${Number(id)}`).emit('typing', { scope, from: uid });
    } else if (scope === 'group') {
      socket.to(`group:${id}`).emit('typing', { scope, from: uid, groupId: Number(id) });
    }
  });

  socket.on('disconnect', () => {
    const sockets = onlineSockets.get(uid);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineSockets.delete(uid);
        broadcastStatus(uid, 'offline').catch((err) => console.error('broadcastStatus error', err));
      }
    }
  });
});

async function start() {
  await db.init();
  server.listen(PORT, () => {
    console.log(`Discord-clone server running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
