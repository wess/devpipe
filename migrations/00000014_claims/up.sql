-- Usernames claimed before launch. Separate from `users` because a claim is
-- not an account: no password, nothing to sign into. It reserves a name and an
-- address so the person who wanted it gets it when accounts open.
CREATE TABLE claims (
  id           SERIAL PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  invited_at   TIMESTAMPTZ,
  redeemed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX claims_created_idx ON claims (created_at);
