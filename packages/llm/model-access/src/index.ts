/** Model-route authorization capability for selectors and execution policy. */
import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelAccess: ModelAccessService
  }
}

/** Exact provider/model route presented to the policy. */
export interface ModelAccessTarget {
  provider: string
  model: string
}

/** Authorization decision for one exact model route. */
export type ModelAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: string }

/** Runtime face published as `ctx.modelAccess`. Implementations may be plain objects. */
export interface ModelAccessService {
  /**
   * Decide whether one exact route is authorized.
   * @param target - provider and provider-owned model id.
   * @returns the authorization decision and a display-safe denial reason.
   */
  decide(target: ModelAccessTarget): ModelAccessDecision
}

/** Optional Service base for in-tree providers that prefer class registration. */
export abstract class ModelAccessPolicy extends Service implements ModelAccessService {
  constructor(ctx: Context) {
    super(ctx, 'modelAccess')
  }

  /**
   * Decide whether one exact route may be selected or executed.
   * @param target - provider and provider-owned model id.
   * @returns the authorization decision and a display-safe denial reason.
   */
  abstract decide(target: ModelAccessTarget): ModelAccessDecision
}

export default ModelAccessPolicy
