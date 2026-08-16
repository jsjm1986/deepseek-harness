# Agent Note: Gateway-managed project directories

Status: implemented

English | [中文](2026-08-16-gateway-managed-project-directories.zh.md)

## Problem

The project creation dialog required an administrator to know and enter an absolute host path, and the Gateway rejected a missing directory. This exposed deployment details in a routine product workflow and split one logical creation across the browser, shell access to the Gateway host, Unix permission provisioning, and the admin API.

## Decision

The admin creation flow accepts only a project name. The Gateway trims the name, requires one filesystem directory segment, creates or reuses `<HGW_PROJECTS_ROOT>/<name>`, forces a newly created directory to mode `0770`, resolves its canonical path, and persists that path as the project mount. `HGW_PROJECTS_ROOT` defaults to `~/harness-projects`; the production unit uses `/srv/harness/projects/admin`.

Managed names reject empty values, `.` and `..`, path separators, control characters, and any canonical result that differs from the direct child path. This prevents traversal and pre-existing symlinks from escaping the configured root. An existing non-directory receives the same stable path diagnostic as an explicit project path.

The JSON and project-service inputs retain an optional absolute `path` for importing an existing directory and for stopped SQLite data during migration. Explicit paths remain non-creating and continue through canonical-directory and reserved-user-directory checks. Project deletion removes control-plane and runtime records but leaves either kind of project directory on disk.

Linux deployment pre-creates `HGW_PROJECTS_ROOT` as `root:harness-project` with mode `2770`. The setgid parent gives Gateway-created `0770` children the shared runtime group without making them world-writable. Local macOS deployments configure a writable root owned by the launchd account.

## Verification

SQLite service tests cover automatic directory creation, Unicode names, `0770` group permissions, traversal rejection, and the existing explicit-path diagnostics. Admin API tests prove that `{ "name": "产品文档" }` creates and returns the canonical directory. Admin UI tests prove that the dialog has no path input and submits only the trimmed name. PostgreSQL integration coverage exercises the same managed-directory helper when `HGW_TEST_DATABASE_URL` is configured.

## Alternatives considered

**Keep requiring an absolute path.** Rejected because it makes a normal product operation depend on host shell access and asks administrators to repeat a deployment-specific prefix.

**Generate an opaque identifier or ASCII slug for the directory.** Rejected because a single validated directory segment already prevents traversal, while retaining the project name makes host inspection and recovery clearer for Chinese and other Unicode names.

**Make created directories world-writable or change ownership from the application.** Rejected because world-writable project data is unsafe and portable user/group lookup is not available in the cross-platform Gateway. A setgid production root supplies the required group deterministically.

## Consequences

Administrators create a project with one meaningful field, while the stored path remains explicit for grants, mounts, audit, and recovery. Deployment owns one project-root permission decision instead of provisioning every managed child manually. Existing absolute-path imports remain available, but they retain their manual Unix permission requirement. Renaming a project changes its catalog label and does not rename the directory, so active mounts and external references stay stable.
