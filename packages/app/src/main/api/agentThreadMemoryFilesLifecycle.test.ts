import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendAssistantMemoryLog, clearAssistantReusableContext, getAssistantWorkspaceState } from '../assistantRuntime/workspace'
import { createMemoryFileSession } from './agentThreadMemoryFileHost'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ data: '' }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-retention-project', threadId: 'pane' } as const
let temp: string
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-memory-retention-fixture-')); h.data = fs.realpathSync.native(temp) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(temp, { recursive: true, force: true }) })
describe('persistent memory-file lifecycle is separate from disposable runtime context', () => {
  it('routine reusable-context clear keeps approved memory namespace, owner incarnation, recovery files and pinned ancestors unchanged', async () => {
    const workspace = getAssistantWorkspaceState(route), namespace = path.join(workspace.memoryDir, '.agent-memory-v1')
    const session = createMemoryFileSession({ route, conversationId: 'retention-conversation', writable: true, childRunId: 'retention-child', parentRunId: 'retention-parent', parentToolCallId: 'retention-call', signal: new AbortController().signal, assertLive: () => undefined, approve: async () => () => undefined, durable: (provider, args, context) => provider.callTool('memory.files.write', args, context) })
    const context = { route, runId: 'retention-child', toolCallId: 'read-before-clear', modelStep: 1 }
    await session.callTool('memory.files.read', { path: './memory/facts.md' }, context)
    await session.callTool('memory.files.write', { path: './memory/facts.md', content: 'APPROVED_PERSISTENT_MEMORY', create: true }, { ...context, toolCallId: 'write-before-clear', modelStep: 2 })
    const marker = fs.readFileSync(path.join(namespace, '.owner.json')), snapshots = fs.readdirSync(path.join(namespace, '.snapshots'))
    const snapshotBytes = snapshots.map(name => fs.readFileSync(path.join(namespace, '.snapshots', name)))
    const parentId = fs.statSync(workspace.memoryDir, { bigint: true }).ino, namespaceId = fs.statSync(namespace, { bigint: true }).ino
    fs.writeFileSync(workspace.memoryFile, 'DISPOSABLE_DAILY_LOG'); fs.writeFileSync(path.join(workspace.memoryDir, '1999-01-01.md'), 'OLDER_DAILY_LOG'); fs.mkdirSync(path.join(workspace.memoryDir, 'legacy-reusable')); fs.writeFileSync(path.join(workspace.memoryDir, 'legacy-reusable', 'old.txt'), 'legacy context')
    fs.writeFileSync(workspace.contextFile, '{}'); fs.writeFileSync(workspace.taskContextFile, 'task'); fs.writeFileSync(workspace.pinnedContextFile, 'pinned')
    await clearAssistantReusableContext(workspace)
    expect(fs.existsSync(path.join(namespace, 'facts.md'))).toBe(true)
    expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe('APPROVED_PERSISTENT_MEMORY')
    expect(fs.readFileSync(path.join(namespace, '.owner.json'))).toEqual(marker)
    expect(fs.readdirSync(path.join(namespace, '.snapshots'))).toEqual(snapshots)
    expect(snapshots.map(name => fs.readFileSync(path.join(namespace, '.snapshots', name)))).toEqual(snapshotBytes)
    expect([workspace.contextFile, workspace.taskContextFile, workspace.pinnedContextFile, path.join(workspace.memoryDir, '1999-01-01.md')].some(file => fs.existsSync(file))).toBe(false)
    expect(fs.statSync(workspace.memoryDir, { bigint: true }).ino).toBe(parentId); expect(fs.statSync(namespace, { bigint: true }).ino).toBe(namespaceId)
    expect(fs.existsSync(workspace.memoryFile)).toBe(false); expect(fs.existsSync(path.join(workspace.memoryDir, 'legacy-reusable'))).toBe(false)
    await expect(session.callTool('memory.files.read', { path: './memory/facts.md' }, { ...context, modelStep: 3 })).rejects.toThrow(/binding.*changed|disappeared/)
    session.close()
    const reopened = createMemoryFileSession({ route, conversationId: 'retention-conversation', writable: false, childRunId: 'reopened-child', parentRunId: 'reopened-parent', parentToolCallId: 'reopened-call', signal: new AbortController().signal, assertLive: () => undefined, approve: async () => () => undefined, durable: (provider, args, execution) => provider.callTool('memory.files.write', args, execution) })
    try { expect(JSON.parse((await reopened.callTool('memory.files.read', { path: './memory/facts.md' }, { route, runId: 'reopened-child', toolCallId: 'reopened-read', modelStep: 1 })).content).content).toBe('APPROVED_PERSISTENT_MEMORY') }
    finally { reopened.close() }
    await appendAssistantMemoryLog(workspace, { title: 'DAILY_AFTER_CLEAR', status: 'completed', requestText: 'new daily request' })
    expect(fs.readdirSync(workspace.memoryDir).sort()).toEqual(['.agent-memory-v1', path.basename(workspace.memoryFile)].sort())
    expect(fs.readFileSync(workspace.memoryFile, 'utf8')).toContain('DAILY_AFTER_CLEAR')
    expect(fs.readFileSync(path.join(namespace, '.owner.json'))).toEqual(marker)
    expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe('APPROVED_PERSISTENT_MEMORY')
    expect(fs.statSync(workspace.memoryDir, { bigint: true }).ino).toBe(parentId)
  })
  it('a review-locked owned namespace survives clear and a fresh helper still rejects, while missing namespaces are never adopted', async () => {
    const workspace = getAssistantWorkspaceState(route), namespace = path.join(workspace.memoryDir, '.agent-memory-v1')
    const open = () => createMemoryFileSession({ route, conversationId: 'review-retention', writable: true, childRunId: 'review-child', parentRunId: 'review-parent', parentToolCallId: 'review-call', signal: new AbortController().signal, assertLive: () => undefined, approve: async () => () => undefined, durable: (provider, input, context) => provider.callTool('memory.files.write', input, context) })
    const seed = open(), context = { route, runId: 'review-child', toolCallId: 'read', modelStep: 1 }
    await seed.callTool('memory.files.read', { path: './memory/facts.md' }, context)
    await seed.callTool('memory.files.write', { path: './memory/facts.md', content: 'REVIEW_LOCKED_MEMORY', create: true }, { ...context, toolCallId: 'write', modelStep: 2 }); seed.close()
    const marker = fs.readFileSync(path.join(namespace, '.owner.json'))
    fs.writeFileSync(path.join(namespace, '.writer-lock'), 'UNKNOWN_RESULT')
    await clearAssistantReusableContext(workspace)
    expect(fs.readFileSync(path.join(namespace, '.owner.json'))).toEqual(marker)
    expect(fs.readFileSync(path.join(namespace, '.writer-lock'), 'utf8')).toBe('UNKNOWN_RESULT')
    expect(() => open()).toThrow(/writer|review/)
    const missing = getAssistantWorkspaceState({ ...route, threadId: 'missing' })
    fs.mkdirSync(missing.memoryDir, { recursive: true }); fs.writeFileSync(missing.memoryFile, 'daily only')
    const memoryId = fs.statSync(missing.memoryDir, { bigint: true }).ino
    await clearAssistantReusableContext(missing)
    expect(fs.readdirSync(missing.memoryDir)).toEqual([]); expect(fs.statSync(missing.memoryDir, { bigint: true }).ino).toBe(memoryId)
  })
  it('preserves reserved entries opaquely, including malformed owner state and Windows case variants', async () => {
    const workspace = getAssistantWorkspaceState(route), spelling = process.platform === 'win32' ? '.AgEnT-MeMoRy-V1' : '.agent-memory-v1', namespace = path.join(workspace.memoryDir, spelling)
    fs.mkdirSync(namespace, { recursive: true }); fs.writeFileSync(path.join(namespace, '.owner.json'), '{malformed owner'); fs.writeFileSync(path.join(namespace, 'facts.md'), 'UNOWNED_DO_NOT_ADOPT')
    const directory = fsp.opendir.bind(fsp), forbidden = vi.spyOn(fsp, 'opendir').mockImplementation((async (...args: Parameters<typeof fsp.opendir>) => {
      if (String(args[0]).toLowerCase() === namespace.toLowerCase()) throw new Error('Routine cleanup must not inspect persistent contents')
      return directory(...args)
    }) as typeof fsp.opendir)
    await clearAssistantReusableContext(workspace)
    expect(fs.readFileSync(path.join(namespace, '.owner.json'), 'utf8')).toBe('{malformed owner'); expect(fs.readFileSync(path.join(namespace, 'facts.md'), 'utf8')).toBe('UNOWNED_DO_NOT_ADOPT')
    expect(forbidden).toHaveBeenCalledOnce(); expect(String(forbidden.mock.calls[0][0]).toLowerCase()).toBe(workspace.memoryDir.toLowerCase())
  })
  it('routine clear never erases unknown-outcome writer locks or adopts an unowned namespace', async () => {
    const workspace = getAssistantWorkspaceState(route), namespace = path.join(workspace.memoryDir, '.agent-memory-v1')
    fs.mkdirSync(namespace, { recursive: true }); fs.writeFileSync(path.join(namespace, '.writer-lock'), 'UNKNOWN_OUTCOME_REQUIRES_REVIEW')
    await clearAssistantReusableContext(workspace)
    expect(fs.existsSync(path.join(namespace, '.writer-lock'))).toBe(true)
    expect(fs.readFileSync(path.join(namespace, '.writer-lock'), 'utf8')).toBe('UNKNOWN_OUTCOME_REQUIRES_REVIEW')
    expect(fs.existsSync(path.join(namespace, '.owner.json'))).toBe(false)
  })
})
