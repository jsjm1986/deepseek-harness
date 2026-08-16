import type { ModelAccessService } from '@deepseek-ai/dsh-model-access'
import type { GovernancePolicyFile } from './policy.ts'

/** Message used when a live policy reload has left the provider fail-closed. */
export const POLICY_UNAVAILABLE_REASON =
  'Model authorization is temporarily unavailable; requests are blocked until a valid policy is loaded.'

interface ModelAccessSnapshot {
  readonly defaultAllowed: boolean
  readonly routes: ReadonlyMap<string, boolean>
  readonly unavailable: boolean
}

/**
 * Stable model-access service whose immutable decision snapshot can be replaced
 * without replacing the Cordis service object consumed by other plugins.
 */
export class ReloadableModelAccess implements ModelAccessService {
  private snapshot: ModelAccessSnapshot

  /**
   * @param policy - the policy that was validated during plugin activation.
   */
  constructor(policy: GovernancePolicyFile) {
    this.snapshot = createSnapshot(policy)
  }

  /**
   * Replace the whole decision snapshot after a validated policy reload.
   * @param policy - the newly validated policy.
   */
  replace(policy: GovernancePolicyFile): void {
    this.snapshot = createSnapshot(policy)
  }

  /** Enter fail-closed mode until a valid policy is published. */
  unavailable(): void {
    this.snapshot = {
      defaultAllowed: false,
      routes: new Map(),
      unavailable: true,
    }
  }

  /**
   * Decide whether a provider/model route is currently authorized.
   * @param target - provider and model route to check.
   * @returns an allow or deny decision for the current immutable snapshot.
   */
  decide(target: { provider: string; model: string }) {
    const snapshot = this.snapshot
    if (snapshot.unavailable) return { allowed: false as const, reason: POLICY_UNAVAILABLE_REASON }
    const allowed = snapshot.routes.get(`${target.provider}\0${target.model}`) ?? snapshot.defaultAllowed
    return allowed ? { allowed: true as const } : {
      allowed: false as const,
      reason: `Model "${target.provider}/${target.model}" is not authorized for this account.`,
    }
  }
}

function createSnapshot(policy: GovernancePolicyFile): ModelAccessSnapshot {
  return {
    defaultAllowed: policy.defaultAllowed,
    routes: new Map(policy.models.map(entry => [`${entry.provider}\0${entry.model}`, entry.allowed])),
    unavailable: false,
  }
}
