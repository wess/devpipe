-- Three roles, one owner.
--
-- `is_owner` answered one question — is this the person whose provider account
-- everything runs on — and that stays exactly one person. What
-- it could not express is the middle: somebody who administers the instance
-- (invites people, suspends an abuser, reads the audit log) without being able
-- to move the money or hand over the machine it all runs on.
--
-- A column rather than a join table. There is one instance and one team on it;
-- a `memberships` table would be modelling a second team that does not exist,
-- and every query that wanted a role would grow a join for it.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
UPDATE users SET role = 'owner' WHERE is_owner = 1;
ALTER TABLE users DROP COLUMN is_owner;

-- The rule, enforced where it cannot be argued with.
--
-- "Exactly one owner" is the sort of invariant that survives in application
-- code right up until two requests run at once, and the failure is a fresh
-- instance with two people who can each remove the other. A partial unique
-- index makes a second owner impossible to write, which turns promotion into
-- an explicit transfer: demote, then promote, in one transaction.
CREATE UNIQUE INDEX users_single_owner_idx ON users (role) WHERE role = 'owner';
CREATE INDEX users_role_idx ON users (role);
