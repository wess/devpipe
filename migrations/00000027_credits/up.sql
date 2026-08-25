-- Prepaid credit, and the hourly boxes it pays for.
--
-- An append-only ledger rather than a balance column. A balance is one number
-- that can be wrong with no way to find out when it went wrong; a ledger is
-- every event that ever touched the money, and the balance is a SUM over it.
-- That matters more here than it usually would, because the rows are written
-- by a sweep on a timer: the question "why is this person forty cents down" has
-- to be answerable a month later, from the database, without the sweep's logs.
--
-- Cents throughout, as integers. GPU rates are quoted per hour and charged per
-- tick, so the amounts are fractions of a cent before rounding — that rounding
-- happens once, in code, against a duration, and never against a float stored
-- here.
CREATE TABLE credit_ledger (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Positive puts credit in, negative takes it out. One column rather than a
  -- debit/credit pair: the sign is the direction, and a SUM is the balance.
  delta_cents BIGINT NOT NULL,
  -- 'topup' | 'usage' | 'grant' | 'refund' | 'adjustment'
  kind        TEXT NOT NULL,
  box_id      INTEGER REFERENCES boxes (id) ON DELETE SET NULL,
  note        TEXT NOT NULL DEFAULT '',
  -- The Stripe object this row came from, where there is one. Unique among
  -- non-empty values, which is what makes a webhook redelivery a no-op rather
  -- than a second helping of credit.
  stripe_ref  TEXT NOT NULL DEFAULT '',
  -- The span a usage row covers, so a charge can be explained and so a replay
  -- of the sweep cannot bill the same hour twice.
  period_start TIMESTAMPTZ,
  period_end   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX credit_ledger_user_idx ON credit_ledger (user_id, created_at DESC);
CREATE INDEX credit_ledger_box_idx ON credit_ledger (box_id);
CREATE UNIQUE INDEX credit_ledger_stripe_ref_idx ON credit_ledger (stripe_ref) WHERE stripe_ref <> '';

-- What has already been charged for on this box, and at what rate.
--
-- `hourly_cents` is written when the box is created and never recalculated.
-- The provider's price and the instance's margin both move; neither should
-- change what somebody is charged for a machine they are already running.
-- Null on every CPU box — they are covered by a subscription and this whole
-- mechanism is blind to them.
ALTER TABLE boxes ADD COLUMN hourly_cents INTEGER;
-- The high-water mark of metering. Set when the droplet starts existing,
-- advanced by the sweep, cleared when it stops. Null means nothing is running
-- that anybody is being charged by the hour for.
ALTER TABLE boxes ADD COLUMN metered_at TIMESTAMPTZ;
CREATE INDEX boxes_metered_idx ON boxes (metered_at) WHERE metered_at IS NOT NULL;

-- The metered subscription a customer in overage is attached to. Empty until
-- they first go past zero, and empty forever on an instance with no meter
-- configured.
ALTER TABLE users ADD COLUMN stripe_overage_subscription_id TEXT NOT NULL DEFAULT '';
