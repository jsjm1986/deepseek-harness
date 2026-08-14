import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { UsageAlert } from './UsageAlert.tsx'

export interface UsageAlert { metric: 'tokens' | 'company-cost'; threshold: 80 | 100; createdAt: number }
export interface UsageView { month: string; alerts: UsageAlert[] }
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
