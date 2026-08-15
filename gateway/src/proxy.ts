import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import httpProxy from 'http-proxy'
import { writeRuntimeGrantsFile } from './apply-grants.ts'
import { writeModelGovernanceFile, writeProjectModelGovernanceFile } from './apply-model-governance.ts'
import type { UserRow } from './auth.ts'
import { waitingPage } from './html.ts'
import type { RuntimeTarget } from './instances.ts'
import { PRINCIPAL_HEADER, type GatewayPrincipalSigner } from './principal.ts'
import { runtimeDirectoryGrants } from './runtime-directory-grants.ts'
import type { GatewayDeps, GatewayRequestContext, ProxyHandler, UpgradeHandler } from './server.ts'

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

export function createProxyHandlers(
  deps: GatewayDeps,
  principalSigner?: GatewayPrincipalSigner,
): { proxy: ProxyHandler; upgrade: UpgradeHandler; close(): void } {
  const { cfg, instances, audit, projects } = deps
  const server = httpProxy.createProxyServer({ xfwd: true })

  // Grants handoff is intrinsic to starting an instance: the manager calls this
  // just before every spawn, so the child always reads the current grants.
  instances.beforeStart = async (runtime): Promise<void> => {
    if (runtime.user !== undefined) {
      writeRuntimeGrantsFile(runtime.dshHome, await runtimeDirectoryGrants(runtime.user, projects))
      if (deps.governance !== undefined) await writeModelGovernanceFile(cfg, deps.governance, runtime.user)
      return
    }
    if (runtime.project === undefined) throw new Error(`runtime ${runtime.runtimeKey} has no owner facts`)
    writeRuntimeGrantsFile(runtime.dshHome, [{
      path: runtime.project.path,
      mode: 'rw',
      label: runtime.project.name,
    }])
    if (deps.governance !== undefined) {
      await writeProjectModelGovernanceFile(cfg, deps.governance, runtime.project)
    }
  }

  const targetFor = (context: GatewayRequestContext): RuntimeTarget => 'username' in context.runtime
    ? { kind: 'user', id: context.runtime.id }
    : { kind: 'project', id: context.runtime.id }

  async function ensureReady(
    req: IncomingMessage,
    res: ServerResponse | null,
    context: GatewayRequestContext,
  ): Promise<{ port: number; generation: number; target: RuntimeTarget } | null> {
    const target = targetFor(context)
    // Trust the live handle, not the `ready` row: an external kill or crash
    // leaves the row stale, and proxying that port yields instance-unreachable.
    if (!await instances.isLive(target)) {
      const pending = instances.ensureRunning(context.runtime)
      if (res !== null) {
        if (wantsHtml(req)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(waitingPage()) }
        else { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"instance-starting"}') }
        pending.catch(error => { console.error(`[gateway] instance start failed for ${target.kind} ${String(target.id)}:`, error) })
        return null
      }
      const running = await pending
      return { ...running, target }
    }
    return {
      port: await instances.portOf(target),
      generation: await instances.generationOf(target),
      target,
    }
  }

  function targetOptions(port: number, principal?: string): httpProxy.ServerOptions {
    const authority = `127.0.0.1:${port}`
    return {
      target: `http://${authority}`,
      headers: {
        host: authority,
        origin: `http://${authority}`,
        ...(principal === undefined ? {} : { [PRINCIPAL_HEADER]: principal }),
      },
    }
  }

  const proxy: ProxyHandler = async (req, res, context) => {
    delete req.headers[PRINCIPAL_HEADER]
    const ready = await ensureReady(req, res, context)
    if (ready === null) return
    await instances.touch(ready.target)
    const principal = principalSigner?.issue({
      user: context.user,
      scope: context.scope,
      runtime: { kind: ready.target.kind, id: ready.target.id, generation: ready.generation },
    })
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    if (pathname.startsWith('/api/')) {
      res.once('finish', () => {
        void Promise.resolve(audit.write({
          userId: context.user.id,
          action: 'api',
          methodPath: `${req.method} ${pathname}`,
          status: res.statusCode,
          ip: req.socket.remoteAddress ?? '',
        })).catch(error => { console.error('[gateway] API audit write failed:', error) })
      })
    }
    await new Promise<void>((resolve) => {
      res.once('close', resolve)
      server.web(req, res, targetOptions(ready.port, principal), () => {
        if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":"instance-unreachable"}') }
        resolve()
      })
    })
  }

  const upgrade: UpgradeHandler = async (req, socket, head, context) => {
    delete req.headers[PRINCIPAL_HEADER]
    let ready: { port: number; generation: number; target: RuntimeTarget }
    try {
      const resolved = await ensureReady(req, null, context)
      if (resolved === null) throw new Error('runtime did not start')
      ready = resolved
    } catch {
      socket.destroy()
      return
    }
    await instances.touch(ready.target)
    await instances.wsRef(ready.target, 1)
    socket.once('close', () => {
      void Promise.resolve(instances.wsRef(ready.target, -1))
        .catch(error => { console.error('[gateway] WebSocket activity update failed:', error) })
    })
    const principal = principalSigner?.issue({
      user: context.user,
      scope: context.scope,
      runtime: { kind: ready.target.kind, id: ready.target.id, generation: ready.generation },
    })
    server.ws(req, socket as Duplex & NodeJS.WritableStream, head, targetOptions(ready.port, principal), () => socket.destroy())
  }

  return { proxy, upgrade, close: () => server.close() }
}
