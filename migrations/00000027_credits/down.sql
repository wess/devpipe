DROP TABLE credit_ledger;
ALTER TABLE boxes DROP COLUMN hourly_cents;
ALTER TABLE boxes DROP COLUMN metered_at;
ALTER TABLE users DROP COLUMN stripe_overage_subscription_id;
