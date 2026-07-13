import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

const { buildDataDirRef } = vi.hoisted(() => ({
  buildDataDirRef: { current: process.cwd() }
}))

vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => ({
    pathMap: {
      data: buildDataDirRef.current
    }
  })
}))

import { AssistantSessionStore } from './sessionStore'
import { getAssistantWorkspaceState, updateAssistantWorkspaceMeta } from './workspace'

describe('AssistantSessionStore', () => {
  let tempDir = ''
  let filePath = ''

  beforeEach(async () => {
    tempDir = await createNodeTestArtifactDir('assistant-session-store')
    buildDataDirRef.current = tempDir
    filePath = path.join(tempDir, 'chat-sessions.json')
    await fs.rm(tempDir, { recursive: true, force: true })
    await fs.mkdir(tempDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
    buildDataDirRef.current = process.cwd()
    vi.clearAllMocks()
  })

  it('normalizes legacy session records into the v2 schema', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          version: 1,
          sessions: [
            {
              sessionKey: 'generic:dm:legacy',
              route: {
                channel: 'generic',
                scopeType: 'dm',
                scopeId: 'legacy'
              },
              messages: [
                {
                  role: 'user',
                  content: 'hello'
                }
              ],
              createdAt: 100,
              updatedAt: 200
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    )

    const store = new AssistantSessionStore(filePath)
    const session = await store.getSession({
      channel: 'generic',
      scopeType: 'dm',
      scopeId: 'legacy'
    })

    expect(session).toMatchObject({
      sessionKey: 'generic:dm:legacy',
      route: {
        channel: 'generic',
        scopeType: 'dm',
        scopeId: 'legacy'
      },
      createdAt: 100,
      updatedAt: 200,
      messages: [
        {
          role: 'user',
          content: 'hello'
        }
      ]
    })
    expect(session?.workspace.rootDir).toContain('chat-workspaces')
    expect(session?.runs).toEqual([])
    expect(session?.artifacts).toEqual([])
    expect(session?.eventLog).toEqual([])
  })

  it('preserves the previous file and cleans up the temp file when an atomic persist fails', async () => {
    const store = new AssistantSessionStore(filePath)
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'atomic-write'
    }

    await store.appendTurn(route, [{ role: 'user', content: 'committed' }], 10)
    const committedFile = await fs.readFile(filePath, 'utf8')
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'))

    await expect(
      store.appendTurn(route, [{ role: 'assistant', content: 'not committed yet' }], 10)
    ).rejects.toThrow('rename failed')

    expect(await fs.readFile(filePath, 'utf8')).toBe(committedFile)
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    renameSpy.mockRestore()
    await store.appendTurn(route, [{ role: 'user', content: 'retry' }], 10)

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'))
    expect(
      persisted.sessions[0].messages.map((message: { content: string }) => message.content)
    ).toEqual(['committed', 'not committed yet', 'retry'])
  })

  it('persists runs, events, artifacts, and summaries in the v2 store', async () => {
    const store = new AssistantSessionStore(filePath)
    const route = {
      channel: 'generic',
      scopeType: 'group' as const,
      scopeId: 'room-1',
      threadId: 'thread-1'
    }
    const workspace = getAssistantWorkspaceState(route)
    await updateAssistantWorkspaceMeta(workspace, {
      title: 'Shared Demo Workspace',
      description: 'Shared workspace description.',
      appendSharedNote: 'Keep the report summary concise.'
    })

    await store.appendTurn(
      route,
      [
        {
          role: 'user',
          content: 'generate a chart'
        },
        {
          role: 'assistant',
          content: 'chart complete'
        }
      ],
      10,
      {
        workspace,
        run: {
          runId: 'run-1',
          sessionKey: 'generic:group:room-1:thread:thread-1',
          workspaceId: workspace.workspaceId,
          route,
          status: 'completed',
          runOrigin: 'new',
          rootRunId: 'run-1',
          createdAt: 1,
          updatedAt: 2,
          finishedAt: 3,
          requestText: 'generate a chart',
          responseText: 'chart complete',
          toolCalls: [
            {
              toolName: 'session.status',
              args: {}
            }
          ],
          artifactIds: ['artifact-1'],
          taskGroup: {
            taskGroupId: 'task-group-1',
            title: 'Draft launch kit',
            description: 'Prepare and review the launch kit.',
            status: 'approved',
            updatedAt: 4,
            qualityGate: {
              gateId: 'task-group-1:quality-gate',
              status: 'passing',
              summary: 'Draft launch kit quality gate',
              updatedAt: 4,
              checks: [
                {
                  checkId: 'task-group-1:approval',
                  label: 'Approval',
                  status: 'passing',
                  detail: 'Approved by reviewer-a',
                  updatedAt: 4
                }
              ]
            }
          }
        },
        artifacts: [
          {
            artifactId: 'artifact-1',
            runId: 'run-1',
            kind: 'image',
            url: 'file:///tmp/chart.png',
            createdAt: 3,
            source: 'reply'
          }
        ],
        events: [
          {
            eventId: 'event-1',
            runId: 'run-1',
            sessionKey: 'generic:group:room-1:thread:thread-1',
            route,
            type: 'completed',
            level: 'info',
            message: 'done',
            createdAt: 3
          }
        ]
      }
    )

    const summary = await store.getSessionSummary(route)
    const events = await store.listEvents(10, route)
    const artifacts = await store.listArtifacts(10, route)
    const run = await store.getRun('run-1', route)
    const trace = await store.getRunTrace('run-1', route)
    const auditTimeline = await store.listAuditTimeline({ limit: 10, route })
    const ops = await store.getOpsStatus({ limit: 5, route })
    const runs = await store.listRuns(10, route)
    const workspaces = await store.listWorkspaceSummaries(10)
    const workspaceInspection = await store.getWorkspaceInspection(workspace.workspaceId, {
      runLimit: 5
    })
    await store.flush()

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      version: number
      sessions: Array<{ runs: unknown[]; artifacts: unknown[]; eventLog: unknown[] }>
    }

    expect(summary).toMatchObject({
      sessionKey: 'generic:group:room-1:thread:thread-1',
      messageCount: 2,
      lastUserText: 'generate a chart',
      lastAssistantText: 'chart complete',
      latestRun: {
        runId: 'run-1',
        status: 'completed'
      }
    })
    expect(events).toHaveLength(1)
    expect(artifacts).toHaveLength(1)
    expect(run).toMatchObject({
      runId: 'run-1',
      workspaceId: workspace.workspaceId,
      status: 'completed',
      runOrigin: 'new',
      rootRunId: 'run-1',
      responseText: 'chart complete'
    })
    expect(trace).toMatchObject({
      runId: 'run-1',
      workspaceId: workspace.workspaceId,
      status: 'completed',
      runOrigin: 'new',
      rootRunId: 'run-1',
      artifactCount: 1,
      eventCount: 1,
      toolCallCount: 1
    })
    expect(trace?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'event',
          type: 'completed',
          message: 'done'
        }),
        expect.objectContaining({
          category: 'artifact',
          type: 'artifact',
          artifact: expect.objectContaining({
            artifactId: 'artifact-1',
            kind: 'image'
          })
        })
      ])
    )
    expect(auditTimeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'event',
          runId: 'run-1',
          type: 'completed'
        }),
        expect.objectContaining({
          category: 'artifact',
          runId: 'run-1',
          artifactId: 'artifact-1'
        })
      ])
    )
    expect(ops).toMatchObject({
      route,
      sessionCount: 1,
      runCount: 1,
      eventCount: 1,
      artifactCount: 1,
      completedRunCount: 1,
      failedRunCount: 0,
      cancelledRunCount: 0
    })
    expect(ops.recentRuns[0]).toMatchObject({
      runId: 'run-1',
      workspaceId: workspace.workspaceId,
      status: 'completed',
      runOrigin: 'new',
      rootRunId: 'run-1',
      toolCallCount: 1,
      artifactCount: 1,
      eventCount: 1
    })
    expect(runs).toHaveLength(1)
    expect(runs[0]?.runId).toBe('run-1')
    expect(workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: workspace.workspaceId,
          sessionCount: 1,
          messageCount: 2,
          runCount: 1,
          eventCount: 1,
          artifactCount: 1,
          title: 'Shared Demo Workspace',
          description: 'Shared workspace description.',
          sharedNotes: ['Keep the report summary concise.']
        })
      ])
    )
    expect(workspaceInspection).toMatchObject({
      workspaceId: workspace.workspaceId,
      sessionCount: 1,
      messageCount: 2,
      runCount: 1,
      eventCount: 1,
      artifactCount: 1,
      title: 'Shared Demo Workspace',
      description: 'Shared workspace description.',
      sharedNotes: ['Keep the report summary concise.']
    })
    expect(workspaceInspection?.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionKey: 'generic:group:room-1:thread:thread-1',
          messageCount: 2
        })
      ])
    )
    expect(workspaceInspection?.recentRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: 'run-1',
          workspaceId: workspace.workspaceId
        })
      ])
    )
    const workflowInspection = await store.getWorkflowInspection('run-1', { route })
    expect(workflowInspection).toMatchObject({
      workflowId: 'run-1',
      rootRunId: 'run-1',
      workspaceId: workspace.workspaceId,
      status: 'completed',
      latestRunId: 'run-1',
      runCount: 1,
      eventCount: 1,
      artifactCount: 1
    })
    expect(workflowInspection?.taskGroup).toMatchObject({
      taskGroupId: 'task-group-1',
      status: 'approved',
      qualityGate: {
        gateId: 'task-group-1:quality-gate',
        status: 'passing'
      }
    })
    expect(workflowInspection?.qualityGate).toMatchObject({
      gateId: 'task-group-1:quality-gate',
      status: 'passing'
    })
    expect(persisted.version).toBe(3)
    expect(persisted.sessions[0]?.runs).toHaveLength(1)
    expect(persisted.sessions[0]?.artifacts).toHaveLength(1)
    expect(persisted.sessions[0]?.eventLog).toHaveLength(1)
  })

  it('derives run lineage from persisted parent and root relationships', async () => {
    const store = new AssistantSessionStore(filePath)
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'lineage-store-1'
    }
    const workspace = getAssistantWorkspaceState(route)

    await store.upsertRun(route, {
      runId: 'run-root',
      sessionKey: 'generic:dm:lineage-store-1',
      workspaceId: workspace.workspaceId,
      route,
      status: 'completed',
      runOrigin: 'new',
      rootRunId: 'run-root',
      createdAt: 1,
      updatedAt: 2,
      artifactIds: []
    })
    await store.upsertRun(route, {
      runId: 'run-child',
      sessionKey: 'generic:dm:lineage-store-1',
      workspaceId: workspace.workspaceId,
      route,
      status: 'completed',
      runOrigin: 'continue',
      rootRunId: 'run-root',
      parentRunId: 'run-root',
      createdAt: 3,
      updatedAt: 4,
      artifactIds: []
    })
    await store.upsertRun(route, {
      runId: 'run-grandchild',
      sessionKey: 'generic:dm:lineage-store-1',
      workspaceId: workspace.workspaceId,
      route,
      status: 'completed',
      runOrigin: 'continue',
      rootRunId: 'run-root',
      parentRunId: 'run-child',
      createdAt: 5,
      updatedAt: 6,
      artifactIds: []
    })

    const lineage = await store.getRunLineage('run-child', route)

    expect(lineage).toMatchObject({
      runId: 'run-child',
      workspaceId: workspace.workspaceId,
      runOrigin: 'continue',
      rootRunId: 'run-root',
      parentRunId: 'run-root',
      root: expect.objectContaining({
        runId: 'run-root',
        rootRunId: 'run-root'
      })
    })
    expect(lineage?.ancestors).toEqual([
      expect.objectContaining({
        runId: 'run-root'
      })
    ])
    expect(lineage?.children).toEqual([
      expect.objectContaining({
        runId: 'run-grandchild',
        parentRunId: 'run-child'
      })
    ])
    expect(lineage?.descendants).toEqual([
      expect.objectContaining({
        runId: 'run-grandchild'
      })
    ])
    expect(lineage?.chain).toEqual([
      expect.objectContaining({ runId: 'run-root' }),
      expect.objectContaining({ runId: 'run-child' }),
      expect.objectContaining({ runId: 'run-grandchild' })
    ])
  })

  it('derives workflow summaries and inspection views from persisted run roots', async () => {
    const store = new AssistantSessionStore(filePath)
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'workflow-store-1'
    }
    const workspace = getAssistantWorkspaceState(route)

    await store.upsertRun(route, {
      runId: 'run-root',
      sessionKey: 'generic:dm:workflow-store-1',
      workspaceId: workspace.workspaceId,
      route,
      status: 'completed',
      runOrigin: 'new',
      rootRunId: 'run-root',
      createdAt: 1,
      updatedAt: 2,
      requestText: 'draft summary',
      artifactIds: []
    })
    await store.upsertRun(route, {
      runId: 'run-resume-1',
      sessionKey: 'generic:dm:workflow-store-1',
      workspaceId: workspace.workspaceId,
      route,
      status: 'failed',
      runOrigin: 'resume',
      rootRunId: 'run-root',
      parentRunId: 'run-root',
      resumeSourceRunId: 'run-root',
      resumeAttempt: 1,
      resumeMode: 'requeue',
      createdAt: 3,
      updatedAt: 4,
      requestText: 'draft summary',
      errorMessage: 'retry failed',
      artifactIds: ['artifact-1']
    })
    await store.appendEvents(route, [
      {
        eventId: 'event-root',
        runId: 'run-root',
        sessionKey: 'generic:dm:workflow-store-1',
        route,
        type: 'completed',
        level: 'info',
        message: 'root done',
        createdAt: 2
      },
      {
        eventId: 'event-resume',
        runId: 'run-resume-1',
        sessionKey: 'generic:dm:workflow-store-1',
        route,
        type: 'failed',
        level: 'error',
        message: 'retry failed',
        createdAt: 4
      }
    ])
    await store.appendArtifacts(route, [
      {
        artifactId: 'artifact-1',
        runId: 'run-resume-1',
        kind: 'text',
        fileName: 'retry-report.txt',
        createdAt: 4,
        source: 'tool'
      }
    ])

    const workflows = await store.listWorkflowSummaries({ limit: 10, route })
    const workflow = await store.getWorkflowInspection('run-resume-1', { route })

    expect(workflows).toEqual([
      expect.objectContaining({
        workflowId: 'run-root',
        rootRunId: 'run-root',
        workspaceId: workspace.workspaceId,
        status: 'failed',
        latestRunId: 'run-resume-1',
        runCount: 2,
        eventCount: 2,
        artifactCount: 1,
        runOrigins: ['new', 'resume']
      })
    ])
    expect(workflow).toMatchObject({
      workflowId: 'run-root',
      rootRunId: 'run-root',
      workspaceId: workspace.workspaceId,
      status: 'failed',
      latestRunId: 'run-resume-1',
      runCount: 2,
      eventCount: 2,
      artifactCount: 1,
      root: expect.objectContaining({
        runId: 'run-root'
      }),
      resumeEligibleRunIds: ['run-resume-1']
    })
    expect(workflow?.runs).toEqual([
      expect.objectContaining({ runId: 'run-root' }),
      expect.objectContaining({ runId: 'run-resume-1', resumeMode: 'requeue' })
    ])
    expect(workflow?.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: 'run-root', type: 'completed' }),
        expect.objectContaining({ runId: 'run-resume-1', type: 'failed' })
      ])
    )
    expect(workflow?.recentArtifacts).toEqual([
      expect.objectContaining({
        artifactId: 'artifact-1',
        runId: 'run-resume-1'
      })
    ])
  })

  it('persists explicit workflow records alongside session data', async () => {
    const store = new AssistantSessionStore(filePath)
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'workflow-store-persisted'
    }
    const workspace = getAssistantWorkspaceState(route, 'workspace-workflow-persisted')

    await store.upsertRun(route, {
      runId: 'run-root-persisted',
      sessionKey: 'generic:dm:workflow-store-persisted',
      workspaceId: workspace.workspaceId,
      route,
      status: 'failed',
      runOrigin: 'new',
      rootRunId: 'run-root-persisted',
      createdAt: 10,
      updatedAt: 12,
      requestText: 'draft persisted workflow',
      errorMessage: 'boom',
      artifactIds: []
    })
    await store.upsertRun(route, {
      runId: 'run-resume-persisted',
      sessionKey: 'generic:dm:workflow-store-persisted',
      workspaceId: workspace.workspaceId,
      route,
      status: 'completed',
      runOrigin: 'resume',
      rootRunId: 'run-root-persisted',
      parentRunId: 'run-root-persisted',
      resumeSourceRunId: 'run-root-persisted',
      resumeAttempt: 1,
      resumeMode: 'requeue',
      createdAt: 20,
      updatedAt: 24,
      requestText: 'retry persisted workflow',
      responseText: 'done',
      artifactIds: []
    })
    await store.flush()

    const raw = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
      version: number
      workflows?: Array<{
        workflowId: string
        recordVersion: number
        runIds: string[]
        resumeEligibleRunIds: string[]
      }>
    }

    expect(raw.version).toBe(3)
    expect(raw.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowId: 'run-root-persisted',
          recordVersion: 1,
          runIds: ['run-root-persisted', 'run-resume-persisted'],
          resumeEligibleRunIds: ['run-root-persisted']
        })
      ])
    )

    const reloadedStore = new AssistantSessionStore(filePath)
    const workflows = await reloadedStore.listWorkflowSummaries({ limit: 10, route })
    expect(workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workflowId: 'run-root-persisted',
          latestRunId: 'run-resume-persisted',
          runCount: 2
        })
      ])
    )
  })

  it('reports retention state and prunes stale sessions by update time', async () => {
    const routeOld = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'old'
    }
    const routeFresh = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'fresh'
    }

    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          version: 2,
          sessions: [
            {
              sessionKey: 'generic:dm:old',
              route: routeOld,
              messages: [{ role: 'user', content: 'old' }],
              createdAt: 10,
              updatedAt: 10,
              workspace: getAssistantWorkspaceState(routeOld),
              runs: [],
              artifacts: [],
              eventLog: []
            },
            {
              sessionKey: 'generic:dm:fresh',
              route: routeFresh,
              messages: [{ role: 'user', content: 'fresh' }],
              createdAt: Date.now(),
              updatedAt: Date.now(),
              workspace: getAssistantWorkspaceState(routeFresh),
              runs: [],
              artifacts: [],
              eventLog: []
            }
          ]
        },
        null,
        2
      ),
      'utf8'
    )

    const store = new AssistantSessionStore(filePath)
    const retentionBefore = await store.getRetentionState()
    const pruneResult = await store.pruneSessions(Date.now() - 24 * 60 * 60 * 1000)
    const sessions = await store.listSessions()

    expect(retentionBefore.sessionCount).toBe(2)
    expect(retentionBefore.totalMessageCount).toBe(2)
    expect(pruneResult.removedCount).toBe(1)
    expect(pruneResult.removedSessionKeys).toEqual(['generic:dm:old'])
    expect(pruneResult.retention.sessionCount).toBe(1)
    expect(pruneResult.retention.totalMessageCount).toBe(1)
    expect(sessions.map((session) => session.sessionKey)).toEqual(['generic:dm:fresh'])
  })
})
