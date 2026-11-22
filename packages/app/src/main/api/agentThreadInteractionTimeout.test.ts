import { describe, expect, it, vi } from 'vitest'
import type { AgentThreadInteractionResult } from '@shared/api/agentThreadInteraction'
import { createAgentThreadToolProvider } from './agentThreadTools'

const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'timeout-alias', threadId: 'pane' } as const
const context = () => ({ route, runId: 'timeout-run', toolCallId: 'timeout-call' })
const setup = () => {
  const request = vi.fn(async (..._args: unknown[]): Promise<AgentThreadInteractionResult> => ({ status: 'dismissed' }))
  const assertLive = vi.fn(), assertInvocation = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation, listVisibleTools: () => provider.listTools(), interactions: { request, assertLive, signal: new AbortController().signal, dispose: vi.fn() } })
  return { provider, request, assertLive, assertInvocation }
}
const choices = [{ id: 'yes', label: 'Feedback yes' }, { id: 'no', label: 'Feedback no' }]
const cases = [
  { name: 'ask_user', input: { question: 'How?' }, prompt: { kind: 'ask_user', question: 'How?' } },
  { name: 'show_card', input: { title: 'Which?', actions: choices }, prompt: { kind: 'show_card', title: 'Which?', actions: choices } },
  { name: 'show_card', input: { title: 'One explicit choice?', actions: choices.slice(0, 1) }, prompt: { kind: 'show_card', title: 'One explicit choice?', actions: choices.slice(0, 1) } }
]

describe('bounded upstream timeout_s spelling in existing thread feedback', () => {
  it.each([1, 600])('maps ask_user timeout_s=%s to the same bounded request wait', async seconds => {
    const { provider, request } = setup()
    const controller = new AbortController()
    expect(JSON.parse((await provider.callTool('ask_user', { question: 'How?', timeout_s: seconds }, { ...context(), signal: controller.signal })).content)).toEqual({ status: 'dismissed' })
    expect(request).toHaveBeenCalledWith({ kind: 'ask_user', question: 'How?' }, seconds, controller.signal)
  })
  it.each([1, 600].flatMap(seconds => [1, 2].map(count => [seconds, count] as const)))('maps interactive show_card timeout_s=%s actions=%s without changing feedback/approval semantics', async (seconds, count) => {
    const { provider, request } = setup()
    expect(JSON.parse((await provider.callTool('show_card', { title: 'Which?', actions: choices.slice(0, count), timeout_s: seconds }, context())).content)).toEqual({ status: 'dismissed' })
    expect(request).toHaveBeenCalledWith({ kind: 'show_card', title: 'Which?', actions: choices.slice(0, count) }, seconds, undefined)
  })
  it.each([{ actions: undefined }, { actions: [] }])('validates but creates no pending request for a provided card with %j', async ({ actions }) => {
    const { provider, request, assertLive } = setup()
    const result = JSON.parse((await provider.callTool('show_card', { title: 'Read only', timeout_s: 1, ...(actions === undefined ? {} : { actions }) }, context())).content)
    expect(result).toMatchObject({ contract: 'agent-thread-card-display/v1', status: 'provided', mode: 'display-only', untrustedData: true, grantsPermission: false })
    expect(request).not.toHaveBeenCalled()
    expect(assertLive).toHaveBeenCalledOnce()
  })
  it.each(cases)('retains omitted default, legacy spelling, plain feedback and exact own timeout mapping for $name', async ({ name, input, prompt }) => {
    const { provider, request } = setup()
    const inherited = Object.assign(Object.create({ timeout_s: 1 }), input)
    const inheritedLegacy = Object.assign(Object.create({ timeout_seconds: 1 }), input)
    for (const [args, expected] of [
      [input, 300], [{ ...input, timeout_seconds: 1 }, 1], [{ ...input, timeout_seconds: 600 }, 600],
      [inherited, 300], [inheritedLegacy, 300], [Object.assign(Object.create({ timeout_seconds: 1 }), input, { timeout_s: 600 }), 600]
    ] as const) {
      request.mockClear()
      const result = await provider.callTool(name, args, context())
      expect(JSON.parse(result.content)).toEqual({ status: 'dismissed' })
      expect(result.metadata).toEqual({ source: 'agent-thread-tool', toolName: name })
      expect(request).toHaveBeenCalledExactlyOnceWith(prompt, expected, undefined)
    }
    const definition = provider.listTools().find(tool => tool.name === name)!
    expect(definition.inputSchema).toMatchObject({ additionalProperties: false, properties: { timeout_s: { type: 'integer', minimum: 1, maximum: 600 }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 } }, not: { required: ['timeout_seconds', 'timeout_s'] } })
    const manual = JSON.parse((await provider.callTool('info', { name }, context())).content).documentation
    expect(manual.timeout).toMatchObject({ parameter: 'timeout_seconds', alias: 'timeout_s', mutuallyExclusive: true, defaultSeconds: 300, minimumSeconds: 1, maximumSeconds: 600 })
  })
  it.each(cases)('rejects invalid or double-spelled waits before any request/display for $name', async ({ name, input }) => {
    const { provider, request, assertLive } = setup()
    const invalid = [null, 0, -1, 0.5, 1.5, 601, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', true, {}, []]
    for (const parameter of ['timeout_s', 'timeout_seconds']) for (const value of invalid)
      await expect(provider.callTool(name, { ...input, [parameter]: value }, context())).rejects.toThrow('Invalid arguments')
    for (const values of [
      { timeout_s: 1, timeout_seconds: 1 }, { timeout_s: 1, timeout_seconds: 2 },
      { timeout_s: undefined, timeout_seconds: 1 }, { timeout_s: 1, timeout_seconds: undefined },
      { timeout_s: undefined, timeout_seconds: undefined }, { timeout_s: null, timeout_seconds: 1 }
    ]) await expect(provider.callTool(name, { ...input, ...values }, context())).rejects.toThrow('Invalid arguments')
    expect(request).not.toHaveBeenCalled()
    expect(assertLive).not.toHaveBeenCalled()
  })
  it('does not mask a supplied invalid alias on provided cards or extend unrelated tools', async () => {
    const { provider, request, assertLive } = setup()
    for (const extra of [{ timeout_s: 0 }, { timeout_s: null }, { timeout_s: 1.5 }, { timeout_s: 1, timeout_seconds: 1 }, { timeout_s: 1, confirmed: true }])
      await expect(provider.callTool('show_card', { title: 'Not provided', ...extra }, context())).rejects.toThrow('Invalid arguments')
    await expect(provider.callTool('show_app', { document: { title: 'Unchanged', blocks: [{ kind: 'text', text: 'x' }] }, timeout_s: 1 }, context())).rejects.toThrow('Invalid arguments')
    await expect(provider.callTool('info', { timeout_s: 1 }, context())).rejects.toThrow('Invalid arguments')
    expect(request).not.toHaveBeenCalled()
    expect(assertLive).not.toHaveBeenCalled()
  })
  it.each(cases)('preserves cancellation, request admission and scope checks with alias for $name', async ({ name, input }) => {
    const { provider, request, assertLive, assertInvocation } = setup()
    const controller = new AbortController(); controller.abort()
    await expect(provider.callTool(name, { ...input, timeout_s: 1 }, { ...context(), signal: controller.signal })).rejects.toThrow()
    await expect(provider.callTool(name, { ...input, timeout_s: 1 }, { ...context(), route: { ...route, threadId: 'foreign' } })).rejects.toThrow('outside')
    expect(assertInvocation).not.toHaveBeenCalled()
    assertInvocation.mockImplementation(() => { throw new Error('request ended') })
    await expect(provider.callTool(name, { ...input, timeout_s: 1 }, context())).rejects.toThrow('request ended')
    expect(request).not.toHaveBeenCalled()
    expect(assertLive).not.toHaveBeenCalled()
    const detached = createAgentThreadToolProvider({ route, messages: [], assertInvocation: vi.fn(), listVisibleTools: () => [] })
    expect(detached.listTools().some(tool => tool.name === name)).toBe(false)
    await expect(detached.callTool(name, { ...input, timeout_s: 1 }, context())).rejects.toThrow('outside')
  })
})
