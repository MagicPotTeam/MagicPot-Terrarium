import { describe, expect, it, vi } from 'vitest'
import { AGENT_LOCAL_FILE_LIMITS } from '@shared/api/svcAgentLocalFiles'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { createAgentThreadToolProvider } from './agentThreadTools'
import { describeThreadFileRead } from './agentThreadFileReadCatalog'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'read-manual', threadId: 'pane' } as const
const context = () => ({ route, runId: 'read-manual-run', toolCallId: 'read-info-call' })
// Exact current public registry schema, not an export, new tool grant or callback.
const schema = () => ({ type: 'object', additionalProperties: false, required: ['path'], properties: {
  path: { type: 'string' },
  maxBytes: { type: 'integer', minimum: 1, maximum: AGENT_LOCAL_FILE_LIMITS.documentBytes },
  maxStringLength: { type: 'integer', minimum: 1, maximum: 1048576 },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 }
} })
const tool = (name = 'files.read', inputSchema: unknown = schema()): Tool => ({ name, description: 'Description is not proof that desktop Office, images or a runtime are available', inputSchema: inputSchema as Tool['inputSchema'] })
const setup = (initial: Tool[] = [tool()]) => {
  let tools = initial
  const assertInvocation = vi.fn(), listVisibleTools = vi.fn(() => tools)
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), htmlApp = vi.fn(), request = vi.fn(), assertLive = vi.fn(), dispose = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_READ_PARENT_PATH_AND_CREDENTIAL_NOT_DOCUMENTATION' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never,
    htmlApp, interactions: { request, assertLive, dispose, signal: new AbortController().signal } })
  return { provider, listVisibleTools, assertInvocation, setVisible: (next: Tool[]) => { tools = next }, callbacks: [describeSkill, invokeSkill, skillContext, htmlApp, request, assertLive, dispose] }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown> = { name: 'files.read' }) =>
  JSON.parse((await provider.callTool('info', args, context())).content)
const noCallbacks = (callbacks: ReturnType<typeof setup>['callbacks']) => { for (const callback of callbacks) expect(callback).not.toHaveBeenCalled() }

describe('exact visible passive local files.read manual without reading or authorizing files', () => {
  it('adds only detached instructions to the exact admitted schema, without interpreting descriptions or private messages', async () => {
    const { provider, callbacks } = setup(), actual = tool()
    const result = await info(provider)
    expect(result).toMatchObject({ ...actual, grantsPermission: false, documentation: {
      contract: 'magicpot-local-file-read-manual/v1', name: 'files.read', documentationOnly: true, grantsPermission: false,
      authority: { readingUnlocksTool: false, grantsMutationPermission: false, checksRuntimeReadiness: false, selectsBackend: false },
      declaredLimits: { maxBytes: 8388608, maxStringLength: 1048576, timeoutMs: 10000, integer: true },
      failure: { automaticRetry: false, cancellationIsRollback: false, receiptIsAuthority: false }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(result.inputSchema).toEqual(schema())
    expect(JSON.stringify(result)).not.toContain('PRIVATE_READ_PARENT_PATH_AND_CREDENTIAL_NOT_DOCUMENTATION')
    expect(Buffer.byteLength(JSON.stringify(result.documentation), 'utf8')).toBeLessThan(10000)
    expect(await info(provider, { kind: 'tool', name: 'files.read' })).toEqual(result)
    noCallbacks(callbacks)
  })
  it('distinguishes conditional workspace prefix/media results and separately obtained hashes from atomic full contents or image vision', async () => {
    const { provider, callbacks } = setup(), result = await info(provider)
    expect(result.documentation).toBeDefined()
    const manual = result.documentation
    expect(manual.workspace.limits).toEqual({ fileBytes: 1048576, returnedUtf16Units: 1048576, timeoutMs: 10000 })
    for (const text of ['relative', 'workspace', 'symlink', 'policy']) expect(manual.workspace.availability).toContain(text)
    for (const text of ['fatal UTF-8', 'prefix', 'not line', 'truncated', 'split']) expect(manual.workspace.text).toContain(text)
    for (const text of ['PNG', 'JPEG', 'GIF', 'WebP', 'base64', 'not full pixel', 'not a vision']) expect(manual.workspace.images).toContain(text)
    for (const text of ['PDF', 'incomplete', 'encrypted', 'unsupportedFilters', 'not OCR', 'Office']) expect(manual.workspace.documents).toContain(text)
    for (const text of ['sha256', 'separate', 'beyond maxBytes', 'not atomic']) expect(manual.workspace.integrity).toContain(text)
    noCallbacks(callbacks)
  })
  it('documents desktop source/text bounds, no prompt but no new permission, no image support or plaintext digest', async () => {
    const { provider, callbacks } = setup(), result = await info(provider)
    expect(result.documentation).toBeDefined()
    const manual = result.documentation
    expect(manual.desktop.limits).toEqual({ ordinarySourceBytes: 1048576, documentSourceBytes: 8388608, plainTextBytes: 65536, extractedTextBytes: 65536, documentResponseBytes: 262144, timeoutMs: 10000, pendingPerSender: 1 })
    for (const text of ['MAIN', 'absolute', 'trusted', 'no per-path', 'not inferred']) expect(manual.desktop.availability).toContain(text)
    for (const text of ['64 KiB', 'whole', 'FILE_TOO_LARGE', 'TEXT_TOO_LARGE', 'no sha256', 'images reject', 'fatal UTF-8']) expect(manual.desktop.text).toContain(text)
    for (const text of ['PDF', 'DOCX', 'XLSX', 'PPTX', 'sourceSha256', 'original container', 'warnings', 'segments', 'not an OS sandbox', 'not OCR']) expect(manual.desktop.documents).toContain(text)
    for (const text of ['BUSY', 'cancel', 'navigation', 'revoke', 'native exit']) expect(manual.desktop.lifecycle).toContain(text)
    for (const text of ['hidden', 'credential', 'selected model', 'not arbitrary secret']) expect(manual.privacy).toContain(text)
    noCallbacks(callbacks)
  })
  it('does not inherit mutation approval/CAS/snapshot contracts or upstream paging and manual unlock', async () => {
    const { provider, callbacks } = setup(), result = await info(provider)
    expect(result.documentation).toBeDefined()
    const manual = result.documentation
    for (const text of ['path', 'maxBytes', 'maxStringLength', 'timeoutMs', 'No offset', 'limit', 'page']) expect(manual.input).toContain(text)
    expect(manual.authority.rule).toContain('separate formal approval')
    expect(manual.authority.rule).toContain('not read-to-edit authorization')
    expect(manual.authority).not.toHaveProperty('requiresFreshApproval')
    for (const text of ['error', 'truncated', 'incomplete', 'unknown', 'not rollback']) expect(manual.failure.rule).toContain(text)
    for (const text of ['not full upstream', 'line numbers', 'require_manual_read', 'provider/desktop/installed']) expect(manual.parity).toContain(text)
    expect(manual.workflow.join(' ')).toContain('separate explicit files.read')
    noCallbacks(callbacks)
  })
  it('keeps compact discovery and separate families unchanged, detaches result data and filters related tools by actual visibility', async () => {
    const { provider, setVisible, callbacks } = setup([tool(), tool('info', { type: 'object' }), tool('files.edit', {})])
    const result = await info(provider)
    expect(result.documentation).toBeDefined()
    const original = structuredClone(result)
    expect(result.documentation.relatedTools).toEqual(['files.edit', 'info'])
    result.documentation.workflow[0] = 'MUTATED'
    result.documentation.authority.readingUnlocksTool = true
    result.documentation.desktop.limits.plainTextBytes = 999999
    result.documentation.failure.automaticRetry = true
    result.documentation.relatedTools.push('shell.execute')
    result.inputSchema.properties.path.type = 'number'
    expect(await info(provider)).toEqual(original)
    expect(await info(provider, {})).toEqual({ tools: [tool(), tool('info', { type: 'object' }), tool('files.edit', {})].map(({ name, description }) => ({ name, description })), grantsPermission: false })
    setVisible([tool(), tool('foreign', {})])
    expect((await info(provider)).documentation.relatedTools).toEqual([])
    expect(await info(provider, { name: 'foreign' })).toEqual({ ...tool('foreign', {}), grantsPermission: false })
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    await expect(info(provider, { kind: 'subagent', name: 'files.read' })).rejects.toThrow('not available')
    noCallbacks(callbacks)
  })
  it('fails closed on unknown, broadened, partial, alias or duplicate metadata without trusting descriptive text', async () => {
    const { provider, setVisible, callbacks } = setup()
    const broadened = schema(); Reflect.set(broadened, 'additionalProperties', true)
    const changedLimit = schema(); changedLimit.properties.maxBytes.maximum++
    const partial = schema(); Reflect.deleteProperty(partial.properties, 'timeoutMs')
    for (const candidate of [tool('files.read', {}), tool('files.read', broadened), tool('files.read', changedLimit), tool('files.read', partial), tool('files.read', { ...schema(), oneOf: [schema()] })]) {
      setVisible([candidate]); expect(await info(provider)).toEqual({ ...candidate, grantsPermission: false })
    }
    setVisible([tool(), tool()]); expect(await info(provider)).toEqual({ ...tool(), grantsPermission: false })
    for (const name of ['read', 'FILES.READ', 'files.read ', '../files.read', 'plugin:read', 'constructor', '__proto__', 'search_memory', 'scratchpad']) {
      setVisible([tool(name)]); expect(await info(provider, { name })).toEqual({ ...tool(name), grantsPermission: false })
      setVisible([]); await expect(info(provider, { name })).rejects.toThrow('not available')
    }
    noCallbacks(callbacks)
  })
  it('independently gates direct helper calls and deep-detaches every mutable manual branch', () => {
    const tools = [tool(), tool('files.edit', {}), tool('info', {})]
    const direct = describeThreadFileRead('files.read', tools)!
    expect(direct).toBeDefined()
    const original = structuredClone(direct)
    expect(describeThreadFileRead('files.read', [])).toBeUndefined()
    expect(describeThreadFileRead('read', tools)).toBeUndefined()
    expect(describeThreadFileRead('constructor', [tool('constructor')])).toBeUndefined()
    expect(describeThreadFileRead('files.read', [tool(), tool()])).toBeUndefined()
    direct.workflow[0] = 'DIRECT MUTATION'
    Reflect.set(direct.authority, 'selectsBackend', true)
    Reflect.set(direct.declaredLimits, 'maxBytes', 1)
    Reflect.set(direct.desktop.limits, 'plainTextBytes', 999999)
    Reflect.set(direct.workspace.limits, 'fileBytes', 1)
    direct.desktop.documents = 'UNBOUNDED OFFICE'
    direct.workspace.integrity = 'HASH IS AUTHORITY'
    direct.failure.automaticRetry = true
    direct.relatedTools.push('files.grep')
    expect(describeThreadFileRead('files.read', tools)).toEqual(original)
    expect(tools[0].inputSchema).toEqual(schema())
  })
  it('rejects non-passive schemas without invoking getters, serialization or coercion hooks', () => {
    const hook = vi.fn(() => { throw new Error('SCHEMA_HOOK_MUST_NOT_EXECUTE') })
    const getter = Object.defineProperty({}, 'properties', { get: hook, enumerable: true })
    const hidden = Object.defineProperty(schema(), 'hidden', { value: true })
    const symbol = Object.assign(schema(), { [Symbol('not-json')]: true })
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    let deep: unknown = {}; for (let index = 0; index < 40; index++) deep = { child: deep }
    const huge = Array.from({ length: 4100 }, () => true)
    const custom = Object.assign(Object.create({ inherited: true }), schema())
    const nullPrototype = Object.assign(Object.create(null), schema())
    const arrayExtra = schema(); Reflect.set(arrayExtra.required, 'extra', true)
    for (const candidate of [null, undefined, true, 1, 'files.read', [], getter, hidden, symbol, cycle, deep, huge, custom, nullPrototype, arrayExtra, { toJSON: hook }, new String('files.read'), { valueOf: hook }, { ...schema(), default: NaN }]) {
      // Explicit undefined must not trigger tool()'s default schema.
      const candidateTool = { name: 'files.read', description: 'Not readiness', inputSchema: candidate } as Tool
      expect(describeThreadFileRead('files.read', [candidateTool])).toBeUndefined()
    }
    expect(hook).not.toHaveBeenCalled()
    expect(describeThreadFileRead('files.read', [tool()])?.contract).toBe('magicpot-local-file-read-manual/v1')
  })
  it.each(['root-prototype', 'root-ownKeys', 'nested-object', 'nested-array', 'revoked'] as const)(
    'rejects %s Proxy schema nodes before running any reflective trap', kind => {
      const trap = vi.fn(() => { throw new Error('PROXY_TRAP_MUST_NOT_RUN') })
      let candidate: unknown
      if (kind === 'root-prototype') candidate = new Proxy(schema(), { getPrototypeOf: trap })
      else if (kind === 'root-ownKeys') candidate = new Proxy(schema(), { ownKeys: trap })
      else if (kind === 'nested-object') {
        const nested = schema(); nested.properties.path = new Proxy(nested.properties.path, { getPrototypeOf: trap }); candidate = nested
      } else if (kind === 'nested-array') {
        const nested = schema(); nested.required = new Proxy(nested.required, { ownKeys: trap }); candidate = nested
      } else {
        const revoked = Proxy.revocable(schema(), { getPrototypeOf: trap }); revoked.revoke(); candidate = revoked.proxy
      }
      expect(describeThreadFileRead('files.read', [tool('files.read', candidate)])).toBeUndefined()
      expect(trap).not.toHaveBeenCalled()
      expect(describeThreadFileRead('files.read', [tool()])?.name).toBe('files.read')
    }
  )
  it('matches exact schema values independent of property order and never caches visibility', () => {
    const known = schema()
    const reordered = Object.fromEntries(Object.entries(known).reverse())
    expect(describeThreadFileRead('files.read', [tool('files.read', reordered)])?.name).toBe('files.read')
    expect(describeThreadFileRead('files.read', [{ ...tool(), description: 'Text only, not desktop' }])).toEqual(describeThreadFileRead('files.read', [tool()]))
    const changedType = schema(); changedType.properties.timeoutMs.type = 'number'
    const changedRequired = schema(); changedRequired.required.push('execute')
    for (const changed of [changedType, changedRequired]) expect(describeThreadFileRead('files.read', [tool('files.read', changed)])).toBeUndefined()
    expect(describeThreadFileRead('files.read', [])).toBeUndefined()
    expect(describeThreadFileRead('files.read', [tool()])?.authority.selectsBackend).toBe(false)
  })
  it.each([{ kind: 'plugin', name: 'files.read' }, { name: 'files.read', path: 'private.txt' }, { name: 'files.read', offset: 0 }, { name: 'files.read', execute: true }, { name: 'files.read', approved: true }])(
    'rejects unsupported manual selectors and authority-like data %j', async args => {
      const { provider, callbacks } = setup()
      await expect(info(provider, args)).rejects.toThrow()
      noCallbacks(callbacks)
    }
  )
  it('checks current route and cancellation before lookup and again before publication', async () => {
    const { provider, listVisibleTools, assertInvocation, callbacks } = setup()
    const cancelled = new AbortController(); cancelled.abort()
    await expect(provider.callTool('info', { name: 'files.read' }, { ...context(), signal: cancelled.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'files.read' }, { ...context(), route: { ...route, threadId: 'other' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return [tool()] })
    await expect(provider.callTool('info', { name: 'files.read' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('ended request') }); return [tool()] })
    await expect(info(provider)).rejects.toThrow('ended request')
    noCallbacks(callbacks)
  })
})
