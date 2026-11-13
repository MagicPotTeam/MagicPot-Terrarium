import { describe, expect, it, vi } from 'vitest'
import type { AssistantRunToolProvider } from '../assistantRuntime/types'
import { AGENT_THREAD_INTERACTION_LIMITS as LIMITS } from '@shared/api/agentThreadInteraction'
import { describeThreadInteractionTool } from './agentThreadInteractionCatalog'
import { createAgentThreadToolProvider } from './agentThreadTools'

type Tool = ReturnType<AssistantRunToolProvider['listTools']>[number]
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'interaction-manual', threadId: 'pane' } as const
const context = () => ({ route, runId: 'manual-run', toolCallId: 'manual-call' })
const names = ['ask_user', 'show_card'] as const
const tool = (name: string): Tool => ({ name, description: `Visible ${name}`, inputSchema: { type: 'object', properties: {} } })
const setup = (withChannel = true) => {
  const request = vi.fn(), assertLive = vi.fn(), assertInvocation = vi.fn()
  const describeSkill = vi.fn(), invokeSkill = vi.fn(), skillContext = vi.fn(), htmlApp = vi.fn()
  let tools: Tool[] = []
  const listVisibleTools = vi.fn(() => tools)
  const provider = createAgentThreadToolProvider({
    route, messages: [{ role: 'user', content: 'PRIVATE_PARENT_NOT_A_MANUAL' }], assertInvocation, listVisibleTools,
    skills: { describe: describeSkill, invoke: invokeSkill, context: skillContext } as never, htmlApp,
    ...(withChannel ? { interactions: { request, assertLive, dispose: vi.fn(), signal: new AbortController().signal } } : {})
  })
  tools = provider.listTools()
  return { provider, request, assertLive, assertInvocation, listVisibleTools, setVisible: (next: Tool[]) => { tools = next }, callbacks: [request, assertLive, describeSkill, invokeSkill, skillContext, htmlApp] }
}
const info = async (provider: ReturnType<typeof setup>['provider'], args: Record<string, unknown>) =>
  JSON.parse((await provider.callTool('info', args, context())).content)

describe('visible-only passive local interaction manuals', () => {
  it('documents formatting-only body Markdown as passive bounded display, not HTML, resources, controls or permission', async () => {
    const { provider, callbacks } = setup(), result = await info(provider, { name: 'show_card' })
    expect(result.description).toContain('formatting-only Markdown body')
    for (const text of ['formatting-only Markdown', '4000', '1024', '24', 'entities', 'plain-text fallback', 'no links', 'no images', 'no task controls', 'title', 'raw stored/model-bound']) expect(result.documentation.behavior.bodyMarkdown).toContain(text)
    expect(result.inputSchema.properties.body).toEqual({ type: 'string', maxLength: LIMITS.body }); expect(result.documentation.grantsPermission).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('documents bounded decorative icon text without input, status or formalapproval grants', async () => {
    const { provider, callbacks } = setup(), result = await info(provider, { name: 'show_card' })
    expect(result.inputSchema.properties.icon).toEqual({ type: 'string', maxLength: 64 })
    expect(result.documentation.limits).toMatchObject({ iconSchemaCharacters: 64, iconUtf16Units: 64 })
    expect(result.documentation.behavior.input).toContain('icon')
    expect(result.documentation.behavior.historyDisplay).toContain('decorative')
    expect(result.documentation.behavior.choices).toContain('icon')
    expect(result.documentation.grantsPermission).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('documents only three non-link action styles without starting input or authorizing execution', async () => {
    const { provider, callbacks } = setup(), result = await info(provider, { name: 'show_card' })
    expect(result.inputSchema.properties.actions.items.properties.style).toEqual({ type: 'string', enum: ['primary', 'secondary', 'danger'] })
    expect(result.documentation.limits).toMatchObject({ actionStyles: ['primary', 'secondary', 'danger'] })
    expect(result.documentation.behavior.choices).toContain('action style')
    expect(result.documentation.behavior.choices).toContain('never approval')
    expect(result.documentation.grantsPermission).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('describes only the six visual card accents without unlocking input, success status or formal approval', async () => {
    const { provider, callbacks } = setup(), result = await info(provider, { name: 'show_card' })
    const accents = ['primary', 'info', 'success', 'warning', 'danger', 'neutral']
    expect(result.inputSchema).toMatchObject({ properties: { accent: { type: 'string', enum: accents } } })
    expect(result.documentation.limits).toMatchObject({ accents })
    expect(result.documentation.behavior.input).toContain('accent')
    expect(result.documentation.behavior.choices).toContain('accent')
    expect(result.documentation.behavior.historyDisplay).toContain('visual hint')
    expect(result.documentation.grantsPermission).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('describes bounded plain-text footer context and both serialization guards without issuing input or authority', async () => {
    const { provider, callbacks } = setup(), result = await info(provider, { name: 'show_card' })
    expect(result.inputSchema).toMatchObject({ properties: { footer: { type: 'string', maxLength: 200 } } })
    expect(result.documentation.limits).toMatchObject({ footerSchemaCharacters: 200, footerUtf16Units: 200 })
    expect(result.documentation.behavior.input).toContain('footer')
    expect(result.documentation.behavior.choices).toContain('footer')
    expect(result.documentation.behavior.historyDisplay).toContain('Footer')
    expect(result.documentation.grantsPermission).toBe(false)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('advertises one through four waiting actions and never reads a lone button as an implicit affirmative', async () => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name: 'show_card' })
    expect(result.documentation.limits).toMatchObject({ minimumInteractiveActions: 1, maximumActions: 4 })
    expect(result.documentation.behavior.choices).toContain('One action still waits for an explicit click')
    expect(result.documentation.behavior.choices).toContain('single-action')
    expect(result.documentation.behavior.choices).not.toContain('One action is not supported')
    expect(result.inputSchema.properties.actions).toMatchObject({ type: 'array', maxItems: 4 })
    expect(result.inputSchema.properties.actions).not.toHaveProperty('not')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('describes the bounded optional subtitle in the actual current card schema without issuing input', async () => {
    const { provider, callbacks } = setup()
    const result = await info(provider, { name: 'show_card' })
    expect(result.inputSchema).toMatchObject({ properties: { subtitle: { type: 'string', maxLength: 200 } } })
    expect(result.documentation.limits).toMatchObject({ subtitleSchemaCharacters: 200, subtitleUtf16Units: 200 })
    expect(result.documentation.behavior.input).toContain('subtitle')
    expect(result.documentation.behavior.choices).toContain('subtitle')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it.each(names)('loads a detached local behavior manual for currently admitted %s without starting input', async name => {
    const { provider, assertInvocation, callbacks } = setup()
    const result = await info(provider, { name })
    expect(result).toMatchObject({ ...provider.listTools().find(tool => tool.name === name), grantsPermission: false, documentation: {
      contract: 'magicpot-local-interaction-manual/v1', name, documentationOnly: true, grantsPermission: false,
      authority: { readingUnlocksTool: false, answersGrantPermission: false },
      timeout: { parameter: 'timeout_seconds', defaultSeconds: 300, minimumSeconds: 1, maximumSeconds: 600 }
    } })
    expect(result.documentation.workflow.length).toBeGreaterThan(2)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PARENT_NOT_A_MANUAL')
    expect(Buffer.byteLength(JSON.stringify(result.documentation), 'utf8')).toBeLessThan(10000)
    expect(await info(provider, { kind: 'tool', name })).toEqual(result)
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
    expect(assertInvocation).toHaveBeenCalledWith('info')
  })
  it('uses actual local limits and distinguishes plain input, waiting choices and provided-not-seen content', async () => {
    const { provider } = setup()
    const ask = (await info(provider, { name: 'ask_user' })).documentation
    expect(ask.limits).toEqual({ questionSchemaCharacters: LIMITS.question, placeholderSchemaCharacters: 200, answerUtf16Units: LIMITS.answer })
    expect(ask.behavior.input).toContain('no default/default_answer')
    expect(ask.behavior.response).toContain('placeholder is a hint, not an answer')
    const card = (await info(provider, { name: 'show_card' })).documentation
    expect(card.limits).toMatchObject({ titleSchemaCharacters: LIMITS.title, bodySchemaCharacters: LIMITS.body, actionLabelSchemaCharacters: LIMITS.actionLabel, maximumActions: 4, displayTitleUtf16Units: LIMITS.title, displayBodyUtf16Units: LIMITS.body, displayReceiptParserBytes: 32768, maximumDisplayFields: 8, fieldLabelUtf16Units: 200, fieldValueUtf16Units: 1000, totalFieldTextUtf16Units: 4096 })
    expect(card.behavior.input).toContain('Fields are read-only context, not input controls')
    expect(card.behavior.choices).toContain('32 KiB exact serialized prompt')
    expect(card.behavior.choices).toContain('No field values, footer, accent, icon or permission extras')
    expect(card.behavior.displayOnly).toContain('not displayed/seen, answered or consent')
    expect(card.behavior.displayOnly).toContain('never truncated')
    expect(card.behavior.choices).toContain('One action still waits for an explicit click')
    expect(card.behavior.historyDisplay).toContain('never answers, retries, executes')
    for (const manual of [ask, card]) {
      expect(manual.timeout).toMatchObject({ alias: 'timeout_s', mutuallyExclusive: true, defaultSeconds: LIMITS.defaultTimeoutSeconds, maximumSeconds: LIMITS.maxTimeoutSeconds })
      expect(manual.lifecycle.pending).toContain('global bound of 64')
      expect(manual.lifecycle.history).toContain('sent to the selected model')
      expect(manual.authority.rule).toContain('never an approval grant')
      expect(manual.privacy).toContain('does not delete or sanitize the original')
    }
  })
  it('retains compact default listings, unrelated tool/schema results and helper selectors', async () => {
    const { provider, setVisible, callbacks } = setup()
    const tools = [...provider.listTools(), tool('files.read')]
    setVisible(tools)
    expect(await info(provider, {})).toEqual({ tools: tools.map(({ name, description }) => ({ name, description })), grantsPermission: false })
    expect(await info(provider, { name: 'files.read' })).toEqual({ ...tool('files.read'), grantsPermission: false })
    const app = await info(provider, { name: 'show_app' })
    expect(app).toMatchObject({ ...tools.find(tool => tool.name === 'show_app'), grantsPermission: false, documentation: { contract: 'magicpot-local-app-manual/v1', name: 'show_app', mode: 'declarative-and-html', documentationOnly: true, grantsPermission: false } })
    expect(await info(provider, { kind: 'subagent' })).toEqual({ kind: 'subagent', subagents: [], grantsPermission: false })
    for (const name of names) await expect(info(provider, { kind: 'subagent', name })).rejects.toThrow('not available')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('independently gates exact names, filters related tools by the current set and deep-detaches common/specific data', async () => {
    const { provider, setVisible } = setup()
    setVisible([tool('ask_user')])
    const result = await info(provider, { name: 'ask_user' })
    expect(result.documentation.relatedTools).toEqual([])
    result.documentation.workflow[0] = 'MUTATED'
    result.documentation.authority.answersGrantPermission = true
    result.documentation.timeout.defaultSeconds = 1
    result.documentation.limits.answerUtf16Units = 1
    result.documentation.relatedTools.push('show_card')
    const fresh = await info(provider, { name: 'ask_user' })
    expect(fresh.documentation.workflow[0]).not.toBe('MUTATED')
    expect(fresh.documentation.authority.answersGrantPermission).toBe(false)
    expect(fresh.documentation.timeout.defaultSeconds).toBe(300)
    expect(fresh.documentation.limits.answerUtf16Units).toBe(4000)
    expect(fresh.documentation.relatedTools).toEqual([])
    setVisible([tool('ask_user'), tool('show_card'), tool('info')])
    expect((await info(provider, { name: 'ask_user' })).documentation.relatedTools).toEqual(['show_card', 'info'])
    expect((await info(provider, { name: 'show_card' })).documentation.authority.answersGrantPermission).toBe(false)
    expect((await info(provider, { name: 'show_card' })).documentation.relatedTools).toEqual(['ask_user', 'info'])
    setVisible([])
    await expect(info(provider, { name: 'ask_user' })).rejects.toThrow('not available')
    for (const name of names) expect(describeThreadInteractionTool(name, [])).toBeUndefined()
    for (const name of names) {
      const visible = [tool(name)]
      const direct = describeThreadInteractionTool(name, visible)!
      const original = structuredClone(direct)
      direct.workflow[0] = 'DIRECT MUTATION'
      direct.authority.answersGrantPermission = true
      expect(Reflect.set(direct.timeout, 'defaultSeconds', 1)).toBe(true)
      direct.behavior.input = 'DIRECT MUTATION'
      expect(Reflect.set(direct.limits, 'answerUtf16Units' in direct.limits ? 'answerUtf16Units' : 'displayTitleUtf16Units', 1)).toBe(true)
      direct.relatedTools.push('info')
      expect(describeThreadInteractionTool(name, visible)).toEqual(original)
    }
  })
  it.each(['ASK_USER', 'ask_user ', '../ask_user', 'show-card', 'SHOW_CARD', 'ui:quiz', 'plugin:secret', '__proto__', 'constructor', 'toString', 'show_app', 'search_memory', 'scratchpad'])('never resolves a fallback/alias manual for %s', async name => {
    const { provider, setVisible, callbacks } = setup()
    setVisible([tool(name)])
    expect(describeThreadInteractionTool(name, [tool(name)])).toBeUndefined()
    expect(await info(provider, { name })).toEqual({ ...tool(name), grantsPermission: false })
    setVisible([])
    await expect(info(provider, { name })).rejects.toThrow('not available')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it.each([
    { name: 'ask_user', execute: true }, { name: 'show_card', confirmed: true }, { name: 'ask_user', default_answer: 'yes' },
    { name: 'ask_user', paths: ['x.ts'] }, { name: 'show_card', offset: 0 }, { kind: 'plugin', name: 'ui:quiz' }
  ])('rejects unsupported/authority-like info selectors %j', async args => {
    const { provider, callbacks } = setup()
    await expect(info(provider, args)).rejects.toThrow()
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('cannot unlock interactions when the trusted response channel is absent', async () => {
    const { provider, callbacks } = setup(false)
    for (const name of names) {
      expect(provider.listTools().some(tool => tool.name === name)).toBe(false)
      await expect(info(provider, { name })).rejects.toThrow('not available')
      await expect(provider.callTool(name, {}, context())).rejects.toThrow('outside')
    }
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
  it('checks cancellation, foreign scope and invocation before lookup and again after current discovery', async () => {
    const { provider, listVisibleTools, assertInvocation, callbacks } = setup()
    const aborted = new AbortController(); aborted.abort()
    await expect(provider.callTool('info', { name: 'ask_user' }, { ...context(), signal: aborted.signal })).rejects.toThrow()
    await expect(provider.callTool('info', { name: 'show_card' }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(listVisibleTools).not.toHaveBeenCalled()
    const late = new AbortController()
    listVisibleTools.mockImplementation(() => { late.abort(); return [tool('ask_user')] })
    await expect(provider.callTool('info', { name: 'ask_user' }, { ...context(), signal: late.signal })).rejects.toThrow()
    listVisibleTools.mockImplementation(() => { assertInvocation.mockImplementation(() => { throw new Error('request ended') }); return [tool('show_card')] })
    await expect(info(provider, { name: 'show_card' })).rejects.toThrow('request ended')
    for (const callback of callbacks) expect(callback).not.toHaveBeenCalled()
  })
})
