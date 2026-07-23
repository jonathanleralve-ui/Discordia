const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

async function isGroupMember(groupId, userId) {
  const result = await db.query(
    'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
    [groupId, userId]
  );
  return result.rows.length > 0;
}

// Same idea as the equivalent helper in routes/groups.js — every connected
// socket always sits in its own `user:${id}` room, so this is how we reach
// "everyone currently in this group" without a dedicated group-wide room.
async function memberUserIds(groupId) {
  const result = await db.query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
  return result.rows.map((r) => r.user_id);
}
function memberRooms(userIds) {
  return userIds.map((id) => `user:${id}`);
}

function formatChannel(c) {
  return {
    id: c.id,
    groupId: c.group_id,
    name: c.name,
    type: c.type,
    category: c.category,
    position: c.position
  };
}

// List a group's channels (text + voice), ordered by category then position
router.get('/groups/:groupId/channels', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);

    if (!(await isGroupMember(groupId, uid))) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const result = await db.query(
      'SELECT * FROM channels WHERE group_id = $1 ORDER BY category ASC, position ASC, id ASC',
      [groupId]
    );

    res.json({ channels: result.rows.map(formatChannel) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Create a new text or voice channel in a group.
// Any member can create one, same as a small self-hosted server among friends.
router.post('/groups/:groupId/channels', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);

    if (!(await isGroupMember(groupId, uid))) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const { name, type } = req.body || {};
    const cleanName = String(name || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 50);
    if (!cleanName) return res.status(400).json({ error: 'Channel name is required' });

    const cleanType = type === 'voice' ? 'voice' : 'text';
    const category = cleanType === 'voice' ? 'VOICE CHANNELS' : 'TEXT CHANNELS';

    const posResult = await db.query(
      'SELECT COALESCE(MAX(position), -1) AS maxpos FROM channels WHERE group_id = $1 AND category = $2',
      [groupId, category]
    );
    const nextPos = Number(posResult.rows[0].maxpos) + 1;

    const inserted = await db.query(
      'INSERT INTO channels (group_id, name, type, category, position) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [groupId, cleanName, cleanType, category, nextPos]
    );
    const channel = formatChannel(inserted.rows[0]);

    const io = req.app.get('io');
    const memberIds = await memberUserIds(groupId);
    const rooms = memberRooms(memberIds);
    io.to(rooms).emit('channel:created', { channel });
    // Members who are already connected won't have joined this brand new
    // channel's room on their own — do it for them so a message sent into
    // it right away still reaches them without an explicit channel:join.
    io.in(rooms).socketsJoin(`channel:${channel.id}`);

    res.status(201).json({ channel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Rename a channel — any group member can do it
router.patch('/channels/:channelId', async (req, res) => {
  try {
    const uid = req.user.id;
    const channelId = Number(req.params.channelId);

    const channelResult = await db.query('SELECT * FROM channels WHERE id = $1', [channelId]);
    const channel = channelResult.rows[0];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (!(await isGroupMember(channel.group_id, uid))) {
      return res.status(403).json({ error: 'Only group members can rename channels' });
    }

    const { name } = req.body || {};
    const cleanName = String(name || '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 50);
    if (!cleanName) return res.status(400).json({ error: 'Channel name is required' });

    const updated = await db.query('UPDATE channels SET name = $2 WHERE id = $1 RETURNING *', [channelId, cleanName]);
    const updatedChannel = formatChannel(updated.rows[0]);

    const io = req.app.get('io');
    const memberIds = await memberUserIds(channel.group_id);
    io.to(memberRooms(memberIds)).emit('channel:renamed', { channel: updatedChannel });

    res.json({ channel: updatedChannel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Delete a channel — any group member can do it
router.delete('/channels/:channelId', async (req, res) => {
  try {
    const uid = req.user.id;
    const channelId = Number(req.params.channelId);

    const channelResult = await db.query('SELECT * FROM channels WHERE id = $1', [channelId]);
    const channel = channelResult.rows[0];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (!(await isGroupMember(channel.group_id, uid))) {
      return res.status(403).json({ error: 'Only group members can delete channels' });
    }

    await db.query('DELETE FROM channels WHERE id = $1', [channelId]);

    const io = req.app.get('io');
    const memberIds = await memberUserIds(channel.group_id);
    io.to(memberRooms(memberIds)).emit('channel:deleted', { channelId, groupId: channel.group_id });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;