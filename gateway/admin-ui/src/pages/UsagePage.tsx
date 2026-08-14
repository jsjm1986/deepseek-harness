import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { listUsage, setQuota, type AdminUsageSummary } from '../api.ts'

function currentMonth(): string {
  const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function UsagePage() {
  const [month, setMonth] = useState(currentMonth())
  const [rows, setRows] = useState<AdminUsageSummary[]>([])
  const [error, setError] = useState('')
  const [subjectType, setSubjectType] = useState<'role' | 'user'>('role')
  const [subjectId, setSubjectId] = useState('user')
  const [tokenMode, setTokenMode] = useState<'inherit' | 'unlimited' | 'custom'>('unlimited')
  const [costMode, setCostMode] = useState<'inherit' | 'unlimited' | 'custom'>('unlimited')
  const [tokenLimit, setTokenLimit] = useState('')
  const [costLimit, setCostLimit] = useState('')

  const reload = useCallback(async () => {
    try { setRows(await listUsage(month)); setError('') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [month])
  useEffect(() => { void reload() }, [reload])

  async function save(event: FormEvent) {
    event.preventDefault()
    try {
      const parsedToken = Number(tokenLimit)
      const parsedCost = Number(costLimit)
      if (tokenMode === 'custom' && (!Number.isSafeInteger(parsedToken) || parsedToken < 0)) throw new Error('Token 额度必须是非负整数')
      if (costMode === 'custom' && (!Number.isFinite(parsedCost) || parsedCost < 0)) throw new Error('成本额度必须是非负数')
      await setQuota({
        subjectType, subjectId,
        tokenLimit: tokenMode === 'inherit' ? 'inherit' : tokenMode === 'unlimited' ? null : parsedToken,
        companyCostMicrosLimit: costMode === 'inherit' ? 'inherit' : costMode === 'unlimited' ? null : Math.round(parsedCost * 1_000_000),
      })
      await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return <div className="card wide">
    <h1>模型用量</h1>
    {error === '' ? null : <p className="error">{error}</p>}
    <label>月份 <input type="month" value={month} onChange={e => setMonth(e.target.value)} /></label>
    <form onSubmit={event => void save(event)}>
      <h2>额度（仅预警，不阻断）</h2>
      <select value={subjectType} onChange={e => { const next = e.target.value as 'role' | 'user'; setSubjectType(next); if (next === 'role') { if (tokenMode === 'inherit') setTokenMode('unlimited'); if (costMode === 'inherit') setCostMode('unlimited') } }}><option value="role">角色</option><option value="user">用户 ID</option></select>
      <input value={subjectId} onChange={e => setSubjectId(e.target.value)} placeholder={subjectType === 'role' ? 'admin 或 user' : '用户 ID'} required />
      <select aria-label="Token 额度模式" value={tokenMode} onChange={e => setTokenMode(e.target.value as typeof tokenMode)}>{subjectType === 'user' ? <option value="inherit">继承角色</option> : null}<option value="unlimited">无限制</option><option value="custom">自定义 Token</option></select>
      {tokenMode === 'custom' ? <input required value={tokenLimit} onChange={e => setTokenLimit(e.target.value)} inputMode="numeric" placeholder="月 token 额度" /> : null}
      <select aria-label="成本额度模式" value={costMode} onChange={e => setCostMode(e.target.value as typeof costMode)}>{subjectType === 'user' ? <option value="inherit">继承角色</option> : null}<option value="unlimited">无限制</option><option value="custom">自定义公司成本</option></select>
      {costMode === 'custom' ? <input required value={costLimit} onChange={e => setCostLimit(e.target.value)} inputMode="decimal" placeholder="月公司成本额度（元）" /> : null}
      <button type="submit">保存额度</button>
    </form>
    <table><thead><tr><th>用户</th><th>调用</th><th>Token</th><th>估算成本</th><th>公司成本</th><th>缺失计量</th><th>额度 / 告警</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.userId}>
        <td>{row.username}<br/><span className="muted">ID {row.userId}</span></td>
        <td>{row.calls}</td><td>{row.totalTokens.toLocaleString()}</td>
        <td>¥{(row.estimatedCostMicros / 1_000_000).toFixed(4)}</td><td>¥{(row.companyCostMicros / 1_000_000).toFixed(4)}</td>
        <td>{row.missingUsageCalls}</td>
        <td>{row.tokenLimit === null ? 'token 无限' : `${row.tokenLimit.toLocaleString()} token`}<br/>{row.companyCostMicrosLimit === null ? '成本无限' : `¥${(row.companyCostMicrosLimit / 1_000_000).toFixed(2)}`}<br/><span className="warning">{row.alerts.map(a => `${a.metric} ${a.threshold}%`).join('；')}</span></td>
      </tr>)}</tbody></table>
  </div>
}
