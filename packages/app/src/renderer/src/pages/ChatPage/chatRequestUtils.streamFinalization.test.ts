import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { createIpcClient } from '@shared/api/createClient/createIpcClient'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletionStream } from './chatRequestUtils'

vi.mock('electron', () => ({ ipcRenderer: { postMessage: vi.fn(), invoke: vi.fn() } }))

const config: Config = {
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [] }
}

const runStream = (events: LLMChatStreamResp[]) => {
  const chatStream = vi.fn(
    async (_request: unknown, response: { onData: (chunk: LLMChatStreamResp) => void }) => {
      for (const event of events) response.onData(event)
    }
  )
  vi.stubGlobal('api', { svcLLMProxy: { chatStream } })
  return requestChatCompletionStream({
    config,
    messages: [{ role: 'user', content: 'Fixture completion only' }],
    onEvent: vi.fn()
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('IPC stream terminal content', () => {
  const delta: LLMChatStreamResp = { type: 'text-delta', delta: 'Keep this text', done: false }
  const done: LLMChatStreamResp = { type: 'done', delta: '', done: true, finishReason: 'stop' }

  it('retains accumulated deltas when a terminal frame omits both content fields', async () => {
    await expect(runStream([delta, done])).resolves.toMatchObject({
      response: delta.delta,
      result: { content: delta.delta, finishReason: 'stop' }
    })
  })

  it('retains text alongside terminal attachments, metadata and usage', async () => {
    const attachment = { type: 'image' as const, url: 'data:image/png;base64,fixture' }
    const metadata = { toolHistory: [{ toolCallId: 'owned', status: 'completed' }] }
    await expect(
      runStream([
        delta,
        { ...done, attachments: [attachment], metadata, usage: { promptTokens: 3 } }
      ])
    ).resolves.toMatchObject({
      response: delta.delta,
      result: {
        content: delta.delta,
        attachments: [attachment],
        metadata,
        usage: { promptTokens: 3 }
      }
    })
  })

  it.each(['content', 'fullContent'] as const)(
    'keeps an explicitly empty terminal %s authoritative',
    async (field) => {
      await expect(runStream([delta, { ...done, [field]: '' }])).resolves.toMatchObject({
        response: '',
        result: { content: '' }
      })
    }
  )

  it.each(['content', 'fullContent'] as const)(
    'uses a terminal %s snapshot instead of appending it to deltas',
    async (field) => {
      await expect(
        runStream([delta, { ...done, [field]: 'Final authoritative snapshot' }])
      ).resolves.toMatchObject({
        response: 'Final authoritative snapshot',
        result: { content: 'Final authoritative snapshot' }
      })
    }
  )

  it('ignores data arriving after the terminal frame', async () => {
    await expect(
      runStream([delta, done, { type: 'text-delta', delta: ' late', done: false }])
    ).resolves.toMatchObject({ response: delta.delta })
  })

  it('continues to reject streams that have no terminal frame', async () => {
    await expect(runStream([delta])).rejects.toMatchObject({
      message: expect.stringContaining('incomplete-stream'),
      partialContent: delta.delta
    })
  })

  it('retains an error followed by done rather than treating final text as success', async () => {
    const metadata = { toolHistory: [{ toolCallId: 'owned', status: 'completed' }] }
    await expect(
      runStream([
        delta,
        { type: 'error', delta: '', done: false, error: 'Owned error', status: 503 },
        { ...done, content: 'Final partial text', metadata, finishReason: 'error' }
      ])
    ).rejects.toMatchObject({
      message: 'Owned error',
      status: 503,
      partialContent: 'Final partial text',
      metadata
    })
  })
})

describe('IPC stream protocol failures through real client callbacks', () => {
  it.each(['retry', 'tool-status'] as const)(
    'rejects invalid %s events immediately with partial text and checkpoints intact',
    async (type) => {
      const channels: FakeMessageChannel[] = []
      vi.stubGlobal(
        'MessageChannel',
        class extends FakeMessageChannel {
          constructor() {
            super()
            channels.push(this)
          }
        }
      )
      const api = createIpcClient<{
        svcLLMProxy: {
          chatStream(request: unknown, response: ServerStreaming<LLMChatStreamResp>): Promise<void>
        }
      }>({ svcLLMProxy: { chatStream: { type: 'serverStreaming' } } })
      vi.stubGlobal('api', api)
      const onEvent = vi.fn()
      const pending = requestChatCompletionStream({
        config,
        messages: [{ role: 'user', content: 'Fixture protocol failure' }],
        onEvent
      }).catch((error: unknown) => error)
      await vi.waitFor(() => expect(channels).toHaveLength(1))
      const port = channels[0].port1
      const deliver = port.onmessage!
      const metadata = { toolHistory: [{ toolCallId: 'owned', status: 'completed' }] }
      deliver({
        data: { data: { type: 'text-delta', delta: 'Keep partial', done: false, metadata } }
      })
      expect(() => deliver({ data: { data: { type, delta: '', done: false } } })).not.toThrow()

      expect(await pending).toMatchObject({
        message: expect.stringMatching(/invalid.*(retry|tool-status)/i),
        partialContent: 'Keep partial',
        metadata
      })
      expect(port.closed).toBe(true)
      deliver({ data: { data: { type: 'done', delta: '', done: true, content: 'Late success' } } })
      expect(onEvent.mock.calls).toEqual([[{ type: 'text-delta', delta: 'Keep partial' }]])
    }
  )
})

class FakeMessagePort {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onmessageerror: ((event: { data: unknown }) => void) | null = null
  closed = false
  private readonly listeners = new Map<string, () => void>()

  addEventListener(type: string, callback: () => void) {
    this.listeners.set(type, callback)
  }

  removeEventListener(type: string, callback: () => void) {
    if (this.listeners.get(type) === callback) this.listeners.delete(type)
  }

  close() {
    this.closed = true
    this.listeners.get('close')?.()
  }
}

class FakeMessageChannel {
  port1 = new FakeMessagePort()
  port2 = {}
}
