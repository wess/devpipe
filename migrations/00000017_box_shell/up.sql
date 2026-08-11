-- The login shell on a box.
--
-- A column rather than a key in `manifest`, because it is read on the path
-- that starts every terminal: the control plane wraps a command in the box's
-- own shell so rc files, aliases and PATH are the ones the user set up.
ALTER TABLE boxes ADD COLUMN shell TEXT NOT NULL DEFAULT 'bash';
