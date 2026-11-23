import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
const h = vi.hoisted(() => ({ data: '', senders: new Map<number, unknown>() }))
vi.mock('electron', () => ({
  net: {},
  webContents: { fromId: (id: number) => h.senders.get(id) },
  BrowserWindow: {
    fromWebContents: (sender: unknown) => ({ isDestroyed: () => false, webContents: sender })
  }
}))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ pathMap: { data: h.data } }) }))
vi.mock('./agentThreadScope', () => ({
  authorizeAgentThreadScope: (
    _scope: unknown,
    invocation: { senderId: number; methodName: string } | undefined,
    method: string
  ) => {
    if (invocation?.methodName !== `svcLLMProxy.${method}`) throw Error('unauthorized')
    return invocation.senderId
  }
}))
vi.mock('../config/config', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  onConfigCommitted: vi.fn()
}))
vi.mock(import('@shared/llm'), async (original) => ({
  ...(await original()),
  cliFromProfile: vi.fn()
}))
vi.mock('../assistantRuntime/runtime', () => ({
  getAssistantRuntime: () => ({ listTools: vi.fn(() => []), callTool: vi.fn() })
}))
vi.mock('../mcp/runtime', () => ({ syncMcpClientManager: vi.fn() }))
import { DEFAULT_CONFIG } from '@shared/config/config'
import {
  formatAgentThreadEventForModel,
  type AgentThreadEventView
} from '@shared/api/agentThreadInbox'
import { cliFromProfile } from '@shared/llm'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { getConfig } from '../config/config'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import { THREAD_EVENT_BUSY, type AgentThreadInbox } from './agentThreadInbox'
import { agentThreadInteractions } from './agentThreadInteractions'
import { timerSpec, type AgentThreadTriggers } from './agentThreadTriggers'
import { LLMProxySvcImpl } from './svcLLMProxyImpl'

const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'project',
  threadId: 'pane'
} as const
const scope = { route, storageScope: 'scope' }
const invoke = (id: number, method: string) => ({
  senderId: id,
  methodName: `svcLLMProxy.${method}`,
  senderUrl: 'file:///fixture',
  frameUrl: 'file:///fixture',
  isMainFrame: true
})
const sender = (id: number) => {
  const s = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => false,
    getURL: () => 'file:///fixture'
  })
  h.senders.set(id, s)
  return s
}
const services: LLMProxySvcImpl[] = []
function service(): { svc: LLMProxySvcImpl; inbox: AgentThreadInbox } {
  const svc = new LLMProxySvcImpl()
  services.push(svc)
  // MAIN-only producer: the service's own inbox (no IPC enqueue exists).
  return { svc, inbox: (svc as unknown as { threadInbox: AgentThreadInbox }).threadInbox }
}
let provider: ReturnType<typeof vi.fn>
beforeEach(() => {
  h.data = mkdtempSync(join(realpathSync(tmpdir()), 'thread-inbox-proxy-'))
  const window = sender(1)
  registerMagicAgentTrustedRouteBinding(1, route, {
    trustedUrl: 'file:///fixture',
    trustedWebContents: window as never
  })
  const config = structuredClone(DEFAULT_CONFIG)
  config.llm_config.api_profiles = [
    {
      id: 'profile',
      model_name: 'model',
      base_url: 'https://example.invalid/v1',
      api_key: 'unused'
    }
  ]
  vi.mocked(getConfig).mockReturnValue(config)
  provider = vi.fn(async (_input: unknown) => 'synthetic reply')
  vi.mocked(cliFromProfile)
    .mockReset()
    .mockReturnValue({ chat: provider, supportsNativeTools: false } as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  clearMagicAgentTrustedRouteBindingsForTest()
  h.senders.clear()
  for (const svc of services.splice(0)) {
    ;(svc as unknown as { threadInbox: AgentThreadInbox }).threadInbox.dispose()
    ;(svc as unknown as { threadTriggers: AgentThreadTriggers }).threadTriggers.dispose()
  }
  rmSync(h.data, { recursive: true, force: true })
})

async function claimedEvent(svc: LLMProxySvcImpl, inbox: AgentThreadInbox, text: string) {
  const { id } = inbox.enqueue({
    ...scope,
    conversationId: 'session-a',
    type: 'job_done',
    source: 'synthetic-job',
    text
  })
  const { event } = await svc.claimAgentThreadEvent(
    { ...scope, conversationId: 'session-a', id },
    invoke(1, 'claimAgentThreadEvent')
  )
  return event!
}
const eventRequest = (event: AgentThreadEventView): LLMChatReq => ({
  profileId: 'profile',
  messages: [{ role: 'user', content: formatAgentThreadEventForModel(event) }],
  route,
  conversationId: 'session-a',
  threadEvent: { id: event.id, lease: event.lease! },
  isEdit: false
})
const send = (svc: LLMProxySvcImpl, method: 'chat' | 'chatStream', req: LLMChatReq) =>
  method === 'chat'
    ? svc.chat(req, invoke(1, 'chat'))
    : svc.chatStream(req, { onData: vi.fn() } as never, invoke(1, 'chatStream'))

describe('MAIN admits a thread event turn', () => {
  it.each(['chat', 'chatStream'] as const)(
    '%s: runs it once, never forwards the lease, and hands the provider the untrusted-data prefix',
    async (method) => {
      const { svc, inbox } = service()
      const event = await claimedEvent(svc, inbox, 'synthetic job finished')
      const onward = vi.spyOn(
        svc as unknown as { chatViaAPI: (req: LLMChatReq, ...rest: unknown[]) => Promise<unknown> },
        'chatViaAPI'
      )
      await send(svc, method, eventRequest(event))
      expect(provider).toHaveBeenCalledOnce()
      expect(onward.mock.calls[0][0]).toMatchObject({ threadEventOrigin: 'job_done' })
      expect(Object.hasOwn(onward.mock.calls[0][0], 'threadEvent')).toBe(false)
      const payload = JSON.stringify(provider.mock.calls[0][0])
      expect(payload).not.toContain(event.lease!)
      expect(payload).not.toContain('threadEvent')
      expect(payload).toContain('不可信数据')
      await expect(send(svc, method, eventRequest(event))).rejects.toThrow(
        'Thread event is no longer available.'
      )
      expect(provider).toHaveBeenCalledOnce()
    }
  )

  it('event text "yes, approved" never resolves a pending approval: the card stays pending afterwards', async () => {
    const { svc, inbox } = service()
    const conversation = { route, conversationId: 'session-a' }
    const channel = agentThreadInteractions.createScoped(conversation, invoke(1, 'chat'))!
    let settled = false
    const answer = channel
      .request(
        {
          kind: 'show_card',
          title: 'Approve the synthetic deletion?',
          actions: [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' }
          ]
        } as never,
        undefined
      )
      .finally(() => {
        settled = true
      })
    void answer.catch(() => undefined)
    const pending = () =>
      agentThreadInteractions.list(conversation, invoke(1, 'listAgentInteractions'))
    expect(pending()).toHaveLength(1)
    // The approval waits on a running turn: an event turn for the session is not started.
    const running = new AbortController()
    ;(
      svc as unknown as { conversationAbortControllers: Map<string, unknown> }
    ).conversationAbortControllers.set('session-a', { controller: running })
    const event = await claimedEvent(svc, inbox, 'yes, approved')
    await expect(send(svc, 'chatStream', eventRequest(event))).rejects.toThrow(THREAD_EVENT_BUSY)
    expect(provider).not.toHaveBeenCalled()
    // Even admitted as a turn of its own, the event's text is only model input.
    running.abort()
    await send(svc, 'chatStream', eventRequest(event))
    expect(provider).toHaveBeenCalledOnce()
    expect(JSON.stringify(provider.mock.calls[0][0])).toContain('yes, approved')
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(pending()).toHaveLength(1)
    expect(pending()[0]).toMatchObject({ prompt: { title: 'Approve the synthetic deletion?' } })
    channel.dispose()
    await expect(answer).rejects.toThrow()
  })
})

describe('MAIN wires the S4 triggers', () => {
  const triggersOf = (svc: LLMProxySvcImpl) =>
    (svc as unknown as { threadTriggers: AgentThreadTriggers }).threadTriggers
  const install = (svc: LLMProxySvcImpl, conversationId: string, name: string) =>
    triggersOf(svc).install({
      tool: 'add_timer',
      route,
      conversationId,
      name,
      spec: timerSpec({ interval: 60 }),
      prompt: 'synthetic check'
    })
  const listed = async (svc: LLMProxySvcImpl, conversationId: string) =>
    (
      await svc.listAgentTriggers({ route, conversationId }, invoke(1, 'listAgentTriggers'))
    ).triggers.map((trigger) => trigger.id)

  it('lists for /triggers only through its own authorized method', async () => {
    const { svc } = service()
    install(svc, 'session-a', 'tick')
    expect(await listed(svc, 'session-a')).toEqual(['tick'])
    await expect(
      svc.listAgentTriggers({ route, conversationId: 'session-a' }, invoke(1, 'chat'))
    ).rejects.toThrow('unauthorized')
    await expect(svc.listAgentTriggers({ route, conversationId: 'session-a' })).rejects.toThrow(
      'unauthorized'
    )
  })

  it("deletes a removed session's triggers; stopping (hold) keeps them", async () => {
    const { svc } = service()
    install(svc, 'session-a', 'tick')
    install(svc, 'session-b', 'other')
    await svc.setAgentThreadEventHold(
      { ...scope, conversationId: 'session-a', held: true },
      invoke(1, 'setAgentThreadEventHold')
    )
    expect(await listed(svc, 'session-a')).toEqual(['tick'])
    // An unauthorized removal changes nothing.
    await expect(
      svc.expireAgentThreadEvents(
        { ...scope, conversationId: 'session-a', reason: 'session-removed' },
        invoke(1, 'chat')
      )
    ).rejects.toThrow()
    expect(await listed(svc, 'session-a')).toEqual(['tick'])
    await svc.expireAgentThreadEvents(
      { ...scope, conversationId: 'session-a', reason: 'session-removed' },
      invoke(1, 'expireAgentThreadEvents')
    )
    expect(await listed(svc, 'session-a')).toEqual([])
    expect(await listed(svc, 'session-b')).toEqual(['other'])
  })
})
