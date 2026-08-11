-- An agent CLI's login, carried between a user's boxes.
--
-- The value is encrypted (see src/util/secretbox.ts) because it is not this
-- instance's secret: it belongs to the person who signed in, it reaches their
-- Anthropic or OpenAI account rather than anything here, and it can spend
-- their money. A database snapshot must not be a set of working logins.
--
-- Scoped to the user, not the box: the whole point is that it outlives the box
-- it was created on.
CREATE TABLE agent_logins (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tool       TEXT NOT NULL,
  path       TEXT NOT NULL,
  sealed     TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX agent_logins_one_per_file_idx ON agent_logins (user_id, tool, path);
