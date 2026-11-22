import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ root: '' }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.root } }) }))
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { getAssistantWorkspaceState } from '../assistantRuntime/workspace'
import { getAssistantSessionKey } from '../assistantRuntime/types'
import { readSkillWorkspaceRecord } from './workspaceRecord'
const roots: string[] = [], route = { channel: 'canvas', scopeType: 'thread', scopeId: 'project', threadId: 'pane' } as const
const signal = () => new AbortController().signal
async function fixture() {
  h.root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'skill-workspace-'))); roots.push(h.root)
  const runtime = new AssistantRuntime(), fallback = getAssistantWorkspaceState(route)
  const put = async (file: string, value: unknown) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)) }
  const snapshot = (workspaceId: string) => ({ sessionKey: getAssistantSessionKey(route), route, workspaceId, generatedAt: Date.now() })
  return { runtime, fallback, put, snapshot }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
describe('main-only read-only skill hint workspace identity', () => {
  it('resolves only the same default workspace as file tools without creating it or metadata', async () => {
    const t = await fixture(), write = vi.spyOn(fs, 'writeFile'), mkdir = vi.spyOn(fs, 'mkdir'), remove = vi.spyOn(fs, 'rm')
    expect(await t.runtime.resolveSkillHintWorkspace(route, signal())).toBe(t.fallback.workspaceRootDir)
    expect(write).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
    await expect(fs.stat(t.fallback.workspaceRootDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('requires exact route attachment and current shared metadata for a nondefault snapshot', async () => {
    const t = await fixture(), workspace = getAssistantWorkspaceState(route, 'explicit-shared')
    await t.put(t.fallback.contextFile, t.snapshot('explicit-shared'))
    await expect(t.runtime.resolveSkillHintWorkspace(route, signal())).rejects.toThrow('missing')
    await t.put(workspace.workspaceMetaFile, { workspaceId: workspace.workspaceId, status: 'active', accessMode: 'shared', attachedSessionKeys: [getAssistantSessionKey(route)] })
    expect(await t.runtime.resolveSkillHintWorkspace(route, signal())).toBe(workspace.workspaceRootDir)
    await t.put(workspace.workspaceMetaFile, { workspaceId: workspace.workspaceId, status: 'active', accessMode: 'shared', attachedSessionKeys: ['foreign'] })
    await expect(t.runtime.resolveSkillHintWorkspace(route, signal())).rejects.toThrow('not attached')
    await t.put(t.fallback.contextFile, { ...t.snapshot('explicit-shared'), sessionKey: 'foreign' })
    await expect(t.runtime.resolveSkillHintWorkspace(route, signal())).rejects.toThrow('invalid')
  })
  it('refuses stale/oversized identity records without deleting or migrating them', async () => {
    const t = await fixture(); await t.put(t.fallback.contextFile, { ...t.snapshot(t.fallback.workspaceId), generatedAt: Date.now() - 8 * 86400000 })
    await expect(t.runtime.resolveSkillHintWorkspace(route, signal())).rejects.toThrow('stale')
    const oversized = 'x'.repeat(32769); await fs.writeFile(t.fallback.contextFile, oversized)
    await expect(t.runtime.resolveSkillHintWorkspace(route, signal())).rejects.toThrow('unavailable')
    expect(await fs.readFile(t.fallback.contextFile, 'utf8')).toBe(oversized)
    const c = new AbortController(); c.abort(); await expect(t.runtime.resolveSkillHintWorkspace(route, c.signal)).rejects.toThrow()
  })
  it('does not follow linked/hardlinked record files and enforces record bounds', async () => {
    const t = await fixture(), file = path.join(h.root, 'outside.json'); await t.put(file, { test: true })
    await fs.mkdir(path.dirname(t.fallback.contextFile), { recursive: true }); await fs.link(file, t.fallback.contextFile)
    await expect(t.runtime.resolveSkillHintWorkspace(route, signal())).rejects.toThrow('unavailable')
    await expect(readSkillWorkspaceRecord(file, 65537, signal())).rejects.toThrow('bounds')
  })
})
