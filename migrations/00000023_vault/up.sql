-- The vault: things a person keeps, that their boxes and agents need.
--
-- Two kinds, and the split is the whole security design rather than a
-- convenience:
--
-- - A **value** is ordinary configuration. A box can read it, an agent can read
--   it, and losing it is embarrassing rather than expensive.
-- - A **secret** is a credential. A box can never read one. It can list the
--   names it is allowed to use and *spend* them through the control plane,
--   which attaches the credential upstream and returns only the response.
--
-- That asymmetry exists because a box runs code nobody has reviewed — that is
-- what a box is *for*. Anything readable there is readable by a prompt-injected
-- agent, so the answer to "can the box read my API key" has to be no, and the
-- point of the proxy is that it never needs to.
--
-- Scope resolves narrow-to-wide: a `box` entry shadows a `workspace` entry of
-- the same name, which shadows a `global` one. `scope_id` is the workspace or
-- box id, and 0 for global — a plain integer rather than two nullable columns
-- so the uniqueness index below can actually be unique.
CREATE TABLE vault_entries (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  scope        TEXT NOT NULL CHECK (scope IN ('global', 'workspace', 'box')),
  scope_id     INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('value', 'secret')),
  -- AES-256-GCM, bound by AAD to (user, scope, scope_id, name). Binding is what
  -- stops a sealed row being *moved*: copying another user's ciphertext into
  -- your own row fails the authentication tag rather than decrypting for you.
  -- Values are sealed too — the database should not be a list of everyone's
  -- configuration either.
  sealed       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- When the value was last handed out or spent. A credential nobody has read
  -- in a year is one to revoke, and this is the only way to know.
  last_used_at TIMESTAMPTZ
);

-- One entry per name per scope. Shadowing happens across scopes, never within.
CREATE UNIQUE INDEX vault_entries_key ON vault_entries (user_id, scope, scope_id, name);

-- Resolution reads every scope that could apply to one box at once.
CREATE INDEX vault_entries_lookup ON vault_entries (user_id, name);
