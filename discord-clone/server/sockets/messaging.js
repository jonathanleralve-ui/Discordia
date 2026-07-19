// DM + channel message sending, and typing indicators.

function registerMessagingHandlers(io, socket, db) {
  const uid = socket.userId;

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

  socket.on('channel:send', async ({ channelId, content }) => {
    try {
      const text = String(content || '').trim().slice(0, 4000);
      if (!text) return;
      const cid = Number(channelId);

      const channelResult = await db.query('SELECT * FROM channels WHERE id = $1', [cid]);
      const channel = channelResult.rows[0];
      if (!channel) {
        socket.emit('error:message', { error: 'Channel not found' });
        return;
      }

      const isMember = await db.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [channel.group_id, uid]
      );
      if (isMember.rows.length === 0) {
        socket.emit('error:message', { error: 'Not a member of this group' });
        return;
      }

      const inserted = await db.query(
        'INSERT INTO messages (sender_id, channel_id, group_id, content) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
        [uid, cid, channel.group_id, text]
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
        channelId: cid
      };

      io.to(`channel:${cid}`).emit('channel:message', payload);
    } catch (err) {
      console.error('channel:send error', err);
      socket.emit('error:message', { error: 'Failed to send message' });
    }
  });

  socket.on('typing', ({ scope, id }) => {
    // scope: 'dm' | 'channel', id: recipientId or channelId
    if (scope === 'dm') {
      io.to(`user:${Number(id)}`).emit('typing', { scope, from: uid });
    } else if (scope === 'channel') {
      socket.to(`channel:${id}`).emit('typing', { scope, from: uid, channelId: Number(id) });
    }
  });
}

module.exports = { registerMessagingHandlers };