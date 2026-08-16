CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE harness.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  default_time_zone text NOT NULL DEFAULT 'Asia/Shanghai',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE harness.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  username citext NOT NULL,
  display_name text NOT NULL,
  home_path text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  legacy_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, username),
  UNIQUE (organization_id, legacy_id),
  UNIQUE (id, organization_id)
);

CREATE TABLE harness.password_credentials (
  user_id uuid PRIMARY KEY REFERENCES harness.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  password_version integer NOT NULL DEFAULT 1,
  must_change_password boolean NOT NULL DEFAULT true,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE harness.memberships (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id),
  FOREIGN KEY (user_id, organization_id) REFERENCES harness.users(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE harness.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  user_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  source_ip inet,
  user_agent text NOT NULL DEFAULT '',
  FOREIGN KEY (user_id, organization_id) REFERENCES harness.users(id, organization_id)
);
CREATE INDEX auth_sessions_active_token ON harness.auth_sessions(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_user_active ON harness.auth_sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE harness.login_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid REFERENCES harness.organizations(id),
  username citext NOT NULL,
  source_ip inet,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  succeeded boolean NOT NULL DEFAULT false
);
CREATE INDEX login_attempts_lockout ON harness.login_attempts(username, source_ip, occurred_at DESC);

CREATE TABLE harness.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  name citext NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid,
  version bigint NOT NULL DEFAULT 1,
  legacy_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (organization_id, legacy_id),
  UNIQUE (id, organization_id),
  FOREIGN KEY (created_by, organization_id) REFERENCES harness.users(id, organization_id)
);

CREATE TABLE harness.compute_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  name citext NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','draining','offline')),
  last_heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name),
  UNIQUE (id, organization_id)
);

CREATE TABLE harness.project_mounts (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  node_id uuid NOT NULL,
  local_path text NOT NULL,
  canonical_path text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','missing')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, node_id),
  UNIQUE (node_id, canonical_path),
  FOREIGN KEY (project_id, organization_id) REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (node_id, organization_id) REFERENCES harness.compute_nodes(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE harness.project_members (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  access_mode text NOT NULL CHECK (access_mode IN ('ro','rw')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES harness.projects(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, organization_id) REFERENCES harness.users(id, organization_id) ON DELETE CASCADE
);

CREATE TABLE harness.instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  user_id uuid NOT NULL,
  assigned_node_id uuid NOT NULL,
  desired_state text NOT NULL DEFAULT 'stopped' CHECK (desired_state IN ('running','stopped')),
  observed_state text NOT NULL DEFAULT 'stopped' CHECK (observed_state IN ('stopped','starting','ready','stopping','failed')),
  generation bigint NOT NULL DEFAULT 1,
  observed_generation bigint NOT NULL DEFAULT 0,
  policy_revision bigint NOT NULL DEFAULT 0,
  applied_policy_revision bigint NOT NULL DEFAULT 0,
  port integer NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  last_heartbeat_at timestamptz,
  started_at timestamptz,
  last_activity_at timestamptz,
  legacy_user_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id),
  UNIQUE (assigned_node_id, port),
  FOREIGN KEY (user_id, organization_id) REFERENCES harness.users(id, organization_id),
  FOREIGN KEY (assigned_node_id, organization_id) REFERENCES harness.compute_nodes(id, organization_id)
);

CREATE TABLE harness.model_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  provider_key text NOT NULL,
  model_key text NOT NULL,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider_key, model_key),
  UNIQUE (id, organization_id)
);

CREATE TABLE harness.model_role_access (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  role text NOT NULL CHECK (role IN ('admin','member')),
  model_id uuid NOT NULL,
  allowed boolean NOT NULL,
  PRIMARY KEY (organization_id, role, model_id),
  FOREIGN KEY (model_id, organization_id) REFERENCES harness.model_catalog(id, organization_id)
);

CREATE TABLE harness.model_user_access (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  model_id uuid NOT NULL,
  allowed boolean NOT NULL,
  PRIMARY KEY (user_id, model_id),
  FOREIGN KEY (user_id, organization_id) REFERENCES harness.users(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (model_id, organization_id) REFERENCES harness.model_catalog(id, organization_id)
);

CREATE TABLE harness.model_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES harness.model_catalog(id),
  effective_at timestamptz NOT NULL,
  currency char(3) NOT NULL DEFAULT 'USD',
  input_per_million numeric(24,9) NOT NULL CHECK (input_per_million >= 0),
  output_per_million numeric(24,9) NOT NULL CHECK (output_per_million >= 0),
  cache_read_per_million numeric(24,9) NOT NULL CHECK (cache_read_per_million >= 0),
  cache_write_per_million numeric(24,9) NOT NULL CHECK (cache_write_per_million >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, effective_at)
);

CREATE TABLE harness.role_quotas (
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  role text NOT NULL CHECK (role IN ('admin','member')),
  token_limit bigint CHECK (token_limit IS NULL OR token_limit >= 0),
  company_cost_limit numeric(24,9) CHECK (company_cost_limit IS NULL OR company_cost_limit >= 0),
  PRIMARY KEY (organization_id, role)
);

CREATE TABLE harness.user_quotas (
  user_id uuid PRIMARY KEY REFERENCES harness.users(id) ON DELETE CASCADE,
  token_mode text NOT NULL DEFAULT 'inherit' CHECK (token_mode IN ('inherit','unlimited','custom')),
  token_limit bigint,
  company_cost_mode text NOT NULL DEFAULT 'inherit' CHECK (company_cost_mode IN ('inherit','unlimited','custom')),
  company_cost_limit numeric(24,9),
  CHECK ((token_mode = 'custom') = (token_limit IS NOT NULL)),
  CHECK (token_limit IS NULL OR token_limit >= 0),
  CHECK ((company_cost_mode = 'custom') = (company_cost_limit IS NOT NULL)),
  CHECK (company_cost_limit IS NULL OR company_cost_limit >= 0)
);

CREATE TABLE harness.model_intake_tokens (
  user_id uuid PRIMARY KEY REFERENCES harness.users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE harness.model_usage (
  event_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  user_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  model_id uuid,
  provider_key text NOT NULL,
  model_key text NOT NULL,
  purpose text NOT NULL,
  session_id text,
  credential_source text NOT NULL,
  credential_class text NOT NULL CHECK (credential_class IN ('company','personal','unknown')),
  status text NOT NULL CHECK (status IN ('succeeded','failed','cancelled','missing-usage','denied')),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  estimated_cost numeric(24,9) NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  company_cost numeric(24,9) NOT NULL DEFAULT 0 CHECK (company_cost >= 0),
  PRIMARY KEY (organization_id, event_id),
  FOREIGN KEY (user_id, organization_id) REFERENCES harness.users(id, organization_id),
  FOREIGN KEY (model_id, organization_id) REFERENCES harness.model_catalog(id, organization_id)
);
CREATE INDEX model_usage_user_time ON harness.model_usage(user_id, occurred_at DESC);

CREATE TABLE harness.model_usage_alerts (
  user_id uuid NOT NULL REFERENCES harness.users(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  metric text NOT NULL CHECK (metric IN ('tokens','company-cost')),
  threshold smallint NOT NULL CHECK (threshold IN (80,100)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_start, metric, threshold)
);

CREATE TABLE harness.audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid REFERENCES harness.organizations(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user_id uuid,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  request_id uuid,
  source_ip inet,
  user_agent text NOT NULL DEFAULT '',
  outcome text NOT NULL DEFAULT 'success',
  status_code integer,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  legacy_id bigint,
  UNIQUE (organization_id, legacy_id),
  CHECK (actor_user_id IS NULL OR organization_id IS NOT NULL),
  FOREIGN KEY (actor_user_id, organization_id) REFERENCES harness.users(id, organization_id)
);
CREATE INDEX audit_events_time ON harness.audit_events(occurred_at DESC);
CREATE INDEX audit_events_actor_time ON harness.audit_events(actor_user_id, occurred_at DESC);

CREATE TABLE harness.conversation_sessions (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  owner_user_id uuid NOT NULL,
  project_id uuid,
  parent_session_id text,
  session_format_version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  closed_at timestamptz,
  cwd text,
  seed_length bigint,
  origin text,
  delegation_depth integer,
  agent_preset text,
  title text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','deleted')),
  next_seq bigint NOT NULL DEFAULT 0 CHECK (next_seq >= 0),
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  total_payload_bytes bigint NOT NULL DEFAULT 0 CHECK (total_payload_bytes >= 0),
  version bigint NOT NULL DEFAULT 1,
  UNIQUE (id, organization_id),
  FOREIGN KEY (owner_user_id, organization_id) REFERENCES harness.users(id, organization_id),
  FOREIGN KEY (project_id, organization_id) REFERENCES harness.projects(id, organization_id),
  FOREIGN KEY (parent_session_id, organization_id) REFERENCES harness.conversation_sessions(id, organization_id)
);
CREATE INDEX conversation_sessions_owner_time ON harness.conversation_sessions(owner_user_id, updated_at DESC);

CREATE TABLE harness.conversation_append_batches (
  batch_id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES harness.conversation_sessions(id) ON DELETE CASCADE,
  first_seq bigint NOT NULL,
  event_count integer NOT NULL,
  checksum bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE harness.conversation_events (
  session_id text NOT NULL REFERENCES harness.conversation_sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL CHECK (seq >= 0),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  event jsonb NOT NULL,
  payload_bytes integer NOT NULL CHECK (payload_bytes >= 0),
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX conversation_events_type_time ON harness.conversation_events(event_type, occurred_at DESC);
CREATE INDEX conversation_events_tool_call ON harness.conversation_events ((event->'data'->>'callId'))
  WHERE event_type IN ('tool/call','tool/result');

CREATE TABLE harness.conversation_search (
  session_id text NOT NULL REFERENCES harness.conversation_sessions(id) ON DELETE CASCADE,
  event_seq bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, event_seq)
);
CREATE INDEX conversation_search_trgm ON harness.conversation_search USING gin (content gin_trgm_ops);

CREATE TABLE harness.content_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES harness.organizations(id),
  owner_user_id uuid NOT NULL,
  session_id text,
  kind text NOT NULL CHECK (kind IN ('attachment','spill','artifact','tool-output')),
  local_path text NOT NULL,
  sha256 char(64) NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  media_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (owner_user_id, organization_id) REFERENCES harness.users(id, organization_id),
  FOREIGN KEY (session_id, organization_id) REFERENCES harness.conversation_sessions(id, organization_id)
);
CREATE INDEX content_files_hash ON harness.content_files(organization_id, sha256, kind);

CREATE TABLE harness.outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES harness.organizations(id),
  topic text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending ON harness.outbox(available_at, created_at) WHERE completed_at IS NULL;
