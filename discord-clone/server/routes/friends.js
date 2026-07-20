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
    status: u.status
  };
}

// Search users by username (excluding self)
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ users: [] });
    const result = await db.query(
      'SELECT * FROM users WHERE username ILIKE $1 AND id != $2 LIMIT 10',
      [`%${q}%`, req.user.id]
    );
    res.json({ users: result.rows.map(publicUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// List friends (accepted) + incoming/outgoing pending requests
router.get('/', async (req, res) => {
  try {
    const uid = req.user.id;

    const accepted = await db.query(
      `SELECT u.*, f.id as friendship_id FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'`,
      [uid]
    );

    const incoming = await db.query(
      `SELECT u.*, f.id as friendship_id FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = $1 AND f.status = 'pending'`,
      [uid]
    );

    const outgoing = await db.query(
      `SELECT u.*, f.id as friendship_id FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = $1 AND f.status = 'pending'`,
      [uid]
    );

    res.json({
      friends: accepted.rows.map((u) => ({ ...publicUser(u), friendshipId: u.friendship_id })),
      incoming: incoming.rows.map((u) => ({ ...publicUser(u), friendshipId: u.friendship_id })),
      outgoing: outgoing.rows.map((u) => ({ ...publicUser(u), friendshipId: u.friendship_id }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Send a friend request by username
router.post('/request', async (req, res) => {
  try {
    const { username } = req.body || {};
    const uid = req.user.id;
    if (!username) return res.status(400).json({ error: 'Username is required' });

    const uname = String(username).trim().toLowerCase();
    const targetResult = await db.query('SELECT * FROM users WHERE username = $1', [uname]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: 'No user with that username' });
    if (target.id === uid) return res.status(400).json({ error: "You can't add yourself" });

    const existingResult = await db.query(
      `SELECT * FROM friendships WHERE
       (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [uid, target.id]
    );
    const existing = existingResult.rows[0];

    if (existing) {
      if (existing.status === 'accepted') return res.status(409).json({ error: 'You are already friends' });
      if (existing.status === 'pending') return res.status(409).json({ error: 'A friend request already exists' });
    }

    await db.query(
      'INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, $3)',
      [uid, target.id, 'pending']
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Accept a pending request
router.post('/:friendshipId/accept', async (req, res) => {
  try {
    const uid = req.user.id;
    const result = await db.query('SELECT * FROM friendships WHERE id = $1', [req.params.friendshipId]);
    const fr = result.rows[0];
    if (!fr || fr.addressee_id !== uid) return res.status(404).json({ error: 'Request not found' });
    await db.query("UPDATE friendships SET status = 'accepted' WHERE id = $1", [fr.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Decline / cancel / remove a friendship
router.delete('/:friendshipId', async (req, res) => {
  try {
    const uid = req.user.id;
    const result = await db.query('SELECT * FROM friendships WHERE id = $1', [req.params.friendshipId]);
    const fr = result.rows[0];
    if (!fr || (fr.requester_id !== uid && fr.addressee_id !== uid)) {
      return res.status(404).json({ error: 'Request not found' });
    }
    await db.query('DELETE FROM friendships WHERE id = $1', [fr.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;
