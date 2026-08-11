-- Reset tokens, stored as a hash for the same reason sessions are: a leaked
-- database should not hand anyone a working link. A spent row is marked with
-- used_at rather than deleted so "was that link ever used?" stays answerable
-- until the sweep takes it; the route tells nobody, answering unknown, spent
-- and expired the same way.
CREATE TABLE password_resets (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX password_resets_token_idx ON password_resets (token_hash);
