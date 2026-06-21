import { describe, expect, it } from 'vitest'
import {
  appendChatThreadMemoryEntries,
  appendChatThreadToolHistory,
  buildScratchpadContext,
  buildThreadMemoryContextPrompt,
  buildToolMemoryEntry,
  buildTurnMemoryEntries,
  createSuccessfulToolHistoryEntry,
  normalizeChatThreadState,
  searchChatThreadMemory,
  type ChatThreadMemoryEntry
} from './chatThreadState'

describe('chatThreadState', () => {
  it('normalizes persisted thread memory, tool history and compression records', () => {
    const state = normalizeChatThreadState({
      scratchpad: '  plan before calling tools  ',
      memoryEntries: [
        {
          id: 'memory-1',
          kind: 'turn',
          title: 'User plan',
          text: 'Keep this fact',
          createdAt: 100
        },
        {
          id: 'empty-memory',
          kind: 'turn',
          title: 'empty',
          text: '   ',
          createdAt: 100
        }
      ],
      toolHistory: [
        {
          id: 'tool-1',
          toolName: 'workspace.inspect',
          status: 'unexpected-status',
          startedAt: 200,
          resultPreview: 'ok'
        }
      ],
      compressionRecords: [
        {
          id: 'compression-1',
          sourceHash: 'hash-1',
          summary: 'compressed older context',
          createdAt: 300,
          coveredMessageCount: 4,
          estimatedSourceTokens: 1000,
          estimatedSummaryTokens: 80
        }
      ]
    })

    expect(state.scratchpad).toBe('plan before calling tools')
    expect(state.memoryEntries).toHaveLength(1)
    expect(state.memoryEntries?.[0]).toMatchObject({ id: 'memory-1', text: 'Keep this fact' })
    expect(state.toolHistory).toHaveLength(1)
    expect(state.toolHistory?.[0]).toMatchObject({
      id: 'tool-1',
      toolName: 'workspace.inspect',
      status: 'success'
    })
    expect(state.compressionRecords?.[0]).toMatchObject({
      id: 'compression-1',
      sourceHash: 'hash-1',
      summary: 'compressed older context'
    })
  })

  it('builds turn memory entries from user and assistant messages', () => {
    const entries = buildTurnMemoryEntries(
      { role: 'user', content: 'Remember the red node needs repair.' },
      [{ role: 'assistant', content: 'I will inspect the red node first.' }],
      1234
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'turn', createdAt: 1234 })
    expect(entries[0].title).toContain('Remember the red node')
    expect(entries[0].text).toContain('User: Remember the red node needs repair.')
    expect(entries[0].text).toContain('Assistant: I will inspect the red node first.')
  })

  it('searches memory records while injecting only durable tool/compression context', () => {
    const toolEntry = createSuccessfulToolHistoryEntry({
      toolName: 'workspace.inspect',
      args: { workspaceId: 'canvas-1' },
      startedAt: 1000,
      result: 'Canvas has two disconnected nodes.'
    })
    const turnMemory: ChatThreadMemoryEntry = {
      id: 'turn-memory-1',
      kind: 'turn',
      title: 'Private turn memory',
      text: 'This searchable turn memory should not be injected automatically.',
      createdAt: 900
    }
    const compressionMemory: ChatThreadMemoryEntry = {
      id: 'compression-memory-1',
      kind: 'compression',
      title: 'Automatic compact summary',
      text: 'Earlier discussion decided to repair the red node.',
      createdAt: 950,
      sourceHash: 'hash-compact'
    }
    const state = normalizeChatThreadState({
      memoryEntries: appendChatThreadMemoryEntries(
        [],
        [turnMemory, compressionMemory, buildToolMemoryEntry(toolEntry)]
      ),
      toolHistory: appendChatThreadToolHistory([], toolEntry)
    })

    expect(searchChatThreadMemory(state, 'disconnected nodes', 'auto', 5)[0].kind).toBe('tool')

    const prompt = buildThreadMemoryContextPrompt(state, { maxEntries: 4 })
    expect(prompt).toContain('Automatic compact summary')
    expect(prompt).toContain('workspace.inspect')
    expect(prompt).toContain('Canvas has two disconnected nodes.')
    expect(prompt).not.toContain('Private turn memory')
  })

  it('formats scratchpad context for hidden agent prompts', () => {
    expect(buildScratchpadContext('')).toBe('')
    expect(buildScratchpadContext('Draft hypothesis')).toContain('[Agent Scratchpad]')
    expect(buildScratchpadContext('Draft hypothesis')).toContain('Draft hypothesis')
  })
})
