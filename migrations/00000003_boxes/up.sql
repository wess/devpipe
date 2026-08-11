-- One row per VPS. `manifest` is the wizard's answer — which tools the box was
-- built with — kept so a box can be rebuilt identically. That is what makes
-- "destroy and recreate" a safe operation rather than a loss.
CREATE TABLE boxes (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  hostname       TEXT UNIQUE NOT NULL,
  provider       TEXT NOT NULL DEFAULT 'digitalocean',
  provider_id    TEXT,
  region         TEXT NOT NULL DEFAULT 'nyc3',
  size           TEXT NOT NULL DEFAULT 's-1vcpu-512mb-10gb',
  status         TEXT NOT NULL DEFAULT 'queued',
  status_detail  TEXT NOT NULL DEFAULT '',
  ip             TEXT NOT NULL DEFAULT '',
  agent_token    TEXT NOT NULL DEFAULT '',
  manifest       TEXT NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ready_at       TIMESTAMPTZ,
  destroyed_at   TIMESTAMPTZ
);
CREATE INDEX boxes_user_idx ON boxes (user_id);
