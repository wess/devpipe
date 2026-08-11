-- Setup output, line by line, so a box being built can show what it is doing
-- rather than a spinner. A build takes minutes; without this, "installing" is
-- indistinguishable from "stuck", and the first thing anyone asks when it
-- fails is what it was doing when it stopped.
CREATE TABLE box_events (
  id      SERIAL PRIMARY KEY,
  box_id  INTEGER NOT NULL REFERENCES boxes (id) ON DELETE CASCADE,
  phase   TEXT NOT NULL DEFAULT '',
  line    TEXT NOT NULL,
  at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX box_events_box_idx ON box_events (box_id, id);
