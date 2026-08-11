-- Who a broadcast has already reached.
--
-- Without this, a send is all-or-nothing in the worst way: `sent_at` is written
-- only after the last address, so a send that dies partway — a request that
-- outlives the server's idle timeout, a process restart, a provider refusing
-- mid-list — leaves a broadcast that still looks like a draft. Pressing send
-- again then mails everyone who already received it, and there is no way to
-- find out who that was.
--
-- The unique index is the guarantee, not the query plan. A resumed send inserts
-- a row per delivery, and the conflict is what makes a redelivery impossible
-- even if two sends of the same broadcast overlap.
CREATE TABLE broadcast_recipients (
  id           SERIAL PRIMARY KEY,
  broadcast_id INTEGER NOT NULL REFERENCES broadcasts (id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  -- A refusal is recorded too. A bad address that fails every attempt would
  -- otherwise be retried on every resume, and the send would never finish.
  delivered    SMALLINT NOT NULL DEFAULT 1,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX broadcast_recipients_once_idx ON broadcast_recipients (broadcast_id, email);
