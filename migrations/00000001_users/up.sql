-- Postgres from here on. The instance ran on SQLite through the proof of
-- concept; a single unbacked-up file holding every box's agent token is not a
-- thing to launch on, and losing it makes customer boxes permanently
-- unreachable.
--
-- `is_owner` and other flags stay INTEGER rather than BOOLEAN: the application
-- writes 1/0 and reads through Boolean(), and this migration is a change of
-- engine, not a redesign of the schema.
CREATE TABLE users (
  id                 SERIAL PRIMARY KEY,
  email              TEXT UNIQUE NOT NULL,
  username           TEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL DEFAULT '',
  password           TEXT NOT NULL,
  is_owner           INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT NOT NULL DEFAULT '',
  suspended_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX users_email_idx ON users (email);
