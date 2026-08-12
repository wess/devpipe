-- When somebody last used a box.
--
-- Seeded from ready_at rather than now(): a box that has been sitting unused
-- for a week should be eligible for reclaim immediately, not given a fresh week
-- because the column was added today. Falling back to created_at covers boxes
-- that never finished coming up.
ALTER TABLE boxes ADD COLUMN last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
UPDATE boxes SET last_active_at = COALESCE(ready_at, created_at);

-- The sweep reads exactly this: live boxes carrying a workspace, oldest use
-- first. Without it the query is a sequential scan on every pass of a loop that
-- runs forever.
CREATE INDEX boxes_idle_idx ON boxes (last_active_at)
  WHERE destroyed_at IS NULL AND workspace_id IS NOT NULL;
