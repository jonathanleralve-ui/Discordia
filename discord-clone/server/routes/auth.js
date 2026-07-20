const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const auth = require('../middleware/auth');
const { JWT_SECRET } = require('../config');

const router = express.Router();

const COLORS = ['#5865F2', '#EB459E', '#57F287', '#FEE75C', '#ED4245', '#3BA55D', '#FAA61A'];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    status: u.status
  };
}

router.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const uname = String(username).trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) {
      return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore only' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await db.query('SELECT id FROM users WHERE username = $1', [uname]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'That username is already taken' });
    }

    const hash = bcrypt.hashSync(String(password), 10);
    const name = (displayName && String(displayName).trim()) || uname;

    const inserted = await db.query(
      `INSERT INTO users (username, display_name, password_hash, avatar_color, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [uname, name, hash, randomColor(), 'online']
    );

    const user = inserted.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const uname = String(username).trim().toLowerCase();
    const result = await db.query('SELECT * FROM users WHERE username = $1', [uname]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    await db.query('UPDATE users SET status = $1 WHERE id = $2', ['online', user.id]);

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

router.patch('/me', auth, async (req, res) => {
  try {
    const { displayName, avatarColor } = req.body || {};
    const updates = [];
    const values = [];
    let idx = 1;

    if (displayName !== undefined) {
      const name = String(displayName).trim();
      if (!name) return res.status(400).json({ error: 'Display name cannot be empty' });
      if (name.length > 32) return res.status(400).json({ error: 'Display name must be 32 characters or fewer' });
      updates.push(`display_name = $${idx++}`);
      values.push(name);
    }

    if (avatarColor !== undefined) {
      if (!COLORS.includes(avatarColor)) {
        return res.status(400).json({ error: 'Invalid avatar color' });
      }
      updates.push(`avatar_color = $${idx++}`);
      values.push(avatarColor);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    values.push(req.user.id);
    const result = await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    res.json({ user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;
