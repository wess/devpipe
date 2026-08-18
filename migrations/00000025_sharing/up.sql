-- Two ways to let something on a box be seen from outside it.
--
-- They ship together because they answer the same question — "can I show this
-- to a person who is not me, without giving them the machine" — and because
-- keeping one revoke list is the only way anybody will ever check it.

-- A port on a box, reachable at a hostname of its own.
--
-- This is what makes "run a dev server and look at it" possible without
-- publishing it. The alternative people actually reach for is binding the
-- server to 0.0.0.0 and opening the firewall, which puts an unfinished site on
-- the public internet under a name that resolves — and leaves it there long
-- after they have stopped looking at it.
--
-- The hostname is a single DNS label so it is covered by the `*.devpipe.com`
-- record that already exists; a second-level name like `x.preview.devpipe.com`
-- would need its own wildcard and a DNS-01 certificate to go with it. Slugs are
-- `p-<random>`, which no username can produce: a username is at least three
-- characters, so a box is never `p-`-anything.
--
-- `audience` is the whole privacy model:
--   private — the URL is not a credential. Reaching it needs a browser that has
--             been granted a cookie by the app, which needs a live session
--             belonging to this user.
--   link    — the URL *is* the credential. For showing a client, and why
--             `expires_at` exists.
CREATE TABLE previews (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  box_id       INTEGER NOT NULL REFERENCES boxes (id) ON DELETE CASCADE,
  port         INTEGER NOT NULL,
  slug         TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  audience     TEXT NOT NULL DEFAULT 'private',
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- Unique across every row, live or not. A slug is a hostname somebody may
-- still have open; handing a retired one to a different box would send their
-- browser somewhere it has no business being.
CREATE UNIQUE INDEX previews_slug ON previews (slug);
CREATE INDEX previews_box ON previews (box_id) WHERE revoked_at IS NULL;

-- A terminal session someone else can watch, and — if you say so — type into.
--
-- The guest never holds the box's token. Their socket terminates on the
-- control plane, which holds one to the box and copies frames between them,
-- dropping everything travelling towards the box when the mode is `watch`.
-- That is the only place read-only can be enforced: the daemon has exactly one
-- credential and it is all-powerful, so a share that handed it over would be a
-- share of the whole machine with a polite request not to type.
--
-- The owner's own terminal still connects straight to the box. Guests are rare
-- and a person watching can afford a hop; the person working cannot.
CREATE TABLE shares (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  box_id       INTEGER NOT NULL REFERENCES boxes (id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'watch',
  label        TEXT NOT NULL DEFAULT '',
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  visits       INTEGER NOT NULL DEFAULT 0
);

-- Hashed, like every other bearer here: the column a database leak reads is not
-- one it can spend.
CREATE UNIQUE INDEX shares_token ON shares (token_hash);
CREATE INDEX shares_box ON shares (box_id) WHERE revoked_at IS NULL;
