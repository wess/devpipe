DROP INDEX IF EXISTS boxes_idle_idx;
ALTER TABLE boxes DROP COLUMN last_active_at;
