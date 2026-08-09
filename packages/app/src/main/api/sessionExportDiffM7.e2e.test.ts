import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/magicpot-session-export-e2e' } }))

import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { ASSISTANT_SESSION_PROJECTION_LIMITS } from '../assistantRuntime/sessionProjection'
import { getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

const artifacts: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const item of artifacts.splice(0)) rmSync(item, { force: true, recursive: true })
})

describe('M7 §3.8 production session export/diff boundary', () => {
  it('uses the real store/runtime/service, preserves source bytes, redacts exports, and reports fork semantics', async () => {
    const file = path.join('/tmp', `m7-session-export-${Date.now()}-${Math.random()}.json`)
    artifacts.push(file)
    const store = new AssistantSessionStore(file)
    const runtime = new AssistantRuntime({ sessionStore: store })
    const sourceRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'source' }
    const forkRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'fork' }
    const run = {
      runId: 'run-1',
      sessionKey: 'generic:dm:source',
      workspaceId: 'workspace',
      route: sourceRoute,
      status: 'failed',
      runOrigin: 'retry',
      rootRunId: 'run-1',
      createdAt: 10,
      updatedAt: 40,
      startedAt: 20,
      finishedAt: 40,
      errorMessage: 'password=hunter2',
      artifactIds: ['artifact-1'],
      toolCalls: [
        {
          toolName: 'fetch',
          args: {
            authorization: 'Bearer tool-secret',
            url: 'https://user:pass@example.test/?token=url-secret'
          }
        }
      ]
    } as any
    const events = [
      {
        eventId: 'event-1',
        runId: 'run-1',
        sessionKey: 'generic:dm:source',
        route: sourceRoute,
        type: 'started',
        level: 'info',
        message: 'start',
        createdAt: 20
      },
      {
        eventId: 'event-2',
        runId: 'run-1',
        sessionKey: 'generic:dm:source',
        route: sourceRoute,
        type: 'tool',
        level: 'info',
        message: 'token=event-secret',
        metadata: { apiKey: 'metadata-secret', artifactId: 'artifact-1' },
        createdAt: 30
      }
    ] as any
    await store.appendTurn(
      sourceRoute,
      [
        { role: 'user', content: '<script>alert(1)</script> token=message-secret' },
        { role: 'assistant', content: 'safe answer' }
      ],
      100,
      {
        run,
        events,
        artifacts: [
          {
            artifactId: 'artifact-1',
            runId: 'run-1',
            kind: 'file',
            url: 'file:///private/secret.txt?token=artifact-secret',
            fileName: '<img src=x onerror=alert(1)>',
            mimeType: 'text/plain',
            sizeBytes: 7,
            createdAt: 25,
            source: 'tool'
          }
        ] as any
      }
    )
    await store.flush()
    const sourceBefore = JSON.stringify(await store.getSession(sourceRoute))
    await runtime.forkSessionAtEvent(sourceRoute, 'event-2', forkRoute)

    const policy = vi.spyOn(getAssistantTerminalPolicyRuntime(), 'authorizeAssistantMutation')
    const projectionRead = vi.spyOn(runtime, 'getSessionProjection')
    const service = new MagicAgentPlatformSvcImpl({ assistantRuntime: runtime })
    const invocation = { authenticatedActor: { kind: 'user', id: 'owner' } } as any
    const exports = await Promise.all(
      (['markdown', 'html', 'jsonl'] as const).map((format) =>
        service.exportSession({ sourceRoute, format }, invocation)
      )
    )
    const [markdown, html, jsonl] = exports.map((item) => item.body)
    expect(policy).toHaveBeenCalledTimes(3)
    expect(policy.mock.invocationCallOrder[0]).toBeLessThan(
      projectionRead.mock.invocationCallOrder[0]
    )
    expect(Buffer.byteLength(JSON.stringify(exports))).toBeLessThanOrEqual(
      ASSISTANT_SESSION_PROJECTION_LIMITS.maxTotalBytes * 4
    )
    for (const secret of [
      'hunter2',
      'tool-secret',
      'user:pass',
      'event-secret',
      'metadata-secret',
      'message-secret',
      'artifact-secret'
    ])
      expect(JSON.stringify(exports)).not.toContain(secret)
    expect(markdown).toContain('## Availability')
    expect(markdown).not.toContain('<script>')
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).not.toMatch(/<script\b/i)
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i)
    const records = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(
      records.filter((item) => item.type === 'message').map((item) => item.value.content)
    ).toEqual(['<script>alert(1)</script> token=[REDACTED]', 'safe answer'])

    const diff = await service.diffSessions(
      { leftRoute: sourceRoute, rightRoute: forkRoute },
      invocation
    )
    expect(policy).toHaveBeenCalledTimes(4)
    expect(diff.relationship.relationship).toBe('right-forked-from-left')
    expect(Object.keys(diff.dimensions)).toEqual(
      expect.arrayContaining(['messages', 'tools', 'artifacts', 'lineage'])
    )
    expect(diff.timeline.length).toBeGreaterThan(0)
    expect(JSON.stringify(await store.getSession(sourceRoute))).toBe(sourceBefore)
  })
})
