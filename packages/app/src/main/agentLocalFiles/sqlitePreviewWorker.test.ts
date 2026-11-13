import { describe, expect, it, vi } from 'vitest'
const runtime = vi.hoisted(() => ({ run: vi.fn(() => ({ rows: [], nativeWorkBounded: false })) }))
vi.mock('./sqlitePreviewRuntime', () => ({ runOwnedSqliteSnapshotPreview: runtime.run }))
import { runSqlitePreviewWorker } from './sqlitePreviewWorker'

describe('SQLite child worker framing', () => {
  it('accepts one supplied frame and rejects reuse without running twice', () => {
    let deliver!: (event: { data: unknown }) => void
    const postMessage = vi.fn(), exit = vi.fn()
    runtime.run.mockClear()
    runSqlitePreviewWorker({ on: (_, listener) => { deliver = listener }, postMessage }, '/trusted-fixture', exit)
    deliver({ data: '{"fixture":true}' })
    expect(runtime.run).toHaveBeenCalledExactlyOnceWith({ fixture: true }, '/trusted-fixture')
    expect(JSON.parse(postMessage.mock.calls[0][0])).toMatchObject({ ok: true })
    deliver({ data: '{"fixture":true}' })
    expect(runtime.run).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenLastCalledWith(2)
  })
  it('emits only fixed failure without diagnostics for invalid data', () => {
    let deliver!: (event: { data: unknown }) => void
    const postMessage = vi.fn()
    runtime.run.mockClear()
    runSqlitePreviewWorker({ on: (_, listener) => { deliver = listener }, postMessage }, '/trusted-fixture', vi.fn())
    deliver({ data: { path: '/private' } })
    expect(runtime.run).not.toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledExactlyOnceWith('{"ok":false,"code":"SQLITE_PREVIEW_FAILED"}')
  })
})
