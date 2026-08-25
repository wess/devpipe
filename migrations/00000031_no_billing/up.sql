-- Billing comes out.
--
-- Devpipe is something you run on your own DigitalOcean account, and on your
-- own account there is nobody to charge. Everything here existed to sell a box
-- to somebody else: subscriptions, a credit balance, the Stripe objects behind
-- both, and the per-box price that carried a margin on top of what the
-- provider charged.
--
-- What replaces it is the half that was always the useful one: the meter. It
-- still runs, on every box and every volume, and it still answers the only
-- money question left — what is this instance costing *me* — which is what the
-- spending cap reads. `boxes.cost_cents` and `spend_ledger` stay; everything
-- that carried a margin or a customer goes.
-- Keep the old tables and columns for one release. The application no longer
-- reads or writes them, but retaining the shape makes a binary rollback safe
-- after this migration has run. A later migration may remove them once every
-- supported rollback target postdates billing.

DELETE FROM credentials WHERE key IN ('stripe_secret_key', 'stripe_webhook_secret');
DELETE FROM settings WHERE key IN (
  'billing_margin_pct',
  'billing_meter_event_name',
  'billing_overage_price_id',
  'billing_overage_limit_cents',
  'boxes_free_max_size',
  'boxes_gpu_min_hours'
);
