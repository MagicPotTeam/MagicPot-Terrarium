import { beforeEach, describe, expect, it } from 'vitest'
import { clearPendingQAppRun, readPendingQAppRun, writePendingQAppRun } from './qAppPendingRun'

describe('qAppPendingRun', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('writes and reads a pending run scoped by project and quick app', () => {
    writePendingQAppRun({
      promptId: 'prompt-1',
      qAppKey: 'qapp-1',
      projectId: 'canvas-1'
    })

    expect(readPendingQAppRun('qapp-1', 'canvas-1')).toMatchObject({
      promptId: 'prompt-1',
      qAppKey: 'qapp-1',
      projectId: 'canvas-1'
    })
  })

  it('keeps different project scopes isolated', () => {
    writePendingQAppRun({
      promptId: 'prompt-1',
      qAppKey: 'qapp-1',
      projectId: 'canvas-1'
    })

    expect(readPendingQAppRun('qapp-1', 'canvas-2')).toBeNull()
  })

  it('clears a persisted pending run', () => {
    writePendingQAppRun({
      promptId: 'prompt-1',
      qAppKey: 'qapp-1',
      projectId: 'canvas-1'
    })

    clearPendingQAppRun('qapp-1', 'canvas-1')

    expect(readPendingQAppRun('qapp-1', 'canvas-1')).toBeNull()
  })
})
