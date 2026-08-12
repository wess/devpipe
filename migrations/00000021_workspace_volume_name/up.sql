-- The provider's name for the volume, which is what a box mounts by.
--
-- Only the id was kept, and the id is not in the device path: a box finds its
-- workspace at /dev/disk/by-id/scsi-0DO_Volume_<name>. Without this the name
-- has to be rebuilt from the row every time something wants to mount it, and a
-- rule that lives in two places is a rule that stops matching.
ALTER TABLE workspaces ADD COLUMN volume_name TEXT NOT NULL DEFAULT '';

-- Backfilling with the same derivation the create path uses, so workspaces
-- made before this column can still be mounted.
UPDATE workspaces
   SET volume_name = left('dp-' || user_id || '-' || regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), 60)
 WHERE volume_name = '';
