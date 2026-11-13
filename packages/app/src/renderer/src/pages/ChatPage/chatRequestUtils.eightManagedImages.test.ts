import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { ChatMessage } from '@shared/llm'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import type { LLMChatStreamResp } from '@shared/api/svcLLMProxy'
import { requestChatCompletion, requestChatCompletionStream } from './chatRequestUtils'

const config: Config = { ...DEFAULT_CONFIG, use_remote_llm: false, llm_config: { ...DEFAULT_CONFIG.llm_config, api_profiles: [{ id: 'fixture', provider: 'openai', deployment: 'cloud', model_use: 'chat', model_name: 'fixture', base_url: 'https://provider.invalid/v1', api_key: 'fixture', api_mode: 'responses', call_type: 'api', attachment_transports: ['request-data-url'] }] } }
const output = { transport: 'request-data-url' as const, dataUrl: 'data:image/png;base64,YQ==', mimeType: 'image/png', sizeBytes: 1 }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function messages(): ChatMessage[] {
  return [{ role: 'user', content: 'fixture', attachments: Array.from({ length: 8 }, (_, index) => {
    const hash = index.toString(16).repeat(64)
    return { type: 'image' as const, url: `local-media:///fixture/${index}.png`, fileName: `${index}.png`,
      media: { version: 1 as const, kind: 'managed' as const, relativePath: `originals/${hash.slice(0, 2)}/${hash}.png`, sha256: hash, sizeBytes: 1, mimeType: 'image/png', originalFileName: `${index}.png` } }
  }) }]
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe.each([false, true])('eight managed images, stream=%s', stream => {
  function setup() {
    const gates: Array<ReturnType<typeof deferred<typeof output>>> = []
    const hashes: string[] = [], events: string[] = []
    let active = 0, maxActive = 0
    const materializeForRequest = vi.fn(({ reference }: { reference: { sha256: string } }) => {
      hashes.push(reference.sha256); events.push(`start:${hashes.length}`)
      active++; maxActive = Math.max(maxActive, active)
      const gate = deferred<typeof output>(); gates.push(gate)
      return gate.promise.finally(() => { active--; events.push('settled') })
    })
    const chat = vi.fn(async () => { events.push('dispatch'); return { content: 'ok' } })
    const chatStream = vi.fn(async (_request: unknown, response: ServerStreaming<LLMChatStreamResp>) => {
      events.push('dispatch'); response.onData({ type: 'done', delta: '', done: true, content: 'ok', finishReason: 'stop' })
    })
    const fetchMock = vi.fn(() => { throw new Error('unexpected network') })
    vi.stubGlobal('fetch', fetchMock)
    window.api = { svcManagedMedia: { materializeForRequest }, svcLLMProxy: { chat, chatStream, remoteFetch: vi.fn() } } as unknown as Window['api']
    const input = messages(), snapshot = structuredClone(input), refs = input[0].attachments!.map(item => item.media)
    const controller = new AbortController()
    const send = () => {
      const options = { config, messages: input, profileId: 'fixture', signal: controller.signal }
      return stream ? requestChatCompletionStream({ ...options, onEvent: vi.fn() }) : requestChatCompletion(options)
    }
    const assertUnchanged = () => {
      expect(input).toEqual(snapshot)
      input[0].attachments!.forEach((item, index) => expect(item.media).toBe(refs[index]))
    }
    return { gates, hashes, events, materializeForRequest, chat, chatStream, fetchMock, input, controller, send, assertUnchanged, max: () => maxActive, active: () => active }
  }

  it('reads each different reference once in sequence before dispatch', async () => {
    const f = setup(), pending = f.send()
    for (let index = 0; index < 8; index++) {
      await vi.waitFor(() => expect(f.gates).toHaveLength(index + 1))
      expect(f.active()).toBe(1)
      expect(f.chat).not.toHaveBeenCalled(); expect(f.chatStream).not.toHaveBeenCalled()
      f.gates[index].resolve(output)
    }
    await expect(pending).resolves.toBeDefined()
    expect(f.hashes).toEqual(Array.from({ length: 8 }, (_, index) => index.toString(16).repeat(64)))
    expect(f.max()).toBe(1)
    expect(f.events.at(-1)).toBe('dispatch')
    expect(f.events.filter(event => event === 'settled')).toHaveLength(8)
    expect(stream ? f.chatStream : f.chat).toHaveBeenCalledOnce()
    expect(f.fetchMock).not.toHaveBeenCalled()
    f.assertUnchanged()
  })

  it('stops after a middle materialization error', async () => {
    const f = setup(), pending = f.send()
    const rejection = expect(pending).rejects.toThrow('fixture middle failure')
    for (let index = 0; index < 4; index++) {
      await vi.waitFor(() => expect(f.gates).toHaveLength(index + 1))
      if (index === 3) f.gates[index].reject(new Error('fixture middle failure'))
      else f.gates[index].resolve(output)
    }
    await rejection
    expect(f.materializeForRequest).toHaveBeenCalledTimes(4)
    expect(f.max()).toBe(1)
    expect(f.chat).not.toHaveBeenCalled(); expect(f.chatStream).not.toHaveBeenCalled()
    f.assertUnchanged()
  })

  it('aborts waiting in the middle without starting later attachments', async () => {
    const f = setup(), pending = f.send()
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    for (let index = 0; index < 4; index++) {
      await vi.waitFor(() => expect(f.gates).toHaveLength(index + 1))
      if (index < 3) f.gates[index].resolve(output)
    }
    f.controller.abort()
    await rejection
    expect(f.materializeForRequest).toHaveBeenCalledTimes(4)
    expect(f.active()).toBe(1)
    expect(f.chat).not.toHaveBeenCalled(); expect(f.chatStream).not.toHaveBeenCalled()
    f.gates[3].resolve(output)
    await vi.waitFor(() => expect(f.active()).toBe(0))
    expect(f.materializeForRequest).toHaveBeenCalledTimes(4)
    f.assertUnchanged()
  })

  it('documents a fresh request starting while aborted IPC work is still pending', async () => {
    const f = setup(), first = f.send()
    const aborted = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.gates).toHaveLength(1))
    f.controller.abort()
    await aborted
    expect(f.active()).toBe(1)
    const nextController = new AbortController()
    const options = { config, messages: f.input, profileId: 'fixture', signal: nextController.signal }
    const second = stream ? requestChatCompletionStream({ ...options, onEvent: vi.fn() }) : requestChatCompletion(options)
    const secondAborted = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(f.gates).toHaveLength(2))
    expect(f.active()).toBe(2)
    nextController.abort()
    await secondAborted
    f.gates[0].resolve(output); f.gates[1].resolve(output)
    await vi.waitFor(() => expect(f.active()).toBe(0))
    expect(f.materializeForRequest).toHaveBeenCalledTimes(2)
    expect(f.chat).not.toHaveBeenCalled(); expect(f.chatStream).not.toHaveBeenCalled()
    f.assertUnchanged()
  })
})
