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

  const createStore = () => new AssistantSessionStore(filePath)

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

  it('migrates legacy files through a durable temp file with one bounded backup', async () => {
    const source = JSON.stringify({
      version: 1,
      sessions: [
        {
          sessionKey: 'generic:dm:migrate',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'migrate' },
          messages: [{ role: 'user', content: 'legacy' }],
          createdAt: 1,
          updatedAt: 2
        }
      ]
    })
    await fs.writeFile(filePath, source, 'utf8')
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'migrate' }

    const first = createStore()
    expect((await first.getSession(route))?.messageEntries?.[0].attributionQuality).toBe(
      'legacy-approximate'
    )
    expect(await fs.readFile(`${filePath}.v1.bak`, 'utf8')).toBe(source)
    const migrated = await fs.readFile(filePath, 'utf8')
    expect(JSON.parse(migrated).version).toBe(4)

    const second = createStore()
    await second.getSession(route)
    expect(await fs.readFile(filePath, 'utf8')).toBe(migrated)
    expect((await fs.readdir(tempDir)).filter((name) => name.endsWith('.bak'))).toEqual([
      'chat-sessions.json.v1.bak'
    ])
  })

  it('fails closed on malformed/future files without replacing the source', async () => {
    for (const source of ['{broken', JSON.stringify({ version: 5, sessions: [] })]) {
      await fs.writeFile(filePath, source, 'utf8')
      const store = createStore()
      await expect(
        store.getSession({ channel: 'generic', scopeType: 'dm', scopeId: 'closed' })
      ).rejects.toThrow()
      expect(await fs.readFile(filePath, 'utf8')).toBe(source)
    }
  })

  it('preserves source and in-memory state when migration rename fails', async () => {
    const source = JSON.stringify({
      version: 2,
      sessions: [
        {
          sessionKey: 'generic:dm:rollback',
          route: { channel: 'generic', scopeType: 'dm', scopeId: 'rollback' },
          messages: [{ role: 'user', content: 'legacy' }],
          createdAt: 1,
          updatedAt: 2
        }
      ]
    })
    await fs.writeFile(filePath, source, 'utf8')
    const renameSpy = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error('migration rename failed'))
    const store = createStore()
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'rollback' }
    await expect(store.getSession(route)).rejects.toThrow('migration rename failed')
    expect(await fs.readFile(filePath, 'utf8')).toBe(source)
    renameSpy.mockRestore()
    expect((await store.getSession(route))?.messages[0].content).toBe('legacy')
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).version).toBe(4)
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

    const store = createStore()
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
    const store = createStore()
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
    const store = createStore()
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
    expect(persisted.version).toBe(4)
    expect(persisted.sessions[0]?.runs).toHaveLength(1)
    expect(persisted.sessions[0]?.artifacts).toHaveLength(1)
    expect(persisted.sessions[0]?.eventLog).toHaveLength(1)
  })

  it('derives run lineage from persisted parent and root relationships', async () => {
    const store = createStore()
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
    const store = createStore()
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
    const store = createStore()
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

    expect(raw.version).toBe(4)
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

    const reloadedStore = createStore()
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

    const store = createStore()
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

  it('forks at persisted event position with remapped bounded state and independent reload', async () => {
    const sourceRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'fork-source' }
    const targetRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'fork-target' }
    const store = createStore()
    const workspace = getAssistantWorkspaceState(sourceRoute)
    const run1 = {
      runId: 'run-1',
      sessionKey: 'generic:dm:fork-source',
      workspaceId: workspace.workspaceId,
      route: sourceRoute,
      status: 'completed' as const,
      runOrigin: 'new' as const,
      rootRunId: 'run-1',
      createdAt: 1,
      updatedAt: 2,
      artifactIds: ['artifact-1'],
      toolCalls: [{ toolName: 'first' }]
    }
    const run2 = {
      ...run1,
      runId: 'run-2',
      rootRunId: 'run-2',
      createdAt: 3,
      updatedAt: 4,
      artifactIds: ['artifact-2'],
      toolCalls: [{ toolName: 'future' }]
    }
    const event1 = {
      eventId: 'event-1',
      runId: 'run-1',
      sessionKey: run1.sessionKey,
      route: sourceRoute,
      type: 'completed' as const,
      level: 'info' as const,
      message: 'cut',
      createdAt: 999,
      metadata: { artifactId: 'artifact-1' }
    }
    const event2 = {
      eventId: 'event-2',
      runId: 'run-2',
      sessionKey: run1.sessionKey,
      route: sourceRoute,
      type: 'completed' as const,
      level: 'info' as const,
      message: 'future',
      createdAt: 1
    }
    await store.appendTurn(
      sourceRoute,
      [
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'answer one' },
        { role: 'user', content: 'future' },
        { role: 'assistant', content: 'future answer' }
      ],
      100,
      {
        workspace,
        run: run1,
        events: [event1],
        artifacts: [
          { artifactId: 'artifact-1', runId: 'run-1', kind: 'file', createdAt: 1, source: 'tool' }
        ]
      }
    )
    await store.upsertRun(sourceRoute, run2, {
      events: [event2],
      artifacts: [
        { artifactId: 'artifact-2', runId: 'run-2', kind: 'file', createdAt: 2, source: 'tool' }
      ]
    })
    const sourceBefore = JSON.stringify(await store.getSession(sourceRoute))
    const result = await store.forkSessionAtEvent(sourceRoute, 'event-1', targetRoute)
    expect(JSON.stringify(await store.getSession(sourceRoute))).toBe(sourceBefore)
    expect(result.session.messages.map((message) => message.content)).toEqual(['one', 'answer one'])
    expect(result.session.runs).toHaveLength(1)
    expect(result.session.runs[0].toolCalls).toEqual([])
    expect(result.session.artifacts).toHaveLength(1)
    expect(result.session.eventLog.map((event) => event.type)).toEqual([
      'completed',
      'fork-created'
    ])
    expect(result.session.workspace.workspaceId).not.toBe(workspace.workspaceId)
    expect(result.session.runs[0].runId).not.toBe('run-1')
    expect(result.session.artifacts[0].artifactId).not.toBe('artifact-1')
    expect(result.lineage.idMap.runs['run-1']).toBe(result.session.runs[0].runId)
    expect(result.lineage.warning).toContain('not rolled back')
    const reloaded = createStore()
    expect((await reloaded.getSession(targetRoute))?.lineage).toEqual(result.lineage)
    await reloaded.appendEvents(targetRoute, [
      { ...result.forkCreatedEvent, eventId: 'target-future' }
    ])
    expect((await reloaded.getSession(sourceRoute))?.eventLog).toHaveLength(2)
    expect((await reloaded.getSession(targetRoute))?.eventLog).toHaveLength(3)
  })

  it('reconstructs retained runs from lifecycle events instead of copying future final state', async () => {
    const sourceRoute = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'fork-lifecycle-source'
    }
    const earlyTarget = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'fork-lifecycle-early'
    }
    const finalTarget = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'fork-lifecycle-final'
    }
    const store = createStore()
    const workspace = getAssistantWorkspaceState(sourceRoute)
    const sessionKey = 'generic:dm:fork-lifecycle-source'
    const runningRun = {
      runId: 'run-lifecycle',
      sessionKey,
      workspaceId: workspace.workspaceId,
      route: sourceRoute,
      status: 'running' as const,
      runOrigin: 'new' as const,
      rootRunId: 'run-lifecycle',
      createdAt: 10,
      updatedAt: 20,
      startedAt: 20,
      requestText: 'make it',
      toolCalls: [],
      artifactIds: []
    }
    const startedEvent = {
      eventId: 'run-started',
      runId: runningRun.runId,
      sessionKey,
      route: sourceRoute,
      type: 'started' as const,
      level: 'info' as const,
      message: 'started',
      createdAt: 20,
      metadata: { requestText: 'make it', executionMode: 'inherit', executionHistorySize: 1 }
    }
    await store.appendTurn(sourceRoute, [{ role: 'user', content: 'make it' }], 100, {
      workspace,
      run: runningRun,
      events: [startedEvent],
      messageEntries: [
        {
          runId: runningRun.runId,
          eventId: startedEvent.eventId,
          attributionQuality: 'exact',
          createdAt: startedEvent.createdAt
        }
      ]
    })

    const artifact = {
      artifactId: 'future-artifact',
      runId: runningRun.runId,
      kind: 'file' as const,
      fileName: 'future.txt',
      createdAt: 30,
      source: 'tool' as const
    }
    const artifactEvent = {
      eventId: 'artifact-linked',
      runId: runningRun.runId,
      sessionKey,
      route: sourceRoute,
      type: 'tool' as const,
      level: 'info' as const,
      message: 'artifact linked',
      createdAt: 30,
      metadata: { artifactId: artifact.artifactId, toolName: 'future.tool' }
    }
    const completedEvent = {
      eventId: 'run-completed',
      runId: runningRun.runId,
      sessionKey,
      route: sourceRoute,
      type: 'completed' as const,
      level: 'info' as const,
      message: 'completed',
      createdAt: 40,
      metadata: { artifactId: artifact.artifactId, artifactCount: 1, toolCallCount: 1 }
    }
    const completedRun = {
      ...runningRun,
      status: 'completed' as const,
      updatedAt: 40,
      finishedAt: 40,
      responseText: 'future response',
      toolCalls: [{ toolName: 'future.tool', args: { secret: true } }],
      artifactIds: [artifact.artifactId]
    }
    await store.appendTurn(sourceRoute, [{ role: 'assistant', content: 'future response' }], 100, {
      workspace,
      run: completedRun,
      artifacts: [artifact],
      events: [artifactEvent, completedEvent],
      messageEntries: [
        {
          runId: runningRun.runId,
          eventId: completedEvent.eventId,
          attributionQuality: 'exact',
          createdAt: completedEvent.createdAt
        }
      ]
    })
    const sourceBefore = JSON.stringify(await store.getSession(sourceRoute))

    const early = await store.forkSessionAtEvent(sourceRoute, startedEvent.eventId, earlyTarget)
    expect(early.session.messages.map((message) => message.content)).toEqual(['make it'])
    expect(early.session.artifacts).toEqual([])
    expect(early.session.runs[0]).toMatchObject({
      status: 'running',
      requestText: 'make it',
      startedAt: 20,
      artifactIds: []
    })
    expect(early.session.runs[0]).not.toHaveProperty('responseText')
    expect(early.session.runs[0]).not.toHaveProperty('finishedAt')
    expect(early.session.runs[0]).not.toHaveProperty('errorMessage')
    expect(early.session.runs[0].toolCalls).toEqual([])

    const final = await store.forkSessionAtEvent(sourceRoute, completedEvent.eventId, finalTarget)
    expect(final.session.runs[0]).toMatchObject({
      status: 'completed',
      responseText: 'future response',
      finishedAt: 40,
      toolCalls: [{ toolName: 'future.tool' }]
    })
    expect(final.session.artifacts).toHaveLength(1)
    expect(final.session.runs[0].artifactIds).toEqual([final.session.artifacts[0].artifactId])
    expect(final.session.artifacts[0].artifactId).not.toBe(artifact.artifactId)
    expect(JSON.stringify(await store.getSession(sourceRoute))).toBe(sourceBefore)

    const reloaded = createStore()
    expect((await reloaded.getSession(earlyTarget))?.runs[0].status).toBe('running')
    expect((await reloaded.getSession(earlyTarget))?.artifacts).toEqual([])
    expect((await reloaded.getSession(finalTarget))?.lineage).toEqual(final.lineage)
  })

  it('rejects same/existing targets and missing events', async () => {
    const source = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'fork-errors-source' }
    const target = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'fork-errors-target' }
    const store = createStore()
    await store.appendEvents(source, [
      {
        eventId: 'exists',
        runId: 'run',
        sessionKey: 'generic:dm:fork-errors-source',
        route: source,
        type: 'started',
        level: 'info',
        message: 'x',
        createdAt: 1
      }
    ])
    await expect(store.forkSessionAtEvent(source, 'exists', source)).rejects.toThrow('distinct')
    await expect(store.forkSessionAtEvent(source, 'missing', target)).rejects.toThrow(
      'event does not exist'
    )
    await store.appendEvents(target, [])
    await expect(store.forkSessionAtEvent(source, 'exists', target)).rejects.toThrow(
      'already exists'
    )
  })
})
