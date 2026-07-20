const path = require('path');

module.exports = {
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
  PORT: process.env.PORT || 3000,

  // Where uploaded chat attachments are stored on disk, and the max size
  // (in MB) accepted per file.
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'),
  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 25),

  // Postgres connection. Either set DATABASE_URL directly, or the individual
  // PG* vars below (used by docker-compose out of the box).
  DATABASE_URL: process.env.DATABASE_URL || null,
  PGHOST: process.env.PGHOST || 'localhost',
  PGPORT: process.env.PGPORT || 5432,
  PGUSER: process.env.PGUSER || 'chatter',
  PGPASSWORD: process.env.PGPASSWORD || 'chatter',
  PGDATABASE: process.env.PGDATABASE || 'chatter'
};
