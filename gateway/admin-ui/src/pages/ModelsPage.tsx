import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  getModelAccess, listModels, listUsers, saveModel, setModelAccess,
  type AdminUser, type ModelGovernanceRow,
} from '../api.ts'

const EMPTY: ModelGovernanceRow = {
  provider: '', model: '', displayName: '', enabled: true, adminAllowed: true, userAllowed: false,
  inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
  cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0,
}

function yuanToMicros(value: string): number {
  const yuan = Number(value)
  if (!Number.isFinite(yuan) || yuan < 0) throw new Error('单价必须是非负数')
  return Math.round(yuan * 1_000_000)
}

export function ModelsPage() {
  const [models, setModels] = useState<ModelGovernanceRow[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [draft, setDraft] = useState(EMPTY)
  const [prices, setPrices] = useState(['0', '0', '0', '0'])
  const [selectedUser, setSelectedUser] = useState('')
  const [overrides, setOverrides] = useState(new Map<string, boolean>())
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    try {
      const [nextModels, nextUsers] = await Promise.all([listModels(), listUsers()])
      setModels(nextModels); setUsers(nextUsers)
      if (selectedUser === '' && nextUsers[0] !== undefined) setSelectedUser(String(nextUsers[0].id))
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [selectedUser])

  useEffect(() => { void reload() }, [])
  useEffect(() => {
    if (selectedUser === '') { setOverrides(new Map()); return }
    void getModelAccess(Number(selectedUser)).then(view => {
      setOverrides(new Map(view.overrides.map(row => [`${row.provider}\0${row.model}`, row.allowed])))
    }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [selectedUser])

  const selected = useMemo(() => users.find(user => String(user.id) === selectedUser), [selectedUser, users])

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await saveModel({
        ...draft,
        inputMicrosPerMillion: yuanToMicros(prices[0] ?? '0'),
        outputMicrosPerMillion: yuanToMicros(prices[1] ?? '0'),
        cacheReadMicrosPerMillion: yuanToMicros(prices[2] ?? '0'),
        cacheWriteMicrosPerMillion: yuanToMicros(prices[3] ?? '0'),
      })
      setDraft(EMPTY); setPrices(['0', '0', '0', '0']); await reload()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function changeOverride(row: ModelGovernanceRow, value: string) {
    try {
      const allowed = value === 'inherit' ? null : value === 'allow'
      await setModelAccess(Number(selectedUser), row.provider, row.model, allowed)
      const view = await getModelAccess(Number(selectedUser))
      setOverrides(new Map(view.overrides.map(item => [`${item.provider}\0${item.model}`, item.allowed])))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return <div className="card wide">
    <h1>模型治理</h1>
    {error === '' ? null : <p className="error">{error}</p>}
    <form onSubmit={event => void submit(event)}>
      <h2>登记或更新模型</h2>
      <input required placeholder="provider" value={draft.provider} onChange={e => setDraft({ ...draft, provider: e.target.value })} />
      <input required placeholder="model" value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} />
      <input required placeholder="显示名" value={draft.displayName} onChange={e => setDraft({ ...draft, displayName: e.target.value })} />
      <label><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用</label>
      <label><input type="checkbox" checked={draft.adminAllowed} onChange={e => setDraft({ ...draft, adminAllowed: e.target.checked })} />管理员允许</label>
      <label><input type="checkbox" checked={draft.userAllowed} onChange={e => setDraft({ ...draft, userAllowed: e.target.checked })} />普通用户允许</label>
      <p className="muted">单价单位：人民币元 / 百万 token</p>
      {['输入', '输出', '缓存读取', '缓存写入'].map((label, index) => <input key={label} inputMode="decimal" placeholder={`${label}单价`} value={prices[index]} onChange={e => setPrices(prices.map((value, i) => i === index ? e.target.value : value))} />)}
      <button type="submit">保存模型</button>
    </form>
    <h2>用户例外</h2>
    <select value={selectedUser} onChange={e => setSelectedUser(e.target.value)} aria-label="用户">
      {users.map(user => <option key={user.id} value={user.id}>{user.username} ({user.role})</option>)}
    </select>
    <span className="muted">未设置时继承 {selected?.role ?? '角色'} 模板</span>
    <table><thead><tr><th>模型</th><th>启用</th><th>admin</th><th>user</th><th>本用户例外</th><th>当前价格（元/百万）</th></tr></thead>
      <tbody>{models.map(row => {
        const override = overrides.get(`${row.provider}\0${row.model}`)
        return <tr key={`${row.provider}/${row.model}`}>
          <td><strong>{row.displayName}</strong><br/><span className="muted">{row.provider}/{row.model}</span></td>
          <td>{row.enabled ? '是' : '否'}</td><td>{row.adminAllowed ? '允许' : '拒绝'}</td><td>{row.userAllowed ? '允许' : '拒绝'}</td>
          <td><select disabled={selectedUser === ''} value={override === undefined ? 'inherit' : override ? 'allow' : 'deny'} onChange={e => void changeOverride(row, e.target.value)}>
            <option value="inherit">继承</option><option value="allow">允许</option><option value="deny">拒绝</option>
          </select></td>
          <td>{[row.inputMicrosPerMillion, row.outputMicrosPerMillion, row.cacheReadMicrosPerMillion, row.cacheWriteMicrosPerMillion].map(v => (v / 1_000_000).toFixed(4)).join(' / ')}</td>
        </tr>
      })}</tbody></table>
  </div>
}
