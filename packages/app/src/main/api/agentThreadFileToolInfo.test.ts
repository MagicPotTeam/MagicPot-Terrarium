import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { describeThreadFileTool } from './agentThreadFileToolCatalog'
import { createAgentThreadToolProvider } from './agentThreadTools'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'manual-project', threadId: 'pane' } as const
const context = () => ({ route, runId: 'manual-run', toolCallId: 'manual-call' })
const names = ['files.edit', 'files.patch', 'files.multi-edit'] as const
const tool = (name: string): Tool => ({ name, description: `Current admitted ${name}`, inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } } } })
const setup = (initial: Tool[] = names.map(tool)) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), contextSkill = vi.fn(), htmlApp = vi.fn(), request = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_PARENT_TEXT_NOT_DOCUMENTATION' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: contextSkill } as never,
    htmlApp, interactions: { request, assertLive: vi.fn(), dispose: vi.fn(), signal: new AbortController().signal } })
  return { provider, assertInvocation, listVisibleTools, callbacks: [describeSkill, invokeSkill, contextSkill, htmlApp, request], setVisible: (next: Tool[]) => { tools = next } }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) => JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only passive file mutation manuals', () => {
  it.each(names)('loads a local manual for the admitted exact name %s', async name => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name })
    expect(result).toMatchObject({ ...tool(name), grantsPermission: false, documentation: {
      contract: 'magicpot-local-file-mutation-manual/v1', name,
      documentationOnly: true, grantsPermission: false,
      limits: { fileBytes: 1048576, diffBytes: 262144, runtimeMs: 10000 },
      authority: { readingUnlocksTool: false, requiresFreshApproval: true, restoresAuthority: false },
      failure: { automaticRetry: false, receiptIsAuthority: false }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(JSON.stringify(result.documentation)).not.toContain('PRIVATE_PARENT_TEXT_NOT_DOCUMENTATION')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(await info(provider, { kind: 'tool', name })).toEqual(result)
  })
  it('retains default listings, ordinary unknown manuals and helper selectors without injecting bodies', async () => {
    const { provider } = setup([...names.map(tool), tool('files.read')])
    expect(await info(provider, {})).toEqual({ tools: [...names, 'files.read'].map(name => ({ name, description: `Current admitted ${name}` })), grantsPermission: false })
    expect(await info(provider, { name: 'files.read' })).toEqual({ ...tool('files.read'), grantsPermission: false })
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    for (const name of names) await expect(info(provider, { kind: 'subagent', name })).rejects.toThrow('not available')
  })
  it('separates ordered one-file, complete-file patch and distinct-file batch semantics', async () => {
    const { provider } = setup()
    const edit = (await info(provider, { name: 'files.edit' })).documentation
    expect(edit.behavior).toMatchObject({ defaultMode: 'strict', modes: { strict: expect.stringContaining('unchanged'), partial: expect.stringContaining('still fails'), best_effort: expect.stringContaining('failed') } })
    expect(edit.behavior.matching).toContain('expectedOccurrences')
    expect(edit.behavior.noChange).toContain('snapshot and rename')
    expect(edit.behavior.report).toContain('MAGIC_AGENT_FILES_EDIT_FAILED')
    const patch = (await info(provider, { name: 'files.patch' })).documentation
    expect(patch.limits).toMatchObject({ patchBytes: 262144, hunks: 1 })
    expect(patch.behavior.ranges).toContain('complete current before text')
    expect(patch.behavior.limitations).toContain('CRLF byte-roundtrip is not guaranteed')
    const batch = (await info(provider, { name: 'files.multi-edit' })).documentation
    expect(batch.limits).toMatchObject({ files: 32, replacementsPerFile: 100 })
    expect(batch.behavior.scope).toContain('not upstream same-file multi_edit')
    expect(batch.behavior.ordering).toContain('no cross-file atomic isolation')
    expect(batch.behavior.rollback).toContain('remains failed')
  })
  it('only advertises currently visible related tools, with independent detached copies', async () => {
    const { provider, setVisible } = setup([tool('files.edit'), tool('files.read')])
    const result = await info(provider, { name: 'files.edit' })
    expect(result.documentation.relatedTools).toEqual(['files.read'])
    expect(Buffer.byteLength(JSON.stringify(result.documentation), 'utf8')).toBeLessThan(10000)
    result.documentation.workflow[0] = 'MUTATED'; result.documentation.authority.readingUnlocksTool = true
    result.documentation.limits.fileBytes = 99; result.documentation.relatedTools.push('files.snapshot.restore')
    const fresh = await info(provider, { name: 'files.edit' })
    expect(fresh.documentation.workflow[0]).not.toBe('MUTATED')
    expect(fresh.documentation.authority.readingUnlocksTool).toBe(false)
    expect(fresh.documentation.limits.fileBytes).toBe(1048576)
    expect(fresh.documentation.relatedTools).toEqual(['files.read'])
    setVisible([tool('files.edit'), tool('files.snapshot.restore')])
    expect((await info(provider, { name: 'files.edit' })).documentation.relatedTools).toEqual(['files.snapshot.restore'])
    setVisible([])
    await expect(info(provider, { name: 'files.edit' })).rejects.toThrow('not available')
    expect(describeThreadFileTool('files.edit', [])).toBeUndefined()
    expect(describeThreadFileTool('__proto__', [tool('__proto__')])).toBeUndefined()
  })
  it.each(['files.edit', 'files.patch', 'files.multi-edit', 'edit', 'multi_edit', 'FILES.EDIT', 'files.edit ', '../files.edit', 'ui:quiz', 'plugin:secret', '__proto__', 'constructor', 'search_memory', 'scratchpad'])(
    'cannot disclose an unadmitted name or fallback manual %s', async name => {
      const { provider, callbacks } = setup([])
      await expect(info(provider, { name })).rejects.toThrow('not available')
      for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    }
  )
  it.each([{ kind: 'plugin', name: 'ui:quiz' }, { kind: 'tool', name: 'files.edit', paths: ['x.ts'] }, { name: 'files.patch', offset: 0 }, { name: 'files.edit', execute: true }, { name: 'files.edit', confirm: true }])(
    'rejects unsupported selectors and authority-like manual arguments %j', async args => {
      const { provider, callbacks } = setup()
      await expect(info(provider, args)).rejects.toThrow()
      for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    }
  )
  it('checks cancellation, route and admission before lookup and again before manual publication', async () => {
    const { provider, listVisibleTools, assertInvocation } = setup()
    const cancelled = new AbortController(); cancelled.abort()
    await expect(provider.callTool('info', { name: 'files.edit' }, { ...context(), signal: cancelled.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'files.edit' }, { ...context(), route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return names.map(tool) })
    await expect(provider.callTool('info', { name: 'files.edit' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('request ended') }); return names.map(tool) })
    await expect(info(provider, { name: 'files.patch' })).rejects.toThrow('request ended')
  })
})
