import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.unmock('fs')
vi.unmock('node:fs')

const pythonSdk = path.join(process.cwd(), 'packages/agent-sdk-python/src')
let baseUrl = ''
let server: ReturnType<typeof createServer>
const semanticMemoryRequests: Array<{ method: string; body: Record<string, unknown> }> = []

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (request.headers.authorization !== 'Bearer python-token') {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: 'unauthorized' }))
      return
    }
    const memoryMethod = request.url?.match(/\/v2\/sdk\/(memory\.[A-Za-z]+)$/)?.[1]
    if (memoryMethod) {
      semanticMemoryRequests.push({ method: memoryMethod, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ method: memoryMethod }))
      return
    }
    if (request.url?.endsWith('/session.export')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          format: body.format,
          mimeType:
            body.format === 'html'
              ? 'text/html; charset=utf-8'
              : body.format === 'jsonl'
                ? 'application/x-ndjson; charset=utf-8'
                : 'text/markdown; charset=utf-8',
          filename: `python-session.${body.format === 'markdown' ? 'md' : body.format}`,
          body:
            body.format === 'jsonl'
              ? '{"type":"session","value":{"sessionKey":"generic:dm:python-source"}}\n'
              : body.format === 'html'
                ? '<!doctype html><html><body>safe</body></html>'
                : '# safe',
          availability: { tools: { status: 'available' } }
        })
      )
      return
    }
    if (request.url?.endsWith('/session.diff')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          leftSessionKey: 'generic:dm:python-source',
          rightSessionKey: 'generic:dm:python-target',
          relationship: { relationship: 'right-forked-from-left' },
          dimensions: { messages: { classification: 'changed' } },
          timeline: [{ side: 'left' }],
          sideBySide: []
        })
      )
      return
    }
    if (request.url?.endsWith('/session.fork')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          targetSessionKey: 'generic:dm:python-target',
          lineage: {
            sourceSessionKey: 'generic:dm:python-source',
            sourceEventId: body.sourceEventId,
            sourceRunId: 'run-1',
            forkedAt: 123
          },
          warning: 'External side effects are not rolled back.',
          counts: { messages: 2, runs: 1, events: 3, artifacts: 1 }
        })
      )
      return
    }
    if (request.url?.match(/\/graphRun\.input\.(inject|edit|cancel)$/)) {
      const action = request.url.split('.').pop()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          runId: body.runId,
          pendingInputId: body.pendingInputId,
          revision: body.expectedRevision + 1,
          status: action === 'cancel' ? 'cancelled' : action === 'inject' ? 'submitted' : 'awaiting'
        })
      )
      return
    }
    if (request.url?.endsWith('/graphRun.attach')) {
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' })
      response.write(
        JSON.stringify({
          eventId: 'event-1',
          runId: body.runId,
          sequence: 1,
          kind: 'run.started',
          timestamp: 1,
          payload: { status: 'running' }
        }) + '\n'
      )
      response.end(
        JSON.stringify({
          eventId: 'event-2',
          runId: body.runId,
          sequence: 2,
          kind: 'run.completed',
          timestamp: 2,
          payload: { status: 'completed' }
        }) + '\n'
      )
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url?.match(/\/team\.(replace|start|pause|resume|stop)$/)) {
      const action = request.url.split('.').pop()
      response.end(
        JSON.stringify({
          id: `operation-${action}`,
          revision: 2,
          teamId: 'python-team',
          teamRevision: 1,
          action,
          status: action === 'start' ? 'partial' : 'completed',
          outcomes: [],
          startedAt: 1,
          completedAt: 2
        })
      )
      return
    }
    if (request.url?.endsWith('/drive.create')) {
      response.end(
        JSON.stringify({
          drive: {
            id: 'python-e2e-run',
            revision: 0,
            state: body.drive,
            createdAt: 1,
            updatedAt: 1
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.createRoot')) {
      response.end(
        JSON.stringify({
          instance: {
            id: 'python-root',
            revision: 0,
            state: { status: 'created', depth: 0 },
            createdAt: 1,
            updatedAt: 1
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.createChild')) {
      response.end(
        JSON.stringify({
          instance: {
            id: 'python-child',
            revision: 0,
            state: { status: 'created', depth: 1, parentInstanceId: 'python-root' },
            createdAt: 2,
            updatedAt: 2
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.remove')) {
      response.end(
        JSON.stringify({
          instance: {
            id: 'python-child',
            revision: 1,
            state: { status: 'removed', depth: 1, parentInstanceId: 'python-root' },
            createdAt: 2,
            updatedAt: 3
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.pause')) {
      response.end(
        JSON.stringify({
          instance: {
            id: 'python-pause',
            revision: 2,
            state: { status: 'paused' },
            createdAt: 1,
            updatedAt: 2
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.resume')) {
      response.end(
        JSON.stringify({
          instance: {
            id: 'python-pause',
            revision: 3,
            state: { status: 'running' },
            createdAt: 1,
            updatedAt: 3
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.config.stage')) {
      response.end(
        JSON.stringify({
          instance: {
            id: 'python-config',
            revision: 1,
            state: { configVersion: body.configVersion, pendingConfigVersion: body.configVersion },
            createdAt: 1,
            updatedAt: 2
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.config.activate')) {
      response.end(
        JSON.stringify({
          instance: {
            id: 'python-config',
            revision: 2,
            state: { configVersion: 'v2', previousConfigVersion: 'v1' },
            createdAt: 1,
            updatedAt: 3
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.config.create')) {
      response.end(
        JSON.stringify({
          version: 'v2',
          definitionId: 'definition',
          contentDigest: 'a'.repeat(64),
          createdAt: 1
        })
      )
      return
    }
    if (
      request.url?.endsWith('/team.create') ||
      request.url?.endsWith('/team.member.add') ||
      request.url?.endsWith('/team.member.remove') ||
      request.url?.endsWith('/team.remove')
    ) {
      const revision = request.url.endsWith('/team.create')
        ? 0
        : request.url.endsWith('/team.member.add')
          ? 1
          : request.url.endsWith('/team.member.remove')
            ? 2
            : 3
      response.end(
        JSON.stringify({
          id: 'team',
          revision,
          state: { id: 'team' },
          createdAt: 1,
          updatedAt: revision + 1
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.replace')) {
      response.end(
        JSON.stringify({
          id: 'python-instance',
          revision: 1,
          state: { definitionId: 'new', configVersion: 'v2' },
          createdAt: 1,
          updatedAt: 2
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.config.rollback')) {
      response.end(
        JSON.stringify({
          instance: {
            id: 'python-config',
            revision: 3,
            state: { configVersion: 'v1', previousConfigVersion: 'v2' },
            createdAt: 1,
            updatedAt: 4
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.publish')) {
      response.end(
        JSON.stringify({
          messageId: 'python-message',
          revision: 1,
          channelId: 'python-channel',
          status: 'published'
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.create')) {
      response.end(
        JSON.stringify({
          channel: {
            id: 'python-created-channel',
            revision: 0,
            state: {
              id: 'python-created-channel',
              name: 'Created',
              mode: 'queue',
              capacity: 5,
              members: [],
              createdAt: 1
            },
            createdAt: 1,
            updatedAt: 1
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.join')) {
      response.end(
        JSON.stringify({
          channel: {
            id: 'python-membership',
            revision: 1,
            state: {
              id: 'python-membership',
              name: 'Membership',
              mode: 'queue',
              capacity: 2,
              members: [body.member]
            },
            createdAt: 1,
            updatedAt: 2
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.leave')) {
      response.end(
        JSON.stringify({
          channel: {
            id: 'python-membership',
            revision: 2,
            state: {
              id: 'python-membership',
              name: 'Membership',
              mode: 'queue',
              capacity: 2,
              members: []
            },
            createdAt: 1,
            updatedAt: 3
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.wire')) {
      response.end(
        JSON.stringify({
          wire: {
            id: 'python-wire-mutation',
            revision: 0,
            state: body.wire,
            createdAt: 1,
            updatedAt: 1
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.unwire')) {
      response.end(
        JSON.stringify({
          wire: {
            id: 'python-wire-mutation',
            revision: 1,
            state: {
              id: 'python-wire-mutation',
              sourceChannelId: 'source',
              targetChannelId: 'target',
              targetPublisherMemberId: 'publisher',
              enabled: false,
              createdAt: 1,
              maxHops: 4
            },
            createdAt: 1,
            updatedAt: 2
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.wire.list')) {
      response.end(
        JSON.stringify({
          wires: [
            {
              id: 'python-wire',
              revision: 1,
              state: {
                id: 'python-wire',
                sourceChannelId: 'source',
                targetChannelId: 'target',
                targetPublisherMemberId: 'publisher',
                enabled: true,
                createdAt: 1,
                maxHops: 4
              },
              createdAt: 1,
              updatedAt: 2
            }
          ]
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.wire.get')) {
      response.end(
        JSON.stringify({
          wire: {
            id: 'python-wire',
            revision: 1,
            state: {
              id: 'python-wire',
              sourceChannelId: 'source',
              targetChannelId: 'target',
              targetPublisherMemberId: 'publisher',
              enabled: true,
              createdAt: 1,
              maxHops: 4
            },
            createdAt: 1,
            updatedAt: 2
          }
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.claim')) {
      response.end(
        JSON.stringify({
          messageId: 'python-message',
          revision: 1,
          channelId: 'python-channel',
          consumerMemberId: 'consumer',
          claimToken: 'python-claim-token',
          leaseExpiresAt: 110
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.ack')) {
      response.end(
        JSON.stringify({
          messageId: 'python-message',
          revision: 2,
          channelId: 'python-channel',
          consumerMemberId: 'consumer',
          acknowledgedAt: 20
        })
      )
      return
    }
    if (request.url?.endsWith('/channel.list')) {
      response.end(
        JSON.stringify({
          channels: [
            {
              id: 'python-channel',
              revision: 1,
              state: {
                id: 'python-channel',
                name: 'Channel',
                mode: 'queue',
                capacity: 2,
                members: []
              },
              createdAt: 1,
              updatedAt: 2
            }
          ]
        })
      )
      return
    }
    if (request.url?.endsWith('/agentInstance.list')) {
      response.end(
        JSON.stringify({
          instances: [
            {
              id: 'python-instance',
              revision: 0,
              state: { status: 'created' },
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      )
      return
    }
    if (request.url?.endsWith('/trigger.manualFire')) {
      response.end(
        JSON.stringify({
          occurrence: {
            id: 'python-e2e-run',
            revision: 0,
            state: { received: body },
            createdAt: 1,
            updatedAt: 1
          }
        })
      )
      return
    }
    response.end(
      JSON.stringify({ runId: 'python-e2e-run', status: 'completed', output: { received: body } })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server address.')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
})

describe('Python SDK HTTP boundary', () => {
  it('exports and diffs sessions through external typed Python sync and async clients', async () => {
    const source = `
import asyncio, json
from magicpot_agent_sdk import AsyncMagicAgentClient, HttpAgentTransport, MagicAgentClient, SessionDiffRequest, SessionExportRequest, SessionRoute
left = SessionRoute('generic', 'dm', 'python-source')
right = SessionRoute('generic', 'dm', 'python-target')
sync = MagicAgentClient(HttpAgentTransport('${baseUrl}', 'python-token'))
exports = [sync.export_session(SessionExportRequest(left, fmt)) for fmt in ('markdown', 'html', 'jsonl')]
sync_diff = sync.diff_sessions(SessionDiffRequest(left, right))
async def main():
    client = AsyncMagicAgentClient(HttpAgentTransport('${baseUrl}', 'python-token'))
    async_export = await client.export_session(SessionExportRequest(left, 'jsonl'))
    async_diff = await client.diff_sessions(SessionDiffRequest(left, right))
    print(json.dumps({'formats':[item.format for item in exports], 'filename':async_export.filename, 'left':sync_diff.left_session_key, 'relationship':async_diff.relationship['relationship']}))
asyncio.run(main())
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn('python', ['-c', source], {
          env: { ...process.env, PYTHONPATH: pythonSdk },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      formats: ['markdown', 'html', 'jsonl'],
      filename: 'python-session.jsonl',
      left: 'generic:dm:python-source',
      relationship: 'right-forked-from-left'
    })
  })

  it('forks a session through an external typed Python sync and async client', async () => {
    const source = `
import asyncio, json
from magicpot_agent_sdk import AsyncMagicAgentClient, HttpAgentTransport, MagicAgentClient, SessionForkRequest, SessionRoute
request = SessionForkRequest(SessionRoute('generic', 'dm', 'python-source'), 'event-2', SessionRoute('generic', 'dm', 'python-target'), 'fork-python')
sync_result = MagicAgentClient(HttpAgentTransport('${baseUrl}', 'python-token')).fork_session_at_event(request)
async def main():
    async_result = await AsyncMagicAgentClient(HttpAgentTransport('${baseUrl}', 'python-token')).fork_session_at_event(request)
    print(json.dumps({'sync': sync_result.target_session_key, 'async': async_result.counts.events, 'warning': async_result.warning}))
asyncio.run(main())
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn('python', ['-c', source], {
          env: { ...process.env, PYTHONPATH: pythonSdk },
          stdio: ['ignore', 'pipe', 'pipe']
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += chunk
        })
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      sync: 'generic:dm:python-target',
      async: 3,
      warning: 'External side effects are not rolled back.'
    })
  })

  it('streams graph-run attach events to an external async Python consumer', async () => {
    const code = `import asyncio, json
from magicpot_agent_sdk import AsyncMagicAgentClient, HttpAgentTransport
async def main():
    client = AsyncMagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
    events = client.attach_graph_run('python-run', {'channel':'sdk','scopeType':'run','scopeId':'python-run'}, 'event-0')
    received = []
    try:
        async for event in events:
            received.append(event)
            if event['payload']['status'] == 'completed':
                break
    finally:
        await events.aclose()
    print(json.dumps({'ids':[e['eventId'] for e in received], 'last':received[-1]['payload']['status']}))
asyncio.run(main())
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ ids: ['event-1', 'event-2'], last: 'completed' })
  })

  it('runs as an external Python consumer against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import AgentRunRequest, HttpAgentTransport, MagicAgentClient
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
result = client.run(AgentRunRequest('python-agent', {'prompt': 'hello'}, session_id='python-e2e'))
print(json.dumps({'runId': result.run_id, 'status': result.status, 'output': result.output}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      runId: 'python-e2e-run',
      status: 'completed',
      output: { received: { agentId: 'python-agent', input: { prompt: 'hello' } } }
    })
  })

  it('uses Python typed Agent replace against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, AgentInstanceReplaceRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
result = client.replace_agent_instance(AgentInstanceReplaceRequest('python-instance', 0, 'new', 'New', 'v2', 2, 'replace'))
print(json.dumps({'id':result.id,'revision':result.revision,'definition':result.state['definitionId']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      id: 'python-instance',
      revision: 1,
      definition: 'new'
    })
  })

  it('uses Python typed Agent create/remove against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, AgentInstanceCreateRootRequest, AgentInstanceCreateChildRequest, AgentInstanceRemoveRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
root = client.create_root_agent_instance(AgentInstanceCreateRootRequest({'id': 'python-root'}, 1, 'root', 'grant', 0))
child = client.create_child_agent_instance(AgentInstanceCreateChildRequest(root.id, root.revision, {'id': 'python-child'}, 2, 'child'))
removed = client.remove_agent_instance(AgentInstanceRemoveRequest(child.id, child.revision, 3, 'remove'))
print(json.dumps({'root': root.id, 'child': child.id, 'removed': removed.state['status']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      root: 'python-root',
      child: 'python-child',
      removed: 'removed'
    })
  })

  it('uses Python typed Agent pause/resume against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, AgentInstancePauseResumeRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
paused = client.pause_agent_instance(AgentInstancePauseResumeRequest('python-pause', 1, 'pause'))
resumed = client.resume_agent_instance(AgentInstancePauseResumeRequest('python-pause', paused.revision, 'resume'))
print(json.dumps({'paused': paused.state['status'], 'resumed': resumed.state['status']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ paused: 'paused', resumed: 'running' })
  })

  it('uses Python typed Team replace against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, AgentTeamMemberReplacement, AgentTeamReplaceRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
result = client.replace_team(AgentTeamReplaceRequest('python-team', 1, [AgentTeamMemberReplacement('member','new','New','v2',2)], 'replace'))
print(json.dumps({'action':result['action'],'status':result['status']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ action: 'replace', status: 'completed' })
  })

  it('uses Python typed Team lifecycle against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, AgentTeamStartRequest, AgentTeamLifecycleRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
start = client.start_team(AgentTeamStartRequest('python-team', 1, 'start', {'agentId':'agent','text':'run'}))
client.pause_team(AgentTeamLifecycleRequest('python-team', 1, 'pause'))
client.resume_team(AgentTeamLifecycleRequest('python-team', 1, 'resume'))
client.stop_team(AgentTeamLifecycleRequest('python-team', 1, 'stop'))
print(json.dumps({'status':start['status'],'teamId':start['teamId']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ status: 'partial', teamId: 'python-team' })
  })

  it('uses Python typed Team mutations against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, AgentTeamCreateRequest, AgentTeamAddMemberRequest, AgentTeamRemoveMemberRequest, AgentTeamRemoveRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
created = client.create_team(AgentTeamCreateRequest({'id':'team','name':'Team','createdAt':1}, 'create'))
added = client.add_team_member(AgentTeamAddMemberRequest('team', 0, {'memberId':'m','agentInstanceId':'agent','role':'leader','joinedAt':2}, 'add'))
removed_member = client.remove_team_member(AgentTeamRemoveMemberRequest('team', 1, 'm', 3, 'remove-member'))
removed = client.remove_team(AgentTeamRemoveRequest('team', 2, 4, 'remove'))
print(json.dumps({'create':created['revision'],'add':added['revision'],'removeMember':removed_member['revision'],'remove':removed['revision']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ create: 0, add: 1, removeMember: 2, remove: 3 })
  })

  it('uses Python typed Agent config version methods against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, AgentConfigCreateRequest, AgentConfigStageRequest, AgentConfigActivateRequest, AgentConfigRollbackRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
created = client.create_agent_config_version(AgentConfigCreateRequest({'version':'v2','definitionId':'definition','model':{'profileId':'model'},'systemPrompt':'safe','inference':{},'tools':{'allowedToolNames':[]},'memory':{'allowHistory':False,'contextMessageLimit':1,'scope':'instance'},'policy':{'policyIds':[],'workspaceRoots':[]},'channels':{'channelIds':[]},'budgets':{'maxRuntimeMs':100},'createdAt':1}, 'create'))
staged = client.stage_agent_config(AgentConfigStageRequest('python-config', 0, 'v2', 1, 'stage'))
active = client.activate_agent_config(AgentConfigActivateRequest('python-config', staged.revision, 2, 'activate'))
rollback = client.rollback_agent_config(AgentConfigRollbackRequest('python-config', active.revision, 3, 'rollback'))
print(json.dumps({'created': created.version, 'active': active.state['configVersion'], 'rollback': rollback.state['configVersion']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ created: 'v2', active: 'v2', rollback: 'v1' })
  })

  it('uses Python typed RuntimeChannel publish against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, RuntimeChannelPublishRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
result = client.publish_runtime_channel_message(RuntimeChannelPublishRequest({'id':'python-message','channelId':'python-channel','publisherMemberId':'producer','payload':{'text':'hello'},'priority':1,'publishedAt':2}, 1, 'publish', 'grant', 0))
print(json.dumps({'id': result.message_id, 'status': result.status}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ id: 'python-message', status: 'published' })
  })

  it('uses Python typed RuntimeChannel create against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, RuntimeChannelCreateRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
channel = client.create_runtime_channel(RuntimeChannelCreateRequest({'id':'python-created-channel','name':'Created','mode':'queue','capacity':5}, 1, 'create', 'grant', 0))
print(json.dumps({'id': channel.id, 'mode': channel.state['mode']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ id: 'python-created-channel', mode: 'queue' })
  })

  it('uses Python typed RuntimeChannel membership against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, RuntimeChannelJoinRequest, RuntimeChannelLeaveRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
member = {'memberId':'member','agentInstanceId':'agent-1','role':'consumer','joinedAt':1}
joined = client.join_runtime_channel(RuntimeChannelJoinRequest('python-membership', 0, member, 1, 'join'))
left = client.leave_runtime_channel(RuntimeChannelLeaveRequest(joined.id, joined.revision, 'member', 2, 'leave'))
print(json.dumps({'joined': len(joined.state['members']), 'left': len(left.state['members'])}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ joined: 1, left: 0 })
  })

  it('uses Python typed RuntimeChannel Wire mutations against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, RuntimeChannelWireRequest, RuntimeChannelUnwireRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
state = {'id':'python-wire-mutation','sourceChannelId':'source','targetChannelId':'target','targetPublisherMemberId':'publisher','enabled':True,'createdAt':1,'maxHops':4}
wired = client.wire_runtime_channel(RuntimeChannelWireRequest(state, 'wire'))
unwired = client.unwire_runtime_channel(RuntimeChannelUnwireRequest(wired.id, wired.revision, 2, 'unwire'))
print(json.dumps({'wired': wired.id, 'enabled': unwired.state['enabled']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ wired: 'python-wire-mutation', enabled: false })
  })

  it('uses Python typed RuntimeChannel Wire methods against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
listed = client.list_runtime_channel_wires()[0]
wire = client.get_runtime_channel_wire('python-wire')
print(json.dumps({'listed': listed.id, 'max_hops': wire.state['maxHops']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ listed: 'python-wire', max_hops: 4 })
  })

  it('uses Python typed RuntimeChannel delivery against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, RuntimeChannelClaimRequest, RuntimeChannelAcknowledgeRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
claimed = client.claim_runtime_channel_message(RuntimeChannelClaimRequest('python-message', 0, 'consumer', 10, 100, 'claim'))
ack = client.acknowledge_runtime_channel_message(RuntimeChannelAcknowledgeRequest('python-message', claimed.revision, 'consumer', 20, claimed.claim_token, 'ack'))
print(json.dumps({'token': claimed.claim_token, 'ack': ack.acknowledged_at, 'ack_token': ack.claim_token}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      token: 'python-claim-token',
      ack: 20,
      ack_token: null
    })
  })

  it('uses Python typed RuntimeChannel methods against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
value = client.list_runtime_channels()[0]
print(json.dumps({'id': value.id, 'mode': value.state['mode']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ id: 'python-channel', mode: 'queue' })
  })

  it('uses Python typed AgentInstance methods against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
value = client.list_agent_instances()[0]
print(json.dumps({'id': value.id, 'revision': value.revision}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ id: 'python-instance', revision: 0 })
  })

  it('uses Python pending Graph input methods against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, GraphRunInjectPendingInputRequest, GraphRunEditPendingInputRequest, GraphRunPendingInputMutationRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
route = {'channel': 'sdk', 'scopeType': 'run', 'scopeId': 'run'}
common = {'run_id': 'run', 'route': route, 'pending_input_id': 'pending', 'expected_revision': 1}
a = client.edit_pending_input(GraphRunEditPendingInputRequest(**common, value='draft', idempotency_key='edit'))
b = client.inject_pending_input(GraphRunInjectPendingInputRequest(**common, value='final', idempotency_key='inject'))
c = client.cancel_pending_input(GraphRunPendingInputMutationRequest(**common, idempotency_key='cancel'))
print(json.dumps([a.status, b.status, c.status]))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = '',
          stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result).toMatchObject({ status: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toEqual(['awaiting', 'submitted', 'cancelled'])
  })

  it('uses Python typed Drive methods against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, DriveCreateRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
value = client.create_drive(DriveCreateRequest({'id': 'python-drive'}, 1, 'python-drive-create'))
print(json.dumps({'id': value.id, 'revision': value.revision}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ id: 'python-e2e-run', revision: 0 })
  })

  it('uses Python typed Trigger methods against a real loopback listener', async () => {
    const code = `import json
from magicpot_agent_sdk import HttpAgentTransport, MagicAgentClient, TriggerManualFireRequest
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
value = client.manual_fire_trigger(TriggerManualFireRequest('python-trigger', 0, 'manual', 1, 'python-occurrence'))
print(json.dumps({'id': value.id, 'status': value.state['received']['occurrenceId']}))
`
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn('python', ['-c', code], {
          env: { ...process.env, PYTHONPATH: pythonSdk }
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
        child.once('error', reject)
        child.once('close', (status) => resolve({ status, stdout, stderr }))
      }
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      id: 'python-e2e-run',
      status: 'python-occurrence'
    })
  })

  it('uses the sync Python semantic memory API over real HTTP without an actor', async () => {
    semanticMemoryRequests.length = 0
    const dir = mkdtempSync(path.join(process.cwd(), '.tmp-python-memory-'))
    const script = path.join(dir, 'semantic_memory_sync.py')
    writeFileSync(
      script,
      `import json
from magicpot_agent_sdk import *
route = SessionRoute('generic', 'dm', 'owner')
scope = SemanticMemoryScope('session', route)
client = MagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
calls = [
 ('memory.ingestSession', client.ingest_session_memory(SemanticMemoryIngestSessionRequest(route, 'local'))),
 ('memory.search', client.search_semantic_memory(SemanticMemorySearchRequest('alpha', (scope,), 'hybrid', 'local', 3))),
 ('memory.inspect', client.inspect_semantic_memory(SemanticMemoryInspectRequest('m1', route))),
 ('memory.setDisabled', client.set_semantic_memory_disabled(SemanticMemorySetDisabledRequest('m1', route, True))),
 ('memory.setVisibility', client.set_semantic_memory_visibility(SemanticMemorySetVisibilityRequest('m1', route, 'workspace'))),
 ('memory.delete', client.delete_semantic_memory(SemanticMemoryInspectRequest('m1', route))),
 ('memory.clearScope', client.clear_semantic_memory_scope(SemanticMemoryClearScopeRequest(scope))),
 ('memory.rebuild', client.rebuild_semantic_memory(SemanticMemoryRebuildRequest(route, 'local', 'job', 2))),
]
print(json.dumps([value['method'] for _, value in calls]))
`
    )
    try {
      const result = await runPythonFile(script)
      expect(result).toMatchObject({ status: 0, stderr: '' })
      expect(JSON.parse(result.stdout)).toEqual(semanticMemoryRequests.map(({ method }) => method))
      expect(semanticMemoryRequests.map(({ method }) => method)).toEqual([
        'memory.ingestSession',
        'memory.search',
        'memory.inspect',
        'memory.setDisabled',
        'memory.setVisibility',
        'memory.delete',
        'memory.clearScope',
        'memory.rebuild'
      ])
      expect(semanticMemoryRequests.every(({ body }) => !('actor' in body))).toBe(true)
      expect(semanticMemoryRequests[1].body).toMatchObject({
        query: 'alpha',
        mode: 'hybrid',
        providerId: 'local',
        limit: 3,
        scopes: [
          { kind: 'session', route: { channel: 'generic', scopeType: 'dm', scopeId: 'owner' } }
        ]
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the async Python semantic memory API over real HTTP without an actor', async () => {
    semanticMemoryRequests.length = 0
    const dir = mkdtempSync(path.join(process.cwd(), '.tmp-python-memory-'))
    const script = path.join(dir, 'semantic_memory_async.py')
    writeFileSync(
      script,
      `import asyncio, json
from magicpot_agent_sdk import *
async def main():
 route = SessionRoute('generic', 'dm', 'owner')
 scope = SemanticMemoryScope('session', route)
 client = AsyncMagicAgentClient(HttpAgentTransport(${JSON.stringify(baseUrl)}, 'python-token'))
 results = []
 results.append(await client.ingest_session_memory(SemanticMemoryIngestSessionRequest(route, 'local')))
 results.append(await client.search_semantic_memory(SemanticMemorySearchRequest('alpha', (scope,), 'semantic', 'local')))
 results.append(await client.inspect_semantic_memory(SemanticMemoryInspectRequest('m1', route)))
 results.append(await client.set_semantic_memory_disabled(SemanticMemorySetDisabledRequest('m1', route, False)))
 results.append(await client.set_semantic_memory_visibility(SemanticMemorySetVisibilityRequest('m1', route, 'private')))
 results.append(await client.delete_semantic_memory(SemanticMemoryInspectRequest('m1', route)))
 results.append(await client.clear_semantic_memory_scope(SemanticMemoryClearScopeRequest(scope)))
 results.append(await client.rebuild_semantic_memory(SemanticMemoryRebuildRequest(route, 'local')))
 print(json.dumps([value['method'] for value in results]))
asyncio.run(main())
`
    )
    try {
      const result = await runPythonFile(script)
      expect(result).toMatchObject({ status: 0, stderr: '' })
      expect(JSON.parse(result.stdout)).toEqual(semanticMemoryRequests.map(({ method }) => method))
      expect(semanticMemoryRequests).toHaveLength(8)
      expect(semanticMemoryRequests.every(({ body }) => !('actor' in body))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const runPythonFile = (script: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('python', [script], { env: { ...process.env, PYTHONPATH: pythonSdk } })
    let stdout = '',
      stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (status) => resolve({ status, stdout, stderr }))
  })
