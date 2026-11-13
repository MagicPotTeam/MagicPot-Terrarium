import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAIAPICli,
  type OpenAIClientOptions,
  type OpenAIResponsesInputPreparer
} from './clients'
import type { OpenAIResponsesInputMessage } from './openaiResponses'
import * as budget from './providerJsonBudget'
import type { ChatMessage } from './types'

const sourceUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
const preparedUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC'
const remoteUrl = 'https://images.invalid/retained.png'
const payload = {
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }]
}
const response = (stream = false): Response =>
  stream
    ? new Response(
        'data: ' +
          JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' }) +
          '\n\n' +
          'data: ' +
          JSON.stringify({ type: 'response.completed', response: payload }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    : Response.json(payload)

const messages = (): ChatMessage[] => [
  { role: 'user', content: 'Earlier reference', attachments: [{ type: 'image', url: sourceUrl }] },
  { role: 'assistant', content: 'Earlier answer' },
  {
    role: 'user',
    content: 'Compare these',
    attachments: [
      { type: 'image', url: sourceUrl, imageDetail: 'low' },
      { type: 'image', url: remoteUrl }
    ]
  }
]

// This fixture replaces an already-built provider projection. Codec behavior is
// covered by the MAIN worker tests; every network response here is a local mock.
const prepareCopy = (
  input: readonly OpenAIResponsesInputMessage[]
): OpenAIResponsesInputMessage[] =>
  input.map((message) => ({
    ...message,
    content: message.content.map((part) =>
      part.type === 'input_image' && part.image_url.startsWith('data:')
        ? { ...part, image_url: preparedUrl }
        : { ...part }
    )
  }))

const setup = (
  prepareResponsesInput: OpenAIResponsesInputPreparer,
  options: Partial<OpenAIClientOptions> = {}
) => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
    response(Boolean(JSON.parse(String(init?.body)).stream))
  )
  const client = new OpenAIAPICli('fixture', 'https://provider.invalid/v1', 'fixture-model', {
    apiMode: 'responses',
    enableHostedTools: false,
    enableHostedWebSearch: false,
    fetchImpl,
    prepareResponsesInput,
    ...options
  })
  return { client, fetchImpl }
}

const observe = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error })
  )

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('MAIN-owned Responses input preparation', () => {
  it.each([false, true])(
    'sends the prepared provider projection without changing original messages (stream=%s)',
    async (stream) => {
      const prepare = vi.fn<OpenAIResponsesInputPreparer>(async (input) => prepareCopy(input))
      const { client, fetchImpl } = setup(prepare)
      const input = messages()
      const before = structuredClone(input)
      const onDelta = vi.fn()
      await expect(
        client.chat({ messages: input, imageHistoryPolicy: 'all', ...(stream ? { onDelta } : {}) })
      ).resolves.toMatchObject({ content: 'ok' })

      expect(prepare).toHaveBeenCalledOnce()
      expect(prepare.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
      expect(fetchImpl).toHaveBeenCalledOnce()
      const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
      const parts = body.input.flatMap((message: OpenAIResponsesInputMessage) => message.content)
      expect(parts.filter((part: { type: string }) => part.type === 'input_image')).toEqual([
        { type: 'input_image', image_url: preparedUrl },
        { type: 'input_image', image_url: preparedUrl, detail: 'low' },
        { type: 'input_image', image_url: remoteUrl }
      ])
      expect(parts).toContainEqual({ type: 'input_text', text: 'Compare these' })
      expect(input).toEqual(before)
      if (stream)
        expect(onDelta).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'text-delta', delta: 'ok' })
        )
    }
  )

  it('prepares only the selected history and preserves the original earlier images', async () => {
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(async (input) => prepareCopy(input))
    const { client } = setup(prepare)
    const input = messages()
    const before = structuredClone(input)
    await client.chat({ messages: input, imageHistoryPolicy: 'latest-user-turn' })
    const selectedImages = prepare.mock.calls[0][0]
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'input_image')
    expect(selectedImages).toHaveLength(2)
    expect(input).toEqual(before)
  })

  it('prepares oversized source URLs before enforcing the provider body budget', async () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024)
    const input: ChatMessage[] = [
      {
        role: 'user',
        content: 'Compare',
        attachments: Array.from({ length: 29 }, () => ({ type: 'image', url }))
      }
    ]
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(async (projection) =>
      prepareCopy(projection)
    )
    const { client, fetchImpl } = setup(prepare)
    await expect(client.chat({ messages: input })).resolves.toMatchObject({ content: 'ok' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(budget.providerJsonUtf8Bytes(String(fetchImpl.mock.calls[0][1]?.body))).toBeLessThan(
      budget.DEFAULT_PROVIDER_JSON_MAX_BYTES
    )
    expect(input[0].attachments?.every((item) => item.url === url)).toBe(true)
  })

  it('does not retry local preparation failures or start hosted setup/model fetch', async () => {
    const prepare = vi
      .fn<OpenAIResponsesInputPreparer>()
      .mockRejectedValue(
        Object.assign(new Error('server overloaded at private-source-path'), { status: 503 })
      )
    const { client, fetchImpl } = setup(prepare, { enableHostedTools: true })
    const result = await observe(
      client.chat({
        messages: [
          ...messages(),
          {
            role: 'user',
            content: 'Read file too',
            attachments: [
              {
                type: 'file',
                fileName: 'note.txt',
                mimeType: 'text/plain',
                url: 'data:text/plain;base64,b3duZWQ='
              }
            ]
          }
        ],
        imageHistoryPolicy: 'all',
        retryCapacity: true
      })
    )
    expect(result.error).toMatchObject({
      message: 'Unable to prepare an image attachment for the model.',
      retryBlocked: true
    })
    expect(String(result.error)).not.toContain('private-source-path')
    expect(prepare).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('propagates cancellation to preparation and rejects a late success before POST', async () => {
    const controller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    let preparationSignal!: AbortSignal
    const prepare = vi.fn<OpenAIResponsesInputPreparer>((input, signal) => {
      preparationSignal = signal
      entered()
      return new Promise((resolve) => {
        release = () => resolve(prepareCopy(input))
      })
    })
    const { client, fetchImpl } = setup(prepare)
    const pending = observe(
      client.chat({ messages: messages(), signal: controller.signal, retryCapacity: true })
    )
    await started
    controller.abort()
    expect(preparationSignal.aborted).toBe(true)
    release()
    expect((await pending).error).toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps the request deadline reason when preparation rejects after timeout', async () => {
    vi.useFakeTimers()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let rejectPreparation!: () => void
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(() => {
      entered()
      return new Promise((_resolve, reject) => {
        rejectPreparation = () => reject(new Error('worker stopped'))
      })
    })
    const { client, fetchImpl } = setup(prepare, { requestTimeoutMs: 1000 })
    const pending = observe(client.chat({ messages: messages(), retryCapacity: true }))
    await started
    await vi.advanceTimersByTimeAsync(1000)
    rejectPreparation()
    expect((await pending).error).toMatchObject({
      code: 'MODEL_REQUEST_TIMEOUT',
      retryBlocked: true
    })
    expect(prepare).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still rejects an oversized prepared image projection before JSON and fetch', async () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024)
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(async () => [
      {
        role: 'user',
        content: Array.from({ length: 29 }, () => ({ type: 'input_image', image_url: url }))
      }
    ])
    const serialize = vi.spyOn(budget, 'serializeProviderJsonWithBudget')
    const { client, fetchImpl } = setup(prepare, { enableHostedTools: true })
    await expect(client.chat({ messages: messages() })).rejects.toBeInstanceOf(
      budget.ProviderJsonBudgetError
    )
    expect(prepare).toHaveBeenCalledOnce()
    expect(serialize).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps the complete JSON budget after preparation for text and tool overhead', async () => {
    const real = budget.serializeProviderJsonWithBudget
    vi.spyOn(budget, 'serializeProviderJsonWithBudget').mockImplementation((value) =>
      real(value, 512)
    )
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(async (input) => prepareCopy(input))
    const { client, fetchImpl } = setup(prepare, { enableHostedTools: true })
    await expect(
      client.chat({
        messages: messages(),
        systemPrompt: 'T'.repeat(1024),
        tools: [{ name: 'fixture', description: 'tool', inputSchema: { type: 'object' } }]
      })
    ).rejects.toBeInstanceOf(budget.ProviderJsonBudgetError)
    expect(prepare).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('leaves hosted image-generation reference bytes untouched', async () => {
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(async (input) => prepareCopy(input))
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ output: [{ type: 'image_generation_call', result: 'aGVsbG8=' }] })
    )
    const { client } = setup(prepare, { fetchImpl })
    const input = messages()
    const before = structuredClone(input)
    await client.chat({
      messages: input,
      imageHistoryPolicy: 'all',
      imageGenerationOptions: { enabled: true, action: 'edit' }
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))
    expect(
      body.input.flatMap((message: OpenAIResponsesInputMessage) => message.content)
    ).toContainEqual({
      type: 'input_image',
      image_url: sourceUrl,
      detail: 'low'
    })
    expect(input).toEqual(before)
  })

  it('does not prepare the separate Images API route', async () => {
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(async (input) => prepareCopy(input))
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ b64_json: 'aGVsbG8=' }] })
    )
    const { client } = setup(prepare, { apiMode: 'images', modelUse: 'image', fetchImpl })
    await client.chat({
      messages: [{ role: 'user', content: 'Draw a fixture' }],
      imageGenerationOptions: { enabled: true, action: 'generate' }
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('does not prepare Chat Completions requests', async () => {
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(async (input) => prepareCopy(input))
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ choices: [{ message: { content: 'ok' } }] })
    )
    const { client } = setup(prepare, { apiMode: 'chat-completions', fetchImpl })
    await client.chat({
      messages: [
        { role: 'user', content: 'Analyze', attachments: [{ type: 'image', url: sourceUrl }] }
      ]
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(String(fetchImpl.mock.calls[0][1]?.body)).toContain(sourceUrl)
  })

  it('reuses a prepared projection for capacity retry but prepares the next tool turn separately', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const prepare = vi.fn<OpenAIResponsesInputPreparer>(async (input) => prepareCopy(input))
    let attempts = 0
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      ++attempts === 1
        ? new Response('{"error":{"code":"server_overloaded"}}', {
            status: 503,
            headers: { 'retry-after': '1' }
          })
        : response()
    )
    const { client } = setup(prepare, { fetchImpl })
    const input = messages()
    const before = structuredClone(input)
    const pending = observe(
      client.chat({ messages: input, imageHistoryPolicy: 'all', retryCapacity: true })
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect((await pending).value).toMatchObject({ content: 'ok' })
    expect(prepare).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(fetchImpl.mock.calls[1][1]?.body)
    const key = (index: number) =>
      new Headers(fetchImpl.mock.calls[index][1]?.headers).get('idempotency-key')
    expect(key(0)).toBeTruthy()
    expect(key(1)).toBe(key(0))
    await client.chat({
      messages: input,
      imageHistoryPolicy: 'all',
      retryCapacity: true,
      toolTurns: [
        {
          content: '',
          calls: [
            { id: 'call_fixture', name: 'files.read', wireName: 'mp_tool_0', arguments: '{}' }
          ],
          results: [{ callId: 'call_fixture', output: 'fixture result' }]
        }
      ]
    })
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(key(2)).not.toBe(key(0))
    expect(String(fetchImpl.mock.calls[2][1]?.body)).toContain('fixture result')
    expect(input).toEqual(before)
  })
})
