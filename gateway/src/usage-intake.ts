import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { UsageEvent } from './model-governance.ts'
import type { GatewayAuditService, GatewayModelGovernanceService } from './services.ts'

async function body(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const value = Buffer.from(chunk as Uint8Array); size += value.length; if (size > limit) throw new Error('body too large'); chunks.push(value) }
  return Buffer.concat(chunks).toString('utf8')
}

/** Create the private loopback-only, bearer-authenticated usage intake. */
export function createUsageIntakeServer(
  governance: GatewayModelGovernanceService,
  audit?: GatewayAuditService,
): Server {
  return createServer((req, res) => { void (async () => {
    if (req.method !== 'POST' || req.url !== '/usage') { res.writeHead(404).end(); return }
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
    const subject = token === '' ? null : await governance.subjectForIntakeToken(token)
    if (subject === null) { res.writeHead(401).end(); return }
    try {
      const event = JSON.parse(await body(req)) as UsageEvent
      const result = await governance.ingest(subject, event)
      if (result.inserted && event.status === 'denied') {
        await audit?.write({
          ...(subject.kind === 'user' ? { userId: subject.id } : {}),
          action: 'model.denied',
          detail: JSON.stringify({
            subject,
            provider: event.provider,
            model: event.model,
            purpose: event.purpose,
          }),
        })
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
    }
  })().catch(() => { if (!res.writableEnded) res.writeHead(500).end() }) })
}
