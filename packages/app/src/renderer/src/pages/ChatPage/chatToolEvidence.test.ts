import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/api/svcLLMProxy'
import { summarizeChatToolEvidence } from './chatToolEvidence'
const receipt = (toolName = 'web_search', status = 'completed', call = 'call') => ({
  runId: 'run',
  toolCallId: call,
  toolName,
  status,
  args: { secret: 'PRIVATE_ARGS' },
  content: 'PRIVATE_BODY',
  error: 'PRIVATE_ERROR'
})
const messages = (...items: unknown[]) =>
  [{ role: 'assistant', content: 'I finished everything', toolHistory: items }] as ChatMessage[]
describe('bounded tool receipts', () => {
  it('does not infer execution from assistant text', () => {
    expect(
      summarizeChatToolEvidence([{ role: 'assistant', content: 'I ran the search' }]).entries
    ).toEqual([])
  })
  it('keeps receipt status but removes arguments and bodies', () => {
    const result = summarizeChatToolEvidence(messages(receipt()))
    expect(result.entries[0]).toMatchObject({ toolName: 'web_search', status: 'completed' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(result.hasCompletedEffects).toBe(false)
  })
  it('warns conservatively for completed mutations and unresolved operations', () => {
    const result = summarizeChatToolEvidence(
      messages(receipt('files.write'), receipt('comfyui.generate', 'running', 'other'))
    )
    expect(result.hasCompletedEffects).toBe(true)
    expect(result.hasUncertainOutcome).toBe(true)
    expect(result.entries[1].status).toBe('unknown')
  })
  it('does not downgrade a completion on a late running snapshot', () => {
    expect(
      summarizeChatToolEvidence(messages(receipt(), receipt('web_search', 'running'))).entries
    ).toHaveLength(1)
    expect(
      summarizeChatToolEvidence(messages(receipt(), receipt('web_search', 'running'))).entries[0]
        .status
    ).toBe('completed')
  })
  it('separates call IDs across runs and bounds the total output', () => {
    const result = summarizeChatToolEvidence(
      messages(receipt(), { ...receipt(), runId: 'other-run' })
    )
    expect(result.entries).toHaveLength(2)
    expect(
      summarizeChatToolEvidence(
        messages(
          ...Array.from({ length: 100 }, (_, i) => receipt('files.read', 'completed', String(i)))
        )
      ).entries
    ).toHaveLength(64)
  })
})
