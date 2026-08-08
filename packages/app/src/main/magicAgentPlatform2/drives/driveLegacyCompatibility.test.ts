import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }))
import { AssistantSessionStore } from '../../assistantRuntime/sessionStore'
import { MagicAgentGraphRunStore } from '../../magicAgentRuntime/graph/graphRunStore'
import { PersistentDriveStore } from './persistentDriveStore'
import { MagicAgentEventStore } from '../persistence/eventStore'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Drive legacy resource compatibility', () => {
  it('preserves Session, Task Group, Run, and Artifact identities without mutating legacy stores', async () => {
    const root = path.join(
      'C:\\MagicPot-Terrarium-Tests',
      `drive-legacy-${Date.now()}-${Math.random()}`
    )
    roots.push(root)
    mkdirSync(root, { recursive: true })
    const sessionPath = path.join(root, 'sessions.json')
    const sessions = new AssistantSessionStore(sessionPath)
    const route = { channel: 'compat', scopeType: 'channel' as const, scopeId: 'session-1' }
    await sessions.appendTurn(route, [{ role: 'user', content: 'compatibility' }], 20, {
      run: {
        runId: 'assistant-run-1',
        sessionKey: 'compat:channel:session-1',
        workspaceId: 'session-1',
        route,
        status: 'completed',
        runOrigin: 'new',
        rootRunId: 'assistant-run-1',
        createdAt: 1,
        updatedAt: 2,
        startedAt: 1,
        finishedAt: 2,
        requestText: 'compatibility',
        responseText: 'done',
        toolCalls: [],
        artifactIds: ['artifact-1'],
        taskGroup: {
          taskGroupId: 'task-group-1',
          title: 'Legacy group',
          status: 'approved',
          updatedAt: 2
        }
      },
      artifacts: [
        {
          artifactId: 'artifact-1',
          runId: 'assistant-run-1',
          kind: 'file',
          fileName: 'Report',
          createdAt: 2,
          source: 'reply'
        }
      ]
    })
    const graphRuns = new MagicAgentGraphRunStore(path.join(root, 'graph-runs'))
    await graphRuns.save({
      runId: 'graph-run-1',
      graphId: 'graph-1',
      route,
      sessionKey: 'compat:channel:session-1',
      status: 'completed',
      input: '{}',
      createdAt: 1,
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
      channels: [],
      outputs: [],
      events: []
    })

    const eventStore = new MagicAgentEventStore(':memory:')
    try {
      const drives = new PersistentDriveStore(eventStore)
      drives.create({
        drive: {
          id: 'drive-1',
          title: 'Compatibility',
          objective: 'Link legacy resources',
          status: 'active',
          priority: 1,
          links: [
            { kind: 'session', targetId: 'session-1' },
            { kind: 'task-group', targetId: 'task-group-1' },
            { kind: 'run', targetId: 'graph-run-1' },
            { kind: 'artifact', targetId: 'artifact-1' }
          ]
        },
        createdAt: 3,
        idempotencyKey: 'create-drive-compat'
      })
      const legacyRun = (await sessions.listRuns(10))[0]
      const legacyArtifacts = await sessions.listArtifacts(10)
      expect(legacyRun).toMatchObject({
        runId: 'assistant-run-1',
        taskGroup: { taskGroupId: 'task-group-1' }
      })
      expect(legacyArtifacts[0]).toMatchObject({ artifactId: 'artifact-1' })
      expect(await graphRuns.get('graph-run-1', route)).toMatchObject({
        runId: 'graph-run-1',
        status: 'completed'
      })
      expect(drives.get('drive-1')?.state.links.map((link) => link.targetId)).toEqual([
        'session-1',
        'task-group-1',
        'graph-run-1',
        'artifact-1'
      ])
    } finally {
      eventStore.close()
    }
  })
})
