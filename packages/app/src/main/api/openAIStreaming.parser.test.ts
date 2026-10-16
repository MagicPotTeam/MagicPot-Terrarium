import { describe, expect, it, vi } from 'vitest'
import { OpenAIRequestControl } from '../../shared/llm/openaiRequestControl'
import { readOpenAIStream } from '../../shared/llm/openaiStreaming'

const chunk = (content: string, finish: string | null = null) => ({
  choices: [{ index: 0, delta: { content }, finish_reason: finish }]
})
const response = (wire: string, slice = 1) => {
  const bytes = new TextEncoder().encode(wire)
  const cancel = vi.fn(() => new Promise<void>(() => undefined))
  let offset = 0
  return {
    cancel,
    response: new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close()
            return
          }
          controller.enqueue(bytes.slice(offset, offset + slice))
          offset = Math.min(bytes.length, offset + slice)
        },
        cancel
      })
    )
  }
}
const completionWire = (separator: string) =>
  `: heartbeat${separator}${separator}event: ignored${separator}data: ${JSON.stringify(chunk('你🙂', 'stop'))}${separator}${separator}data: [DONE]${separator}${separator}`

describe('incremental SSE framing and callback ownership', () => {
  it.each(['\n', '\r', '\r\n'])(
    'handles one-byte UTF-8 fragments and %j framing',
    async (separator) => {
      const fixture = response(completionWire(separator))
      const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
      const onDelta = vi.fn()
      try {
        await expect(
          readOpenAIStream(fixture.response, control, 'chat-completions', onDelta)
        ).resolves.toMatchObject({
          payload: { choices: [{ message: { content: '你🙂' } }] },
          finishReason: 'stop'
        })
        expect(onDelta).toHaveBeenCalledWith({
          type: 'text-delta',
          delta: '你🙂',
          metadata: { streaming: { upstreamProtocol: 'sse', upstreamIncremental: true } }
        })
      } finally {
        control.dispose()
      }
    }
  )

  it('joins multiple data lines and returns token-limit completion distinctly', async () => {
    const fixture = response(
      'data: {"type":"response.incomplete",\n' +
        'data: "response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}}\n\n'
    )
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    try {
      await expect(
        readOpenAIStream(fixture.response, control, 'responses', vi.fn())
      ).resolves.toMatchObject({ finishReason: 'length' })
    } finally {
      control.dispose()
    }
  })

  it('requires completion before DONE rather than declaring truncated output successful', async () => {
    const fixture = response(`data: ${JSON.stringify(chunk('partial'))}\n\ndata: [DONE]\n\n`)
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    try {
      await expect(
        readOpenAIStream(fixture.response, control, 'chat-completions', vi.fn())
      ).rejects.toThrow('before its terminal completion')
    } finally {
      control.dispose()
    }
  })

  it('cancels the reader when a delta callback throws, preserving the callback error', async () => {
    const fixture = response(completionWire('\n'), 1024)
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    const error = new Error('owned callback error')
    try {
      await expect(
        readOpenAIStream(fixture.response, control, 'chat-completions', () => {
          throw error
        })
      ).rejects.toBe(error)
      // A transport may already have naturally closed; the reader lock must always release.
      expect(fixture.response.body?.locked).toBe(false)
    } finally {
      control.dispose()
    }
  })

  it('stops after a terminal Responses event without waiting for more bytes or for cancellation', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"response.completed","response":{"output":[]}}\n\n'
          )
        )
      },
      cancel
    })
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    const resp = new Response(stream)
    try {
      await expect(readOpenAIStream(resp, control, 'responses', vi.fn())).resolves.toMatchObject({
        finishReason: 'stop'
      })
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(resp.body?.locked).toBe(false)
    } finally {
      control.dispose()
    }
  })

  it.each(['parse', 'normalize'] as const)(
    'rejects expiry during terminal %s work rather than returning success',
    async (phase) => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
      const control = new OpenAIRequestControl(vi.fn<typeof fetch>(), undefined, 1_000)
      const fixture = response('data: {"type":"response.completed","response":{"output":[]}}\n\n')
      const originalParse = JSON.parse
      const parse = vi.spyOn(JSON, 'parse').mockImplementation((text) => {
        const value = originalParse(text)
        if (value.type === 'response.completed') {
          if (phase === 'parse') clock.mockReturnValue(1_001)
          else
            value.response.output = [
              {
                get content() {
                  clock.mockReturnValue(1_001)
                  return []
                }
              }
            ]
        }
        return value
      })
      try {
        await expect(
          readOpenAIStream(fixture.response, control, 'responses', vi.fn())
        ).rejects.toMatchObject({ name: 'TimeoutError' })
        expect(fixture.response.body?.locked).toBe(false)
      } finally {
        control.dispose()
        parse.mockRestore()
        clock.mockRestore()
      }
    }
  )

  it('does not accept an unterminated completion frame at EOF', async () => {
    const fixture = response('data: {"type":"response.completed","response":{"output":[]}}')
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    try {
      await expect(
        readOpenAIStream(fixture.response, control, 'responses', vi.fn())
      ).rejects.toThrow('incomplete event')
    } finally {
      control.dispose()
    }
  })

  it('rejects content after an already-finished chat choice', async () => {
    const fixture = response(
      `data: ${JSON.stringify(chunk('first', 'stop'))}\n\ndata: ${JSON.stringify(chunk('late'))}\n\ndata: [DONE]\n\n`
    )
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    const onDelta = vi.fn()
    try {
      await expect(
        readOpenAIStream(fixture.response, control, 'chat-completions', onDelta)
      ).rejects.toThrow('after its finish marker')
      expect(onDelta).toHaveBeenCalledTimes(1)
    } finally {
      control.dispose()
    }
  })

  it('rejects an unknown finish reason rather than inventing success', async () => {
    const fixture = response(
      `data: ${JSON.stringify(chunk('owned', 'unknown-owned'))}\n\ndata: [DONE]\n\n`
    )
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    try {
      await expect(
        readOpenAIStream(fixture.response, control, 'chat-completions', vi.fn())
      ).rejects.toThrow('unknown finish reason')
    } finally {
      control.dispose()
    }
  })

  it('bounds generated text independently of the larger image event budget', async () => {
    const wire = 'data: ' + JSON.stringify(chunk('x'.repeat(8 * 1024 * 1024 + 1), 'stop')) + '\n\n'
    const fixture = response(wire, 16_384)
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    const onDelta = vi.fn()
    try {
      await expect(
        readOpenAIStream(fixture.response, control, 'chat-completions', onDelta)
      ).rejects.toThrow('text exceeds its byte limit')
      expect(onDelta).not.toHaveBeenCalled()
    } finally {
      control.dispose()
    }
  })

  it('keeps partial image previews out of final attachments and promotes only a completed image call', async () => {
    const preview = {
      type: 'response.image_generation_call.partial_image',
      partial_image_index: 0,
      image_url: 'data:image/png;base64,preview-only'
    }
    const completedImage = {
      type: 'image_generation_call',
      id: 'image-call-1',
      output_index: 0,
      result: {
        image_url: {
          url: 'data:image/png;base64,final-image'
        }
      }
    }
    const wire = [
      `data: ${JSON.stringify(preview)}`,
      '',
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: completedImage })}`,
      '',
      `data: ${JSON.stringify({ type: 'response.completed', response: { output: [] } })}`,
      '',
      ''
    ].join('\n')
    const fixture = response(wire)
    const control = new OpenAIRequestControl(vi.fn<typeof fetch>())
    try {
      const result = await readOpenAIStream(fixture.response, control, 'responses', vi.fn())
      const output = (result.payload.output || []) as Array<Record<string, unknown>>
      expect(output).toHaveLength(1)
      expect(output[0]).toEqual(completedImage)
      expect(JSON.stringify(output)).not.toContain('preview-only')
      expect(JSON.stringify(output)).toContain('final-image')
    } finally {
      control.dispose()
    }
  })
})
