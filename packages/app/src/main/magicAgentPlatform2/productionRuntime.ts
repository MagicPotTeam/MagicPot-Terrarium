import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import path from 'node:path'
import type { AssistantRoute } from '../assistantRuntime/types'
import { getBuildEnv } from '../config/buildEnv'
import {
  createAssistantToolPolicyRequest,
  createTerminalPolicyRequest,
  type PolicyJsonRecord,
  type PolicyRequest,
  type PolicyRule
} from '../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from './persistence'
import { MagicAgentPolicyAuthorizationService } from './policy'
import {
  TerminalApprovalCoordinator,
  type PendingTerminalApproval,
  type TerminalApprovalReference
} from './terminalApprovalCoordinator'
import { TerminalRunToolHost } from './toolHost'

const POLICY_VERSION = 'assistant-terminal-v1'
const TRUSTED_APPROVER = { kind: 'user', id: 'magicpot-desktop-user' } as const
const PYTHON_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024
const PYTHON_CPU_LIMIT_MS = 60_000

export const PRODUCTION_PYTHON_NOTEBOOK_POLICY_RULES: readonly PolicyRule[] = [
  {
    ruleId: 'assistant-python-requires-bounded-approval',
    priority: 2000,
    effect: 'require-approval',
    match: {
      origins: ['assistant', 'graph'],
      actions: ['python.execute'],
      targetKinds: ['tool']
    },
    constraints: {
      requireNoShell: true,
      allowedToolNames: ['python.run', 'python.background'],
      maxTimeoutMs: 120_000,
      maxOutputChars: 4 * 1024 * 1024,
      metadata: { maxMemoryBytes: PYTHON_MEMORY_LIMIT_BYTES, maxCpuTimeMs: PYTHON_CPU_LIMIT_MS }
    },
    explanation: 'Python execution requires approval and supported OS resource confinement.',
    approvalRequirement: {
      scopeKind: 'request',
      scopeValue: '*',
      maxUses: 1,
      expiresInMs: 5 * 60_000,
      reason: 'Python execution can modify the workspace or host.'
    }
  },
  {
    ruleId: 'assistant-notebook-structural-write-requires-approval',
    priority: 2000,
    effect: 'require-approval',
    match: {
      origins: ['assistant', 'graph'],
      actions: ['notebook.write'],
      actorKinds: ['system'],
      targetKinds: ['tool'],
      effectKinds: ['filesystem.write']
    },
    constraints: {
      requireNoShell: true,
      allowedToolNames: ['notebook.write']
    },
    explanation: 'Structural Notebook mutations require a one-shot trusted approval.',
    approvalRequirement: {
      scopeKind: 'request',
      scopeValue: '*',
      maxUses: 1,
      expiresInMs: 5 * 60_000,
      reason: 'Notebook structure or persisted output state will be changed.'
    }
  },
  {
    ruleId: 'assistant-notebook-requires-bounded-approval',
    priority: 2000,
    effect: 'require-approval',
    match: {
      origins: ['assistant', 'graph'],
      actions: ['notebook.execute'],
      targetKinds: ['tool']
    },
    constraints: {
      requireNoShell: true,
      allowedToolNames: ['notebook.execute-cell', 'notebook.execute-all'],
      maxTimeoutMs: 120_000,
      maxOutputChars: 4 * 1024 * 1024,
      metadata: { maxMemoryBytes: PYTHON_MEMORY_LIMIT_BYTES, maxCpuTimeMs: PYTHON_CPU_LIMIT_MS }
    },
    explanation: 'Notebook execution requires approval and supported OS resource confinement.',
    approvalRequirement: {
      scopeKind: 'request',
      scopeValue: '*',
      maxUses: 1,
      expiresInMs: 5 * 60_000,
      reason: 'Notebook execution can modify the notebook, workspace, or host.'
    }
  }
]

export const PRODUCTION_FILE_WRITE_POLICY_RULE: PolicyRule = {
  ruleId: 'workspace-files-write-requires-approval',
  priority: 2000,
  effect: 'require-approval',
  match: {
    origins: ['assistant', 'graph'],
    actions: ['filesystem.write'],
    targetKinds: ['tool'],
    effectKinds: ['filesystem.write']
  },
  constraints: {
    requireNoShell: true,
    allowedToolNames: [
      'files.write',
      'files.edit',
      'files.patch',
      'files.multi-edit',
      'files.json.write',
      'files.snapshot.restore'
    ]
  },
  explanation: 'Workspace file mutations require a one-shot trusted approval.',
  approvalRequirement: {
    scopeKind: 'request',
    scopeValue: '*',
    maxUses: 1,
    expiresInMs: 5 * 60_000,
    reason: 'File mutation changes workspace content.'
  }
}

export type AssistantTerminalPolicyRuntime = Readonly<{
  readonly eventStore: MagicAgentEventStore
  authorization: MagicAgentPolicyAuthorizationService
  createTrustedApproval(request: PolicyRequest): Omit<TerminalApprovalReference, 'authorizationId'>
  requestTerminalApproval(request: PolicyRequest): Promise<TerminalApprovalReference>
  requestTerminalApprovalWithSnapshot(
    request: PolicyRequest,
    graphContext: NonNullable<PendingTerminalApproval['graphContext']>
  ): ReturnType<TerminalApprovalCoordinator['requestWithSnapshot']>
  listPendingTerminalApprovals(): readonly PendingTerminalApproval[]
  resolvePendingTerminalApproval(input: {
    approvalId: string
    expectedRevision: number
    approved: boolean
  }): PendingTerminalApproval
  shutdownTerminalApprovals(): void
  authorizeAssistantMutation(input: {
    route: AssistantRoute
    sessionId: string
    toolName: string
    toolInput: PolicyJsonRecord
  }): void
  createRequest(input: {
    route: AssistantRoute
    sessionId: string
    command: string
    args: string[]
    cwd: string
    allowedRoots: string[]
  }): PolicyRequest
  run(input: Parameters<TerminalRunToolHost['run']>[0]): ReturnType<TerminalRunToolHost['run']>
}>

let runtime: AssistantTerminalPolicyRuntime | undefined

export const runMagicAgentApprovalSmoke = async (markerPath: string): Promise<void> => {
  const writeSmokeFailure = (error: unknown): void => {
    writeFileSync(
      markerPath,
      JSON.stringify({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        cause:
          error instanceof Error && error.cause
            ? error.cause instanceof Error
              ? { message: error.cause.message, stack: error.cause.stack }
              : String(error.cause)
            : undefined
      }),
      'utf8'
    )
  }
  try {
    const runtime = getAssistantTerminalPolicyRuntime()
    const cwd = process.cwd()
    const command = process.platform === 'win32' ? process.env['ComSpec'] || 'cmd.exe' : '/bin/sh'
    const args =
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'echo magic-agent-policy-smoke']
        : ['-c', 'printf magic-agent-policy-smoke']
    const request = runtime.createRequest({
      route: { channel: 'smoke', scopeType: 'dm', scopeId: 'approval-e2e' },
      sessionId: 'approval-e2e',
      command,
      args,
      cwd,
      allowedRoots: [cwd]
    })
    const authorization = await runtime.requestTerminalApproval(request)
    writeFileSync(
      `${markerPath}.stage`,
      JSON.stringify({ stage: 'approved', authorizationId: authorization.authorizationId }),
      'utf8'
    )
    const result = await runtime.run({
      authorizationId: authorization.authorizationId!,
      idempotencyKey: `approval-smoke-execute:${authorization.authorizationId}:${authorization.expectedGrantUseCount}:execute-v2`,
      request,
      command,
      args,
      cwd,
      grantId: authorization.grantId,
      expectedGrantUseCount: authorization.expectedGrantUseCount,
      timeoutMs: 90_000
    })
    if (result.status !== 'completed') {
      throw new Error(`Approval smoke terminal execution ended with status ${result.status}.`)
    }
    writeFileSync(
      markerPath,
      JSON.stringify({
        authorizationId: authorization.authorizationId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        status: result.status
      })
    )
  } catch (error) {
    writeSmokeFailure(error)
    throw error
  }
}

let store: MagicAgentEventStore | undefined

export const getAssistantTerminalPolicyRuntime = (): AssistantTerminalPolicyRuntime => {
  if (runtime) return runtime
  const databasePath =
    process.env.NODE_ENV === 'test'
      ? ':memory:'
      : path.join(getBuildEnv().pathMap.data, 'magic-agent-platform-2', 'policy.sqlite')

  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true })
    if (!existsSync(databasePath)) closeSync(openSync(databasePath, 'a'))
    const instanceDirectory = `${databasePath}.magicagent.instances`
    if (existsSync(instanceDirectory)) {
      for (const entry of readdirSync(instanceDirectory)) {
        const anchorPath = path.join(instanceDirectory, entry)
        try {
          const lease = JSON.parse(readFileSync(anchorPath, 'utf8')) as { pid?: unknown }
          if (typeof lease.pid === 'number') {
            try {
              process.kill(lease.pid, 0)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH')
                rmSync(anchorPath, { force: true })
            }
          }
        } catch {
          // The event store will reject malformed live lease state rather than guessing ownership.
        }
      }
    }
  }

  store = new MagicAgentEventStore(databasePath)
  const authorization = new MagicAgentPolicyAuthorizationService({
    store,
    rules: [
      ...PRODUCTION_PYTHON_NOTEBOOK_POLICY_RULES,
      PRODUCTION_FILE_WRITE_POLICY_RULE,
      {
        ruleId: 'workspace-files-read-allowed',
        priority: 2000,
        effect: 'allow-with-constraints',
        match: {
          origins: ['assistant', 'graph'],
          actions: ['filesystem.list', 'filesystem.read'],
          targetKinds: ['tool'],
          effectKinds: ['filesystem.read']
        },
        constraints: {
          readOnly: true,
          requireNoShell: true,
          allowedToolNames: [
            'files.tree',
            'files.read',
            'files.glob',
            'files.grep',
            'files.json.read'
          ]
        },
        explanation: 'Bounded read-only file tools are allowed within the route workspace root.'
      },
      {
        ruleId: 'workspace-git-read-allowed',
        priority: 2000,
        effect: 'allow-with-constraints',
        match: {
          origins: ['assistant', 'graph'],
          actions: ['git.status', 'git.diff', 'git.log', 'git.show'],
          targetKinds: ['tool']
        },
        constraints: {
          readOnly: true,
          requireNoShell: true,
          allowedToolNames: ['git.status', 'git.diff', 'git.log', 'git.show']
        },
        explanation: 'Bounded read-only Git inspection is allowed within the route workspace.'
      },
      {
        ruleId: 'workspace-git-write-requires-approval',
        priority: 2000,
        effect: 'require-approval',
        match: {
          origins: ['assistant', 'graph'],
          actions: ['git.branch', 'git.checkout', 'git.add', 'git.commit'],
          targetKinds: ['tool'],
          effectKinds: ['git.branch', 'git.checkout', 'git.add', 'git.commit']
        },
        constraints: {
          requireNoShell: true,
          allowedToolNames: ['git.branch', 'git.checkout', 'git.add', 'git.commit']
        },
        explanation: 'Writable local Git operations require a one-shot trusted approval.',
        approvalRequirement: {
          scopeKind: 'request',
          scopeValue: '*',
          maxUses: 1,
          expiresInMs: 5 * 60_000,
          reason: 'Git mutation changes repository state.'
        }
      },
      {
        ruleId: 'graph-tool-requires-approval',
        priority: 1000,
        effect: 'require-approval',
        match: {
          origins: ['graph'],
          actions: ['tool.invoke'],
          targetKinds: ['tool'],
          effectKinds: ['tool.invoke']
        },
        explanation: 'Managed Graph tool execution requires trusted user approval.',
        approvalRequirement: {
          scopeKind: 'request',
          scopeValue: '*',
          maxUses: 1,
          expiresInMs: 5 * 60_000,
          reason: 'The managed Graph requested a side-effecting tool.'
        }
      },
      {
        ruleId: 'assistant-terminal-requires-approval',
        priority: 1000,
        effect: 'require-approval',
        match: {
          origins: ['assistant'],
          actions: ['terminal.execute'],
          targetKinds: ['tool'],
          effectKinds: ['process.execute', 'filesystem.read']
        },
        constraints: {
          requireNoShell: true,
          allowedToolNames: ['terminal.run', 'commands.background'],
          maxTimeoutMs: 600000,
          maxOutputChars: 2097152
        },
        explanation: 'Assistant process execution requires a trusted user approval.',
        approvalRequirement: {
          scopeKind: 'request',
          scopeValue: '*',
          maxUses: 1,
          expiresInMs: 5 * 60_000,
          reason: 'Process execution can modify the workspace or host.'
        }
      }
    ],
    policyVersion: POLICY_VERSION,
    storeId: databasePath,
    trustedApprovers: [TRUSTED_APPROVER]
  })
  const hosts = new Map<string, TerminalRunToolHost>()
  const createTrustedApproval = (
    request: PolicyRequest
  ): Omit<TerminalApprovalReference, 'authorizationId'> => {
    const grantId = randomUUID()
    const now = Date.now()
    const created = authorization.createApprovalGrant({
      grantId,
      request,
      approvedBy: TRUSTED_APPROVER,
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
      maxUses: 1,
      idempotencyKey: `assistant-terminal-grant:${grantId}`
    })
    return {
      grantId: created.grant.grantId,
      expectedGrantUseCount: created.grant.useCount
    }
  }
  const approvals = new TerminalApprovalCoordinator(authorization, createTrustedApproval)
  runtime = {
    eventStore: store,
    authorization,
    createTrustedApproval,
    requestTerminalApproval: (request) => approvals.request(request),
    requestTerminalApprovalWithSnapshot: (request, graphContext) =>
      approvals.requestWithSnapshot(request, graphContext),
    listPendingTerminalApprovals: () => approvals.list(),
    resolvePendingTerminalApproval: (input) => approvals.resolve(input),
    shutdownTerminalApprovals: () => approvals.shutdown(),
    authorizeAssistantMutation: ({ route, sessionId, toolName, toolInput }) => {
      const request = createAssistantToolPolicyRequest({
        requestId: randomUUID(),
        actor: { kind: 'agent', id: route.senderId || sessionId },
        target: { kind: 'tool', id: toolName },
        route: { ...route },
        sessionId,
        toolInput
      })
      const approval = createTrustedApproval(request)
      const result = authorization.authorize({
        authorizationId: randomUUID(),
        request,
        evaluatedAt: Date.now(),
        grantId: approval.grantId,
        expectedGrantUseCount: approval.expectedGrantUseCount,
        idempotencyKey: `assistant-mutation:${request.requestId}`
      })
      if (result.status !== 'authorized')
        throw new Error(`Assistant mutation was not authorized: ${toolName}`)
    },
    createRequest: ({ route, sessionId, command, args, cwd, allowedRoots }) =>
      createTerminalPolicyRequest({
        requestId: randomUUID(),
        actor: { kind: 'agent', id: route.senderId || sessionId },
        target: { kind: 'tool', id: 'terminal.run' },
        route: { ...route },
        sessionId,
        command,
        args,
        cwd,
        filesystem: { cwd, allowedRoots }
      }),
    run: (input) => {
      const roots = input.request.filesystem?.allowedRoots ?? [input.cwd]
      const key = JSON.stringify([...roots].sort())
      let host = hosts.get(key)
      if (!host) {
        host = new TerminalRunToolHost(authorization, { allowedRoots: roots })
        hosts.set(key, host)
      }
      return host.run(input)
    }
  }
  return runtime
}

export const closeAssistantTerminalPolicyRuntime = (): void => {
  runtime?.shutdownTerminalApprovals()
  store?.close()
  store = undefined
  runtime = undefined
}
