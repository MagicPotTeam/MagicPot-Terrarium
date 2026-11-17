import v8 from 'node:v8'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'
import { isBenignSaveSupersede, isPermanentSaveConflict, RefusedSaveSessions, SAVE_SUPERSEDE_STREAK_LIMIT, SaveSupersedeStreaks } from './chatSaveErrors'
import { ChatSessionSaveConflictError, ChatSessionSaveSupersededError, normalizedSessionsEqual, type ChatSession } from './chatStorage'

describe('SaveSupersedeStreaks', () => {
  it('reports exhaustion only after consecutive supersedes of the same object', () => {
    const streaks = new SaveSupersedeStreaks()
    const first = { id: 'a' }
    for (let count = 1; count < SAVE_SUPERSEDE_STREAK_LIMIT; count++) expect(streaks.note(first)).toBe(false)
    expect(streaks.note(first)).toBe(true)
    expect(streaks.note(first)).toBe(true)
    // A replaced (newer) object starts its own streak.
    expect(streaks.note({ id: 'a' })).toBe(false)
    streaks.clear(first)
    expect(streaks.note(first)).toBe(false)
  })
})

describe('normalizedSessionsEqual with NaN values', () => {
  const session: ChatSession = { id: 'nan', title: 'NaN', profileId: 'p', createdAt: 1, messages: [{ role: 'user', content: 'x', ocrResult: { kind: 'text', text: 'x', boxes: [{ x: 0, y: 0, width: 1, height: 1, confidence: NaN }] } }] }
  it('treats a session holding NaN as equal to its own copy', () => {
    expect(normalizedSessionsEqual(session, structuredClone(session), 'default')).toBe(true)
  })
  it('still tells NaN apart from a number, and from a missing value', () => {
    const numbered = structuredClone(session)
    numbered.messages[0].ocrResult!.boxes![0].confidence = 0
    expect(normalizedSessionsEqual(session, numbered, 'default')).toBe(false)
    const missing = structuredClone(session)
    delete missing.messages[0].ocrResult!.boxes![0].confidence
    expect(normalizedSessionsEqual(session, missing, 'default')).toBe(false)
  })
})

describe('RefusedSaveSessions', () => {
  it('skips only the very object that was refused, until the key is deleted or pruned', () => {
    const refused = new RefusedSaveSessions()
    const object = { id: 'a' }
    refused.record('scope\u0000a', object)
    expect(refused.isRefused('scope\u0000a', object)).toBe(true)
    expect(refused.isRefused('scope\u0000a', { id: 'a' })).toBe(false)
    expect(refused.isRefused('other\u0000a', object)).toBe(false)
    expect(refused.has('scope\u0000a')).toBe(true)
    refused.record('other\u0000b', { id: 'b' })
    refused.prune((key, id) => key.startsWith('scope') && id === 'a')
    expect(refused.has('scope\u0000a')).toBe(false)
    expect(refused.has('other\u0000b')).toBe(true)
    refused.delete('other\u0000b')
    expect(refused.size).toBe(0)
  })

  it('does not keep a refused session object alive', async () => {
    v8.setFlagsFromString('--expose-gc')
    const gc = vm.runInNewContext('gc') as () => void
    const refused = new RefusedSaveSessions()
    let probe!: WeakRef<object>
    ;(() => {
      const session = { id: 'big', messages: [{ content: 'x'.repeat(1024) }] }
      probe = new WeakRef(session)
      refused.record('other-scope\u0000big', session)
    })()
    // A WeakRef target survives until the current job ends; collect on a later turn.
    for (let round = 0; round < 5 && probe.deref(); round++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      gc()
    }
    expect(probe.deref()).toBeUndefined()
    // The record itself (the key, and so the "already reported" state) stays.
    expect(refused.has('other-scope\u0000big')).toBe(true)
  })
})

describe('save error classification', () => {
  it('treats a conflict and the writer\'s lifecycle refusal as permanent, a supersede as benign', async () => {
    const baseline: ChatSession = { id: 'member', title: 'Member', profileId: 'p', createdAt: 1, messages: [], teamLeadId: 'lead', teamMemberName: 'a', teamGeneration: 1 }
    const live: ChatSession = { ...baseline, teamGeneration: 2, messages: [{ role: 'user', content: 'edit' }] }
    // The real writer refuses before any storage access: the payload's lifecycle differs from the baseline.
    const refusal = await new ChatSessionSaveBaseline().persistLatest('scope', live.id, () => live, () => baseline).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(Error)
    expect(isPermanentSaveConflict(refusal)).toBe(true)
    expect(isBenignSaveSupersede(refusal)).toBe(false)
    expect(isPermanentSaveConflict(new ChatSessionSaveConflictError('member', 'scope'))).toBe(true)
    expect(isPermanentSaveConflict(new ChatSessionSaveSupersededError())).toBe(false)
    expect(isBenignSaveSupersede(new ChatSessionSaveSupersededError())).toBe(true)
    expect(isPermanentSaveConflict(new Error('IndexedDB failed to compare the chat session.'))).toBe(false)
  })
})
