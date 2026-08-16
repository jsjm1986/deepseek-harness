ALTER TABLE harness.instances
  ALTER COLUMN user_id DROP NOT NULL,
  ADD COLUMN project_id uuid,
  ADD COLUMN runtime_token_hash bytea,
  ADD COLUMN runtime_token_issued_at timestamptz;

ALTER TABLE harness.instances
  DROP CONSTRAINT instances_organization_id_user_id_key,
  ADD CONSTRAINT instances_exactly_one_owner CHECK ((user_id IS NULL) <> (project_id IS NULL)),
  ADD CONSTRAINT instances_project_id_organization_id_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX instances_organization_user_key
  ON harness.instances(organization_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX instances_organization_project_key
  ON harness.instances(organization_id, project_id) WHERE project_id IS NOT NULL;

INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode)
SELECT organization_id,id,created_by,'rw'
FROM harness.projects
WHERE created_by IS NOT NULL
ON CONFLICT(project_id,user_id) DO NOTHING;

ALTER TABLE harness.conversation_sessions
  RENAME COLUMN owner_user_id TO creator_user_id;

ALTER TABLE harness.conversation_sessions
  ADD COLUMN visibility text,
  ADD COLUMN root_session_id text;

UPDATE harness.conversation_sessions
SET visibility = CASE WHEN project_id IS NULL THEN 'personal' ELSE 'project' END;

WITH RECURSIVE conversation_roots AS (
  SELECT id,organization_id,id root_session_id
  FROM harness.conversation_sessions
  WHERE parent_session_id IS NULL
  UNION ALL
  SELECT child.id,child.organization_id,parent.root_session_id
  FROM harness.conversation_sessions child
  JOIN conversation_roots parent
    ON parent.id=child.parent_session_id
    AND parent.organization_id=child.organization_id
)
UPDATE harness.conversation_sessions session
SET root_session_id=roots.root_session_id
FROM conversation_roots roots
WHERE roots.id=session.id AND roots.organization_id=session.organization_id;

ALTER TABLE harness.conversation_sessions
  ALTER COLUMN visibility SET NOT NULL,
  ALTER COLUMN root_session_id SET NOT NULL,
  DROP CONSTRAINT conversation_sessions_project_id_organization_id_fkey,
  ADD CONSTRAINT conversation_sessions_project_id_organization_id_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  ADD CONSTRAINT conversation_sessions_visibility_check
    CHECK (visibility IN ('personal','project','private')),
  ADD CONSTRAINT conversation_sessions_scope_visibility_check CHECK (
    (project_id IS NULL AND visibility = 'personal')
    OR (project_id IS NOT NULL AND visibility IN ('project','private'))
  ),
  ADD CONSTRAINT conversation_sessions_root_session_id_organization_id_fkey
    FOREIGN KEY (root_session_id, organization_id)
    REFERENCES harness.conversation_sessions(id, organization_id);

ALTER INDEX harness.conversation_sessions_owner_time
  RENAME TO conversation_sessions_creator_time;

CREATE INDEX conversation_sessions_project_time
  ON harness.conversation_sessions(project_id, updated_at DESC)
  WHERE project_id IS NOT NULL AND status <> 'deleted';
CREATE INDEX conversation_sessions_root
  ON harness.conversation_sessions(root_session_id);

CREATE TABLE harness.conversation_participants (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  user_id uuid NOT NULL,
  first_contributed_at timestamptz NOT NULL,
  last_contributed_at timestamptz NOT NULL,
  contribution_count bigint NOT NULL DEFAULT 1 CHECK (contribution_count > 0),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, organization_id)
    REFERENCES harness.conversation_sessions(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, organization_id)
    REFERENCES harness.users(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX conversation_participants_user_time
  ON harness.conversation_participants(user_id, last_contributed_at DESC);

CREATE TABLE harness.conversation_interaction_responses (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  interaction_kind text NOT NULL CHECK (interaction_kind IN ('approval','question')),
  interaction_id text NOT NULL,
  conversation_id text NOT NULL,
  responder_user_id uuid NOT NULL,
  outcome jsonb NOT NULL,
  responded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, interaction_kind, interaction_id),
  FOREIGN KEY (conversation_id, organization_id)
    REFERENCES harness.conversation_sessions(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (responder_user_id, organization_id)
    REFERENCES harness.users(id, organization_id)
);
CREATE INDEX conversation_interaction_responses_conversation_time
  ON harness.conversation_interaction_responses(conversation_id, responded_at DESC);

CREATE TABLE harness.project_model_intake_tokens (
  project_id uuid PRIMARY KEY REFERENCES harness.projects(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE harness.project_quotas (
  project_id uuid PRIMARY KEY REFERENCES harness.projects(id) ON DELETE CASCADE,
  token_limit bigint CHECK (token_limit IS NULL OR token_limit >= 0),
  company_cost_limit numeric(24,9) CHECK (company_cost_limit IS NULL OR company_cost_limit >= 0)
);

CREATE TABLE harness.project_usage_alerts (
  project_id uuid NOT NULL REFERENCES harness.projects(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('tokens','company-cost')),
  threshold smallint NOT NULL CHECK (threshold IN (80,100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, period_start, metric, threshold)
);

ALTER TABLE harness.model_usage
  ADD COLUMN project_id uuid,
  ALTER COLUMN user_id DROP NOT NULL,
  ADD CONSTRAINT model_usage_exactly_one_subject
    CHECK ((user_id IS NULL) <> (project_id IS NULL)),
  ADD CONSTRAINT model_usage_project_id_organization_id_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE;
CREATE INDEX model_usage_project_time
  ON harness.model_usage(project_id, occurred_at DESC) WHERE project_id IS NOT NULL;

ALTER TABLE harness.content_files
  ADD COLUMN project_id uuid,
  ADD CONSTRAINT content_files_project_id_organization_id_fkey
    FOREIGN KEY (project_id, organization_id)
    REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE;
CREATE INDEX content_files_project_time
  ON harness.content_files(project_id, created_at DESC) WHERE project_id IS NOT NULL;
