import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, execMock, platformMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execMock: vi.fn(),
  platformMock: vi.fn<() => NodeJS.Platform>(() => 'linux')
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  exec: execMock
}))

vi.mock('node:os', () => ({
  platform: platformMock
}))

import {
  cleanupSubProcesses,
  getActiveSubProcesses,
  killSubProcess,
  spawnSubProcess
} from './subprocess'

class MockChildProcess extends EventEmitter {
  pid = 4321
  killed = false
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stdout = null
  stderr = null
  kill = vi.fn((signal: NodeJS.Signals = 'SIGTERM') => {
    // Node sets killed when a signal was sent, not when the process exits.
    this.killed = true
    if (signal === 'SIGKILL') {
      this.signalCode = signal
      this.emit('exit', null, signal)
      this.emit('close', null, signal)
    }
    return true
  })
}

function startManagedProcess(child: MockChildProcess): Promise<void> {
  spawnMock.mockReturnValue(child)
  return spawnSubProcess('test-process', { command: 'test', args: [] })
}

describe('subprocess cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    execMock.mockImplementation((_command, callback) => callback(null, { stdout: '', stderr: '' }))
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('does not treat child.killed as exit and escalates after the grace period', async () => {
    const child = new MockChildProcess()
    const spawned = startManagedProcess(child).catch(() => undefined)

    let settled = false
    const killing = killSubProcess(child.pid, 100).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(99)

    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(child.killed).toBe(true)
    expect(settled).toBe(false)
    expect(getActiveSubProcesses()).toEqual([{ pid: child.pid, name: 'test-process' }])

    await vi.advanceTimersByTimeAsync(1)
    await killing

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(getActiveSubProcesses()).toEqual([])
    await spawned
  })

  it('keeps the PID snapshot until descendant cleanup finishes', async () => {
    const child = new MockChildProcess()
    const spawned = startManagedProcess(child)
    let finishDescendantCleanup: (() => void) | undefined

    execMock.mockImplementation((command, callback) => {
      expect(command).toBe(`pkill -9 -P ${child.pid} || true`)
      finishDescendantCleanup = () => callback(null, { stdout: '', stderr: '' })
    })

    const cleanup = cleanupSubProcesses()
    await Promise.resolve()

    expect(finishDescendantCleanup).toBeTypeOf('function')
    expect(getActiveSubProcesses()).toEqual([{ pid: child.pid, name: 'test-process' }])
    expect(child.kill).not.toHaveBeenCalled()

    finishDescendantCleanup?.()
    await Promise.resolve()
    child.signalCode = 'SIGTERM'
    child.emit('exit', null, 'SIGTERM')
    child.emit('close', null, 'SIGTERM')
    await cleanup
    await spawned

    expect(getActiveSubProcesses()).toEqual([])
  })
})
