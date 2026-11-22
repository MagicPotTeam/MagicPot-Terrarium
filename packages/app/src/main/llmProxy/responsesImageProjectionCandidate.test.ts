import { describe, expect, it, vi } from 'vitest'
import { buildOpenAIResponsesInput, type OpenAIResponsesInputMessage } from '../../shared/llm/openaiResponses'
import { prepareResponsesImageProjection, type ResponsesProjectionBatch } from './responsesImageProjectionCandidate'

const data = (bytes: string, mime = 'png') => `data:image/${mime};base64,${Buffer.from(bytes).toString('base64')}`
const projection = (...urls: string[]): OpenAIResponsesInputMessage[] => [{
  role: 'user', content: [{ type: 'input_text', text: 'text' }, ...urls.map(url => ({ type: 'input_image' as const, image_url: url }))]
}]
const batch = () => vi.fn<ResponsesProjectionBatch>(async sources => sources.map(() => ({
  bytes: Uint8Array.from([7, 8, 9]), mimeType: 'image/jpeg' as const
})))

describe('Responses provider projection image preparation', () => {
  it('preserves projected assistant history, text, detail, repeated occurrences, HTTP and source objects', async () => {
    const input = buildOpenAIResponsesInput([
      { role: 'user', content: 'early', attachments: [{ type: 'image', url: data('early') }] },
      { role: 'assistant', content: 'answer', attachments: [{ type: 'image', url: data('assistant'), imageDetail: 'low' }] },
      { role: 'user', content: 'now', attachments: [{ type: 'image', url: data('now') }, { type: 'image', url: data('now') }, { type: 'image', url: 'https://fixture.invalid/image' }] }
    ], { imageHistory: 'all' })
    const original = structuredClone(input)
    const prepare = batch()
    const output = await prepareResponsesImageProjection(input, prepare)
    expect(input).toEqual(original)
    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare.mock.calls[0][0].map(bytes => Buffer.from(bytes).toString())).toEqual(['early', 'assistant', 'now', 'now'])
    expect(output).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'early' }, { type: 'input_image', image_url: data('\x07\x08\t', 'jpeg') }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'Reference image(s) from the previous assistant response:' }, { type: 'input_image', image_url: data('\x07\x08\t', 'jpeg'), detail: 'low' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'now' }, { type: 'input_image', image_url: data('\x07\x08\t', 'jpeg') }, { type: 'input_image', image_url: data('\x07\x08\t', 'jpeg') }, { type: 'input_image', image_url: 'https://fixture.invalid/image' }] }
    ])
  })

  it('rejects 51 image occurrences, invalid base64, or unsupported URLs before preparation', async () => {
    const cases = [
      projection(...Array.from({ length: 51 }, () => data('x'))), projection(data('ok'), 'data:image/png;base64,a==='),
      projection(data('ok'), 'local-media://fixture')
    ]
    for (const input of cases) {
      const prepare = batch(), before = structuredClone(input)
      await expect(prepareResponsesImageProjection(input, prepare)).rejects.toThrow()
      expect(prepare).not.toHaveBeenCalled()
      expect(input).toEqual(before)
    }
  })

  it('accepts exactly 50 inline occurrences and rejects a 20 MiB per-image or 32 MiB aggregate overage before preparation', async () => {
    const valid = batch()
    await expect(prepareResponsesImageProjection(projection(...Array.from({ length: 50 }, () => data('a'))), valid)).resolves.toHaveLength(1)
    expect(valid.mock.calls[0][0]).toHaveLength(50)
    for (const urls of [
      [`data:image/png;base64,${Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')}`],
      Array.from({ length: 2 }, () => `data:image/png;base64,${Buffer.alloc(17 * 1024 * 1024).toString('base64')}`)
    ]) {
      const prepare = batch()
      await expect(prepareResponsesImageProjection(projection(...urls), prepare)).rejects.toThrow()
      expect(prepare).not.toHaveBeenCalled()
    }
  }, 30_000)

  it('preserves GIF bytes while preparing other inline images and still charges GIF input budgets', async () => {
    const gif = data('GIF89a', 'gif')
    const prepare = batch()
    const input = projection(gif, data('png'))
    const output = await prepareResponsesImageProjection(input, prepare)
    expect(output[0].content[1]).toEqual({ type: 'input_image', image_url: gif })
    expect(prepare.mock.calls[0][0].map(bytes => Buffer.from(bytes).toString())).toEqual(['png'])
    const never = batch()
    await expect(prepareResponsesImageProjection(projection(gif), never)).resolves.toEqual(projection(gif))
    expect(never).not.toHaveBeenCalled()
    for (const urls of [
      [`data:image/gif;base64,${Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64')}`],
      Array.from({ length: 2 }, () => `data:image/gif;base64,${Buffer.alloc(17 * 1024 * 1024).toString('base64')}`)
    ]) {
      await expect(prepareResponsesImageProjection(projection(...urls), never)).rejects.toThrow('Image source budget exceeded')
      expect(never).not.toHaveBeenCalled()
    }
  }, 30_000)

  it('fails closed on abort, rejected/malformed/missing/over-budget encoder results; never returns original image as fallback', async () => {
    const input = projection(data('abc'))
    const controller = new AbortController(); controller.abort()
    const never = batch()
    await expect(prepareResponsesImageProjection(input, never, controller.signal)).rejects.toThrow()
    expect(never).not.toHaveBeenCalled()
    const cases: ResponsesProjectionBatch[] = [
      async () => { throw new Error('codec failed') }, async () => [],
      async () => [{ bytes: new Uint8Array(), mimeType: 'image/jpeg' }],
      async () => [{ bytes: new Uint8Array(512_001), mimeType: 'image/jpeg' }],
      async () => [{ bytes: Uint8Array.of(1), mimeType: 'image/gif' as 'image/jpeg' }]
    ]
    for (const prepare of cases) await expect(prepareResponsesImageProjection(input, prepare)).rejects.toThrow()
  })

  it('detaches all projection fields before awaiting the batch and observes late cancellation', async () => {
    const input = projection(data('abc'), 'https://fixture.invalid/before')
    const original = structuredClone(input)
    let release!: (value: Array<{ bytes: Uint8Array; mimeType: 'image/jpeg' }>) => void
    const prepare = vi.fn<ResponsesProjectionBatch>(() => new Promise(resolve => { release = resolve }))
    const result = prepareResponsesImageProjection(input, prepare)
    input[0].role = 'assistant'
    input[0].content[0] = { type: 'input_text', text: 'changed' }
    input[0].content[2] = { type: 'input_image', image_url: 'https://fixture.invalid/after' }
    release([{ bytes: Uint8Array.of(7, 8, 9), mimeType: 'image/jpeg' }])
    const output = await result
    expect(output[0].role).toBe(original[0].role)
    expect(output[0].content[0]).toEqual(original[0].content[0])
    expect(output[0].content[2]).toEqual(original[0].content[2])
    const controller = new AbortController()
    let finish!: (value: Array<{ bytes: Uint8Array; mimeType: 'image/jpeg' }>) => void
    const work = prepareResponsesImageProjection(projection(data('abc')), () => new Promise(resolve => { finish = resolve }), controller.signal)
    controller.abort(); finish([{ bytes: Uint8Array.of(7), mimeType: 'image/jpeg' }])
    await expect(work).rejects.toThrow()
  })
})
