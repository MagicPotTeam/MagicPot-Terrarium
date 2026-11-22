import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { buildAssistantContextSnapshot, clearAssistantReusableContext, getAssistantWorkspaceState, persistAssistantContextSnapshot, readAssistantContextSnapshotFromFile } from '../assistantRuntime/workspace'
import { acquireMemoryFileBindingLease, memoryFileBindingLockPath, readMemoryFileBindingRecord } from '../assistantRuntime/memoryFileBinding'
import { createMemoryFileSession } from './agentThreadMemoryFileHost'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ data: '' }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'binding-revalidation', threadId: 'pane' } as const
let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-memory-revalidation-fixture-')); h.data = fs.realpathSync.native(root) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })
async function fixture() {
  const workspace = getAssistantWorkspaceState(route), snapshot = buildAssistantContextSnapshot(route, structuredClone(DEFAULT_CONFIG))
  fs.mkdirSync(workspace.memoryDir, { recursive: true })
  await persistAssistantContextSnapshot(workspace, snapshot)
  return { workspace, snapshot }
}
describe('participating MAIN binding lease and durable incarnation interleavings, isolated fixture files only', () => {
  it('revalidates expired context under the lease instead of deleting a fresh committed replacement from an earlier observation', async () => {
    const { workspace, snapshot } = await fixture()
    const stale = JSON.stringify({ ...snapshot, generatedAt: Date.now() - 8 * 86400000 })
    fs.writeFileSync(workspace.contextFile, stale)
    const read = fsp.readFile.bind(fsp)
    let replaced = false
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: Parameters<typeof fsp.readFile>) => {
      if (!replaced && String(args[0]) === workspace.contextFile) {
        replaced = true
        // Return the already-observed stale bytes after a separate MAIN refresh
        // has fully published its fresh context + durable incarnation.
        await persistAssistantContextSnapshot(workspace, { ...snapshot, generatedAt: Date.now(), outputDir: 'fresh-replacement' })
        return stale
      }
      return read(...args)
    }) as typeof fsp.readFile)
    expect(await readAssistantContextSnapshotFromFile(workspace.contextFile)).toMatchObject({ outputDir: 'fresh-replacement' })
    spy.mockRestore()
    expect(JSON.parse(fs.readFileSync(workspace.contextFile, 'utf8')).outputDir).toBe('fresh-replacement')
    expect(readMemoryFileBindingRecord(workspace)).toMatchObject({ present: true })
    expect(fs.existsSync(memoryFileBindingLockPath(workspace))).toBe(false)
  })
  it('a live lease rejects another context writer and cleanup without deleting memory or changing the incumbent context', async () => {
    const { workspace, snapshot } = await fixture(), original = fs.readFileSync(workspace.contextFile), incarnation = readMemoryFileBindingRecord(workspace)
    const lease = acquireMemoryFileBindingLease(workspace)
    try {
      await expect(persistAssistantContextSnapshot(workspace, { ...snapshot, workspaceId: 'different' })).rejects.toThrow(/binding.*writer|review/)
      await expect(clearAssistantReusableContext(workspace)).rejects.toThrow(/binding.*writer|review/)
      expect(fs.readFileSync(workspace.contextFile)).toEqual(original); expect(readMemoryFileBindingRecord(workspace)).toEqual(incarnation)
    } finally { lease.release() }
  })
  it('known atomic context rename failure preserves both previous authoritative files, releases its lease and permits a later refresh', async () => {
    const { workspace, snapshot } = await fixture(), original = fs.readFileSync(workspace.contextFile), incarnation = readMemoryFileBindingRecord(workspace)
    const rename = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('Synthetic known context publication failure'))
    await expect(persistAssistantContextSnapshot(workspace, { ...snapshot, workspaceId: 'never-committed' })).rejects.toThrow('Synthetic known context publication failure')
    rename.mockRestore()
    expect(fs.readFileSync(workspace.contextFile)).toEqual(original); expect(readMemoryFileBindingRecord(workspace)).toEqual(incarnation)
    expect(fs.existsSync(memoryFileBindingLockPath(workspace))).toBe(false)
    await persistAssistantContextSnapshot(workspace, { ...snapshot, outputDir: 'later-success' })
    expect(readMemoryFileBindingRecord(workspace)?.revision).toBe(incarnation?.revision)
  })
  it('transient lock lookup after context publication remains unknown and cannot release its review lease', async () => {
    const { workspace, snapshot } = await fixture(), incarnation = readMemoryFileBindingRecord(workspace), stat = fs.lstatSync.bind(fs)
    let injected = false
    const lookup = vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      if (!injected && String(args[0]) === memoryFileBindingLockPath(workspace) && JSON.parse(fs.readFileSync(workspace.contextFile, 'utf8')).workspaceId === 'published-before-transient-lookup') {
        injected = true
        throw Object.assign(new Error('Synthetic transient binding lock lookup failure'), { code: 'EIO' })
      }
      return stat(...args)
    }) as typeof fs.lstatSync)
    await expect(persistAssistantContextSnapshot(workspace, { ...snapshot, workspaceId: 'published-before-transient-lookup' })).rejects.toMatchObject({ code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
    lookup.mockRestore()
    expect(injected).toBe(true); expect(readMemoryFileBindingRecord(workspace)).toEqual(incarnation)
    expect(JSON.parse(fs.readFileSync(workspace.contextFile, 'utf8')).workspaceId).toBe('published-before-transient-lookup')
    expect(fs.existsSync(memoryFileBindingLockPath(workspace))).toBe(true)
    await expect(persistAssistantContextSnapshot(workspace, snapshot)).rejects.toThrow(/binding.*writer|review/)
  })
  it('indeterminate incarnation publication after a committed context retains a review lease, never automatic adoption', async () => {
    const { workspace, snapshot } = await fixture(), incarnation = readMemoryFileBindingRecord(workspace)
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('Synthetic incarnation result uncertainty') })
    await expect(persistAssistantContextSnapshot(workspace, { ...snapshot, workspaceId: 'context-was-committed' })).rejects.toMatchObject({ code: 'TOOL_EXECUTION_OUTCOME_UNKNOWN' })
    rename.mockRestore()
    expect(JSON.parse(fs.readFileSync(workspace.contextFile, 'utf8')).workspaceId).toBe('context-was-committed')
    expect(readMemoryFileBindingRecord(workspace)).toEqual(incarnation)
    expect(fs.existsSync(memoryFileBindingLockPath(workspace))).toBe(true)
    expect(() => createMemoryFileSession({ route, conversationId: 'revalidation', writable: false, childRunId: 'never-start', parentRunId: 'parent', parentToolCallId: 'call', signal: new AbortController().signal, assertLive: () => undefined, approve: async () => () => undefined, durable: (provider, input, context) => provider.callTool('memory.files.write', input, context) })).toThrow(/binding|review/)
    await expect(clearAssistantReusableContext(workspace)).rejects.toThrow(/binding|review/)
  })
})
