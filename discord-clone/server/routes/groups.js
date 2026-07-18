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
      group: { id: group.id, name: group.name, iconColor: group.icon_color, ownerId: group.owner_id }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  } finally {
    client.release();
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
    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, uid]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;
