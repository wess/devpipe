-- Instance settings the owner changes without a redeploy. Values are text so
-- the table never needs a migration to hold a new kind of setting.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
