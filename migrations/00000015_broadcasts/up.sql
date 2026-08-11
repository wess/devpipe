-- What was sent to whom, so a second send does not repeat a message and so
-- there is an answer to "what did we tell people, and when".
CREATE TABLE broadcasts (
  id           SERIAL PRIMARY KEY,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  audience     TEXT NOT NULL DEFAULT 'claims',
  sent_count   INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  sent_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  sent_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
