import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAssistantWorkspaceState } from '../assistantRuntime/workspace'
import { createMemoryFileSession, type MemoryFileHostOptions } from './agentThreadMemoryFileHost'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ data: '' }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-confinement', threadId: 'pane' } as const
let temp: string
const sessions: Array<{ close(): void }> = []
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-memory-confinement-fixture-')); h.data = fs.realpathSync.native(temp) })
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.restoreAllMocks(); fs.rmSync(temp, { recursive: true, force: true }) })
function fixture(child = 'safe-child', writable = true) {
  const approve = vi.fn<MemoryFileHostOptions['approve']>(async () => vi.fn<() => void>())
  const session = createMemoryFileSession({ route, conversationId: 'confinement-conversation', writable, childRunId: child, parentRunId: 'safe-parent', parentToolCallId: `safe-call-${child}`, signal: new AbortController().signal, assertLive: () => undefined, approve, durable: (provider, input, context) => provider.callTool('memory.files.write', input, context) })
  sessions.push(session)
  const call = (name: string, input: Record<string, unknown>, modelStep = 1) => session.callTool(`memory.files.${name}`, input, { route, runId: child, toolCallId: `${child}-step-${modelStep}`, modelStep })
  return { session, call, approve }
}
async function seed() {
  const f = fixture('seed'); await f.call('read', { path: './memory/facts.md' }); await f.call('write', { path: './memory/facts.md', content: 'ORIGINAL_MEMORY', create: true }, 2)
  return path.join(getAssistantWorkspaceState(route).memoryDir, '.agent-memory-v1')
}
describe('bounded real-filesystem confinement fixtures; not arbitrary-host race certification', () => {
  it('rejects a directory junction in the virtual namespace and never reads its target', async () => {
    const namespace = await seed(), outside = path.join(temp, 'fixture-only-outside')
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'private.md'), 'FIXTURE_PRIVATE_UNAVAILABLE')
    fs.symlinkSync(fs.realpathSync.native(outside), path.join(namespace, 'linked'), 'junction')
    const f = fixture('junction-reader', false)
    await expect(f.call('read', { path: './memory/linked/private.md' })).rejects.toThrow(/link|directory|canonical/)
    await expect(f.call('tree', { path: './memory' })).rejects.toThrow(/link|directory|canonical/)
    expect(fs.readFileSync(path.join(outside, 'private.md'), 'utf8')).toBe('FIXTURE_PRIVATE_UNAVAILABLE'); expect(f.approve).not.toHaveBeenCalled()
  })
  it('rejects multiply linked regular files rather than accepting a pathname or caller SHA as a read receipt', async () => {
    const namespace = await seed(), file = path.join(namespace, 'facts.md')
    fs.linkSync(file, path.join(temp, 'fixture-only-hardlink.md'))
    const f = fixture('hardlink-reader', false)
    await expect(f.call('read', { path: './memory/facts.md' })).rejects.toThrow(/regular file|link/)
    expect(f.approve).not.toHaveBeenCalled()
  })
  it('rejects invalid UTF-8, NUL and over-limit files without issuing a usable read receipt', async () => {
    const namespace = await seed(), file = path.join(namespace, 'facts.md'), f = fixture('bounded-writer')
    for (const bytes of [Buffer.from([0xff]), Buffer.from('zero\0byte'), Buffer.alloc(8193, 0x61)]) {
      fs.writeFileSync(file, bytes)
      await expect(f.call('read', { path: './memory/facts.md' })).rejects.toThrow()
      await expect(f.call('write', { path: './memory/facts.md', content: 'never', create: false }, 2)).rejects.toThrow(/read before/)
    }
    expect(f.approve).not.toHaveBeenCalled()
  })
  it('tree and grep do not grant full-read receipt authority to a writer', async () => {
    await seed(); const f = fixture('tree-only')
    await f.call('tree', { path: './memory' })
    await expect(f.call('write', { path: './memory/facts.md', content: 'never', create: false }, 2)).rejects.toThrow(/read before/)
    await expect(f.call('grep', { query: 'ORIGINAL' })).rejects.toThrow(/Unavailable|read-only/)
    expect(f.approve).not.toHaveBeenCalled()
  })
  it('an absent target appearing before approval returns is never overwritten and consumes no permit', async () => {
    const namespace = await seed(), f = fixture('absent-reader'), target = path.join(namespace, 'new.md'), consume = vi.fn<() => void>()
    await f.call('read', { path: './memory/new.md' })
    f.approve.mockImplementationOnce(async () => { fs.writeFileSync(target, 'COMPETING_FILE'); return consume })
    await expect(f.call('write', { path: './memory/new.md', content: 'never', create: true }, 2)).rejects.toThrow(/preimage|conflict/)
    expect(consume).not.toHaveBeenCalled(); expect(fs.readFileSync(target, 'utf8')).toBe('COMPETING_FILE')
  })
  it('unsupported hardlink create never falls back to rename-overwrite, and partial effects are unknown', async () => {
    const namespace = await seed(), f = fixture('unsupported-link')
    await f.call('read', { path: './memory/new.md' })
    const rename = vi.spyOn(fs, 'renameSync'), link = vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw Object.assign(new Error('Synthetic hardlink unsupported'), { code: 'ENOTSUP' }) })
    await expect(f.call('write', { path: './memory/new.md', content: 'never', create: true }, 2)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
    expect(rename).not.toHaveBeenCalled(); expect(link).toHaveBeenCalledOnce(); expect(fs.existsSync(path.join(namespace, 'new.md'))).toBe(false)
    expect(fs.existsSync(path.join(namespace, '.writer-lock'))).toBe(true)
    expect(() => fixture('post-unknown', false)).toThrow(/binding|writer|review/)
  })
  it('atomic exclusive create preserves a competitor even if it appears at the link boundary', async () => {
    const namespace = await seed(), f = fixture('no-clobber')
    await f.call('read', { path: './memory/new.md' })
    const link = fs.linkSync.bind(fs), target = path.join(namespace, 'new.md'), rename = vi.spyOn(fs, 'renameSync')
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((oldPath, newPath) => { fs.writeFileSync(newPath, 'ATOMIC_COMPETITOR'); link(oldPath, newPath) })
    await expect(f.call('write', { path: './memory/new.md', content: 'never', create: true }, 2)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
    expect(rename).not.toHaveBeenCalled(); expect(fs.readFileSync(target, 'utf8')).toBe('ATOMIC_COMPETITOR')
  })
})
