import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import { ReloadableModelAccess } from './access.ts'
import { UsageOutbox, type UsageRecord } from './outbox.ts'
import { loadPolicy } from './policy.ts'
import { PolicyReloader } from './reload.ts'

export const name = 'dsh-model-governance'
export const inject = ['llm']

function credentialClass(source: string): UsageRecord['credentialClass'] {
  if (source === 'file' || source === 'project-env' || source === 'request') return 'personal'
  if (source === 'env' || source === 'process' || source === 'user-env') return 'company'
  return 'unknown'
}

function terminalStatus(chunk: Extract<StreamChunk, { type: 'finish' }>): UsageRecord['status'] {
  return chunk.reason.kind === 'error' ? 'failed' : chunk.reason.kind === 'aborted' ? 'cancelled' : 'succeeded'
}

/** Mount policy provider plus final llm/stream enforcement and metering. */
export function apply(ctx: Context): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const policyPath = process.env.DSH_MODEL_GOVERNANCE ?? join(home, 'model-governance.json')
  const policy = loadPolicy(policyPath)
  const access = new ReloadableModelAccess(policy)
  ctx.provide('modelAccess', access)
  const outbox = new UsageOutbox(join(home, 'model-governance-outbox'), policy.intakeUrl, policy.intakeToken)
  let reloader: PolicyReloader | undefined
  ctx.effect(() => async () => {
    await reloader?.close()
    await outbox.close()
  }, 'model-governance: drain policy reload and usage outbox')
  reloader = new PolicyReloader({
    filename: policyPath,
    onValid: next => {
      access.replace(next)
      outbox.setEndpoint(next.intakeUrl, next.intakeToken)
    },
    onInvalid: error => {
      access.unavailable()
      ctx.logger.warn(`model-governance: policy reload failed at ${policyPath}; denying new model requests`)
      ctx.logger.warn(error)
    },
    onWatcherError: error => {
      ctx.logger.warn(`model-governance: policy watcher failed at ${policyPath}`)
      ctx.logger.warn(error)
    },
  })
  const enqueue = (record: UsageRecord): void => {
    try { outbox.enqueue(record) } catch (error) {
      ctx.logger.warn('model-governance: failed to persist usage record; model result is preserved')
      ctx.logger.warn(error)
    }
  }
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    const initiatorId = ctx.get('agents')?.currentInitiator()?.session.id
    const explicitId = options.sessionId
    const attributedId = explicitId ?? initiatorId
    const base = {
      eventId: randomUUID(), occurredAt: Date.now(), provider: options.provider, model: options.model,
      purpose: options.purpose ?? 'assistant', ...attributedId === undefined ? {} : { sessionId: String(attributedId) },
    }
    if (initiatorId !== undefined && explicitId !== undefined && initiatorId !== explicitId) {
      return (async function* (): AsyncIterable<StreamChunk> {
        enqueue({ ...base, credentialSource: 'none', credentialClass: 'unknown', status: 'failed' })
        yield { type: 'finish', reason: { kind: 'error', failure: {
          message: 'model-governance: initiating Agent and explicit sessionId disagree', code: 'MODEL_ATTRIBUTION_CONFLICT',
        } } }
      })()
    }
    const decision = access.decide({ provider: options.provider, model: options.model })
    if (!decision.allowed) return (async function* (): AsyncIterable<StreamChunk> {
      enqueue({ ...base, credentialSource: 'none', credentialClass: 'unknown', status: 'denied' })
      yield { type: 'finish', reason: { kind: 'error', failure: { message: decision.reason, code: 'MODEL_FORBIDDEN' } } }
    })()
    return (async function* (): AsyncIterable<StreamChunk> {
      let usage: TokenUsage | undefined
      let source = 'unknown'
      let status: UsageRecord['status'] = 'cancelled'
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') { usage = chunk.usage; source = chunk.credentialSource ?? 'unknown' }
          if (chunk.type === 'finish') status = terminalStatus(chunk)
          yield chunk
        }
      } finally {
        enqueue({
          ...base, credentialSource: source, credentialClass: credentialClass(source),
          status: status === 'succeeded' && usage === undefined ? 'missing-usage' : status,
          ...usage === undefined ? {} : { usage },
        })
      }
    })()
  })
}
