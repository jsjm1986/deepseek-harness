import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { openDb } from '../src/db.ts'

describe('AuditService', () => {
  it('writes and filters entries', () => {
    const audit = new AuditService(openDb(join(mkdtempSync(join(tmpdir(), 'hgw-')), 'g.sqlite')))
    audit.write({ userId: 1, action: 'login', ip: '1.1.1.1' })
    audit.write({ userId: 1, action: 'api', methodPath: 'POST /api/session.prompt', status: 200 })
    audit.write({ userId: 2, action: 'api', methodPath: 'POST /api/session.create', status: 200 })
    expect(audit.query({ userId: 1 })).toHaveLength(2)
    expect(audit.query({ action: 'login' })[0]?.ip).toBe('1.1.1.1')
    expect(audit.query({ limit: 1 })).toHaveLength(1)
  })
})
