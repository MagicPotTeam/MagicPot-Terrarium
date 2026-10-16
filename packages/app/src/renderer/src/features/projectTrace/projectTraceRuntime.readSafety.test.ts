import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectTraceEventSummary } from '@shared/projectTrace'

import { readRecentProjectTraceEvents } from './projectTraceRuntime'

function storedEvent(overrides: Partial<ProjectTraceEventSummary> = {}): ProjectTraceEventSummary {
  return {
    id: 'event-1',
    at: new Date().toISOString(),
    scope: 'canvas',
    action: 'canvas_items_changed',
    status: 'success',
    safeSummary: 'Moved 1 item.',
    ...overrides
  }
}

describe('projectTraceRuntime read safety', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('preserves two prior events when the history read is unavailable', () => {
    const projectId = 'project-read-only-failure'
    const storageKey = `projectTrace.recentEvents.${projectId}`
    const seededEvents = [
      storedEvent({
        id: 'event-1',
        at: new Date(Date.now() - 1000).toISOString(),
        safeSummary: 'Moved the first item.'
      }),
      storedEvent({
        id: 'event-2',
        at: new Date(Date.now() - 500).toISOString(),
        safeSummary: 'Moved the second item.'
      })
    ]
    localStorage.setItem(storageKey, JSON.stringify(seededEvents))

    expect(readRecentProjectTraceEvents(projectId)).toEqual(seededEvents)
    const persistedRaw = localStorage.getItem(storageKey)

    const originalGetItem = Storage.prototype.getItem
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === storageKey) {
        throw new Error('storage read unavailable')
      }
      return originalGetItem.call(localStorage, key)
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is read-only')
    })
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage is read-only')
    })

    let history: ProjectTraceEventSummary[] | undefined
    try {
      history = readRecentProjectTraceEvents(projectId)
    } finally {
      getItem.mockRestore()
    }

    expect(history).toEqual(seededEvents)
    expect(localStorage.getItem(storageKey)).toBe(persistedRaw)
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })
})
