import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createSqlitePreviewSupervisor } from './sqlitePreviewSupervisor'

const request = { version: 1, requestId: 'fixture', snapshotBase64: 'YQ==', table: 'fixture', columns: ['id'], limit: 1 }
function setup() {
  const events = new EventEmitter()
  const child = { postMessage: vi.fn(), kill: vi.fn(), on: (event: string, callback: (value: unknown) => void) => { events.on(event, callback) }, removeAllListeners: () => { events.removeAllListeners() } }
  const cleanup = vi.fn()
  const supervisor = createSqlitePreviewSupervisor(() => child, cleanup)
  return { events, child, supervisor, cleanup }
}
describe('SQLite child lifetime', () => {
  it.each(['cancel', 'deadline'])('never dispatches after delayed spawn following %s', async mode => {
    vi.useFakeTimers()
    try {
      const t = setup(), controller = new AbortController()
      const pending = t.supervisor.run(request, controller.signal, 100)
      expect(t.child.postMessage).not.toHaveBeenCalled()
      if (mode === 'cancel') controller.abort()
      else await vi.advanceTimersByTimeAsync(100)
      expect(t.child.kill).toHaveBeenCalledOnce()
      t.events.emit('spawn')
      expect(t.child.kill).toHaveBeenCalledTimes(2)
      expect(t.child.postMessage).not.toHaveBeenCalled()
      expect(t.cleanup).not.toHaveBeenCalled()
      t.events.emit('exit', 1)
      await expect(pending).rejects.toThrow()
      expect(t.cleanup).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it('holds result and slot until actual exit', async () => {
    const t = setup(), controller = new AbortController()
    const pending = t.supervisor.run(request, controller.signal)
    let settled = false; void pending.then(() => { settled = true })
    t.events.emit('spawn')
    expect(t.child.postMessage).toHaveBeenCalledOnce()
    t.events.emit('message', JSON.stringify({ ok: true, result: { version: 1, requestId: 'fixture', rows: [], truncated: false, returnedBytes: 2, source: 'supplied-standalone-snapshot', nativeWorkBounded: false, liveDatabaseConsistency: false } }))
    await Promise.resolve()
    expect(settled).toBe(false); expect(t.supervisor.isOccupied()).toBe(true)
    t.events.emit('exit', 0)
    expect(await pending).toMatchObject({ requestId: 'fixture' })
    expect(t.supervisor.isOccupied()).toBe(false)
  })
  it('does not release a timed-out child slot until exit', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      const pending = t.supervisor.run(request, new AbortController().signal, 100)
      await vi.advanceTimersByTimeAsync(100)
      expect(t.child.kill).toHaveBeenCalledOnce()
      expect(t.supervisor.isOccupied()).toBe(true)
      t.events.emit('exit', 1)
      await expect(pending).rejects.toThrow()
      expect(t.supervisor.isOccupied()).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('rejects child rows with unrequested fields before publication', async () => {
    const t = setup(), pending = t.supervisor.run(request, new AbortController().signal)
    t.events.emit('message', JSON.stringify({ ok: true, result: { version: 1, requestId: 'fixture', rows: [{ secret: 'unexpected' }], truncated: false, returnedBytes: 20, source: 'supplied-standalone-snapshot', nativeWorkBounded: false, liveDatabaseConsistency: false } }))
    expect(t.child.kill).toHaveBeenCalledOnce()
    t.events.emit('exit', 0)
    await expect(pending).rejects.toThrow()
  })
  it('quarantines on parent cleanup failure even after child exit', async () => {
    const t = setup()
    t.cleanup.mockImplementation(() => { throw new Error('cleanup fixture failure') })
    const pending = t.supervisor.run(request, new AbortController().signal)
    t.events.emit('exit', 1)
    await expect(pending).rejects.toThrow('quarantined')
    expect(t.supervisor.isOccupied()).toBe(true)
  })
  it('cancels and retains quarantine until native exit without publishing late responses', async () => {
    const t = setup(), controller = new AbortController()
    const pending = t.supervisor.run(request, controller.signal)
    controller.abort()
    expect(t.child.kill).toHaveBeenCalledOnce()
    expect(t.cleanup).not.toHaveBeenCalled()
    expect(t.supervisor.isOccupied()).toBe(true)
    await expect(t.supervisor.run(request, new AbortController().signal)).rejects.toThrow('active')
    t.events.emit('exit', 0)
    await expect(pending).rejects.toThrow('cancelled')
    expect(t.cleanup).toHaveBeenCalledOnce()
    expect(t.supervisor.isOccupied()).toBe(false)
  })
})
