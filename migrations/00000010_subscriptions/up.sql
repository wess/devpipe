-- One paid box, one row. `box_id` is what makes "a subscription covers exactly
-- one box" answerable without asking Stripe on the create path. `size` is
-- recorded here rather than read back off the Stripe price, so changing the
-- margin later never rewrites what somebody already agreed to pay.
CREATE TABLE subscriptions (
  id                     SERIAL PRIMARY KEY,
  user_id                INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  stripe_customer_id     TEXT NOT NULL DEFAULT '',
  stripe_subscription_id TEXT UNIQUE NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'incomplete',
  size                   TEXT NOT NULL,
  box_id                 INTEGER REFERENCES boxes (id) ON DELETE SET NULL,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, status);
CREATE INDEX subscriptions_box_idx ON subscriptions (box_id);
