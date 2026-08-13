import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { GrantService } from '../src/grants.ts'
import { InstanceManager } from '../src/instances.ts'
import { createProxyHandlers } from '../src/proxy.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

// Resolve from a real cwd path (not import.meta.url, which is a virtual URL
// under vitest) so the absolute ws path stays requireable by the plain-node child.
const WS_MODULE = createRequire(join(process.cwd(), 'noop.js')).resolve('ws')
const ECHO_DSH = `
const http = require('http')
const { WebSocketServer } = require(${JSON.stringify(WS_MODULE)})
const server = http.createServer((req, res) => {
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
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_READINESS_TIMEOUT_MS: '10000', HGW_INSTANCE_PORT_BASE: '43200' })
  cfg.dshCommand = [process.execPath, '-e', ECHO_DSH, '{port}']
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    grants: new GrantService(db),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
  }
  const alice = await deps.users.create({ username: 'alice', password: 'pw-12345678' })
  await deps.users.changeOwnPassword(alice.id, 'pw-12345678')
  const handlers = createProxyHandlers(deps)
  const server = createGatewayServer(deps, handlers)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  // Teardown order matters: stop instances first (drops the upstream socket so
  // the proxied upgrade pipe ends), then close proxy and server. server.close()'s
  // callback can stall on a detached (upgraded) socket, so race it with a short
  // timeout after forcibly dropping tracked connections.
  cleanup.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections()
    const timer = setTimeout(resolve, 1500)
    server.close(() => { clearTimeout(timer); resolve() })
  }))
  cleanup.push(() => handlers.close())
  cleanup.push(() => deps.instances.stopAll())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  const loginRes = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username: 'alice', password: 'pw-12345678' }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { deps, base, cookie, root }
}

describe('proxy handlers', () => {
  it('rewrites host and origin to the instance loopback authority and writes grants', async () => {
    const { deps, base, cookie, root } = await setup()
    // Deterministic startup (the manager's beforeStart writes the grants file).
    await deps.instances.ensureRunning(deps.users.getByUsername('alice')!)
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    })
    expect(response.status).toBe(200)
    const echoed = await response.json() as { host: string; origin: string }
    const port = deps.instances.portOf(1)
    expect(echoed.host).toBe(`127.0.0.1:${port}`)
    expect(echoed.origin).toBe(`http://127.0.0.1:${port}`)
    const audited = deps.audit.query({ action: 'api' })
    expect(audited[0]?.methodPath).toBe('POST /api/echo')
    const grantsFile = join(root, 'users', 'alice', 'dsh', 'directory-grants.json')
    expect(existsSync(grantsFile)).toBe(true)
    expect(JSON.parse(readFileSync(grantsFile, 'utf8'))).toEqual(deps.grants.effectiveGrants(1))
  })

  it('proxies websocket upgrades with rewritten host', async () => {
    const { deps, base, cookie } = await setup()
    await deps.instances.ensureRunning(deps.users.getByUsername('alice')!)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, { headers: { cookie, origin: base } })
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ws message in 5s')), 5000)
      ws.once('message', data => { clearTimeout(timer); resolve(String(data)) })
      ws.once('error', err => { clearTimeout(timer); reject(err) })
    })
    ws.close()
    const port = deps.instances.portOf(1)
    expect(JSON.parse(first)).toEqual({ host: `127.0.0.1:${port}` })
  })
})
