-- Provider credentials, kept apart from settings so a careless SELECT * on
-- settings cannot spill them into a log or an admin screen.
CREATE TABLE credentials (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
