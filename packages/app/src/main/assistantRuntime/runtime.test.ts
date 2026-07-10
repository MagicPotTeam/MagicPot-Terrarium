import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import type { LLMChatReq, LLMChatResp } from '@shared/api/svcLLMProxy'
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

import { AssistantRuntime } from './runtime'
import { AssistantSessionStore } from './sessionStore'
import {
  AssistantToolRegistry,
  type AssistantToolCallContext,
  type AssistantToolCallResult
} from './toolRegistry'
import { getAssistantWorkspaceState } from './workspace'

describe('AssistantRuntime', () => {
  let tempDir = ''
  let store: AssistantSessionStore
  const flushQueue = async (count = 2) => {
    for (let index = 0; index < count; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  beforeEach(async () => {
    tempDir = await createNodeTestArtifactDir('assistant-runtime')
    buildDataDirRef.current = tempDir
    store = new AssistantSessionStore(path.join(tempDir, 'chat-sessions.json'))
  })

  afterEach(async () => {
    await store.flush()
    await fs.rm(tempDir, { recursive: true, force: true })
    buildDataDirRef.current = process.cwd()
    tempDir = ''
    vi.clearAllMocks()
  })

  const createConfig = (): Config => ({
    ...DEFAULT_CONFIG,
    chat_config: {
      ...DEFAULT_CONFIG.chat_config,
      enable: true,
      profile_id: 'bot-profile',
      system_prompt: 'bot system prompt',
      max_history_messages: 4
    }
  })

  it('reuses stored conversation history for the same route', async () => {
    const requests: LLMChatReq[] = []
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      requests.push(req)
      return { content: `reply-${requests.length}` }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'telegram', scopeType: 'dm' as const, scopeId: '42' }

    const first = await runtime.handleMessage({ route, text: 'hello' })
    const second = await runtime.handleMessage({ route, text: 'again' })

    expect(first.sessionKey).toBe('telegram:dm:42')
    expect(first.historySize).toBe(2)
    expect(second.historySize).toBe(4)
    expect(requests).toHaveLength(2)
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(requests[0].profileId).toBe('bot-profile')
    expect(requests[0].systemPrompt).toContain('bot system prompt')
    expect(requests[0].systemPrompt).toContain('MagicPot reusable session context.')
    expect(requests[0].systemPrompt).toContain('"sessionKey": "telegram:dm:42"')
    expect(requests[1].systemPrompt).toContain('bot system prompt')
    expect(requests[1].systemPrompt).toContain('MagicPot reusable session context.')
    expect(requests[1].systemPrompt).toContain('"latestRequestText": "hello"')
    expect(requests[1].systemPrompt).toContain('"latestResponseText": "reply-1"')
    expect(requests[1].systemPrompt).toContain('Recent workspace memory:')
    expect(requests[1].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:hello',
      'assistant:reply-1',
      'user:again'
    ])
  })

  it('clears stored history when resetHistory is requested', async () => {
    const requests: LLMChatReq[] = []
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      requests.push(req)
      return { content: `reply-${requests.length}` }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'telegram', scopeType: 'dm' as const, scopeId: '99' }

    await runtime.handleMessage({ route, text: 'old message' })
    await runtime.handleMessage({ route, text: 'fresh start', resetHistory: true })

    expect(requests).toHaveLength(2)
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'fresh start' }])
    expect(requests[1].systemPrompt).toContain('bot system prompt')
    expect(requests[1].systemPrompt).toContain('MagicPot reusable session context.')
    expect(requests[1].systemPrompt).not.toContain('"latestRequestText": "old message"')
    expect(requests[1].systemPrompt).not.toContain('Recent workspace memory:')
  })

  it('honors isolated and no-history execution modes without forwarding session history', async () => {
    const requests: LLMChatReq[] = []
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      requests.push(req)
      return { content: `reply-${requests.length}` }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'telegram', scopeType: 'dm' as const, scopeId: 'mode-1' }

    await runtime.handleMessage({ route, text: 'seed history' })
    const isolated = await runtime.handleMessage({
      route,
      text: 'isolated turn',
      execution: { mode: 'isolated', traceLabel: 'isolated-check' }
    })
    const noHistory = await runtime.handleMessage({
      route,
      text: 'no-history turn',
      execution: { mode: 'no-history' }
    })

    expect(requests).toHaveLength(3)
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'seed history' }])
    expect(requests[1].messages).toEqual([{ role: 'user', content: 'isolated turn' }])
    expect(requests[2].messages).toEqual([{ role: 'user', content: 'no-history turn' }])
    expect(isolated.executionMode).toBe('isolated')
    expect(isolated.executionHistorySize).toBe(1)
    expect(isolated.executionTraceLabel).toBe('isolated-check')
    expect(noHistory.executionMode).toBe('no-history')
    expect(noHistory.executionHistorySize).toBe(1)
  })

  it('lists stored sessions for external channel management', async () => {
    const chat = vi.fn(
      async (req: LLMChatReq): Promise<LLMChatResp> => ({
        content: `reply:${req.messages[req.messages.length - 1]?.content || ''}`
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const dmRoute = { channel: 'telegram', scopeType: 'dm' as const, scopeId: '42' }
    const groupRoute = {
      channel: 'generic',
      scopeType: 'group' as const,
      scopeId: 'team-room',
      threadId: 'topic-1'
    }

    await runtime.handleMessage({ route: dmRoute, text: 'hello there' })
    await runtime.handleMessage({ route: groupRoute, text: 'group request' })

    const summary = await runtime.getSessionSummary(dmRoute)
    const sessions = await runtime.listSessions()

    expect(summary).toMatchObject({
      sessionKey: 'telegram:dm:42',
      messageCount: 2,
      lastUserText: 'hello there',
      lastAssistantText: 'reply:hello there'
    })
    expect(sessions.map((item) => item.sessionKey).sort()).toEqual([
      'generic:group:team-room:thread:topic-1',
      'telegram:dm:42'
    ])
  })

  it('serializes concurrent messages for the same route', async () => {
    const requests: LLMChatReq[] = []
    const resolvers: Array<() => void> = []
    const chat = vi.fn(
      async (req: LLMChatReq): Promise<LLMChatResp> =>
        await new Promise<LLMChatResp>((resolve) => {
          requests.push(req)
          const index = requests.length
          resolvers.push(() => resolve({ content: `reply-${index}` }))
        })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'telegram', scopeType: 'dm' as const, scopeId: '777' }
    const firstPromise = runtime.handleMessage({ route, text: 'first message' })
    const secondPromise = runtime.handleMessage({ route, text: 'second message' })

    await flushQueue()
    expect(chat).toHaveBeenCalledTimes(1)

    resolvers[0]?.()
    const first = await firstPromise

    await flushQueue()
    expect(chat).toHaveBeenCalledTimes(2)
    expect(first.historySize).toBe(2)

    resolvers[1]?.()
    const second = await secondPromise

    expect(second.historySize).toBe(4)
    expect(requests[1].messages.map((message) => `${message.role}:${message.content}`)).toEqual([
      'user:first message',
      'assistant:reply-1',
      'user:second message'
    ])
  })

  it('handles built-in commands through the shared runtime', async () => {
    const chat = vi.fn(async (): Promise<LLMChatResp> => ({ content: 'reply' }))

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = {
      channel: 'generic',
      scopeType: 'group' as const,
      scopeId: 'room-1',
      threadId: 'thread-99'
    }

    const first = await runtime.handleMessage({ route, text: 'normal message' })

    const status = await runtime.handleCommand(route, 'status')
    const help = await runtime.handleCommand(route, 'help')
    const tools = await runtime.handleCommand(route, 'tools')
    const toolDetail = await runtime.handleCommand(route, 'tools', 'session.status')
    const workspace = await runtime.handleCommand(route, 'workspace')
    const workspaceInspect = await runtime.handleCommand(
      route,
      'workspace',
      'workspace-generic_group_room-1_thread_thread-99'
    )
    const workspaces = await runtime.handleCommand(route, 'workspaces')
    const session = await runtime.handleCommand(route, 'session')
    const runs = await runtime.handleCommand(route, 'runs')
    const events = await runtime.handleCommand(route, 'events')
    const memory = await runtime.handleCommand(route, 'memory')
    const artifacts = await runtime.handleCommand(route, 'artifacts')
    const ops = await runtime.handleCommand(route, 'ops')
    const trace = await runtime.handleCommand(route, 'trace', first.runId!)
    const lineage = await runtime.handleCommand(route, 'lineage', first.runId!)
    const reset = await runtime.handleCommand(route, 'reset')
    const afterResetStatus = await runtime.handleCommand(route, 'status')

    expect(status.reply.content).toContain('Session: generic:group:room-1:thread:thread-99')
    expect(status.reply.content).toContain('Running: no')
    expect(status.reply.content).toContain('Messages: 2')
    expect(status.reply.content).toContain('Runs: 1')
    expect(help.reply.content).toContain('Onboarding:')
    expect(help.reply.content).toContain(
      'Use this bot from the external chat channel or relay entrypoint'
    )
    expect(help.reply.content).toContain('First message to try: /help')
    expect(help.reply.content).toContain('/help - show this help')
    expect(help.reply.content).toContain('/session - show stored session summary')
    expect(help.reply.content).toContain('/runs - show recent run records')
    expect(help.reply.content).toContain('/events - show recent runtime events')
    expect(help.reply.content).toContain('/artifacts - show recent recorded artifacts')
    expect(help.reply.content).toContain('/ops - show derived operational status for this session')
    expect(help.reply.content).toContain(
      '/attach <workspaceId> [private|shared] - attach this route to a workspace identity'
    )
    expect(help.reply.content).toContain(
      '/detach - detach this route back to its default workspace identity'
    )
    expect(help.reply.content).toContain('/workspaces - list recorded workspace identities')
    expect(help.reply.content).toContain(
      '/workflows - list persisted workflow records for this route'
    )
    expect(help.reply.content).toContain(
      '/continue <runId> <message> - continue a prior run as a follow-up run'
    )
    expect(help.reply.content).toContain(
      '/resume <runId> - requeue a failed or cancelled run from its stored request text'
    )
    expect(help.reply.content).toContain(
      '/trace <runId> - show a correlated trace timeline for a run'
    )
    expect(help.reply.content).toContain('/lineage <runId> - show the related run chain for a run')
    expect(help.reply.content).toContain(
      '/workflow <workflowId> - show a persisted workflow inspection view'
    )
    expect(help.reply.content).toContain(
      '/workflow-resume <workflowId> - requeue the latest resumable run in a persisted workflow record'
    )
    expect(help.reply.content).toContain('/task - show task status and task-group summaries')
    expect(help.reply.content).toContain('/tasks - alias for /task status')
    expect(help.reply.content).toContain('/task-group ... - alias for /task')
    expect(help.reply.content).toContain('/cleanup [clear | prune <olderThanDays>]')
    expect(help.reply.content).toContain(
      '/share [workspaceId] - mark a workspace as shared (owner only)'
    )
    expect(help.reply.content).toContain(
      '/privatize [workspaceId] - mark a workspace as private when no foreign routes remain attached (owner only)'
    )
    expect(help.reply.content).toContain('/tools [name] - list available tools or inspect one tool')
    expect(tools.reply.content).toContain('Available tools:')
    expect(tools.reply.content).toContain(
      '- session.status: Describe the current chat session and task state.'
    )
    expect(tools.reply.content).toContain(
      'Use /tools <name> to inspect a tool and its input schema.'
    )
    expect(toolDetail.reply.content).toContain('Tool: session.status')
    expect(toolDetail.reply.content).toContain(
      'Description: Describe the current chat session and task state.'
    )
    expect(toolDetail.reply.content).toContain('Input schema:')
    expect(toolDetail.reply.content).toContain('"type": "object"')
    expect(workspace.reply.content).toContain(
      '"sessionKey": "generic:group:room-1:thread:thread-99"'
    )
    expect(workspace.reply.content).toContain('"workspaceId":')
    expect(workspaceInspect.reply.content).toContain(
      'Workspace: workspace-generic_group_room-1_thread_thread-99'
    )
    expect(workspaceInspect.reply.content).toContain('Access: private')
    expect(workspaceInspect.reply.content).toContain('Sessions: 1')
    expect(workspaces.reply.content).toContain('#1 workspace-generic_group_room-1_thread_thread-99')
    expect(workspaces.reply.content).toContain('access=private')
    expect(session.reply.content).toContain('Route: generic/group/room-1')
    expect(session.reply.content).toContain(
      'Workspace: workspace-generic_group_room-1_thread_thread-99'
    )
    expect(session.reply.content).toContain('Latest status: completed')
    expect(runs.reply.content).toContain('status=completed')
    expect(runs.reply.content).toContain('origin=new')
    expect(runs.reply.content).toContain(
      'workspace=workspace-generic_group_room-1_thread_thread-99'
    )
    expect(events.reply.content).toContain('completed')
    expect(memory.reply.content).toContain('Status: completed')
    expect(artifacts.reply.content).toContain(
      'No artifacts have been recorded for this session yet.'
    )
    expect(ops.reply.content).toContain('Runs: 1')
    expect(ops.reply.content).toContain('Completed: 1')
    expect(trace.reply.content).toContain(`Run: ${first.runId}`)
    expect(trace.reply.content).toContain('Timeline:')
    expect(lineage.reply.content).toContain(`Run: ${first.runId}`)
    expect(lineage.reply.content).toContain('Chain:')
    expect(reset.historySize).toBe(0)
    expect(afterResetStatus.reply.content).toContain('Messages: 0')
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('routes task-group aliases through workflow summary and task-group control surfaces', async () => {
    const chat = vi.fn(
      async (req: LLMChatReq): Promise<LLMChatResp> => ({
        content: `reply:${req.messages[req.messages.length - 1]?.content || ''}`
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = {
      channel: 'generic',
      scopeType: 'group' as const,
      scopeId: 'task-room',
      threadId: 'task-thread'
    }

    await runtime.handleMessage({
      route,
      text: 'seed task group',
      workspaceId: 'workspace-task-group',
      taskGroup: {
        taskGroupId: 'task-group-1',
        title: 'Draft launch kit',
        description: 'Prepare and review the launch kit.'
      }
    })

    const status = await runtime.handleCommand(route, 'status')
    const list = await runtime.handleCommand(route, 'tasks')
    const task = await runtime.handleCommand(route, 'task')
    const taskStatus = await runtime.handleCommand(route, 'task-status')
    const inspect = await runtime.handleCommand(route, 'task-group', 'inspect task-group-1')
    const start = await runtime.handleCommand(
      route,
      'task',
      'start task-group-1 | Draft launch kit | Prepare and review the launch kit.'
    )
    const startedStatus = await runtime.handleCommand(route, 'status')
    const progress = await runtime.handleCommand(
      route,
      'task',
      'progress task-group-1 | Drafting | 2 | 5 | 40'
    )
    const approve = await runtime.handleCommand(route, 'task', 'approve task-group-1 | reviewer-a')
    const exportResult = await runtime.handleCommand(
      route,
      'task',
      'export task-group-1 | launch-bundle.zip | artifact-1,artifact-2'
    )
    const cancel = await runtime.handleCommand(route, 'task', 'cancel task-group-1')

    await store.upsertRun(route, {
      runId: 'task-group-1-failed',
      sessionKey: 'generic:group:task-room:thread:task-thread',
      workspaceId: 'workspace-task-group',
      route,
      status: 'failed',
      runOrigin: 'new',
      rootRunId: 'task-group-1',
      createdAt: 10,
      updatedAt: 20,
      requestText: 'resume the task group',
      errorMessage: 'retry me',
      artifactIds: [],
      taskGroup: {
        taskGroupId: 'task-group-1',
        status: 'cancelled',
        workspaceRunId: 'task-group-1-failed',
        rootRunId: 'task-group-1',
        updatedAt: 20
      }
    })

    const replay = await runtime.handleCommand(route, 'task', 'replay task-group-1')
    const retry = await runtime.handleCommand(route, 'task', 'retry task-group-1')

    expect(status.reply.content).toContain('Task group: task-group-1')
    expect(status.reply.content).toContain('Task group status: draft')
    expect(list.reply.content).toContain('Task status:')
    expect(list.reply.content).toContain('Task groups:')
    expect(list.reply.content).toContain('taskGroup=task-group-1')
    expect(list.reply.content).toContain('qualityGate=')
    expect(task.reply.content).toContain('Task status:')
    expect(task.reply.content).toContain('Task groups:')
    expect(taskStatus.reply.content).toContain('Task status:')
    expect(taskStatus.reply.content).toContain('Task groups:')
    expect(taskStatus.reply.content).toContain('qualityGate=')
    expect(inspect.reply.content).toContain('Task group: task-group-1')
    expect(inspect.reply.content).toContain('Title: Draft launch kit')
    expect(inspect.reply.content).toContain('Quality gate status:')
    expect(inspect.reply.content).toContain('Workspace status: active')
    expect(inspect.reply.content).toContain('Workspace access: shared')
    expect(inspect.reply.content).toContain('Workspace sessions: 1')
    expect(inspect.reply.content).toContain('Workspace runs: 1')
    expect(start.reply.content).toContain('Task group started: task-group-1')
    expect(startedStatus.reply.content).toContain('Task group: task-group-1')
    expect(startedStatus.reply.content).toContain('Task group status: running')
    expect(progress.reply.content).toContain('Task group: task-group-1')
    expect(progress.reply.content).toContain('Progress: Drafting')
    expect(approve.reply.content).toContain('Task group approved: task-group-1')
    expect(approve.reply.content).toContain('Approved by: reviewer-a')
    expect(exportResult.reply.content).toContain('Task group exported: task-group-1')
    expect(exportResult.reply.content).toContain('Export target: launch-bundle.zip')
    expect(cancel.reply.content).toContain('Task group cancelled: task-group-1')
    expect(replay.reply.content).toContain('Task group replay: task-group-1')
    expect(replay.reply.content).toContain('Replayable: yes')
    expect(replay.reply.content).toContain('Retry tool: run.retry')
    expect(retry.reply.content).toContain('Task group retried: task-group-1')
    expect(retry.reply.content).toContain('Run:')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('clears a session through the cleanup command and reports retention state', async () => {
    const chat = vi.fn(async (): Promise<LLMChatResp> => ({ content: 'reply' }))
    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'cleanup-1' }

    await runtime.handleMessage({ route, text: 'hello' })
    const cleanup = await runtime.handleCommand(route, 'cleanup')
    const retention = await runtime.getRetentionState()
    const session = await runtime.getSession(route)

    expect(cleanup.reply.content).toContain('Cleanup mode: clear')
    expect(cleanup.reply.content).toContain('Cleared: yes')
    expect(cleanup.reply.content).toContain('Remaining sessions: 0')
    expect(retention.sessionCount).toBe(0)
    expect(session).toBeNull()
  })

  it('records run metadata, artifacts, and tool calls for each session', async () => {
    const chat = vi.fn(
      async (): Promise<LLMChatResp> => ({
        content: 'artifact reply',
        imageUrl: 'file:///tmp/generated-report.png'
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'workspace-1' }

    const first = await runtime.handleMessage({ route, text: 'generate a report' })
    const second = await runtime.handleMessage({ route, text: '/tool session.status' })
    const session = await runtime.getSession(route)

    expect(first.runId).toBeTruthy()
    expect(first.status).toBe('completed')
    expect(first.artifacts).toHaveLength(1)
    const firstArtifact = first.artifacts?.[0]
    expect(first.executionMode).toBe('inherit')
    expect(first.executionHistorySize).toBe(1)
    expect(firstArtifact).toMatchObject({
      traceId: first.runId,
      executionMode: 'inherit',
      originatingRunId: first.runId
    })
    expect(first.events?.find((event) => event.type === 'completed')?.metadata).toMatchObject({
      executionMode: 'inherit',
      executionHistorySize: 1,
      artifactCount: 1,
      toolCallCount: 0
    })
    expect(first.events?.map((event) => event.type)).toEqual(
      expect.arrayContaining(['progress', 'completed'])
    )

    expect(second.runId).toBeTruthy()
    expect(second.reply.content).toContain('Session: generic:dm:workspace-1')
    expect(second.executionMode).toBe('inherit')
    expect(second.executionHistorySize).toBe(3)
    expect(second.events?.map((event) => event.type)).toEqual(
      expect.arrayContaining(['tool', 'completed'])
    )
    expect(chat).toHaveBeenCalledTimes(1)

    expect(session?.workspace.rootDir).toContain('chat-workspaces')
    expect(session?.contextSnapshot?.sessionKey).toBe('generic:dm:workspace-1')
    expect(session?.runs).toHaveLength(2)
    expect(session?.runs[0]?.artifactIds).toHaveLength(1)
    expect(session?.runs[1]?.toolCalls).toEqual([
      {
        toolName: 'session.status',
        args: {}
      }
    ])
    expect(session?.artifacts).toHaveLength(1)
    expect(session?.eventLog.some((event) => event.type === 'tool')).toBe(true)
  })

  it('honors tool allowlists for direct /tool execution', async () => {
    const chat = vi.fn(
      async (): Promise<LLMChatResp> => ({
        content: 'unused'
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'tool-allowlist-1' }

    await expect(
      runtime.handleMessage({
        route,
        text: '/tool context.pinned {"text":"blocked"}',
        execution: {
          allowedToolNames: ['session.status']
        }
      })
    ).rejects.toThrow('Tool "context.pinned" is not bound to the current skill.')

    expect(chat).not.toHaveBeenCalled()
  })

  it('allows direct /tool execution when the tool is present in the allowlist', async () => {
    const chat = vi.fn(
      async (): Promise<LLMChatResp> => ({
        content: 'unused'
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'tool-allowlist-2' }

    const result = await runtime.handleMessage({
      route,
      text: '/tool session.status',
      execution: {
        allowedToolNames: ['session.status']
      }
    })

    expect(result.reply.content).toContain('Session: generic:dm:tool-allowlist-2')
    expect(result.events?.map((event) => event.type)).toEqual(
      expect.arrayContaining(['tool', 'completed'])
    )
    expect(chat).not.toHaveBeenCalled()
  })

  it('injects recent artifact metadata into later reusable prompt context', async () => {
    const requests: LLMChatReq[] = []
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      requests.push(req)
      return requests.length === 1
        ? {
            content: 'generated report',
            imageUrl: 'file:///tmp/generated-report.png'
          }
        : {
            content: 'follow-up reply'
          }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'artifact-context-1' }

    await runtime.handleMessage({ route, text: 'generate a report' })
    await runtime.handleMessage({ route, text: 'summarize the latest artifact' })

    expect(requests).toHaveLength(2)
    expect(requests[1].systemPrompt).toContain('"recentArtifacts"')
    expect(requests[1].systemPrompt).toContain('"kind": "image"')
    expect(requests[1].systemPrompt).toContain('"fileName": "generated-report.png"')
    expect(requests[1].systemPrompt).toContain('"source": "reply"')
  })

  it('manages pinned notes through commands and reuses them in later prompts', async () => {
    const requests: LLMChatReq[] = []
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      requests.push(req)
      return {
        content: `reply-${requests.length}`
      }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'pins-1' }

    const pinResult = await runtime.handleCommand(
      route,
      'pin',
      'Prefer CSV exports for tabular responses.'
    )
    const pinsResult = await runtime.handleCommand(route, 'pins')

    await runtime.handleMessage({ route, text: 'What output format should I use?' })

    expect(pinResult.reply.content).toContain('Pinned note saved.')
    expect(pinsResult.reply.content).toContain('Prefer CSV exports for tabular responses.')
    expect(requests).toHaveLength(1)
    expect(requests[0].systemPrompt).toContain('"pinnedContext"')
    expect(requests[0].systemPrompt).toContain('Prefer CSV exports for tabular responses.')

    const removeResult = await runtime.handleCommand(route, 'unpin', '1')
    await runtime.handleMessage({ route, text: 'And now?' })

    expect(removeResult.reply.content).toContain('Pinned note removed.')
    expect(requests).toHaveLength(2)
    expect(requests[1].systemPrompt).not.toContain('Prefer CSV exports for tabular responses.')
  })

  it('emits run events and returns a cancelled result when active execution is aborted', async () => {
    const events: string[] = []
    const chat = vi.fn(
      async (_req: LLMChatReq, options?: { signal?: AbortSignal }): Promise<LLMChatResp> =>
        await new Promise<LLMChatResp>((resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              const abortError = new Error('Aborted')
              abortError.name = 'AbortError'
              reject(abortError)
            },
            { once: true }
          )
          void resolve
        })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'cancel-1' }
    const resultPromise = runtime.handleMessage({
      route,
      text: 'long running request',
      onEvent: async (event) => {
        events.push(event.type)
      }
    })

    await flushQueue()
    const taskState = await runtime.cancelRoute(route)
    const result = await resultPromise

    expect(taskState.cancelRequested).toBe(true)
    expect(result.status).toBe('cancelled')
    expect(result.reply.content).toBe('The task was cancelled.')
    expect(events).toEqual(
      expect.arrayContaining(['queued', 'acknowledged', 'started', 'progress', 'cancelled'])
    )
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('discards a successful late result after an external abort signal', async () => {
    let resolveChat: ((value: LLMChatResp) => void) | undefined
    const chat = vi.fn(
      async (): Promise<LLMChatResp> =>
        new Promise<LLMChatResp>((resolve) => {
          resolveChat = resolve
        })
    )
    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })
    const controller = new AbortController()
    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'external-cancel-1' }
    const resultPromise = runtime.handleMessage({
      route,
      text: 'ignore a late reply',
      signal: controller.signal
    })

    await flushQueue()
    controller.abort('External graph cancellation.')
    resolveChat?.({ content: 'late reply' })
    const result = await resultPromise

    expect(result.status).toBe('cancelled')
    expect(result.reply.content).toBe(
      'The task was cancelled before the final result was delivered.'
    )
    const session = await store.getSession(route)
    expect(session?.runs.at(-1)).toMatchObject({
      status: 'cancelled',
      toolCalls: [],
      artifactIds: []
    })
    expect(session?.runs.at(-1)?.responseText).toBeUndefined()
    expect(session?.messages.some((message) => message.content === 'late reply')).toBe(false)
  })

  it('returns a cancelled result when direct /tool execution is aborted', async () => {
    class SlowToolRegistry extends AssistantToolRegistry {
      override listTools() {
        return [
          ...super.listTools(),
          {
            name: 'slow.tool',
            description: 'A slow tool used to verify cancellation propagation.',
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      }

      override async callTool(
        name: string,
        args: Record<string, unknown>,
        context: AssistantToolCallContext
      ): Promise<AssistantToolCallResult> {
        if (name !== 'slow.tool') {
          return super.callTool(name, args, context)
        }

        return await new Promise<AssistantToolCallResult>((resolve, reject) => {
          if (context.signal?.aborted) {
            const error = new Error('Aborted')
            error.name = 'AbortError'
            reject(error)
            return
          }

          context.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('Aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true }
          )
        })
      }
    }

    const chat = vi.fn(async (): Promise<LLMChatResp> => ({ content: 'should not be used' }))
    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig,
      toolRegistry: new SlowToolRegistry()
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'tool-cancel-1' }
    const resultPromise = runtime.handleMessage({
      route,
      text: '/tool slow.tool'
    })

    await flushQueue()
    const taskState = await runtime.cancelRoute(route)
    const result = await resultPromise

    expect(taskState.cancelRequested).toBe(true)
    expect(result.status).toBe('cancelled')
    expect(result.reply.content).toBe('The task was cancelled.')
    expect(chat).not.toHaveBeenCalled()
  })

  it('broadcasts route-scoped runtime events to subscribers', async () => {
    const events: string[] = []
    const chat = vi.fn(
      async (): Promise<LLMChatResp> => ({
        content: 'subscriber reply'
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'stream-1' }
    const unsubscribe = runtime.subscribeEvents(route, (event) => {
      events.push(event.type)
    })

    await runtime.handleMessage({ route, text: 'stream progress' })
    unsubscribe()

    expect(events).toEqual(
      expect.arrayContaining(['queued', 'acknowledged', 'started', 'completed'])
    )
    expect(events.indexOf('queued')).toBeLessThan(events.indexOf('completed'))
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('accepts asynchronous submissions and completes them in the background', async () => {
    const chat = vi.fn(
      async (): Promise<LLMChatResp> => ({
        content: 'async reply'
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'async-1' }
    const accepted = await runtime.submitMessage({
      route,
      text: 'run asynchronously'
    })

    expect(accepted.status).toBe('queued')
    expect(accepted.reply.content).toBe(
      'MagicPot accepted the request for asynchronous processing.'
    )
    expect(accepted.runId).toBeTruthy()

    await flushQueue(4)
    const run = await runtime.getRun(accepted.runId!, route)

    expect(chat).toHaveBeenCalledTimes(1)
    expect(run?.status).toBe('completed')
    expect(run?.responseText).toBe('async reply')
  })

  it('records failed runs for asynchronous submissions', async () => {
    const chat = vi.fn(async (): Promise<LLMChatResp> => {
      throw new Error('async failure')
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'async-failed-1' }
    const accepted = await runtime.submitMessage({
      route,
      text: 'fail asynchronously'
    })

    await flushQueue(4)
    const run = await runtime.getRun(accepted.runId!, route)
    const events = await runtime.listEvents(10, route)

    expect(chat).toHaveBeenCalledTimes(1)
    expect(run?.status).toBe('failed')
    expect(run?.errorMessage).toContain('async failure')
    expect(events.map((event) => event.type)).toContain('failed')
  })

  it('records cancelled runs for asynchronous submissions', async () => {
    const chat = vi.fn(
      async (_req: LLMChatReq, options?: { signal?: AbortSignal }): Promise<LLMChatResp> =>
        await new Promise<LLMChatResp>((resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => {
              const abortError = new Error('Aborted')
              abortError.name = 'AbortError'
              reject(abortError)
            },
            { once: true }
          )
          void resolve
        })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'async-cancel-1' }
    const accepted = await runtime.submitMessage({
      route,
      text: 'cancel asynchronously'
    })

    await flushQueue()
    const taskState = await runtime.cancelRoute(route)
    await flushQueue(4)

    const run = await runtime.getRun(accepted.runId!, route)
    const events = await runtime.listEvents(10, route)

    expect(taskState.cancelRequested).toBe(true)
    expect(chat).toHaveBeenCalledTimes(1)
    expect(run?.status).toBe('cancelled')
    expect(run?.cancelRequested).toBe(true)
    expect(events.map((event) => event.type)).toContain('cancelled')
  })

  it('requeues failed runs through resume control with resume metadata', async () => {
    let callCount = 0
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      callCount += 1
      if (callCount === 1) {
        throw new Error('resume me')
      }
      return {
        content: `resumed:${req.messages[req.messages.length - 1]?.content || ''}`
      }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'resume-failed-1' }
    const failedAccepted = await runtime.submitMessage({
      route,
      text: 'retry this request',
      workspaceId: 'workspace-resume-1'
    })

    await flushQueue(4)
    const failedRun = await runtime.getRun(failedAccepted.runId!, route)
    expect(failedRun?.status).toBe('failed')

    const resumed = await runtime.handleCommand(route, 'resume', failedAccepted.runId!)
    const resumedRun = await runtime.getRun(resumed.runId!, route)
    const resumedLineage = await runtime.getRunLineage(resumed.runId!, route)
    expect(chat).toHaveBeenCalledTimes(2)
    expect(resumedRun).toMatchObject({
      runId: resumed.runId,
      workspaceId: 'workspace-resume-1',
      runOrigin: 'resume',
      parentRunId: failedAccepted.runId,
      rootRunId: failedAccepted.runId,
      resumeSourceRunId: failedAccepted.runId,
      resumeAttempt: 1,
      resumeMode: 'requeue',
      status: 'completed',
      requestText: 'retry this request',
      responseText: 'resumed:retry this request'
    })
    expect(resumedLineage).toMatchObject({
      runId: resumed.runId,
      workspaceId: 'workspace-resume-1',
      runOrigin: 'resume',
      parentRunId: failedAccepted.runId,
      rootRunId: failedAccepted.runId,
      resumeSourceRunId: failedAccepted.runId,
      resumeAttempt: 1,
      resumeMode: 'requeue',
      resumeEligible: false,
      resumeBlockedReason: 'Only failed or cancelled runs can be resumed.'
    })
    expect(resumedLineage?.ancestors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: failedAccepted.runId
        })
      ])
    )
    expect((await runtime.getSession(route))?.workspace.workspaceId).toBe('workspace-resume-1')
  })

  it('rejects resume control for completed runs', async () => {
    const chat = vi.fn(
      async (): Promise<LLMChatResp> => ({
        content: 'completed'
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'resume-completed-1' }
    const completed = await runtime.handleMessage({
      route,
      text: 'finish normally'
    })

    await expect(runtime.resumeRun(route, completed.runId!)).rejects.toThrow(
      'Only failed or cancelled runs can be resumed.'
    )
  })

  it('creates follow-up runs with lineage metadata and a stable workspace identity', async () => {
    const chat = vi.fn(
      async (req: LLMChatReq): Promise<LLMChatResp> => ({
        content: `reply:${req.messages[req.messages.length - 1]?.content || ''}`
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'lineage-1' }
    const first = await runtime.handleMessage({
      route,
      text: 'draft the first answer',
      workspaceId: 'workspace-shared-lineage'
    })
    const second = await runtime.handleMessage({
      route,
      text: 'refine that answer',
      continueFromRunId: first.runId
    })

    const session = await runtime.getSession(route)
    const runs = await runtime.listRuns(10, route)
    const secondRun = await runtime.getRun(second.runId!, route)
    const secondTrace = await runtime.getRunTrace(second.runId!, route)
    const secondLineage = await runtime.getRunLineage(second.runId!, route)

    expect(first.runId).toBeTruthy()
    expect(second.runId).toBeTruthy()
    expect(chat).toHaveBeenCalledTimes(2)
    expect(session?.workspace.workspaceId).toBe('workspace-shared-lineage')
    expect(session?.contextSnapshot?.workspaceId).toBe('workspace-shared-lineage')
    expect(runs).toHaveLength(2)
    expect(secondRun).toMatchObject({
      runId: second.runId,
      workspaceId: 'workspace-shared-lineage',
      runOrigin: 'continue',
      parentRunId: first.runId,
      rootRunId: first.runId
    })
    expect(secondTrace).toMatchObject({
      runId: second.runId,
      workspaceId: 'workspace-shared-lineage',
      runOrigin: 'continue',
      parentRunId: first.runId,
      rootRunId: first.runId
    })
    expect(secondLineage).toMatchObject({
      runId: second.runId,
      workspaceId: 'workspace-shared-lineage',
      runOrigin: 'continue',
      parentRunId: first.runId,
      rootRunId: first.runId
    })
    expect(secondLineage?.ancestors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: first.runId,
          rootRunId: first.runId
        })
      ])
    )
    expect(secondLineage?.chain).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: first.runId }),
        expect.objectContaining({ runId: second.runId })
      ])
    )
  })

  it('lists and inspects persisted workflow records aggregated from run lineage for a route', async () => {
    const chat = vi.fn(
      async (req: LLMChatReq): Promise<LLMChatResp> => ({
        content: `reply:${req.messages[req.messages.length - 1]?.content || ''}`
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'workflow-command-1' }
    const first = await runtime.handleMessage({
      route,
      text: 'draft the initial workflow output',
      workspaceId: 'workspace-workflow-command'
    })
    const second = await runtime.handleMessage({
      route,
      text: 'resume the workflow with a follow-up',
      continueFromRunId: first.runId
    })

    const workflows = await runtime.handleCommand(route, 'workflows')
    const workflow = await runtime.handleCommand(route, 'workflow')

    expect(workflows.reply.content).toContain(first.runId!)
    expect(workflows.reply.content).toContain('runs=2')
    expect(workflow.reply.content).toContain(`Workflow: ${first.runId}`)
    expect(workflow.reply.content).toContain(`Workspace: workspace-workflow-command`)
    expect(workflow.reply.content).toContain('Workspace status: active')
    expect(workflow.reply.content).toContain('Workspace access: shared')
    expect(workflow.reply.content).toContain('Workspace sessions: 1')
    expect(workflow.reply.content).toContain('Workspace runs: 2')
    expect(workflow.reply.content).toContain(`Latest run: ${second.runId}`)
  })

  it('requeues the latest resumable run from a persisted workflow record', async () => {
    let callCount = 0
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      callCount += 1
      if (callCount === 1) {
        throw new Error('workflow resume me')
      }
      return {
        content: `workflow-resumed:${req.messages[req.messages.length - 1]?.content || ''}`
      }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'workflow-resume-1' }
    const failedAccepted = await runtime.submitMessage({
      route,
      text: 'retry this workflow',
      workspaceId: 'workspace-workflow-resume'
    })

    await flushQueue(4)

    const resumed = await runtime.handleCommand(route, 'workflow-resume', failedAccepted.runId!)
    const resumedRun = await runtime.getRun(resumed.runId!, route)

    expect(chat).toHaveBeenCalledTimes(2)
    expect(resumedRun).toMatchObject({
      runId: resumed.runId,
      workspaceId: 'workspace-workflow-resume',
      runOrigin: 'resume',
      parentRunId: failedAccepted.runId,
      rootRunId: failedAccepted.runId,
      resumeSourceRunId: failedAccepted.runId,
      resumeAttempt: 1,
      resumeMode: 'requeue',
      status: 'completed',
      requestText: 'retry this workflow',
      responseText: 'workflow-resumed:retry this workflow'
    })
  })

  it('attaches a route to a shared workspace and injects shared workspace metadata into later prompts', async () => {
    const requests: LLMChatReq[] = []
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      requests.push(req)
      return {
        content: `reply:${requests.length}`
      }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'attach-1' }
    const attached = await runtime.attachWorkspace(route, 'workspace-shared-attach', {
      title: 'Shared Attach Workspace',
      description: 'Shared description for attached routes.',
      appendSharedNote: 'Always keep shared summaries concise.'
    })
    const attachCommand = await runtime.handleCommand(route, 'attach', 'workspace-shared-attach')

    await runtime.handleMessage({ route, text: 'use the shared workspace' })

    expect(attached).toMatchObject({
      workspaceId: 'workspace-shared-attach',
      accessMode: 'shared',
      title: 'Shared Attach Workspace',
      description: 'Shared description for attached routes.',
      sharedNotes: ['Always keep shared summaries concise.']
    })
    expect(attachCommand.reply.content).toContain(
      'Attached route to workspace: workspace-shared-attach'
    )
    expect(attachCommand.reply.content).toContain('Access: shared')
    expect(requests).toHaveLength(1)
    expect(requests[0].systemPrompt).toContain('"workspaceMeta"')
    expect(requests[0].systemPrompt).toContain('"title": "Shared Attach Workspace"')
    expect(requests[0].systemPrompt).toContain('Always keep shared summaries concise.')
  })

  it('keeps private workspaces route-scoped until the owner explicitly shares them', async () => {
    const chat = vi.fn(
      async (req: LLMChatReq): Promise<LLMChatResp> => ({
        content: `reply:${req.messages[req.messages.length - 1]?.content || ''}`
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const ownerRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'private-owner-1' }
    const guestRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'private-guest-1' }
    const ownerWorkspaceId = getAssistantWorkspaceState(ownerRoute).workspaceId

    await runtime.handleMessage({ route: ownerRoute, text: 'seed owner workspace' })

    const ownerWorkspaceBefore = await runtime.getWorkspace(ownerWorkspaceId, { runLimit: 5 })
    await expect(runtime.attachWorkspace(guestRoute, ownerWorkspaceId)).rejects.toThrow(
      /private to generic:dm:private-owner-1/i
    )

    const sharedWorkspace = await runtime.attachWorkspace(ownerRoute, ownerWorkspaceId, {
      accessMode: 'shared'
    })
    const guestAttached = await runtime.attachWorkspace(guestRoute, ownerWorkspaceId)

    expect(ownerWorkspaceBefore).toMatchObject({
      workspaceId: ownerWorkspaceId,
      accessMode: 'private',
      ownerSessionKey: 'generic:dm:private-owner-1'
    })
    expect(sharedWorkspace).toMatchObject({
      workspaceId: ownerWorkspaceId,
      accessMode: 'shared'
    })
    expect(guestAttached).toMatchObject({
      workspaceId: ownerWorkspaceId,
      accessMode: 'shared',
      sessionCount: 2
    })
  })

  it('does not rebind a route when private attach validation fails', async () => {
    const chat = vi.fn(
      async (req: LLMChatReq): Promise<LLMChatResp> => ({
        content: `reply:${req.messages[req.messages.length - 1]?.content || ''}`
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const ownerRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'private-owner-2' }
    const guestRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'private-guest-2' }
    const outsiderRoute = {
      channel: 'generic',
      scopeType: 'dm' as const,
      scopeId: 'private-outsider-2'
    }
    const ownerWorkspaceId = getAssistantWorkspaceState(ownerRoute).workspaceId
    const outsiderDefaultWorkspaceId = getAssistantWorkspaceState(outsiderRoute).workspaceId

    await runtime.handleMessage({ route: ownerRoute, text: 'seed owner workspace' })
    await runtime.attachWorkspace(ownerRoute, ownerWorkspaceId, { accessMode: 'shared' })
    await runtime.attachWorkspace(guestRoute, ownerWorkspaceId)

    await expect(
      runtime.attachWorkspace(outsiderRoute, ownerWorkspaceId, { accessMode: 'private' })
    ).rejects.toThrow(/private to generic:dm:private-owner-2/i)

    await runtime.handleMessage({ route: outsiderRoute, text: 'stay on the default workspace' })

    const outsiderSession = await runtime.getSession(outsiderRoute)
    expect(outsiderSession?.workspace.workspaceId).toBe(outsiderDefaultWorkspaceId)
  })

  it('applies explicit workspace governance actions for the workspace owner', async () => {
    const chat = vi.fn(
      async (req: LLMChatReq): Promise<LLMChatResp> => ({
        content: `reply:${req.messages[req.messages.length - 1]?.content || ''}`
      })
    )

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const ownerRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'govern-owner-1' }
    const guestRoute = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'govern-guest-1' }
    const archivedWorkspaceId = 'workspace-govern-archive-1'
    const ownerWorkspaceId = getAssistantWorkspaceState(ownerRoute).workspaceId

    await runtime.handleMessage({ route: ownerRoute, text: 'seed governance workspace' })

    const sharedWorkspace = await runtime.manageWorkspace(ownerRoute, 'share', ownerWorkspaceId)
    await runtime.attachWorkspace(guestRoute, ownerWorkspaceId)

    await expect(
      runtime.manageWorkspace(guestRoute, 'privatize', ownerWorkspaceId)
    ).rejects.toThrow(/Only the workspace owner/i)
    await expect(
      runtime.manageWorkspace(ownerRoute, 'privatize', ownerWorkspaceId)
    ).rejects.toThrow(/Detach the other routes first/i)

    await runtime.detachWorkspace(guestRoute)
    const privatizedWorkspace = await runtime.manageWorkspace(
      ownerRoute,
      'privatize',
      ownerWorkspaceId
    )

    await runtime.attachWorkspace(ownerRoute, archivedWorkspaceId, { accessMode: 'shared' })
    await runtime.detachWorkspace(ownerRoute)

    const revivedWorkspace = await runtime.manageWorkspace(
      ownerRoute,
      'revive',
      archivedWorkspaceId
    )
    const archivedWorkspace = await runtime.manageWorkspace(
      ownerRoute,
      'archive',
      archivedWorkspaceId
    )

    expect(sharedWorkspace).toMatchObject({
      workspaceId: ownerWorkspaceId,
      accessMode: 'shared'
    })
    expect(privatizedWorkspace).toMatchObject({
      workspaceId: ownerWorkspaceId,
      accessMode: 'private',
      ownerSessionKey: 'generic:dm:govern-owner-1'
    })
    expect(revivedWorkspace).toMatchObject({
      workspaceId: archivedWorkspaceId,
      status: 'active'
    })
    expect(archivedWorkspace).toMatchObject({
      workspaceId: archivedWorkspaceId,
      status: 'archived'
    })
  })

  it('detaches a route from a shared workspace and archives the prior workspace identity when it becomes empty', async () => {
    const requests: LLMChatReq[] = []
    const chat = vi.fn(async (req: LLMChatReq): Promise<LLMChatResp> => {
      requests.push(req)
      return {
        content: `reply:${requests.length}`
      }
    })

    const runtime = new AssistantRuntime({
      chatService: { chat },
      sessionStore: store,
      configProvider: createConfig
    })

    const route = { channel: 'generic', scopeType: 'dm' as const, scopeId: 'detach-1' }
    await runtime.attachWorkspace(route, 'workspace-shared-detach', {
      title: 'Shared Detach Workspace',
      description: 'Workspace to test detach behavior.',
      appendSharedNote: 'Reuse the shared workspace while attached.'
    })

    const detachCommand = await runtime.handleCommand(route, 'detach')
    const detachResult = await runtime.detachWorkspace(route)
    const currentSession = await runtime.getSession(route)
    const previousWorkspace = await runtime.getWorkspace('workspace-shared-detach', { runLimit: 5 })

    await runtime.handleMessage({ route, text: 'after detach' })

    expect(detachCommand.reply.content).toContain(
      'Detached route from workspace: workspace-shared-detach'
    )
    expect(detachResult.detached).toBe(false)
    expect(detachResult.previousWorkspaceId).toBe(currentSession?.workspace.workspaceId)
    expect(currentSession?.workspace.workspaceId).toBe('workspace-generic_dm_detach-1')
    expect(currentSession?.contextSnapshot?.workspaceId).toBe('workspace-generic_dm_detach-1')
    expect(previousWorkspace).toMatchObject({
      workspaceId: 'workspace-shared-detach',
      status: 'archived',
      sessionCount: 0
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].systemPrompt).not.toContain('Shared Detach Workspace')
    expect(requests[0].systemPrompt).not.toContain('Reuse the shared workspace while attached.')
  })
})
