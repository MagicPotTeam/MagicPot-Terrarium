import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  forEachStoredChatRecord: vi.fn(),
  loadCanvasItems: vi.fn(),
  updateReferenceSnapshot: vi.fn()
}))

vi.mock('../pages/ChatPage/chatStorage', () => ({
  forEachStoredChatRecord: mocks.forEachStoredChatRecord
}))

vi.mock('../pages/ProjectCanvasPage/canvasStorage', () => ({
  loadCanvasItemsMetadata: mocks.loadCanvasItems
}))

vi.mock('../utils/windowUtils', () => ({
  api: () => ({
    svcManagedMedia: {
      updateReferenceSnapshot: mocks.updateReferenceSnapshot
    }
  })
}))

import { startManagedMediaReferenceScanner } from './managedMediaReferenceBootstrap'

const reference = (id: string) => ({
  version: 1 as const,
  kind: 'managed' as const,
  sha256: id,
  relativePath: `originals/${id.slice(0, 2)}/${id}.png`,
  sizeBytes: 1024,
  mimeType: 'image/png',
  originalFileName: `${id.slice(0, 8)}.png`
})

describe('managed media reference bootstrap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    mocks.forEachStoredChatRecord.mockReset()
    mocks.loadCanvasItems.mockReset()
    mocks.updateReferenceSnapshot.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('publishes managed references from chat sessions, draft backups, and canvas items', async () => {
    localStorage.setItem('ai_engine_projects', JSON.stringify([{ id: 'canvas-a' }]))
    mocks.forEachStoredChatRecord.mockImplementation(async (visit: (record: unknown) => void) => {
      visit({
        id: 'chat-a',
        messages: [
          { role: 'assistant', content: '', attachments: [{ media: reference('a'.repeat(64)) }] }
        ]
      })
    })
    localStorage.setItem(
      'magicpot-chat-draft:default:chat-a',
      JSON.stringify({
        updatedAt: 1,
        draft: { pendingAttachments: [{ media: reference('b'.repeat(64)) }] }
      })
    )
    mocks.loadCanvasItems.mockResolvedValue({
      items: [{ id: 'canvas-item', type: 'image', media: reference('c'.repeat(64)) }]
    })
    mocks.updateReferenceSnapshot.mockResolvedValue(undefined)

    const stop = startManagedMediaReferenceScanner()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(mocks.loadCanvasItems).toHaveBeenCalledWith('canvas-a')
    expect(mocks.updateReferenceSnapshot).toHaveBeenCalledWith({
      version: 1,
      complete: true,
      ids: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
      referenceCounts: {
        ['a'.repeat(64)]: 1,
        ['b'.repeat(64)]: 1,
        ['c'.repeat(64)]: 1
      }
    })
    // One pass over the chat store per scan.
    expect(mocks.forEachStoredChatRecord).toHaveBeenCalledTimes(1)

    // The next scan reads again instead of reusing the previous scan's records.
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(mocks.forEachStoredChatRecord).toHaveBeenCalledTimes(2)
    expect(mocks.updateReferenceSnapshot).toHaveBeenCalledTimes(2)

    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('loads each project canvas storage key from the canonical project registry', async () => {
    localStorage.setItem(
      'magicpot.projects.v1',
      JSON.stringify([
        {
          id: 'project-a',
          name: 'Project A',
          createdAt: 1,
          updatedAt: 2,
          canvasStorageKey: 'canvas-storage-a'
        }
      ])
    )
    mocks.forEachStoredChatRecord.mockResolvedValue(undefined)
    mocks.loadCanvasItems.mockResolvedValue({ items: [] })
    mocks.updateReferenceSnapshot.mockResolvedValue(undefined)

    const stop = startManagedMediaReferenceScanner()
    await vi.advanceTimersByTimeAsync(2_000)

    expect(mocks.loadCanvasItems).toHaveBeenCalledWith('canvas-storage-a')
    expect(mocks.updateReferenceSnapshot).toHaveBeenCalledWith({
      version: 1,
      complete: true,
      ids: [],
      referenceCounts: {}
    })

    stop()
  })
})
