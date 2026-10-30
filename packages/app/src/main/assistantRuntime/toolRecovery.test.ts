import { describe, expect, it, vi } from 'vitest'
import type { AssistantRoute, AssistantRunEvent, AssistantRunRecord } from './types'
import { assertKnownAssistantToolOutcomes, resolveAssistantToolReplayRunId } from './toolRecovery'

const route: AssistantRoute = {
  channel: 'test',
  scopeType: 'thread',
  scopeId: 'project',
  threadId: 'thread'
}
const run = (id: string, resumeSourceRunId?: string): AssistantRunRecord => ({
  runId: id,
  route,
  sessionKey: 'test:thread:project:thread:thread',
  workspaceId: 'owned',
  status: 'failed',
  runOrigin: resumeSourceRunId ? 'resume' : 'new',
  rootRunId: id,
  createdAt: 1,
  updatedAt: 2,
  artifactIds: [],
  ...(resumeSourceRunId ? { resumeSourceRunId } : {})
})
const event = (action: unknown, runId = 'original'): AssistantRunEvent => ({
  eventId: 'owned-event',
  runId,
  sessionKey: 'test:thread:project:thread:thread',
  route,
  type: 'tool',
  level: 'info',
  message: 'Owned tool journal event',
  createdAt: 1,
  metadata: { agentAction: action }
})
const intent = () => ({
  type: 'tool.invoke',
  correlationId: 'original',
  payload: {
    invocationId: 'invocation-1',
    toolCallId: 'call-1',
    toolName: 'files.write',
    args: { path: 'owned.txt' }
  }
})
const result = (ok = true) => ({
  type: 'tool.result',
  correlationId: 'original',
  payload: {
    invocationId: 'invocation-1',
    toolCallId: 'call-1',
    toolName: 'files.write',
    ok
  }
})
const code = { code: 'TOOL_REPLAY_REQUIRES_REVIEW' }

describe('same-thread replay lineage', () => {
  it('uses the first resume source, not a follow-up root link', async () => {
    const runs = new Map([
      ['third', run('third', 'second')],
      ['second', run('second', 'first')],
      [
        'first',
        { ...run('first'), rootRunId: 'unrelated-follow-up', parentRunId: 'unrelated-follow-up' }
      ]
    ])
    const getRun = vi.fn(async (id: string) => runs.get(id))
    await expect(resolveAssistantToolReplayRunId('third', route, getRun)).resolves.toBe('first')
    expect(getRun.mock.calls.map(([id]) => id)).toEqual(['third', 'second', 'first'])
  })
  it.each(['missing', 'foreign-thread', 'wrong-id', 'cycle'] as const)(
    'rejects %s ancestry',
    async (kind) => {
      const getRun = vi.fn(async (id: string) =>
        kind === 'missing'
          ? null
          : kind === 'cycle'
            ? run(id, id)
            : kind === 'wrong-id'
              ? run('different')
              : { ...run(id), route: { ...route, threadId: 'other' } }
      )
      await expect(resolveAssistantToolReplayRunId('first', route, getRun)).rejects.toMatchObject(
        code
      )
    }
  )
  it('bounds untrusted resume chains', async () => {
    const getRun = vi.fn(async (id: string) => run(id, String(Number(id) + 1)))
    await expect(resolveAssistantToolReplayRunId('0', route, getRun)).rejects.toMatchObject(code)
    expect(getRun).toHaveBeenCalledTimes(64)
  })
})

describe('recovery receipt identity', () => {
  it.each([true, false])(
    'accepts matching settled outcome ok=%s without authorizing a replay',
    (ok) => {
      expect(() =>
        assertKnownAssistantToolOutcomes([event(intent()), event(result(ok))], 'original')
      ).not.toThrow()
    }
  )
  it('ignores ordinary events and foreign-run records', () => {
    expect(() =>
      assertKnownAssistantToolOutcomes(
        [
          event(undefined),
          event(null),
          event({ type: 'run.progress' }),
          event(intent(), 'another-run')
        ],
        'original'
      )
    ).not.toThrow()
  })
  it('rejects an intent without a receipt', () => {
    expect(() => assertKnownAssistantToolOutcomes([event(intent())], 'original')).toThrowError()
  })
  it.each(['toolName', 'toolCallId', 'invocationId', 'correlationId', 'ok'] as const)(
    'rejects a receipt with different %s',
    (field) => {
      const changed = result()
      if (field === 'correlationId') changed.correlationId = 'foreign'
      else Object.assign(changed.payload, { [field]: 'different' })
      expect(() =>
        assertKnownAssistantToolOutcomes([event(intent()), event(changed)], 'original')
      ).toThrowError()
    }
  )
  it.each([null, [], {}, { invocationId: '', toolName: 'files.write' }])(
    'rejects a malformed intent payload %#',
    (payload) => {
      expect(() =>
        assertKnownAssistantToolOutcomes([event({ ...intent(), payload })], 'original')
      ).toThrowError()
    }
  )
  it('rejects matching-looking receipts whose correlation belongs to a foreign run', () => {
    expect(() =>
      assertKnownAssistantToolOutcomes(
        [
          event({ ...intent(), correlationId: 'foreign' }),
          event({ ...result(), correlationId: 'foreign' })
        ],
        'original'
      )
    ).toThrowError()
  })
  it('rejects an orphan or out-of-order receipt instead of assuming success', () => {
    expect(() => assertKnownAssistantToolOutcomes([event(result())], 'original')).toThrowError()
    expect(() =>
      assertKnownAssistantToolOutcomes([event(result()), event(intent())], 'original')
    ).toThrowError()
  })
  it('rejects conflicting terminal receipts', () => {
    expect(() =>
      assertKnownAssistantToolOutcomes(
        [event(intent()), event(result()), event(result(false))],
        'original'
      )
    ).toThrowError()
  })
})

it('requires retained run-start evidence when checking a real resume', () => {
  const settled = [event(intent()), event(result())]
  expect(() =>
    assertKnownAssistantToolOutcomes([], 'original', { requireRunStart: true })
  ).toThrowError()
  expect(() =>
    assertKnownAssistantToolOutcomes(settled, 'original', { requireRunStart: true })
  ).toThrowError()
  const start = { ...event(undefined), type: 'queued' as const }
  expect(() =>
    assertKnownAssistantToolOutcomes([start, ...settled], 'original', { requireRunStart: true })
  ).not.toThrow()
})
