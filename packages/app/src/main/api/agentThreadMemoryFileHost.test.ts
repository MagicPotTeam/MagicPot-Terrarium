import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryFileSession, type MemoryFileHostOptions } from './agentThreadMemoryFileHost'
import { getAssistantWorkspaceState } from '../assistantRuntime/workspace'

vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ data: '' }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-project', threadId: 'pane' } as const
let root: string, parent: AbortController
const sessions: Array<{ close(): void }> = []
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-memory-files-fixture-')); h.data = fs.realpathSync.native(root); parent = new AbortController() })
afterEach(() => { parent.abort(); for (const s of sessions.splice(0)) s.close(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
function fixture(writable = true, childRunId = 'child-memory-one') {
  const approve = vi.fn<MemoryFileHostOptions['approve']>(async () => vi.fn<() => void>()), durable = vi.fn<MemoryFileHostOptions['durable']>(async (provider, args, context) => provider.callTool('memory.files.write', args, context))
  const assertLive = vi.fn(() => parent.signal.throwIfAborted())
  const session = createMemoryFileSession({ route, conversationId: 'memory-conversation', writable, childRunId, parentRunId: 'parent-run', parentToolCallId: `parent-call-${childRunId}`, signal: parent.signal, assertLive, approve, durable })
  sessions.push(session)
  const call = (name: string, args: Record<string, unknown>, modelStep = 1) => session.callTool(`memory.files.${name}`, args, { route, runId: childRunId, toolCallId: `${childRunId}-${modelStep}`, signal: parent.signal, modelStep })
  return { session, call, approve, durable, assertLive }
}
describe('MAIN-owned persistent memory-file namespace, not notes or general workspace files', () => {
  it('missing memory is explicitly empty without creating any directory or touching daily logs', async () => {
    const f = fixture(false)
    expect(JSON.parse((await f.call('tree', { path: './memory' })).content)).toMatchObject({ path: './memory', entries: [], namespaceExists: false })
    expect(JSON.parse((await f.call('read', { path: './memory/facts.md' })).content)).toMatchObject({ path: './memory/facts.md', exists: false })
    expect(fs.readdirSync(root)).toEqual([]); expect(f.approve).not.toHaveBeenCalled()
  })
  it('formal-approved create/update persists actual files with complete read-before-write, not sqlite notes', async () => {
    const workspace = getAssistantWorkspaceState(route)
    fs.mkdirSync(workspace.memoryDir, { recursive: true }); fs.writeFileSync(workspace.memoryFile, 'EXISTING_DAILY_LOG_NEVER_OVERWRITE')
    const f = fixture()
    await expect(f.call('write', { path: './memory/facts.md', content: 'unsafe', create: true }, 1)).rejects.toThrow(/read before/)
    await f.call('read', { path: './memory/facts.md' }, 1)
    await expect(f.call('write', { path: './memory/facts.md', content: 'same-step', create: true }, 1)).rejects.toThrow(/later model step/)
    const saved = JSON.parse((await f.call('write', { path: './memory/facts.md', content: 'FIRST_FACT_原始🌱', create: true }, 2)).content)
    expect(saved).toMatchObject({ path: './memory/facts.md', written: true, created: true })
    expect(f.approve).toHaveBeenCalledOnce(); expect(f.durable).toHaveBeenCalledOnce()
    expect(f.approve.mock.calls[0][0]).toMatchObject({ content: 'FIRST_FACT_原始🌱', create: true, preimage: null, conversationId: 'memory-conversation' })
    const second = fixture(true, 'child-memory-two')
    const read = JSON.parse((await second.call('read', { path: './memory/facts.md' }, 1)).content)
    expect(read).toMatchObject({ content: 'FIRST_FACT_原始🌱', exists: true, complete: true })
    await second.call('write', { path: './memory/facts.md', content: 'UPDATED_FACT', create: false }, 2)
    expect(JSON.parse((await fixture(false, 'child-memory-three').call('read', { path: './memory/facts.md' })).content).content).toBe('UPDATED_FACT')
    expect(fs.readFileSync(workspace.memoryFile, 'utf8')).toBe('EXISTING_DAILY_LOG_NEVER_OVERWRITE')
    expect((await f.call('tree', { path: './memory' })).content).not.toContain('.owner')
  })
  it.each(['D:/private/file.md', '/etc/passwd', '../daily.md', './memory/../daily.md', './memory/a\\b.md', '//server/share/file', './memory/con.md', './memory/file:stream', './memory/.owner.json'])('rejects unsafe path %s before approval or writes', async path => {
    const f = fixture()
    await expect(f.call('read', { path })).rejects.toThrow(/path|reserved/)
    await expect(f.call('write', { path, content: 'x', create: true }, 2)).rejects.toThrow(/path|reserved/)
    expect(f.approve).not.toHaveBeenCalled(); expect(fs.readdirSync(root)).toEqual([])
  })
  it('does not borrow another child receipt or overwrite a changed preimage during approval', async () => {
    const first = fixture(), second = fixture(true, 'other-child')
    await first.call('read', { path: './memory/facts.md' }, 1)
    await expect(second.call('write', { path: './memory/facts.md', content: 'borrow', create: true }, 2)).rejects.toThrow(/read before/)
    await first.call('write', { path: './memory/facts.md', content: 'original', create: true }, 2)
    const reader = fixture(true, 'stale-reader'), competitor = fixture(true, 'other-writer')
    await reader.call('read', { path: './memory/facts.md' }, 1); await competitor.call('read', { path: './memory/facts.md' }, 1)
    reader.approve.mockImplementationOnce(async () => { await competitor.call('write', { path: './memory/facts.md', content: 'competing', create: false }, 2); return vi.fn<() => void>() })
    await expect(reader.call('write', { path: './memory/facts.md', content: 'stale', create: false }, 2)).rejects.toThrow(/changed|conflict/)
    expect(JSON.parse((await fixture(false, 'final-read').call('read', { path: './memory/facts.md' })).content).content).toBe('competing')
  })
  it('Stop or scope revocation during approval prevents the first filesystem mutation', async () => {
    const f = fixture(); await f.call('read', { path: './memory/new.md' }, 1)
    f.approve.mockImplementationOnce(async () => { parent.abort(new Error('Parent stopped')); return vi.fn<() => void>() })
    await expect(f.call('write', { path: './memory/new.md', content: 'never', create: true }, 2)).rejects.toThrow('Parent stopped')
    expect(fs.readdirSync(root)).toEqual([])
  })
  it('captures exact proposed content before the approval await and does not adopt a recreated namespace', async () => {
    const f = fixture(); await f.call('read', { path: './memory/new.md' }, 1)
    const args = { path: './memory/new.md', content: 'APPROVED_ORIGINAL', create: true }
    f.approve.mockImplementationOnce(async () => { args.content = 'MUTATED_REPLACEMENT'; return vi.fn<() => void>() })
    await f.call('write', args, 2)
    const workspace = getAssistantWorkspaceState(route), old = path.join(workspace.memoryDir, '.agent-memory-v1'), moved = old + '-moved'
    fs.renameSync(old, moved); fs.mkdirSync(old)
    await expect(f.call('read', { path: './memory/new.md' }, 3)).rejects.toThrow(/changed|identity|owner|review/)
    fs.rmdirSync(old); fs.renameSync(moved, old)
    expect(JSON.parse((await fixture(false, 'content-reader').call('read', { path: './memory/new.md' })).content).content).toBe('APPROVED_ORIGINAL')
  })
  it('rejects full snapshot capacity before another approval and leaves the namespace readable without a writer lock', async () => {
    const seed = fixture(); await seed.call('read', { path: './memory/facts.md' }, 1); await seed.call('write', { path: './memory/facts.md', content: 'retained', create: true }, 2)
    const namespace = path.join(getAssistantWorkspaceState(route).memoryDir, '.agent-memory-v1'), snapshots = path.join(namespace, '.snapshots')
    for (let index = fs.readdirSync(snapshots).length; index < 64; index++) fs.writeFileSync(path.join(snapshots, `capacity-${index}.json`), '{}')
    const next = fixture(true, 'capacity-writer'); await next.call('read', { path: './memory/facts.md' }, 1)
    await expect(next.call('write', { path: './memory/facts.md', content: 'never', create: false }, 2)).rejects.toThrow(/snapshots.*full|capacity/)
    expect(next.approve).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(namespace, '.writer-lock'))).toBe(false)
    expect(JSON.parse((await fixture(false, 'quota-reader').call('read', { path: './memory/facts.md' })).content).content).toBe('retained')
  })
  it('cleans up an exclusively owned lock when its fsync fails before any other effect', async () => {
    const seed = fixture(); await seed.call('read', { path: './memory/facts.md' }, 1); await seed.call('write', { path: './memory/facts.md', content: 'retained', create: true }, 2)
    const next = fixture(true, 'sync-writer'); await next.call('read', { path: './memory/facts.md' }, 1)
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('Synthetic lock sync failure') })
    await expect(next.call('write', { path: './memory/facts.md', content: 'never', create: false }, 2)).rejects.toThrow('Synthetic lock sync failure')
    sync.mockRestore()
    const namespace = path.join(getAssistantWorkspaceState(route).memoryDir, '.agent-memory-v1')
    expect(fs.existsSync(path.join(namespace, '.writer-lock'))).toBe(false)
    expect(JSON.parse((await fixture(false, 'sync-reader').call('read', { path: './memory/facts.md' })).content).content).toBe('retained')
  })
  it('classifies failed post-result lock cleanup as unknown rather than ordinary failure or definite cancellation', async () => {
    const seed = fixture(); await seed.call('read', { path: './memory/facts.md' }, 1); await seed.call('write', { path: './memory/facts.md', content: 'retained', create: true }, 2)
    const next = fixture(true, 'cleanup-writer'); await next.call('read', { path: './memory/facts.md' }, 1)
    const unlink = fs.unlinkSync.bind(fs)
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => { if (String(file).endsWith('.writer-lock')) throw new Error('Synthetic lock unlink failure'); return unlink(file) })
    await expect(next.call('write', { path: './memory/facts.md', content: 'already committed', create: false }, 2)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
    const namespace = path.join(getAssistantWorkspaceState(route).memoryDir, '.agent-memory-v1')
    expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe('already committed')
    expect(fs.existsSync(path.join(namespace, '.writer-lock'))).toBe(true)
  })
  it('persistent lock descriptor close failure after commit stays unknown without a second cleanup error masking it', async () => {
    const seed = fixture(); await seed.call('read', { path: './memory/facts.md' }, 1); await seed.call('write', { path: './memory/facts.md', content: 'retained', create: true }, 2)
    const next = fixture(true, 'close-writer'); await next.call('read', { path: './memory/facts.md' }, 1)
    const open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs)
    let lockFd: number | undefined
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => { const fd = open(file, flags, mode); if (String(file).endsWith('.writer-lock') && flags === 'wx') lockFd = fd; return fd })
    const failing = vi.spyOn(fs, 'closeSync').mockImplementation(fd => { if (fd === lockFd) throw new Error('Persistent synthetic lock close failure'); return close(fd) })
    try {
      await expect(next.call('write', { path: './memory/facts.md', content: 'committed before close', create: false }, 2)).rejects.toMatchObject({ code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
      const namespace = path.join(getAssistantWorkspaceState(route).memoryDir, '.agent-memory-v1')
      expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe('committed before close')
      expect(fs.existsSync(path.join(namespace, '.writer-lock'))).toBe(true)
    } finally { failing.mockRestore(); if (lockFd !== undefined) close(lockFd) }
  })
  it('uses bounded directory iteration instead of materializing an entire namespace/snapshot directory', async () => {
    const seed = fixture(); await seed.call('read', { path: './memory/facts.md' }, 1); await seed.call('write', { path: './memory/facts.md', content: 'retained', create: true }, 2)
    const namespace = path.join(getAssistantWorkspaceState(route).memoryDir, '.agent-memory-v1'), snapshots = path.join(namespace, '.snapshots')
    const readdir = fs.readdirSync.bind(fs)
    const unbounded = vi.spyOn(fs, 'readdirSync').mockImplementation(((file: fs.PathLike, options: unknown) => {
      if (String(file) === namespace || String(file) === snapshots) throw new Error('Unbounded memory enumeration')
      return readdir(file, options as never)
    }) as typeof fs.readdirSync)
    const reader = fixture(false, 'bounded-reader')
    expect(JSON.parse((await reader.call('tree', { path: './memory' })).content).entries).toEqual(['./memory/facts.md'])
    expect(unbounded).not.toHaveBeenCalled(); unbounded.mockRestore()
  })
  it('known sanitized-route collision and unowned existing namespace fail closed without adoption', () => {
    const workspace = getAssistantWorkspaceState(route)
    fs.mkdirSync(workspace.memoryDir, { recursive: true }); fs.writeFileSync(workspace.contextFile, JSON.stringify({ sessionKey: 'different', route: { ...route, threadId: 'sibling' }, workspaceId: 'workspace' }))
    expect(() => fixture()).toThrow(/owner|route|collision/)
    fs.unlinkSync(workspace.contextFile); fs.mkdirSync(path.join(workspace.memoryDir, '.agent-memory-v1'))
    expect(() => fixture()).toThrow(/owner|review|namespace/)
  })
})
