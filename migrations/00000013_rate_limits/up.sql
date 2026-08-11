-- Counters for the rate limiter. One row per bucket — "route|dimension|value" —
-- holding a fixed window rather than a sliding one. A sliding window needs a
-- row per hit, and this table is written on every unauthenticated request.
--
-- window_start stays unix seconds rather than a timestamp: the counter is a
-- single conditional upsert, and comparing integers inside it needs no date
-- parsing on either engine.
--
-- The unique index is load bearing, not an optimisation. The counter is one
-- `INSERT ... ON CONFLICT (bucket)`, which needs a unique index to conflict
-- against; without it every hit inserts a fresh row, every count reads 1, and
-- nothing is ever limited.
CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
CREATE UNIQUE INDEX rate_limits_bucket_idx ON rate_limits (bucket);
