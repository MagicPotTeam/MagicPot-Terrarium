import { describe, expect, it } from 'vitest'
import {
  parseAndMigrateAssistantSessionEnvelope,
  serializeAssistantSessionEnvelopeV4
} from './sessionMigration'

const route = { channel: 'generic', scopeType: 'dm', scopeId: 'fixture' }
const message = { role: 'user', content: 'hello' }

const fixture = (version: 1 | 2 | 3 | 4) => ({
  version,
  sessions: [
    {
      sessionKey: 'generic:dm:fixture',
      route,
      messages: [message],
      ...(version === 4
        ? {
            messageEntries: [
              {
                messageId: 'message-1',
                message,
                order: 0,
                createdAt: 10,
                attributionQuality: 'exact',
                runId: 'run-1'
              }
            ]
          }
        : {}),
      createdAt: 10,
      updatedAt: 20,
      runs: [
        {
          runId: 'run-1',
          sessionKey: 'generic:dm:fixture',
          workspaceId: 'workspace-1',
          route,
          createdAt: 11,
          updatedAt: 12,
          taskGroup: { taskGroupId: 'group-1', title: 'Ship', updatedAt: 12 }
        }
      ],
      artifacts: [],
      eventLog: [],
      unsupported: 'drop-me'
    }
  ],
  ...(version >= 3
    ? {
        workflows: [
          {
            workflowId: 'run-1',
            rootRunId: 'run-1',
            workspaceId: 'workspace-1',
            route,
            sessionKeys: ['generic:dm:fixture'],
            createdAt: 11,
            updatedAt: 12,
            taskGroup: { taskGroupId: 'group-1', updatedAt: 12 }
          }
        ]
      }
    : {})
})

describe('assistant session v1-v4 migration', () => {
  for (const version of [1, 2, 3] as const) {
    it(`migrates the frozen v${version} fixture deterministically to v4`, () => {
      const first = parseAndMigrateAssistantSessionEnvelope(fixture(version))
      const second = parseAndMigrateAssistantSessionEnvelope(fixture(version))
      expect(first.sourceVersion).toBe(version)
      expect(first.migrated).toBe(true)
      expect(serializeAssistantSessionEnvelopeV4(first.envelope)).toBe(
        serializeAssistantSessionEnvelopeV4(second.envelope)
      )
      const session = first.envelope.sessions[0]
      expect(session.messageEntries).toEqual([
        expect.objectContaining({ attributionQuality: 'legacy-approximate' })
      ])
      expect(session).not.toHaveProperty('unsupported')
      expect(session.runs).toEqual([
        expect.objectContaining({
          status: 'queued',
          runOrigin: 'new',
          rootRunId: 'run-1',
          toolCalls: [],
          artifactIds: [],
          taskGroup: expect.objectContaining({ status: 'draft' })
        })
      ])
      expect(first.envelope.workflows).toEqual(
        version === 3
          ? [
              expect.objectContaining({
                recordVersion: 1,
                runIds: ['run-1'],
                resumeEligibleRunIds: [],
                taskGroup: expect.objectContaining({ status: 'draft' })
              })
            ]
          : []
      )
    })
  }

  it('normalizes v4 without migration and preserves exact attribution', () => {
    const result = parseAndMigrateAssistantSessionEnvelope(fixture(4))
    expect(result.migrated).toBe(false)
    expect(result.envelope.sessions[0].messageEntries).toEqual([
      expect.objectContaining({
        messageId: 'message-1',
        runId: 'run-1',
        attributionQuality: 'exact'
      })
    ])
  })

  it.each([0, 5, 1.5, '4', undefined])('rejects invalid/future version %s', (version) => {
    expect(() => parseAndMigrateAssistantSessionEnvelope({ version, sessions: [] })).toThrow(
      'Unsupported assistant session store version'
    )
  })

  it('rejects malformed envelopes', () => {
    expect(() => parseAndMigrateAssistantSessionEnvelope({ version: 4, sessions: {} })).toThrow(
      'sessions must be an array'
    )
  })
})
