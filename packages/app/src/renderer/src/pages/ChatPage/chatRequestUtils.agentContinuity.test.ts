import { DEFAULT_CONFIG, type Config, type CustomSkill } from '@shared/config/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRouteLike } from '@shared/agent'
import type { LLMProxySvc } from '@shared/api/svcLLMProxy'
import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: 'agent-profile',
        provider: 'openai',
        deployment: 'cloud',
        model_use: 'vision',
        model_name: 'fixture-agent-model',
        base_url: 'https://fixture-agent.invalid/v1',
        api_key: '',
        api_mode: 'chat-completions',
        attachment_transports: ['request-data-url']
      }
    ]
  }
})

const fixtureSkill: CustomSkill = {
  id: 'fixture-agent',
  type: 'agent',
  category: 'fixture',
  skillName: 'Fixture Agent',
  prompt: 'Answer the fixture request.',
  apiAddress: 'http://127.0.0.1:43117/agent',
  apiKey: ''
}

const fixtureRoute: AgentRouteLike = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'fixture-project',
  threadId: 'fixture-pane'
}

const fixtureImage: ChatAttachment = {
  type: 'image',
  url: 'local-media:///fixture-managed/originals/aa/fixture-reference.png',
  fileName: 'fixture-reference.png',
  mimeType: 'image/png'
}

const installFixtureLocalMediaFetch = () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== fixtureImage.url) {
      throw new Error(`unexpected fixture URL: ${url}`)
    }
    return new Response(new Blob(['fixture-image'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const installRemoteFetch = (
  responses: Array<{
    content: string
    sessionUrl?: string
    metadata?: Record<string, unknown>
  }>
) => {
  const requests: Array<{
    body: Record<string, unknown>
    conversationId?: string
    responseIndex: number
  }> = []
  const payloadSummaries: Array<{
    call: number
    responseIndex: number
    conversationId?: string
    threadId?: string
    messages: Array<{ role: string; content: string; attachmentUrls: string[] }>
  }> = []
  const remoteFetch = vi.fn(async (request: { body: string; conversationId?: string }) => {
    const body = JSON.parse(request.body) as Record<string, unknown>
    const call = requests.length + 1
    const responseIndex = call - 1
    const route = body.route
    const threadId =
      route && typeof route === 'object'
        ? String((route as Record<string, unknown>).threadId || '')
        : undefined
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>).map((message) => ({
          role: String(message.role || ''),
          content: String(message.content || ''),
          attachmentUrls: Array.isArray(message.attachments)
            ? (message.attachments as Array<Record<string, unknown>>).map((attachment) =>
                String(attachment.url || '')
              )
            : []
        }))
      : []
    const summary = {
      call,
      responseIndex,
      conversationId: request.conversationId,
      threadId,
      messages
    }
    payloadSummaries.push(summary)
    requests.push({ body, conversationId: request.conversationId, responseIndex })
    const response = responses[responseIndex]
    if (!response) {
      throw new Error(
        `unexpected remoteFetch count: ${call}; response index ${responseIndex}; payload summaries: ${JSON.stringify(payloadSummaries)}`
      )
    }
    return {
      status: 200,
      statusText: 'OK',
      body: JSON.stringify(response)
    }
  })

  window.api = {
    svcManagedMedia: {},
    svcLLMProxy: { remoteFetch }
  } as unknown as Window['api']

  return { remoteFetch, requests }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('external agent continuity fixture', () => {
  it('delivers the first response delta before the delayed remote request settles', async () => {
    let stream!: Parameters<LLMProxySvc['externalAgentStream']>[1]
    let resolveStream: (() => void) | undefined
    const externalAgentStream = vi.fn<LLMProxySvc['externalAgentStream']>((_request, response) => {
      stream = response
      return new Promise<void>((resolve) => {
        resolveStream = resolve
      })
    })
    const remoteFetch = vi.fn()
    const cancelConversation = vi.fn(async () => ({ cancelled: true }))
    window.api = {
      svcManagedMedia: {},
      svcLLMProxy: { externalAgentStream, remoteFetch, cancelConversation }
    } as unknown as Window['api']
    const mediaFetch = installFixtureLocalMediaFetch()

    const events: Array<{ at: number; type: string; delta?: string }> = []
    const controller = new AbortController()
    let settled = false
    const request = requestChatCompletionStream({
      config: createConfig(),
      profileId: 'agent-profile',
      messages: [
        { role: 'user', content: 'Describe the fixture image.', attachments: [fixtureImage] }
      ],
      externalAgentSkill: fixtureSkill,
      route: fixtureRoute,
      storageScope: 'fixture-project.fixture-pane',
      conversationId: 'remote-continuation-1',
      signal: controller.signal,
      onEvent: (event) => {
        events.push({
          at: performance.now(),
          type: event.type,
          delta: event.type === 'text-delta' ? event.delta : undefined
        })
      }
    }).finally(() => {
      settled = true
    })
    void request.catch(() => undefined)

    try {
      // Image materialization is asynchronous; wait for the stream RPC, not one microtask.
      await vi.waitFor(() => expect(externalAgentStream).toHaveBeenCalledOnce())
      expect(mediaFetch).toHaveBeenCalledWith(fixtureImage.url)
      expect(remoteFetch).not.toHaveBeenCalled()
      const payload = JSON.parse(externalAgentStream.mock.calls[0][0].body!)
      expect(payload.stream).toBe(true)
      expect(payload.messages[0].attachments[0]).toMatchObject({
        type: 'image',
        url: expect.stringMatching(/^data:image\/png;base64,/)
      })

      stream.onData({ type: 'text-delta', delta: 'first delta', done: false })
      await Promise.resolve()
      expect(events).toEqual([
        expect.objectContaining({ type: 'text-delta', delta: 'first delta' })
      ])
      expect(settled).toBe(false)

      stream.onData({ type: 'text-delta', delta: ' second delta', done: false })
      stream.onData({
        type: 'done',
        delta: '',
        done: true,
        fullContent: 'first delta second delta',
        sessionUrl: 'https://fixture.example/session/1',
        finishReason: 'stop'
      })
      resolveStream?.()
      await expect(request).resolves.toMatchObject({
        response: 'first delta second delta',
        result: { sessionUrl: 'https://fixture.example/session/1' }
      })
      expect(settled).toBe(true)
      expect(events.map((event) => event.type)).toEqual(['text-delta', 'text-delta', 'done'])
      expect(remoteFetch).not.toHaveBeenCalled()
    } finally {
      controller.abort()
      resolveStream?.()
      await request.catch(() => undefined)
    }
  })

  it('keeps the image and continuation identity across three restored-thread rounds', async () => {
    const fixture = installRemoteFetch([
      {
        content: 'round one',
        sessionUrl: 'https://fixture.example/session/1',
        metadata: { remoteContinuationId: 'remote-continuation-1', parentId: 'parent-0' }
      },
      {
        content: 'round two',
        sessionUrl: 'https://fixture.example/session/1',
        metadata: { remoteContinuationId: 'remote-continuation-1', parentId: 'parent-1' }
      },
      {
        content: 'round three',
        sessionUrl: 'https://fixture.example/session/1',
        metadata: { remoteContinuationId: 'remote-continuation-1', parentId: 'parent-2' }
      }
    ])
    installFixtureLocalMediaFetch()
    const config = createConfig()
    const firstMessages: ChatMessage[] = [
      {
        role: 'user',
        content: 'What is in the fixture image?',
        attachments: [fixtureImage]
      }
    ]
    const first = await requestChatCompletion({
      config,
      profileId: 'agent-profile',
      messages: firstMessages,
      externalAgentSkill: fixtureSkill,
      route: fixtureRoute,
      storageScope: 'fixture-project.fixture-pane',
      conversationId: 'remote-continuation-1'
    })

    const secondMessages: ChatMessage[] = [
      ...firstMessages,
      { role: 'assistant', content: first.content },
      { role: 'user', content: 'Follow up about the same image.' }
    ]
    await requestChatCompletion({
      config,
      profileId: 'agent-profile',
      messages: secondMessages,
      externalAgentSkill: fixtureSkill,
      route: { ...fixtureRoute },
      storageScope: 'fixture-project.fixture-pane',
      conversationId: 'remote-continuation-1',
      sessionUrl: first.sessionUrl
    })

    const thirdMessages: ChatMessage[] = [
      ...secondMessages,
      { role: 'assistant', content: 'round two' },
      { role: 'user', content: 'After restoring the same thread, read the image again.' }
    ]
    await requestChatCompletion({
      config,
      profileId: 'agent-profile',
      messages: thirdMessages,
      externalAgentSkill: fixtureSkill,
      route: { ...fixtureRoute },
      storageScope: 'fixture-project.fixture-pane',
      conversationId: 'remote-continuation-1',
      sessionUrl: first.sessionUrl
    })

    expect(fixture.remoteFetch).toHaveBeenCalledTimes(3)
    expect(fixture.requests).toHaveLength(3)
    expect(fixture.requests.map((request) => request.responseIndex)).toEqual([0, 1, 2])
    expect(fixture.requests.map((request) => request.conversationId)).toEqual([
      'remote-continuation-1',
      'remote-continuation-1',
      'remote-continuation-1'
    ])
    expect(
      fixture.requests.map((request) => (request.body.route as { threadId: string }).threadId)
    ).toEqual(['fixture-pane', 'fixture-pane', 'fixture-pane'])

    const secondPayloadMessages = fixture.requests[1].body.messages as Array<{
      role: string
      content: string
      attachments?: ChatAttachment[]
    }>
    expect(secondPayloadMessages[0].attachments?.[0]).toEqual(
      expect.objectContaining({
        type: 'image',
        url: expect.stringMatching(/^data:image\/png;base64,/)
      })
    )

    const thirdPayloadMessages = fixture.requests[2].body.messages as Array<{
      role: string
      content: string
      attachments?: ChatAttachment[]
    }>
    expect(thirdPayloadMessages[0].attachments?.[0]).toEqual(
      expect.objectContaining({
        type: 'image',
        url: expect.stringMatching(/^data:image\/png;base64,/)
      })
    )

    expect(fixture.requests[1].body).not.toHaveProperty('sessionUrl')
    expect(fixture.requests[2].body).not.toHaveProperty('sessionUrl')
  })
})
