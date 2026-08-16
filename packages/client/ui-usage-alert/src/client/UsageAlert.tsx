import { useEffect, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { UsageAlertInjected, UsageView } from './index.ts'
import css from './UsageAlert.module.css'

export type UsageAlertProps = PropsRuntime<'shell.overlay'> & InjectFace<UsageAlertInjected>

/** Display gateway-generated quota crossings; the client never recomputes thresholds. */
export function UsageAlert({ loadUsage }: UsageAlertProps) {
  const [view, setView] = useState<UsageView | null>(null)
  useEffect(() => {
    let active = true
    void loadUsage().then((next) => { if (active) setView(next) })
    return () => { active = false }
  }, [loadUsage])
  if (view === null || view.alerts.length === 0) return null
  return <div className={css.stack} aria-live="polite">
    {view.alerts.map(alert => <div className={css.alert} key={`${alert.metric}-${alert.threshold}`} role="status">
      <strong>{alert.threshold}% 用量提醒</strong><br />
      {alert.metric === 'tokens' ? '本月 Token 用量' : '本月公司模型成本'}已达到额度的 {alert.threshold}%。
    </div>)}
  </div>
}
