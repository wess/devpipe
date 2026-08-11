-- Invite codes. With signups closed, this is the only way in — which matters
-- because registering leads directly to creating a box, and a box costs the
-- instance owner real money the moment it exists.
CREATE TABLE invites (
  id         SERIAL PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  used_by    INTEGER REFERENCES users (id) ON DELETE SET NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
