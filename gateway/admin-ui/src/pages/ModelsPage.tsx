import { Pencil, Plus, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  getModelAccess,
  listModels,
  listUsers,
  saveModel,
  setModelAccess,
  type AdminUser,
  type ModelGovernanceRow,
} from '../api.ts'
import {
  Button,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  LoadingState,
  PageHeader,
  Section,
  StatusBadge,
  Switch,
} from '../components/ui.tsx'

const EMPTY_MODEL: ModelGovernanceRow = {
  provider: '',
  model: '',
  displayName: '',
  enabled: true,
  adminAllowed: true,
  userAllowed: false,
  inputMicrosPerMillion: 0,
  outputMicrosPerMillion: 0,
  cacheReadMicrosPerMillion: 0,
  cacheWriteMicrosPerMillion: 0,
}

const PRICE_LABELS = ['输入', '输出', '缓存读取', '缓存写入'] as const

function yuanToMicros(value: string): number {
  const yuan = Number(value)
  if (!Number.isFinite(yuan) || yuan < 0) throw new Error('单价必须是非负数')
  return Math.round(yuan * 1_000_000)
}

function microsToYuan(value: number): string {
  return (value / 1_000_000).toFixed(4)
}

export function ModelsPage() {
  const [models, setModels] = useState<ModelGovernanceRow[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(true)
  const [accessLoading, setAccessLoading] = useState(false)
  const [error, setError] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingKey, setEditingKey] = useState('')
  const [draft, setDraft] = useState<ModelGovernanceRow>(EMPTY_MODEL)
  const [prices, setPrices] = useState(['0', '0', '0', '0'])
  const [saving, setSaving] = useState(false)
  const [selectedUser, setSelectedUser] = useState('')
  const [overrides, setOverrides] = useState(new Map<string, boolean>())
  const [overridePending, setOverridePending] = useState('')

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const [nextModels, nextUsers] = await Promise.all([listModels(), listUsers()])
      setModels(nextModels)
      setUsers(nextUsers)
      setSelectedUser(current => current === '' || !nextUsers.some(user => String(user.id) === current)
        ? String(nextUsers[0]?.id ?? '')
        : current)
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void reload(true) }, [reload])

  useEffect(() => {
    let active = true
    if (selectedUser === '') {
      setOverrides(new Map())
      setAccessLoading(false)
      return () => { active = false }
    }
    setAccessLoading(true)
    void getModelAccess(Number(selectedUser)).then(view => {
      if (!active) return
      setOverrides(new Map(view.overrides.map(row => [modelKey(row), row.allowed])))
      setError('')
    }).catch(cause => {
      if (active) setError(messageFrom(cause))
    }).finally(() => {
      if (active) setAccessLoading(false)
    })
    return () => { active = false }
  }, [selectedUser])

  const selected = useMemo(() => users.find(user => String(user.id) === selectedUser), [selectedUser, users])

  function openCreate() {
    setEditingKey('')
    setDraft(EMPTY_MODEL)
    setPrices(['0', '0', '0', '0'])
    setEditorOpen(true)
  }

  function openEdit(model: ModelGovernanceRow) {
    setEditingKey(modelKey(model))
    setDraft(model)
    setPrices([
      microsToYuan(model.inputMicrosPerMillion),
      microsToYuan(model.outputMicrosPerMillion),
      microsToYuan(model.cacheReadMicrosPerMillion),
      microsToYuan(model.cacheWriteMicrosPerMillion),
    ])
    setEditorOpen(true)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    try {
      await saveModel({
        ...draft,
        inputMicrosPerMillion: yuanToMicros(prices[0] ?? '0'),
        outputMicrosPerMillion: yuanToMicros(prices[1] ?? '0'),
        cacheReadMicrosPerMillion: yuanToMicros(prices[2] ?? '0'),
        cacheWriteMicrosPerMillion: yuanToMicros(prices[3] ?? '0'),
      })
      setEditorOpen(false)
      await reload()
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setSaving(false)
    }
  }

  async function changeOverride(row: ModelGovernanceRow, value: string) {
    if (selectedUser === '') return
    const key = modelKey(row)
    setOverridePending(key)
    try {
      const allowed = value === 'inherit' ? null : value === 'allow'
      await setModelAccess(Number(selectedUser), row.provider, row.model, allowed)
      const view = await getModelAccess(Number(selectedUser))
      setOverrides(new Map(view.overrides.map(item => [modelKey(item), item.allowed])))
      setError('')
    } catch (cause) {
      setError(messageFrom(cause))
    } finally {
      setOverridePending('')
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="模型治理"
        description="集中控制模型可用性、角色默认权限、用户例外和历史计价。"
        meta={loading ? undefined : `${models.length} 个模型`}
        actions={<Button variant="primary" icon={Plus} onClick={openCreate}>登记模型</Button>}
      />
      <ErrorBanner message={error} />
      <Section
        className="responsiveSection"
        title="模型目录"
        meta={loading ? undefined : `${models.length} 条路由`}
        actions={users.length === 0 ? undefined : (
          <div className="modelUserPicker">
            <span>用户例外</span>
            <select className="select selectCompact" value={selectedUser} onChange={event => setSelectedUser(event.target.value)} aria-label="用户例外">
              {users.map(user => <option key={user.id} value={user.id}>{user.username}（{user.role === 'admin' ? '管理员' : '用户'}）</option>)}
            </select>
          </div>
        )}
      >
        {loading ? <LoadingState label="正在加载模型目录" /> : models.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="还没有登记模型"
            detail="登记 provider 与 model 路由后，可配置角色默认权限、用户例外和计价。"
            action={<Button variant="primary" icon={Plus} onClick={openCreate}>登记模型</Button>}
          />
        ) : (
          <>
            {users.length === 0 ? <div className="inlineNotice">暂无用户；模型目录仍可编辑，创建用户后可配置用户例外。</div> : null}
            <div className="tableWrap desktopOnly">
              <table className="dataTable modelTable">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>状态</th>
                    <th>角色默认</th>
                    <th>{selected === undefined ? '用户例外' : `${selected.username} 的例外`}</th>
                    <th>价格（元 / 百万 Token）</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {models.map(row => {
                    const key = modelKey(row)
                    const override = overrides.get(key)
                    return (
                      <tr key={key}>
                        <td><ModelIdentity row={row} /></td>
                        <td><StatusBadge tone={row.enabled ? 'success' : 'danger'}>{row.enabled ? '已启用' : '已停用'}</StatusBadge></td>
                        <td><RoleDefaults row={row} /></td>
                        <td>
                          <OverrideSelect
                            disabled={selectedUser === '' || accessLoading || overridePending === key}
                            value={override}
                            onChange={value => void changeOverride(row, value)}
                          />
                        </td>
                        <td><PriceSummary row={row} /></td>
                        <td><div className="rowActions"><IconButton label="编辑模型" icon={Pencil} onClick={() => openEdit(row)} /></div></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <div className="mobileList">
              {models.map(row => {
                const key = modelKey(row)
                const override = overrides.get(key)
                return (
                  <article className="mobileItem" key={key}>
                    <div className="mobileItemHeader">
                      <ModelIdentity row={row} />
                      <IconButton label="编辑模型" icon={Pencil} onClick={() => openEdit(row)} />
                    </div>
                    <div className="mobileItemBody">
                      <div className="mobileStatusRow">
                        <StatusBadge tone={row.enabled ? 'success' : 'danger'}>{row.enabled ? '已启用' : '已停用'}</StatusBadge>
                        <RoleDefaults row={row} />
                      </div>
                      <div>
                        <span className="fieldLabel">{selected === undefined ? '用户例外' : `${selected.username} 的例外`}</span>
                        <OverrideSelect
                          disabled={selectedUser === '' || accessLoading || overridePending === key}
                          value={override}
                          onChange={value => void changeOverride(row, value)}
                        />
                      </div>
                      <div><span className="fieldLabel">价格（元 / 百万 Token）</span><PriceSummary row={row} /></div>
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        )}
      </Section>

      <Dialog
        open={editorOpen}
        title={editingKey === '' ? '登记模型' : '编辑模型'}
        description="权限按精确的 provider 与 model 路由生效，价格用于用量核算。"
        onClose={() => { if (!saving) setEditorOpen(false) }}
        footer={(
          <>
            <Button type="button" disabled={saving} onClick={() => setEditorOpen(false)}>取消</Button>
            <Button type="submit" form="model-editor-form" variant="primary" loading={saving}>保存模型</Button>
          </>
        )}
      >
        <form id="model-editor-form" onSubmit={event => void submit(event)}>
          <div className="formGrid">
            <Field label="Provider">
              <input className="input codeText" required disabled={editingKey !== ''} value={draft.provider} onChange={event => setDraft({ ...draft, provider: event.target.value })} placeholder="deepseek" />
            </Field>
            <Field label="Model">
              <input className="input codeText" required disabled={editingKey !== ''} value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} placeholder="deepseek-chat" />
            </Field>
            <Field label="显示名" className="formSpanFull">
              <input className="input" required value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })} />
            </Field>
          </div>
          <div className="formDivider" />
          <div className="toggleGrid">
            <Switch label="启用模型" checked={draft.enabled} onChange={enabled => setDraft({ ...draft, enabled })} />
            <Switch label="管理员默认允许" checked={draft.adminAllowed} onChange={adminAllowed => setDraft({ ...draft, adminAllowed })} />
            <Switch label="普通用户默认允许" checked={draft.userAllowed} onChange={userAllowed => setDraft({ ...draft, userAllowed })} />
          </div>
          <div className="formDivider" />
          <span className="fieldLabel">单价（人民币元 / 百万 Token）</span>
          <div className="priceGrid formSectionSpacing">
            {PRICE_LABELS.map((label, index) => (
              <Field key={label} label={label}>
                <input
                  className="input"
                  required
                  min="0"
                  step="0.0001"
                  inputMode="decimal"
                  value={prices[index]}
                  onChange={event => setPrices(prices.map((value, current) => current === index ? event.target.value : value))}
                />
              </Field>
            ))}
          </div>
        </form>
      </Dialog>
    </div>
  )
}

function ModelIdentity({ row }: { row: ModelGovernanceRow }) {
  return (
    <div className="modelIdentity">
      <span className="itemIcon"><Sparkles aria-hidden="true" /></span>
      <span className="modelIdentityText"><strong>{row.displayName}</strong><span className="codeText">{row.provider}/{row.model}</span></span>
    </div>
  )
}

function RoleDefaults({ row }: { row: ModelGovernanceRow }) {
  return (
    <div className="roleDefaults">
      <span className={row.adminAllowed ? 'allowed' : 'denied'}>管理员 {row.adminAllowed ? '允许' : '拒绝'}</span>
      <span className={row.userAllowed ? 'allowed' : 'denied'}>用户 {row.userAllowed ? '允许' : '拒绝'}</span>
    </div>
  )
}

function OverrideSelect({ value, disabled, onChange }: {
  value: boolean | undefined
  disabled: boolean
  onChange: (value: string) => void
}) {
  return (
    <select className="select selectCompact overrideSelect" disabled={disabled} value={value === undefined ? 'inherit' : value ? 'allow' : 'deny'} onChange={event => onChange(event.target.value)}>
      <option value="inherit">继承角色</option>
      <option value="allow">允许</option>
      <option value="deny">拒绝</option>
    </select>
  )
}

function PriceSummary({ row }: { row: ModelGovernanceRow }) {
  const values = [row.inputMicrosPerMillion, row.outputMicrosPerMillion, row.cacheReadMicrosPerMillion, row.cacheWriteMicrosPerMillion]
  return (
    <div className="priceSummary">
      {PRICE_LABELS.map((label, index) => <span key={label}><b>{label}</b><span>{microsToYuan(values[index] ?? 0)}</span></span>)}
    </div>
  )
}

function modelKey(row: { provider: string; model: string }): string {
  return `${row.provider}\0${row.model}`
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
