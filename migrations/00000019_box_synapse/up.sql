-- Whether a box carries the account's Synapse memory.
--
-- A flag rather than the configuration itself: what a box needs — server, token
-- and the key its envelopes are sealed with — is the account's, not the box's,
-- and lives in agent_logins where it is encrypted at rest and fetched over TLS
-- with the box's own token. This only says whether to fetch it.
ALTER TABLE boxes ADD COLUMN synapse SMALLINT NOT NULL DEFAULT 0;
