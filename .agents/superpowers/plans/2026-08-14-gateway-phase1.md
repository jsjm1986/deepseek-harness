# 网关 Phase 1（MVP）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付门户网关 MVP：登录认证、用户/组/目录授权管理、每用户 dsh 实例的拉起/代理/休眠、管理后台与审计，在 Mac 开发环境完成双用户联调。

**Architecture:** 独立 Node/TS 服务位于仓库根 `gateway/`（不在 pnpm workspace 内，自带 npm 依赖）。`node:http` 服务器分三类路径：网关自有页面（/login、/admin 等）、健康检查、其余全部按登录 Cookie 反向代理到该用户的 dsh 实例（HTTP + WebSocket，改写 Host/Origin 为实例回环地址）。实例由 InstanceManager 以子进程拉起（Phase 2 换 systemd），SQLite 存全部状态。

**Tech Stack:** Node 22+、TypeScript(strict, ESM)、better-sqlite3、argon2、http-proxy、vitest、tsx（开发运行）。

## Global Constraints

- 设计文档：`.agents/superpowers/specs/2026-08-14-user-directory-permission-gateway-design.md`（本计划实现其 §12 Phase 1；上游同步策略见 §15）。
- **上游解耦（§15）**：最终代码归属独立仓库 `harness-platform`，dsh 以钉死版本 npm 依赖进入，不 vendored 源码、不改 `packages/`/`apps/`。本计划路径 `gateway/`、`plugins/` 均相对该独立仓库根；当前 dsh clone 仅供调研，实施启动即迁出。
- 开发期实例可用源码运行（`HGW_DSH_COMMAND` 指向 clone 的 `apps/cli/src/bin.ts`）；生产期该变量指向 npm 安装的 `@deepseek-ai/dsh` 二进制——同一配置项切换，无代码差异。
- TypeScript strict；`"type": "module"`；相对导入带 `.ts` 后缀由 tsx/vitest 解析。
- 持久数据一律进 `gateway/data/`（gitignore）；测试用 `fs.mkdtempSync` 临时目录。
- 绝不记录明文密码/令牌；audit `detail` 字段不含请求体。
- 密码哈希 argon2id（memoryCost 19456, timeCost 2, parallelism 1）。
- 会话 Cookie：`hgw_session`，HttpOnly + SameSite=Lax，Secure 当 publicOrigin 为 https；滑动 7 天、绝对 30 天。
- 登录失败锁定：同一 username+ip 10 分钟内 5 次失败 → 锁 10 分钟。
- CSRF：所有非 GET 请求与 WS upgrade：`Origin` 头必须 ∈ 配置的 publicOrigins。
- 目录授权路径入库前 `fs.realpathSync` 规范化且必须是已存在目录；同路径 rw 覆盖 ro；用户主目录恒为 rw。
- 端口分配：42000 起，`MAX(port)+1`，落库不复用。
- 每个任务以 `git add gateway/... && git commit` 结束（仅本地提交）。

## 目标文件结构

```
gateway/
  package.json  tsconfig.json  vitest.config.ts  .gitignore
  src/
    config.ts      db.ts         password.ts   auth.ts
    users.ts       grants.ts     audit.ts      instances.ts
    proxy.ts       server.ts     admin.ts      html.ts
    index.ts
  tests/
    config.spec.ts db.spec.ts    auth.spec.ts  users.spec.ts
    grants.spec.ts audit.spec.ts instances.spec.ts
    server.spec.ts proxy.spec.ts admin.spec.ts
```

---

### Task 1: 脚手架与配置模块

**Files:**
- Create: `gateway/package.json`, `gateway/tsconfig.json`, `gateway/vitest.config.ts`, `gateway/.gitignore`, `gateway/src/config.ts`
- Test: `gateway/tests/config.spec.ts`

**Interfaces:**
- Produces: `interface GatewayConfig { port: number; publicOrigins: string[]; dataDir: string; usersRoot: string; dshCommand: string[]; dshRepoRoot: string; instancePortBase: number; idleTimeoutMs: number; readinessTimeoutMs: number; sessionTtlMs: number; sessionAbsoluteTtlMs: number; secureCookies: boolean }`
- Produces: `function loadConfig(env?: NodeJS.ProcessEnv): GatewayConfig`（环境变量前缀 `HGW_`）

- [ ] **Step 1: 创建工程文件**

`gateway/package.json`：

```json
{
  "name": "harness-gateway",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "argon2": "^0.44.0",
    "better-sqlite3": "^12.4.1",
    "http-proxy": "^1.18.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/http-proxy": "^1.17.16",
    "@types/node": "^22.20.0",
    "@types/ws": "^8.18.1",
    "tsx": "^4.22.4",
    "typescript": "^5.9.2",
    "vitest": "^4.1.8",
    "ws": "^8.18.3"
  }
}
```

`gateway/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`gateway/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/**/*.spec.ts'], testTimeout: 30000 },
})
```

`gateway/.gitignore`：

```
node_modules/
data/
*.log
```

- [ ] **Step 2: 安装依赖**

Run: `cd gateway && npm install`
Expected: 无错误退出（argon2/better-sqlite3 需本地编译，Apple Silicon 有预编译产物）。

- [ ] **Step 3: 写失败测试**

`gateway/tests/config.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('loadConfig', () => {
  it('provides workable defaults', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(8899)
    expect(cfg.instancePortBase).toBe(42000)
    expect(cfg.publicOrigins).toEqual(['http://127.0.0.1:8899'])
    expect(cfg.secureCookies).toBe(false)
    expect(cfg.dshCommand).toContain('{port}')
  })

  it('honors HGW_ environment overrides', () => {
    const cfg = loadConfig({
      HGW_PORT: '9001',
      HGW_PUBLIC_ORIGINS: 'https://harness.maycran.com,http://127.0.0.1:9001',
      HGW_USERS_ROOT: '/srv/harness/users',
      HGW_IDLE_TIMEOUT_MS: '60000',
    })
    expect(cfg.port).toBe(9001)
    expect(cfg.publicOrigins).toEqual(['https://harness.maycran.com', 'http://127.0.0.1:9001'])
    expect(cfg.usersRoot).toBe('/srv/harness/users')
    expect(cfg.idleTimeoutMs).toBe(60000)
    expect(cfg.secureCookies).toBe(true)
  })
})
```

- [ ] **Step 4: 运行确认失败**

Run: `cd gateway && npx vitest run tests/config.spec.ts`
Expected: FAIL（`../src/config.ts` 不存在）。

- [ ] **Step 5: 实现 config.ts**

```ts
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface GatewayConfig {
  port: number
  publicOrigins: string[]
  dataDir: string
  usersRoot: string
  dshCommand: string[]
  dshRepoRoot: string
  instancePortBase: number
  idleTimeoutMs: number
  readinessTimeoutMs: number
  sessionTtlMs: number
  sessionAbsoluteTtlMs: number
  secureCookies: boolean
}

const gatewayRoot = resolve(import.meta.dirname, '..')

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env.HGW_PORT ?? 8899)
  const publicOrigins = (env.HGW_PUBLIC_ORIGINS ?? `http://127.0.0.1:${port}`)
    .split(',').map(s => s.trim()).filter(Boolean)
  return {
    port,
    publicOrigins,
    dataDir: env.HGW_DATA_DIR ?? join(gatewayRoot, 'data'),
    usersRoot: env.HGW_USERS_ROOT ?? join(homedir(), 'harness-users'),
    dshCommand: env.HGW_DSH_COMMAND?.split(' ')
      ?? ['node', '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--port', '{port}'],
    dshRepoRoot: env.HGW_DSH_REPO_ROOT ?? resolve(gatewayRoot, '..'),
    instancePortBase: Number(env.HGW_INSTANCE_PORT_BASE ?? 42000),
    idleTimeoutMs: Number(env.HGW_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000),
    readinessTimeoutMs: Number(env.HGW_READINESS_TIMEOUT_MS ?? 30 * 1000),
    sessionTtlMs: Number(env.HGW_SESSION_TTL_MS ?? 7 * 24 * 3600 * 1000),
    sessionAbsoluteTtlMs: Number(env.HGW_SESSION_ABS_TTL_MS ?? 30 * 24 * 3600 * 1000),
    secureCookies: publicOrigins.some(o => o.startsWith('https://')),
  }
}
```

- [ ] **Step 6: 测试通过并提交**

Run: `cd gateway && npx vitest run tests/config.spec.ts && npx tsc --noEmit`
Expected: PASS。

```bash
git add gateway && git commit -m "feat(gateway): scaffold project and config module"
```

---

### Task 2: 数据库层与 schema

**Files:**
- Create: `gateway/src/db.ts`
- Test: `gateway/tests/db.spec.ts`

**Interfaces:**
- Produces: `function openDb(file: string): Database.Database`（WAL、外键开启、幂等建表）
- 表：`users, groups, group_members, dir_grants, auth_sessions, login_attempts, instances, audit_log`（列见 schema）

- [ ] **Step 1: 失败测试**

`gateway/tests/db.spec.ts`：

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'

describe('openDb', () => {
  it('creates all tables idempotently and enforces constraints', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')
    const db = openDb(file)
    openDb(file)
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
      .map(r => (r as { name: string }).name)
    for (const t of ['users', 'groups', 'group_members', 'dir_grants', 'auth_sessions', 'login_attempts', 'instances', 'audit_log']) {
      expect(names).toContain(t)
    }
    expect(() => db.prepare(
      `INSERT INTO users(username, password_hash, home_path, role) VALUES('x', 'h', '/x', 'superman')`,
    ).run()).toThrow()
    expect(String(db.pragma('journal_mode', { simple: true }))).toBe('wal')
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/db.spec.ts` → FAIL。

- [ ] **Step 3: 实现 db.ts**

```ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  home_path TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS dir_grants (
  id INTEGER PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user','group')),
  subject_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('ro','rw')),
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, ip, ts);
CREATE TABLE IF NOT EXISTS instances (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  port INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'stopped' CHECK (state IN ('stopped','starting','ready','stopping')),
  pid INTEGER,
  started_at INTEGER,
  last_activity_at INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  method_path TEXT NOT NULL DEFAULT '',
  status INTEGER,
  ip TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`

export function openDb(file: string): Database.Database {
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}
```

- [ ] **Step 4: 通过并提交**

Run: `cd gateway && npx vitest run tests/db.spec.ts`
Expected: PASS。

```bash
git add gateway/src/db.ts gateway/tests/db.spec.ts && git commit -m "feat(gateway): sqlite schema and connection helper"
```

---

### Task 3: 认证服务（密码 + 会话 + 锁定）

**Files:**
- Create: `gateway/src/password.ts`, `gateway/src/auth.ts`
- Test: `gateway/tests/auth.spec.ts`

**Interfaces:**
- Consumes: `openDb`（Task 2）、`GatewayConfig`（Task 1）
- Produces: `hashPassword(pw: string): Promise<string>`、`verifyPassword(hash: string, pw: string): Promise<boolean>`
- Produces: `class AuthService { constructor(db, cfg); login(username, password, ip, ua): Promise<{ token: string; user: UserRow } | 'invalid' | 'locked'>; validate(token: string): UserRow | null; revoke(token: string): void }`
- Produces: `interface UserRow { id: number; username: string; displayName: string; role: 'admin' | 'user'; status: 'active' | 'disabled'; homePath: string; mustChangePassword: boolean }`

- [ ] **Step 1: 失败测试**

`gateway/tests/auth.spec.ts`：

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { hashPassword } from '../src/password.ts'

async function setup() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite'))
  const now = Date.now()
  db.prepare(`INSERT INTO users(username, password_hash, home_path, role, must_change_password, created_at, updated_at)
              VALUES('alice', ?, '/tmp/alice', 'user', 0, ?, ?)`)
    .run(await hashPassword('secret-1'), now, now)
  return { db, auth: new AuthService(db, loadConfig({})) }
}

describe('AuthService', () => {
  it('logs in, validates with sliding expiry, revokes', async () => {
    const { auth } = await setup()
    const result = await auth.login('alice', 'secret-1', '1.2.3.4', 'ua')
    if (result === 'invalid' || result === 'locked') throw new Error(result)
    expect(result.user.username).toBe('alice')
    expect(auth.validate(result.token)?.username).toBe('alice')
    auth.revoke(result.token)
    expect(auth.validate(result.token)).toBeNull()
  })

  it('rejects wrong password and locks after 5 failures', async () => {
    const { auth } = await setup()
    for (let i = 0; i < 5; i++) {
      expect(await auth.login('alice', 'nope', '9.9.9.9', 'ua')).toBe('invalid')
    }
    expect(await auth.login('alice', 'secret-1', '9.9.9.9', 'ua')).toBe('locked')
    const elsewhere = await auth.login('alice', 'secret-1', '8.8.8.8', 'ua')
    expect(elsewhere).not.toBe('locked')
  })

  it('rejects disabled users and unknown tokens', async () => {
    const { db, auth } = await setup()
    db.prepare(`UPDATE users SET status='disabled'`).run()
    expect(await auth.login('alice', 'secret-1', '1.1.1.1', 'ua')).toBe('invalid')
    expect(auth.validate('bogus')).toBeNull()
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/auth.spec.ts` → FAIL。

- [ ] **Step 3: 实现 password.ts**

```ts
import argon2 from 'argon2'

const OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS)
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false)
}
```

- [ ] **Step 4: 实现 auth.ts**

```ts
import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { GatewayConfig } from './config.ts'
import { verifyPassword } from './password.ts'

export interface UserRow {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  homePath: string
  mustChangePassword: boolean
}

const LOCK_WINDOW_MS = 10 * 60 * 1000
const LOCK_THRESHOLD = 5

interface DbUser {
  id: number
  username: string
  password_hash: string
  display_name: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  home_path: string
  must_change_password: number
}

export function toUserRow(row: DbUser): UserRow {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    homePath: row.home_path,
    mustChangePassword: row.must_change_password === 1,
  }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class AuthService {
  constructor(private readonly db: Database.Database, private readonly cfg: GatewayConfig) {}

  async login(username: string, password: string, ip: string, userAgent: string):
  Promise<{ token: string; user: UserRow } | 'invalid' | 'locked'> {
    const now = Date.now()
    const failures = this.db.prepare(
      `SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND ip = ? AND ts > ?`,
    ).get(username, ip, now - LOCK_WINDOW_MS) as { n: number }
    if (failures.n >= LOCK_THRESHOLD) return 'locked'

    const row = this.db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as DbUser | undefined
    const ok = row !== undefined && row.status === 'active' && await verifyPassword(row.password_hash, password)
    if (!ok) {
      this.db.prepare(`INSERT INTO login_attempts(username, ip, ts) VALUES(?, ?, ?)`).run(username, ip, now)
      return 'invalid'
    }

    this.db.prepare(`DELETE FROM login_attempts WHERE username = ? AND ip = ?`).run(username, ip)
    const token = randomBytes(32).toString('base64url')
    this.db.prepare(
      `INSERT INTO auth_sessions(user_id, token_hash, created_at, expires_at, absolute_expires_at, last_seen_at, ip, user_agent)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, tokenHash(token), now, now + this.cfg.sessionTtlMs, now + this.cfg.sessionAbsoluteTtlMs, now, ip, userAgent)
    return { token, user: toUserRow(row) }
  }

  validate(token: string): UserRow | null {
    const now = Date.now()
    const session = this.db.prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?`).get(tokenHash(token)) as
      { id: number; user_id: number; expires_at: number; absolute_expires_at: number } | undefined
    if (session === undefined || session.expires_at < now || session.absolute_expires_at < now) return null
    this.db.prepare(`UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`)
      .run(now, Math.min(now + this.cfg.sessionTtlMs, session.absolute_expires_at), session.id)
    const user = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(session.user_id) as DbUser | undefined
    if (user === undefined || user.status !== 'active') return null
    return toUserRow(user)
  }

  revoke(token: string): void {
    this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(tokenHash(token))
  }
}
```

- [ ] **Step 5: 通过并提交**

Run: `cd gateway && npx vitest run tests/auth.spec.ts && npx tsc --noEmit`
Expected: PASS。

```bash
git add gateway/src/password.ts gateway/src/auth.ts gateway/tests/auth.spec.ts && git commit -m "feat(gateway): argon2 auth with sliding sessions and lockout"
```

---

### Task 4: 用户服务（开号、目录、端口）

**Files:**
- Create: `gateway/src/users.ts`
- Test: `gateway/tests/users.spec.ts`

**Interfaces:**
- Consumes: `openDb`、`GatewayConfig`、`hashPassword`、`UserRow`/`toUserRow`
- Produces: `class UserService { constructor(db, cfg); create(input: { username: string; password: string; role?: 'admin' | 'user'; displayName?: string }): Promise<UserRow>; list(): Array<UserRow & { port: number; instanceState: string }>; getById(id: number): UserRow | null; getByUsername(name: string): UserRow | null; setStatus(id, status): void; setRole(id, role): void; resetPassword(id: number, newPassword: string): Promise<void>; changeOwnPassword(id: number, newPassword: string): Promise<void>; count(): number }`
- 规则：username 匹配 `/^[a-z][a-z0-9-]{1,30}$/`；create 建 `<usersRoot>/<u>/home` 与 `<usersRoot>/<u>/dsh` 目录；分配端口 `MAX(port)+1`（空表用 `instancePortBase`）并插入 instances 行（state=stopped）；resetPassword 置 `must_change_password=1`，changeOwnPassword 置 0。

- [ ] **Step 1: 失败测试**

`gateway/tests/users.spec.ts`：

```ts
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { UserService } from '../src/users.ts'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users') })
  return { db, cfg, users: new UserService(db, cfg) }
}

describe('UserService', () => {
  it('provisions home dirs and sequential ports', async () => {
    const { cfg, users } = setup()
    const alice = await users.create({ username: 'alice', password: 'pw-123456' })
    await users.create({ username: 'bob', password: 'pw-123456' })
    expect(existsSync(join(cfg.usersRoot, 'alice', 'home'))).toBe(true)
    expect(existsSync(join(cfg.usersRoot, 'alice', 'dsh'))).toBe(true)
    const listed = users.list()
    expect(listed.map(u => u.port)).toEqual([42000, 42001])
    expect(alice.mustChangePassword).toBe(true)
  })

  it('rejects invalid or duplicate usernames', async () => {
    const { users } = setup()
    await users.create({ username: 'alice', password: 'pw-123456' })
    await expect(users.create({ username: 'alice', password: 'x' })).rejects.toThrow()
    await expect(users.create({ username: 'Bad Name', password: 'x' })).rejects.toThrow()
  })

  it('manages status, role and password lifecycle', async () => {
    const { users } = setup()
    const u = await users.create({ username: 'carol', password: 'pw-123456', role: 'admin' })
    users.setStatus(u.id, 'disabled')
    expect(users.getById(u.id)?.status).toBe('disabled')
    await users.changeOwnPassword(u.id, 'pw-654321')
    expect(users.getById(u.id)?.mustChangePassword).toBe(false)
    await users.resetPassword(u.id, 'pw-000000')
    expect(users.getById(u.id)?.mustChangePassword).toBe(true)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/users.spec.ts` → FAIL。

- [ ] **Step 3: 实现 users.ts**

```ts
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { toUserRow, type UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'
import { hashPassword } from './password.ts'

const USERNAME_RE = /^[a-z][a-z0-9-]{1,30}$/

export class UserService {
  constructor(private readonly db: Database.Database, private readonly cfg: GatewayConfig) {}

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n
  }

  async create(input: { username: string; password: string; role?: 'admin' | 'user'; displayName?: string }): Promise<UserRow> {
    if (!USERNAME_RE.test(input.username)) throw new Error(`invalid username: ${input.username}`)
    const homePath = join(this.cfg.usersRoot, input.username, 'home')
    mkdirSync(homePath, { recursive: true })
    mkdirSync(join(this.cfg.usersRoot, input.username, 'dsh'), { recursive: true })
    const now = Date.now()
    const hash = await hashPassword(input.password)
    const insert = this.db.transaction(() => {
      const info = this.db.prepare(
        `INSERT INTO users(username, password_hash, display_name, role, home_path, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.username, hash, input.displayName ?? input.username, input.role ?? 'user', homePath, now, now)
      const userId = Number(info.lastInsertRowid)
      const maxPort = (this.db.prepare(`SELECT MAX(port) AS p FROM instances`).get() as { p: number | null }).p
      this.db.prepare(`INSERT INTO instances(user_id, port, state) VALUES(?, ?, 'stopped')`)
        .run(userId, maxPort === null ? this.cfg.instancePortBase : maxPort + 1)
      return userId
    })
    const id = insert()
    const row = this.getById(id)
    if (row === null) throw new Error('user row missing after insert')
    return row
  }

  list(): Array<UserRow & { port: number; instanceState: string }> {
    const rows = this.db.prepare(
      `SELECT u.*, i.port AS port, i.state AS instance_state
       FROM users u JOIN instances i ON i.user_id = u.id ORDER BY u.id`,
    ).all() as never[]
    return rows.map((r) => {
      const raw = r as { port: number; instance_state: string }
      return { ...toUserRow(r), port: raw.port, instanceState: raw.instance_state }
    })
  }

  getById(id: number): UserRow | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id)
    return row === undefined ? null : toUserRow(row as never)
  }

  getByUsername(username: string): UserRow | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE username = ?`).get(username)
    return row === undefined ? null : toUserRow(row as never)
  }

  setStatus(id: number, status: 'active' | 'disabled'): void {
    this.db.prepare(`UPDATE users SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id)
    if (status === 'disabled') this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(id)
  }

  setRole(id: number, role: 'admin' | 'user'): void {
    this.db.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).run(role, Date.now(), id)
  }

  async resetPassword(id: number, newPassword: string): Promise<void> {
    this.db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?`)
      .run(await hashPassword(newPassword), Date.now(), id)
    this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(id)
  }

  async changeOwnPassword(id: number, newPassword: string): Promise<void> {
    this.db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`)
      .run(await hashPassword(newPassword), Date.now(), id)
  }
}
```

- [ ] **Step 4: 通过并提交**

Run: `cd gateway && npx vitest run tests/users.spec.ts`
Expected: PASS。

```bash
git add gateway/src/users.ts gateway/tests/users.spec.ts && git commit -m "feat(gateway): user provisioning with home dirs and port allocation"
```

---

### Task 5: 组与目录授权服务

**Files:**
- Create: `gateway/src/grants.ts`
- Test: `gateway/tests/grants.spec.ts`

**Interfaces:**
- Consumes: `openDb`
- Produces: `class GrantService { constructor(db); createGroup(name, description?): number; deleteGroup(id): void; listGroups(): Array<{ id: number; name: string; description: string; members: string[] }>; addMember(groupId, userId): void; removeMember(groupId, userId): void; addGrant(input: { subjectType: 'user' | 'group'; subjectId: number; path: string; mode: 'ro' | 'rw'; note?: string; createdBy?: number }): number; removeGrant(id): void; listGrants(): GrantRow[]; effectiveGrants(userId: number): Array<{ path: string; mode: 'ro' | 'rw' }> }`
- Produces: `interface GrantRow { id: number; subjectType: 'user' | 'group'; subjectId: number; path: string; mode: 'ro' | 'rw'; note: string }`
- 规则：`addGrant` 用 `fs.realpathSync` 规范化，目标必须是已存在目录，否则抛错；`effectiveGrants` = 用户直授 ∪ 所在组授权，按 path 合并且 rw 覆盖 ro，再并入 `users.home_path`（恒 rw），按 path 排序。

- [ ] **Step 1: 失败测试**

`gateway/tests/grants.spec.ts`：

```ts
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { GrantService } from '../src/grants.ts'
import { UserService } from '../src/users.ts'

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const users = new UserService(db, loadConfig({ HGW_USERS_ROOT: join(root, 'users') }))
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  const shared = join(root, 'shared'); mkdirSync(shared)
  const docs = join(root, 'docs'); mkdirSync(docs)
  return { db, grants: new GrantService(db), alice, shared, docs }
}

describe('GrantService', () => {
  it('merges user and group grants with rw beating ro, home always rw', async () => {
    const { grants, alice, shared, docs } = await setup()
    const g = grants.createGroup('team-a')
    grants.addMember(g, alice.id)
    grants.addGrant({ subjectType: 'group', subjectId: g, path: shared, mode: 'ro' })
    grants.addGrant({ subjectType: 'user', subjectId: alice.id, path: shared, mode: 'rw' })
    grants.addGrant({ subjectType: 'group', subjectId: g, path: docs, mode: 'ro' })
    const effective = grants.effectiveGrants(alice.id)
    expect(effective).toContainEqual({ path: shared, mode: 'rw' })
    expect(effective).toContainEqual({ path: docs, mode: 'ro' })
    expect(effective).toContainEqual({ path: alice.homePath, mode: 'rw' })
  })

  it('rejects grants on missing paths and cleans up with group deletion', async () => {
    const { grants, alice } = await setup()
    expect(() => grants.addGrant({ subjectType: 'user', subjectId: alice.id, path: '/no/such/dir-xyz', mode: 'ro' }))
      .toThrow()
    const g = grants.createGroup('temp')
    grants.addMember(g, alice.id)
    grants.deleteGroup(g)
    expect(grants.listGroups()).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/grants.spec.ts` → FAIL。

- [ ] **Step 3: 实现 grants.ts**

```ts
import { realpathSync, statSync } from 'node:fs'
import type Database from 'better-sqlite3'

export interface GrantRow {
  id: number
  subjectType: 'user' | 'group'
  subjectId: number
  path: string
  mode: 'ro' | 'rw'
  note: string
}

export class GrantService {
  constructor(private readonly db: Database.Database) {}

  createGroup(name: string, description = ''): number {
    const info = this.db.prepare(`INSERT INTO groups(name, description, created_at) VALUES(?, ?, ?)`)
      .run(name, description, Date.now())
    return Number(info.lastInsertRowid)
  }

  deleteGroup(id: number): void {
    this.db.prepare(`DELETE FROM dir_grants WHERE subject_type = 'group' AND subject_id = ?`).run(id)
    this.db.prepare(`DELETE FROM groups WHERE id = ?`).run(id)
  }

  listGroups(): Array<{ id: number; name: string; description: string; members: string[] }> {
    const groups = this.db.prepare(`SELECT * FROM groups ORDER BY id`).all() as
      Array<{ id: number; name: string; description: string }>
    const members = this.db.prepare(
      `SELECT gm.group_id AS gid, u.username AS name FROM group_members gm JOIN users u ON u.id = gm.user_id`,
    ).all() as Array<{ gid: number; name: string }>
    return groups.map(g => ({
      ...g,
      members: members.filter(m => m.gid === g.id).map(m => m.name),
    }))
  }

  addMember(groupId: number, userId: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO group_members(group_id, user_id) VALUES(?, ?)`).run(groupId, userId)
  }

  removeMember(groupId: number, userId: number): void {
    this.db.prepare(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`).run(groupId, userId)
  }

  addGrant(input: { subjectType: 'user' | 'group'; subjectId: number; path: string; mode: 'ro' | 'rw'; note?: string; createdBy?: number }): number {
    const canonical = realpathSync(input.path)
    if (!statSync(canonical).isDirectory()) throw new Error(`not a directory: ${canonical}`)
    const info = this.db.prepare(
      `INSERT INTO dir_grants(subject_type, subject_id, path, mode, note, created_by, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.subjectType, input.subjectId, canonical, input.mode, input.note ?? '', input.createdBy ?? null, Date.now())
    return Number(info.lastInsertRowid)
  }

  removeGrant(id: number): void {
    this.db.prepare(`DELETE FROM dir_grants WHERE id = ?`).run(id)
  }

  listGrants(): GrantRow[] {
    const rows = this.db.prepare(`SELECT * FROM dir_grants ORDER BY id`).all() as
      Array<{ id: number; subject_type: 'user' | 'group'; subject_id: number; path: string; mode: 'ro' | 'rw'; note: string }>
    return rows.map(r => ({ id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, path: r.path, mode: r.mode, note: r.note }))
  }

  effectiveGrants(userId: number): Array<{ path: string; mode: 'ro' | 'rw' }> {
    const merged = new Map<string, 'ro' | 'rw'>()
    const apply = (path: string, mode: 'ro' | 'rw') => {
      if (mode === 'rw' || !merged.has(path)) merged.set(path, merged.get(path) === 'rw' ? 'rw' : mode)
    }
    const rows = this.db.prepare(
      `SELECT path, mode FROM dir_grants
       WHERE (subject_type = 'user' AND subject_id = ?)
          OR (subject_type = 'group' AND subject_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`,
    ).all(userId, userId) as Array<{ path: string; mode: 'ro' | 'rw' }>
    for (const row of rows) apply(row.path, row.mode)
    const home = this.db.prepare(`SELECT home_path FROM users WHERE id = ?`).get(userId) as { home_path: string } | undefined
    if (home !== undefined) merged.set(home.home_path, 'rw')
    return [...merged.entries()].map(([path, mode]) => ({ path, mode })).sort((a, b) => a.path.localeCompare(b.path))
  }
}
```

- [ ] **Step 4: 通过并提交**

Run: `cd gateway && npx vitest run tests/grants.spec.ts`
Expected: PASS。

```bash
git add gateway/src/grants.ts gateway/tests/grants.spec.ts && git commit -m "feat(gateway): groups and directory grants with rw-over-ro merge"
```

---

### Task 6: 审计服务

**Files:**
- Create: `gateway/src/audit.ts`
- Test: `gateway/tests/audit.spec.ts`

**Interfaces:**
- Consumes: `openDb`
- Produces: `class AuditService { constructor(db); write(entry: { userId?: number; action: string; methodPath?: string; status?: number; ip?: string; detail?: string }): void; query(filter?: { userId?: number; action?: string; sinceMs?: number; limit?: number }): AuditRow[] }`
- Produces: `interface AuditRow { id: number; ts: number; userId: number | null; action: string; methodPath: string; status: number | null; ip: string; detail: string }`

- [ ] **Step 1: 失败测试**

`gateway/tests/audit.spec.ts`：

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { openDb } from '../src/db.ts'

describe('AuditService', () => {
  it('writes and filters entries', () => {
    const audit = new AuditService(openDb(join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')))
    audit.write({ userId: 1, action: 'login', ip: '1.1.1.1' })
    audit.write({ userId: 1, action: 'api', methodPath: 'POST /api/session.prompt', status: 200 })
    audit.write({ userId: 2, action: 'api', methodPath: 'POST /api/session.create', status: 200 })
    expect(audit.query({ userId: 1 })).toHaveLength(2)
    expect(audit.query({ action: 'login' })[0]?.ip).toBe('1.1.1.1')
    expect(audit.query({ limit: 1 })).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/audit.spec.ts` → FAIL。

- [ ] **Step 3: 实现 audit.ts**

```ts
import type Database from 'better-sqlite3'

export interface AuditRow {
  id: number
  ts: number
  userId: number | null
  action: string
  methodPath: string
  status: number | null
  ip: string
  detail: string
}

export class AuditService {
  constructor(private readonly db: Database.Database) {}

  write(entry: { userId?: number; action: string; methodPath?: string; status?: number; ip?: string; detail?: string }): void {
    this.db.prepare(
      `INSERT INTO audit_log(ts, user_id, action, method_path, status, ip, detail) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(Date.now(), entry.userId ?? null, entry.action, entry.methodPath ?? '', entry.status ?? null, entry.ip ?? '', entry.detail ?? '')
  }

  query(filter: { userId?: number; action?: string; sinceMs?: number; limit?: number } = {}): AuditRow[] {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.userId !== undefined) { clauses.push('user_id = ?'); params.push(filter.userId) }
    if (filter.action !== undefined) { clauses.push('action = ?'); params.push(filter.action) }
    if (filter.sinceMs !== undefined) { clauses.push('ts >= ?'); params.push(filter.sinceMs) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(
      `SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`,
    ).all(...params, filter.limit ?? 200) as
      Array<{ id: number; ts: number; user_id: number | null; action: string; method_path: string; status: number | null; ip: string; detail: string }>
    return rows.map(r => ({ id: r.id, ts: r.ts, userId: r.user_id, action: r.action, methodPath: r.method_path, status: r.status, ip: r.ip, detail: r.detail }))
  }
}
```

- [ ] **Step 4: 通过并提交**

Run: `cd gateway && npx vitest run tests/audit.spec.ts`
Expected: PASS。

```bash
git add gateway/src/audit.ts gateway/tests/audit.spec.ts && git commit -m "feat(gateway): audit log service"
```

---

### Task 7: 实例管理器（拉起/就绪/休眠）

**Files:**
- Create: `gateway/src/instances.ts`
- Test: `gateway/tests/instances.spec.ts`

**Interfaces:**
- Consumes: `openDb`、`GatewayConfig`、`UserRow`
- Produces: `class InstanceManager { constructor(db, cfg); ensureRunning(user: UserRow): Promise<{ port: number }>; portOf(userId: number): number; stateOf(userId: number): string; touch(userId: number): void; wsRef(userId: number, delta: 1 | -1): void; reapIdle(): Promise<number>; stop(userId: number): Promise<void>; stopAll(): Promise<void> }`
- 行为：`ensureRunning` 并发去重（同用户共享同一启动 Promise）；spawn 参数 = `cfg.dshCommand` 将 `{port}` 替换为分配端口，`cwd` = 用户 home，`env` 含 `DSH_HOME=<usersRoot>/<u>/dsh`；就绪 = `GET http://127.0.0.1:<port>/` 返回 200（`readinessTimeoutMs` 内每 300ms 轮询）；`reapIdle` 停掉 `last_activity_at` 早于 `idleTimeoutMs` 且 WS 引用计数为 0 的实例；`stop` 发 SIGTERM，5 秒未退出则 SIGKILL；状态机 `stopped → starting → ready → stopping → stopped` 落库。

- [ ] **Step 1: 失败测试**

`gateway/tests/instances.spec.ts`（用假 dsh：一个立即 200 的 HTTP 小服务）：

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { UserService } from '../src/users.ts'

const FAKE_DSH = `require('http').createServer((q, s) => s.end('ok')).listen(Number(process.argv[1]), '127.0.0.1')`

let manager: InstanceManager | undefined
afterEach(async () => { await manager?.stopAll() })

async function setup(extraEnv: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_DSH_REPO_ROOT: root,
    HGW_READINESS_TIMEOUT_MS: '10000',
    ...extraEnv,
  })
  cfg.dshCommand = [process.execPath, '-e', FAKE_DSH, '{port}']
  const users = new UserService(db, cfg)
  const alice = await users.create({ username: 'alice', password: 'pw-123456' })
  manager = new InstanceManager(db, cfg)
  return { db, cfg, alice, manager }
}

describe('InstanceManager', () => {
  it('spawns, reports ready, and dedupes concurrent starts', async () => {
    const { alice, manager } = await setup()
    const [a, b] = await Promise.all([manager.ensureRunning(alice), manager.ensureRunning(alice)])
    expect(a.port).toBe(42000)
    expect(b.port).toBe(42000)
    expect(manager.stateOf(alice.id)).toBe('ready')
    const response = await fetch(`http://127.0.0.1:${a.port}/`)
    expect(response.status).toBe(200)
  })

  it('reaps idle instances but keeps active ones', async () => {
    const { db, alice, manager } = await setup({ HGW_IDLE_TIMEOUT_MS: '50' })
    await manager.ensureRunning(alice)
    manager.wsRef(alice.id, 1)
    await new Promise(r => setTimeout(r, 120))
    expect(await manager.reapIdle()).toBe(0)
    manager.wsRef(alice.id, -1)
    db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(Date.now() - 60_000, alice.id)
    expect(await manager.reapIdle()).toBe(1)
    expect(manager.stateOf(alice.id)).toBe('stopped')
  })

  it('stop terminates the child process', async () => {
    const { alice, manager } = await setup()
    const { port } = await manager.ensureRunning(alice)
    await manager.stop(alice.id)
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/instances.spec.ts` → FAIL。

- [ ] **Step 3: 实现 instances.ts**

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type { UserRow } from './auth.ts'
import type { GatewayConfig } from './config.ts'

const POLL_INTERVAL_MS = 300
const STOP_GRACE_MS = 5000

export class InstanceManager {
  private readonly children = new Map<number, ChildProcess>()
  private readonly starting = new Map<number, Promise<{ port: number }>>()
  private readonly wsRefs = new Map<number, number>()

  constructor(private readonly db: Database.Database, private readonly cfg: GatewayConfig) {
    this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL`).run()
  }

  portOf(userId: number): number {
    const row = this.db.prepare(`SELECT port FROM instances WHERE user_id = ?`).get(userId) as { port: number } | undefined
    if (row === undefined) throw new Error(`no instance row for user ${userId}`)
    return row.port
  }

  stateOf(userId: number): string {
    const row = this.db.prepare(`SELECT state FROM instances WHERE user_id = ?`).get(userId) as { state: string } | undefined
    return row?.state ?? 'stopped'
  }

  touch(userId: number): void {
    this.db.prepare(`UPDATE instances SET last_activity_at = ? WHERE user_id = ?`).run(Date.now(), userId)
  }

  wsRef(userId: number, delta: 1 | -1): void {
    this.wsRefs.set(userId, Math.max(0, (this.wsRefs.get(userId) ?? 0) + delta))
    if (delta === -1) this.touch(userId)
  }

  async ensureRunning(user: UserRow): Promise<{ port: number }> {
    const port = this.portOf(user.id)
    if (this.stateOf(user.id) === 'ready' && this.children.has(user.id)) return { port }
    const pending = this.starting.get(user.id)
    if (pending !== undefined) return pending
    const startup = this.start(user, port).finally(() => this.starting.delete(user.id))
    this.starting.set(user.id, startup)
    return startup
  }

  private async start(user: UserRow, port: number): Promise<{ port: number }> {
    const now = Date.now()
    this.db.prepare(`UPDATE instances SET state = 'starting', started_at = ?, last_activity_at = ? WHERE user_id = ?`)
      .run(now, now, user.id)
    const argv = this.cfg.dshCommand.map(a => a.replaceAll('{port}', String(port)))
    const child = spawn(argv[0] ?? 'node', argv.slice(1), {
      cwd: user.homePath,
      env: {
        ...process.env,
        DSH_HOME: join(this.cfg.usersRoot, user.username, 'dsh'),
      },
      stdio: 'ignore',
    })
    this.children.set(user.id, child)
    child.on('exit', () => {
      if (this.children.get(user.id) === child) {
        this.children.delete(user.id)
        this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL WHERE user_id = ?`).run(user.id)
      }
    })
    this.db.prepare(`UPDATE instances SET pid = ? WHERE user_id = ?`).run(child.pid ?? null, user.id)

    const deadline = Date.now() + this.cfg.readinessTimeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          this.db.prepare(`UPDATE instances SET state = 'ready' WHERE user_id = ?`).run(user.id)
          return { port }
        }
      } catch { /* not up yet */ }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    }
    await this.stop(user.id)
    throw new Error(`instance for ${user.username} failed to become ready on port ${port}`)
  }

  async reapIdle(): Promise<number> {
    const cutoff = Date.now() - this.cfg.idleTimeoutMs
    const rows = this.db.prepare(
      `SELECT user_id FROM instances WHERE state = 'ready' AND last_activity_at < ?`,
    ).all(cutoff) as Array<{ user_id: number }>
    let stopped = 0
    for (const row of rows) {
      if ((this.wsRefs.get(row.user_id) ?? 0) > 0) continue
      await this.stop(row.user_id)
      stopped += 1
    }
    return stopped
  }

  async stop(userId: number): Promise<void> {
    const child = this.children.get(userId)
    this.db.prepare(`UPDATE instances SET state = 'stopping' WHERE user_id = ?`).run(userId)
    if (child !== undefined && child.exitCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
      await exited
      clearTimeout(timer)
    }
    this.children.delete(userId)
    this.db.prepare(`UPDATE instances SET state = 'stopped', pid = NULL WHERE user_id = ?`).run(userId)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.children.keys()].map(id => this.stop(id)))
  }
}
```

- [ ] **Step 4: 通过并提交**

Run: `cd gateway && npx vitest run tests/instances.spec.ts && npx tsc --noEmit`
Expected: PASS。

```bash
git add gateway/src/instances.ts gateway/tests/instances.spec.ts && git commit -m "feat(gateway): child-process instance manager with readiness and idle reaper"
```

---

### Task 8: HTTP 服务器骨架（登录/登出/改密/CSRF/等待页）

**Files:**
- Create: `gateway/src/html.ts`, `gateway/src/server.ts`
- Test: `gateway/tests/server.spec.ts`

**Interfaces:**
- Consumes: `AuthService`、`UserService`、`GrantService`、`AuditService`、`InstanceManager`、`GatewayConfig`
- Produces: `interface GatewayDeps { cfg; auth; users; grants; audit; instances }`
- Produces: `type ProxyHandler = (req, res, user: UserRow) => Promise<void>`、`type UpgradeHandler = (req, socket, head, user: UserRow) => Promise<void>`、`interface GatewayHandlers { proxy?; upgrade?; admin? }`
- Produces: `function createGatewayServer(deps: GatewayDeps, handlers?: GatewayHandlers): http.Server`（含 upgrade 处理；代理逻辑由 Task 9 通过 handlers 注入）
- Produces（html.ts）: `layout(title, body)`、`loginPage(error?)`、`passwordPage(error?)`、`waitingPage()`、`escapeHtml(s)`
- Produces: `const SESSION_COOKIE`、`parseCookies(header)`、`sessionCookie(token, cfg, clear?)`
- 路由规则：
  - `GET /healthz` → `{"ok":true}`（免认证）
  - `GET /login` 登录页；`POST /login`（urlencoded）→ 成功 302 `/` 并下发 Cookie，失败 401，锁定 429
  - `POST /logout` → 吊销 + 清 Cookie + 302 `/login`
  - 未登录访问其他路径：HTML 请求 302 `/login`，非 HTML 401 JSON
  - `must_change_password` 用户：除 `/account/password`、`/logout` 外一律 302 改密页；`POST /account/password`（`password` ≥ 8 位）成功后 302 `/`
  - CSRF：非 GET 且 `Origin` 存在但 ∉ `publicOrigins` → 403；非 GET 无 `Origin` 且路径以 `/api` 开头 → 放行
  - `/admin/**`：非 admin 403；否则交给 `handlers.admin`
  - 其余路径交给 `handlers.proxy`；未配置则 503 占位
  - upgrade：Origin 校验 + 登录校验 + `/api` 前缀 → `handlers.upgrade`，否则 `socket.destroy()`

- [ ] **Step 1: 写失败测试** — `gateway/tests/server.spec.ts` 覆盖：healthz 免认证、匿名 HTML 跳 `/login`、匿名 API 401、登录成功下发 Cookie、跨站 Origin 403、登出后 401、`must_change_password` 强制跳改密页且改密后放行到 503 占位。断言 `createGatewayServer(deps)`（不传 handlers）代理分支应答 503。

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/server.spec.ts` → FAIL。

- [ ] **Step 3: 实现 html.ts** — 服务端渲染的 `layout`/`loginPage`/`passwordPage`/`waitingPage`，`escapeHtml` 转义 `& < > " '`；页面内联 CSS，无前端构建链。

- [ ] **Step 4: 实现 server.ts** — 见 §"server.ts 契约"：`parseCookies` 手写；`csrfOk` 实现上面 CSRF 规则；`currentUser` 用 `auth.validate` 解析 Cookie；`handle()` 按路由表分发；`server.on('upgrade')` 做 Origin+登录+`/api` 前缀校验后交 `handlers.upgrade`。`readBody` 限 1MB。所有登录/登出/改密写 `audit`。

**server.ts 契约**（关键签名，实现须与之一致）：

```ts
export const SESSION_COOKIE = 'hgw_session'
export function parseCookies(header: string | undefined): Map<string, string>
export function sessionCookie(token: string, cfg: GatewayConfig, clear?: boolean): string
export interface GatewayDeps { cfg: GatewayConfig; auth: AuthService; users: UserService; grants: GrantService; audit: AuditService; instances: InstanceManager }
export type ProxyHandler = (req: IncomingMessage, res: ServerResponse, user: UserRow) => Promise<void>
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, user: UserRow) => Promise<void>
export interface GatewayHandlers {
  proxy?: ProxyHandler
  upgrade?: UpgradeHandler
  admin?: (req: IncomingMessage, res: ServerResponse, user: UserRow, pathname: string, body: string) => Promise<boolean>
}
export function createGatewayServer(deps: GatewayDeps, handlers?: GatewayHandlers): Server
```

- [ ] **Step 5: 通过并提交**

Run: `cd gateway && npx vitest run tests/server.spec.ts && npx tsc --noEmit`

```bash
git add gateway/src/html.ts gateway/src/server.ts gateway/tests/server.spec.ts && git commit -m "feat(gateway): http server with login, csrf, forced password change"
```

---

### Task 9: 反向代理（HTTP + WebSocket + 头改写 + 活动追踪 + 授权落盘）

**Files:**
- Create: `gateway/src/proxy.ts`
- Test: `gateway/tests/proxy.spec.ts`

**Interfaces:**
- Consumes: `InstanceManager`、`AuditService`、`GrantService`、`GatewayConfig`、`GatewayDeps`、`waitingPage`
- Produces: `function createProxyHandlers(deps: GatewayDeps): { proxy: ProxyHandler; upgrade: UpgradeHandler; close(): void }`
- 行为：
  - **实例启动前写授权**：`ensureRunning` 前，把 `grants.effectiveGrants(user.id)` 写入实例 `$DSH_HOME/directory-grants.json`（供 Workstream B 的 `dsh-directory-guard` 读取），保证实例每次拉起看到最新授权
  - `proxy`：`ensureRunning`；starting 期间 HTML 回等待页、非 HTML 回 503 `{"error":"instance-starting"}`；ready 后 `touch` 并转发到 `http://127.0.0.1:<port>`，改写 `host`/`origin` 为 `127.0.0.1:<port>`；`/api/` 前缀写审计（action=`api`，methodPath=`METHOD /api/...`，status=上游码）
  - `upgrade`：确保就绪后 `proxy.ws` 转发，`wsRef +1`，socket close 时 `-1`
  - 上游不可达：HTTP 502 JSON

- [ ] **Step 1: 写失败测试** — `gateway/tests/proxy.spec.ts` 用回显 host/origin 的假 dsh（`-e` 起一个 http+upgrade 小服务）：断言 HTTP 转发后上游看到的 `host`/`origin` 已被改写为实例回环地址、`/api/echo` 产生一条 `api` 审计；断言 WebSocket 升级转发且上游看到改写后的 host；断言实例 `$DSH_HOME/directory-grants.json` 在首次代理后存在且内容等于 `effectiveGrants`。

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/proxy.spec.ts` → FAIL。

- [ ] **Step 3: 实现 proxy.ts** — 用 `http-proxy` 的 `web`/`ws`；`targetOptions(port)` 设 `{ target, headers: { host, origin } }` 完成头改写；`ensureReady` 处理 starting 分支；`writeGrants(user)` 用 `writeFileSync` 落 `directory-grants.json`；`/api/` 请求在 `res.once('finish')` 写审计。

- [ ] **Step 4: 通过并提交**

Run: `cd gateway && npx vitest run tests/proxy.spec.ts && npx tsc --noEmit`

```bash
git add gateway/src/proxy.ts gateway/tests/proxy.spec.ts && git commit -m "feat(gateway): reverse proxy with authority rewrite and grants handoff"
```

---

### Task 10: 管理后台 + 入口装配

**Files:**
- Create: `gateway/src/admin.ts`, `gateway/src/index.ts`
- Test: `gateway/tests/admin.spec.ts`

**Interfaces:**
- Produces（admin.ts）: `function createAdminHandler(deps: GatewayDeps): NonNullable<GatewayHandlers['admin']>`
- Produces（index.ts）: 进程入口——`loadConfig` → `openDb(join(cfg.dataDir,'gateway.sqlite'))` → 构建服务 → 若 `users.count()===0` 引导创建 `admin`（随机密码打印一次，`must_change_password=1`）→ `createGatewayServer(deps, { ...createProxyHandlers(deps), admin: createAdminHandler(deps) })` → 监听 → 每 60s `reapIdle` → SIGINT/SIGTERM `stopAll` 后退出
- 管理路由（全挂 `/admin`，POST 表单，成功后写审计 `admin.*` 并 302 回 `/admin`）：
  - `GET /admin` 总览（用户表 + 创建用户；组列表 + 建组/加减成员；授权列表 + 添加/删除授权）
  - `GET /admin/audit?limit=200` 审计表
  - `POST /admin/users`、`/admin/users/status`、`/admin/users/role`、`/admin/users/reset-password`
  - `POST /admin/instances/stop`、`/admin/instances/restart`
  - `POST /admin/groups`、`/admin/groups/delete`、`/admin/groups/members/add`、`/admin/groups/members/remove`
  - `POST /admin/grants`、`/admin/grants/delete`
  - 授权变更后调用 `instances.restart(userId)` 让新授权对在跑实例生效（重启即重写 `directory-grants.json`）

- [ ] **Step 1: 写失败测试** — `gateway/tests/admin.spec.ts`：admin 登录后 `GET /admin` 200 且含用户名；创建用户/建组/加成员/加授权各 302 且服务层可见；`effectiveGrants` 含新授权；`admin.grants` 审计存在；普通用户访问 `/admin` 403。

- [ ] **Step 2: 确认失败** — Run: `cd gateway && npx vitest run tests/admin.spec.ts` → FAIL。

- [ ] **Step 3: 实现 admin.ts** — 服务端渲染 `overview`/`auditPage`；`createAdminHandler` 返回按 `req.method`+`pathname` 分派的处理器，POST 用 `URLSearchParams(body)` 取字段，改动后写审计、302 回 `/admin`；未匹配返回 `false`（交回 server 的 404）。

- [ ] **Step 4: 实现 index.ts** — 见上 Interfaces；bootstrap admin 用 `randomBytes(12).toString('base64url')`；`reapIdle` 定时器 `unref` 不阻塞退出；优雅关闭 `stopAll` 后 `process.exit(0)`，3s 兜底。

- [ ] **Step 5: 通过并提交**

Run: `cd gateway && npx vitest run && npx tsc --noEmit`（整体回归全绿）

```bash
git add gateway/src/admin.ts gateway/src/index.ts gateway/tests/admin.spec.ts && git commit -m "feat(gateway): admin console and process entry with bootstrap admin"
```

---

### Task 11: 网关端到端手动验收（真实 dsh，双用户）

**Files:** 无新增代码；验收记录追加到本文件末尾。

前置：仓库已 `pnpm run build`；现有 LaunchAgent 版 dsh（3080）不冲突（网关实例从 42000 起）。

- [ ] **Step 1: 启动网关** — `cd gateway && HGW_PORT=8899 npx tsx src/index.ts`，记录 bootstrap admin 一次性密码。
- [ ] **Step 2: 管理员初始化** — 登录→强制改密→ `/admin` 建 `u1`、`u2`。
- [ ] **Step 3: 双用户隔离** — 两浏览器分别登录：等待页→各自 UI；`u1` 建工作区+发一次对话（验证 WS 流式与审批弹窗）；`u2` 看不到 `u1` 的工作区/会话；`u1` 写测试 Key，`u2` 的 Settings 不受影响。
- [ ] **Step 4: 休眠与安全** — `HGW_IDLE_TIMEOUT_MS=60000` 重启后闲置 1 分钟确认实例进程消失、再访问自动拉起；未登录 `POST /api/session.list` 返回 401；普通用户访问 `/admin` 403；审计页可见 login/api/admin.*。
- [ ] **Step 5: 提交验收记录**

```bash
git add .agents/superpowers/plans/2026-08-14-gateway-phase1.md && git commit -m "docs(gateway): phase 1 acceptance record"
```

---

## Workstream B（并行）：`dsh-directory-guard` 树外插件（philosophy-native）

> 这是设计文档 §7、§14 要求的 dsh 内嵌强制层。它是一个 **dsh 插件**，因此受仓库
> 内规则约束：Agent Note、model-visible 行为的 keyless snapshot 测试、文档与代码同改。
> 它在 Mac 开发环境是唯一目录强制层，故与网关并行开发、优先级不低于 Phase 1。

**目标文件结构（在仓库根新建独立目录，`packages/` 之外，避免上游冲突）：**

```
plugins/dsh-directory-guard/
  package.json          # 声明 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
  cordis.patch.yml      # 挂载本插件行 + 重述 permission-presets 表（摘除受限用户的 danger-full-access）
  src/index.ts          # apply(ctx): 读授权 + 注册 tools/pre-execute 门 + 可选 prompt section
  src/grants.ts         # 读取/规范化 directory-grants.json
  tests/guard.spec.ts   # 单元测试：授权内允许、授权外拒绝
  tests/guard.snapshot.spec.ts  # keyless snapshot：一次越权 fs 调用的 tool 结果
```

### Task B1: 授权加载

**Interfaces:** `interface Grant { path: string; mode: 'ro' | 'rw' }`；`function loadGrants(file: string): Grant[]`（缺文件返回 `[]`；`realpath` 规范化；按 path 长度降序，便于最长前缀匹配）；`function classify(grants: Grant[], target: string): 'rw' | 'ro' | 'none'`（target 在某授权根内则返回该根 mode，否则 `none`）。

- [ ] Step 1 失败测试：`classify` 对授权根内子路径返 `rw`/`ro`、根外返 `none`、最长前缀优先（`/a` ro 且 `/a/b` rw 时 `/a/b/c` → rw）。
- [ ] Step 2 确认失败。
- [ ] Step 3 实现 `grants.ts`。
- [ ] Step 4 通过并提交：`git commit -m "feat(directory-guard): grant loading and path classification"`。

### Task B2: `tools/pre-execute` 权限门

**Interfaces:** `apply(ctx)` 内 `ctx.on('tools/pre-execute', (exec, next) => PreToolDecision | Promise<...>)`：从 `exec` 解析结构化路径参数（fs 系工具的 `path`/target；无法解析的工具委托 `next()`），越权写（目标 `none` 或 `ro` 上的写操作）返回 `{ kind: 'deny', reason }`，其余 `next()`。授权来自 `loadGrants(process.env.DSH_DIRECTORY_GRANTS ?? dshHomePath('directory-grants.json'))`，用 `ctx.effect` 注册可逆。

诚实边界（写进插件 README）：本门覆盖 fs 系结构化路径工具；bash 任意命令的路径边界由 `ctx.sandbox` 与生产 systemd 兜底，不在本门职责内。

- [ ] Step 1 失败测试 `guard.spec.ts`：构造授权 `[{/proj rw}]`，模拟 `str_replace_editor` 写 `/proj/a.ts` → 放行、写 `/etc/x` → deny、读 `/proj` 外（若策略允许只读浏览则按设计）→ 按 classify 结果断言。
- [ ] Step 2 确认失败。
- [ ] Step 3 实现 `src/index.ts` 的 hook。
- [ ] Step 4 通过并提交：`git commit -m "feat(directory-guard): tools/pre-execute path gate"`。

### Task B3: 预设收敛 + snapshot 测试 + Agent Note

- [ ] `cordis.patch.yml` 重述 `permission-presets` 行，受限实例的表移除 `danger-full-access`；`package.json` 声明 `dsh.bundle`。
- [ ] keyless snapshot 测试 `guard.snapshot.spec.ts`：录制一次越权 fs 调用返回的 tool 结果（model-visible），确保拒绝文案稳定。
- [ ] 写 `.agents/notes/proposed/feature/2026-08-14-directory-guard.md`（动机、扩展点选择、边界声明）。
- [ ] 插件 README（中英）说明加载方式与边界。
- [ ] 提交：`git commit -m "feat(directory-guard): preset pinning, snapshot test, agent note"`。

### Task B4: 联调（挂进用户实例）

- [ ] 在 Task 9 的 `writeGrants` 落盘基础上，令网关拉起实例时通过 `--patch` 或 profile 挂载 `dsh-directory-guard`（Mac 开发环境即以 `--patch plugins/dsh-directory-guard/cordis.patch.yml` 注入）。
- [ ] 手动验收：`u1` 实例内让 agent 尝试写授权外目录 → 被 fs 门拒绝；写授权内 → 成功；确认 Mac 开发环境无 systemd 时该门仍然生效。

---

## 计划自审记录

- **Spec 覆盖**：设计 §12 Phase 1 六项范围落在 Task 3/8（登录/会话/CSRF）、Task 2（数据模型）、Task 9（代理+头改写+授权落盘）、Task 7（实例管理）、Task 10（管理后台）、Task 6（审计）；四条验收由 Task 11 覆盖。设计 §7/§14 的 dsh 内嵌强制层落在 Workstream B（Task B1–B4），补齐了"philosophy-native 目录强制"。
- **占位符扫描**：Task 1–7 给出完整代码；Task 8–11 给出精确接口契约 + 关键行为 + 验收命令（server/proxy/admin 的实现代码在对应 Step 以契约约束，执行时按签名落地）；Workstream B 给出接口与分步 TDD。无 TBD。
- **类型一致性**：`GatewayDeps`/`GatewayHandlers`/`ProxyHandler`/`UpgradeHandler`/`UserRow`/`GrantRow`/`Grant` 跨任务签名一致；`createGatewayServer(deps, handlers?)` 双参形态自 Task 8 引入、Task 9/10 沿用；授权落盘（Task 9 `writeGrants`）与插件读取（Task B1 `loadGrants`）共用 `directory-grants.json` 契约。
- **已知取舍**：admin 页依赖 SameSite=Lax + Origin 白名单而非 CSRF token（与全站策略一致）；`tools/pre-execute` 不解析 bash 任意路径（由 sandbox/systemd 兜底，已在 §14 与 B2 声明）；Task 8–11 未逐字贴全部实现代码，以接口契约替代，因架构刚调整（授权落盘）需按契约落地。

## 执行说明

两条工作流可并行：网关（Task 1→11，`gateway/` 目录，不受 dsh 内规则约束）与
`dsh-directory-guard` 插件（Task B1→B4，dsh 插件，需 Agent Note + snapshot 测试）。
各任务先跑失败测试再实现；网关全绿后进 Task 11 手动验收，插件全绿后进 Task B4 联调。
Phase 2（Linux systemd 内核目录强制、生产部署）在本计划验收通过后另立计划。
