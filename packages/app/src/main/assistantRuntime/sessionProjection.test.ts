import { describe, expect, it } from 'vitest'
import type { AssistantSessionRecord } from './types'
import {
  ASSISTANT_SESSION_PROJECTION_LIMITS,
  diffAssistantSessionProjections,
  exportAssistantSessionHtml,
  exportAssistantSessionJsonl,
  exportAssistantSessionMarkdown,
  projectAssistantSession
} from './sessionProjection'

const route = {
  channel: 'discord',
  scopeType: 'thread' as const,
  scopeId: 'room',
  threadId: 'thread'
}
const session = (overrides: Partial<AssistantSessionRecord> = {}): AssistantSessionRecord => ({
  sessionKey: 'discord:room:thread',
  route,
  createdAt: 10,
  updatedAt: 50,
  workspace: {
    workspaceId: 'workspace',
    workspaceRootDir: '/private',
    workspaceMetaFile: '/private/meta',
    rootDir: '/private/root',
    memoryDir: '/private/memory',
    memoryFile: '/private/memory.md',
    contextFile: '/private/context',
    taskContextFile: '/private/task',
    pinnedContextFile: '/private/pinned'
  },
  messages: [
    { role: 'user', content: '<script>alert(1)</script> token=supersecret' },
    { role: 'assistant', content: 'done' }
  ],
  runs: [
    {
      runId: 'run-1',
      sessionKey: 'discord:room:thread',
      workspaceId: 'workspace',
      route,
      status: 'failed',
      runOrigin: 'retry',
      rootRunId: 'run-1',
      createdAt: 20,
      updatedAt: 40,
      startedAt: 25,
      finishedAt: 40,
      errorMessage: 'password=hunter2',
      artifactIds: ['artifact-1'],
      toolCalls: [
        {
          toolName: 'fetch',
          args: {
            url: 'https://user:pass@example.test/a?token=abc',
            authorization: 'Bearer abc',
            nested: { apiKey: 'xyz' }
          }
        }
      ],
      taskGroup: {
        taskGroupId: 'legacy',
        status: 'approved',
        approvedBy: 'operator',
        approvedAt: 30,
        updatedAt: 30
      }
    }
  ],
  artifacts: [
    {
      artifactId: 'artifact-1',
      runId: 'run-1',
      kind: 'file',
      url: 'https://secret.example/file?token=abc',
      mimeType: 'text/plain',
      fileName: '<img src=x onerror=alert(1)>',
      sizeBytes: 42,
      createdAt: 35,
      source: 'tool'
    }
  ],
  eventLog: [
    {
      eventId: 'event-1',
      runId: 'run-1',
      sessionKey: 'discord:room:thread',
      route,
      type: 'started',
      level: 'info',
      message: 'started',
      createdAt: 25
    },
    {
      eventId: 'event-2',
      runId: 'run-1',
      sessionKey: 'discord:room:thread',
      route,
      type: 'tool',
      level: 'info',
      message: 'approval granted token=eventsecret',
      createdAt: 30,
      metadata: { password: 'eventpass' }
    },
    {
      eventId: 'event-3',
      runId: 'run-1',
      sessionKey: 'discord:room:thread',
      route,
      type: 'failed',
      level: 'error',
      message: 'failed',
      createdAt: 40
    }
  ],
  ...overrides
})

describe('assistant session projection/export/diff', () => {
  it('is deterministic, redacted, bounded, metadata-only and explicit about availability', () => {
    const source = session()
    const before = JSON.stringify(source)
    const first = projectAssistantSession(source)
    const second = projectAssistantSession(source)
    expect(first).toEqual(second)
    expect(JSON.stringify(source)).toBe(before)
    const serialized = JSON.stringify(first)
    for (const secret of [
      'supersecret',
      'hunter2',
      'user:pass',
      'eventsecret',
      'eventpass',
      '"abc"',
      '"xyz"'
    ])
      expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('secret.example/file')
    expect(first.artifacts[0]).not.toHaveProperty('url')
    expect(first.availability.graphVersions.status).toBe('unavailable')
    expect(first.availability.teams.status).toBe('unavailable')
    expect(first.availability.runtimeChannels.status).toBe('unavailable')
    expect(first.availability.durableDrives.status).toBe('unavailable')
    expect(first.availability.fileDiffs.status).toBe('unavailable')
    expect(first.availability.approvals.status).toBe('available')
    expect(first.availability.legacyTaskGroups.status).toBe('available')
    expect(first.usageAndTiming[0]).toMatchObject({ queueDelayMs: 5, durationMs: 15 })
  })

  it('exports semantically equivalent JSONL, escaped Markdown, and self-contained no-script HTML', () => {
    const projection = projectAssistantSession(session())
    const jsonl = exportAssistantSessionJsonl(projection)
    const records = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      records.filter((record) => record.type === 'message').map((record) => record.value)
    ).toEqual(projection.messages)
    const markdown = exportAssistantSessionMarkdown(projection)
    expect(markdown).toContain('## Availability')
    expect(markdown).not.toContain('<script>')
    const html = exportAssistantSessionHtml(projection)
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).not.toMatch(/<script\b/i)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img src=x')
  })

  it('bounds depth, arrays, strings, and total bytes', () => {
    const huge = 'x'.repeat(20_000)
    const projection = projectAssistantSession(
      session({ messages: Array.from({ length: 150 }, () => ({ role: 'user', content: huge })) })
    )
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(
      ASSISTANT_SESSION_PROJECTION_LIMITS.maxTotalBytes
    )
    expect(projection.messages.length).toBeLessThanOrEqual(100)
    expect(JSON.stringify(projection)).toContain('TRUNCATED')
  })

  it('classifies every dimension, aligns messages, merges timeline, and recognizes fork lineage', () => {
    const left = projectAssistantSession(session())
    const right = projectAssistantSession(
      session({
        sessionKey: 'discord:fork',
        route: { ...route, scopeId: 'fork' },
        messages: [],
        lineage: {
          sourceSessionKey: left.session.sessionKey,
          sourceRoute: route,
          sourceEventId: 'event-2',
          sourceRunId: 'run-1',
          forkedAt: 45,
          warning: 'fork',
          sourceWorkspaceId: 'workspace',
          idMap: { runs: {}, events: {}, artifacts: {} }
        }
      })
    )
    const diff = diffAssistantSessionProjections(left, right)
    expect(Object.keys(diff.dimensions)).toEqual(
      expect.arrayContaining([
        'messages',
        'lifecycleEvents',
        'tools',
        'routeIdentity',
        'legacyTaskGroups',
        'durableDrives',
        'approvals',
        'artifacts',
        'errorsAndRetries',
        'usageAndTiming',
        'graphVersions',
        'teams',
        'runtimeChannels',
        'fileDiffs',
        'lineage'
      ])
    )
    expect(diff.dimensions.graphVersions.classification).toBe('unavailable')
    expect(diff.dimensions.messages.classification).toBe('changed')
    expect(diff.lineage.relationship).toBe('right-forked-from-left')
    expect(diff.sideBySide[0].classification).toBe('left-only')
    expect(diff.mergedTimeline.length).toBeGreaterThan(0)
  })

  it('handles empty legacy sessions without fabricating facts', () => {
    const projection = projectAssistantSession(
      session({ messages: [], runs: [], artifacts: [], eventLog: [] })
    )
    expect(projection.availability.legacyTaskGroups.status).toBe('unavailable')
    expect(projection.availability.approvals.status).toBe('unavailable')
    expect(projection.messages).toEqual([])
    expect(projection.timeline).toEqual([])
  })
})
