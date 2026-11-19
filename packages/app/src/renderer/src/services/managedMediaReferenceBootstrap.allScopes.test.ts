import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  POISONED_RECORD,
  createFakeChatIndexedDb,
  type FakeChatIndexedDb
} from '../testUtils/fakeChatIndexedDb'

/**
 * The scan over the real chat store (on the in-memory IndexedDB of the chat storage tests).
 * Its snapshot authorises deletion of every managed file it does not name: it must name at least
 * what the scoped loaders of every scope can see, and nothing at all when a read fails.
 */

const mocks = vi.hoisted(() => ({
  loadCanvasItemsMetadata: vi.fn(),
  updateReferenceSnapshot: vi.fn()
}))

vi.mock('../pages/ProjectCanvasPage/canvasStorage', () => ({
  CanvasMetadataFileError: class CanvasMetadataFileError extends Error {},
  loadCanvasItemsMetadata: mocks.loadCanvasItemsMetadata
}))

vi.mock('../utils/windowUtils', () => ({
  api: () => ({ svcManagedMedia: { updateReferenceSnapshot: mocks.updateReferenceSnapshot } })
}))

const STORE = 'sessions-v2'

const id = (n: number): string => n.toString(16).padStart(2, '0').repeat(32)

const media = (sha256: string) => ({
  version: 1 as const,
  kind: 'managed' as const,
  sha256,
  relativePath: `originals/${sha256.slice(0, 2)}/${sha256}.png`,
  sizeBytes: 10,
  mimeType: 'image/png',
  originalFileName: 'image.png'
})

const image = (sha256: string) => ({
  type: 'image',
  url: `local-media:///media/${sha256}.png`,
  media: media(sha256)
})

const stored = (scope: string, sessionId: string, extra: Record<string, unknown> = {}) => ({
  storageKey: `${scope}\u0000${sessionId}`,
  storageScope: scope,
  id: sessionId,
  title: sessionId,
  messages: [],
  createdAt: 1,
  ...extra
})

type Snapshot = {
  version: 1
  complete: boolean
  ids: string[]
  referenceCounts: Record<string, number>
}

describe('managed media reference scan over every scope of the chat store', () => {
  let db: FakeChatIndexedDb

  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    vi.useFakeTimers()
    localStorage.clear()
    mocks.loadCanvasItemsMetadata.mockReset()
    mocks.loadCanvasItemsMetadata.mockResolvedValue({ items: [] })
    mocks.updateReferenceSnapshot.mockReset()
    mocks.updateReferenceSnapshot.mockResolvedValue(undefined)
    db = createFakeChatIndexedDb()
    db.setVersion(2)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  async function scanOnce(): Promise<Snapshot> {
    db.install(vi.stubGlobal)
    const { startManagedMediaReferenceScanner } = await import('./managedMediaReferenceBootstrap')
    const stop = startManagedMediaReferenceScanner()
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      for (
        let step = 0;
        step < 100 && mocks.updateReferenceSnapshot.mock.calls.length === 0;
        step += 1
      ) {
        await vi.advanceTimersByTimeAsync(10)
      }
    } finally {
      stop()
    }
    expect(mocks.updateReferenceSnapshot).toHaveBeenCalledTimes(1)
    return mocks.updateReferenceSnapshot.mock.calls[0][0] as Snapshot
  }

  it('names media referenced only from a conversation of an Agent pane scope', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('default', 'main', {
        messages: [{ role: 'user', content: 'a', attachments: [image(id(1))] }]
      }),
      stored('project-a.agent-1', 'pane-thread', {
        messages: [{ role: 'assistant', content: 'b', attachments: [image(id(2))] }]
      })
    ])

    const snapshot = await scanOnce()

    expect(snapshot).toEqual({
      version: 1,
      complete: true,
      ids: [id(1), id(2)],
      referenceCounts: { [id(1)]: 1, [id(2)]: 1 }
    })
  })

  it('names at least every reference the scoped loaders of every scope see, for every store shape', async () => {
    const queuedReceipt = {
      version: 1,
      id: 'receipt-1',
      recipientId: 'member-1',
      teamKey: 'team-1',
      text: 'hello',
      state: 'queued',
      createdAt: 1,
      updatedAt: 1
    }
    db.seedStore(STORE, 'storageKey', [
      stored('default', 'main', {
        messages: [
          { role: 'user', content: 'a', attachments: [image(id(1))] },
          {
            role: 'assistant',
            content: 'b',
            toolHistory: [
              {
                runId: 'r',
                toolCallId: 't',
                toolName: 'tool',
                args: {},
                status: 'completed',
                metadata: { output: { media: media(id(3)) } }
              }
            ]
          }
        ],
        compactedMessages: [{ role: 'user', content: 'old', attachments: [image(id(2))] }],
        draft: {
          inputValue: 'typing',
          pendingAttachments: [image(id(4))],
          pendingHiddenContext: '',
          updatedAt: 5,
          queuedSends: [
            { id: 'q1', text: 'later', attachments: [image(id(5))], hiddenContext: '' }
          ],
          queuedSendsUpdatedAt: 5
        },
        teamMessageReceipts: [queuedReceipt]
      }),
      stored('project-a.agent-1', 'pane-thread', {
        messages: [{ role: 'assistant', content: 'c', attachments: [image(id(6))] }],
        draft: {
          inputValue: '',
          pendingAttachments: [],
          pendingHiddenContext: '',
          updatedAt: 1,
          queuedSends: [
            { id: 'q2', text: 'queued', attachments: [image(id(7))], hiddenContext: '' }
          ],
          queuedSendsUpdatedAt: 1
        }
      }),
      stored('project-b.agent-3', 'member', {
        teamLeadId: 'lead',
        teamMemberName: 'Member',
        messages: [{ role: 'assistant', content: 'd', attachments: [image(id(8))] }]
      }),
      // The key names the default scope, the record another one: no scoped loader returns it.
      {
        ...stored('project-c.agent-1', 'moved'),
        storageKey: 'default\u0000moved',
        messages: [{ role: 'user', content: 'e', attachments: [image(id(11))] }]
      }
    ])
    // Keys no scope range reaches.
    db.seedRows(STORE, [
      {
        key: 7,
        value: {
          ...stored('default', 'numeric-key'),
          storageKey: 7,
          messages: [{ role: 'user', content: 'f', attachments: [image(id(9))] }]
        }
      },
      {
        key: 'no-separator',
        value: {
          ...stored('default', 'stray'),
          storageKey: 'no-separator',
          messages: [{ role: 'user', content: 'g', attachments: [image(id(10))] }]
        }
      }
    ])
    localStorage.setItem(
      'magicpot-chat-draft:project-a.agent-1:pane-thread',
      JSON.stringify({
        updatedAt: 2,
        queuedSends: [
          { id: 'q3', text: 'backup', attachments: [image(id(12))], hiddenContext: '' }
        ],
        queuedSendsUpdatedAt: 2
      })
    )
    localStorage.setItem(
      'magicpot-chat-draft:default:main',
      JSON.stringify({
        updatedAt: 6,
        draft: {
          inputValue: 'x',
          pendingAttachments: [image(id(13))],
          pendingHiddenContext: '',
          updatedAt: 6
        }
      })
    )
    localStorage.setItem('ai_engine_projects', JSON.stringify([{ id: 'canvas-a' }]))
    mocks.loadCanvasItemsMetadata.mockResolvedValue({
      items: [{ id: 'canvas-item', type: 'image', media: media(id(14)) }]
    })

    const snapshot = await scanOnce()
    // A scan reads, it never writes (the scoped loader persists recovered team receipts).
    expect(db.stats.calls.put).toBe(0)
    expect(db.stats.calls.delete).toBe(0)

    // What every scoped loader of every scope hands out, with the draft backups each reads.
    vi.useRealTimers()
    const storage = await import('../pages/ChatPage/chatStorage')
    const { scanManagedMediaReferenceIds } = await import('./managedMediaReferenceScanner')
    const loaded: unknown[] = []
    for (const scope of [
      'default',
      'project-a.agent-1',
      'project-b.agent-3',
      'project-c.agent-1'
    ]) {
      for (const session of await storage.loadAllSessions(scope)) {
        loaded.push(session, storage.readSessionDraftBackup(session.id, scope))
      }
    }
    const scoped = await scanManagedMediaReferenceIds({
      visitChatRecords: async (visit) => visit(loaded),
      visitCanvasItems: async (visit) => visit((await mocks.loadCanvasItemsMetadata()).items),
      localStorage
    })
    expect(scoped.ok).toBe(true)
    // Only the record whose key and scope disagree is out of every scoped loader's reach.
    expect(scoped.ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14].map(id))

    expect(snapshot.complete).toBe(true)
    expect(snapshot.ids).toEqual(expect.arrayContaining(scoped.ids))
    expect(snapshot.ids).toEqual(Array.from({ length: 14 }, (_, index) => id(index + 1)))
  })

  it('reads the store one record at a time, every key, without a whole-store getAll', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('default', 'a'),
      stored('project-a.agent-1', 'b'),
      stored('project-b.agent-1', 'c')
    ])
    db.seedRows(STORE, [{ key: 3, value: { ...stored('default', 'n'), storageKey: 3 } }])

    const snapshot = await scanOnce()

    expect(snapshot.complete).toBe(true)
    expect(db.stats.calls.getAll).toBe(0)
    expect(db.stats.calls.openCursor).toBe(1)
    expect([...db.stats.handedOut].sort()).toEqual(
      [3, 'default\u0000a', 'project-a.agent-1\u0000b', 'project-b.agent-1\u0000c'].sort()
    )
  })

  it('sends an incomplete snapshot when a record of any scope cannot be read', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('default', 'main', {
        messages: [{ role: 'user', content: 'a', attachments: [image(id(1))] }]
      })
    ])
    db.seedRows(STORE, [{ key: 'project-a.agent-1\u0000unreadable', value: POISONED_RECORD }])

    const snapshot = await scanOnce()

    expect(db.stats.poisonedReads).toBe(1)
    expect(snapshot).toEqual({ version: 1, complete: false, ids: [], referenceCounts: {} })
  })

  it('sends an incomplete snapshot when a record of another scope holds a malformed reference', async () => {
    db.seedStore(STORE, 'storageKey', [
      stored('default', 'main', {
        messages: [{ role: 'user', content: 'a', attachments: [image(id(1))] }]
      }),
      stored('project-a.agent-1', 'broken', {
        messages: [
          {
            role: 'user',
            content: 'b',
            attachments: [{ type: 'image', url: 'x', media: { kind: 'managed', sha256: 'bad' } }]
          }
        ]
      }),
      stored('project-z.agent-1', 'after', {
        messages: [{ role: 'user', content: 'c', attachments: [image(id(2))] }]
      })
    ])

    const snapshot = await scanOnce()

    expect(snapshot).toEqual({ version: 1, complete: false, ids: [], referenceCounts: {} })
    // The pass stops at the malformed record.
    expect(db.stats.handedOut).not.toContain('project-z.agent-1\u0000after')
  })

  it('sends an incomplete snapshot when the chat store cannot be opened', async () => {
    db.install(vi.stubGlobal)
    vi.stubGlobal('indexedDB', {
      cmp: () => 0,
      open: () => {
        throw new DOMException('Denied', 'UnknownError')
      }
    })
    const { startManagedMediaReferenceScanner } = await import('./managedMediaReferenceBootstrap')
    const stop = startManagedMediaReferenceScanner()
    await vi.advanceTimersByTimeAsync(2_000)
    stop()
    expect(mocks.updateReferenceSnapshot).toHaveBeenCalledWith({
      version: 1,
      complete: false,
      ids: [],
      referenceCounts: {}
    })
  })
})
