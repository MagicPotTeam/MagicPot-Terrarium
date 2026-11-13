import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { Config, CustomSkill, LLMOpenAIApiMode } from '@shared/config/config'
import type { ChatMessage } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const manifestUrl = 'local-media:///fixture/manifest.json'
const reportUrl = 'data:text/plain;base64,b3duZWQ='
const agent: CustomSkill = {
  id: 'owned',
  type: 'agent',
  category: 'owned',
  skillName: 'Owned',
  prompt: 'Analyze',
  apiAddress: 'https://never-called.invalid',
  apiKey: ''
}
const config = (apiMode: LLMOpenAIApiMode): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [
      {
        id: 'fixture-profile',
        provider: 'openai',
        deployment: 'cloud',
        model_use: 'chat',
        model_name: 'fixture-opaque-model',
        base_url: 'https://never-called.invalid/v1',
        api_key: 'fixture-not-a-credential',
        api_mode: apiMode,
        attachment_transports: ['request-data-url', 'accessible-url']
      }
    ]
  }
})
const message = (): ChatMessage => ({
  role: 'user',
  content: 'Analyze selected references.',
  attachments: [
    { type: 'image', url: 'local-media:///fixture/selected.png', mimeType: 'image/png' },
    {
      type: 'file',
      url: reportUrl,
      fileName: 'report.txt',
      reportBundleRole: 'primary-report',
      reportBundleManifestUrl: manifestUrl
    }
  ]
})
const request = (
  stream: boolean,
  external: boolean,
  messages: ChatMessage[],
  imageHistoryPolicy?: 'all' | 'latest-user-turn'
) => {
  const input = {
    config: config(external ? 'responses' : 'chat-completions'),
    messages,
    profileId: 'fixture-profile',
    ...(imageHistoryPolicy ? { imageHistoryPolicy } : {}),
    ...(external ? { externalAgentSkill: agent } : {})
  }
  return stream
    ? requestChatCompletionStream({ ...input, onEvent: vi.fn() })
    : requestChatCompletion(input)
}

const fixture = (entries: number) => {
  let completedManifestReads = 0
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === manifestUrl) {
      return {
        ok: true,
        text: async () => {
          completedManifestReads += 1
          return JSON.stringify({
            version: 1,
            bundleId: 'fixture',
            title: 'fixture',
            entries: Array.from({ length: entries }, (_, i) => ({
              role: 'report-image',
              fileName: `extra-${i}.png`,
              sourceUrl: `local-media:///fixture/extra-${i}.png`
            }))
          })
        }
      }
    }
    if (String(url) === reportUrl) {
      return { ok: true, text: async () => 'fixture', headers: { get: () => 'text/plain' } }
    }
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    }
  })
  const materializeForRequest = vi.fn()
  const dispatches: Array<{ transport: string; payload: unknown }> = []
  const chat = vi.fn(async (payload: unknown) => {
    dispatches.push({ transport: 'chat', payload })
    return { content: 'owned answer' }
  })
  const streamImpl = async (
    _payload: unknown,
    receiver: { onData: (event: { type: 'done'; content: string }) => void }
  ) => {
    dispatches.push({ transport: 'stream', payload: _payload })
    receiver.onData({ type: 'done', content: 'owned answer' })
  }
  const chatStream = vi.fn(streamImpl)
  const remoteFetch = vi.fn(async (payload: unknown) => {
    dispatches.push({ transport: 'remote', payload })
    return {
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ content: 'owned answer' })
    }
  })
  const externalAgentStream = vi.fn(streamImpl)
  vi.stubGlobal('fetch', fetchMock)
  window.api = {
    svcManagedMedia: { materializeForRequest },
    svcLLMProxy: { chat, chatStream, remoteFetch, externalAgentStream }
  } as unknown as Window['api']
  return {
    fetchMock,
    materializeForRequest,
    chat,
    chatStream,
    remoteFetch,
    externalAgentStream,
    dispatches,
    completedManifestReads: () => completedManifestReads
  }
}

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

const dispatchedImages = (f: ReturnType<typeof fixture>) => {
  const dispatched = f.dispatches.at(-1)?.payload as
    { messages?: ChatMessage[]; body?: string } | undefined
  if (!dispatched) throw new Error('Missing fixture dispatch')
  const payload = dispatched.body
    ? (JSON.parse(dispatched.body) as { messages: ChatMessage[] })
    : dispatched
  if (!payload.messages) throw new Error('Missing fixture messages')
  return payload.messages
    .flatMap((item) => item.attachments ?? [])
    .filter((item) => item.type === 'image')
}

describe('non-Responses report expansion: current explicit image lower bound', () => {
  it.each([
    ['chat-completions', false, false],
    ['chat-completions', true, false],
    ['external-agent', false, true],
    ['external-agent', true, true]
  ] as const)(
    'rejects 1 selected + 50 manifest images before probe, image materialization or dispatch (%s, stream=%s)',
    async (_route, stream, external) => {
      const f = fixture(50)
      const messages = [message()]
      const original = JSON.stringify(messages)
      const pending = request(stream, external, messages)
      await pending.then(
        () => undefined,
        () => undefined
      )
      expect(f.fetchMock.mock.calls.map(([url]) => String(url))).toContain(manifestUrl)
      expect(f.completedManifestReads()).toBe(1)
      await expect(pending).rejects.toThrow('本次图片数量超过限制，请分批发送')
      expect(f.fetchMock.mock.calls.map(([url]) => String(url))).toEqual([manifestUrl])
      expect(f.dispatches).toHaveLength(0)
      expect(f.materializeForRequest).not.toHaveBeenCalled()
      expect(f.chat).not.toHaveBeenCalled()
      expect(f.chatStream).not.toHaveBeenCalled()
      expect(f.remoteFetch).not.toHaveBeenCalled()
      expect(f.externalAgentStream).not.toHaveBeenCalled()
      expect(JSON.stringify(messages)).toBe(original)
    }
  )

  it.each([
    ['chat-completions', false, false],
    ['chat-completions', true, false],
    ['external-agent', false, true],
    ['external-agent', true, true]
  ] as const)(
    'keeps exactly 50 expanded current images and reads the manifest only once (%s, stream=%s)',
    async (_route, stream, external) => {
      const f = fixture(49)
      const messages = [message()]
      const original = JSON.stringify(messages)
      await expect(request(stream, external, messages)).resolves.toBeDefined()
      expect(f.completedManifestReads()).toBe(1)
      expect(f.fetchMock.mock.calls.filter(([url]) => String(url) === manifestUrl)).toHaveLength(1)
      expect(dispatchedImages(f)).toHaveLength(50)
      expect(JSON.stringify(messages)).toBe(original)
    }
  )

  it.each([false, true])(
    'does not reintroduce an older bundle under the latest-user policy (stream=%s)',
    async (stream) => {
      const f = fixture(50)
      const latest: ChatMessage = {
        role: 'user',
        content: 'Latest only',
        attachments: [
          { type: 'image', url: 'data:image/png;base64,aW1hZ2U=', mimeType: 'image/png' }
        ]
      }
      await expect(
        request(stream, false, [message(), latest], 'latest-user-turn')
      ).resolves.toBeDefined()
      expect(f.completedManifestReads()).toBe(0)
      expect(dispatchedImages(f)).toHaveLength(1)
    }
  )

  it.each([false, true])(
    'does not apply the current-turn 50-image guard to an older all-history bundle (stream=%s)',
    async (stream) => {
      const f = fixture(50)
      const latest: ChatMessage = {
        role: 'user',
        content: 'Latest only',
        attachments: [
          { type: 'image', url: 'data:image/png;base64,aW1hZ2U=', mimeType: 'image/png' }
        ]
      }
      await expect(request(stream, false, [message(), latest], 'all')).resolves.toBeDefined()
      expect(f.completedManifestReads()).toBe(1)
      expect(dispatchedImages(f)).toHaveLength(52)
    }
  )

  it.each([false, true])(
    'rejects 51 repeated explicit descriptors before even reading a manifest (stream=%s)',
    async (stream) => {
      const f = fixture(0)
      const selected = message()
      selected.attachments = [
        ...Array.from({ length: 51 }, () => ({
          type: 'image' as const,
          url: 'local-media:///fixture/same.png',
          mimeType: 'image/png'
        })),
        selected.attachments![1]
      ]
      const before = JSON.stringify(selected)
      await expect(request(stream, false, [selected])).rejects.toThrow(
        '本次图片数量超过限制，请分批发送'
      )
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.dispatches).toHaveLength(0)
      expect(JSON.stringify(selected)).toBe(before)
    }
  )

  it.each([false, true])(
    'still rejects images exposed by a second manifest after the first read fails (stream=%s)',
    async (stream) => {
      const f = fixture(50)
      const selected = message()
      const failedManifest = 'local-media:///fixture/fails.json'
      selected.attachments!.splice(1, 0, {
        type: 'file',
        url: reportUrl,
        reportBundleRole: 'primary-report',
        reportBundleManifestUrl: failedManifest
      })
      const originalFetch = f.fetchMock.getMockImplementation()!
      f.fetchMock.mockImplementation(async (url) => {
        if (String(url) === failedManifest) throw new Error('fixture first manifest unavailable')
        return originalFetch(url)
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await expect(request(stream, false, [selected])).rejects.toThrow(
          '本次图片数量超过限制，请分批发送'
        )
        expect(f.fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
          failedManifest,
          manifestUrl
        ])
        expect(f.completedManifestReads()).toBe(1)
        expect(f.dispatches).toHaveLength(0)
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    }
  )

  it.each([false, true])(
    'counts images exposed before a later bad manifest entry (stream=%s)',
    async (stream) => {
      const f = fixture(50)
      const originalFetch = f.fetchMock.getMockImplementation()!
      f.fetchMock.mockImplementation(async (url) => {
        if (String(url) !== manifestUrl) return originalFetch(url)
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              version: 1,
              bundleId: 'fixture',
              title: 'fixture',
              entries: [
                ...Array.from({ length: 50 }, (_, i) => ({
                  role: 'report-image',
                  fileName: `extra-${i}.png`,
                  sourceUrl: `local-media:///fixture/extra-${i}.png`
                })),
                { role: 'report-image', fileName: 'malformed.png', sourceUrl: 1 }
              ]
            })
        }
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await expect(request(stream, false, [message()])).rejects.toThrow(
          '本次图片数量超过限制，请分批发送'
        )
        expect(f.fetchMock.mock.calls.map(([url]) => String(url))).toEqual([manifestUrl])
        expect(f.dispatches).toHaveLength(0)
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    }
  )
})
