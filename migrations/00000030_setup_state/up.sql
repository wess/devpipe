-- An instance that was already running does not get shown the setup wizard.
--
-- The wizard opens by itself for an owner who has not been through it, which is
-- right on a fresh install and wrong on an upgrade: devpipe.com has had a
-- provider token and a domain for months, and deploying this would put its
-- owner on a configuration screen for a machine that is already configured.
--
-- Keyed on the provider credential rather than on the domain setting, because
-- the domain has a default and the credential does not — a row in `credentials`
-- means somebody deliberately connected an account.
INSERT INTO settings (key, value)
SELECT 'setup_complete', '1'
WHERE EXISTS (SELECT 1 FROM credentials WHERE key = 'digitalocean_token')
ON CONFLICT (key) DO NOTHING;
