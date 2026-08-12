-- Storage that outlives the box it is attached to.
--
-- A box is disposable by design: the manifest rebuilds one identically, which
-- is what makes destroying it survivable. What it never rebuilt is the work.
-- A workspace is the volume that does.
--
-- `region` is not decoration. Block storage is pinned to one, so a workspace
-- can only be mounted by a box in the same place — which makes the region a
-- property of the workspace rather than a free choice at box creation.
CREATE TABLE workspaces (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  region     TEXT NOT NULL,
  size_gb    INTEGER NOT NULL,
  volume_id  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Kept as a row after the volume is gone, so the audit trail still explains
  -- a charge that has stopped.
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX workspaces_name_per_user ON workspaces (user_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX workspaces_volume ON workspaces (volume_id);

-- Which workspace a box is carrying, if any.
--
-- A volume attaches to exactly one droplet at a time, so this is also the lock:
-- a workspace already named by a live box cannot be given to a second one.
ALTER TABLE boxes ADD COLUMN workspace_id INTEGER REFERENCES workspaces (id) ON DELETE SET NULL;
