import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { UsageAlert } from './UsageAlert.tsx'

/** One durable quota threshold crossing returned by the Gateway account API. */
export interface UsageAlert { metric: 'tokens' | 'company-cost'; threshold: 80 | 100; createdAt: number }
/** Account usage fields required by the shell alert overlay. */
export interface UsageView { month: string; alerts: UsageAlert[] }
/** Apply-side loader injected into the usage-alert presentation component. */
export interface UsageAlertInjected { loadUsage: () => Promise<UsageView | null> }

export const inject = ['slots']
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'usage-alert',
    inject: (): UsageAlertInjected => ({
      loadUsage: async () => {
        try {
          const response = await fetch('/account/api/usage', { credentials: 'same-origin' })
          return response.ok ? await response.json() as UsageView : null
        } catch {
          // Advisory usage transport never disrupts the shell.
          return null
        }
      },
    }),
  }, UsageAlert))
}
