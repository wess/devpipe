-- Stripe redelivers an event until it gets a 2xx, and it also fans the same
-- state change out over several event types. Keeping the ids it has already
-- been given is what stops a retry from attaching a second box or cancelling
-- a subscription twice.
CREATE TABLE billing_events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL DEFAULT '',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
