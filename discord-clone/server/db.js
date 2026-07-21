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
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

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

-- Joining a group now requires an existing member to accept the request
-- (posted as a message in the group's default channel) rather than adding
-- the requester immediately.
--
-- NOTE: this used to have a UNIQUE(group_id, user_id) constraint so a repeat
-- request would upsert the same row (see the old ON CONFLICT insert in
-- routes/groups.js). That meant a user leaving and requesting to join again
-- reused the exact same request id, so the old (already-resolved) "invite"
-- message in chat and the new (pending) one both pointed at the same row and
-- always showed identical status. Each request now gets its own row/id;
-- only-one-*pending*-request-at-a-time is enforced in the route handler.
CREATE TABLE IF NOT EXISTS group_join_requests (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration for databases created before this constraint was removed. The
-- constraint's name depends on how/when the table was originally created
-- (inline UNIQUE(...) gets an auto-generated name, and older revisions of
-- this file also created a separately named unique index), so rather than
-- guessing a name and risking a silent no-op via "IF EXISTS", look up
-- whatever unique constraint(s) actually exist on these two columns and
-- drop them by their real name.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'group_join_requests'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE group_join_requests DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
DROP INDEX IF EXISTS idx_group_join_requests_unique;

-- Non-unique index to keep the "is there already a pending request"/search
-- lookups fast now that a (group_id, user_id) pair can have many rows.
CREATE INDEX IF NOT EXISTS idx_group_join_requests_lookup ON group_join_requests(group_id, user_id, status);

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

-- A message may carry a single file attachment (image, video, or any other
-- file) alongside or instead of text content.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER;

-- content used to be required; attachment-only messages send an empty string.
ALTER TABLE messages ALTER COLUMN content SET DEFAULT '';

-- A message can represent a group join request instead of regular chat text,
-- rendered as an "X wants to join" card with an Accept action.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS join_request_id INTEGER REFERENCES group_join_requests(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(sender_id, recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
`;

// Postgres (especially in Docker) can take a few seconds to accept
// connections after the container starts, so retry on startup — but only
// for actual connectivity errors. A real error in the SCHEMA string (e.g. a
// bad migration statement) isn't a "not ready yet" situation and used to
// get logged as one, then silently retried 20 times before finally
// surfacing, which made it very hard to tell "Postgres is still booting"
// apart from "the schema migration is broken".
const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', '57P03', '08006', '08001', '08004']);

async function init(retries = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(SCHEMA);
      console.log('Connected to Postgres and ensured schema exists.');
      return;
    } catch (err) {
      if (!CONNECTION_ERROR_CODES.has(err.code)) {
        console.error('Postgres schema setup failed (this is a real error, not a "not ready yet" retry):', err.message);
        throw err;
      }
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