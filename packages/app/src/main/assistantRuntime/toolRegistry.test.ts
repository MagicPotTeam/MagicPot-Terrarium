import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { buildProjectStorageDirName } from '@shared/projectStorage'
import type { ProjectTraceProjectRef } from '@shared/projectTrace'
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
import { AssistantToolRegistry } from './toolRegistry'
import { ProjectTraceFSCli } from '../projectTrace/fs'
import {
  appendAssistantMemoryLog,
  getAssistantWorkspaceState,
  persistAssistantContextSnapshot,
  updateAssistantTaskContext
} from './workspace'

describe('AssistantToolRegistry', () => {
  let tempDir = ''
  let store: AssistantSessionStore

  beforeEach(async () => {
    tempDir = await createNodeTestArtifactDir('chat-tool-registry')
    buildDataDirRef.current = tempDir
    store = new AssistantSessionStore(path.join(tempDir, 'chat-sessions.json'))
  })

  afterEach(async () => {
    await store.flush()
    await fs.rm(tempDir, { recursive: true, force: true })
    buildDataDirRef.current = process.cwd()
    vi.clearAllMocks()
  })

  const createProjectTraceToolFixture = async () => {
    const downloadDir = path.join(tempDir, 'trace-projects')
    const projectId = 'trace-tool-project'
    const projectName = 'Trace Tool Project'
    const projectStorageDirName = buildProjectStorageDirName(projectName, projectId)
    const projectRootDir = path.join(downloadDir, projectStorageDirName)
    const project: ProjectTraceProjectRef = {
      projectId,
      projectName,
      projectStorageDirName,
      projectRootDir
    }
    const config: Config = {
      ...DEFAULT_CONFIG,
      download_dir: downloadDir
    }
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'trace-tooling'
    }
    await fs.mkdir(projectRootDir, { recursive: true })

    return {
      cli: new ProjectTraceFSCli(config),
      config,
      project,
      route,
      context: {
        config,
        route,
        sessionStore: store,
        taskState: {
          sessionKey: 'generic:dm:trace-tooling',
          running: false,
          queuedCount: 0,
          updatedAt: 1
        }
      }
    }
  }

  it('lists built-in tools and exposes session, memory, run, and artifact data', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'tooling-1'
    }
    const workspace = getAssistantWorkspaceState(route)

    await store.appendTurn(
      route,
      [
        {
          role: 'user',
          content: 'hello'
        },
        {
          role: 'assistant',
          content: 'world'
        }
      ],
      12,
      {
        workspace,
        contextSnapshot: {
          clientId: DEFAULT_CONFIG.client_id,
          sessionKey: 'generic:dm:tooling-1',
          workspaceId: workspace.workspaceId,
          route,
          generatedAt: 1,
          workflowDir: DEFAULT_CONFIG.workflow_dir,
          outputDir: DEFAULT_CONFIG.output_dir,
          downloadDir: DEFAULT_CONFIG.download_dir,
          useRemoteComfyUI: false,
          useRemoteLLM: false,
          localLLMServerEnabled: false
        },
        run: {
          runId: 'run-1',
          sessionKey: 'generic:dm:tooling-1',
          workspaceId: workspace.workspaceId,
          route,
          status: 'completed',
          runOrigin: 'new',
          rootRunId: 'run-1',
          createdAt: 1,
          updatedAt: 2,
          artifactIds: ['artifact-1'],
          taskGroup: {
            taskGroupId: 'task-group-1',
            title: 'Draft launch kit',
            description: 'Prepare and review the launch kit.',
            status: 'running',
            workspaceRunId: 'run-1',
            rootRunId: 'run-1',
            updatedAt: 2
          }
        },
        artifacts: [
          {
            artifactId: 'artifact-1',
            runId: 'run-1',
            kind: 'image',
            url: 'file:///tmp/out.png',
            createdAt: 2,
            source: 'reply'
          }
        ],
        events: [
          {
            eventId: 'event-1',
            runId: 'run-1',
            sessionKey: 'generic:dm:tooling-1',
            route,
            type: 'completed',
            level: 'info',
            message: 'Run completed successfully.',
            createdAt: 2,
            metadata: {
              profileId: 'profile-1'
            }
          }
        ]
      }
    )
    await appendAssistantMemoryLog(workspace, {
      title: 'hello',
      requestText: 'hello',
      responseText: 'world',
      status: 'completed',
      profileId: 'profile-1'
    })
    await persistAssistantContextSnapshot(workspace, {
      clientId: DEFAULT_CONFIG.client_id,
      sessionKey: 'generic:dm:tooling-1',
      workspaceId: workspace.workspaceId,
      route,
      generatedAt: 2,
      workflowDir: DEFAULT_CONFIG.workflow_dir,
      outputDir: DEFAULT_CONFIG.output_dir,
      downloadDir: DEFAULT_CONFIG.download_dir,
      useRemoteComfyUI: false,
      useRemoteLLM: false,
      localLLMServerEnabled: false
    })
    await updateAssistantTaskContext(workspace, {
      route,
      runId: 'run-1',
      workspaceId: workspace.workspaceId,
      status: 'completed',
      runOrigin: 'new',
      rootRunId: 'run-1',
      updatedAt: 3,
      profileId: 'profile-1',
      requestText: 'hello',
      responseText: 'world',
      artifactIds: ['artifact-1'],
      artifacts: [
        {
          artifactId: 'artifact-1',
          runId: 'run-1',
          kind: 'image',
          url: 'file:///tmp/out.png',
          fileName: 'out.png',
          mimeType: 'image/png',
          createdAt: 2,
          source: 'reply'
        }
      ],
      toolCalls: [{ toolName: 'session.status' }]
    })

    const taskState = {
      sessionKey: 'generic:dm:tooling-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }

    const addPinned = await registry.callTool(
      'context.pinned',
      {
        action: 'add',
        text: 'Prefer CSV exports for tabular results.'
      },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const pinned = await registry.callTool(
      'context.pinned',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const status = await registry.callTool(
      'session.status',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const sessionSummary = await registry.callTool(
      'session.summary',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const sessionHistory = await registry.callTool(
      'session.history',
      { limit: 2 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const sessionsList = await registry.callTool(
      'sessions.list',
      { limit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const workspacesList = await registry.callTool(
      'workspaces.list',
      { limit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const workspaceInspect = await registry.callTool(
      'workspace.inspect',
      { workspaceId: workspace.workspaceId, runLimit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const events = await registry.callTool(
      'events.list',
      { limit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const memory = await registry.callTool(
      'memory.recent',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const workspaceContext = await registry.callTool(
      'workspace.context',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )
    const workspaceAttach = await registry.callTool(
      'workspace.attach',
      {
        workspaceId: workspace.workspaceId,
        accessMode: 'shared',
        title: 'Shared Tool Workspace',
        description: 'Shared tool-facing metadata.',
        sharedNote: 'Prefer stable CSV exports.'
      },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile,
        workspaceMetaFile: workspace.workspaceMetaFile
      }
    )
    const workspaceContextAfterAttach = await registry.callTool(
      'workspace.context',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile,
        workspaceMetaFile: workspace.workspaceMetaFile
      }
    )
    const mcpStatus = await registry.callTool(
      'mcp.status',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState
      }
    )
    const runs = await registry.callTool(
      'runs.list',
      { limit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const run = await registry.callTool(
      'runs.get',
      { runId: 'run-1' },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const runInspect = await registry.callTool(
      'run.inspect',
      { runId: 'run-1' },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const workflowInspect = await registry.callTool(
      'workflow.inspect',
      { workflowId: 'run-1', runLimit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const taskGroupInspect = await registry.callTool(
      'task.group.inspect',
      { taskGroupId: 'task-group-1', runLimit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const runTrace = await registry.callTool(
      'run.trace',
      { runId: 'run-1' },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const runLineage = await registry.callTool(
      'run.lineage',
      { runId: 'run-1' },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const artifacts = await registry.callTool(
      'artifacts.list',
      { limit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const artifact = await registry.callTool(
      'artifacts.get',
      { artifactId: 'artifact-1' },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const auditTimeline = await registry.callTool(
      'audit.timeline',
      { limit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const opsStatus = await registry.callTool(
      'ops.status',
      { limit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const limitsStatus = await registry.callTool(
      'limits.status',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile
      }
    )
    const cleanup = await registry.callTool(
      'session.cleanup',
      { mode: 'clear' },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile
      }
    )

    expect(registry.listTools().map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'session.status',
        'session.summary',
        'session.history',
        'session.cleanup',
        'sessions.list',
        'workspaces.list',
        'workspace.inspect',
        'workspace.attach',
        'workspace.detach',
        'workspace.manage',
        'events.list',
        'workspace.context',
        'memory.recent',
        'context.pinned',
        'agent.terminal.run',
        'runs.list',
        'runs.get',
        'run.inspect',
        'run.trace',
        'run.lineage',
        'task.group.resume',
        'task.group.retry',
        'run.resume',
        'run.retry',
        'run.replay',
        'project.trace.list',
        'project.trace.read',
        'project.trace.references',
        'project.trace.replay',
        'project.trace.verify',
        'artifacts.list',
        'artifacts.get',
        'audit.timeline',
        'ops.status',
        'limits.status',
        'mcp.status'
      ])
    )
    expect(addPinned.content).toContain('Pinned note saved.')
    expect(pinned.content).toContain('Prefer CSV exports for tabular results.')
    expect(status.content).toContain('Session: generic:dm:tooling-1')
    expect(status.content).toContain('Messages: 2')
    expect(status.content).toContain('Runs: 1')
    expect(status.content).toContain('Artifacts: 1')
    expect(status.content).toContain('Events: 1')
    expect(sessionSummary.content).toContain('"sessionKey": "generic:dm:tooling-1"')
    expect(sessionSummary.content).toContain(`"workspaceId": "${workspace.workspaceId}"`)
    expect(sessionSummary.content).toContain('"eventCount": 1')
    expect(sessionSummary.content).toContain('"artifactCount": 1')
    expect(sessionSummary.content).toContain('"latestRun"')
    expect(sessionHistory.content).toContain('"returnedCount": 2')
    expect(sessionHistory.content).toContain('hello')
    expect(sessionsList.content).toContain('"sessionCount": 1')
    expect(sessionsList.content).toContain('"sessionKey": "generic:dm:tooling-1"')
    expect(workspacesList.content).toContain('"workspaceCount": 1')
    expect(workspacesList.content).toContain(`"workspaceId": "${workspace.workspaceId}"`)
    expect(workspacesList.content).toContain('"accessMode": "private"')
    expect(workspacesList.content).toContain('"ownerSessionKey": "generic:dm:tooling-1"')
    expect(workspacesList.content).toContain('"messageCount": 2')
    expect(workspaceInspect.content).toContain('"found": true')
    expect(workspaceInspect.content).toContain(`"workspaceId": "${workspace.workspaceId}"`)
    expect(workspaceInspect.content).toContain('"accessMode": "private"')
    expect(workspaceInspect.content).toContain('"ownerSessionKey": "generic:dm:tooling-1"')
    expect(workspaceInspect.content).toContain('"recentRuns"')
    expect(workspaceInspect.content).toContain('"sessions"')
    expect(workspaceAttach.content).toContain('"attached": true')
    expect(workspaceAttach.content).toContain('"accessMode": "shared"')
    expect(workspaceAttach.content).toContain('"title": "Shared Tool Workspace"')
    expect(workspaceAttach.content).toContain('"sharedNotes"')
    expect(events.content).toContain('"eventId": "event-1"')
    expect(events.content).toContain('"eventCount": 1')
    expect(memory.content).toContain('Title: hello')
    expect(memory.content).toContain('Profile: profile-1')
    expect(workspaceContext.content).toContain('"contextSnapshot"')
    expect(workspaceContext.content).toContain(`"workspaceId": "${workspace.workspaceId}"`)
    expect(workspaceContext.content).toContain('"memoryPreview"')
    expect(workspaceContext.content).toContain('"pinnedContext"')
    expect(workspaceContext.content).toContain('"workspaceSummary"')
    expect(workspaceContext.content).toContain('"latestRequestText": "hello"')
    expect(workspaceContext.content).toContain('"taskContext"')
    expect(workspaceContext.content).toContain('"recentArtifacts"')
    expect(workspaceContext.content).toContain('Prefer CSV exports for tabular results.')
    expect(workspaceContext.content).toContain('"fileName": "out.png"')
    expect(workspaceContextAfterAttach.content).toContain('"workspaceMeta"')
    expect(workspaceContextAfterAttach.content).toContain('"accessMode": "shared"')
    expect(workspaceContextAfterAttach.content).toContain('"title": "Shared Tool Workspace"')
    expect(workspaceContextAfterAttach.content).toContain('Prefer stable CSV exports.')
    expect(mcpStatus.content).toContain('"discoveredToolCount": 0')
    expect(mcpStatus.content).toContain('"path": "/api/mcp"')
    expect(mcpStatus.content).toContain('"authRequired": false')
    expect(runs.content).toContain('"runId": "run-1"')
    expect(run.content).toContain('"found": true')
    expect(run.content).toContain('"runId": "run-1"')
    expect(run.content).toContain(`"workspaceId": "${workspace.workspaceId}"`)
    expect(run.content).toContain('"runOrigin": "new"')
    expect(runInspect.content).toContain('"found": true')
    expect(runInspect.content).toContain('"runId": "run-1"')
    expect(workflowInspect.content).toContain('"workspaceInspection":')
    expect(workflowInspect.content).toContain('"sessionCount": 1')
    expect(workflowInspect.content).toContain('"runCount": 1')
    expect(taskGroupInspect.content).toContain('"workspaceInspection":')
    expect(taskGroupInspect.content).toContain('"taskGroupId": "task-group-1"')
    expect(runTrace.content).toContain('"found": true')
    expect(runTrace.content).toContain('"timeline"')
    expect(runTrace.content).toContain('"type": "artifact"')
    expect(runTrace.content).toContain(`"workspaceId": "${workspace.workspaceId}"`)
    expect(runTrace.content).toContain('"runOrigin": "new"')
    expect(runLineage.content).toContain('"found": true')
    expect(runLineage.content).toContain('"chain"')
    expect(runLineage.content).toContain('"rootRunId": "run-1"')
    expect(artifacts.content).toContain('"artifactId": "artifact-1"')
    expect(artifact.content).toContain('"found": true')
    expect(artifact.content).toContain('"artifactId": "artifact-1"')
    expect(auditTimeline.content).toContain('"returnedCount": 2')
    expect(auditTimeline.content).toContain('"category": "event"')
    expect(auditTimeline.content).toContain('"category": "artifact"')
    expect(opsStatus.content).toContain('"currentRoute"')
    expect(opsStatus.content).toContain('"global"')
    expect(opsStatus.content).toContain('"completedRunCount": 1')
    expect(opsStatus.content).toContain(`"workspaceId": "${workspace.workspaceId}"`)
    expect(limitsStatus.content).toContain('"currentMessageCount": 2')
    expect(limitsStatus.content).toContain('"currentEventCount": 1')
    expect(limitsStatus.content).toContain('"maxRunRecords"')
    expect(limitsStatus.content).toContain('"sessionCount": 1')
    expect(limitsStatus.content).toContain('"totalMessageCount": 2')
    expect(cleanup.content).toContain('"mode": "clear"')
    expect(cleanup.content).toContain('"cleared": true')
    expect(cleanup.content).toContain('"sessionCount": 0')
  })

  it('includes the active task-group summary in session.status output', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'group' as const,
      scopeId: 'task-room',
      threadId: 'thread-1'
    }
    const workspace = getAssistantWorkspaceState(route)
    const taskState = {
      sessionKey: 'generic:group:task-room:thread:thread-1',
      running: true,
      queuedCount: 1,
      taskGroup: {
        taskGroupId: 'task-group-1',
        title: 'Draft launch kit',
        status: 'running' as const,
        progress: {
          label: 'Packaging',
          completed: 2,
          total: 5,
          percent: 40,
          updatedAt: 10
        },
        workspaceRunId: 'run-1',
        updatedAt: 10
      },
      updatedAt: 10
    }

    await store.appendTurn(
      route,
      [
        {
          role: 'user',
          content: 'seed task group'
        }
      ],
      12,
      { workspace }
    )

    const status = await registry.callTool(
      'session.status',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: workspace.memoryFile,
        workspaceContextFile: workspace.contextFile
      }
    )

    expect(status.content).toContain('Session: generic:group:task-room:thread:thread-1')
    expect(status.content).toContain('Running: yes')
    expect(status.content).toContain('Queued: 1')
    expect(status.content).toContain('Task group: task-group-1')
    expect(status.content).toContain('Task group status: running')
    expect(status.content).toContain('Task group title: Draft launch kit')
    expect(status.content).toContain('Task group progress: Packaging')
    expect(status.content).toContain('Workspace run: run-1')
  })

  it('surfaces discovered MCP tools and delegates execution through the MCP client manager', async () => {
    const mcpClientManager = {
      listToolsSnapshot: vi.fn(() => [
        {
          name: 'mcp.echo.echo',
          description: 'Echo from MCP',
          inputSchema: {
            type: 'object',
            properties: {
              message: {
                type: 'string'
              }
            }
          }
        }
      ]),
      listConnections: vi.fn(() => [
        {
          id: 'echo',
          aliasPrefix: 'mcp.echo',
          status: 'connected',
          toolCount: 1,
          toolAliases: ['mcp.echo.echo'],
          transport: 'stdio'
        }
      ]),
      sync: vi.fn(async () => undefined),
      callToolByAlias: vi.fn(async (name: string) =>
        name === 'mcp.echo.echo'
          ? {
              content: 'echo:hello',
              metadata: {
                serverId: 'echo'
              }
            }
          : null
      )
    }

    const registry = new AssistantToolRegistry(mcpClientManager as never)
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'tooling-2'
    }
    const taskState = {
      sessionKey: 'generic:dm:tooling-2',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }

    const result = await registry.callTool(
      'mcp.echo.echo',
      { message: 'hello' },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState
      }
    )
    const mcpStatus = await registry.callTool(
      'mcp.status',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState
      }
    )

    expect(registry.listTools().map((tool) => tool.name)).toContain('mcp.echo.echo')
    expect(mcpClientManager.callToolByAlias).toHaveBeenCalledWith(
      'mcp.echo.echo',
      {
        message: 'hello'
      },
      undefined
    )
    expect(result).toEqual({
      content: 'echo:hello',
      metadata: {
        serverId: 'echo'
      }
    })
    expect(mcpStatus.content).toContain('"id": "echo"')
  })

  it('validates tool input against the declared input schema before execution', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'tooling-3'
    }
    const taskState = {
      sessionKey: 'generic:dm:tooling-3',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }

    await expect(
      registry.callTool(
        'workspace.inspect',
        {},
        {
          config: DEFAULT_CONFIG,
          route,
          sessionStore: store,
          taskState
        }
      )
    ).rejects.toThrow('Invalid input for tool "workspace.inspect": input.workspaceId is required.')

    await expect(
      registry.callTool(
        'sessions.list',
        { limit: 'many' as unknown as number },
        {
          config: DEFAULT_CONFIG,
          route,
          sessionStore: store,
          taskState
        }
      )
    ).rejects.toThrow('Invalid input for tool "sessions.list": input.limit must be an integer.')

    expect(
      registry.listTools().find((tool) => tool.name === 'task.group.cancel')?.inputSchema
    ).toMatchObject({
      required: ['taskGroupId']
    })

    await expect(
      registry.callTool(
        'task.group.cancel',
        {},
        {
          config: DEFAULT_CONFIG,
          route,
          sessionStore: store,
          taskState
        }
      )
    ).rejects.toThrow('Invalid input for tool "task.group.cancel": input.taskGroupId is required.')
  })

  it('rejects agent terminal calls when the feature flag is disabled', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'terminal-disabled-1'
    }
    const taskState = {
      sessionKey: 'generic:dm:terminal-disabled-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }

    await expect(
      registry.callTool(
        'agent.terminal.run',
        {
          command: 'node',
          args: ['--version'],
          confirm: true,
          cwd: tempDir
        },
        {
          config: DEFAULT_CONFIG,
          route,
          sessionStore: store,
          taskState
        }
      )
    ).rejects.toThrow('agent.terminal.run is disabled')
  })

  it('requires explicit confirmation before running the agent terminal', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'terminal-confirm-1'
    }
    const taskState = {
      sessionKey: 'generic:dm:terminal-confirm-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }
    const config = {
      ...DEFAULT_CONFIG,
      download_dir: tempDir,
      project_trace_config: {
        ...DEFAULT_CONFIG.project_trace_config,
        enable_agent_terminal: true
      }
    }

    await expect(
      registry.callTool(
        'agent.terminal.run',
        {
          command: 'node',
          args: ['--version'],
          confirm: false,
          cwd: tempDir
        },
        {
          config,
          route,
          sessionStore: store,
          taskState
        }
      )
    ).rejects.toThrow('agent.terminal.run requires confirm: true')
  })

  it('rejects destructive or non-allowlisted agent terminal commands', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'terminal-deny-1'
    }
    const taskState = {
      sessionKey: 'generic:dm:terminal-deny-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }
    const config = {
      ...DEFAULT_CONFIG,
      download_dir: tempDir,
      project_trace_config: {
        ...DEFAULT_CONFIG.project_trace_config,
        enable_agent_terminal: true
      }
    }

    await expect(
      registry.callTool(
        'agent.terminal.run',
        {
          command: 'rm',
          args: ['-rf', '.'],
          confirm: true,
          cwd: tempDir
        },
        {
          config,
          route,
          sessionStore: store,
          taskState
        }
      )
    ).rejects.toThrow('command is not allowlisted')

    await expect(
      registry.callTool(
        'agent.terminal.run',
        {
          command: 'git',
          args: ['reset', '--hard'],
          confirm: true,
          cwd: tempDir
        },
        {
          config,
          route,
          sessionStore: store,
          taskState
        }
      )
    ).rejects.toThrow('only allows git status, git diff, or git log')
  })

  it('does not resolve terminal executables from allowed workspace roots or symlinked PATH entries', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'terminal-path-escape-1'
    }
    const taskState = {
      sessionKey: 'generic:dm:terminal-path-escape-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }
    const config: Config = {
      ...DEFAULT_CONFIG,
      download_dir: tempDir,
      project_trace_config: {
        ...DEFAULT_CONFIG.project_trace_config,
        enable_agent_terminal: true
      }
    }
    const fakeBin = path.join(tempDir, 'fake-bin')
    const externalPathParent = path.join(path.dirname(tempDir), 'external-path-bin')
    const linkedPathEntry = path.join(externalPathParent, 'linked-bin')
    const originalPath = process.env.PATH
    let pathEntry = linkedPathEntry

    await fs.mkdir(fakeBin, { recursive: true })
    await fs.writeFile(
      path.join(fakeBin, process.platform === 'win32' ? 'git.exe' : 'git'),
      'not a real git executable',
      'utf8'
    )
    await fs.mkdir(externalPathParent, { recursive: true })
    try {
      await fs.symlink(fakeBin, linkedPathEntry, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES') {
        pathEntry = fakeBin
      } else {
        throw error
      }
    }

    try {
      process.env.PATH = pathEntry
      await expect(
        registry.callTool(
          'agent.terminal.run',
          {
            command: 'git',
            args: ['status', '--short'],
            confirm: true,
            cwd: tempDir
          },
          {
            config,
            route,
            sessionStore: store,
            taskState
          }
        )
      ).rejects.toThrow('agent.terminal.run could not resolve git without using a shell.')
    } finally {
      process.env.PATH = originalPath
      await fs.rm(externalPathParent, { recursive: true, force: true })
    }
  })

  it('runs an allowlisted low-risk agent terminal command when enabled and confirmed', async () => {
    const registry = new AssistantToolRegistry()
    const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'terminal-allow-1'
    }
    const taskState = {
      sessionKey: 'generic:dm:terminal-allow-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }
    const config = {
      ...DEFAULT_CONFIG,
      download_dir: tempDir,
      project_trace_config: {
        ...DEFAULT_CONFIG.project_trace_config,
        enable_agent_terminal: true
      }
    }

    await realFs.mkdir(tempDir, { recursive: true })
    try {
      const result = await registry.callTool(
        'agent.terminal.run',
        {
          command: 'node',
          args: ['--version'],
          confirm: true,
          cwd: tempDir,
          timeoutMs: 5000,
          maxOutputChars: 1000
        },
        {
          config,
          route,
          sessionStore: store,
          taskState
        }
      )
      const payload = JSON.parse(result.content)

      expect(payload.exitCode).toBe(0)
      expect(payload.timedOut).toBe(false)
      expect(payload.truncated).toBe(false)
      expect(payload.cwd).toBe(await fs.realpath(tempDir))
      expect(payload.command).toEqual({
        executable: 'node',
        args: ['--version'],
        requested: 'node --version'
      })
      expect(payload.stdout.trim()).toBe(process.version)
    } finally {
      await realFs.rm(tempDir, { recursive: true, force: true })
    }
  })

  it('detaches a route from a shared workspace and archives the prior workspace identity', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'tooling-detach-1'
    }
    const defaultWorkspace = getAssistantWorkspaceState(route)
    const sharedWorkspace = getAssistantWorkspaceState(route, 'workspace-shared-tooling-detach')
    const taskState = {
      sessionKey: 'generic:dm:tooling-detach-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }

    await registry.callTool(
      'workspace.attach',
      {
        workspaceId: sharedWorkspace.workspaceId,
        title: 'Shared Tooling Workspace',
        description: 'Shared workspace used by multiple routes.'
      },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: defaultWorkspace.memoryFile,
        workspaceTaskContextFile: defaultWorkspace.taskContextFile,
        workspaceContextFile: defaultWorkspace.contextFile,
        workspacePinnedContextFile: defaultWorkspace.pinnedContextFile,
        workspaceMetaFile: defaultWorkspace.workspaceMetaFile
      }
    )

    const detachResult = await registry.callTool(
      'workspace.detach',
      {},
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: sharedWorkspace.memoryFile,
        workspaceTaskContextFile: sharedWorkspace.taskContextFile,
        workspaceContextFile: sharedWorkspace.contextFile,
        workspacePinnedContextFile: sharedWorkspace.pinnedContextFile,
        workspaceMetaFile: sharedWorkspace.workspaceMetaFile
      }
    )
    const archivedWorkspace = await registry.callTool(
      'workspace.inspect',
      { workspaceId: sharedWorkspace.workspaceId, runLimit: 5 },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState,
        workspaceMemoryFile: defaultWorkspace.memoryFile,
        workspaceTaskContextFile: defaultWorkspace.taskContextFile,
        workspaceContextFile: defaultWorkspace.contextFile,
        workspacePinnedContextFile: defaultWorkspace.pinnedContextFile,
        workspaceMetaFile: defaultWorkspace.workspaceMetaFile
      }
    )

    expect(detachResult.content).toContain('"detached": true')
    expect(detachResult.content).toContain(
      `"previousWorkspaceId": "${sharedWorkspace.workspaceId}"`
    )
    expect(detachResult.content).toContain(`"workspaceId": "${defaultWorkspace.workspaceId}"`)
    expect(detachResult.content).toContain('"status": "archived"')
    expect(archivedWorkspace.content).toContain(`"workspaceId": "${sharedWorkspace.workspaceId}"`)
    expect(archivedWorkspace.content).toContain('"status": "archived"')
    expect(archivedWorkspace.content).toContain('"sessionCount": 0')
  })

  it('blocks foreign routes from attaching to a private workspace until the owner shares it', async () => {
    const registry = new AssistantToolRegistry()
    const ownerRoute = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'tooling-private-owner-1'
    }
    const guestRoute = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'tooling-private-guest-1'
    }
    const ownerWorkspace = getAssistantWorkspaceState(ownerRoute)
    const ownerTaskState = {
      sessionKey: 'generic:dm:tooling-private-owner-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }
    const guestTaskState = {
      sessionKey: 'generic:dm:tooling-private-guest-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }

    await registry.callTool(
      'workspace.attach',
      {
        workspaceId: ownerWorkspace.workspaceId,
        accessMode: 'private'
      },
      {
        config: DEFAULT_CONFIG,
        route: ownerRoute,
        sessionStore: store,
        taskState: ownerTaskState,
        workspaceMemoryFile: ownerWorkspace.memoryFile,
        workspaceTaskContextFile: ownerWorkspace.taskContextFile,
        workspaceContextFile: ownerWorkspace.contextFile,
        workspacePinnedContextFile: ownerWorkspace.pinnedContextFile,
        workspaceMetaFile: ownerWorkspace.workspaceMetaFile
      }
    )

    await expect(
      registry.callTool(
        'workspace.attach',
        {
          workspaceId: ownerWorkspace.workspaceId
        },
        {
          config: DEFAULT_CONFIG,
          route: guestRoute,
          sessionStore: store,
          taskState: guestTaskState,
          workspaceMemoryFile: getAssistantWorkspaceState(guestRoute).memoryFile,
          workspaceTaskContextFile: getAssistantWorkspaceState(guestRoute).taskContextFile,
          workspaceContextFile: getAssistantWorkspaceState(guestRoute).contextFile,
          workspacePinnedContextFile: getAssistantWorkspaceState(guestRoute).pinnedContextFile,
          workspaceMetaFile: getAssistantWorkspaceState(guestRoute).workspaceMetaFile
        }
      )
    ).rejects.toThrow(/private to generic:dm:tooling-private-owner-1/i)

    const sharedWorkspace = await registry.callTool(
      'workspace.attach',
      {
        workspaceId: ownerWorkspace.workspaceId,
        accessMode: 'shared'
      },
      {
        config: DEFAULT_CONFIG,
        route: ownerRoute,
        sessionStore: store,
        taskState: ownerTaskState,
        workspaceMemoryFile: ownerWorkspace.memoryFile,
        workspaceTaskContextFile: ownerWorkspace.taskContextFile,
        workspaceContextFile: ownerWorkspace.contextFile,
        workspacePinnedContextFile: ownerWorkspace.pinnedContextFile,
        workspaceMetaFile: ownerWorkspace.workspaceMetaFile
      }
    )
    const guestAttach = await registry.callTool(
      'workspace.attach',
      {
        workspaceId: ownerWorkspace.workspaceId
      },
      {
        config: DEFAULT_CONFIG,
        route: guestRoute,
        sessionStore: store,
        taskState: guestTaskState,
        workspaceMemoryFile: getAssistantWorkspaceState(guestRoute).memoryFile,
        workspaceTaskContextFile: getAssistantWorkspaceState(guestRoute).taskContextFile,
        workspaceContextFile: getAssistantWorkspaceState(guestRoute).contextFile,
        workspacePinnedContextFile: getAssistantWorkspaceState(guestRoute).pinnedContextFile,
        workspaceMetaFile: getAssistantWorkspaceState(guestRoute).workspaceMetaFile
      }
    )

    expect(sharedWorkspace.content).toContain('"accessMode": "shared"')
    expect(guestAttach.content).toContain('"accessMode": "shared"')
    expect(guestAttach.content).toContain('"sessionCount": 2')
  })

  it('applies explicit workspace governance actions for the owner route', async () => {
    const registry = new AssistantToolRegistry()
    const ownerRoute = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'tooling-govern-owner-1'
    }
    const guestRoute = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'tooling-govern-guest-1'
    }
    const ownerWorkspace = getAssistantWorkspaceState(ownerRoute)
    const ownerTaskState = {
      sessionKey: 'generic:dm:tooling-govern-owner-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }
    const guestTaskState = {
      sessionKey: 'generic:dm:tooling-govern-guest-1',
      running: false,
      queuedCount: 0,
      updatedAt: Date.now()
    }

    await registry.callTool(
      'workspace.attach',
      {
        workspaceId: ownerWorkspace.workspaceId,
        accessMode: 'private'
      },
      {
        config: DEFAULT_CONFIG,
        route: ownerRoute,
        sessionStore: store,
        taskState: ownerTaskState,
        workspaceMemoryFile: ownerWorkspace.memoryFile,
        workspaceTaskContextFile: ownerWorkspace.taskContextFile,
        workspaceContextFile: ownerWorkspace.contextFile,
        workspacePinnedContextFile: ownerWorkspace.pinnedContextFile,
        workspaceMetaFile: ownerWorkspace.workspaceMetaFile
      }
    )

    const sharedResult = await registry.callTool(
      'workspace.manage',
      {
        action: 'share',
        workspaceId: ownerWorkspace.workspaceId
      },
      {
        config: DEFAULT_CONFIG,
        route: ownerRoute,
        sessionStore: store,
        taskState: ownerTaskState,
        workspaceMemoryFile: ownerWorkspace.memoryFile,
        workspaceTaskContextFile: ownerWorkspace.taskContextFile,
        workspaceContextFile: ownerWorkspace.contextFile,
        workspacePinnedContextFile: ownerWorkspace.pinnedContextFile,
        workspaceMetaFile: ownerWorkspace.workspaceMetaFile
      }
    )

    await registry.callTool(
      'workspace.attach',
      {
        workspaceId: ownerWorkspace.workspaceId
      },
      {
        config: DEFAULT_CONFIG,
        route: guestRoute,
        sessionStore: store,
        taskState: guestTaskState,
        workspaceMemoryFile: getAssistantWorkspaceState(guestRoute).memoryFile,
        workspaceTaskContextFile: getAssistantWorkspaceState(guestRoute).taskContextFile,
        workspaceContextFile: getAssistantWorkspaceState(guestRoute).contextFile,
        workspacePinnedContextFile: getAssistantWorkspaceState(guestRoute).pinnedContextFile,
        workspaceMetaFile: getAssistantWorkspaceState(guestRoute).workspaceMetaFile
      }
    )

    await expect(
      registry.callTool(
        'workspace.manage',
        {
          action: 'privatize',
          workspaceId: ownerWorkspace.workspaceId
        },
        {
          config: DEFAULT_CONFIG,
          route: guestRoute,
          sessionStore: store,
          taskState: guestTaskState,
          workspaceMemoryFile: getAssistantWorkspaceState(guestRoute).memoryFile,
          workspaceTaskContextFile: getAssistantWorkspaceState(guestRoute).taskContextFile,
          workspaceContextFile: getAssistantWorkspaceState(guestRoute).contextFile,
          workspacePinnedContextFile: getAssistantWorkspaceState(guestRoute).pinnedContextFile,
          workspaceMetaFile: getAssistantWorkspaceState(guestRoute).workspaceMetaFile
        }
      )
    ).rejects.toThrow(/Only the workspace owner/i)

    expect(sharedResult.content).toContain('"action": "share"')
    expect(sharedResult.content).toContain('"accessMode": "shared"')
  })

  it('exposes run.resume when runtime control support is available', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'resume-tool-1'
    }
    const workspace = getAssistantWorkspaceState(route)
    const resumeRun = vi.fn(async () => ({
      runId: 'run-resumed-1',
      sessionKey: 'generic:dm:resume-tool-1',
      historySize: 3,
      status: 'completed' as const,
      reply: {
        content: 'resumed ok'
      }
    }))

    const result = await registry.callTool(
      'run.resume',
      {
        runId: 'run-failed-1',
        async: true
      },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState: {
          sessionKey: 'generic:dm:resume-tool-1',
          running: false,
          queuedCount: 0,
          updatedAt: 1
        },
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile,
        workspaceMetaFile: workspace.workspaceMetaFile,
        resumeRun
      }
    )

    expect(resumeRun).toHaveBeenCalledWith(route, 'run-failed-1', {
      async: true
    })
    expect(JSON.parse(result.content)).toMatchObject({
      resumedFromRunId: 'run-failed-1',
      accepted: true,
      result: {
        runId: 'run-resumed-1',
        status: 'completed'
      }
    })
  })

  it('exposes workflow.resume when runtime control support is available', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'workflow-resume-tool-1'
    }
    const workspace = getAssistantWorkspaceState(route)
    const resumeWorkflow = vi.fn(async () => ({
      runId: 'run-workflow-resumed-1',
      sessionKey: 'generic:dm:workflow-resume-tool-1',
      historySize: 3,
      status: 'completed' as const,
      reply: {
        content: 'workflow resumed ok'
      }
    }))

    const result = await registry.callTool(
      'workflow.resume',
      {
        workflowId: 'run-root-1',
        async: true
      },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState: {
          sessionKey: 'generic:dm:workflow-resume-tool-1',
          running: false,
          queuedCount: 0,
          updatedAt: 1
        },
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile,
        workspaceMetaFile: workspace.workspaceMetaFile,
        resumeWorkflow
      }
    )

    expect(resumeWorkflow).toHaveBeenCalledWith('run-root-1', route, {
      async: true
    })
    expect(JSON.parse(result.content)).toMatchObject({
      resumedFromWorkflowId: 'run-root-1',
      accepted: true,
      result: {
        runId: 'run-workflow-resumed-1',
        status: 'completed'
      }
    })
  })

  it('exposes read-only project trace list, read, references, replay, and verify tools', async () => {
    const registry = new AssistantToolRegistry()
    const { cli, project, context } = await createProjectTraceToolFixture()
    const saved = await cli.saveTrace(project, {
      id: 'trace-tool-1',
      name: 'Move guard trace',
      sourceKind: 'manual',
      markdown: 'Keep selected image movement under the recorded safety threshold.',
      documentJson: {
        title: 'Move guard trace',
        summary: 'Replay the safe move pattern.',
        sourceKind: 'manual',
        sections: [
          {
            title: 'Steps',
            items: ['Select the image.', 'Move it by a small distance.', 'Check the final layout.']
          }
        ]
      },
      executableRules: {
        version: 1,
        generatedAt: '2026-05-05T00:00:00.000Z',
        rules: [
          {
            id: 'move-limit',
            type: 'canvas.move.distance',
            target: 'selected.image',
            condition: {
              operator: '>',
              value: 500,
              unit: 'px'
            },
            feedback: 'Image movement exceeded the recorded trace threshold.',
            mode: 'software',
            source: 'trace_intent',
            confidence: 0.9
          }
        ],
        semanticRules: [
          {
            id: 'layout-balance',
            requirement: 'Keep the image visually balanced in the layout.',
            appliesTo: ['canvas'],
            feedback: 'Review visual balance against the trace.',
            mode: 'model_review',
            source: 'trace_intent',
            confidence: 0.7
          }
        ],
        unsupportedNotes: ['Color harmony requires visual review.']
      },
      eventSummaries: [
        {
          id: 'event-move-1',
          at: '2026-05-05T00:01:00.000Z',
          scope: 'canvas',
          action: 'move_selected_image',
          status: 'success',
          safeSummary: 'Moved selected image within the accepted range.',
          movementDistancePx: 120,
          canvasMutation: true
        }
      ]
    })

    const list = JSON.parse(
      (
        await registry.callTool(
          'project.trace.list',
          {
            project,
            limit: 5
          },
          context
        )
      ).content
    )
    const read = JSON.parse(
      (
        await registry.callTool(
          'project.trace.read',
          {
            project,
            traceId: saved.manifest.id
          },
          context
        )
      ).content
    )
    const references = JSON.parse(
      (
        await registry.callTool(
          'project.trace.references',
          {
            project,
            traceIds: [saved.manifest.id, 'missing-trace']
          },
          context
        )
      ).content
    )
    const replay = JSON.parse(
      (
        await registry.callTool(
          'project.trace.replay',
          {
            project,
            traceId: saved.manifest.id
          },
          context
        )
      ).content
    )
    const verify = JSON.parse(
      (
        await registry.callTool(
          'project.trace.verify',
          {
            project,
            traceIds: [saved.manifest.id],
            operationSummary: 'The new run moved the selected image too far.',
            eventSummaries: [
              {
                action: 'move_selected_image',
                safeSummary: 'Moved selected image by 650px.',
                movementDistancePx: 650
              }
            ]
          },
          context
        )
      ).content
    )

    expect(list).toMatchObject({
      projectId: project.projectId,
      returnedCount: 1,
      traceCount: 1
    })
    expect(read).toMatchObject({
      traceId: saved.manifest.id,
      found: true,
      trace: {
        manifest: {
          id: saved.manifest.id,
          name: 'Move guard trace'
        }
      }
    })
    expect(references).toMatchObject({
      requestedTraceIds: [saved.manifest.id, 'missing-trace'],
      foundTraceIds: [saved.manifest.id],
      missingTraceIds: ['missing-trace'],
      referenceCount: 1
    })
    expect(replay).toMatchObject({
      traceId: saved.manifest.id,
      found: true,
      replay: {
        replayable: true,
        source: 'event_summaries',
        rules: [
          {
            id: 'move-limit'
          }
        ]
      }
    })
    expect(replay.replay.steps[0]).toMatchObject({
      action: 'move_selected_image',
      metrics: {
        movementDistancePx: 120
      }
    })
    expect(verify).toMatchObject({
      requestedTraceIds: [saved.manifest.id],
      foundTraceIds: [saved.manifest.id],
      missingTraceIds: [],
      verdict: 'deviation_detected',
      ruleChecks: [
        {
          traceId: saved.manifest.id,
          ruleId: 'move-limit',
          status: 'deviation',
          measuredValue: 650
        }
      ]
    })
    expect(verify.semanticRules[0]).toMatchObject({
      traceId: saved.manifest.id,
      id: 'layout-balance'
    })
    expect(verify.deviationHints).toContain(
      `${saved.manifest.id}/move-limit: Image movement exceeded the recorded trace threshold.`
    )
  })

  it('reports missing project traces and rejects project roots outside allowed storage', async () => {
    const registry = new AssistantToolRegistry()
    const { cli, project, context } = await createProjectTraceToolFixture()
    const noRuleTrace = await cli.saveTrace(project, {
      id: 'trace-no-rules',
      name: 'Document-only trace',
      sourceKind: 'manual',
      markdown: 'Human-readable reference without deterministic software rules.',
      executableRules: {
        version: 1,
        generatedAt: '2026-05-05T00:00:00.000Z',
        rules: [],
        semanticRules: [],
        unsupportedNotes: []
      }
    })

    const read = JSON.parse(
      (
        await registry.callTool(
          'project.trace.read',
          {
            project,
            traceId: 'missing-trace'
          },
          context
        )
      ).content
    )
    const replay = JSON.parse(
      (
        await registry.callTool(
          'project.trace.replay',
          {
            project,
            traceId: 'missing-trace'
          },
          context
        )
      ).content
    )
    const verify = JSON.parse(
      (
        await registry.callTool(
          'project.trace.verify',
          {
            project,
            traceIds: ['missing-trace']
          },
          context
        )
      ).content
    )
    const noRuleVerify = JSON.parse(
      (
        await registry.callTool(
          'project.trace.verify',
          {
            project,
            traceIds: [noRuleTrace.manifest.id],
            eventSummaries: [
              {
                action: 'noop',
                safeSummary: 'No measurable rule was available.'
              }
            ]
          },
          context
        )
      ).content
    )

    expect(read).toMatchObject({
      traceId: 'missing-trace',
      found: false,
      trace: null
    })
    expect(replay).toMatchObject({
      traceId: 'missing-trace',
      found: false,
      replay: {
        replayable: false
      }
    })
    expect(verify).toMatchObject({
      requestedTraceIds: ['missing-trace'],
      foundTraceIds: [],
      missingTraceIds: ['missing-trace'],
      verdict: 'needs_review'
    })
    expect(noRuleVerify).toMatchObject({
      requestedTraceIds: [noRuleTrace.manifest.id],
      foundTraceIds: [noRuleTrace.manifest.id],
      missingTraceIds: [],
      ruleChecks: [],
      verdict: 'needs_review'
    })
    expect(noRuleVerify.warnings).toContain(
      'No software-executable trace rules were available; deterministic verification cannot prove a pass.'
    )

    await expect(
      registry.callTool(
        'project.trace.list',
        {
          project: {
            ...project,
            projectRootDir: path.join(
              path.dirname(tempDir),
              'outside-trace-tools',
              project.projectStorageDirName || ''
            )
          }
        },
        context
      )
    ).rejects.toThrow(/outside the allowed project storage roots/i)
  })

  it('exposes retry aliases and replay bundles without introducing a new execution path', async () => {
    const registry = new AssistantToolRegistry()
    const route = {
      channel: 'generic',
      scopeType: 'group' as const,
      scopeId: 'retry-replay-room',
      threadId: 'thread-1'
    }
    const workspace = getAssistantWorkspaceState(route)
    const resumeRun = vi.fn(async () => ({
      runId: 'run-retried-1',
      sessionKey: 'generic:group:retry-replay-room:thread:thread-1',
      historySize: 3,
      status: 'completed' as const,
      reply: {
        content: 'retry ok'
      }
    }))
    const resumeTaskGroup = vi.fn(async () => ({
      runId: 'run-task-retried-1',
      sessionKey: 'generic:group:retry-replay-room:thread:thread-1',
      historySize: 3,
      status: 'completed' as const,
      reply: {
        content: 'task retry ok'
      }
    }))

    await store.appendTurn(
      route,
      [
        {
          role: 'user',
          content: 'seed replay data'
        },
        {
          role: 'assistant',
          content: 'seed replay result'
        }
      ],
      8,
      {
        workspace,
        run: {
          runId: 'run-replay-1',
          sessionKey: 'generic:group:retry-replay-room:thread:thread-1',
          workspaceId: workspace.workspaceId,
          route,
          status: 'failed',
          runOrigin: 'new',
          rootRunId: 'run-replay-1',
          createdAt: 1,
          updatedAt: 2,
          requestText: 'seed replay data',
          errorMessage: 'retry please',
          artifactIds: [],
          taskGroup: {
            taskGroupId: 'task-group-replay-1',
            title: 'Replay bundle',
            status: 'cancelled',
            updatedAt: 2,
            qualityGate: {
              gateId: 'task-group-replay-1:quality-gate',
              status: 'failed',
              updatedAt: 2
            }
          }
        },
        artifacts: [
          {
            artifactId: 'artifact-replay-1',
            runId: 'run-replay-1',
            kind: 'text',
            fileName: 'replay.txt',
            createdAt: 2,
            source: 'tool'
          }
        ],
        events: [
          {
            eventId: 'event-replay-1',
            runId: 'run-replay-1',
            sessionKey: 'generic:group:retry-replay-room:thread:thread-1',
            route,
            type: 'failed',
            level: 'error',
            message: 'retry please',
            createdAt: 2
          }
        ]
      }
    )

    const taskRetry = await registry.callTool(
      'task.group.retry',
      {
        taskGroupId: 'task-group-replay-1',
        async: true
      },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState: {
          sessionKey: 'generic:group:retry-replay-room:thread:thread-1',
          running: true,
          queuedCount: 0,
          updatedAt: 1
        },
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile,
        workspaceMetaFile: workspace.workspaceMetaFile,
        resumeTaskGroup
      }
    )
    const runRetry = await registry.callTool(
      'run.retry',
      {
        runId: 'run-replay-1',
        async: true
      },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState: {
          sessionKey: 'generic:group:retry-replay-room:thread:thread-1',
          running: true,
          queuedCount: 0,
          updatedAt: 1
        },
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile,
        workspaceMetaFile: workspace.workspaceMetaFile,
        resumeRun
      }
    )
    const replay = await registry.callTool(
      'run.replay',
      {
        runId: 'run-replay-1'
      },
      {
        config: DEFAULT_CONFIG,
        route,
        sessionStore: store,
        taskState: {
          sessionKey: 'generic:group:retry-replay-room:thread:thread-1',
          running: true,
          queuedCount: 0,
          updatedAt: 1
        },
        workspaceMemoryFile: workspace.memoryFile,
        workspaceTaskContextFile: workspace.taskContextFile,
        workspaceContextFile: workspace.contextFile,
        workspacePinnedContextFile: workspace.pinnedContextFile,
        workspaceMetaFile: workspace.workspaceMetaFile,
        resumeRun
      }
    )

    expect(resumeTaskGroup).toHaveBeenCalledWith(route, 'task-group-replay-1', {
      async: true
    })
    expect(resumeRun).toHaveBeenCalledWith(route, 'run-replay-1', {
      async: true
    })
    expect(JSON.parse(taskRetry.content)).toMatchObject({
      retriedFromTaskGroupId: 'task-group-replay-1',
      accepted: true,
      result: {
        runId: 'run-task-retried-1',
        status: 'completed'
      }
    })
    expect(JSON.parse(runRetry.content)).toMatchObject({
      retriedFromRunId: 'run-replay-1',
      accepted: true,
      result: {
        runId: 'run-retried-1',
        status: 'completed'
      }
    })
    expect(JSON.parse(replay.content)).toMatchObject({
      runId: 'run-replay-1',
      found: true,
      replay: {
        replayable: true,
        suggestedRetryTool: 'run.retry'
      }
    })
  })
})
