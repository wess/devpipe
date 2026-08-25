DROP TABLE IF EXISTS machine_operations;
DROP INDEX IF EXISTS boxes_live_workspace;
ALTER TABLE boxes DROP COLUMN IF EXISTS endpoint;
ALTER TABLE workspaces DROP COLUMN IF EXISTS provider;
