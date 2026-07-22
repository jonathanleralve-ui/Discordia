// DM + channel message sending, and typing indicators.

// Only trust attachment metadata that points at a file our own /api/upload
// route produced (path under /uploads/...) — never an arbitrary client-supplied
// URL — and cap the fields we store/broadcast.
function sanitizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const url = String(attachment.url || '');
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  return {
    url,
    name: String(attachment.name || 'file').slice(0, 255),
    type: String(attachment.type || 'application/octet-stream').slice(0, 100),
    size: Number(attachment.size) || 0
  };
}

function registerMessagingHandlers(io, socket, db) {
  const uid = socket.userId;

  socket.on('dm:send', async ({ recipientId, content, attachment }) => {
    try {
      const text = String(content || '').trim().slice(0, 4000);
      const att = sanitizeAttachment(attachment);
      if (!text && !att) return;
      const rid = Number(recipientId);

      const friendship = await db.query(
        `SELECT * FROM friendships WHERE status = 'accepted' AND
         ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
        [uid, rid]
      );
      if (friendship.rows.length === 0) {
        // Not friends — still allow it if they share a group (e.g. clicked
        // from the members tab), same rule enforced on the REST side.
        const sharedGroup = await db.query(
          `SELECT 1 FROM group_members gm1
           JOIN group_members gm2 ON gm2.group_id = gm1.group_id
           WHERE gm1.user_id = $1 AND gm2.user_id = $2 LIMIT 1`,
          [uid, rid]
        );
        if (sharedGroup.rows.length === 0) {
          socket.emit('error:message', { error: 'You are not friends with this user' });
          return;
        }
      }

      const inserted = await db.query(
        `INSERT INTO messages (sender_id, recipient_id, content, attachment_url, attachment_name, attachment_type, attachment_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [uid, rid, text, att && att.url, att && att.name, att && att.type, att && att.size]
      );

      const senderResult = await db.query('SELECT display_name, avatar_color, avatar_url, name_color FROM users WHERE id = $1', [uid]);
      const sender = senderResult.rows[0];

      const payload = {
        id: inserted.rows[0].id,
        content: text,
        createdAt: inserted.rows[0].created_at,
        senderId: uid,
        senderName: sender.display_name,
        senderColor: sender.avatar_color,
        senderAvatarUrl: sender.avatar_url,
        senderNameColor: sender.name_color,
        recipientId: rid,
        attachment: att
      };

      io.to(`user:${uid}`).to(`user:${rid}`).emit('dm:message', payload);
    } catch (err) {
      console.error('dm:send error', err);
      socket.emit('error:message', { error: 'Failed to send message' });
    }
  });

  socket.on('channel:send', async ({ channelId, content, attachment }) => {
    try {
      const text = String(content || '').trim().slice(0, 4000);
      const att = sanitizeAttachment(attachment);
      if (!text && !att) return;
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
        `INSERT INTO messages (sender_id, channel_id, group_id, content, attachment_url, attachment_name, attachment_type, attachment_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
        [uid, cid, channel.group_id, text, att && att.url, att && att.name, att && att.type, att && att.size]
      );

      const senderResult = await db.query('SELECT display_name, avatar_color, avatar_url, name_color FROM users WHERE id = $1', [uid]);
      const sender = senderResult.rows[0];

      const payload = {
        id: inserted.rows[0].id,
        content: text,
        createdAt: inserted.rows[0].created_at,
        senderId: uid,
        senderName: sender.display_name,
        senderColor: sender.avatar_color,
        senderAvatarUrl: sender.avatar_url,
        senderNameColor: sender.name_color,
        channelId: cid,
        attachment: att
      };

      io.to(`channel:${cid}`).emit('channel:message', payload);
    } catch (err) {
      console.error('channel:send error', err);
      socket.emit('error:message', { error: 'Failed to send message' });
    }
  });

  socket.on('typing', async ({ scope, id }) => {
    try {
      const senderResult = await db.query('SELECT display_name, name_color FROM users WHERE id = $1', [uid]);
      const sender = senderResult.rows[0];
      if (!sender) return;

      const payload = { scope, from: uid, senderName: sender.display_name, senderNameColor: sender.name_color };

      if (scope === 'dm') {
        io.to(`user:${Number(id)}`).emit('typing', payload);
      } else if (scope === 'channel') {
        socket.to(`channel:${id}`).emit('typing', { ...payload, channelId: Number(id) });
      }
    } catch (err) {
      console.error('typing error', err);
    }
  });

  // Deleting a message works the same whether it's plain text, an image,
  // or any other attachment — we only ever store/broadcast the row id, the
  // actual content (text vs. attachment) is irrelevant to removing it.
  socket.on('message:delete', async ({ messageId }) => {
    try {
      const id = Number(messageId);
      if (!Number.isInteger(id)) return;

      const result = await db.query('SELECT * FROM messages WHERE id = $1', [id]);
      const message = result.rows[0];
      if (!message) return;

      if (message.sender_id !== uid) {
        socket.emit('error:message', { error: 'You can only delete your own messages' });
        return;
      }

      await db.query('DELETE FROM messages WHERE id = $1', [id]);

      const payload = {
        id,
        channelId: message.channel_id,
        recipientId: message.recipient_id,
        senderId: message.sender_id
      };

      if (message.channel_id) {
        io.to(`channel:${message.channel_id}`).emit('message:deleted', payload);
      } else if (message.recipient_id) {
        io.to(`user:${message.sender_id}`).to(`user:${message.recipient_id}`).emit('message:deleted', payload);
      }
    } catch (err) {
      console.error('message:delete error', err);
      socket.emit('error:message', { error: 'Failed to delete message' });
    }
  });
}

module.exports = { registerMessagingHandlers };