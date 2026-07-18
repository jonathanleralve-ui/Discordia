module.exports = {
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
  PORT: process.env.PORT || 3000,

  // Postgres connection. Either set DATABASE_URL directly, or the individual
  // PG* vars below (used by docker-compose out of the box).
  DATABASE_URL: process.env.DATABASE_URL || null,
  PGHOST: process.env.PGHOST || 'localhost',
  PGPORT: process.env.PGPORT || 5432,
  PGUSER: process.env.PGUSER || 'chatter',
  PGPASSWORD: process.env.PGPASSWORD || 'chatter',
  PGDATABASE: process.env.PGDATABASE || 'chatter'
};
