import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { mergeToolCheckpoint } from './chatToolCheckpoint'
import { removeTrailingEmptyAssistantMessage } from './chatSessionUtils'
import { requestChatCompletionStream } from './chatRequestUtils'
import type { ChatSession } from './chatStorage'

const entry = {
  runId: 'run-a',
  toolCallId: 'call-a',
  toolName: 'files.write',
  args: { path: 'owned.txt' },
  status: 'completed' as const,
  content: 'OWNED_TOOL_RESULT'
}
const status = {
  runId: entry.runId,
  toolCallId: entry.toolCallId,
  toolName: entry.toolName,
  status: entry.status
}
afterEach(() => vi.restoreAllMocks())

describe('completed tool checkpoints', () => {
  it('accepts completed evidence and keeps it when an incoming snapshot is shorter', () => {
    const first = mergeToolCheckpoint(undefined, [entry], status)!
    const second = { ...entry, toolCallId: 'call-b', content: 'second' }
    const merged = mergeToolCheckpoint(first, [second], { ...status, toolCallId: 'call-b' })!
    expect(merged).toEqual([entry, second])
    expect(mergeToolCheckpoint(merged, [entry], status)).toBeUndefined()
  })
  it.each(
    [
      [{ ...entry, runId: 'foreign' }],
      [entry, entry],
      [{ ...entry, toolCallId: 'foreign-call' }],
      [{ ...entry, status: 'running' }],
      [{ ...entry, args: null }],
      Array.from({ length: 65 }, (_, i) => ({ ...entry, toolCallId: 'call-' + i }))
    ].map((snapshot) => ({ snapshot }))
  )('rejects invalid, foreign, duplicate or oversized snapshots %#', ({ snapshot }) => {
    expect(mergeToolCheckpoint(undefined, snapshot, status)).toBeUndefined()
  })
  it('does not rewrite a previously completed effect', () => {
    expect(
      mergeToolCheckpoint([entry], [{ ...entry, content: 'replacement' }], status)
    ).toBeUndefined()
    expect(
      mergeToolCheckpoint([entry], [{ ...entry, runId: 'new-run' }], {
        ...status,
        runId: 'new-run'
      })
    ).toBeUndefined()
  })
  it('does not remove an assistant message that contains only tool evidence', () => {
    const session: ChatSession = {
      id: 'owned',
      title: 'owned',
      messages: [
        { role: 'user', content: 'write' },
        { role: 'assistant', content: '', toolHistory: [entry] }
      ]
    }
    expect(removeTrailingEmptyAssistantMessage([session], 'owned')[0]).toBe(session)
    const empty = { ...session, messages: [{ role: 'assistant' as const, content: '' }] }
    expect(removeTrailingEmptyAssistantMessage([empty], 'owned')[0].messages).toEqual([])
  })
  it('forwards tool checkpoints from IPC before the stream is complete', async () => {
    const onEvent = vi.fn()
    const chatStream = vi.fn(async (_request, response) => {
      response.onData({
        type: 'tool-status',
        toolStatus: status,
        metadata: { runId: entry.runId, toolHistory: [entry] }
      })
      expect(onEvent).toHaveBeenCalledWith({
        type: 'tool-status',
        toolStatus: status,
        toolHistory: [entry]
      })
      response.onData({ type: 'done', content: 'done', fullContent: 'done', done: true })
    })
    const previous = window.api
    window.api = {
      svcLLMProxy: { chatStream, cancelConversation: vi.fn() }
    } as unknown as Window['api']
    try {
      await requestChatCompletionStream({
        config: { ...DEFAULT_CONFIG, use_remote_llm: false },
        messages: [{ role: 'user', content: 'owned' }],
        conversationId: 'owned',
        onEvent
      })
      expect(chatStream).toHaveBeenCalledOnce()
    } finally {
      window.api = previous
    }
  })
})
