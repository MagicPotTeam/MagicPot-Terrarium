import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POISONED_RECORD,
  createFakeChatIndexedDb,
  type FakeChatIndexedDb
} from '../../testUtils/fakeChatIndexedDb'

vi.mock('../../utils/windowUtils', () => ({ api: () => ({}) }))

const STORE = 'sessions-v2'

const stored = (scope: string, id: string, extra: Record<string, unknown> = {}) => ({
  storageKey: `${scope}\u0000${id}`,
  storageScope: scope,
  id,
  title: id,
  messages: [],
  ...extra
})

describe('forEachStoredChatRecord', () => {
  let db: FakeChatIndexedDb

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    localStorage.clear()
    db = createFakeChatIndexedDb()
    db.setVersion(2)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  async function openStorage() {
    db.install(vi.stubGlobal)
    const open = vi.spyOn(globalThis.indexedDB as unknown as { open: () => unknown }, 'open')
    return { storage: await import('./chatStorage'), open }
  }

  it('hands out every record of every scope, as stored, without writing', async () => {
    db.seedStore(STORE, 'storageKey', [stored('default', 'a'), stored('project-a.agent-1', 'b')])
    db.seedRows(STORE, [{ key: 5, value: { ...stored('default', 'n'), storageKey: 5 } }])
    const { storage } = await openStorage()

    const seen: unknown[] = []
    await storage.forEachStoredChatRecord((record) => seen.push(record))

    expect(seen.map((record) => (record as { id: string }).id)).toEqual(['n', 'a', 'b'])
    expect(db.stats.calls.put).toBe(0)
    expect(db.stats.calls.getAll).toBe(0)
  })

  it('stops at the error of its visitor and rejects with it', async () => {
    db.seedStore(STORE, 'storageKey', [stored('default', 'a'), stored('default', 'b')])
    const { storage } = await openStorage()
    const failure = new Error('malformed')
    const seen: string[] = []

    await expect(
      storage.forEachStoredChatRecord((record) => {
        seen.push((record as { id: string }).id)
        throw failure
      })
    ).rejects.toBe(failure)
    expect(seen).toEqual(['a'])
  })

  it('rejects on a record it cannot read without closing the shared connection or dropping summaries', async () => {
    db.seedStore(STORE, 'storageKey', [stored('default', 'a', { createdAt: 1 })])
    db.seedRows(STORE, [{ key: 'project-a.agent-1\u0000unreadable', value: POISONED_RECORD }])
    const { storage, open } = await openStorage()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // An open conversation list: the summaries of the default scope are kept by the module.
    expect((await storage.loadSessionPreviewSummaries('default')).map((s) => s.id)).toEqual(['a'])
    const cursorsBefore = db.stats.calls.openCursor

    await expect(storage.forEachStoredChatRecord(() => undefined)).rejects.toThrow()
    expect(db.stats.poisonedReads).toBe(1)

    // The list is still answered from its summaries, over the same connection.
    expect((await storage.loadSessionPreviewSummaries('default')).map((s) => s.id)).toEqual(['a'])
    expect(db.stats.calls.openCursor).toBe(cursorsBefore + 1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
  })
})
