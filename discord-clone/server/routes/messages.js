const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function formatMessage(m, senderMap) {
  const sender = senderMap[m.sender_id];
  return {
    id: m.id,
    content: m.content,
    createdAt: m.created_at,
    senderId: m.sender_id,
    senderName: sender ? sender.display_name : 'Unknown',
    senderColor: sender ? sender.avatar_color : '#5865F2',
    senderAvatarUrl: sender ? sender.avatar_url : null,
    senderNameColor: sender ? sender.name_color : null,
    recipientId: m.recipient_id,
    channelId: m.channel_id,
    messageType: m.message_type || 'text',
    joinRequest: m.join_request_id
      ? { id: m.join_request_id, status: m.join_request_status, userId: m.join_request_user_id, groupId: m.group_id }
      : null,
    attachment: m.attachment_url
      ? {
          url: m.attachment_url,
          name: m.attachment_name,
          type: m.attachment_type,
          size: m.attachment_size
        }
      : null
  };
}

async function buildSenderMap(messages) {
  const ids = [...new Set(messages.map((m) => m.sender_id))];
  if (ids.length === 0) return {};
  const result = await db.query('SELECT id, display_name, avatar_color, avatar_url, name_color FROM users WHERE id = ANY($1)', [ids]);
  const map = {};
  result.rows.forEach((r) => (map[r.id] = r));
  return map;
}

// DM history with a specific friend
router.get('/dm/:userId', async (req, res) => {
  try {
    const uid = req.user.id;
    const otherId = Number(req.params.userId);

    const friendshipResult = await db.query(
      `SELECT * FROM friendships WHERE status = 'accepted' AND
       ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
      [uid, otherId]
    );
    if (friendshipResult.rows.length === 0) {
      // Not friends — still allow it if they share a group (e.g. clicked
      // from the members tab), same rule enforced on the socket side.
      const sharedGroupResult = await db.query(
        `SELECT 1 FROM group_members gm1
         JOIN group_members gm2 ON gm2.group_id = gm1.group_id
         WHERE gm1.user_id = $1 AND gm2.user_id = $2 LIMIT 1`,
        [uid, otherId]
      );
      if (sharedGroupResult.rows.length === 0) {
        return res.status(403).json({ error: 'You are not friends with this user' });
      }
    }

    const messagesResult = await db.query(
      `SELECT * FROM messages WHERE
       (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY id ASC LIMIT 200`,
      [uid, otherId]
    );

    const senderMap = await buildSenderMap(messagesResult.rows);
    res.json({ messages: messagesResult.rows.map((m) => formatMessage(m, senderMap)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Message history for a single text channel
router.get('/channel/:channelId', async (req, res) => {
  try {
    const uid = req.user.id;
    const channelId = Number(req.params.channelId);

    const channelResult = await db.query('SELECT * FROM channels WHERE id = $1', [channelId]);
    const channel = channelResult.rows[0];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [channel.group_id, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const messagesResult = await db.query(
      `SELECT m.*, gjr.status AS join_request_status, gjr.user_id AS join_request_user_id
       FROM messages m
       LEFT JOIN group_join_requests gjr ON gjr.id = m.join_request_id
       WHERE m.channel_id = $1 ORDER BY m.id ASC LIMIT 200`,
      [channelId]
    );

    const senderMap = await buildSenderMap(messagesResult.rows);
    res.json({ messages: messagesResult.rows.map((m) => formatMessage(m, senderMap)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;