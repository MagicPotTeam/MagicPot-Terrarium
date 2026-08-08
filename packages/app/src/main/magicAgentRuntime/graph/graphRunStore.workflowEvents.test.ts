import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeTestArtifactDir } from '../../testSupport/nodeTestArtifacts'
import {
  clearWorkflowCompletionListenersForTest,
  subscribeWorkflowCompletions
} from '../../magicAgentPlatform2/triggers/workflowCompletionEvents'
import { MagicAgentGraphRunStore } from './graphRunStore'

const dirs: string[] = []
afterEach(async () => {
  clearWorkflowCompletionListenersForTest()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const run = (status: 'running' | 'completed' | 'failed' | 'cancelled') => ({
  runId: 'run-workflow-event',
  graphId: 'graph-workflow-event',
  status,
  createdAt: 1,
  updatedAt: status === 'running' ? 1 : 2,
  route: {
    scopeType: 'agent' as const,
    scopeId: 'agent-1',
    threadId: 'thread-1',
    channel: 'chat'
  },
  sessionKey: 'agent:agent-1:thread:thread-1',
  request: { graphId: 'graph-workflow-event', input: {} },
  input: '{}',
  channels: [],
  outputs: [],
  nodeRuns: []
})

describe('MagicAgentGraphRunStore workflow completion publisher', () => {
  it('publishes only after terminal records are durably saved', async () => {
    const root = await createNodeTestArtifactDir('magic-agent-run-store-workflow-events')
    dirs.push(root)
    const store = new MagicAgentGraphRunStore(root)
    const events: unknown[] = []
    subscribeWorkflowCompletions((event) => events.push(event))
    await store.save(run('running'))
    expect(events).toEqual([])
    const completed = run('completed')
    await store.save(completed)
    expect(events).toEqual([
      {
        runId: 'run-workflow-event',
        graphId: 'graph-workflow-event',
        status: 'completed',
        completedAt: 2
      }
    ])
  })
})
