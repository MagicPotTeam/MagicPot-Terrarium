import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createSqlitePreviewScratchOwner } from './sqlitePreviewScratchOwner'
import { createSqlitePreviewSupervisor } from './sqlitePreviewSupervisor'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
describe('parent snapshot cleanup after child termination', () => {
  it('retains sensitive copy until exit then removes it even though child finally never ran', async () => {
    const root = mkdtempSync(path.resolve('../../.magicpot-trash/p5-parent-cleanup-')); roots.push(root)
    const owner = createSqlitePreviewScratchOwner(root)
    const nested = path.join(owner.directory, 'sqlite-preview-synthetic')
    mkdirSync(nested); writeFileSync(path.join(nested, 'snapshot.sqlite'), 'synthetic sensitive fixture')
    const events = new EventEmitter(), controller = new AbortController()
    const child = { postMessage: vi.fn(), kill: vi.fn(), on: (name: string, listener: (value: unknown) => void) => { events.on(name, listener) }, removeAllListeners: () => { events.removeAllListeners() } }
    const supervisor = createSqlitePreviewSupervisor(() => child, owner.cleanupAfterExit)
    const pending = supervisor.run({ version: 1, requestId: 'fixture', snapshotBase64: 'YQ==', table: 'fixture', columns: ['id'], limit: 1 }, controller.signal)
    controller.abort()
    expect(existsSync(owner.directory)).toBe(true)
    expect(supervisor.isOccupied()).toBe(true)
    events.emit('exit', 1)
    await expect(pending).rejects.toThrow()
    expect(existsSync(owner.directory)).toBe(false)
    expect(supervisor.isOccupied()).toBe(false)
    owner.cleanupAfterExit()
  })
})
