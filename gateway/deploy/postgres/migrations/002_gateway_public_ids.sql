CREATE SEQUENCE harness.user_public_id_seq;
ALTER TABLE harness.users ADD COLUMN public_id bigint;
UPDATE harness.users SET public_id = legacy_id;
SELECT setval(
  'harness.user_public_id_seq',
  COALESCE((SELECT MAX(public_id) FROM harness.users), 1),
  EXISTS (SELECT 1 FROM harness.users)
);
ALTER TABLE harness.users ALTER COLUMN public_id SET DEFAULT nextval('harness.user_public_id_seq');
ALTER TABLE harness.users ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE harness.users ADD CONSTRAINT users_organization_public_id_key UNIQUE (organization_id, public_id);

CREATE SEQUENCE harness.project_public_id_seq;
ALTER TABLE harness.projects ADD COLUMN public_id bigint;
UPDATE harness.projects SET public_id = legacy_id;
SELECT setval(
  'harness.project_public_id_seq',
  COALESCE((SELECT MAX(public_id) FROM harness.projects), 1),
  EXISTS (SELECT 1 FROM harness.projects)
);
ALTER TABLE harness.projects ALTER COLUMN public_id SET DEFAULT nextval('harness.project_public_id_seq');
ALTER TABLE harness.projects ALTER COLUMN public_id SET NOT NULL;
ALTER TABLE harness.projects ADD CONSTRAINT projects_organization_public_id_key UNIQUE (organization_id, public_id);
