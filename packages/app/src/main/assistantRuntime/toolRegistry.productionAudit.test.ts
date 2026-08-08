import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { buildDataDirRef } = vi.hoisted(() => ({ buildDataDirRef: { current: process.cwd() } }))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: () => ({ pathMap: { data: buildDataDirRef.current } })
}))
import { DEFAULT_CONFIG } from '@shared/config/config'
import type { PolicyRequest, PolicyRule } from '@shared/magicAgentPlatform2'
import { AssistantSessionStore } from './sessionStore'
import { AssistantToolRegistry } from './toolRegistry'
import {
  getAssistantTerminalPolicyRuntime,
  PRODUCTION_FILE_WRITE_POLICY_RULE,
  PRODUCTION_PYTHON_NOTEBOOK_POLICY_RULES,
  type AssistantTerminalPolicyRuntime
} from '../magicAgentPlatform2/productionRuntime'
import { MagicAgentEventStore } from '../magicAgentPlatform2/persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../magicAgentPlatform2/policy'
import { TOOL_AUDIT_STREAM_ID } from '../magicAgentPlatform2/toolHost'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const READ_RULES: readonly PolicyRule[] = [
  {
    ruleId: 'registry-files-read',
    priority: 2000,
    effect: 'allow-with-constraints',
    match: {
      origins: ['assistant'],
      actions: ['filesystem.read', 'filesystem.list', 'filesystem.search'],
      targetKinds: ['tool']
    },
    constraints: {
      readOnly: true,
      requireNoShell: true,
      allowedToolNames: ['files.read', 'git.status']
    },
    explanation: 'Registry composition test read policy.'
  },
  {
    ruleId: 'registry-git-read',
    priority: 2100,
    effect: 'allow-with-constraints',
    match: { origins: ['assistant'], actions: ['git.status'], targetKinds: ['tool'] },
    constraints: { readOnly: true, requireNoShell: true, allowedToolNames: ['git.status'] },
    explanation: 'Registry composition test Git policy.'
  }
]

const makeRuntime = (eventStore: MagicAgentEventStore): AssistantTerminalPolicyRuntime => {
  const approver = { kind: 'user', id: 'registry-test-user' } as const
  const authorization = new MagicAgentPolicyAuthorizationService({
    store: eventStore,
    rules: [
      ...PRODUCTION_PYTHON_NOTEBOOK_POLICY_RULES,
      PRODUCTION_FILE_WRITE_POLICY_RULE,
      ...READ_RULES
    ],
    policyVersion: 'registry-production-composition-v1',
    storeId: 'registry-production-composition',
    trustedApprovers: [approver]
  })
  const createTrustedApproval = (request: PolicyRequest) => {
    const grantId = randomUUID()
    const now = Date.now()
    const created = authorization.createApprovalGrant({
      grantId,
      request,
      approvedBy: approver,
      issuedAt: now,
      expiresAt: now + 60_000,
      maxUses: 1,
      idempotencyKey: `registry-approval:${grantId}`
    })
    return { grantId: created.grant.grantId, expectedGrantUseCount: created.grant.useCount }
  }
  return {
    eventStore,
    authorization,
    createTrustedApproval,
    requestTerminalApproval: async (request) => createTrustedApproval(request),
    requestTerminalApprovalWithSnapshot: () => {
      throw new Error('not used')
    },
    listPendingTerminalApprovals: () => [],
    resolvePendingTerminalApproval: () => {
      throw new Error('not used')
    },
    shutdownTerminalApprovals: () => undefined,
    authorizeAssistantMutation: () => undefined,
    createRequest: () => {
      throw new Error('not used')
    },
    run: () => {
      throw new Error('not used')
    }
  }
}

describe('AssistantToolRegistry production audit composition', () => {
  it('persists content-free Files, Git, and structural Notebook audit events in an injected runtime', async () => {
    const root = await createNodeTestArtifactDir('registry-production-audit')
    roots.push(root)
    const databasePath = path.join(root, 'audit.sqlite')
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace, { recursive: true })

    const contentSentinel = 'CONTENT_SECRET_SENTINEL'
    const pathSentinel = 'PATH_SECRET_SENTINEL'
    const notebookSentinel = 'NOTEBOOK_SECRET_SENTINEL'
    await fs.writeFile(path.join(workspace, `${pathSentinel}.txt`), contentSentinel)
    const notebookPath = path.join(workspace, `${notebookSentinel}.ipynb`)
    const notebook = JSON.stringify({
      cells: [{ cell_type: 'markdown', id: 'seed', metadata: {}, source: ['seed'] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    })
    await fs.writeFile(notebookPath, notebook)
    execFileSync('git', ['init'], { cwd: workspace })
    execFileSync('git', ['config', 'user.email', 'registry@example.invalid'], { cwd: workspace })
    execFileSync('git', ['config', 'user.name', 'Registry Test'], { cwd: workspace })
    execFileSync('git', ['add', '.'], { cwd: workspace })
    execFileSync('git', ['commit', '-m', 'seed'], { cwd: workspace })

    const singleton = getAssistantTerminalPolicyRuntime()
    const singletonCount = singleton.eventStore.readStream(TOOL_AUDIT_STREAM_ID).length
    let eventStore = new MagicAgentEventStore(databasePath)
    const runtime = makeRuntime(eventStore)
    const registry = new AssistantToolRegistry()
    const sessionStore = new AssistantSessionStore(path.join(root, 'sessions.json'))
    const route = {
      channel: 'ROUTE_SECRET_SENTINEL',
      scopeType: 'dm' as const,
      scopeId: 'SESSION_SECRET_SENTINEL'
    }
    const context = {
      config: DEFAULT_CONFIG,
      route,
      sessionStore,
      taskState: {
        sessionKey: 'SESSION_SECRET_SENTINEL',
        running: false,
        queuedCount: 0,
        updatedAt: 1
      },
      workspaceRootDir: workspace,
      terminalPolicyRuntime: runtime,
      terminalApproval: (request: PolicyRequest) => makeRuntimeApproval(runtime, request)
    }

    await registry.callTool('files.read', { path: `${pathSentinel}.txt` }, context)
    await registry.callTool('git.status', { repository: '.' }, context)
    await registry.callTool(
      'notebook.insert',
      {
        path: `${notebookSentinel}.ipynb`,
        expectedSha256: createHash('sha256').update(notebook).digest('hex'),
        position: 'after',
        referenceCellId: 'seed',
        cell: { id: 'added', cellType: 'raw', source: 'SOURCE_SECRET_SENTINEL' }
      },
      context
    )
    await sessionStore.flush()

    expect(singleton.eventStore.readStream(TOOL_AUDIT_STREAM_ID)).toHaveLength(singletonCount)
    eventStore.close()
    eventStore = new MagicAgentEventStore(databasePath)
    const events = eventStore.readStream(TOOL_AUDIT_STREAM_ID, { limit: 20 })
    eventStore.close()

    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3])
    expect(events.map((event) => event.type)).toEqual([
      'magic-agent.audit.tool-call.v1',
      'magic-agent.audit.tool-call.v1',
      'magic-agent.audit.tool-call.v1',
      'magic-agent.audit.file-change.v1'
    ])
    expect(events.map((event) => (event.payload as { tool: string }).tool)).toEqual([
      'files.read',
      'git.status',
      'notebook.insert',
      'notebook.insert'
    ])
    const durableAudit = JSON.stringify(events)
    for (const sentinel of [
      contentSentinel,
      pathSentinel,
      notebookSentinel,
      'SOURCE_SECRET_SENTINEL',
      'ROUTE_SECRET_SENTINEL',
      'SESSION_SECRET_SENTINEL',
      'GIT_SECRET_SENTINEL'
    ]) {
      expect(durableAudit).not.toContain(sentinel)
    }
  })
})

const makeRuntimeApproval = (runtime: AssistantTerminalPolicyRuntime, request: PolicyRequest) =>
  runtime.createTrustedApproval(request)
