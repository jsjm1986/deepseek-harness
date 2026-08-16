ALTER TABLE harness.users
  ADD COLUMN deleted_at timestamptz;

CREATE INDEX users_active_lookup
  ON harness.users(organization_id, username)
  WHERE deleted_at IS NULL;
