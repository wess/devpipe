DROP TABLE spend_ledger;
ALTER TABLE boxes DROP COLUMN cost_cents;
ALTER TABLE workspaces DROP COLUMN cost_cents;
ALTER TABLE workspaces DROP COLUMN metered_at;
