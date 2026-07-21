const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url,
    nameColor: u.name_color,
    status: u.status
  };
}

const COLORS = ['#5865F2', '#EB459E', '#57F287', '#FEE75C', '#ED4245', '#3BA55D', '#FAA61A'];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// List groups the current user belongs to
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT g.* FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at ASC`,
      [req.user.id]
    );

    res.json({
      groups: result.rows.map((g) => ({
        id: g.id,
        name: g.name,
        iconColor: g.icon_color,
        iconUrl: g.icon_url,
        ownerId: g.owner_id
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Create a group (creator becomes owner + member); optional initial member usernames/ids
router.post('/', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { name, memberIds } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Group name is required' });

    const uid = req.user.id;

    await client.query('BEGIN');

    const inserted = await client.query(
      'INSERT INTO groups (name, icon_color, owner_id) VALUES ($1, $2, $3) RETURNING *',
      [String(name).trim().slice(0, 50), randomColor(), uid]
    );
    const group = inserted.rows[0];

    await client.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [group.id, uid]);

    if (Array.isArray(memberIds)) {
      for (const mid of memberIds) {
        if (Number(mid) !== uid) {
          await client.query(
            'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [group.id, Number(mid)]
          );
        }
      }
    }

    await client.query('COMMIT');

    res.status(201).json({
      group: { id: group.id, name: group.name, iconColor: group.icon_color, iconUrl: group.icon_url, ownerId: group.owner_id }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  } finally {
    client.release();
  }
});

// Rename a group — any group member can do it, same as channels
router.patch('/:groupId', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Only group members can rename this group' });

    const { name, iconUrl } = req.body || {};
    const cleanName = String(name || '').trim().slice(0, 50);
    if (!cleanName) return res.status(400).json({ error: 'Group name is required' });

    const updated = await db.query(
      'UPDATE groups SET name = $2, icon_url = $3 WHERE id = $1 RETURNING *',
      [groupId, cleanName, iconUrl || null]
    );
    const group = updated.rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    res.json({ group: { id: group.id, name: group.name, iconColor: group.icon_color, iconUrl: group.icon_url, ownerId: group.owner_id } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Get members of a group (must be a member)
router.get('/:groupId/members', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const result = await db.query(
      `SELECT u.* FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`,
      [groupId]
    );

    res.json({ members: result.rows.map(publicUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Search groups by name — includes groups the user already belongs to
// (flagged via isMember) so they show an "Already in it" tag instead of
// being hidden entirely.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ groups: [] });

    const result = await db.query(
      `SELECT g.*,
              (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS member_count,
              EXISTS (
                SELECT 1 FROM group_members gm3 WHERE gm3.group_id = g.id AND gm3.user_id = $2
              ) AS is_member,
              EXISTS (
                SELECT 1 FROM group_join_requests gjr
                WHERE gjr.group_id = g.id AND gjr.user_id = $2 AND gjr.status = 'pending'
              ) AS pending_request
       FROM groups g
       WHERE g.name ILIKE $1
       ORDER BY g.name ASC
       LIMIT 10`,
      [`%${q}%`, req.user.id]
    );

    res.json({
      groups: result.rows.map((g) => ({
        id: g.id,
        name: g.name,
        iconColor: g.icon_color,
        iconUrl: g.icon_url,
        ownerId: g.owner_id,
        memberCount: Number(g.member_count),
        isMember: g.is_member,
        pendingRequest: g.pending_request
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Request to join a group. Instead of adding the requester immediately, this
// posts a "wants to join" card into the group's default text channel — any
// existing member can accept it from chat (see /:groupId/join-requests/:id/accept).
router.post('/:groupId/join-requests', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group' });

    const groupResult = await db.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    const group = groupResult.rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length > 0) return res.status(400).json({ error: 'You are already in this group' });

    const existing = await db.query(
      `SELECT * FROM group_join_requests WHERE group_id = $1 AND user_id = $2 AND status = 'pending'`,
      [groupId, uid]
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({ requestId: existing.rows[0].id, alreadyPending: true });
    }

    const inserted = await db.query(
      `INSERT INTO group_join_requests (group_id, user_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [groupId, uid]
    );
    const request = inserted.rows[0];

    // Post the request as a message in the group's first text channel
    // ("general", by convention) so members see and can act on it in chat.
    const channelResult = await db.query(
      `SELECT * FROM channels WHERE group_id = $1 AND type = 'text' ORDER BY position ASC, id ASC LIMIT 1`,
      [groupId]
    );
    const channel = channelResult.rows[0];

    if (channel) {
      const msgInserted = await db.query(
        `INSERT INTO messages (sender_id, channel_id, group_id, content, message_type, join_request_id)
         VALUES ($1, $2, $3, '', 'join_request', $4) RETURNING id, created_at`,
        [uid, channel.id, groupId, request.id]
      );
      const requesterResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [uid]);
      const requester = requesterResult.rows[0];

      const io = req.app.get('io');
      io.to(`channel:${channel.id}`).emit('channel:message', {
        id: msgInserted.rows[0].id,
        content: '',
        createdAt: msgInserted.rows[0].created_at,
        senderId: uid,
        senderName: requester.display_name,
        senderColor: requester.avatar_color,
        channelId: channel.id,
        messageType: 'join_request',
        joinRequest: { id: request.id, status: 'pending', userId: uid, groupId }
      });
    }

    res.status(201).json({ requestId: request.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Accept a pending join request (any existing member can do this)
router.post('/:groupId/join-requests/:requestId/accept', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const requestId = Number(req.params.requestId);

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const requestResult = await db.query(
      'SELECT * FROM group_join_requests WHERE id = $1 AND group_id = $2',
      [requestId, groupId]
    );
    const request = requestResult.rows[0];
    if (!request) return res.status(404).json({ error: 'Join request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'This request was already resolved' });

    await db.query(`UPDATE group_join_requests SET status = 'accepted' WHERE id = $1`, [requestId]);
    await db.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, request.user_id]
    );

    const groupResult = await db.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    const group = groupResult.rows[0];

    const io = req.app.get('io');

    const msgResult = await db.query('SELECT channel_id FROM messages WHERE join_request_id = $1 LIMIT 1', [requestId]);
    const channelId = msgResult.rows[0] && msgResult.rows[0].channel_id;
    if (channelId) {
      io.to(`channel:${channelId}`).emit('group:join-request-resolved', { requestId, groupId, status: 'accepted' });

      // Post a "X has joined the server" system line in the same channel so
      // everyone watching chat sees the group gain a member in real time.
      const joinerResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [request.user_id]);
      const joiner = joinerResult.rows[0];

      const systemMsgInserted = await db.query(
        `INSERT INTO messages (sender_id, channel_id, group_id, content, message_type)
         VALUES ($1, $2, $3, $4, 'system') RETURNING id, created_at`,
        [request.user_id, channelId, groupId, `${joiner.display_name} has joined the server`]
      );

      io.to(`channel:${channelId}`).emit('channel:message', {
        id: systemMsgInserted.rows[0].id,
        content: `${joiner.display_name} has joined the server`,
        createdAt: systemMsgInserted.rows[0].created_at,
        senderId: request.user_id,
        senderName: joiner.display_name,
        senderColor: joiner.avatar_color,
        channelId,
        messageType: 'system'
      });
    }

    // The requester isn't in the channel room yet, so notify them directly
    // so their client can refresh its group list and open the new group.
    io.to(`user:${request.user_id}`).emit('group:joined', {
      group: { id: group.id, name: group.name, iconColor: group.icon_color, iconUrl: group.icon_url, ownerId: group.owner_id }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Decline a pending join request (any existing member can do this)
router.post('/:groupId/join-requests/:requestId/decline', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const requestId = Number(req.params.requestId);

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const requestResult = await db.query(
      'SELECT * FROM group_join_requests WHERE id = $1 AND group_id = $2',
      [requestId, groupId]
    );
    const request = requestResult.rows[0];
    if (!request) return res.status(404).json({ error: 'Join request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'This request was already resolved' });

    await db.query(`UPDATE group_join_requests SET status = 'declined' WHERE id = $1`, [requestId]);

    const io = req.app.get('io');

    const msgResult = await db.query('SELECT channel_id FROM messages WHERE join_request_id = $1 LIMIT 1', [requestId]);
    const channelId = msgResult.rows[0] && msgResult.rows[0].channel_id;
    if (channelId) {
      io.to(`channel:${channelId}`).emit('group:join-request-resolved', { requestId, groupId, status: 'declined' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Add a friend to a group
router.post('/:groupId/members', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const { userId } = req.body || {};

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const targetResult = await db.query('SELECT * FROM users WHERE id = $1', [Number(userId)]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });

    await db.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, target.id]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Leave a group
router.delete('/:groupId/members/me', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);

    const userResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [uid]);
    const user = userResult.rows[0];

    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, uid]);

    // Announce the departure in the group's default text channel, same place
    // "X has joined the server" is posted on accept.
    const channelResult = await db.query(
      `SELECT * FROM channels WHERE group_id = $1 AND type = 'text' ORDER BY position ASC, id ASC LIMIT 1`,
      [groupId]
    );
    const channel = channelResult.rows[0];

    if (channel && user) {
      const systemMsgInserted = await db.query(
        `INSERT INTO messages (sender_id, channel_id, group_id, content, message_type)
         VALUES ($1, $2, $3, $4, 'system') RETURNING id, created_at`,
        [uid, channel.id, groupId, `${user.display_name} has left the server`]
      );

      const io = req.app.get('io');
      io.to(`channel:${channel.id}`).emit('channel:message', {
        id: systemMsgInserted.rows[0].id,
        content: `${user.display_name} has left the server`,
        createdAt: systemMsgInserted.rows[0].created_at,
        senderId: uid,
        senderName: user.display_name,
        senderColor: user.avatar_color,
        channelId: channel.id,
        messageType: 'system'
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;
