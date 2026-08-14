import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import httpProxy from 'http-proxy'
import { writeGrantsFile } from './apply-grants.ts'
import { writeModelGovernanceFile } from './apply-model-governance.ts'
import type { UserRow } from './auth.ts'
import { waitingPage } from './html.ts'
import type { GatewayDeps, ProxyHandler, UpgradeHandler } from './server.ts'

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

export function createProxyHandlers(deps: GatewayDeps): { proxy: ProxyHandler; upgrade: UpgradeHandler; close(): void } {
  const { cfg, instances, audit, projects } = deps
  const server = httpProxy.createProxyServer({ xfwd: true })

  // Grants handoff is intrinsic to starting an instance: the manager calls this
  // just before every spawn, so the child always reads the current grants.
  instances.beforeStart = async (user: UserRow): Promise<void> => {
    writeGrantsFile(cfg, user.username, await projects.effectiveGrants(user.id))
    if (deps.governance !== undefined) await writeModelGovernanceFile(cfg, deps.governance, user)
  }

  async function ensureReady(req: IncomingMessage, res: ServerResponse | null, user: UserRow): Promise<number | null> {
    // Trust the live handle, not the `ready` row: an external kill or crash
    // leaves the row stale, and proxying that port yields instance-unreachable.
    if (!await instances.isLive(user.id)) {
      const pending = instances.ensureRunning(user)
      if (res !== null) {
        if (wantsHtml(req)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(waitingPage()) }
        else { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"instance-starting"}') }
        pending.catch(error => { console.error(`[gateway] instance start failed for ${user.username}:`, error) })
        return null
      }
      await pending
    }
    return instances.portOf(user.id)
  }

  function targetOptions(port: number): httpProxy.ServerOptions {
    const authority = `127.0.0.1:${port}`
    return { target: `http://${authority}`, headers: { host: authority, origin: `http://${authority}` } }
  }

  const proxy: ProxyHandler = async (req, res, user) => {
    const port = await ensureReady(req, res, user)
    if (port === null) return
    await instances.touch(user.id)
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname.startsWith('/api/')) {
      res.once('finish', () => {
        void Promise.resolve(audit.write({
          userId: user.id,
          action: 'api',
          methodPath: `${req.method} ${pathname}`,
          status: res.statusCode,
          ip: req.socket.remoteAddress ?? '',
        })).catch(error => { console.error('[gateway] API audit write failed:', error) })
      })
    }
    await new Promise<void>((resolve) => {
      res.once('close', resolve)
      server.web(req, res, targetOptions(port), () => {
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"instance-unreachable"}') }
        resolve()
      })
    })
  }

  const upgrade: UpgradeHandler = async (req, socket, head, user) => {
    let port: number
    try {
      port = await instances.isLive(user.id)
        ? await instances.portOf(user.id)
        : (await instances.ensureRunning(user)).port
    } catch {
      socket.destroy()
      return
    }
    await instances.touch(user.id)
    await instances.wsRef(user.id, 1)
    socket.once('close', () => {
      void Promise.resolve(instances.wsRef(user.id, -1))
        .catch(error => { console.error('[gateway] WebSocket activity update failed:', error) })
    })
    server.ws(req, socket as Duplex & NodeJS.WritableStream, head, targetOptions(port), () => socket.destroy())
  }

  return { proxy, upgrade, close: () => server.close() }
}
