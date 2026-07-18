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
    recipientId: m.recipient_id,
    groupId: m.group_id
  };
}

async function buildSenderMap(messages) {
  const ids = [...new Set(messages.map((m) => m.sender_id))];
  if (ids.length === 0) return {};
  const result = await db.query('SELECT id, display_name, avatar_color FROM users WHERE id = ANY($1)', [ids]);
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
      return res.status(403).json({ error: 'You are not friends with this user' });
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

// Group chat history
router.get('/group/:groupId', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const messagesResult = await db.query(
      'SELECT * FROM messages WHERE group_id = $1 ORDER BY id ASC LIMIT 200',
      [groupId]
    );

    const senderMap = await buildSenderMap(messagesResult.rows);
    res.json({ messages: messagesResult.rows.map((m) => formatMessage(m, senderMap)) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;
