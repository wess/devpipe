-- Who did what. Provisioning spends money and destroying a box loses work, so
-- both need to be answerable after the fact.
CREATE TABLE audit (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX audit_created_idx ON audit (created_at);
