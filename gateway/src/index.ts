import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createAdminHandler } from './admin.ts'
import { AuditService } from './audit.ts'
import { AuthService } from './auth.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db.ts'
import { GrantService } from './grants.ts'
import { InstanceManager } from './instances.ts'
import { createProxyHandlers } from './proxy.ts'
import { createGatewayServer, type GatewayDeps } from './server.ts'
import { UserService } from './users.ts'

const cfg = loadConfig()
const db = openDb(join(cfg.dataDir, 'gateway.sqlite'))
const deps: GatewayDeps = {
  cfg,
  auth: new AuthService(db, cfg),
  users: new UserService(db, cfg),
  grants: new GrantService(db),
  audit: new AuditService(db),
  instances: new InstanceManager(db, cfg),
}

if (deps.users.count() === 0) {
  const password = randomBytes(12).toString('base64url')
  await deps.users.create({ username: 'admin', password, role: 'admin' })
  console.log(`[gateway] bootstrap admin created — username: admin  password: ${password}`)
  console.log('[gateway] 首次登录后会强制修改密码。')
}

const proxyHandlers = createProxyHandlers(deps)
const server = createGatewayServer(deps, { ...proxyHandlers, admin: createAdminHandler(deps) })
// Bind loopback only: the gateway is reached through the TLS entry (Cloudflare
// tunnel / Nginx) that connects to 127.0.0.1, never directly over the LAN.
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[gateway] listening on http://127.0.0.1:${cfg.port}`)
})

const reaper = setInterval(() => {
  void deps.instances.reapIdle()
}, 60_000)

async function shutdown(): Promise<void> {
  clearInterval(reaper)
  proxyHandlers.close()
  await deps.instances.stopAll()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
