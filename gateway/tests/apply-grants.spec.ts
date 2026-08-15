import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { applyGrantsToUser } from '../src/apply-grants.ts'
import { AuditService } from '../src/audit.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { UserService } from '../src/users.ts'

const WS_MODULE = createRequire(join(process.cwd(), 'noop.js')).resolve('ws')
const ECHO_DSH = `
const http = require('http')
const { WebSocketServer } = require(${JSON.stringify(WS_MODULE)})
const server = http.createServer((req, res) => {
  if (req.url === '/exit') { res.end('bye'); process.exit(0); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, url: req.url }))
})
const wss = new WebSocketServer({ server })
wss.on('connection', (socket, req) => { socket.send(JSON.stringify({ host: req.headers.host })) })
server.listen(Number(process.argv[1]), '127.0.0.1')
`

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = [] })

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_READINESS_TIMEOUT_MS: '10000', HGW_INSTANCE_PORT_BASE: '43300' })
  cfg.dshCommand = [process.execPath, '-e', ECHO_DSH, '{port}']
  const deps = {
    cfg,
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
  }
  const admin = await deps.users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
  const alice = await deps.users.create({ username: 'alice', password: 'pw-12345678' })
  cleanup.push(() => deps.instances.stopAll())
  return { deps, alice, admin, root }
}

describe('applyGrantsToUser', () => {
  it('restarts a live instance and only writes when stopped', async () => {
    const { deps, alice, admin, root } = await setup()
    await deps.instances.ensureRunning(alice)
    expect(await applyGrantsToUser(deps, alice.id, admin.id)).toBe('restarted')
    expect(await deps.instances.isLive(alice.id)).toBe(true)
    const body = JSON.parse(readFileSync(join(root, 'users', 'alice', 'dsh', 'directory-grants.json'), 'utf8'))
    expect(body[0]).toMatchObject({ label: '主目录', mode: 'rw' })
    await deps.instances.stop(alice.id)
    expect(await applyGrantsToUser(deps, alice.id, admin.id)).toBe('written')
    await expect(fetch(`http://127.0.0.1:${await deps.instances.portOf(alice.id)}/`)).rejects.toThrow()
  })

  it('audits and throws when a live restart fails', async () => {
    const { deps, alice, admin } = await setup()
    await deps.instances.ensureRunning(alice)
    deps.cfg.dshCommand = [process.execPath, '-e', 'process.exit(1)', '{port}']
    deps.cfg.readinessTimeoutMs = 800
    await expect(applyGrantsToUser(deps, alice.id, admin.id)).rejects.toThrow()
    const audited = deps.audit.query({ action: 'admin.instances.restart-failed' })
    expect(audited[0]?.userId).toBe(admin.id)
    expect(audited[0]?.detail).toContain(String(alice.id))
  })

  it('writes a filesystem-root rw grant for administrators', async () => {
    const { deps, admin, root } = await setup()
    expect(await applyGrantsToUser(deps, admin.id, admin.id)).toBe('written')
    const body = JSON.parse(
      readFileSync(join(root, 'users', 'admin', 'dsh', 'directory-grants.json'), 'utf8'),
    )
    const filesystemRoot = parse(admin.homePath).root
    expect(body).toEqual([{ path: filesystemRoot, mode: 'rw', label: filesystemRoot }])
  })
})
