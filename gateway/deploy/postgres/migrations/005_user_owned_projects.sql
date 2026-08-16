-- Projects have one shared runtime regardless of who provisioned them.
-- Origin and owner are separate from created_by so an administrator can
-- provision a project on behalf of a user without changing its audit trail.
ALTER TABLE harness.projects
  ADD COLUMN origin text NOT NULL DEFAULT 'admin',
  ADD COLUMN owner_user_id uuid,
  ADD CONSTRAINT projects_origin_check CHECK (origin IN ('admin','user')),
  ADD CONSTRAINT projects_owner_required_check CHECK (
    (origin = 'user' AND owner_user_id IS NOT NULL) OR origin = 'admin'
  ),
  ADD CONSTRAINT projects_owner_id_organization_id_fkey
    FOREIGN KEY (owner_user_id, organization_id)
    REFERENCES harness.users(id, organization_id);

CREATE INDEX projects_owner ON harness.projects(organization_id, owner_user_id)
  WHERE owner_user_id IS NOT NULL;

CREATE TABLE harness.project_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  invitee_user_id uuid NOT NULL,
  inviter_user_id uuid NOT NULL,
  access_mode text NOT NULL CHECK (access_mode IN ('ro','rw')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','declined','revoked','expired')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (invitee_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (inviter_user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX project_invitations_pending_target
  ON harness.project_invitations(project_id, invitee_user_id)
  WHERE status = 'pending';
CREATE INDEX project_invitations_invitee_status
  ON harness.project_invitations(organization_id, invitee_user_id, status, created_at DESC);
