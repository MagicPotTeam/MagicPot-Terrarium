import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionKey } from '@shared/agent'
import type { AssistantRoute } from '../assistantRuntime/types'
import { buildAssistantContextSnapshot, getAssistantWorkspaceState, persistAssistantContextSnapshot } from '../assistantRuntime/workspace'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { createMemoryFileSession, type MemoryFileHostOptions } from './agentThreadMemoryFileHost'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ data: '' }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data } }) }))
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'room', threadId: 'pane' } as const
let temp: string
const sessions: Array<{ close(): void }> = []
beforeEach(() => { temp = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-memory-identity-fixture-')); h.data = fs.realpathSync.native(temp) })
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.restoreAllMocks(); fs.rmSync(temp, { recursive: true, force: true }) })
function fixture(owner: AssistantRoute = route, child = 'identity-child') {
  const approve = vi.fn<MemoryFileHostOptions['approve']>(async () => vi.fn<() => void>())
  const session = createMemoryFileSession({ route: owner, conversationId: 'identity-conversation', writable: true, childRunId: child, parentRunId: 'identity-parent', parentToolCallId: `identity-call-${child}`, signal: new AbortController().signal, assertLive: () => undefined, approve, durable: (provider, args, context) => provider.callTool('memory.files.write', args, context) })
  sessions.push(session)
  const call = (name: string, args: Record<string, unknown>, step = 1) => session.callTool(`memory.files.${name}`, args, { route: owner, runId: child, toolCallId: `identity-tool-${step}`, modelStep: step })
  return { session, call, approve }
}
async function initialContext(workspaceId = 'shared-initial') {
  const workspace = getAssistantWorkspaceState(route, workspaceId), snapshot = buildAssistantContextSnapshot(route, structuredClone(DEFAULT_CONFIG), workspaceId)
  fs.mkdirSync(workspace.memoryDir, { recursive: true }); await persistAssistantContextSnapshot(workspace, snapshot)
  return { workspace, snapshot }
}
describe('exact MAIN memory route tuple and live mapping ownership, not delimiter key or mutable daily context identity', () => {
  it('different route tuples with the same flattened key cannot read an existing namespace even without context.json', async () => {
    const other = { channel: 'canvas', scopeType: 'thread', scopeId: 'room:thread:pane' } as const
    expect(getAgentSessionKey(other)).toBe(getAgentSessionKey(route))
    const first = fixture(); await first.call('read', { path: './memory/facts.md' }); await first.call('write', { path: './memory/facts.md', content: 'EXACT_ROUTE_PRIVATE_MEMORY', create: true }, 2)
    expect(() => fixture(other, 'colliding-child')).toThrow(/owner|route|collision/)
  })
  it('a colliding context route with the same sessionKey is not treated as this route ownership', async () => {
    const { workspace, snapshot } = await initialContext()
    fs.writeFileSync(workspace.contextFile, JSON.stringify({ ...snapshot, route: { channel: 'canvas', scopeType: 'thread', scopeId: 'room:thread:pane' } }))
    expect(() => fixture()).toThrow(/owner|route|collision/)
  })
  it('captures nondefault MAIN mapping in exact approval but never retargets memory into the shared workspace', async () => {
    const { workspace } = await initialContext('shared-main-mapping')
    const f = fixture(); await f.call('read', { path: './memory/facts.md' }); await f.call('write', { path: './memory/facts.md', content: 'ACTUAL_MAPPING_MEMORY', create: true }, 2)
    expect(f.approve.mock.calls[0][0]).toMatchObject({ workspaceId: 'shared-main-mapping', routeIdentity: ['canvas', 'thread', 'room', 'pane'], namespace: path.join(workspace.memoryDir, '.agent-memory-v1') })
    expect(fs.existsSync(workspace.workspaceRootDir)).toBe(false)
  })
  it.each(['changed', 'removed', 'ABA'])('mapping %s during approval invalidates the old read before permit consumption or directory mutation', async change => {
    const { workspace, snapshot } = await initialContext()
    const f = fixture(); await f.call('read', { path: './memory/facts.md' })
    const consume = vi.fn<() => void>()
    f.approve.mockImplementationOnce(async () => {
      if (change === 'removed') fs.unlinkSync(workspace.contextFile)
      else if (change === 'changed') fs.writeFileSync(workspace.contextFile, JSON.stringify({ ...snapshot, workspaceId: 'changed-mapping' }))
      else { await persistAssistantContextSnapshot(workspace, { ...snapshot, workspaceId: 'temporary-mapping' }); await persistAssistantContextSnapshot(workspace, snapshot) }
      return consume
    })
    await expect(f.call('write', { path: './memory/facts.md', content: 'MUST_NOT_WRITE', create: true }, 2)).rejects.toThrow(/binding|mapping|owner|changed|revoked/)
    expect(consume).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(workspace.memoryDir, '.agent-memory-v1'))).toBe(false)
  })
  it('a MAIN-owned ordinary snapshot refresh is not a workspace rebind or a reason to lose an earlier-step read', async () => {
    const { workspace, snapshot } = await initialContext()
    const f = fixture(); await f.call('read', { path: './memory/facts.md' })
    f.approve.mockImplementationOnce(async () => { await persistAssistantContextSnapshot(workspace, { ...snapshot, generatedAt: snapshot.generatedAt + 1000, outputDir: 'changed-ordinary-config' }); return vi.fn<() => void>() })
    await f.call('write', { path: './memory/facts.md', content: 'BENIGN_REFRESH_OK', create: true }, 2)
    expect(fs.readFileSync(path.join(workspace.memoryDir, '.agent-memory-v1', 'facts.md'), 'utf8')).toBe('BENIGN_REFRESH_OK')
  })
  it('initially absent context does not hide a present-then-cleared mapping incarnation during approval', async () => {
    const workspace = getAssistantWorkspaceState(route), seeded = fixture(route, 'aba-seed')
    await seeded.call('read', { path: './memory/seed.md' }); await seeded.call('write', { path: './memory/seed.md', content: 'EXISTING_NAMESPACE', create: true }, 2)
    seeded.session.close()
    const f = fixture(), consume = vi.fn<() => void>()
    await f.call('read', { path: './memory/facts.md' })
    f.approve.mockImplementationOnce(async () => {
      const { clearAssistantReusableContext } = await import('../assistantRuntime/workspace')
      await persistAssistantContextSnapshot(workspace, buildAssistantContextSnapshot(route, structuredClone(DEFAULT_CONFIG), 'intervening-shared-mapping'))
      await clearAssistantReusableContext(workspace)
      return consume
    })
    await expect(f.call('write', { path: './memory/facts.md', content: 'ABSENT_ABA_MUST_NOT_WRITE', create: true }, 2)).rejects.toThrow(/binding|mapping|changed|identity/)
    expect(consume).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(workspace.memoryDir, '.agent-memory-v1', 'facts.md'))).toBe(false)
  })
  it.each(['expired', 'oversized'])('context retention (%s) cannot delete binding while a participating MAIN writer owns its lease', async kind => {
    const { workspace, snapshot } = await initialContext()
    const { readAssistantContextSnapshotFromFile } = await import('../assistantRuntime/workspace')
    const { acquireMemoryFileBindingLease } = await import('../assistantRuntime/memoryFileBinding')
    const bytes = JSON.stringify(kind === 'expired' ? { ...snapshot, generatedAt: Date.now() - 8 * 86400000 } : { ...snapshot, payload: 'x'.repeat(33000) })
    fs.writeFileSync(workspace.contextFile, bytes)
    const lease = acquireMemoryFileBindingLease(workspace)
    try {
      await expect(readAssistantContextSnapshotFromFile(workspace.contextFile)).rejects.toThrow(/binding|writer|review/)
      expect(fs.readFileSync(workspace.contextFile, 'utf8')).toBe(bytes)
    } finally { lease.release() }
  })
  it('a retained context tombstone from a colliding route is not authority to create another owner namespace', async () => {
    const { workspace } = await initialContext()
    const { clearAssistantReusableContext } = await import('../assistantRuntime/workspace')
    await clearAssistantReusableContext(workspace)
    const collision = { channel: 'canvas', scopeType: 'thread', scopeId: 'room:thread:pane' } as const
    expect(getAgentSessionKey(collision)).toBe(getAgentSessionKey(route))
    expect(fs.existsSync(workspace.contextFile)).toBe(false)
    expect(() => fixture(collision, 'tombstone-collision')).toThrow(/owner|route|collision/)
    expect(fs.existsSync(path.join(workspace.memoryDir, '.agent-memory-v1'))).toBe(false)
  })
  it('legacy key-only markers are preserved for review, never silently upgraded or adopted', () => {
    const namespace = path.join(getAssistantWorkspaceState(route).memoryDir, '.agent-memory-v1'), marker = path.join(namespace, '.owner.json')
    fs.mkdirSync(namespace, { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ version: 1, routeKey: getAgentSessionKey(route), generation: randomUUID() }))
    const original = fs.readFileSync(marker)
    expect(() => fixture()).toThrow(/owner|review/)
    expect(fs.readFileSync(marker)).toEqual(original)
  })
})
