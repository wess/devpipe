-- Sessions are rows rather than self-contained tokens so that signing a device
-- out actually ends it. A stateless token stays valid until it expires no
-- matter what the user clicks.
CREATE TABLE sessions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   TEXT UNIQUE NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sessions_token_idx ON sessions (token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id);
