import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.mock('electron', () => ({ app: { isReady: () => false }, utilityProcess: { fork: () => { throw new Error('No real fork') } } }))
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createSqlitePreviewUtility } from './sqlitePreviewUtility'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('SQLite utility fixed launch and cleanup', () => {
  it('uses verified entry and private operation directory, releases only after child exit', async () => {
    const root = mkdtempSync(path.resolve('../../.magicpot-trash/p5-utility-mock-')); roots.push(root)
    const events = new EventEmitter()
    const child = { postMessage: vi.fn(), kill: vi.fn(), on: (name: string, listener: (value: unknown) => void) => { events.on(name, listener) }, removeAllListeners: () => { events.removeAllListeners() } }
    const fork = vi.fn((_entry: string, _args: string[], _settings: Electron.ForkOptions) => child), verifyAssets = vi.fn(() => '/fixed/verified-entry.cjs')
    const utility = createSqlitePreviewUtility(root, { isReady: () => true, appRoot: () => '/fixed-app', verifyAssets, fork })
    expect(fork).not.toHaveBeenCalled()
    const controller = new AbortController()
    const pending = utility.run({ version: 1, requestId: 'fixture', snapshotBase64: 'YQ==', table: 'fixture', columns: ['id'], limit: 1 }, controller.signal)
    expect(verifyAssets).toHaveBeenCalledExactlyOnceWith('/fixed-app')
    const [, args, settings] = fork.mock.calls[0]
    expect(args).toHaveLength(1)
    expect(existsSync(args[0])).toBe(true)
    expect(Object.keys(settings.env ?? {})).not.toContain('CODEX_HOME')
    expect(settings.env).toMatchObject({ LANG: 'C' })
    controller.abort()
    expect(existsSync(args[0])).toBe(true)
    events.emit('exit', 1)
    await expect(pending).rejects.toThrow()
    expect(existsSync(args[0])).toBe(false)
    expect(utility.isOccupied()).toBe(false)
  })
})
