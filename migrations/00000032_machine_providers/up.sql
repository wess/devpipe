-- The provider is part of the resource identity, not an implementation detail.
-- Existing rows are DigitalOcean resources; new installations may choose a
-- different backend without making an old opaque id ambiguous.
ALTER TABLE workspaces ADD COLUMN provider TEXT NOT NULL DEFAULT 'digitalocean';

-- The address the control plane uses to reach the daemon. DigitalOcean derives
-- this from the public hostname; local Docker publishes a loopback port. Kept
-- separate from the human-facing hostname so one does not masquerade as the
-- other.
ALTER TABLE boxes ADD COLUMN endpoint TEXT;

-- The database is the lock. A preflight SELECT alone lets two simultaneous
-- creates both claim the same workspace before either row is visible.
CREATE UNIQUE INDEX boxes_live_workspace
  ON boxes (workspace_id)
  WHERE workspace_id IS NOT NULL AND destroyed_at IS NULL;

-- Every provider mutation is journalled before it starts. A resource tagged
-- with this id can be reconciled after the API dies between the provider call
-- and the row update, which is the narrow window that used to leak machines.
CREATE TABLE machine_operations (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  provider        TEXT NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  step            TEXT NOT NULL DEFAULT '',
  box_id          INTEGER REFERENCES boxes (id) ON DELETE SET NULL,
  workspace_id    INTEGER REFERENCES workspaces (id) ON DELETE SET NULL,
  resource_id     TEXT,
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);
CREATE INDEX machine_operations_unfinished
  ON machine_operations (created_at)
  WHERE finished_at IS NULL;
