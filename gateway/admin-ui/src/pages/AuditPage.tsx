import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { listAudit, type AuditEntry } from '../api.ts'

const PAGE_SIZE = 50

function msFromDatetimeLocal(value: string): number | undefined {
  if (value === '') return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : undefined
}

export function AuditPage() {
  const [rows, setRows] = useState<AuditEntry[]>([])
  const [error, setError] = useState('')
  const [userId, setUserId] = useState('')
  const [actionPrefix, setActionPrefix] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [offset, setOffset] = useState(0)

  const load = useCallback(async (nextOffset: number) => {
    try {
      const parsedUserId = userId === '' ? undefined : Number(userId)
      if (parsedUserId !== undefined && !Number.isInteger(parsedUserId)) {
        setError('invalid userId')
        return
      }
      const next = await listAudit({
        userId: parsedUserId,
        actionPrefix: actionPrefix === '' ? undefined : actionPrefix,
        from: msFromDatetimeLocal(from),
        to: msFromDatetimeLocal(to),
        limit: PAGE_SIZE,
        offset: nextOffset,
      })
      setRows(next)
      setOffset(nextOffset)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [actionPrefix, from, to, userId])

  useEffect(() => {
    void load(0)
  }, [])

  function onFilter(event: FormEvent) {
    event.preventDefault()
    void load(0)
  }

  return (
    <div className="card">
      <h1>审计</h1>
      {error === '' ? null : <p className="error">{error}</p>}
      <form onSubmit={onFilter}>
        <input value={userId} onChange={e => setUserId(e.target.value)} placeholder="userId" inputMode="numeric" />
        <input value={actionPrefix} onChange={e => setActionPrefix(e.target.value)} placeholder="actionPrefix" />
        <input value={from} onChange={e => setFrom(e.target.value)} type="datetime-local" aria-label="from" />
        <input value={to} onChange={e => setTo(e.target.value)} type="datetime-local" aria-label="to" />
        <button type="submit">筛选</button>
      </form>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>userId</th>
            <th>action</th>
            <th>methodPath</th>
            <th>status</th>
            <th>ip</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id}>
              <td>{new Date(row.ts).toLocaleString()}</td>
              <td>{row.userId ?? ''}</td>
              <td>{row.action}</td>
              <td>{row.methodPath}</td>
              <td>{row.status ?? ''}</td>
              <td>{row.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button type="button" disabled={offset === 0} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
        <button type="button" disabled={rows.length < PAGE_SIZE} onClick={() => void load(offset + PAGE_SIZE)}>下一页</button>
        <span className="muted"> offset {offset}</span>
      </p>
    </div>
  )
}
