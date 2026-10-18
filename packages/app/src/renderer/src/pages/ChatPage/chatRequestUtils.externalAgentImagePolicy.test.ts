import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type CustomSkill } from '@shared/config/config'
import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { requestChatCompletion } from './chatRequestUtils'

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOwbDn0HwAE+AJ/CEh6/AAAAABJRU5ErkJggg=='

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: 'probe-vision',
        provider: 'openai',
        deployment: 'cloud',
        model_use: 'vision',
        model_name: 'owned-probe',
        base_url: 'https://never-called.invalid/v1',
        api_key: '',
        attachment_transports: ['request-data-url'],
        supports_session_continuation: true
      }
    ]
  }
})

const externalAgentSkill: CustomSkill = {
  id: 'owned-agent',
  type: 'agent',
  category: 'owned',
  skillName: 'Owned agent',
  prompt: 'Analyze the provided reference.',
  apiAddress: 'https://never-called.invalid/agent',
  apiKey: ''
}

const history = (): ChatMessage[] => [
  {
    role: 'user',
    content: 'Describe this image',
    attachments: [
      {
        type: 'image',
        url: PNG_DATA_URL,
        fileName: 'owned-reference.png',
        mimeType: 'image/png'
      }
    ]
  },
  { role: 'assistant', content: 'Description' },
  { role: 'user', content: 'What color was in the previous image?' }
]

const installRemoteFetch = () => {
  const bodies: Array<Record<string, unknown>> = []
  const remoteFetch = vi.fn(async (request: { body: string }) => {
    bodies.push(JSON.parse(request.body) as Record<string, unknown>)
    return {
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ content: 'owned answer' })
    }
  })

  window.api = {
    svcManagedMedia: {},
    svcLLMProxy: { remoteFetch }
  } as unknown as Window['api']

  return { bodies, remoteFetch }
}

const findImageUrl = (body: Record<string, unknown>): string | undefined => {
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const attachments = (message as { attachments?: unknown }).attachments
    if (!Array.isArray(attachments)) continue
    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') continue
      const value = (attachment as ChatAttachment).url
      if (typeof value === 'string' && value.startsWith('data:image/png;base64,')) return value
    }
  }
  return undefined
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('external-agent image-history request policy', () => {
  it('keeps the exact historical PNG when continuation optimization has no usable transport', async () => {
    const messages = history()
    const before = JSON.stringify(messages)
    const { bodies } = installRemoteFetch()

    await requestChatCompletion({
      config: createConfig(),
      profileId: 'probe-vision',
      externalAgentSkill,
      messages,
      imageHistoryPolicy: 'latest-user-turn',
      sessionUrl: 'https://never-called.invalid/session/owned'
    })

    expect(bodies).toHaveLength(1)
    expect(findImageUrl(bodies[0])).toBe(PNG_DATA_URL)
    expect(bodies[0]).not.toHaveProperty('sessionUrl')
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('does not produce the no-history/no-continuation outcome for a prior-image request', async () => {
    const { bodies } = installRemoteFetch()

    await requestChatCompletion({
      config: createConfig(),
      profileId: 'probe-vision',
      externalAgentSkill,
      messages: history(),
      imageHistoryPolicy: 'latest-user-turn',
      sessionUrl: 'https://never-called.invalid/session/owned'
    })

    const body = bodies[0]
    const carriesOriginal = findImageUrl(body) === PNG_DATA_URL
    const carriesContinuation = body.sessionUrl === 'https://never-called.invalid/session/owned'
    expect({ carriesOriginal, carriesContinuation }).not.toEqual({
      carriesOriginal: false,
      carriesContinuation: false
    })
    expect(carriesOriginal).toBe(true)
    expect(carriesContinuation).toBe(false)
  })

  it('preserves explicit all-history PNG projection without mutating stored messages', async () => {
    const messages = history()
    const before = JSON.stringify(messages)
    const { bodies } = installRemoteFetch()

    await requestChatCompletion({
      config: createConfig(),
      profileId: 'probe-vision',
      externalAgentSkill,
      messages,
      imageHistoryPolicy: 'all',
      conversationId: 'owned-request-all'
    })

    expect(bodies).toHaveLength(1)
    expect(findImageUrl(bodies[0])).toBe(PNG_DATA_URL)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('fails before sending when the selected local image is unavailable', async () => {
    const { remoteFetch } = installRemoteFetch()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('owned missing file')
      })
    )
    const messages = history()
    const attachment = messages[0]?.attachments?.[0]
    if (!attachment) throw new Error('fixture image is missing')
    attachment.url = 'local-media:///owned-probe/missing.png'

    await expect(
      requestChatCompletion({
        config: createConfig(),
        profileId: 'probe-vision',
        externalAgentSkill,
        messages,
        imageHistoryPolicy: 'all',
        conversationId: 'owned-request-missing'
      })
    ).rejects.toThrow(/Unable to prepare image attachment/)
    expect(remoteFetch).not.toHaveBeenCalled()
    expect(messages[0]?.attachments).toHaveLength(1)
  })
})
