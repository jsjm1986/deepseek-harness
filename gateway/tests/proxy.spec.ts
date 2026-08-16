import { generateKeyPairSync } from 'node:crypto'
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
import { InstanceManager } from '../src/instances.ts'
import { ProjectService } from '../src/projects.ts'
import { createProxyHandlers } from '../src/proxy.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

// Resolve from a real cwd path (not import.meta.url, which is a virtual URL
// under vitest) so the absolute ws path stays requireable by the plain-node child.
const WS_MODULE = createRequire(join(process.cwd(), 'noop.js')).resolve('ws')
const ECHO_DSH = `
const http = require('http')
const { WebSocketServer } = require(${JSON.stringify(WS_MODULE)})
const server = http.createServer((req, res) => {
  if (req.url === '/exit') { res.end('bye'); process.exit(0); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null, url: req.url, principal: req.headers[${JSON.stringify('x-dsh-gateway-principal')}] ?? null }))
})
const wss = new WebSocketServer({ server })
wss.on('connection', (socket, req) => { socket.send(JSON.stringify({ host: req.headers.host, principal: req.headers[${JSON.stringify('x-dsh-gateway-principal')}] ?? null })) })
server.listen(Number(process.argv[1]), '127.0.0.1')
`

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup = [] })

async function setup(withPrincipal = false) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_READINESS_TIMEOUT_MS: '10000', HGW_INSTANCE_PORT_BASE: '43200' })
  cfg.dshCommand = [process.execPath, '-e', ECHO_DSH, '{port}']
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
  }
  const alice = await deps.users.create({ username: 'alice', password: 'pw-12345678' })
  await deps.users.changeOwnPassword(alice.id, 'pw-12345678')
  const signer = withPrincipal
    ? new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'default', 30_000)
    : undefined
  const handlers = createProxyHandlers(deps, signer)
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
  return { deps, base, cookie, root, signer }
}

describe('proxy handlers', () => {
  it('rewrites host and origin to the instance loopback authority and writes grants', async () => {
    const { deps, base, cookie, root } = await setup()
    // Deterministic startup (the manager's beforeStart writes the grants file).
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    })
    expect(response.status).toBe(200)
    const echoed = await response.json() as { host: string; origin: string }
    const port = await deps.instances.portOf(1)
    expect(echoed.host).toBe(`127.0.0.1:${port}`)
    expect(echoed.origin).toBe(`http://127.0.0.1:${port}`)
    const audited = await deps.audit.query({ action: 'api' })
    expect(audited[0]?.methodPath).toBe('POST /api/echo')
    const grantsFile = join(root, 'users', 'alice', 'dsh', 'directory-grants.json')
    expect(existsSync(grantsFile)).toBe(true)
    expect(JSON.parse(readFileSync(grantsFile, 'utf8'))).toEqual(await deps.projects.effectiveGrants(1))
  })

  it('shows the waiting page and respawns when a ready child has exited', async () => {
    const { deps, base, cookie } = await setup()
    const alice = (await deps.users.getByUsername('alice'))!
    await deps.instances.ensureRunning(alice)
    const port = await deps.instances.portOf(alice.id)
    await fetch(`http://127.0.0.1:${port}/exit`)
    await new Promise(r => setTimeout(r, 50))
    expect(await deps.instances.isLive(alice.id)).toBe(false)
    const waiting = await fetch(base + '/', { headers: { cookie, accept: 'text/html' }, redirect: 'manual' })
    expect(waiting.status).toBe(200)
    expect(await waiting.text()).toContain('正在启动您的工作台')
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !await deps.instances.isLive(alice.id)) {
      await new Promise(r => setTimeout(r, 100))
    }
    expect(await deps.instances.isLive(alice.id)).toBe(true)
    const proxied = await fetch(`${base}/api/echo`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    })
    expect(proxied.status).toBe(200)
  })

  it('proxies websocket upgrades with rewritten host', async () => {
    const { deps, base, cookie } = await setup()
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, { headers: { cookie, origin: base } })
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ws message in 5s')), 5000)
      ws.once('message', data => { clearTimeout(timer); resolve(String(data)) })
      ws.once('error', err => { clearTimeout(timer); reject(err) })
    })
    ws.close()
    const port = await deps.instances.portOf(1)
    expect(JSON.parse(first)).toEqual({ host: `127.0.0.1:${port}`, principal: null })
  })

  it('replaces forged principal headers on HTTP and WebSocket requests', async () => {
    const { deps, base, cookie, signer } = await setup(true)
    await deps.instances.ensureRunning((await deps.users.getByUsername('alice'))!)
    const response = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: {
        cookie,
        origin: base,
        'content-type': 'application/json',
        [PRINCIPAL_HEADER]: 'forged',
      },
      body: '{}',
    })
    const echoed = await response.json() as { principal: string }
    expect(echoed.principal).not.toBe('forged')
    expect(signer?.verify(echoed.principal).user.username).toBe('alice')

    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/events.mux`, {
      headers: { cookie, origin: base, [PRINCIPAL_HEADER]: 'forged' },
    })
    const first = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no ws message in 5s')), 5000)
      ws.once('message', data => { clearTimeout(timer); resolve(String(data)) })
      ws.once('error', error => { clearTimeout(timer); reject(error) })
    })
    ws.close()
    const websocket = JSON.parse(first) as { principal: string }
    expect(websocket.principal).not.toBe('forged')
    expect(signer?.verify(websocket.principal).runtime).toEqual({ kind: 'user', id: 1, generation: 1 })
  })
})
