import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveSessionToDBMock = vi.hoisted(() => vi.fn())

vi.mock('./chatStorage', () => ({
  saveSessionToDB: saveSessionToDBMock
}))

import type { ChatSession } from './chatStorage'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'

const session = (id: string, content: string): ChatSession => ({
  id,
  title: id,
  messages: [{ role: 'user', content }]
})

describe('ChatSessionSaveBaseline', () => {
  beforeEach(() => {
    saveSessionToDBMock.mockReset()
    saveSessionToDBMock.mockResolvedValue(undefined)
  })

  it('freezes the baseline once and passes it as expectedSession', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')
    const resolve = vi.fn(() => v0)

    await baseline.persist('scope-a', v1, resolve)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(saveSessionToDBMock).toHaveBeenCalledWith(v1, 'scope-a', { expectedSession: v0 })
  })

  it('does not replace an already frozen baseline', () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')

    expect(baseline.freeze('scope-a', 's1', v0)).toBe(v0)
    // A later (external) refresh attempting to freeze again is ignored.
    expect(baseline.freeze('scope-a', 's1', v1)).toBe(v0)
  })

  it('serializes concurrent own saves and advances the baseline between them', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')
    const v2 = session('s1', 'v2')

    const order: string[] = []
    saveSessionToDBMock.mockImplementation(async (saved: ChatSession) => {
      order.push(`start:${saved.messages[0].content}`)
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`end:${saved.messages[0].content}`)
    })

    const first = baseline.persist('scope-a', v1, () => v0)
    const second = baseline.persist('scope-a', v2, () => v0)
    await Promise.all([first, second])

    // The second save waits for the first to advance the baseline, so it expects v1 (not v0).
    expect(saveSessionToDBMock.mock.calls).toEqual([
      [v1, 'scope-a', { expectedSession: v0 }],
      [v2, 'scope-a', { expectedSession: v1 }]
    ])
    expect(order).toEqual(['start:v1', 'end:v1', 'start:v2', 'end:v2'])
  })

  it('does not advance the baseline when a save fails', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')
    const v2 = session('s1', 'v2')

    saveSessionToDBMock.mockRejectedValueOnce(new Error('conflict'))

    await expect(baseline.persist('scope-a', v1, () => v0)).rejects.toThrow('conflict')
    // Baseline stays at the frozen v0, so a retry still compares against v0.
    await baseline.persist('scope-a', v2, () => v0)

    expect(saveSessionToDBMock.mock.calls).toEqual([
      [v1, 'scope-a', { expectedSession: v0 }],
      [v2, 'scope-a', { expectedSession: v0 }]
    ])
  })

  it('keeps baselines isolated per scope', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const a = session('s1', 'scope a')
    const b = session('s1', 'scope b')

    await baseline.persist('scope-a', a, () => null)
    await baseline.persist('scope-b', b, () => null)

    expect(saveSessionToDBMock.mock.calls).toEqual([
      [a, 'scope-a', { expectedSession: null }],
      [b, 'scope-b', { expectedSession: null }]
    ])
  })

  it('releases a baseline so a later persist re-freezes', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')

    await baseline.persist('scope-a', v0, () => null)
    baseline.release('scope-a', 's1')
    const resolve = vi.fn(() => v1)
    await baseline.persist('scope-a', v1, resolve)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(saveSessionToDBMock).toHaveBeenLastCalledWith(v1, 'scope-a', { expectedSession: v1 })
  })

  it('freezes synchronously before enqueue so a later resolver value cannot move the baseline', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const vX = session('s1', 'vX')
    const toSave = session('s1', 'save')
    let current = v0

    const pending = baseline.persist('scope-a', toSave, () => current)
    // Mutate the resolved source AFTER the persist call but BEFORE the queued task runs.
    current = vX
    await pending

    expect(saveSessionToDBMock).toHaveBeenCalledWith(toSave, 'scope-a', { expectedSession: v0 })
  })

  it('does not advance a stale in-flight baseline back after reset', async () => {
    const baseline = new ChatSessionSaveBaseline()
    let release!: () => void
    saveSessionToDBMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const pending = baseline.persist('scope-a', session('s1', 'v1'), () => session('s1', 'v0'))
    // Let the queued task start and block inside saveSessionToDB.
    await Promise.resolve()
    baseline.reset()
    release()
    await pending

    // Epoch guard: the pre-reset write must not re-seed a baseline for the stale snapshot.
    expect(baseline.hasBaseline('scope-a', 's1')).toBe(false)
  })

  it('does not let a stale queued save use a baseline frozen by a newer load after reset', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const vOld = session('s1', 'old')
    const vNewLoad = session('s1', 'new-load')
    const staleSave = session('s1', 'stale-write')
    let release!: () => void
    saveSessionToDBMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const pending = baseline.persist('scope-a', staleSave, () => vOld)
    await Promise.resolve()
    baseline.reset() // lifecycle reset (e.g. scope switch / reload)
    baseline.freeze('scope-a', 's1', vNewLoad) // new load freezes a new baseline for the same key
    release()
    await pending

    // The stale task must compare against the OLD captured snapshot, never the new-load baseline.
    expect(saveSessionToDBMock).toHaveBeenCalledWith(staleSave, 'scope-a', {
      expectedSession: vOld
    })
    // The new-load baseline is left intact for future clean saves.
    expect(baseline.freeze('scope-a', 's1', session('s1', 'ignored'))).toBe(vNewLoad)
  })

  it('adopts loaded baselines for clean sessions but preserves dirty baselines across a reload', () => {
    const baseline = new ChatSessionSaveBaseline()
    const dirtyV0 = session('dirty', 'unsaved v0')
    const cleanV0 = session('clean', 'clean v0')
    baseline.freeze('scope-a', 'dirty', dirtyV0)
    baseline.freeze('scope-a', 'clean', cleanV0)

    const dirtyDb = session('dirty', 'newer db dirty')
    const cleanDb = session('clean', 'newer db clean')
    baseline.adoptLoaded('scope-a', [dirtyDb, cleanDb], new Set(['dirty']))

    // Dirty session keeps its frozen (unsaved) baseline — no overwrite authority from newer DB.
    expect(baseline.freeze('scope-a', 'dirty', session('dirty', 'x'))).toBe(dirtyV0)
    // Clean session adopts the freshly loaded snapshot.
    expect(baseline.freeze('scope-a', 'clean', session('clean', 'x'))).toBe(cleanDb)
  })

  it('skips adoption for a session with an in-flight write', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const edit = session('s1', 'edit')
    let release!: () => void
    saveSessionToDBMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const pending = baseline.persist('scope-a', edit, () => v0)
    await Promise.resolve()
    baseline.adoptLoaded('scope-a', [session('s1', 'newer db')], new Set())
    release()
    await pending

    // Adoption must not have replaced the in-flight baseline; CAS compares against the frozen v0.
    expect(saveSessionToDBMock).toHaveBeenCalledWith(edit, 'scope-a', { expectedSession: v0 })
    expect(baseline.freeze('scope-a', 's1', session('s1', 'x'))).toBe(edit)
  })

  const useCasStore = (): Map<string, ChatSession> => {
    const store = new Map<string, ChatSession>()
    saveSessionToDBMock.mockImplementation(
      async (
        saved: ChatSession,
        scope: string,
        options?: { expectedSession: ChatSession | null }
      ) => {
        const key = `${scope}\u0000${saved.id}`
        const current = store.get(key) ?? null
        const expected = options?.expectedSession ?? null
        if (expected === null) {
          if (current) throw new Error('conflict')
        } else if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
          throw new Error('conflict')
        }
        store.set(key, saved)
      }
    )
    return store
  }

  it('lets a clean window that adopted a newer external snapshot save a legit follow-up without self-conflict', async () => {
    const store = useCasStore()
    const baseline = new ChatSessionSaveBaseline()
    const external = session('s1', 'external new reply')
    store.set('scope-a\u0000s1', external)
    // Clean window adopts the freshly installed external snapshot on refresh.
    baseline.adoptLoaded('scope-a', [external], new Set())

    const follow = session('s1', 'legit follow-up')
    await expect(
      baseline.persist('scope-a', follow, () => session('s1', 'stale'))
    ).resolves.toBeUndefined()
    expect(store.get('scope-a\u0000s1')).toBe(follow)
  })

  it('keeps a dirty window on its stale baseline so a save after refresh still conflicts', async () => {
    const store = useCasStore()
    const baseline = new ChatSessionSaveBaseline()
    const old = session('s1', 'old local')
    const external = session('s1', 'external new reply')
    store.set('scope-a\u0000s1', external)
    // Frozen while dirty, before the external advance.
    baseline.freeze('scope-a', 's1', old)
    // Refresh must NOT adopt because the key is dirty.
    baseline.adoptLoaded('scope-a', [external], new Set(['s1']))

    await expect(
      baseline.persist('scope-a', session('s1', 'dirty edit'), () => old)
    ).rejects.toThrow('conflict')
    // The external record is preserved (no overwrite).
    expect(store.get('scope-a\u0000s1')).toBe(external)
  })
})
