import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createAdminApiHandler } from './admin-api.ts'
import { AuditService } from './audit.ts'
import { AuthService } from './auth.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db.ts'
import { InstanceManager } from './instances.ts'
import { selectLauncher } from './launcher.ts'
import { ProjectService } from './projects.ts'
import { ModelGovernanceService } from './model-governance.ts'
import { createProxyHandlers } from './proxy.ts'
import { createGatewayServer, type GatewayDeps } from './server.ts'
import { createUsageIntakeServer } from './usage-intake.ts'
import { UserService } from './users.ts'

const cfg = loadConfig()
const db = openDb(join(cfg.dataDir, 'gateway.sqlite'))
const auth = new AuthService(db, cfg)
const users = new UserService(db, cfg)
const projects = new ProjectService(db, cfg)
const audit = new AuditService(db)
const governance = new ModelGovernanceService(db, cfg.usageTimeZone)
// Launcher is local child-process (dev) unless HGW_LAUNCHER=systemd (Linux prod);
// the systemd options factory is only evaluated in the systemd case.
const launcher = selectLauncher(cfg, () => ({
  systemd: {
    usersRoot: cfg.usersRoot,
    execStart: cfg.dshCommand.join(' '),
    gatewayDir: cfg.gatewayDir,
    memoryMax: cfg.memoryMax,
    cpuQuota: cfg.cpuQuota,
  },
  unitDir: cfg.systemdUnitDir,
  grantsProvider: (username) => {
    const user = users.getByUsername(username)
    if (user === null) return []
    return projects.effectiveGrants(user.id).map(({ path, mode }) => ({ path, mode }))
  },
}))
const deps: GatewayDeps = {
  cfg,
  auth,
  users,
  projects,
  audit,
  governance,
  instances: new InstanceManager(db, cfg, launcher),
}

if (deps.users.count() === 0) {
  const password = randomBytes(12).toString('base64url')
  await deps.users.create({ username: 'admin', password, role: 'admin' })
  console.log(`[gateway] bootstrap admin created — username: admin  password: ${password}`)
  console.log('[gateway] 首次登录后会强制修改密码。')
}

const proxyHandlers = createProxyHandlers(deps)
const server = createGatewayServer(deps, { ...proxyHandlers, admin: createAdminApiHandler(deps) })
// Bind loopback only: the gateway is reached through the TLS entry (Cloudflare
// tunnel / Nginx) that connects to 127.0.0.1, never directly over the LAN.
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[gateway] listening on http://127.0.0.1:${cfg.port}`)
})
const intake = createUsageIntakeServer(governance, audit)
intake.listen(cfg.intakePort, '127.0.0.1', () => {
  console.log(`[gateway] usage intake listening on http://127.0.0.1:${cfg.intakePort}`)
})

const reaper = setInterval(() => {
  void deps.instances.reapIdle()
}, 60_000)

async function shutdown(): Promise<void> {
  clearInterval(reaper)
  proxyHandlers.close()
  intake.close()
  await deps.instances.stopAll()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
