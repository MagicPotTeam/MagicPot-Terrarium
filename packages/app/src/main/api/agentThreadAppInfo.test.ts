import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { AGENT_APP_LIMITS, AGENT_APP_DOCUMENT_SCHEMA } from '@shared/api/agentThreadApp'
import { HTML_APP_INPUT_SCHEMA } from '@shared/api/agentThreadHtml'
import { describeThreadApp } from './agentThreadAppCatalog'
import { createAgentThreadToolProvider } from './agentThreadTools'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'app-manual', threadId: 'pane' } as const
const context = () => ({ route, runId: 'app-manual-run', toolCallId: 'app-manual-call' })
const setup = (html = false, channel = true) => {
  const request = vi.fn(async () => ({ status: 'dismissed' as const })), assertLive = vi.fn(), assertInvocation = vi.fn()
  const htmlApp = vi.fn(async () => ({ app: { id: 'not-a-permit', status: 'ready' }, awaitingUserOpen: true, grantsPermission: false }))
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), dispose = vi.fn()
  let tools: Tool[] = []
  const listVisibleTools = vi.fn(() => tools)
  const provider = createAgentThreadToolProvider({ route, messages: [{ role: 'user', content: 'PRIVATE_APP_PARENT_NOT_DOCUMENTATION' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never,
    ...(html ? { htmlApp } : {}), ...(channel ? { interactions: { request, assertLive, dispose, signal: new AbortController().signal } } : {}) })
  tools = provider.listTools()
  return { provider, request, htmlApp, listVisibleTools, assertInvocation, setVisible: (next: Tool[]) => { tools = next }, callbacks: [request, assertLive, htmlApp, describeSkill, invokeSkill, skillContext, dispose] }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown> = { name: 'show_app' }) =>
  JSON.parse((await provider.callTool('info', args, context())).content)
const fake = (name: string, inputSchema: unknown = { type: 'object', properties: {} }): Tool => ({ name, description: 'Self-described full HTML availability is not a capability or a manual', inputSchema: inputSchema as Tool['inputSchema'] })
const noCallbacks = (callbacks: ReturnType<typeof setup>['callbacks']) => { for (const callback of callbacks) expect(callback).not.toHaveBeenCalled() }

describe('visible-only passive local show_app manuals without starting displays or HTML', () => {
  it.each([false, true])('documents the actual advertised show_app modes, HTML=%s, without changing their schemas', async html => {
    const { provider, callbacks } = setup(html), actual = provider.listTools().find(tool => tool.name === 'show_app')!
    const result = await info(provider)
    expect(result).toMatchObject({ ...actual, grantsPermission: false, documentation: {
      contract: 'magicpot-local-app-manual/v1', name: 'show_app', documentationOnly: true, grantsPermission: false,
      mode: html ? 'declarative-and-html' : 'declarative',
      authority: { readingUnlocksTool: false, answersGrantPermission: false, htmlEventsGrantPermission: false, checksRuntimeReadiness: false }
    } })
    expect(result.inputSchema).toEqual(actual.inputSchema)
    expect(result.documentation.declarative.limits).toMatchObject({ documentUtf8Bytes: AGENT_APP_LIMITS.bytes, blocks: 12, fields: 8, textAnswerUtf16Units: 2000, totalTextAnswerUtf16Units: 8000, callsPerRequest: 3, pendingDisplaysGlobal: 8 })
    expect(result.documentation.declarative.timeout).toEqual({ parameter: 'timeout_seconds', defaultSeconds: 300, minimumSeconds: 1, maximumSeconds: 600, integer: true })
    expect(result.documentation.relatedTools).toEqual(['ask_user', 'show_card', 'info'])
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(Buffer.byteLength(JSON.stringify(result.documentation), 'utf8')).toBeLessThan(10000)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_APP_PARENT_NOT_DOCUMENTATION')
    expect(await info(provider, { kind: 'tool', name: 'show_app' })).toEqual(result)
    if (!html) expect(result.documentation).not.toHaveProperty('html')
    noCallbacks(callbacks)
  })
  it('describes declarative exact field answers, no-field explicit submit, privacy and cancel without executing anything', async () => {
    const { provider, callbacks } = setup(), manual = (await info(provider)).documentation
    expect(manual.declarative.input).toContain('document')
    expect(manual.declarative.input).toContain('plain text')
    for (const text of ['all declared fields', 'even optional', '{}', 'explicit Submit', 'Closing the dialog']) expect(manual.declarative.feedback).toContain(text)
    for (const text of ['one pending', '64', 'current document', 'one-shot', 'timers']) expect(manual.declarative.lifecycle).toContain(text)
    for (const text of ['selected model', 'not secret', 'not arbitrary']) expect(manual.privacy).toContain(text)
    expect(manual.authority.rule).toContain('formal approval')
    expect(manual.declarative.feedback).toContain('never authorization')
    expect(manual.parity).toContain('not full upstream')
    noCallbacks(callbacks)
  })
  it('describes HTML prerequisites and non-authorizing state/event receipts rather than claiming it is ready or seen', async () => {
    const { provider, callbacks } = setup(true), manual = (await info(provider)).documentation
    expect(manual.html.limits).toMatchObject({ titleUtf16Units: 120, htmlUtf8Bytes: 262144, dataUtf8Bytes: 65536, stateUtf8Bytes: 65536, callsPerRequest: 12, retainedPerScope: 4, retainedGlobal: 32, lifetimeMs: 900000, queuedEvents: 16, inputIntervalMs: 5000 })
    expect(manual.html.timeout).toEqual({ parameter: 'timeout_s', defaultSeconds: 300, minimumSeconds: 1, maximumSeconds: 300, integer: true })
    for (const text of ['Windows', 'verified', 'encrypted', 'user', 'not a readiness check']) expect(manual.html.availability).toContain(text)
    for (const text of ['ready', 'awaitingUserOpen', 'not seen', 'unknown']) expect(manual.html.result).toContain(text)
    for (const text of ['read', 'expectedRevision', 'patch always', 'exactly once', 'wait-only', 'no reload']) expect(manual.html.operations).toContain(text)
    for (const text of ['kt.ready', 'kt.data', 'kt.send', 'kt.state', 'auxiliary-host acceptance', 'not click causality', 'not disk', 'no kt.openLink']) expect(manual.html.bridge).toContain(text)
    for (const text of ['no external', 'inline', 'separate window', 'not approval']) expect(manual.html.boundary).toContain(text)
    noCallbacks(callbacks)
  })
  it.each([false, true])('deep-detaches manuals, preserves compact listings and unrelated tool/helper results, HTML=%s', async html => {
    const { provider, callbacks, setVisible } = setup(html), actual = provider.listTools().find(tool => tool.name === 'show_app')!
    setVisible([actual, fake('info'), fake('unrelated')])
    const result = await info(provider), original = structuredClone(result)
    expect(result.documentation.relatedTools).toEqual(['info'])
    result.documentation.workflow[0] = 'MUTATED'
    result.documentation.authority.readingUnlocksTool = true
    result.documentation.declarative.limits.callsPerRequest = 1000
    result.documentation.declarative.timeout.defaultSeconds = 1
    result.documentation.relatedTools.push('shell.execute')
    if (html) result.documentation.html.limits.htmlUtf8Bytes = 1
    result.inputSchema.properties.document.properties.title.maxLength = 1
    expect(await info(provider)).toEqual(original)
    expect(await info(provider, {})).toEqual({ tools: [actual, fake('info'), fake('unrelated')].map(({ name, description }) => ({ name, description })), grantsPermission: false })
    expect(await info(provider, { name: 'unrelated' })).toEqual({ ...fake('unrelated'), grantsPermission: false })
    await expect(info(provider, { kind: 'subagent', name: 'show_app' })).rejects.toThrow('not available')
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    noCallbacks(callbacks)
  })
  it.each([false, true])('info consumes neither declarative display nor HTML callback attempts, HTML=%s', async html => {
    const { provider, request, htmlApp, callbacks } = setup(html)
    for (let index = 0; index < 16; index++) await info(provider)
    noCallbacks(callbacks)
    const document = { title: 'Existing display', blocks: [{ kind: 'text', text: 'Untrusted feedback, not approval' }] }
    for (let index = 0; index < 3; index++) await provider.callTool('show_app', { document }, context())
    await expect(provider.callTool('show_app', { document }, context())).rejects.toThrow('display limit')
    expect(request).toHaveBeenCalledTimes(3)
    if (html) {
      const args = { title: 'Existing HTML path', html: '<p>Not opened</p>' }, signal = new AbortController().signal
      await provider.callTool('show_app', args, { ...context(), signal })
      expect(htmlApp).toHaveBeenCalledExactlyOnceWith(args, signal, 'app-manual-call')
    } else expect(htmlApp).not.toHaveBeenCalled()
  })
  it.each(['SHOW_APP', 'show_app ', '../show_app', 'ui.apps:show_app', 'ui:quiz', 'constructor', '__proto__', 'search_memory', 'scratchpad'])('never invents an app manual from alias, path, plugin or removed name %s', async name => {
    const { provider, setVisible, callbacks } = setup(true)
    setVisible([fake(name)])
    expect(await info(provider, { name })).toEqual({ ...fake(name), grantsPermission: false })
    setVisible([])
    await expect(info(provider, { name })).rejects.toThrow('not available')
    noCallbacks(callbacks)
  })
  it('fails closed on unknown, partially combined, broadened or duplicate show_app schemas, without trusting descriptions', async () => {
    const { provider, setVisible, callbacks } = setup(true), actual = provider.listTools().find(tool => tool.name === 'show_app')!
    const base = { type: 'object', properties: { document: AGENT_APP_DOCUMENT_SCHEMA, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 } }, required: ['document'], additionalProperties: false }
    const changed = structuredClone(actual); Reflect.set((changed.inputSchema as { properties: object }).properties, 'execute', { type: 'boolean' })
    const candidates = [fake('show_app'), fake('show_app', HTML_APP_INPUT_SCHEMA), fake('show_app', { ...base, additionalProperties: true }), fake('show_app', { ...base, oneOf: [base] }), changed]
    for (const candidate of candidates) {
      setVisible([candidate])
      expect(await info(provider)).toEqual({ ...candidate, grantsPermission: false })
    }
    setVisible([actual, structuredClone(actual)])
    expect(await info(provider)).toEqual({ ...actual, grantsPermission: false })
    setVisible([fake('show_app', actual.inputSchema)])
    expect((await info(provider)).documentation.mode).toBe('declarative-and-html')
    noCallbacks(callbacks)
  })
  it.each([false, true])('cannot unlock unavailable show_app even with an HTML callback, HTML=%s', async html => {
    const { provider, callbacks, setVisible } = setup(html, false)
    expect(provider.listTools().some(tool => tool.name === 'show_app')).toBe(false)
    await expect(info(provider)).rejects.toThrow('not available')
    await expect(provider.callTool('show_app', {}, context())).rejects.toThrow('outside')
    setVisible([])
    await expect(info(provider)).rejects.toThrow('not available')
    noCallbacks(callbacks)
  })
  it.each([{ name: 'show_app', execute: true }, { name: 'show_app', approved: true }, { name: 'show_app', paths: ['x.ts'] }, { name: 'show_app', offset: 0 }, { kind: 'plugin', name: 'ui.apps:show_app' }])('rejects unsupported or authority-like info selectors %j', async args => {
    const { provider, callbacks } = setup(true)
    await expect(info(provider, args)).rejects.toThrow()
    noCallbacks(callbacks)
  })
  it.each([false, true])('independently gates the direct catalog and detaches every nested branch, HTML=%s', html => {
    const { provider, callbacks } = setup(html), actual = provider.listTools().find(tool => tool.name === 'show_app')!
    const tools = [actual, fake('info'), fake('ask_user'), fake('show_card')]
    const direct = describeThreadApp('show_app', tools)!
    expect(direct).toBeDefined()
    const original = structuredClone(direct)
    expect(describeThreadApp('show_app', [])).toBeUndefined()
    expect(describeThreadApp('SHOW_APP', tools)).toBeUndefined()
    expect(describeThreadApp('constructor', [fake('constructor', actual.inputSchema)])).toBeUndefined()
    expect(describeThreadApp('show_app', [actual, actual])).toBeUndefined()
    direct.workflow[0] = 'DIRECT MUTATION'
    expect(Reflect.set(direct.authority, 'checksRuntimeReadiness', true)).toBe(true)
    expect(Reflect.set(direct.declarative.limits, 'callsPerRequest', 999)).toBe(true)
    expect(Reflect.set(direct.declarative.timeout, 'defaultSeconds', 1)).toBe(true)
    direct.relatedTools.push('info')
    if (direct.html) expect(Reflect.set(direct.html.limits, 'stateUtf8Bytes', 1)).toBe(true)
    expect(describeThreadApp('show_app', tools)).toEqual(original)
    expect(actual.inputSchema).toEqual(provider.listTools().find(tool => tool.name === 'show_app')!.inputSchema)
    noCallbacks(callbacks)
  })
  it('rejects nonpassive direct schemas without invoking getters, toJSON, coercion or mutating actual schemas', () => {
    const { provider } = setup(true), schema = provider.listTools().find(tool => tool.name === 'show_app')!.inputSchema
    const hook = vi.fn(() => { throw new Error('MODEL_SCHEMA_HOOK_MUST_NOT_RUN') })
    const getter = Object.defineProperty({}, 'properties', { get: hook, enumerable: true })
    const hidden = Object.defineProperty(structuredClone(schema), 'hidden', { value: true })
    const symbol = Object.assign(structuredClone(schema) as object, { [Symbol('not-json')]: true })
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    let deep: unknown = {}; for (let index = 0; index < 40; index++) deep = { child: deep }
    const huge = Array.from({ length: 4100 }, () => true)
    const arrayExtras = structuredClone(schema) as { oneOf: object }; Reflect.set(arrayExtras.oneOf, 'extra', true)
    const custom = Object.assign(Object.create({ inherited: true }), schema)
    const nullPrototype = Object.assign(Object.create(null), schema)
    for (const candidate of [null, undefined, true, 1, 'show_app', [], getter, hidden, symbol, cycle, deep, huge, custom, nullPrototype, arrayExtras, { toJSON: hook }, new String('show_app'), { valueOf: hook }, { ...schema as object, default: NaN }]) {
      expect(describeThreadApp('show_app', [fake('show_app', candidate)])).toBeUndefined()
    }
    expect(hook).not.toHaveBeenCalled()
    expect(describeThreadApp('show_app', [fake('show_app', schema)])?.mode).toBe('declarative-and-html')
  })
  it.each([false, true])('describes exactly the supported current schema even if key order or description changes, HTML=%s', html => {
    const { provider } = setup(html), actual = provider.listTools().find(tool => tool.name === 'show_app')!
    const reversed = Object.fromEntries(Object.entries(actual.inputSchema as object).reverse())
    expect(describeThreadApp('show_app', [fake('show_app', reversed)])?.mode).toBe(html ? 'declarative-and-html' : 'declarative')
    const changed = structuredClone(actual.inputSchema) as { properties: { document: { properties: { title: { maxLength: number } } } } }
    changed.properties.document.properties.title.maxLength++
    expect(describeThreadApp('show_app', [fake('show_app', changed)])).toBeUndefined()
  })
  it('gates HTML documentation on the actual visible schema, never on an otherwise present HTML callback', async () => {
    const { provider, callbacks, setVisible } = setup(true), declarative = setup().provider.listTools().find(tool => tool.name === 'show_app')!
    setVisible([declarative])
    const result = await info(provider)
    expect(result.documentation.mode).toBe('declarative')
    expect(result.documentation).not.toHaveProperty('html')
    expect(result.documentation.relatedTools).toEqual([])
    noCallbacks(callbacks)
  })
  it('checks abort, foreign scope, invocation and late cancellation before passive lookup; no timers or callbacks', async () => {
    const { provider, listVisibleTools, assertInvocation, callbacks } = setup(true), expired = new AbortController()
    expired.abort()
    const timer = vi.spyOn(globalThis, 'setTimeout')
    try {
      await expect(provider.callTool('info', { name: 'show_app' }, { ...context(), signal: expired.signal })).rejects.toThrow()
      await expect(provider.callTool('info', { name: 'show_app' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
      expect(listVisibleTools).not.toHaveBeenCalled()
      const late = new AbortController()
      listVisibleTools.mockImplementation(() => { late.abort(); return provider.listTools() })
      await expect(provider.callTool('info', { name: 'show_app' }, { ...context(), signal: late.signal })).rejects.toThrow()
      listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('request ended') }); return provider.listTools() })
      await expect(info(provider)).rejects.toThrow('request ended')
      expect(timer).not.toHaveBeenCalled()
      noCallbacks(callbacks)
    } finally { timer.mockRestore() }
  })
})
