const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(
  config.DATABASE_URL
    ? { connectionString: config.DATABASE_URL }
    : {
        host: config.PGHOST,
        port: config.PGPORT,
        user: config.PGUSER,
        password: config.PGPASSWORD,
        database: config.PGDATABASE
      }
);

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error', err);
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#5865F2',
  status TEXT NOT NULL DEFAULT 'offline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  icon_color TEXT NOT NULL DEFAULT '#5865F2',
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- A group ("server") is now made up of channels, same as Discord: several
-- text channels and several voice channels, organized into categories.
CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text', -- text | voice
  category TEXT NOT NULL DEFAULT 'TEXT CHANNELS',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_id);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- exactly one of recipient_id / channel_id is set
  recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages now belong to a channel rather than directly to a group.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(sender_id, recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
`;

// Postgres (especially in Docker) can take a few seconds to accept
// connections after the container starts, so retry on startup.
async function init(retries = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(SCHEMA);
      console.log('Connected to Postgres and ensured schema exists.');
      return;
    } catch (err) {
      console.log(`Postgres not ready yet (attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  init
};