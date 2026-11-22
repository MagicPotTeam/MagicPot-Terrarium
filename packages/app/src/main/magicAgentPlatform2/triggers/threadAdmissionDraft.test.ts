import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { ThreadAdmissionDraft } from './threadAdmissionDraft'
vi.unmock('node:fs')
describe('unwired fake approval admission draft', () => {
  it('requires fake approval, shares admission and preserves unknown after reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'admission-draft-')), path = join(dir, 'db.sqlite')
    const db = new MagicAgentEventStore(path)
    try {
      const draft = new ThreadAdmissionDraft(db, () => true)
      draft.stage('owner-a', 'task', 100, 'stage', 1)
      expect(() => draft.admit('owner-a', 'manual', 'claim', 'pre', 2)).toThrow()
      draft.approve('owner-a', 'approve', 3)
      draft.setPaused('owner-a', true, 'pause', 4)
      expect(() => draft.admit('owner-a', 'manual', 'claim', 'blocked', 5)).toThrow()
      draft.setPaused('owner-a', false, 'resume', 6)
      expect(() => draft.admit('owner-a', 'tick', 'claim', 'early', 7)).toThrow()
      draft.admit('owner-a', 'manual', 'claim', 'admit', 8)
      expect(() => draft.admit('owner-a', 'tick', 'other', 'duplicate', 100)).toThrow()
      draft.markUnknown('owner-a', 'claim', 'unknown', 101)
      const db2 = new MagicAgentEventStore(path)
      try { const reopened = new ThreadAdmissionDraft(db2, () => true); expect(reopened.inspect('owner-a')?.delivery).toBe('unknown'); expect(() => reopened.admit('owner-a', 'manual', 'again', 'again', 102)).toThrow() } finally { db2.close() }
      draft.revoke('owner-a', 'revoke', 103)
      expect(draft.inspect('owner-a')?.approval).toBe('revoked')
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('rejects stale admission if another connection revokes first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'admission-draft-')), path = join(dir, 'db.sqlite'), a = new MagicAgentEventStore(path), b = new MagicAgentEventStore(path)
    try {
      const one = new ThreadAdmissionDraft(a, () => true), two = new ThreadAdmissionDraft(b, () => true)
      one.stage('owner', 'task', 10, 'stage', 1); one.approve('owner', 'approve', 2)
      const commit = a.mutateResource.bind(a)
      vi.spyOn(a, 'mutateResource').mockImplementationOnce(input => { two.revoke('owner', 'revoke', 3); return commit(input) })
      expect(() => one.admit('owner', 'manual', 'claim', 'admit', 4)).toThrow()
      expect(two.inspect('owner')).toMatchObject({ approval: 'revoked', delivery: 'none' })
    } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }) }
  })
})
