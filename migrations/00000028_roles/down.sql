ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
UPDATE users SET is_owner = 1 WHERE role = 'owner';
DROP INDEX users_single_owner_idx;
DROP INDEX users_role_idx;
ALTER TABLE users DROP COLUMN role;
