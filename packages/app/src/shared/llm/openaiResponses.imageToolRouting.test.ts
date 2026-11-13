import { describe, expect, it } from 'vitest'
import { shouldUseOpenAIImageGeneration } from './openaiResponses'
import { OpenAIAPICli } from './clients'
import type { ChatMessage } from './types'

const messages: ChatMessage[] = [{ role: 'user', content: 'Please generate a picture of a frog.' }]

describe('ordinary image tool routing does not activate hosted generation', () => {
  it('preserves legacy automatic intent unless MAIN suppresses it', () => {
    expect(shouldUseOpenAIImageGeneration({ messages })).toBe(true)
    expect(
      shouldUseOpenAIImageGeneration({ messages, disableAutomaticImageGeneration: true })
    ).toBe(false)
  })

  it.each([
    { modelUse: 'image' as const },
    { imageGenerationOptions: { enabled: true } },
    { imageGenerationOptions: { action: 'generate' as const } },
    { imageGenerationOptions: { action: 'edit' as const } }
  ])('does not change explicit legacy image routing %j', (explicit) => {
    expect(
      shouldUseOpenAIImageGeneration({
        messages,
        ...explicit,
        disableAutomaticImageGeneration: true
      })
    ).toBe(true)
  })

  it.each(['responses', 'chat-completions'] as const)(
    'keeps native function declarations in %s despite image-intent text',
    async (apiMode) => {
      const requests: { endpoint: string; body: Record<string, unknown> }[] = []
      const cli = new OpenAIAPICli('fixture-key', 'https://provider.fixture/v1', 'text-model', {
        apiMode,
        enableHostedTools: false,
        fetchImpl: async (input, init) => {
          const body = JSON.parse(String(init?.body))
          requests.push({ endpoint: String(input), body })
          return Response.json(
            apiMode === 'responses'
              ? {
                  output: [
                    { type: 'message', content: [{ type: 'output_text', text: 'tool planning' }] }
                  ]
                }
              : { choices: [{ message: { content: 'tool planning' }, finish_reason: 'stop' }] }
          )
        }
      })
      const result = await cli.chat({
        messages,
        tools: [
          {
            name: 'image_gen',
            description: 'approved ordinary tool',
            inputSchema: { type: 'object' }
          }
        ],
        disableAutomaticImageGeneration: true
      })
      expect(result.content).toBe('tool planning')
      expect(requests).toHaveLength(1)
      expect(requests[0].endpoint).toBe(
        apiMode === 'responses'
          ? 'https://provider.fixture/v1/responses'
          : 'https://provider.fixture/v1'
      )
      const tools = requests[0].body.tools as { type: string }[]
      expect(tools).toHaveLength(1)
      expect(tools[0].type).toBe('function')
    }
  )
})
