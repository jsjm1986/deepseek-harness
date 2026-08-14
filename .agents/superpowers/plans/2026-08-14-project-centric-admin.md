# 项目制管理端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把网关管理从「组 + 散装路径授权 + 一页表单」换成一等项目对象、JSON 管理 API、网关托管的管理应用，以及只从授权根添加工作区。

**Architecture:** SQLite 迁到 `projects` / `project_members`；`ProjectService` 计算带 `label` 的有效授权并在成员变更时重启相关实例。`/admin/api/*` 由网关提供 JSON；`/admin` 托管 `gateway/admin-ui` 的 Vite/React 构建产物。实例侧不改 directory-picker seam：browse 在存在 `directory-grants.json` 时把无路径 `list()` 变成授权根列表，并拒绝离开这些根。

**Tech Stack:** 网关仍是独立 npm 包（Node 22+、better-sqlite3、vitest、tsx）。管理前端 Vite + React + TypeScript，构建到 `gateway/public/admin/`。实例侧改动落在 `@deepseek-ai/dsh-host-directory-picker-browse` 与 `@deepseek-ai/dsh-client-ui-workspace`。

## Global Constraints

- 设计文档：`.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md`。登录/代理/实例生命周期仍以 `.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md` 为准。
- 管理 UI 只活在网关 `/admin`，不做成 dsh 客户端插件，不进入 `packages/` workspace。
- 不做组、自助建项目、改项目路径、销号、SSO、用量、Linux systemd 挂载验收。
- 项目 `path` 必须已存在且为目录，经 `realpathSync`；不得等于任何用户 `home_path` 或 `$DSH_HOME`（`usersRoot/<username>/dsh`）。
- 有效授权 = home `rw`（label `主目录`）∪ 项目成员；`directory-grants.json` 含 `{ path, mode, label }`。
- 成员/删项目：已运行实例停再拉起；已停实例只写文件。多名用户按 `user_id` 串行。
- 不能禁用或降级最后一个 `active` 管理员。
- 写操作 `Origin` ∈ `HGW_PUBLIC_ORIGINS`；审计不含请求体。
- 无 `directory-grants.json` 的独立 `dsh web` 保持现有整盘 browse，不得回归。
- TypeScript strict；网关相对导入带 `.ts`。每个任务以可独立运行的测试结束。

## 目标文件结构

```
gateway/
  src/
    db.ts              schema_version + migrateTo2
    projects.ts        ProjectService（替换 grants.ts）
    apply-grants.ts    写文件 + 按需重启
    users.ts           last-admin、displayName
    audit.ts           from/to/offset/action prefix
    admin-api.ts       /admin/api/* JSON（替换 admin.ts HTML CRUD）
    static.ts          /admin 静态与 SPA fallback
    server.ts          先 API，再静态，再代理
    proxy.ts           beforeStart 走 ProjectService
    index.ts           注入 ProjectService
  admin-ui/            Vite + React
  public/admin/        构建产物（gitignore 源，CI/启动前构建）
  tests/
    db-migrate.spec.ts
    projects.spec.ts
    apply-grants.spec.ts
    users.spec.ts
    admin-api.spec.ts
    audit.spec.ts

packages/host/directory-picker-browse/   list(undefined)=授权根；越权拒绝
packages/client/ui-workspace/            已有工作区不在授权根内则打开失败
plugins/dsh-directory-guard/             label 字段忽略（补测）
```

`gateway/src/grants.ts` 与 `gateway/src/admin.ts` 的 HTML CRUD 在 Task 2 / Task 5 删除。`html.ts` 只保留登录、改密、等待页。

---

### Task 1: schema_version 与项目表迁移

**Files:**
- Modify: `gateway/src/db.ts`
- Test: `gateway/tests/db.spec.ts`, Create: `gateway/tests/db-migrate.spec.ts`

**Interfaces:**
- Consumes: 现有 `users` / `instances` / `auth_sessions` / `audit_log` / 旧 `groups` / `dir_grants`
- Produces: `export const SCHEMA_VERSION = 2`；`openDb` 结束后必有 `projects`、`project_members`，且无 `groups` / `group_members` / `dir_grants`

- [ ] **Step 1: Write the failing migration test**

在 `gateway/tests/db-migrate.spec.ts`：

```ts
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.ts'

function tables(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>)
    .map(r => r.name)
}

describe('schema v2 migration', () => {
  it('creates project tables on a fresh database and records schema_version=2', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')
    const db = openDb(file)
    expect(tables(db)).toEqual(expect.arrayContaining(['projects', 'project_members', 'schema_meta']))
    expect(tables(db)).not.toEqual(expect.arrayContaining(['groups', 'dir_grants']))
    expect((db.prepare(`SELECT version FROM schema_meta`).get() as { version: number }).version).toBe(2)
  })

  it('folds dir_grants and group members into projects; rw beats ro; then drops old tables', () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-'))
    const shared = join(root, 'shared'); mkdirSync(shared)
    const file = join(root, 'legacy.sqlite')
    const raw = new Database(file)
    raw.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, home_path TEXT);
      CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT, description TEXT, created_at INTEGER);
      CREATE TABLE group_members (group_id INTEGER, user_id INTEGER, PRIMARY KEY(group_id, user_id));
      CREATE TABLE dir_grants (id INTEGER PRIMARY KEY, subject_type TEXT, subject_id INTEGER, path TEXT, mode TEXT, note TEXT, created_by INTEGER, created_at INTEGER);
    `)
    raw.prepare(`INSERT INTO users(id, username, home_path) VALUES(1,'alice',?), (2,'bob',?)`)
      .run(join(root, 'alice'), join(root, 'bob'))
    raw.prepare(`INSERT INTO groups(id, name, description, created_at) VALUES(1,'team','',0)`).run()
    raw.prepare(`INSERT INTO group_members(group_id, user_id) VALUES(1,1),(1,2)`).run()
    raw.prepare(`INSERT INTO dir_grants(subject_type, subject_id, path, mode, note, created_by, created_at)
      VALUES('group',1,?, 'ro','',NULL,0),('user',1,?, 'rw','',NULL,0)`).run(shared, shared)
    raw.close()

    const db = openDb(file)
    const project = db.prepare(`SELECT name, path FROM projects`).get() as { name: string; path: string }
    expect(project.path).toBe(shared)
    expect(project.name).toBe('shared')
    const members = db.prepare(`SELECT user_id, mode FROM project_members ORDER BY user_id`).all()
    expect(members).toEqual([{ user_id: 1, mode: 'rw' }, { user_id: 2, mode: 'ro' }])
    expect(tables(db)).not.toEqual(expect.arrayContaining(['groups', 'group_members', 'dir_grants']))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/db-migrate.spec.ts`

Expected: FAIL（`schema_meta` / `projects` 不存在）

- [ ] **Step 3: Write minimal implementation**

`gateway/src/db.ts`：

- 现有 `CREATE TABLE` 中**删除** `groups` / `group_members` / `dir_grants`。
- 增加：

```sql
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('ro','rw')),
  PRIMARY KEY (project_id, user_id)
);
```

- `openDb` 在 `db.exec(SCHEMA)` 之后调用 `migrate(db)`：
  - 若存在 `groups` 或 `dir_grants`：按 path 建项目（`name` = `basename(path)`，重名 `-2`、`-3`）；user 授权与该 path 的组成员入 `project_members`；同人 `rw` 覆盖 `ro`；然后 `DROP TABLE` 三张旧表。
  - `INSERT OR REPLACE` `schema_meta.version = 2`（表里只留一行）。
- 更新 `gateway/tests/db.spec.ts` 里枚举表名的断言，去掉 `groups` / `dir_grants`，加上 `projects` / `project_members` / `schema_meta`。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/db.spec.ts tests/db-migrate.spec.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/db.ts gateway/tests/db.spec.ts gateway/tests/db-migrate.spec.ts
git commit -m "$(cat <<'EOF'
feat(gateway): migrate directory grants into first-class projects

EOF
)"
```

---

### Task 2: ProjectService

**Files:**
- Create: `gateway/src/projects.ts`
- Delete: `gateway/src/grants.ts`（本任务末尾，先改完所有引用）
- Test: `gateway/tests/projects.spec.ts`（替换 `grants.spec.ts`）
- Modify: `gateway/src/server.ts`（`GatewayDeps.grants` → `projects: ProjectService`）、`gateway/src/index.ts`、`gateway/src/proxy.ts`、`gateway/src/admin.ts`（暂时只改类型，HTML 仍编译到下一任务）、所有 `GrantService` 测试 import

**Interfaces:**
- Consumes: `Database`、`GatewayConfig.usersRoot`
- Produces:

```ts
export type GrantMode = 'ro' | 'rw'
export interface EffectiveGrant { path: string; mode: GrantMode; label: string }
export interface ProjectRow {
  id: number; name: string; path: string; memberCount: number
}
export interface ProjectDetail extends ProjectRow {
  members: Array<{ userId: number; username: string; mode: GrantMode }>
}
export class ProjectService {
  constructor(db: Database.Database, cfg: GatewayConfig)
  create(input: { name: string; path: string; createdBy: number }): ProjectRow
  list(): ProjectRow[]
  getById(id: number): ProjectDetail | null
  rename(id: number, name: string): void
  remove(id: number): number[]  // 返回被撤掉的 userId，已排序
  setMember(projectId: number, userId: number, mode: GrantMode): void
  removeMember(projectId: number, userId: number): void
  effectiveGrants(userId: number): EffectiveGrant[]
}
```

- [ ] **Step 1: Write the failing ProjectService tests**

`gateway/tests/projects.spec.ts` 覆盖：home 恒 `rw` label `主目录`；成员项目带 name 作 label；非成员没有该 path；重名/重路径/路径不存在/路径等于 home 或 `usersRoot/<user>/dsh` 抛错；`setMember` 更新 mode；`remove` 返回成员 id。

```ts
it('effective grants are home plus member projects with labels', async () => {
  const { projects, alice, shared } = await setup()
  const p = projects.create({ name: 'Alpha', path: shared, createdBy: alice.id })
  projects.setMember(p.id, alice.id, 'ro')
  expect(projects.effectiveGrants(alice.id)).toEqual([
    { path: alice.homePath, mode: 'rw', label: '主目录' },
    { path: realpathSync(shared), mode: 'ro', label: 'Alpha' },
  ])
})
```

`setup` 与现 `grants.spec.ts` 相同，但 `new ProjectService(db, cfg)`。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/projects.spec.ts`

Expected: FAIL（模块不存在）

- [ ] **Step 3: Write ProjectService and retarget callers**

`create`：`realpathSync` + `statSync().isDirectory()`；拒绝 `path === user.home_path` 或 `path === join(cfg.usersRoot, username, 'dsh')`（对所有用户比较）；`UNIQUE` 冲突转成明确 Error。

`effectiveGrants`：先 push home，再 `JOIN project_members`，按 path 排序。

把 `GatewayDeps.grants` 改成 `projects`。`proxy.ts` `beforeStart` 写 `deps.projects.effectiveGrants(user.id)`。`index.ts` systemd `grantsProvider` 用 `effectiveGrants` 映射回 `{ path, mode }[]`（systemd 不需要 label）。

`admin.ts` 若仍引用 `grants.*`，先改成空组/空授权渲染或直接在本任务改 import 让 `tsc` 过（HTML CRUD 下一任务删）。删 `grants.ts` 与 `grants.spec.ts`。

- [ ] **Step 4: Run the gateway suite that still compiles**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/projects.spec.ts tests/db.spec.ts tests/proxy.spec.ts tests/instances.spec.ts tests/users.spec.ts tests/auth.spec.ts`

Expected: PASS。`admin.spec.ts` 若仍测组授权，本任务改成 skip 或删掉组断言，下一任务重写。

- [ ] **Step 5: Commit**

```bash
git add gateway/src/projects.ts gateway/src/grants.ts gateway/src/server.ts gateway/src/index.ts gateway/src/proxy.ts gateway/src/admin.ts gateway/tests
git commit -m "$(cat <<'EOF'
feat(gateway): replace group path grants with ProjectService

EOF
)"
```

---

### Task 3: 最后管理员与显示名

**Files:**
- Modify: `gateway/src/users.ts`
- Test: `gateway/tests/users.spec.ts`

**Interfaces:**
- Produces: `setDisplayName(id, name): void`；`setStatus` / `setRole` 在会去掉最后一个 active admin 时抛 `Error('cannot-remove-last-admin')`

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses to disable or demote the last active admin', async () => {
  const { users } = setup()
  const admin = await users.create({ username: 'boss', password: 'pw-123456', role: 'admin' })
  expect(() => users.setStatus(admin.id, 'disabled')).toThrow(/cannot-remove-last-admin/)
  expect(() => users.setRole(admin.id, 'user')).toThrow(/cannot-remove-last-admin/)
})

it('allows demoting an admin when another active admin remains', async () => {
  const { users } = setup()
  const a = await users.create({ username: 'a-admin', password: 'pw-123456', role: 'admin' })
  await users.create({ username: 'b-admin', password: 'pw-123456', role: 'admin' })
  users.setRole(a.id, 'user')
  expect(users.getById(a.id)?.role).toBe('user')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/users.spec.ts`

Expected: FAIL（当前 `setStatus`/`setRole` 无保护）

- [ ] **Step 3: Implement the guard**

```ts
private assertNotLastAdmin(id: number, next: { role?: 'admin' | 'user'; status?: 'active' | 'disabled' }): void {
  const row = this.getById(id)
  if (row === null || row.role !== 'admin' || row.status !== 'active') return
  const wouldLose = (next.role === 'user') || (next.status === 'disabled')
  if (!wouldLose) return
  const n = (this.db.prepare(
    `SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active' AND id != ?`,
  ).get(id) as { n: number }).n
  if (n === 0) throw new Error('cannot-remove-last-admin')
}
```

`setDisplayName`：`UPDATE users SET display_name=?, updated_at=?`。

- [ ] **Step 4: Run tests**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/users.spec.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/users.ts gateway/tests/users.spec.ts
git commit -m "$(cat <<'EOF'
fix(gateway): refuse removing the last active admin

EOF
)"
```

---

### Task 4: 写授权文件并按需重启

**Files:**
- Create: `gateway/src/apply-grants.ts`
- Test: `gateway/tests/apply-grants.spec.ts`
- Modify: `gateway/src/proxy.ts`（`beforeStart` 调同一写文件函数）

**Interfaces:**
- Produces:

```ts
export function writeGrantsFile(cfg: GatewayConfig, username: string, grants: EffectiveGrant[]): string
export async function applyGrantsToUser(
  deps: Pick<GatewayDeps, 'cfg' | 'projects' | 'users' | 'instances' | 'audit'>,
  userId: number,
  actorId: number,
): Promise<'restarted' | 'written'>
```

- [ ] **Step 1: Write the failing tests**

用现有 `ECHO_DSH` / `InstanceManager` 模式（见 `gateway/tests/proxy.spec.ts`）：`ensureRunning` 后 `applyGrantsToUser` → 进程被停再拉起，文件含 `label`；`stop` 后再 apply → 返回 `'written'`，端口上无进程。

```ts
it('restarts a live instance and only writes when stopped', async () => {
  // setup deps with ProjectService + InstanceManager + fake dsh
  await deps.instances.ensureRunning(alice)
  expect(await applyGrantsToUser(deps, alice.id, admin.id)).toBe('restarted')
  expect(deps.instances.isLive(alice.id)).toBe(true)
  const body = JSON.parse(readFileSync(join(root, 'users', 'alice', 'dsh', 'directory-grants.json'), 'utf8'))
  expect(body[0]).toMatchObject({ label: '主目录', mode: 'rw' })
  await deps.instances.stop(alice.id)
  expect(await applyGrantsToUser(deps, alice.id, admin.id)).toBe('written')
  await expect(fetch(`http://127.0.0.1:${deps.instances.portOf(alice.id)}/`)).rejects.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/apply-grants.spec.ts`

Expected: FAIL

- [ ] **Step 3: Implement**

`writeGrantsFile`：`mkdirSync` `$DSH_HOME`，`writeFileSync` pretty JSON。

`applyGrantsToUser`：取 user → 写文件 → 若 `stateOf` 为 `ready` 或 `starting`：`stop` + `ensureRunning`，成功 `'restarted'`；失败则 `audit.write({ action: 'admin.instances.restart-failed', ... })` 再 throw。否则 `'written'`。

`proxy.ts` `beforeStart` 改为 `writeGrantsFile(cfg, user.username, projects.effectiveGrants(user.id))`。

- [ ] **Step 4: Run tests**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/apply-grants.spec.ts tests/proxy.spec.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/apply-grants.ts gateway/src/proxy.ts gateway/tests/apply-grants.spec.ts
git commit -m "$(cat <<'EOF'
feat(gateway): rewrite grants and restart only live instances

EOF
)"
```

---

### Task 5: `/admin/api` JSON

**Files:**
- Create: `gateway/src/admin-api.ts`
- Delete: `gateway/src/admin.ts` HTML CRUD（或改成只 re-export `createAdminHandler`）
- Modify: `gateway/src/server.ts`（`/admin/api` 走 JSON；非 api 的 `/admin` 留给 Task 6 静态）、`gateway/src/audit.ts`（`fromMs`/`toMs`/`offset`/`actionPrefix`）
- Test: `gateway/tests/admin-api.spec.ts`（替换 `admin.spec.ts`）、`gateway/tests/audit.spec.ts`

**Interfaces:**
- Produces: `createAdminApiHandler(deps): NonNullable<GatewayHandlers['admin']>`。只处理 `pathname.startsWith('/admin/api')`，返回 `false` 让静态层接手。错误：`400/403/404/409` + `{ error: string }`。成功：`200` JSON 或 `204`。

路由按设计文档 §4 一字不差。成员写入与 `DELETE /projects/:id` 对每个受影响 `userId` 调 `applyGrantsToUser`（已停则只写文件）。`PATCH /users/:id` 捕获 `cannot-remove-last-admin` → 409。禁用用户：现有 `setStatus` + `instances.stop`。

审计：`query` 增加 `fromMs`、`toMs`、`offset`；`action` 改为 `action LIKE ?`（调用方传 `admin.projects%` 时自己加 `%`，或参数名 `actionPrefix` 在 SQL 里 `action LIKE prefix || '%'`）。

- [ ] **Step 1: Write the failing API tests**

`gateway/tests/admin-api.spec.ts` 沿用现 `admin.spec.ts` 的 `setup`/`post`，改为 `fetch` JSON：

```ts
it('lets an admin create a project and assign members; non-admin is 403', async () => {
  const { base, cookie, root, member } = await setup()
  const shared = join(root, 'shared'); mkdirSync(shared)
  const created = await fetch(`${base}/admin/api/projects`, {
    method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Alpha', path: shared }),
  })
  expect(created.status).toBe(200)
  const project = await created.json() as { id: number }
  expect((await fetch(`${base}/admin/api/projects/${project.id}/members/${member.id}`, {
    method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'ro' }),
  })).status).toBe(204)
  const workerCookie = await login(base, 'worker', 'pw-12345678')
  expect((await fetch(`${base}/admin/api/users`, { headers: { cookie: workerCookie } })).status).toBe(403)
})
```

再加：最后管理员 409；审计 `userId` 过滤。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/admin-api.spec.ts`

Expected: FAIL（仍是 HTML form 路由）

- [ ] **Step 3: Implement JSON router**

解析 `pathname` 用正则，例如：

```ts
const member = /^\/admin\/api\/projects\/(\d+)\/members\/(\d+)$/.exec(pathname)
```

body：`JSON.parse(await readBody(req))`，非法 JSON → 400。`createAdminHandler` 换成该 router。`index.ts` 改 import。

- [ ] **Step 4: Run tests**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/admin-api.spec.ts tests/audit.spec.ts tests/server.spec.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/admin-api.ts gateway/src/admin.ts gateway/src/server.ts gateway/src/audit.ts gateway/src/index.ts gateway/tests
git commit -m "$(cat <<'EOF'
feat(gateway): serve /admin/api JSON for users, projects, and audit

EOF
)"
```

---

### Task 6: 静态托管管理应用脚手架

**Files:**
- Create: `gateway/src/static.ts`、`gateway/admin-ui/package.json`、`gateway/admin-ui/vite.config.ts`、`gateway/admin-ui/tsconfig.json`、`gateway/admin-ui/index.html`、`gateway/admin-ui/src/main.tsx`、`gateway/admin-ui/src/App.tsx`
- Modify: `gateway/src/server.ts`（`/admin` 且非 `/admin/api` → 静态）、`gateway/package.json`（`build:admin`、`dev` 可先不 watch）、`gateway/.gitignore`（`public/admin`）
- Test: `gateway/tests/admin-static.spec.ts`

**Interfaces:**
- Produces: `serveAdmin(req, res, pathname): boolean` — 命中则写响应并返回 true

- [ ] **Step 1: Write the failing static test**

测试里先 `mkdirSync` 一个临时 `public/admin/index.html`（内容含 `data-testid="admin-app"`），把 `GatewayConfig` 或 `serveAdmin` 的根目录注入为该临时目录（在 `static.ts` 用 `cfg` 或参数 `root`，默认 `join(gatewayRoot, 'public/admin')`）。

```ts
it('serves the admin SPA shell for /admin and /admin/projects/1', async () => {
  const { base, cookie } = await setupWithAdminAssets()
  const page = await fetch(`${base}/admin`, { headers: { cookie, accept: 'text/html' } })
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('data-testid="admin-app"')
  const nested = await fetch(`${base}/admin/projects/1`, { headers: { cookie, accept: 'text/html' } })
  expect(nested.status).toBe(200)
  expect(await nested.text()).toContain('data-testid="admin-app"')
})
```

非 admin 仍 403（`server.ts` 在进静态之前已查 role）。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && ./node_modules/.bin/vitest run tests/admin-static.spec.ts`

Expected: FAIL

- [ ] **Step 3: Implement static + Vite hello**

`serveAdmin`：`/admin` 与无扩展名的 `/admin/...` → `index.html`；`/admin/assets/*` → 文件，按扩展名设 `content-type`（`.js` `.css` `.svg` `.map`）。路径必须 `realpath` 后仍在 `public/admin` 下，否则 404。

Vite：`base: '/admin/'`，`build.outDir: '../public/admin'`。`App.tsx` 先渲染导航「用户 / 项目 / 审计」和一个占位标题。`admin-ui` 依赖 `react` `react-dom` `react-router-dom`。

`gateway/package.json`：`"build:admin": "npm run build --prefix admin-ui"`。

- [ ] **Step 4: Build and run tests**

Run:

```
cd gateway/admin-ui && npm install && npm run build
cd ../ && ./node_modules/.bin/vitest run tests/admin-static.spec.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/static.ts gateway/src/server.ts gateway/admin-ui gateway/package.json gateway/.gitignore gateway/tests/admin-static.spec.ts
git commit -m "$(cat <<'EOF'
feat(gateway): host the admin SPA under /admin

EOF
)"
```

不要把 `node_modules` 或未约定的巨大 lock 噪声提交进仓库根 pnpm lock；`admin-ui` 自带 `package-lock.json`。

---

### Task 7: 管理端用户页与项目页

**Files:**
- Create: `gateway/admin-ui/src/api.ts`、`gateway/admin-ui/src/pages/UsersPage.tsx`、`gateway/admin-ui/src/pages/ProjectListPage.tsx`、`gateway/admin-ui/src/pages/ProjectDetailPage.tsx`、`gateway/admin-ui/src/pages/AuditPage.tsx`
- Modify: `gateway/admin-ui/src/App.tsx`（`BrowserRouter` `basename="/admin"`）
- Test: `gateway/admin-ui` 用 vitest + happy-dom 测 `api.ts` 的 URL 拼接，或对页面做最小 render 测（有确认对话框的按钮存在）。网关 API 已在 Task 5 覆盖，本任务不重复业务规则。

**Interfaces:**
- Consumes: Task 5 的 JSON 路径与字段
- Produces: 三个一级路由 `/`（用户）、`/projects`、`/audit`，详情 `/projects/:id`

- [ ] **Step 1: Write a failing UI test for the users table**

`gateway/admin-ui/src/pages/UsersPage.spec.tsx`：mock `api.listUsers` 返回一行，断言渲染用户名和「禁用」按钮；点击禁用先出现确认，再调用 `api.patchUser`。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway/admin-ui && npx vitest run src/pages/UsersPage.spec.tsx`

Expected: FAIL

- [ ] **Step 3: Implement pages**

`api.ts`：`fetch(url, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ... })`；非 GET 不需要手写 Origin（浏览器会带）。`!res.ok` 则 `throw new Error((await res.json()).error)`。

用户页：创建表单、列表、启用/禁用、重置密码（确认）、改角色、改显示名、启/停/重启。项目列表：名称、路径、成员数、新建（name + path）。项目详情：成员矩阵（每用户 无 / ro / rw），删项目确认。审计：`userId`、`actionPrefix`、时间、分页。

样式跟 `html.ts` 同一套（system-ui、`#0071e3`、白卡片），不引入组件库。

- [ ] **Step 4: Run UI tests and rebuild**

```
cd gateway/admin-ui && npx vitest run && npm run build
```

Expected: PASS，`gateway/public/admin` 更新

- [ ] **Step 5: Commit**

```bash
git add gateway/admin-ui
git commit -m "$(cat <<'EOF'
feat(gateway): add admin pages for users, projects, and audit

EOF
)"
```

---

### Task 8: browse 授权根与工作区打开失败

**Files:**
- Modify: `packages/host/directory-picker-browse/src/index.ts`、`packages/host/directory-picker-browse/tests/service.spec.ts`
- Modify: `packages/client/ui-workspace/src/client/WorkspacePicker.tsx`、`packages/client/ui-workspace/tests/workspace-picker.client.spec.tsx`
- Test: `plugins/dsh-directory-guard` 现有 grants 测试加一条带 `label` 的文件

**Interfaces:**
- Consumes: `$DSH_HOME/directory-grants.json`（或 `DSH_DIRECTORY_GRANTS`），格式与 guard 的 `loadGrants` 兼容（可多 `label`）
- Produces: 有授权文件且至少一条有效 path 时，`list(undefined)` 的 `entries` 为各根（`name=label||basename(path)`，`path` 为授权 path）；`list(outside)` / `createDirectory(outside)` 抛 `directory-unreadable` / `directory-create-failed`。无文件或空列表：保持今天的 OS home 行为。

- [ ] **Step 1: Write the failing browse tests**

在 `service.spec.ts` 增加：写临时 grants 文件，`DSH_DIRECTORY_GRANTS=...`，`list()` 只含这两个根；`list('/etc')` 抛错。再测无文件时 `list()` 仍回到 `homedir()`（现有断言）。

directory-guard：fixture JSON 带 `label`，越权仍 deny。

workspace picker：给 `useWorkspaces` 一项 `path: '/revoked'`，并让 `listDirectory()`（或新注入的 roots）不含它；点选后 `onPick` 不被调用，错误对话框出现。实现上在 `WorkspacePickFlow` 增加可选 `listAuthorizedRoots?: () => Promise<Array<{ path: string }>>`；缺省（独立 dsh）不检查。gateway 实例始终有文件，browse `list()` 即 roots，picker 在 `onPick` 已有 workspace 时用 `workspace.path` 对照最近一次 roots。

最小做法（避免改 slot 契约）：`WorkspacePickFlow` 在 `handleSelect` 里对已有 workspace 调 `listDirectory()`（无 path）。若返回的 entries 的 path 都不是该 workspace.path 的前缀，则走现有 error dialog，文案用已有 locale 或加 `menu.workspaceUnauthorized`（中英都要，走 ui-workspace 的 locale 注册）。

- [ ] **Step 2: Run tests to verify they fail**

```
pnpm --filter @deepseek-ai/dsh-host-directory-picker-browse exec vitest run
pnpm --filter @deepseek-ai/dsh-client-ui-workspace exec vitest run tests/workspace-picker.client.spec.tsx
```

Expected: FAIL

- [ ] **Step 3: Implement the fence and picker check**

browse：抽 `loadGrantRoots()`（读 JSON，忽略未知字段，`realpath` 失败则跳过）。`list(undefined)` 若 roots 非空：`{ path: roots[0].path, home: roots[0].path, crumbs: [], entries: rootsAsEntries, truncated: false }`。`list(path)`：`fullyQualified` 之后若 roots 非空且 `classify(roots, target)==='none'` 则 throw。crumbs 截断到包含该 path 的那个 grant root（不要露出 root 之上的 `/`）。`createDirectory` 同样 fence。

picker：`handleSelect` 对非 `ADD_WORKSPACE` 的 id，找到 `workspace.path`，`listDirectory()` 无 path，检查 containment（与 guard 相同的 segment-aware 前缀）。失败则 `setModalError` + `setErrorOpen(true)`，不 `onPick`。

- [ ] **Step 4: Run tests**

同上 filter 命令，外加 `pnpm --filter @deepseek-ai/dsh-directory-guard exec vitest run`。

Expected: PASS

- [ ] **Step 5: Update READMEs + Agent Note, then commit**

更新（成对）：

- `gateway/README.md` + `README.zh.md`：管理端是 `/admin` SPA + `/admin/api`；项目模型。
- `packages/host/directory-picker-browse/README.md` + `.zh.md`：存在 grants 文件时默认列表与越权拒绝。
- `plugins/dsh-directory-guard/README.md` + `.zh.md`：文件可含 `label`，强制仍只看 path。
- Agent Note：`.agents/notes/implemented/architecture/2026-08-14-project-centric-admin.{md,zh.md,i18n.yaml}`（问题/决策/备选/后果；配对哈希 `--write`）。

```bash
git add gateway/README.md gateway/README.zh.md packages/host/directory-picker-browse plugins/dsh-directory-guard packages/client/ui-workspace .agents/notes/implemented/architecture/2026-08-14-project-centric-admin.*
git commit -m "$(cat <<'EOF'
feat: constrain workspace add to authorized project roots

EOF
)"
```

---

### Task 9: 文档收口与手工验收清单

**Files:**
- Modify: `.agents/superpowers/specs/2026-08-14-project-centric-admin-design.md` 状态改为已实施（仅状态行，不改合同）
- 不改原 Phase 2 计划

- [ ] **Step 1: Confirm spec coverage**

对照设计文档 §1–§7：每个条款能指到 Task 1–8 的测试或页面。缺口补进对应任务，不要在本任务新开功能。

- [ ] **Step 2: Run the gateway test suite**

```
cd gateway && ./node_modules/.bin/vitest run
```

Expected: 全绿

- [ ] **Step 3: Manual acceptance on the Mac gateway**

1. `npm run build --prefix gateway/admin-ui`，重启 `com.maycran.harness-gateway`。
2. 管理员打开 `https://harness.maycran.com/admin`（实例可停）。
3. 建用户 A、B；建项目（已存在的共享目录）；A=`rw`，B=`ro`。
4. A 工作区列表有 home + 项目，能写；B 能读不能写。
5. 把 B 改为 `rw`，B 看到等待页后能写。
6. 移除 B，B 列表无该项目；点旧工作区失败提示。
7. 尝试禁用最后一个管理员 → 409 / 页面错误。

- [ ] **Step 4: Commit leftover doc nits only if the status line changed**

```bash
git add .agents/superpowers/specs/2026-08-14-project-centric-admin-design.md
git commit -m "$(cat <<'EOF'
docs: mark project-centric admin spec implemented

EOF
)"
```

---

## Self-review

**Spec coverage**

| 设计条款 | 任务 |
|---|---|
| 项目表、迁移、去组 | Task 1 |
| 有效授权 + 约束 | Task 2 |
| 最后管理员 | Task 3 |
| 改权写文件 + 只重启运行中实例 | Task 4 |
| `/admin/api` | Task 5 |
| `/admin` SPA 与实例无关 | Task 6–7 |
| 工作区只从授权根来；越权 browse 拒绝；撤权打开失败 | Task 8 |
| 测试与手工验收 | 各任务 + Task 9 |
| 非目标（组/SSO/Linux/销号/实例内管理） | 未列入任务 |

**Placeholder scan:** 无 TBD。Host 方法没有新开 RPC：复用 `listDirectory()` 无 path 作为授权根列表。

**Type consistency:** `EffectiveGrant`、`ProjectService`、`applyGrantsToUser`、`GatewayDeps.projects` 在 Task 2–5 名称一致。
