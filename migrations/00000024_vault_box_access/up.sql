-- How a box reaches the vault, and what it is allowed to see there.
--
-- A box needs a credential to ask the control plane anything, and an agent
-- running on that box can read whatever the box can read — that is what a box
-- is for, and no arrangement of file permissions changes it. So the credential
-- is not protected by being secret. It is made safe by being *narrow*:
--
-- - It authorises the vault and nothing else, which is why it is not
--   `agent_token`. That token gates attaching to the box's terminal; one secret
--   doing two unrelated jobs means rotating it for either reason breaks the
--   other.
-- - It resolves only that box's own scope chain — its box entries, its
--   workspace's, and the account's globals. Never another box's.
-- - It dies with the box.
--
-- Stored as a hash. The control plane never needs the token back, only to
-- recognise it, and a column it cannot read is one a database leak cannot spend.
ALTER TABLE boxes ADD COLUMN vault_token_hash TEXT NOT NULL DEFAULT '';

-- Secrets a box has been explicitly allowed to read.
--
-- By default a box sees a secret's *name* and nothing else: enough to know the
-- credential exists, never enough to hold it. A grant is the owner deciding
-- that this box, specifically, may read this entry — so the blast radius of a
-- compromised box is a list somebody chose rather than the whole vault.
--
-- Deliberately keyed on the entry rather than the name: granting `OPENAI_KEY`
-- must not silently extend to a different `OPENAI_KEY` created later in a wider
-- scope, which is exactly the kind of quiet privilege creep nobody reviews.
CREATE TABLE vault_grants (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  box_id     INTEGER NOT NULL REFERENCES boxes (id) ON DELETE CASCADE,
  entry_id   INTEGER NOT NULL REFERENCES vault_entries (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX vault_grants_key ON vault_grants (box_id, entry_id);
CREATE INDEX vault_grants_entry ON vault_grants (entry_id);
