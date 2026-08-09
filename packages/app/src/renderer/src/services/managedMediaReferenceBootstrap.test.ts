import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadAllSessions: vi.fn(),
  readSessionDraftBackup: vi.fn(),
  loadCanvasItems: vi.fn(),
  updateReferenceSnapshot: vi.fn()
}))

vi.mock('../pages/ChatPage/chatStorage', () => ({
  loadAllSessions: mocks.loadAllSessions,
  readSessionDraftBackup: mocks.readSessionDraftBackup
}))

vi.mock('../pages/ProjectCanvasPage/canvasStorage', () => ({
  loadCanvasItems: mocks.loadCanvasItems
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
    mocks.loadAllSessions.mockReset()
    mocks.readSessionDraftBackup.mockReset()
    mocks.loadCanvasItems.mockReset()
    mocks.updateReferenceSnapshot.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('publishes managed references from chat sessions, draft backups, and canvas items', async () => {
    localStorage.setItem('ai_engine_projects', JSON.stringify([{ id: 'canvas-a' }]))
    mocks.loadAllSessions.mockResolvedValue([
      {
        id: 'chat-a',
        messages: [
          { role: 'assistant', content: '', attachments: [{ media: reference('a'.repeat(64)) }] }
        ]
      }
    ])
    mocks.readSessionDraftBackup.mockReturnValue({
      attachments: [{ media: reference('b'.repeat(64)) }]
    })
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
      ids: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]
    })

    stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
