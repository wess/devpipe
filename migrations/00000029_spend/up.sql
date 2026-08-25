-- What this instance is costing at the provider.
--
-- Deliberately not the same thing as `credit_ledger`. That one is money a
-- *customer* owes and it only exists where somebody is selling boxes; this is
-- what the machines cost the person whose provider account they run on, and it
-- exists on every instance including the ones with no billing at all. They are
-- measured by the same clock and they are different numbers: one carries the
-- margin, the other is the provider's own price.
--
-- Accumulated rather than computed from what is running, because a cap that
-- only counted live boxes would reset every time somebody destroyed one — and
-- "spend less by deleting the evidence" is not a spend cap.
CREATE TABLE spend_ledger (
  id           SERIAL PRIMARY KEY,
  -- Always positive. This ledger only goes one way.
  cents        BIGINT NOT NULL,
  -- 'box' | 'workspace'
  kind         TEXT NOT NULL,
  -- Both nullable and both ON DELETE SET NULL: the row outlives the thing it
  -- was spent on, which is the entire point of accumulating it.
  box_id       INTEGER REFERENCES boxes (id) ON DELETE SET NULL,
  workspace_id INTEGER REFERENCES workspaces (id) ON DELETE SET NULL,
  user_id      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  note         TEXT NOT NULL DEFAULT '',
  period_start TIMESTAMPTZ,
  period_end   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX spend_ledger_created_idx ON spend_ledger (created_at DESC);
CREATE INDEX spend_ledger_user_idx ON spend_ledger (user_id, created_at DESC);

-- The provider's price for this box, per hour, in cents. Written when the
-- droplet starts existing and never recalculated, for the same reason
-- `hourly_cents` is not: a price that moves under a running machine makes last
-- week's spend unexplainable.
ALTER TABLE boxes ADD COLUMN cost_cents INTEGER;

-- Volumes are charged for whether or not a box is attached to them, and they
-- are the part of the bill that lingers after everything else is cleaned up.
-- A cap that counted droplets alone would read low and be trusted anyway.
ALTER TABLE workspaces ADD COLUMN cost_cents INTEGER;
ALTER TABLE workspaces ADD COLUMN metered_at TIMESTAMPTZ;
CREATE INDEX workspaces_metered_idx ON workspaces (metered_at) WHERE metered_at IS NOT NULL;
