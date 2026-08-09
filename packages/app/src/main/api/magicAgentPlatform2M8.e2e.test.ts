import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HttpAgentTransport,
  MagicAgentClient,
  type GraphDefinitionV2
} from '../../../../agent-sdk-typescript/src/index'
import {
  createFilesToolPolicyRequest,
  createTerminalPolicyRequest,
  validateGraphDefinitionV2Draft,
  type PolicyRequest,
  type PolicyRule
} from '../../shared/magicAgentPlatform2'
import { AssistantRuntime } from '../assistantRuntime/runtime'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { MagicAgentGraphRuntime } from '../magicAgentRuntime/graph/MagicAgentGraphRuntime'
import { MagicAgentGraphRunEventStore } from '../magicAgentRuntime/graph/graphRunEventStore'
import { MagicAgentUserGraphStore } from '../magicAgentRuntime/graph/userGraphStore'
import { createAgentInstanceLifecyclePolicyRequest } from '../magicAgentPlatform2/agents/productionAgentInstanceLifecycle'
import {
  closeProductionAgentInstanceLifecycle,
  ProductionAgentInstanceLifecycle,
  startProductionAgentInstanceLifecycle
} from '../magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner'
import { createMagicAgentConfigContent } from '../magicAgentPlatform2/agents/persistentAgentConfigStore'
import {
  createRuntimeChannelCreatePolicyRequest,
  createRuntimeChannelMembershipPolicyRequest,
  createRuntimeChannelPublishPolicyRequest
} from '../magicAgentPlatform2/channels/runtimeChannelCommandService'
import { ProductionRuntimeChannelLifecycle } from '../magicAgentPlatform2/channels/productionRuntimeChannelLifecycle'
import { createRuntimeChannelWirePolicyRequest } from '../magicAgentPlatform2/channels/runtimeChannelWireCommandService'
import { ProductionDriveRuntime } from '../magicAgentPlatform2/drives/productionDriveRuntime'
import {
  EmbeddingProviderRegistry,
  PublicSemanticMemoryService,
  SemanticMemoryService,
  SqliteSemanticMemoryStore
} from '../magicAgentPlatform2/memory'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import {
  MagicAgentPolicyAuthorizationService,
  PermitConsumedError
} from '../magicAgentPlatform2/policy'
import { ProductionTriggerRuntime } from '../magicAgentPlatform2/triggers/productionTriggerRuntime'
import {
  FilesToolAuthorizationError,
  FilesToolHost,
  TerminalRunToolHost,
  type FilesToolAuditEvidence,
  type TerminalRunAuditEvidence
} from '../magicAgentPlatform2/toolHost'
import {
  closeAssistantTerminalPolicyRuntime,
  getAssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
import { MagicAgentSdkGateway } from './magicAgentSdkGateway'
import {
  startMagicAgentSdkHttpServer,
  type MagicAgentSdkHttpServer
} from './magicAgentSdkHttpServer'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => process.cwd(), getVersion: () => '1' }
}))
vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const artifacts: string[] = []
const originalFeatureFlag = process.env['MAGICPOT_MAGICAGENT_PLATFORM']
let sdkServer: MagicAgentSdkHttpServer | undefined
const cleanups: Array<() => void | Promise<void>> = []

const cleanupAfterTest = (cleanup: () => void | Promise<void>): void => {
  cleanups.push(cleanup)
}

afterEach(async () => {
  await sdkServer?.close()
  sdkServer = undefined
  closeAssistantTerminalPolicyRuntime()
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch {
      // Continue closing remaining owners so temporary SQLite files can be removed.
    }
  }
  for (const artifact of artifacts.splice(0)) rmSync(artifact, { recursive: true, force: true })
  if (originalFeatureFlag === undefined) delete process.env['MAGICPOT_MAGICAGENT_PLATFORM']
  else process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = originalFeatureFlag
}, 60_000)

const actor = { kind: 'user', id: 'owner' } as const
const agentActor = { kind: 'agent', id: 'coding-agent' } as const
const approver = { kind: 'user', id: 'approver' } as const
const route = { channel: 'e2e', scopeType: 'dm', scopeId: 'platform-2-m8' } as const
const sessionKey = 'e2e:dm:platform-2-m8'
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const waitForFile = async (file: string, child: ChildProcess): Promise<void> => {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(file)) return
    if (child.exitCode !== null)
      throw new Error(`Abrupt recovery fixture exited ${child.exitCode}.`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Abrupt recovery fixture did not signal readiness.')
}

const terminateProcessTree = async (child: ChildProcess): Promise<void> => {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      killer.once('error', reject)
      killer.once('exit', (code) =>
        code === 0 || code === 128 ? resolve() : reject(new Error(`taskkill exited ${code}.`))
      )
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

const policyRequestAction = (request: unknown): string => {
  if (
    typeof request !== 'object' ||
    request === null ||
    !('action' in request) ||
    typeof request.action !== 'string'
  ) {
    throw new TypeError('Authorization request must contain an action')
  }
  return request.action
}

const graphV2: GraphDefinitionV2 = {
  kind: 'magic-agent.graph-definition.v2-draft',
  graphMode: 'design',
  schemaVersion: '2.0.0',
  graphId: 'acceptance.platform-2.m8',
  name: 'M8 strict acceptance graph',
  description: 'A nontrivial typed graph retained losslessly by SDK and Studio persistence.',
  version: '2.0.0',
  tags: ['m8', 'acceptance'],
  entryNodeIds: ['research'],
  nodes: [
    {
      nodeId: 'research',
      kind: 'agent',
      name: 'Research',
      description: 'Collect deterministic evidence for the acceptance run.',
      position: { x: 20, y: 40 },
      inputs: [],
      outputs: [
        {
          portId: 'facts',
          name: 'Facts',
          direction: 'output',
          role: 'data',
          valueType: { kind: 'array', schemaRef: '#/$defs/facts' },
          required: true
        }
      ],
      config: {},
      metadata: { editor: { color: '#3366ff' } }
    },
    {
      nodeId: 'review',
      kind: 'output',
      name: 'Review',
      description: 'Publish the reviewed acceptance report.',
      position: { x: 360, y: 40 },
      inputs: [
        {
          portId: 'facts-in',
          name: 'Facts',
          direction: 'input',
          role: 'data',
          valueType: { kind: 'array', schemaRef: '#/$defs/facts' },
          required: true
        }
      ],
      outputs: [
        {
          portId: 'report',
          name: 'Report',
          direction: 'output',
          role: 'data',
          valueType: { kind: 'object', schemaRef: '#/$defs/report' },
          required: true
        }
      ],
      config: {},
      metadata: { editor: { pinned: true } }
    }
  ],
  edges: [
    {
      edgeId: 'research-review',
      kind: 'data',
      source: { nodeId: 'research', portId: 'facts' },
      target: { nodeId: 'review', portId: 'facts-in' },
      label: 'verified facts',
      metadata: { editor: { curve: 'smooth' } }
    }
  ],
  variables: [
    {
      variableId: 'query',
      name: 'Query',
      scope: 'input',
      valueType: { kind: 'string' },
      defaultValue: 'strict acceptance'
    },
    {
      variableId: 'credential-secret-id',
      name: 'Credential',
      scope: 'secret',
      valueType: { kind: 'string' },
      sensitive: true
    }
  ],
  outputs: [
    {
      outputId: 'report',
      name: 'Report',
      description: 'The reviewed acceptance report.',
      source: { nodeId: 'review', portId: 'report' },
      metadata: { mediaType: 'application/json' }
    }
  ],
  metadata: {
    editor: { viewport: { x: 10, y: -5, zoom: 0.9 }, grid: { size: 16, snap: true } },
    schemas: {
      $defs: {
        facts: { type: 'array', items: { type: 'string' } },
        report: {
          type: 'object',
          required: ['summary'],
          properties: { summary: { type: 'string' } }
        }
      }
    }
  },
  legacySnapshot: {
    graphId: 'acceptance.platform-2.m8',
    name: 'M8 strict acceptance graph',
    description: 'A nontrivial typed graph retained losslessly by SDK and Studio persistence.',
    version: '2.0.0',
    tags: ['m8', 'acceptance'],
    entryNodeIds: ['research'],
    nodes: [
      {
        nodeId: 'research',
        kind: 'agent',
        name: 'Research',
        description: 'Collect deterministic evidence for the acceptance run.',
        agentId: 'research-agent'
      },
      {
        nodeId: 'review',
        kind: 'output',
        name: 'Review',
        description: 'Publish the reviewed acceptance report.'
      }
    ],
    channels: [
      {
        channelId: 'research-review',
        from: 'research',
        to: 'review',
        kind: 'artifact',
        required: true
      }
    ],
    outputs: [
      {
        outputId: 'report',
        name: 'Report',
        description: 'The reviewed acceptance report.',
        sourceNodeId: 'review',
        channelId: 'research-review'
      }
    ]
  }
}

describe('Magic Agent Platform 2 M8 strict production acceptance', () => {
  it('demonstrates docs §8 steps 1-12 once, in order, through production-owned boundaries', async () => {
    process.env['MAGICPOT_MAGICAGENT_PLATFORM'] = '1'
    const root = await mkdtemp(path.join(tmpdir(), 'magic-agent-platform-2-m8-'))
    artifacts.push(root)
    const databasePath = path.join(root, 'events.sqlite3')
    const workspace = path.join(root, 'workspace')
    mkdirSync(workspace)
    const targetFile = path.join(workspace, 'feature.txt')
    writeFileSync(targetFile, 'before\n', 'utf8')
    let clock = Date.now()
    const now = () => clock++
    const policyCalls: string[] = []
    const policyRequests: PolicyRequest[] = []
    const audits: Array<FilesToolAuditEvidence | TerminalRunAuditEvidence> = []
    const rules: PolicyRule[] = [
      {
        ruleId: 'channel-create-allow',
        priority: 2_000,
        effect: 'require-approval',
        match: {
          origins: ['internal'],
          actions: ['runtime-channel.create'],
          targetKinds: ['runtime-channel']
        },
        explanation: 'M8 production channel creation.',
        approvalRequirement: {
          scopeKind: 'request',
          scopeValue: '*',
          maxUses: 1,
          expiresInMs: 60_000,
          reason: 'M8 channel approval'
        }
      },
      {
        ruleId: 'file-and-terminal-approval',
        priority: 100,
        effect: 'require-approval',
        match: { actions: ['filesystem.write', 'terminal.execute'] },
        constraints: {
          allowedRoots: [workspace],
          allowedToolNames: ['files.edit', 'terminal.run'],
          allowedCommands: [process.execPath],
          maxTimeoutMs: 30_000,
          maxOutputChars: 8_192
        },
        explanation: 'High-risk mutation and command execution require one-shot approval.',
        approvalRequirement: {
          scopeKind: 'request',
          scopeValue: '*',
          maxUses: 1,
          expiresInMs: 60_000,
          reason: 'M8 acceptance approval'
        }
      },
      {
        ruleId: 'channel-membership-allow',
        priority: 2_000,
        effect: 'allow',
        match: { actions: ['runtime-channel.membership'], targetKinds: ['runtime-channel'] },
        explanation: 'M8 production channel membership.'
      },
      {
        ruleId: 'channel-publish-allow',
        priority: 2_000,
        effect: 'allow',
        match: { actions: ['runtime-channel.publish'], targetKinds: ['runtime-channel'] },
        explanation: 'M8 production channel publication.'
      },
      {
        ruleId: 'channel-wire-allow',
        priority: 2_000,
        effect: 'allow',
        match: { actions: ['runtime-channel.wire'], targetKinds: ['runtime-channel'] },
        explanation: 'M8 production channel wiring.'
      },
      {
        ruleId: 'agent-lifecycle-allow',
        priority: 2_000,
        effect: 'require-approval',
        match: {
          origins: ['internal'],
          actorKinds: ['user'],
          actions: ['agent-instance.start', 'agent-instance.pause', 'agent-instance.resume'],
          targetKinds: ['agent-instance'],
          effectKinds: ['agent.lifecycle'],
          risks: ['high']
        },
        explanation: 'M8 high-risk production agent lifecycle requires one-shot approval.',
        approvalRequirement: {
          scopeKind: 'request',
          scopeValue: '*',
          maxUses: 1,
          expiresInMs: 60_000,
          reason: 'M8 lifecycle approval'
        }
      },
      {
        ruleId: 'acceptance-allow',
        priority: 1,
        effect: 'allow',
        explanation: 'Allow bounded acceptance control-plane operations.'
      }
    ]
    const authorizationFor = (store: MagicAgentEventStore, storeId: string) => {
      const authorization = new MagicAgentPolicyAuthorizationService({
        store,
        rules,
        policyVersion: 'm8-strict-v1',
        storeId,
        trustedApprovers: [approver]
      })
      const original = authorization.authorize.bind(authorization)
      authorization.authorize = ((input) => {
        policyCalls.push(policyRequestAction(input.request))
        policyRequests.push(input.request as PolicyRequest)
        return original(input)
      }) as typeof authorization.authorize
      return authorization
    }

    // Step 1: persist the schedule, close the application store, then reconstruct it.
    let store = new MagicAgentEventStore(databasePath)
    cleanupAfterTest(() => store.close())
    let authorization = authorizationFor(store, 'before-reconstruction')
    const triggerGrantProvider = async (request: PolicyRequest) => {
      const id = `trigger-grant:${request.requestId}`
      const grant = authorization.createApprovalGrant({
        grantId: id,
        request,
        approvedBy: approver,
        issuedAt: now(),
        expiresAt: now() + 59_999,
        maxUses: 1,
        idempotencyKey: id
      })
      return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
    }
    let triggerRuntime = new ProductionTriggerRuntime({
      eventStore: store,
      authorization,
      service: { runAgent: vi.fn(), runGraph: vi.fn() },
      grantProvider: triggerGrantProvider,
      routeResolver: () => ({ trusted: true }),
      now,
      pollInterval: 60_000
    })
    triggerRuntime.store.create(
      {
        id: 'scheduled-acceptance',
        type: 'schedule',
        title: 'M8 persisted schedule',
        enabled: true,
        config: {
          target: { kind: 'agent-run', agentId: 'coordinator', prompt: 'coordinate acceptance' }
        },
        schedule: { type: 'interval', intervalMs: 60_000 },
        nextFireAt: 0
      },
      now()
    )
    await triggerRuntime.stop()
    store.close()

    store = new MagicAgentEventStore(databasePath)
    authorization = authorizationFor(store, 'after-reconstruction')
    const driveRuntime = new ProductionDriveRuntime({
      eventStore: store,
      deliver: vi.fn(),
      now,
      deliveryEnabled: false
    })
    const fileHost = await FilesToolHost.create(authorization, {
      allowedRoots: [workspace],
      onAudit: (audit) => {
        audits.push(audit)
        persistToolAuditAttribution(audit.tool)
      }
    })
    const terminalHost = new TerminalRunToolHost(authorization, {
      allowedRoots: [workspace],
      allowedCommands: [process.execPath],
      onAudit: (audit) => {
        audits.push(audit)
        persistToolAuditAttribution(audit.tool)
      }
    })
    const completedRun = {
      runId: 'agent-run',
      agentId: 'agent',
      status: 'completed' as const,
      content: 'ok',
      messages: [],
      toolCalls: [],
      events: [],
      startedAt: now(),
      finishedAt: now()
    }
    let signalToolEntered!: () => void
    let releaseToolInvocation!: () => void
    let signalRunCompleted!: () => void
    const toolEntered = new Promise<void>((resolve) => (signalToolEntered = resolve))
    const releaseTool = new Promise<void>((resolve) => (releaseToolInvocation = resolve))
    const runCompleted = new Promise<void>((resolve) => (signalRunCompleted = resolve))
    const codingRunId = 'coding-lifecycle-run'
    const durableToolAuditAttributions: Array<{ actorId: string; runId: string; tool: string }> = []
    let toolAuditSequence = 0
    const persistToolAuditAttribution = (tool: string): void => {
      const attribution = { actorId: agentActor.id, runId: codingRunId, tool }
      durableToolAuditAttributions.push(attribution)
      store.appendBatch([
        {
          protocolVersion: '2.0.0',
          id: `coding-tool-audit:${toolAuditSequence}`,
          type: 'agent.tool.audit-attributed',
          createdAt: now(),
          payload: attribution,
          envelopeKind: 'event',
          streamId: `agent-run:${codingRunId}:audit`,
          sequence: toolAuditSequence++
        }
      ])
    }
    const agents = startProductionAgentInstanceLifecycle({
      eventStore: store,
      authorization,
      platformService: { runAgent: vi.fn(async () => completedRun) },
      runAgent: async (_request, { cooperativeExecution }) => {
        await cooperativeExecution.checkpoint('tool-invocation')
        const leaveToolInvocation = cooperativeExecution.enter('tool-invocation')
        signalToolEntered()
        try {
          const fileRequest = createFilesToolPolicyRequest({
            requestId: 'file-edit-request',
            actor: agentActor,
            target: { kind: 'tool', id: 'files.edit' },
            action: 'filesystem.write',
            toolInput: { path: 'feature.txt' },
            filesystem: { paths: ['feature.txt'] }
          })
          const editInput = {
            authorizationId: 'file-edit-auth',
            idempotencyKey: 'file-edit-execution',
            request: fileRequest,
            input: {
              path: 'feature.txt',
              expectedSha256: sha256('before\n'),
              replacements: [{ old: 'before', new: 'after', expectedOccurrences: 1 }]
            }
          }
          await expect(fileHost.edit(editInput)).rejects.toMatchObject({
            status: 'awaiting-approval'
          })
          expect(readFileSync(targetFile, 'utf8')).toBe('before\n')
          authorization.createApprovalGrant({
            grantId: 'file-edit-grant',
            request: fileRequest,
            approvedBy: approver,
            issuedAt: now(),
            expiresAt: now() + 59_999,
            maxUses: 1,
            idempotencyKey: 'approve-file-edit'
          })
          await fileHost.edit({
            ...editInput,
            grantId: 'file-edit-grant',
            expectedGrantUseCount: 0
          })
          expect(readFileSync(targetFile, 'utf8')).toBe('after\n')
          await expect(
            fileHost.edit({
              ...editInput,
              authorizationId: 'file-edit-reuse-auth',
              idempotencyKey: 'file-edit-reuse',
              grantId: 'file-edit-grant',
              expectedGrantUseCount: 0
            })
          ).rejects.toBeInstanceOf(FilesToolAuthorizationError)

          const testArgs = [
            '-e',
            `const fs=require('node:fs');if(fs.readFileSync(${JSON.stringify(targetFile)},'utf8')!=='after\\n')process.exit(1);process.stdout.write('test passed')`
          ]
          const terminalRequest = createTerminalPolicyRequest({
            requestId: 'test-command-request',
            actor: agentActor,
            target: { kind: 'tool', id: 'terminal.run' },
            command: process.execPath,
            args: testArgs,
            cwd: workspace,
            filesystem: { cwd: workspace, allowedRoots: [workspace] }
          })
          authorization.createApprovalGrant({
            grantId: 'test-command-grant',
            request: terminalRequest,
            approvedBy: approver,
            issuedAt: now(),
            expiresAt: now() + 59_999,
            maxUses: 1,
            idempotencyKey: 'approve-test-command'
          })
          const result = await terminalHost.run({
            authorizationId: 'test-command-auth',
            idempotencyKey: 'test-command-execution',
            request: terminalRequest,
            command: process.execPath,
            args: testArgs,
            cwd: workspace,
            grantId: 'test-command-grant',
            expectedGrantUseCount: 0
          })
          expect(result).toMatchObject({ status: 'completed', exitCode: 0, stdout: 'test passed' })
          await releaseTool
        } finally {
          leaveToolInvocation()
        }
        await cooperativeExecution.checkpoint('tool-invocation')
        signalRunCompleted()
        return { ...completedRun, runId: codingRunId, agentId: 'coding-definition' }
      },
      now
    })
    const channels = new ProductionRuntimeChannelLifecycle({
      eventStore: store,
      authorization,
      now,
      pollIntervalMs: 60_000
    })
    cleanupAfterTest(() => channels.close())
    cleanupAfterTest(() => closeProductionAgentInstanceLifecycle())
    cleanupAfterTest(() => triggerRuntime.stop())
    cleanupAfterTest(() => driveRuntime.stop())
    const coordinator = vi.fn(async () => {
      // Step 2: the scheduled coordinator creates/wakes a durable Drive.
      driveRuntime.store.create({
        drive: {
          id: 'drive-acceptance',
          title: 'Close §8',
          objective: 'Demonstrate the strict production scenario.',
          status: 'active',
          priority: 10,
          ownerId: actor.id,
          assigneeId: 'coordinator',
          deliveryTarget: { kind: 'agent', agentId: 'coordinator', text: 'wake' },
          links: [{ kind: 'session', targetId: sessionKey }],
          metadata: { source: 'persisted-schedule' }
        },
        createdAt: now(),
        idempotencyKey: 'drive-from-schedule'
      })

      // Step 3: coordinator dynamically creates research, coding and review Agents.
      const limits = {
        maxChildren: 3,
        maxDepth: 2,
        maxConcurrency: 3,
        maxRuntimeMs: 30_000,
        allowedToolNames: ['files.edit', 'terminal.run'],
        workspaceRoots: [workspace]
      }
      for (const role of ['research', 'coding', 'review']) {
        const version = `${role}-v1`
        agents.configStore.create({
          config: createMagicAgentConfigContent({
            version,
            definitionId: `${role}-definition`,
            model: { profileId: 'deterministic-test-model' },
            systemPrompt: `${role} acceptance role`,
            inference: { maxToolIterations: 2 },
            tools: { allowedToolNames: limits.allowedToolNames },
            memory: { allowHistory: true, contextMessageLimit: 8, scope: 'session' },
            policy: { policyIds: ['m8-strict-v1'], workspaceRoots: [workspace] },
            channels: { channelIds: ['coordination', 'review'] },
            budgets: { maxRuntimeMs: 30_000, maxToolCalls: 4 },
            createdAt: now(),
            createdBy: actor
          }),
          idempotencyKey: `config-${role}`
        })
        const createdAt = now()
        const instance = {
          id: `${role}-agent`,
          name: `${role} agent`,
          definitionId: `${role}-definition`,
          depth: 0,
          configVersion: version,
          status: 'created' as const,
          limits
        }
        const request = createAgentInstanceLifecyclePolicyRequest({
          actor,
          action: 'create',
          instance: {
            kind: 'agent-instance',
            id: instance.id,
            revision: 0,
            state: instance,
            deleted: false,
            createdAt,
            updatedAt: createdAt
          }
        })
        const grantId = `create-${role}-grant`
        authorization.createApprovalGrant({
          grantId,
          request,
          approvedBy: approver,
          issuedAt: now(),
          expiresAt: now() + 59_999,
          maxUses: 1,
          idempotencyKey: grantId
        })
        agents.commands.createRoot({
          actor,
          instance,
          createdAt,
          idempotencyKey: `create-${role}`,
          grantId,
          expectedGrantUseCount: 0
        })
      }

      // Step 4: production Channel/Wiring forwards coordinator communication.
      const issueChannelGrant = (grantId: string, request: PolicyRequest) => {
        const issuedAt = now()
        const grant = authorization.createApprovalGrant({
          grantId,
          request,
          approvedBy: approver,
          issuedAt,
          expiresAt: issuedAt + 60_000,
          maxUses: 1,
          idempotencyKey: grantId
        })
        return { grantId: grant.grant.grantId, expectedGrantUseCount: grant.grant.useCount }
      }
      const sourceChannel = {
        id: 'coordination',
        name: 'Coordination',
        mode: 'queue' as const,
        capacity: 8,
        members: []
      }
      let source = channels.commands.create({
        actor,
        channel: sourceChannel,
        createdAt: now(),
        idempotencyKey: 'channel-coordination',
        ...issueChannelGrant(
          'channel-coordination-grant',
          createRuntimeChannelCreatePolicyRequest({ actor, channel: sourceChannel })
        )
      })
      const targetChannel = {
        id: 'review',
        name: 'Review',
        mode: 'queue' as const,
        capacity: 8,
        members: []
      }
      let target = channels.commands.create({
        actor,
        channel: targetChannel,
        createdAt: now(),
        idempotencyKey: 'channel-review',
        ...issueChannelGrant(
          'channel-review-grant',
          createRuntimeChannelCreatePolicyRequest({ actor, channel: targetChannel })
        )
      })
      const codingMember = {
        memberId: 'coding-publisher',
        agentInstanceId: 'coding-agent',
        role: 'producer' as const,
        joinedAt: now()
      }
      source = channels.commands.join({
        actor,
        channelId: source.id,
        expectedRevision: source.revision,
        member: codingMember,
        joinedAt: now(),
        idempotencyKey: 'join-coding',
        ...issueChannelGrant(
          'join-coding-grant',
          createRuntimeChannelMembershipPolicyRequest({
            actor,
            action: 'join',
            channelId: source.id,
            memberId: codingMember.memberId,
            channelRevision: source.revision
          })
        )
      })!
      const reviewMember = {
        memberId: 'review-publisher',
        agentInstanceId: 'review-agent',
        role: 'producer' as const,
        joinedAt: now()
      }
      target = channels.commands.join({
        actor,
        channelId: target.id,
        expectedRevision: target.revision,
        member: reviewMember,
        joinedAt: now(),
        idempotencyKey: 'join-review',
        ...issueChannelGrant(
          'join-review-grant',
          createRuntimeChannelMembershipPolicyRequest({
            actor,
            action: 'join',
            channelId: target.id,
            memberId: reviewMember.memberId,
            channelRevision: target.revision
          })
        )
      })!
      const channelWire = {
        id: 'coding-to-review',
        sourceChannelId: source.id,
        targetChannelId: target.id,
        targetPublisherMemberId: 'review-publisher',
        enabled: true,
        createdAt: now(),
        maxHops: 2
      }
      channels.wireCommands.wire({
        actor,
        wire: channelWire,
        idempotencyKey: 'wire-coding-review',
        ...issueChannelGrant(
          'wire-coding-review-grant',
          createRuntimeChannelWirePolicyRequest({
            actor,
            action: 'wire',
            wireId: channelWire.id,
            sourceChannelId: channelWire.sourceChannelId,
            targetChannelId: channelWire.targetChannelId
          })
        )
      })
      const sourceForPublish = channels.store.getChannel(source.id)!
      const forwardedMessageId = 'wire:coding-to-review:edit-ready'
      const forwardedWake = new Promise<void>((resolve) => {
        const unsubscribe = channels.subscribeWake((event) => {
          if (
            event.channelId === target.id &&
            event.pendingMessageIds.includes(forwardedMessageId)
          ) {
            unsubscribe()
            resolve()
          }
        })
      })
      channels.start()
      const sourceMessage = {
        id: 'edit-ready',
        channelId: source.id,
        publisherMemberId: 'coding-publisher',
        payload: { kind: 'review-request', artifactDigest: sha256('after\n') },
        priority: 10,
        publishedAt: now()
      }
      channels.commands.publish({
        actor: agentActor,
        message: sourceMessage,
        expectedChannelRevision: sourceForPublish.revision,
        idempotencyKey: 'publish-edit-ready',
        ...issueChannelGrant(
          'publish-edit-ready-grant',
          createRuntimeChannelPublishPolicyRequest({
            actor: agentActor,
            message: sourceMessage,
            channelRevision: sourceForPublish.revision
          })
        )
      })
      await forwardedWake
      expect(channels.store.getMessage(forwardedMessageId)?.state.payload).toMatchObject({
        kind: 'review-request'
      })

      // Steps 5-6 execute in the coding Agent lifecycle adapter below.
      return completedRun
    })
    triggerRuntime = new ProductionTriggerRuntime({
      eventStore: store,
      authorization,
      service: { runAgent: coordinator, runGraph: vi.fn() },
      grantProvider: triggerGrantProvider,
      routeResolver: () => ({ trusted: true }),
      now,
      pollInterval: 60_000
    })
    expect(await triggerRuntime.scheduler.runOnce()).toBe(true)
    expect(coordinator).toHaveBeenCalledOnce()
    await coordinator.mock.results[0]?.value
    expect(driveRuntime.store.get('drive-acceptance')?.state.status).toBe('active')
    expect(
      agents.store
        .list()
        .map(({ id }) => id)
        .sort()
    ).toEqual(['coding-agent', 'research-agent', 'review-agent'])
    expect(
      channels.store.getMessage('wire:coding-to-review:edit-ready')?.state.payload
    ).toMatchObject({
      kind: 'review-request'
    })

    // Steps 5-6: lifecycle-owned coding tools, active-boundary rejection, safe activation, resume.
    // Tool choice is deterministic test orchestration at the real lifecycle/tool boundary; this step
    // does not claim model-driven dispatch.
    const invocation = { authenticatedActor: actor } as never
    const lifecycleService = new MagicAgentPlatformSvcImpl()
    const approveLatestLifecycleRequest = (action: 'start' | 'pause' | 'resume') => {
      const request = policyRequests.findLast(
        (candidate) => candidate.action === `agent-instance.${action}`
      )!
      const grantId = `${action}-coding-lifecycle-grant`
      authorization.createApprovalGrant({
        grantId,
        request,
        approvedBy: approver,
        issuedAt: now(),
        expiresAt: now() + 59_999,
        maxUses: 1,
        idempotencyKey: grantId
      })
      return grantId
    }
    let coding = agents.store.get('coding-agent')!
    const startInput = {
      instanceId: coding.id,
      expectedRevision: coding.revision,
      actor,
      request: {
        text: 'edit and verify feature.txt',
        route,
        sessionId: sessionKey,
        metadata: { runId: codingRunId }
      },
      idempotencyKey: 'start-coding-lifecycle'
    }
    await expect(lifecycleService.startAgentInstance(startInput, invocation)).rejects.toThrow(
      /awaiting-approval/
    )
    await lifecycleService.startAgentInstance(
      {
        ...startInput,
        idempotencyKey: 'start-coding-lifecycle-approved',
        grantId: approveLatestLifecycleRequest('start'),
        expectedGrantUseCount: 0
      },
      invocation
    )
    await toolEntered
    expect(agents.service.isAtSafePoint(coding.id)).toBe(false)
    const codingV1 = agents.configStore.get('coding-v1')!.state
    agents.configStore.create({
      config: createMagicAgentConfigContent({
        ...codingV1,
        version: 'coding-v2',
        systemPrompt: 'coding acceptance role v2',
        createdAt: now(),
        createdBy: actor
      }),
      idempotencyKey: 'config-coding-v2'
    })
    const staged = await lifecycleService.stageAgentConfig(
      {
        instanceId: coding.id,
        expectedRevision: agents.store.get(coding.id)!.revision,
        configVersion: 'coding-v2',
        stagedAt: now(),
        idempotencyKey: 'stage-coding-v2'
      },
      invocation
    )
    coding = agents.store.get(coding.id)!
    expect(staged.instance).toMatchObject({
      id: coding.id,
      revision: coding.revision,
      createdAt: coding.createdAt,
      updatedAt: coding.updatedAt
    })
    expect(staged.instance.state).toMatchObject({
      configVersion: 'coding-v1',
      pendingConfigVersion: 'coding-v2'
    })
    await expect(
      lifecycleService.activateAgentConfig(
        {
          instanceId: coding.id,
          expectedRevision: coding.revision,
          activatedAt: now(),
          idempotencyKey: 'activate-coding-v2-not-safe'
        },
        invocation
      )
    ).rejects.toThrow(/not at a config activation safe point/i)
    const pauseInput = {
      instanceId: coding.id,
      expectedRevision: coding.revision,
      actor,
      idempotencyKey: 'pause-coding-for-v2'
    }
    await expect(lifecycleService.pauseAgentInstance(pauseInput, invocation)).rejects.toThrow(
      /awaiting-approval/
    )
    const pausePromise = lifecycleService.pauseAgentInstance(
      {
        ...pauseInput,
        idempotencyKey: 'pause-coding-for-v2-approved',
        grantId: approveLatestLifecycleRequest('pause'),
        expectedGrantUseCount: 0
      },
      invocation
    )
    releaseToolInvocation()
    const paused = await pausePromise
    coding = agents.store.get(coding.id)!
    expect(paused.instance).toMatchObject({
      id: coding.id,
      revision: coding.revision,
      createdAt: coding.createdAt,
      updatedAt: coding.updatedAt
    })
    expect(paused.instance.state).toMatchObject({
      status: 'paused',
      configVersion: 'coding-v1',
      pendingConfigVersion: 'coding-v2'
    })
    expect(agents.service.isAtSafePoint(coding.id)).toBe(true)
    const beforeActivationVersion = coding.state.configVersion
    const activated = await lifecycleService.activateAgentConfig(
      {
        instanceId: coding.id,
        expectedRevision: coding.revision,
        activatedAt: now(),
        idempotencyKey: 'activate-coding-v2-safe'
      },
      invocation
    )
    coding = agents.store.get(coding.id)!
    expect(activated.instance).toMatchObject({
      id: coding.id,
      revision: coding.revision,
      createdAt: coding.createdAt,
      updatedAt: coding.updatedAt
    })
    expect(activated.instance.state).toMatchObject({
      status: 'paused',
      configVersion: 'coding-v2',
      previousConfigVersion: 'coding-v1'
    })
    expect(activated.instance.state.pendingConfigVersion).toBeUndefined()
    expect({ before: beforeActivationVersion, after: coding.state.configVersion }).toEqual({
      before: 'coding-v1',
      after: 'coding-v2'
    })
    expect(store.readStream('agent-instance:coding-agent:stream').at(-1)).toMatchObject({
      type: 'agent-instance.config-activated',
      payload: { configVersion: 'coding-v2' }
    })
    const resumeInput = {
      instanceId: coding.id,
      expectedRevision: coding.revision,
      actor,
      idempotencyKey: 'resume-coding-v2'
    }
    await expect(lifecycleService.resumeAgentInstance(resumeInput, invocation)).rejects.toThrow(
      /awaiting-approval/
    )
    const resumed = await lifecycleService.resumeAgentInstance(
      {
        ...resumeInput,
        idempotencyKey: 'resume-coding-v2-approved',
        grantId: approveLatestLifecycleRequest('resume'),
        expectedGrantUseCount: 0
      },
      invocation
    )
    coding = agents.store.get(coding.id)!
    expect(resumed.instance).toMatchObject({
      id: coding.id,
      revision: coding.revision,
      createdAt: coding.createdAt,
      updatedAt: coding.updatedAt
    })
    expect(resumed.instance.state).toMatchObject({
      status: 'running',
      configVersion: 'coding-v2',
      previousConfigVersion: 'coding-v1'
    })
    expect(coding.state.status).toBe('running')
    await runCompleted
    for (
      let attempt = 0;
      attempt < 100 && agents.store.get(coding.id)?.state.status !== 'stopped';
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 2))
    expect(agents.store.get(coding.id)?.state).toMatchObject({
      status: 'stopped',
      configVersion: 'coding-v2'
    })
    expect(durableToolAuditAttributions).toEqual(
      expect.arrayContaining([
        { actorId: 'coding-agent', runId: codingRunId, tool: 'files.edit' },
        { actorId: 'coding-agent', runId: codingRunId, tool: 'terminal.run' }
      ])
    )
    expect(store.readStream(`agent-run:${codingRunId}:audit`)).toHaveLength(
      durableToolAuditAttributions.length
    )

    // Step 7: attach to a real managed-input run, edit without waking, then safely submit it.
    const managedGraph = {
      graphId: 'managed-hot-update',
      name: 'Managed hot update',
      version: '1.0.0',
      entryNodeIds: ['input'],
      nodes: [
        { nodeId: 'input', kind: 'input', name: 'Input', config: { inputMode: 'managed' } },
        { nodeId: 'output', kind: 'output', name: 'Output' }
      ],
      channels: [
        { channelId: 'input-output', from: 'input', to: 'output', kind: 'artifact', required: true }
      ],
      outputs: [
        { outputId: 'result', name: 'Result', sourceNodeId: 'output', channelId: 'input-output' }
      ]
    } as never
    const graphRuntime = new MagicAgentGraphRuntime([managedGraph])
    const graphEventStore = new MagicAgentGraphRunEventStore(
      path.join(root, 'managed-run-events.sqlite3')
    )
    cleanupAfterTest(() => graphEventStore.close())
    const graphService = new MagicAgentPlatformSvcImpl({
      graphRuntime,
      runEventStore: graphEventStore,
      routeAuthorizer: (requestedRoute, context) => {
        if (!context?.authenticatedActor) throw new Error('authentication required')
        return requestedRoute
      }
    })
    const managedRunPromise = graphRuntime.run({
      graphId: 'managed-hot-update',
      runId: 'managed-run',
      input: 'initial',
      route
    })
    const attachedEvents: string[] = []
    const attachPromise = graphService.attachGraphRun(
      { runId: 'managed-run', route },
      { onData: (event) => attachedEvents.push(event.kind) } as never,
      invocation
    )
    let pending = graphRuntime.getRun('managed-run', sessionKey)?.pendingInput
    for (let attempt = 0; attempt < 50 && !pending; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
      pending = graphRuntime.getRun('managed-run', sessionKey)?.pendingInput
    }
    expect(pending?.status).toBe('awaiting')
    const edited = await graphService.editPendingInput(
      {
        runId: 'managed-run',
        route,
        pendingInputId: pending!.pendingInputId,
        expectedRevision: pending!.revision,
        value: 'edited-private-input',
        idempotencyKey: 'pending-edit'
      },
      invocation
    )
    expect(edited.status).toBe('awaiting')
    expect(graphRuntime.getRun('managed-run', sessionKey)?.status).toBe('running')
    await graphService.injectPendingInput(
      {
        runId: 'managed-run',
        route,
        pendingInputId: pending!.pendingInputId,
        expectedRevision: edited.revision,
        value: 'safe-final-input',
        idempotencyKey: 'pending-inject'
      },
      invocation
    )
    const managedRun = await managedRunPromise
    await attachPromise
    expect(managedRun.status).toBe('completed')
    expect(attachedEvents).toEqual(expect.arrayContaining(['input.edited', 'input.injected']))
    expect(JSON.stringify(managedRun.events)).not.toMatch(/edited-private-input|safe-final-input/)

    // Step 8: kill a real SQLite-owning fixture without cleanup, then reopen and replay once.
    const repositoryRoot = process.cwd()
    const recoveryRoot = await mkdtemp(path.join(tmpdir(), 'm8-abrupt-recovery-'))
    artifacts.push(recoveryRoot)
    const recoveryDatabasePath = path.join(recoveryRoot, 'abrupt-recovery.sqlite3')
    const recoveryReadyPath = path.join(recoveryRoot, 'abrupt-recovery.ready')
    const fixturePath = path.join(
      repositoryRoot,
      'packages/app/src/main/api/fixtures/m8AbruptRecovery.fixture.test.ts'
    )
    const vitestPath = path.join(repositoryRoot, 'node_modules/vitest/vitest.mjs')
    const vitestConfigPath = path.join(repositoryRoot, 'config/vitest/vitest.node.config.mjs')
    const recoveryChild = spawn(
      process.execPath,
      [vitestPath, 'run', fixturePath, '--config', vitestConfigPath, '--root', repositoryRoot],
      {
        cwd: recoveryRoot,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MAGICPOT_M8_ABRUPT_RECOVERY_FIXTURE: '1',
          MAGICPOT_M8_RECOVERY_DATABASE: recoveryDatabasePath,
          MAGICPOT_M8_RECOVERY_READY: recoveryReadyPath
        }
      }
    )
    let recoveryOutput = ''
    recoveryChild.stdout?.on('data', (chunk) => (recoveryOutput += String(chunk)))
    recoveryChild.stderr?.on('data', (chunk) => (recoveryOutput += String(chunk)))
    cleanupAfterTest(() => terminateProcessTree(recoveryChild))
    try {
      await waitForFile(recoveryReadyPath, recoveryChild)
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${recoveryOutput}`
      )
    }
    await terminateProcessTree(recoveryChild)
    let recoveryStore = new MagicAgentEventStore(recoveryDatabasePath)
    cleanupAfterTest(() => recoveryStore.close())
    const retainedEventCount = recoveryStore.countEvents()
    expect(recoveryStore.getEvent('m8-abrupt-side-effect-committed')).toMatchObject({
      type: 'm8.abrupt-side-effect.committed',
      payload: { count: 1 }
    })
    expect(
      recoveryStore.getResource('m8-abrupt-side-effect', 'non-idempotent-once')?.state
    ).toEqual({ count: 1 })
    recoveryStore.close()
    recoveryStore = new MagicAgentEventStore(recoveryDatabasePath)
    const recoveryAuthorization = new MagicAgentPolicyAuthorizationService({
      store: recoveryStore,
      rules: [
        {
          ruleId: 'recovery-allow',
          priority: 1,
          effect: 'allow',
          explanation: 'Allow bounded abrupt-recovery verification operations.'
        }
      ],
      policyVersion: 'm8-recovery-v1',
      storeId: 'recovery-parent',
      trustedApprovers: [approver]
    })
    const recoveryOwner = new ProductionAgentInstanceLifecycle({
      eventStore: recoveryStore,
      authorization: recoveryAuthorization,
      platformService: { runAgent: vi.fn() }
    })
    cleanupAfterTest(() => recoveryOwner.close())
    expect(recoveryOwner.store.get('abrupt-agent')?.state.status).toBe('running')
    recoveryOwner.start()
    expect(recoveryOwner.store.get('abrupt-agent')?.state.status).toBe('stopped')
    expect(
      recoveryStore.readStream('agent-instance:abrupt-agent:stream').map((event) => event.type)
    ).toEqual(
      expect.arrayContaining(['agent-instance.created', 'agent-instance.status-transitioned'])
    )
    const [retainedEffect] = recoveryStore.listResources({
      kind: 'm8-abrupt-side-effect',
      limit: 10
    })
    expect(retainedEffect).toBeDefined()
    const replayedEffect = recoveryStore.mutateResource<{ count: number }>({
      operation: 'create',
      kind: 'm8-abrupt-side-effect',
      id: 'non-idempotent-once',
      state: retainedEffect!.state,
      createdAt: retainedEffect!.createdAt,
      idempotencyKey: 'm8-abrupt-effect:stable-command-v1',
      event: recoveryStore.getEvent('m8-abrupt-side-effect-committed')!
    })
    expect(replayedEffect.inserted).toBe(false)
    expect(replayedEffect.resource.state.count).toBe(1)
    expect(recoveryStore.countEvents()).toBe(retainedEventCount + 1)
    expect(recoveryStore.listResources({ kind: 'm8-abrupt-side-effect', limit: 10 })).toHaveLength(
      1
    )

    // Steps 9-10: event-level Session fork, branch export and semantic diff via production service.
    const sessionFile = path.join(root, 'sessions.json')
    const sessionStore = new AssistantSessionStore(sessionFile)
    cleanupAfterTest(() => sessionStore.flush())
    const assistantRuntime = new AssistantRuntime({ sessionStore })
    const sourceRoute = {
      channel: 'e2e',
      scopeType: 'dm' as const,
      scopeId: 'source',
      senderId: actor.id
    }
    const forkRoute = {
      channel: 'e2e',
      scopeType: 'dm' as const,
      scopeId: 'fork',
      senderId: actor.id
    }
    await sessionStore.appendTurn(
      sourceRoute,
      [
        { role: 'user', content: 'nebula acceptance api_key=session-secret' },
        { role: 'assistant', content: 'implemented after review' }
      ],
      now(),
      {
        run: {
          runId: 'session-run',
          sessionKey: 'e2e:dm:source',
          workspaceId: 'workspace',
          route: sourceRoute,
          status: 'completed',
          runOrigin: 'new',
          rootRunId: 'session-run',
          createdAt: now(),
          updatedAt: now(),
          startedAt: now(),
          finishedAt: now(),
          artifactIds: ['edited-feature'],
          toolCalls: [{ toolName: 'files.edit', args: { token: 'tool-secret' } }]
        } as never,
        events: [
          {
            eventId: 'fork-event',
            runId: 'session-run',
            sessionKey: 'e2e:dm:source',
            route: sourceRoute,
            type: 'tool',
            level: 'info',
            message: 'edit complete',
            metadata: { artifactId: 'edited-feature' },
            createdAt: now()
          }
        ] as never
      }
    )
    await sessionStore.flush()
    await assistantRuntime.forkSessionAtEvent(sourceRoute, 'fork-event', forkRoute)
    const sessionService = new MagicAgentPlatformSvcImpl({ assistantRuntime })
    const sessionInvocation = { authenticatedActor: actor } as never
    const exported = await sessionService.exportSession(
      { sourceRoute: forkRoute, format: 'jsonl' },
      sessionInvocation
    )
    const diff = await sessionService.diffSessions(
      { leftRoute: sourceRoute, rightRoute: forkRoute },
      sessionInvocation
    )
    expect(exported.body).toContain('implemented after review')
    expect(exported.body).not.toMatch(/session-secret|tool-secret/)
    expect(diff.relationship.relationship).toBe('right-forked-from-left')
    expect(diff.timeline.length).toBeGreaterThan(0)

    // Step 11: provenance-linked semantic retrieval survives its own SQLite reconstruction.
    const memoryPath = path.join(root, 'semantic.sqlite3')
    const registry = new EmbeddingProviderRegistry()
    registry.register({
      id: 'deterministic',
      remote: false,
      model: 'm8-vector',
      dimension: 2,
      embed: async ({ texts }) => ({
        model: 'm8-vector',
        dimension: 2,
        vectors: texts.map((text) => (text.includes('nebula') ? [1, 0] : [0, 1]))
      })
    })
    let memoryStore = new SqliteSemanticMemoryStore(memoryPath)
    cleanupAfterTest(() => memoryStore.close())
    let semantic = new PublicSemanticMemoryService({
      memory: new SemanticMemoryService(memoryStore, registry),
      assistantRuntime,
      authorize: ({ toolName }) => policyCalls.push(toolName)
    })
    await semantic.ingestSession({ sourceRoute, providerId: 'deterministic' }, actor)
    memoryStore.close()
    memoryStore = new SqliteSemanticMemoryStore(memoryPath)
    semantic = new PublicSemanticMemoryService({
      memory: new SemanticMemoryService(memoryStore, registry),
      assistantRuntime,
      authorize: ({ toolName }) => policyCalls.push(toolName)
    })
    const retrieval = await semantic.search(
      {
        query: 'nebula',
        mode: 'semantic',
        providerId: 'deterministic',
        scopes: [{ kind: 'session', route: sourceRoute }]
      },
      actor
    )
    expect(retrieval.effectiveMode).toBe('semantic')
    expect(retrieval.hits[0].memory.provenance).toMatchObject({
      sourceKind: 'assistant-session',
      sourceSessionKey: 'e2e:dm:source'
    })
    expect(JSON.stringify(retrieval)).not.toContain('session-secret')
    memoryStore.close()

    // Step 12: authenticated public SDK and canonical Studio/service store round-trip Graph V2 losslessly.
    const graphRoot = path.join(root, 'graphs')
    await mkdir(graphRoot, { recursive: true })
    const policyRuntime = getAssistantTerminalPolicyRuntime()
    const graphPolicy = vi.spyOn(policyRuntime, 'authorizeAssistantMutation')
    const canonicalStore = new MagicAgentUserGraphStore(graphRoot)
    const canonicalService = new MagicAgentPlatformSvcImpl({
      userGraphStore: canonicalStore,
      graphRuntime: new MagicAgentGraphRuntime(),
      adapter: { listTools: () => [], listAgents: () => [] } as never,
      routeAuthorizer: (requestedRoute) => requestedRoute as never
    })
    const saveSurface = vi.spyOn(canonicalService, 'saveGraphV2')
    sdkServer = await startMagicAgentSdkHttpServer({
      token: 'm8-authenticated-sdk-token',
      authenticatedActor: actor,
      gateway: new MagicAgentSdkGateway(canonicalService, 'm8-authenticated-sdk-token', actor)
    })
    const client = new MagicAgentClient(
      new HttpAgentTransport({ baseUrl: sdkServer.baseUrl, token: 'm8-authenticated-sdk-token' })
    )
    const validation = validateGraphDefinitionV2Draft(graphV2)
    expect(validation).toEqual({ valid: true, issues: [] })
    const savedGraph = await client.saveGraphV2({ graph: graphV2, route, replace: true })
    expect(validateGraphDefinitionV2Draft(savedGraph.definitionV2)).toEqual({
      valid: true,
      issues: []
    })
    expect(savedGraph.definitionV2).toMatchObject({
      graphId: graphV2.graphId,
      nodes: graphV2.nodes,
      edges: graphV2.edges,
      outputs: graphV2.outputs,
      variables: graphV2.variables,
      metadata: graphV2.metadata
    })
    const readGraph = await client.getGraphV2({ graphId: graphV2.graphId, route })
    expect(readGraph.definitionV2).toEqual(savedGraph.definitionV2)
    expect(saveSurface).toHaveBeenCalledOnce()
    expect(graphPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        route,
        toolName: 'graph.save',
        toolInput: { graphId: graphV2.graphId, version: 'v2', replace: true }
      })
    )
    const studioRead = await canonicalStore.getV2(graphV2.graphId, route)
    expect(studioRead).toEqual(savedGraph.definitionV2)

    // Cross-cutting strict checks: Policy was used and every audit remains content-free.
    const policyActions = new Set(policyCalls)
    for (const requiredAction of [
      'trigger.execute',
      'filesystem.write',
      'terminal.execute',
      'memory.search'
    ])
      expect(policyActions.has(requiredAction)).toBe(true)
    expect(audits.length).toBeGreaterThanOrEqual(2)
    const serializedAudits = JSON.stringify(audits)
    expect(serializedAudits).not.toMatch(
      /before\n|after\n|test passed|session-secret|tool-secret|graph-v2-acceptance|trim-non-empty/
    )
    expect(serializedAudits).not.toContain(root)
    expect(serializedAudits).not.toContain(workspace)
    expect(serializedAudits).not.toContain(targetFile)
    expect(serializedAudits).not.toContain(process.execPath)
    expect(
      audits.some(
        (audit) =>
          audit.tool === 'terminal.run' &&
          audit.exitCode === 0 &&
          audit.commandSha256 === sha256(process.execPath) &&
          audit.argsCount === 2 &&
          audit.stdoutChars === 'test passed'.length &&
          /^[a-f0-9]{64}$/.test(audit.argsSha256) &&
          /^[a-f0-9]{64}$/.test(audit.cwdSha256) &&
          /^[a-f0-9]{64}$/.test(audit.stdoutSha256) &&
          /^[a-f0-9]{64}$/.test(audit.stderrSha256)
      )
    ).toBe(true)
    expect(audits.some((audit) => 'beforeSha256' in audit || 'afterSha256' in audit)).toBe(true)
    const policyAudit = [
      ...authorization.listAuditResources({ limit: 1_000 }),
      ...policyRuntime.authorization.listAuditResources({ limit: 1_000 })
    ]
    expect(policyAudit.length).toBeGreaterThan(0)
    expect(JSON.stringify(policyAudit)).not.toMatch(
      /edited-private-input|safe-final-input|session-secret|tool-secret|credential-secret-id/
    )
    expect(existsSync(targetFile)).toBe(true)
    await triggerRuntime.stop()
    await driveRuntime.stop()
    channels.close()
    closeProductionAgentInstanceLifecycle()
    await sessionStore.flush()
    await sdkServer.close()
    sdkServer = undefined
    store.close()
  }, 60_000)
})
