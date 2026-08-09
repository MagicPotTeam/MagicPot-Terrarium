import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type {
  GraphV2NodeDescriptor,
  MagicAgentInstanceState,
  PolicyJsonRecord,
  PolicyJsonValue,
  RuntimeChannelState
} from '@shared/magicAgentPlatform2'
import {
  createGraphToolPolicyRequest,
  GRAPH_V2_FIRST_PARTY_NODE_REGISTRY
} from '@shared/magicAgentPlatform2'
import { createMagicAgentConfigContent } from '../magicAgentPlatform2/agents/persistentAgentConfigStore'
import { getProductionAgentInstanceLifecycle } from '../magicAgentPlatform2/agents/productionAgentInstanceLifecycleOwner'
import { getProductionRuntimeChannelLifecycle } from '../magicAgentPlatform2/channels/productionRuntimeChannelLifecycle'
import { getProductionDriveLifecycle } from '../magicAgentPlatform2/drives/productionDriveLifecycle'
import { getProductionTriggerLifecycle } from '../magicAgentPlatform2/triggers/productionTriggerLifecycle'
import { TriggerCommandService } from '../magicAgentPlatform2/triggers/triggerCommandService'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { normalizeMagicPotToolName } from '@shared/app/types'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import type { AssistantRoute } from '../assistantRuntime/types'
import { getAssistantRuntime, type AssistantRuntime } from '../assistantRuntime/runtime'
import { getAgentKernel, type AgentKernel } from '../agentKernel'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformEmptyReq,
  MagicAgentPlatformGraphCancelReq,
  MagicAgentPlatformGraphPauseReq,
  MagicAgentPlatformGraphResumeReq,
  MagicAgentPlatformInjectPendingInputReq,
  MagicAgentPlatformEditPendingInputReq,
  MagicAgentPlatformPendingInputMutationReq,
  MagicAgentPlatformGraphCatalogListReq,
  MagicAgentPlatformGraphDeleteReq,
  MagicAgentPlatformGraphDeleteResp,
  MagicAgentPlatformGraphForkReq,
  MagicAgentPlatformGraphForkResp,
  MagicAgentPlatformSessionForkReq,
  MagicAgentPlatformSessionForkResp,
  MagicAgentPlatformSessionExportReq,
  MagicAgentPlatformSessionExportResp,
  MagicAgentPlatformSessionDiffReq,
  MagicAgentPlatformSessionDiffResp,
  MagicAgentPlatformGraphInspectReq,
  MagicAgentPlatformGraphListResp,
  MagicAgentPlatformGraphPreflightRunReq,
  MagicAgentPlatformGraphPreflightRunResp,
  MagicAgentPlatformGraphRunEventListReq,
  MagicAgentPlatformGraphRunEventListResp,
  MagicAgentPlatformGraphRunGetReq,
  MagicAgentPlatformGraphRunListReq,
  MagicAgentPlatformGraphRunReq,
  MagicAgentPlatformRuntimeGraphTopologyReq,
  MagicAgentPlatformRuntimeGraphTopologyResp,
  MagicAgentPlatformGraphRunWatchReq,
  MagicAgentPlatformGraphRunAttachReq,
  MagicAgentPlatformGraphSaveResp,
  MagicAgentPlatformGraphV2GetReq,
  MagicAgentPlatformGraphV2GetResp,
  MagicAgentPlatformGraphV2GetPublishedReq,
  MagicAgentPlatformGraphV2GetPublishedResp,
  MagicAgentPlatformGraphV2ListPublishedResp,
  MagicAgentPlatformGraphV2NodeRegistryResp,
  MagicAgentPlatformGraphV2PublishReq,
  MagicAgentPlatformGraphV2PublishResp,
  MagicAgentPlatformGraphV2SaveReq,
  MagicAgentPlatformGraphV2SaveResp,
  MagicAgentPlatformGraphValidateReq,
  MagicAgentPlatformGraphValidateResp,
  MagicAgentPlatformAgentInstanceMutationResp,
  MagicAgentPlatformCreateChildAgentInstanceReq,
  MagicAgentPlatformCreateRootAgentInstanceReq,
  MagicAgentPlatformGetAgentInstanceReq,
  MagicAgentPlatformGetAgentInstanceResp,
  MagicAgentPlatformGetRuntimeChannelReq,
  MagicAgentPlatformGetRuntimeChannelResp,
  MagicAgentPlatformListAgentInstancesResp,
  MagicAgentPlatformListRuntimeChannelsResp,
  MagicAgentPlatformRemoveAgentInstanceReq,
  MagicAgentPlatformStartAgentInstanceReq,
  MagicAgentPlatformStopAgentInstanceReq,
  MagicAgentPlatformListDrivesResp,
  MagicAgentPlatformGetDriveReq,
  MagicAgentPlatformGetDriveResp,
  MagicAgentPlatformCreateDriveReq,
  MagicAgentPlatformDriveMutationResp,
  MagicAgentPlatformTransitionDriveReq,
  MagicAgentPlatformRetryDriveDeliveryReq,
  MagicAgentPlatformTransferDriveReq,
  MagicAgentPlatformSetDriveLinksReq,
  MagicAgentPlatformReportDriveProgressReq,
  MagicAgentPlatformListAgentsResp,
  MagicAgentPlatformCreateTriggerReq,
  MagicAgentPlatformCreateTriggerResp,
  MagicAgentPlatformGetTriggerReq,
  MagicAgentPlatformGetTriggerResp,
  MagicAgentPlatformListTriggersResp,
  MagicAgentPlatformManualFireTriggerReq,
  MagicAgentPlatformManualFireTriggerResp,
  MagicAgentPlatformTriggerControlReq,
  MagicAgentPlatformTriggerMutationResp,
  MagicAgentPlatformUpdateTriggerReq,
  MagicAgentPlatformListPendingApprovalsResp,
  MagicAgentPlatformListToolsReq,
  MagicAgentPlatformListToolsResp,
  MagicAgentPlatformPackageInspectReq,
  MagicAgentPlatformPackageInspectResp,
  MagicAgentPlatformPackageInstallResp,
  MagicAgentPlatformPackageListResp,
  MagicAgentPlatformPackagePathReq,
  MagicAgentPlatformPackageScanResp,
  MagicAgentPlatformPackageUninstallReq,
  MagicAgentPlatformPackageUninstallResp,
  MagicAgentPlatformPendingApprovalStreamEvent,
  MagicAgentPlatformRegisterAgentReq,
  MagicAgentPlatformRegisterAgentResp,
  MagicAgentPlatformResolvePendingApprovalReq,
  MagicAgentPlatformResolvePendingApprovalResp,
  MagicAgentPlatformRunReq,
  MagicAgentPlatformRunResp,
  MagicAgentPlatformStatusResp,
  MagicAgentPlatformSvc,
  MagicAgentPlatformToolCallReq,
  MagicAgentPlatformToolCallResp,
  MagicAgentPlatformValidatePackageManifestReq,
  MagicAgentPlatformValidatePackageManifestResp
} from '@shared/api/svcMagicAgentPlatform'
import {
  MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE,
  type MagicAgentGraphCreateRequest,
  type MagicAgentGraphDefinition,
  type MagicAgentGraphPendingInputRecord,
  type MagicAgentGraphRunResult,
  type MagicAgentGraphRunPublicEvent,
  type MagicAgentGraphRunStreamEvent
} from '@shared/magicAgent'

const projectPublicPendingInput = (
  pendingInput: MagicAgentGraphRunResult['pendingInput']
): MagicAgentGraphPendingInputRecord | undefined =>
  pendingInput
    ? {
        pendingInputId: pendingInput.pendingInputId,
        nodeId: pendingInput.nodeId,
        revision: pendingInput.revision,
        status: pendingInput.status,
        createdAt: pendingInput.createdAt,
        updatedAt: pendingInput.updatedAt
      }
    : undefined

const projectPublicGraphRun = (run: MagicAgentGraphRunResult): MagicAgentGraphRunResult => ({
  ...run,
  ...(run.pendingInput ? { pendingInput: projectPublicPendingInput(run.pendingInput) } : {})
})
import type {
  MagicAgentInstalledPackage,
  MagicAgentPackageAgentDefinition,
  MagicAgentPackageInspection
} from '@shared/magicAgentRuntime'
import {
  getMagicAgentPlatformAdapter,
  type MagicAgentPlatformAdapter,
  type MagicAgentPlatformExecutionOptions
} from '../magicAgentRuntime/platformAdapter'
import {
  createMagicAgentGraphPreflightSnapshot,
  getMagicAgentGraphRuntime,
  MagicAgentGraphCatalogService,
  MagicAgentGraphRunStore,
  MagicAgentGraphRunEventStore,
  MagicAgentUserGraphStore,
  validateMagicAgentGraphDefinition,
  type MagicAgentGraphRuntime,
  type MagicAgentGraphRuntimeDeps,
  type MagicAgentGraphFirstPartyNodeExecutionRequest,
  type MagicAgentGraphToolApprovalRequest
} from '../magicAgentRuntime/graph'
import { getAssistantTerminalPolicyRuntime } from '../magicAgentPlatform2/productionRuntime'
import { getMcpClientManager, syncMcpClientManager } from '../mcp/runtime'
import { PublicSemanticMemoryService } from '../magicAgentPlatform2/memory/publicSemanticMemoryService'
import type { SemanticMemoryService } from '../magicAgentPlatform2/memory/semanticMemoryService'
import {
  MagicAgentPackageStore,
  validateMagicAgentPackageManifest
} from '../magicAgentRuntime/package'
import {
  assertMagicAgentPlatformEnabled,
  isMagicAgentPlatformEnabled,
  MAGIC_AGENT_PLATFORM_ENV
} from '../magicAgentRuntime/featureFlag'
import {
  authorizeMagicAgentApprovalRenderer,
  authorizeMagicAgentTrustedRoute
} from '../magicAgentRuntime/trustedRouteBinding'
import { isMagicAgentPlatformDeniedToolName } from '../magicAgentRuntime/toolPolicy'

export type MagicAgentPlatformRouteAuthorizer = (
  route: AgentRouteLike,
  invocation?: ServiceInvocationContext
) => AgentRouteLike

export type MagicAgentPlatformSvcImplDeps = {
  assistantRuntime?: AssistantRuntime
  adapter?: MagicAgentPlatformAdapter
  graphRuntime?: MagicAgentGraphRuntime
  packageStore?: MagicAgentPackageStore
  userGraphStore?: MagicAgentUserGraphStore
  runStore?: MagicAgentGraphRunStore
  runEventStore?: MagicAgentGraphRunEventStore
  agentKernel?: AgentKernel
  routeAuthorizer?: MagicAgentPlatformRouteAuthorizer
  requestToolApproval?: MagicAgentGraphRuntimeDeps['requestToolApproval']
  semanticMemory?: SemanticMemoryService
  ensureMcpRuntimeAvailable?: () => Promise<void>
}

const WATCH_GRAPH_RUN_SUBSCRIBE_TIMEOUT_MS = 2_000
const WATCH_GRAPH_RUN_SUBSCRIBE_RETRY_MS = 25
const ATTACH_GRAPH_RUN_MAX_BUFFERED_EVENTS = 10_000

const TERMINAL_GRAPH_RUN_EVENT_KINDS = new Set<MagicAgentGraphRunPublicEvent['kind']>([
  'graph.completed',
  'graph.failed',
  'graph.cancelled'
])

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const resolveDefaultUserDataRoot = (): string => app?.getPath?.('userData') || process.cwd()

const resolveDefaultPackageRoot = (): string =>
  path.join(resolveDefaultUserDataRoot(), 'magic-agent-packages')

const resolveDefaultGraphStoreRoot = (): string =>
  path.join(resolveDefaultUserDataRoot(), 'magic-agent-platform', 'user-graphs')

const resolveDefaultGraphRunStoreRoot = (): string =>
  path.join(resolveDefaultUserDataRoot(), 'magic-agent-platform', 'graph-runs')

const redactInstalledPackage = (installed: MagicAgentInstalledPackage) => {
  const { sourcePath: _sourcePath, packagePath: _packagePath, ...safeInstalled } = installed
  return safeInstalled
}

const WINDOWS_ABSOLUTE_PATH_FRAGMENT = /[A-Za-z]:[\\/][^\r\n;,'"`)]+/g
const POSIX_ABSOLUTE_PATH_FRAGMENT = /(^|[\s'"`])\/[^\r\n;,'"`)]+/g

const redactLocalPathFragments = (message: string): string =>
  message
    .replace(WINDOWS_ABSOLUTE_PATH_FRAGMENT, '[redacted path]')
    .replace(POSIX_ABSOLUTE_PATH_FRAGMENT, '$1[redacted path]')

const redactValidationIssue = <T extends { path: string; message: string }>(issue: T): T => ({
  ...issue,
  message: redactLocalPathFragments(issue.message)
})

const redactPackageValidation = (validation: MagicAgentPackageInspection['validation']) => {
  if (validation.ok) {
    return {
      ...validation,
      warnings: validation.warnings.map(redactValidationIssue)
    }
  }
  return {
    ...validation,
    errors: validation.errors.map(redactValidationIssue),
    warnings: validation.warnings.map(redactValidationIssue)
  }
}

const redactPackageInspection = (
  inspection: MagicAgentPackageInspection
): MagicAgentPlatformPackageScanResp => {
  const {
    manifestPath: _manifestPath,
    packagePath: _packagePath,
    installed,
    ...safeInspection
  } = inspection
  return {
    ...safeInspection,
    validation: redactPackageValidation(inspection.validation),
    ...(installed ? { installed: redactInstalledPackage(installed) } : {})
  }
}

const packageAgentToPlatformAgent = (
  agent: MagicAgentPackageAgentDefinition
): MagicAgentPlatformAgentDefinition => ({
  id: agent.id,
  name: agent.name,
  ...(agent.description ? { description: agent.description } : {}),
  ...(agent.systemPrompt ? { systemPrompt: agent.systemPrompt } : {}),
  ...(agent.toolNames !== undefined ? { toolNames: agent.toolNames } : {}),
  ...(agent.maxToolIterations !== undefined ? { maxToolIterations: agent.maxToolIterations } : {}),
  ...(agent.profileId ? { profileId: agent.profileId } : {})
})

const mergeAgentDefinitions = (
  runtimeAgents: MagicAgentPlatformAgentDefinition[],
  packageAgents: MagicAgentPlatformAgentDefinition[]
): MagicAgentPlatformAgentDefinition[] => {
  const agentsById = new Map<string, MagicAgentPlatformAgentDefinition>()
  for (const agent of runtimeAgents) {
    agentsById.set(agent.id, agent)
  }
  for (const agent of packageAgents) {
    if (agentsById.has(agent.id)) {
      throw new Error(`Duplicate MagicAgent id from installed package: ${agent.id}`)
    }
    agentsById.set(agent.id, agent)
  }
  return [...agentsById.values()].sort((left, right) => left.id.localeCompare(right.id))
}

const cleanSystemPrompt = (value: string | null | undefined): string => String(value || '').trim()

const composeSystemPrompt = (
  agentSystemPrompt: string | null | undefined,
  requestSystemPrompt: string | null | undefined
): string | undefined => {
  const agentPrompt = cleanSystemPrompt(agentSystemPrompt)
  const requestPrompt = cleanSystemPrompt(requestSystemPrompt)
  if (!agentPrompt) {
    return requestPrompt || undefined
  }
  if (!requestPrompt || requestPrompt === agentPrompt) {
    return agentPrompt
  }
  return `${agentPrompt}\n\n${requestPrompt}`
}

const resolvePackageAgentAllowedToolNames = (
  requested: MagicAgentPlatformRunReq['allowedToolNames'],
  packageToolNames: MagicAgentPlatformAgentDefinition['toolNames']
): MagicAgentPlatformRunReq['allowedToolNames'] => {
  if (requested === undefined) {
    return undefined
  }
  if (!Array.isArray(requested)) {
    return requested
  }
  if (!Array.isArray(packageToolNames)) {
    return requested
  }

  const packageToolNameSet = new Set(
    packageToolNames
      .map((toolName) => normalizeMagicPotToolName(toolName))
      .filter((toolName) => Boolean(toolName) && !isMagicAgentPlatformDeniedToolName(toolName))
  )
  return [
    ...new Set(requested.map((toolName) => normalizeMagicPotToolName(toolName)).filter(Boolean))
  ].filter((toolName) => packageToolNameSet.has(toolName))
}

const normalizePathSeparators = (input: string): string => input.replace(/\\/g, '/')

const isPathLikePackageIdentifier = (value: string): boolean =>
  path.isAbsolute(value) ||
  value.includes('/') ||
  value.includes('\\') ||
  value === '.' ||
  value.startsWith('..')

const assertPackagePathApproved = (
  packageStore: MagicAgentPackageStore,
  packageDir: string
): string => {
  const resolvedRoot = path.resolve(packageStore.getPackageRoot())
  const resolvedPackageDir = path.resolve(packageDir)
  const relative = normalizePathSeparators(path.relative(resolvedRoot, resolvedPackageDir))
  if (
    relative === '' ||
    (!relative.startsWith('../') && relative !== '..' && !path.isAbsolute(relative))
  ) {
    return resolvedPackageDir
  }

  throw new Error('MagicAgent package paths must be under the configured package root.')
}

const triggerResourceDto = (resource: {
  id: string
  revision: number
  state: unknown
  createdAt: number
  updatedAt: number
}) => ({
  id: resource.id,
  revision: resource.revision,
  state: resource.state,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt
})

const agentInstanceLifecycle = () => {
  const lifecycle = getProductionAgentInstanceLifecycle()
  if (!lifecycle) throw new Error('Production Agent instance lifecycle is not running.')
  return lifecycle
}
const agentInstanceCommands = () => agentInstanceLifecycle().commands

const runtimeChannelLifecycle = () => {
  const lifecycle = getProductionRuntimeChannelLifecycle()
  if (!lifecycle) throw new Error('Production Runtime Channel lifecycle is not running.')
  return lifecycle
}
const runtimeChannelStore = () => runtimeChannelLifecycle().store

const driveCommands = () => {
  const lifecycle = getProductionDriveLifecycle()
  if (!lifecycle) throw new Error('Production Drive runtime is unavailable.')
  return lifecycle.commands
}

const agentInstanceResourceDto = (resource: {
  id: string
  revision: number
  state: MagicAgentInstanceState
  createdAt: number
  updatedAt: number
}): import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformAgentInstanceResource => ({
  id: resource.id,
  revision: resource.revision,
  state: resource.state,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt
})
const runtimeChannelWireResourceDto = (resource: {
  id: string
  revision: number
  state: import('@shared/magicAgentPlatform2').RuntimeChannelWireState
  createdAt: number
  updatedAt: number
}) => ({
  id: resource.id,
  revision: resource.revision,
  state: resource.state,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt
})

const runtimeChannelResourceDto = (resource: {
  id: string
  revision: number
  state: RuntimeChannelState
  createdAt: number
  updatedAt: number
}): import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformRuntimeChannelResource => ({
  id: resource.id,
  revision: resource.revision,
  state: {
    id: resource.state.id,
    name: resource.state.name,
    mode: resource.state.mode,
    capacity: resource.state.capacity,
    members: resource.state.members.map((member) => ({
      memberId: member.memberId,
      ...(member.agentInstanceId ? { agentInstanceId: member.agentInstanceId } : {}),
      ...(member.graphTargetId ? { graphTargetId: member.graphTargetId } : {}),
      ...(member.graphWakeRequest
        ? {
            graphWakeRequest: {
              graphId: member.graphWakeRequest.graphId,
              route: member.graphWakeRequest.route
            }
          }
        : {}),
      role: member.role,
      joinedAt: member.joinedAt
    }))
  },
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt
})
const driveResourceDto = triggerResourceDto

const triggerCommands = () => {
  const lifecycle = getProductionTriggerLifecycle()
  if (!lifecycle) throw new Error('Production trigger runtime is unavailable.')
  return new TriggerCommandService(lifecycle.runtime)
}

export const requestProductionGraphToolApproval = (
  approvalRequest: MagicAgentGraphToolApprovalRequest
) => {
  const policyRuntime = getAssistantTerminalPolicyRuntime()
  const policyRequest = createGraphToolPolicyRequest({
    requestId: randomUUID(),
    actor: { kind: 'graph', id: approvalRequest.runId },
    target: { kind: 'tool', id: approvalRequest.toolName },
    route: { ...approvalRequest.request.route },
    sessionId: approvalRequest.runId,
    toolInput: (approvalRequest.request.args || {}) as PolicyJsonRecord
  })
  const requested = policyRuntime.requestTerminalApprovalWithSnapshot(policyRequest, {
    runId: approvalRequest.runId,
    nodeId: approvalRequest.nodeId,
    toolName: approvalRequest.toolName,
    requestDigest: approvalRequest.requestDigest
  })
  let used = false
  return {
    pending: requested.pending,
    decision: requested.decision.then((reference) => ({
      invoke: async () => {
        if (used) throw new Error('Graph tool approval authorization was already used.')
        used = true
        const authorized = policyRuntime.authorization.authorize({
          authorizationId: reference.authorizationId!,
          request: policyRequest,
          evaluatedAt: Date.now(),
          grantId: reference.grantId,
          expectedGrantUseCount: reference.expectedGrantUseCount,
          idempotencyKey: `graph-tool-authorize:${reference.authorizationId}`
        })
        if (authorized.status !== 'authorized')
          throw new Error(`Graph tool approval was not authorized: ${authorized.status}`)
        policyRuntime.authorization.consumeExecutionPermit({
          permit: authorized.permit,
          request: policyRequest,
          consumedAt: Date.now(),
          idempotencyKey: `graph-tool-consume:${reference.authorizationId}`
        })
        return approvalRequest.invoke()
      }
    }))
  }
}

export class MagicAgentPlatformSvcImpl implements MagicAgentPlatformSvc {
  private readonly deps: MagicAgentPlatformSvcImplDeps
  private adapterInstance?: MagicAgentPlatformAdapter
  private graphRuntimeInstance?: MagicAgentGraphRuntime
  private packageStoreInstance?: MagicAgentPackageStore
  private userGraphStoreInstance?: MagicAgentUserGraphStore
  private runStoreInstance?: MagicAgentGraphRunStore
  private runEventStoreInstance?: MagicAgentGraphRunEventStore
  private agentKernelInstance?: AgentKernel
  private publicMemoryInstance?: PublicSemanticMemoryService

  private publicMemory(): PublicSemanticMemoryService {
    return (this.publicMemoryInstance ??= new PublicSemanticMemoryService({
      memory: this.deps.semanticMemory,
      assistantRuntime: this.deps.assistantRuntime,
      resolveRuntime: () => this.deps.assistantRuntime ?? getAssistantRuntime(),
      agentStore: getProductionAgentInstanceLifecycle()?.store,
      driveStore: getProductionDriveLifecycle()?.runtime.store
    }))
  }

  private memoryActor(invocation?: ServiceInvocationContext): { kind: 'user'; id: string } {
    const actor = invocation?.authenticatedActor
    if (actor?.kind !== 'user' || !actor.id.trim())
      throw new Error('Semantic memory requires an authenticated user.')
    return { kind: 'user', id: actor.id }
  }

  searchMemory = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().search(req, this.memoryActor(invocation))
  inspectMemory = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().inspect(req, this.memoryActor(invocation))
  deleteMemory = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().delete(req, this.memoryActor(invocation))
  setMemoryDisabled = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().setDisabled(req, this.memoryActor(invocation))
  setMemoryVisibility = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().setVisibility(req, this.memoryActor(invocation))
  clearMemoryScope = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().clearScope(req, this.memoryActor(invocation))
  rebuildMemory = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().rebuild(req, this.memoryActor(invocation))
  ingestSessionMemory = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().ingestSession(req, this.memoryActor(invocation))
  ingestMemoryScope = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().ingestScope(req, this.memoryActor(invocation))
  linkMemoryAgentSession = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().linkAgentSession(req, this.memoryActor(invocation))
  unlinkMemoryAgentSession = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().unlinkAgentSession(req, this.memoryActor(invocation))
  listMemoryAgentSessions = async (req: any, invocation?: ServiceInvocationContext) =>
    this.publicMemory().listAgentSessionLinks(req, this.memoryActor(invocation))

  constructor(deps: MagicAgentPlatformSvcImplDeps = {}) {
    this.deps = deps
  }

  private getAdapter(): MagicAgentPlatformAdapter {
    assertMagicAgentPlatformEnabled()
    if (!this.adapterInstance) {
      this.adapterInstance = this.deps.adapter || getMagicAgentPlatformAdapter()
    }
    return this.adapterInstance
  }

  private async executeFirstPartyNode(
    request: MagicAgentGraphFirstPartyNodeExecutionRequest
  ): Promise<unknown> {
    request.signal.throwIfAborted()
    const config = request.config
    const inputValue = (() => {
      try {
        return JSON.parse(request.input) as unknown
      } catch {
        return request.input
      }
    })()
    const actor = { kind: 'user' as const, id: request.route.senderId || request.route.scopeId }
    switch (request.operation) {
      case 'channel-message': {
        const lifecycle = getProductionRuntimeChannelLifecycle()
        if (!lifecycle) throw new Error('Communication family is unconfigured in this environment.')
        const channelId = String(config.channelId || '').trim()
        const publisherMemberId = String(config.publisherMemberId || '').trim()
        const channel = lifecycle.store.getChannel(channelId)
        if (!channel) throw new Error(`Runtime Channel is unconfigured: ${channelId}`)
        return lifecycle.commands.publish({
          actor,
          message: {
            id: `graph:${request.run.runId}:${request.node.nodeId}`,
            channelId,
            publisherMemberId,
            payload: inputValue as PolicyJsonValue,
            priority: 0,
            publishedAt: Date.now()
          },
          expectedChannelRevision: channel.revision,
          idempotencyKey: `graph:${request.run.runId}:${request.node.nodeId}`
        })
      }
      case 'automation-trigger': {
        const triggerId = String(config.triggerId || '').trim()
        const lifecycle = getProductionTriggerLifecycle()
        const trigger = lifecycle?.runtime.store.get(triggerId)
        if (!lifecycle || !trigger)
          throw new Error(`Automation Trigger is unconfigured: ${triggerId}`)
        return new TriggerCommandService(lifecycle.runtime).manualFire({
          triggerId,
          expectedTriggerRevision: trigger.revision,
          occurrenceId: `graph:${request.run.runId}:${request.node.nodeId}`,
          requestedAt: Date.now(),
          idempotencyKey: `graph:${request.run.runId}:${request.node.nodeId}`
        })
      }
      case 'llm': {
        const result = await this.getAdapter().runAgent(
          {
            agentId: String(config.agentId || 'graph-llm'),
            text: request.input,
            route: request.route,
            profileId: String(config.model || ''),
            ...(String(config.systemPrompt || '').trim()
              ? { systemPrompt: String(config.systemPrompt) }
              : {})
          },
          { signal: request.signal }
        )
        if (result.status !== 'completed')
          throw new Error(result.error || `LLM run ${result.status}.`)
        return result.content
      }
      case 'mcp-tool': {
        const alias = String(config.mcpAlias || '').trim()
        await syncMcpClientManager()
        const result = await getMcpClientManager().callToolByAlias(
          alias,
          (typeof inputValue === 'object' && inputValue !== null
            ? inputValue
            : { input: inputValue }) as Record<string, unknown>,
          request.signal
        )
        if (!result) throw new Error(`Configured MCP alias is unavailable: ${alias}`)
        return result
      }
      case 'memory-search': {
        const scope = String(config.scope || 'session')
        const agentId = String(config.agentId || '').trim()
        if (scope === 'agent' && !agentId)
          throw new Error('Semantic Memory agent scope is unconfigured: agentId')
        return this.publicMemory().search(
          {
            query: request.input,
            scopes:
              scope === 'agent'
                ? [{ kind: 'agent', id: agentId, sourceRoute: request.route }]
                : [{ kind: 'session', route: request.route }],
            limit: Number(config.limit || 5)
          },
          actor
        )
      }
      case 'coding-task': {
        const toolName = String(config.operation || '').trim()
        const runtime = this.deps.assistantRuntime ?? getAssistantRuntime()
        if (!runtime.listTools([toolName]).some((tool) => tool.name === toolName))
          throw new Error(`Coding tool is unconfigured or not allowlisted: ${toolName}`)
        return runtime.callTool(
          request.route as AssistantRoute,
          toolName,
          (typeof inputValue === 'object' && inputValue !== null
            ? inputValue
            : { input: inputValue }) as Record<string, unknown>,
          { allowedToolNames: [toolName] }
        )
      }
      case 'comfyui-workflow': {
        const result = await this.getAdapter().callTool(
          {
            name: 'comfyui.workflow.submit',
            args: {
              workflowId: String(config.workflowId || ''),
              workflow: inputValue
            },
            route: request.route,
            metadata: { graphRunId: request.run.runId, nodeId: request.node.nodeId }
          },
          { signal: request.signal }
        )
        if (!result.ok) throw new Error(result.error || result.unavailableReason || result.content)
        return result.data ?? result.content
      }
      default:
        throw new Error(`First-party Graph operation is unconfigured: ${request.operation}`)
    }
  }

  private getGraphRuntime(): MagicAgentGraphRuntime {
    assertMagicAgentPlatformEnabled()
    if (!this.graphRuntimeInstance) {
      if (this.deps.graphRuntime) {
        this.graphRuntimeInstance = this.deps.graphRuntime
        this.configureGraphRuntimeDeps(this.graphRuntimeInstance)
      } else {
        const adapter = this.getAdapter()
        this.graphRuntimeInstance = getMagicAgentGraphRuntime({
          runAgent: (request, options) => adapter.runAgent(request, options),
          callTool: (request, options) => adapter.callTool(request, options),
          requestToolApproval: this.deps.requestToolApproval || requestProductionGraphToolApproval,
          firstPartyNodeExecutor: (request) => this.executeFirstPartyNode(request),
          runStore: this.getRunStore(),
          runEventStore: this.getRunEventStore()
        })
      }
    }
    return this.graphRuntimeInstance
  }

  private getPackageStore(): MagicAgentPackageStore {
    assertMagicAgentPlatformEnabled()
    if (!this.packageStoreInstance) {
      this.packageStoreInstance =
        this.deps.packageStore || new MagicAgentPackageStore(resolveDefaultPackageRoot())
    }
    return this.packageStoreInstance
  }

  private getUserGraphStore(): MagicAgentUserGraphStore {
    assertMagicAgentPlatformEnabled()
    if (!this.userGraphStoreInstance) {
      this.userGraphStoreInstance =
        this.deps.userGraphStore || new MagicAgentUserGraphStore(resolveDefaultGraphStoreRoot())
    }
    return this.userGraphStoreInstance
  }

  private getRunStore(): MagicAgentGraphRunStore {
    assertMagicAgentPlatformEnabled()
    if (!this.runStoreInstance) {
      this.runStoreInstance =
        this.deps.runStore || new MagicAgentGraphRunStore(resolveDefaultGraphRunStoreRoot())
    }
    return this.runStoreInstance
  }

  private getRunEventStore(): MagicAgentGraphRunEventStore {
    if (!this.runEventStoreInstance) {
      this.runEventStoreInstance =
        this.deps.runEventStore ||
        MagicAgentGraphRunEventStore.adjacentTo(resolveDefaultGraphRunStoreRoot())
    }
    return this.runEventStoreInstance
  }

  private configureGraphRuntimeDeps(runtime: MagicAgentGraphRuntime): void {
    const adapter = this.getAdapter()
    const setDeps = (
      runtime as {
        setDeps?: (deps: MagicAgentGraphRuntimeDeps) => void
      }
    ).setDeps
    if (typeof setDeps === 'function') {
      setDeps.call(runtime, {
        ...(runtime === getMagicAgentGraphRuntime()
          ? {
              runAgent: (request, options) => adapter.runAgent(request, options),
              callTool: (request, options) => adapter.callTool(request, options),
              firstPartyNodeExecutor: (request) => this.executeFirstPartyNode(request),
              requestToolApproval: requestProductionGraphToolApproval
            }
          : {}),
        ...(this.deps.requestToolApproval
          ? { requestToolApproval: this.deps.requestToolApproval }
          : {}),
        ...(this.deps.runStore ? { runStore: this.deps.runStore } : {}),
        ...(this.deps.runEventStore ? { runEventStore: this.deps.runEventStore } : {})
      })
    }
  }

  private getGraphCatalog(): MagicAgentGraphCatalogService {
    return new MagicAgentGraphCatalogService({
      userGraphStore: this.getUserGraphStore(),
      packageStore: this.getPackageStore()
    })
  }

  private getAgentKernel(): AgentKernel {
    assertMagicAgentPlatformEnabled()
    if (!this.agentKernelInstance) {
      this.agentKernelInstance = this.deps.agentKernel || getAgentKernel()
    }
    return this.agentKernelInstance
  }

  private authorizeRoute(
    route: AgentRouteLike,
    invocation?: ServiceInvocationContext
  ): AssistantRoute {
    const authorizer = this.deps.routeAuthorizer || authorizeMagicAgentTrustedRoute
    return authorizer(route, invocation) as AssistantRoute
  }

  private authorizeAgentStudioInvocation(invocation?: ServiceInvocationContext): void {
    this.authorizeRoute(MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE, invocation)
  }

  private async controlTrigger(
    req: MagicAgentPlatformTriggerControlReq,
    operation: 'enable' | 'disable' | 'pause' | 'resume' | 'retry'
  ): Promise<MagicAgentPlatformTriggerMutationResp> {
    const commands = triggerCommands()
    return { trigger: triggerResourceDto(commands[operation](req)) }
  }

  private async listPackageAgents(): Promise<MagicAgentPlatformAgentDefinition[]> {
    const packageStore = this.getPackageStore()
    const listAgents = packageStore.listAgents?.bind(packageStore)
    if (!listAgents) {
      return []
    }
    return (await listAgents()).map(packageAgentToPlatformAgent)
  }

  private async listAllAgents(): Promise<MagicAgentPlatformAgentDefinition[]> {
    return mergeAgentDefinitions(this.getAdapter().listAgents(), await this.listPackageAgents())
  }

  getStatus = async (
    _req: MagicAgentPlatformEmptyReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformStatusResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    const enabled = isMagicAgentPlatformEnabled()
    if (!enabled) {
      return {
        enabled: false,
        featureFlag: MAGIC_AGENT_PLATFORM_ENV,
        platformVersion: 1,
        assistantRuntimeCompatible: true,
        agentCount: 0,
        toolCount: 0,
        assistantToolCount: 0,
        creativeToolCount: 0,
        graphCount: 0
      }
    }

    const adapter = this.getAdapter()
    const graphRuntime = this.getGraphRuntime()
    const packageStore = this.getPackageStore()
    const tools = adapter.listTools()
    const packages = await packageStore.list().catch(() => undefined)
    const runtimeAgents = adapter.listAgents()
    const agents = await this.listPackageAgents()
      .then((packageAgents) => mergeAgentDefinitions(runtimeAgents, packageAgents))
      .catch(() => runtimeAgents)
    return {
      enabled,
      featureFlag: MAGIC_AGENT_PLATFORM_ENV,
      platformVersion: 1,
      assistantRuntimeCompatible: true,
      agentCount: agents.length,
      toolCount: tools.length,
      assistantToolCount: tools.filter((tool) => tool.source === 'assistantRuntime').length,
      creativeToolCount: tools.filter((tool) => tool.source === 'creative').length,
      graphCount: graphRuntime.list().length,
      ...(packages ? { packageCount: packages.length } : {})
    }
  }

  listPendingApprovals = async (
    _req: MagicAgentPlatformEmptyReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformListPendingApprovalsResp> => {
    authorizeMagicAgentApprovalRenderer(invocation)
    return {
      approvals: [...getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()]
    }
  }

  watchPendingApprovals = async (
    _req: MagicAgentPlatformEmptyReq,
    stream: ServerStreaming<MagicAgentPlatformPendingApprovalStreamEvent>,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    authorizeMagicAgentApprovalRenderer(invocation)
    let last = ''
    let aborted = false
    stream.abortReceiver?.onAbort(() => {
      aborted = true
    })
    while (!aborted) {
      const approvals = [...getAssistantTerminalPolicyRuntime().listPendingTerminalApprovals()]
      const serialized = JSON.stringify(approvals)
      if (serialized !== last) {
        last = serialized
        stream.onData({ type: 'snapshot', approvals })
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  resolvePendingApproval = async (
    req: MagicAgentPlatformResolvePendingApprovalReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformResolvePendingApprovalResp> => {
    authorizeMagicAgentApprovalRenderer(invocation)
    return {
      approval: getAssistantTerminalPolicyRuntime().resolvePendingTerminalApproval(req)
    }
  }

  listAgents = async (
    _req: MagicAgentPlatformEmptyReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformListAgentsResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    return { agents: await this.listAllAgents() }
  }

  registerAgent = async (
    req: MagicAgentPlatformRegisterAgentReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformRegisterAgentResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    return { agent: this.getAdapter().registerAgent(req.agent) }
  }

  runAgent = async (
    req: MagicAgentPlatformRunReq,
    invocation?: ServiceInvocationContext,
    options: MagicAgentPlatformExecutionOptions = {}
  ): Promise<MagicAgentPlatformRunResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    const authorizedReq = { ...req, route }
    const agentId = normalizeMagicPotToolName(authorizedReq.agentId)
    if (agentId) {
      const adapter = this.getAdapter()
      const packageAgents = await this.listPackageAgents()
      mergeAgentDefinitions(adapter.listAgents(), packageAgents)
      const packageAgent = packageAgents.find((agent) => agent.id === agentId)
      if (packageAgent) {
        const allowedToolNames = resolvePackageAgentAllowedToolNames(
          authorizedReq.allowedToolNames,
          packageAgent.toolNames
        )
        const packageRequest = {
          ...authorizedReq,
          systemPrompt: composeSystemPrompt(packageAgent.systemPrompt, authorizedReq.systemPrompt),
          profileId: authorizedReq.profileId ?? packageAgent.profileId,
          maxToolIterations: authorizedReq.maxToolIterations ?? packageAgent.maxToolIterations,
          ...(allowedToolNames !== undefined ? { allowedToolNames } : {})
        }
        return Object.keys(options).length
          ? adapter.runAgent(packageRequest, options)
          : adapter.runAgent(packageRequest)
      }
    }
    return Object.keys(options).length
      ? this.getAdapter().runAgent(authorizedReq, options)
      : this.getAdapter().runAgent(authorizedReq)
  }

  listTools = async (
    req: MagicAgentPlatformListToolsReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformListToolsResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    return { tools: this.getAdapter().listTools(req) }
  }

  callTool = async (
    req: MagicAgentPlatformToolCallReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformToolCallResp> => {
    return this.getAdapter().callTool({ ...req, route: this.authorizeRoute(req.route, invocation) })
  }

  listTeams = async () => agentInstanceLifecycle().teams.list()
  listAgentInstances = async (
    _req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListAgentInstancesResp> => ({
    instances: agentInstanceCommands().list().map(agentInstanceResourceDto)
  })

  getAgentInstance = async (
    req: MagicAgentPlatformGetAgentInstanceReq
  ): Promise<MagicAgentPlatformGetAgentInstanceResp> => {
    const instance = agentInstanceCommands().get(req.instanceId)
    return instance ? { instance: agentInstanceResourceDto(instance) } : {}
  }

  listRuntimeChannels = async (
    _req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListRuntimeChannelsResp> => ({
    channels: runtimeChannelStore().listChannels().map(runtimeChannelResourceDto)
  })

  getRuntimeChannel = async (
    req: MagicAgentPlatformGetRuntimeChannelReq
  ): Promise<MagicAgentPlatformGetRuntimeChannelResp> => {
    const channel = runtimeChannelStore().getChannel(req.channelId)
    return channel ? { channel: runtimeChannelResourceDto(channel) } : {}
  }

  createRuntimeChannel = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformCreateRuntimeChannelReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor || actor.kind !== 'user')
      throw new Error('Runtime Channel creation requires an authenticated user.')
    const channel = runtimeChannelLifecycle().commands.create({
      ...req,
      actor,
      channel: { ...req.channel, members: [] }
    })
    return { channel: runtimeChannelResourceDto(channel) }
  }

  joinRuntimeChannel = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformJoinRuntimeChannelReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor)
      throw new Error('Runtime Channel membership mutation requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.member.agentInstanceId)
      throw new Error('Agent may only join its own Runtime Channel membership.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Runtime Channel membership actor must be an Agent or user.')
    const channel = runtimeChannelLifecycle().commands.join({ ...req, actor })
    if (!channel) throw new Error('Runtime Channel not found.')
    return { channel: runtimeChannelResourceDto(channel) }
  }

  leaveRuntimeChannel = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformLeaveRuntimeChannelReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor)
      throw new Error('Runtime Channel membership mutation requires an authenticated actor.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Runtime Channel membership actor must be an Agent or user.')
    if (actor.kind === 'agent') {
      const channel = runtimeChannelStore().getChannel(req.channelId)
      const member = channel?.state.members.find((candidate) => candidate.memberId === req.memberId)
      if (!member || member.agentInstanceId !== actor.id)
        throw new Error('Agent may only leave its own Runtime Channel membership.')
    }
    const channel = runtimeChannelLifecycle().commands.leave({ ...req, actor })
    if (!channel) throw new Error('Runtime Channel not found.')
    return { channel: runtimeChannelResourceDto(channel) }
  }

  listRuntimeChannelWires = async () => ({
    wires: runtimeChannelLifecycle().wires.list().map(runtimeChannelWireResourceDto)
  })

  getRuntimeChannelWire = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformGetRuntimeChannelWireReq
  ) => {
    const wire = runtimeChannelLifecycle().wires.get(req.wireId)
    return { ...(wire ? { wire: runtimeChannelWireResourceDto(wire) } : {}) }
  }

  wireRuntimeChannel = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformWireRuntimeChannelReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor)
      throw new Error('Runtime Channel topology mutation requires an authenticated actor.')
    const wire = runtimeChannelLifecycle().wireCommands.wire({ ...req, actor })
    if (!wire) throw new Error('Runtime Channel wire was not created.')
    return { wire: runtimeChannelWireResourceDto(wire) }
  }

  unwireRuntimeChannel = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformUnwireRuntimeChannelReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor)
      throw new Error('Runtime Channel topology mutation requires an authenticated actor.')
    const wire = runtimeChannelLifecycle().wireCommands.unwire({ ...req, actor })
    if (!wire) throw new Error('Runtime Channel wire was not found.')
    return { wire: runtimeChannelWireResourceDto(wire) }
  }

  publishRuntimeChannelMessage = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformPublishRuntimeChannelMessageReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Runtime Channel publish requires an authenticated actor.')
    const published = runtimeChannelLifecycle().commands.publish({ ...req, actor })
    if (!published) throw new Error('Runtime Channel message was not published.')
    return {
      messageId: published.id,
      revision: published.revision,
      channelId: published.state.channelId,
      status: 'published'
    }
  }

  claimRuntimeChannelMessage = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformClaimRuntimeChannelMessageReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Runtime Channel delivery requires an authenticated actor.')
    const message = runtimeChannelLifecycle().commands.claim({ ...req, actor })
    if (!message?.state.queueClaim)
      throw new Error('Runtime Channel claim did not produce a claim.')
    return {
      messageId: message.id,
      revision: message.revision,
      channelId: message.state.channelId,
      consumerMemberId: req.consumerMemberId,
      claimToken: message.state.queueClaim.token,
      leaseExpiresAt: message.state.queueClaim.expiresAt
    }
  }

  acknowledgeRuntimeChannelMessage = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformAcknowledgeRuntimeChannelMessageReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Runtime Channel delivery requires an authenticated actor.')
    const message = runtimeChannelLifecycle().commands.acknowledge({ ...req, actor })
    if (!message) throw new Error('Runtime Channel message not found.')
    return {
      messageId: message.id,
      revision: message.revision,
      channelId: message.state.channelId,
      consumerMemberId: req.consumerMemberId,
      ...(message.state.acknowledgedAt === undefined
        ? {}
        : { acknowledgedAt: message.state.acknowledgedAt })
    }
  }

  createTeam = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformCreateTeamReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Team creation requires authentication.')
    return agentInstanceLifecycle().teams.create({
      ...req,
      actor,
      team: { ...req.team, ownerId: actor.id, status: 'active', members: [], createdBy: actor }
    })
  }
  addTeamMember = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformAddTeamMemberReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Team membership mutation requires authentication.')
    return agentInstanceLifecycle().teams.addMember({
      ...req,
      actor,
      member: { ...req.member, addedBy: actor }
    })
  }
  removeTeam = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformRemoveTeamReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Team removal requires authentication.')
    return agentInstanceLifecycle().teams.remove({ ...req, actor })
  }
  removeTeamMember = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformRemoveTeamMemberReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Team membership mutation requires authentication.')
    return agentInstanceLifecycle().teams.removeMember({ ...req, actor })
  }

  replaceTeam = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformReplaceTeamReq,
    invocation?: ServiceInvocationContext
  ): Promise<import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformTeamLifecycleResp> => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Team replacement requires authentication.')
    const operation = await agentInstanceLifecycle().teams.replace({ ...req, actor })
    const state = operation.state
    if (state.status === 'running') throw new Error('Team replacement did not complete.')
    return {
      id: operation.id,
      revision: operation.revision,
      teamId: state.teamId,
      teamRevision: state.teamRevision,
      action: state.action,
      status: state.status,
      outcomes: state.outcomes,
      startedAt: state.startedAt,
      ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt })
    }
  }

  startTeam = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformStartTeamReq,
    invocation?: ServiceInvocationContext
  ) => this.runTeamLifecycle('start', req, invocation)
  pauseTeam = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformTeamLifecycleReq,
    invocation?: ServiceInvocationContext
  ) => this.runTeamLifecycle('pause', req, invocation)
  resumeTeam = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformTeamLifecycleReq,
    invocation?: ServiceInvocationContext
  ) => this.runTeamLifecycle('resume', req, invocation)
  stopTeam = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformTeamLifecycleReq,
    invocation?: ServiceInvocationContext
  ) => this.runTeamLifecycle('stop', req, invocation)

  private runTeamLifecycle = async (
    action: 'start' | 'pause' | 'resume' | 'stop',
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformTeamLifecycleReq & {
      request?: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformRunReq
    },
    invocation?: ServiceInvocationContext
  ): Promise<import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformTeamLifecycleResp> => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Team lifecycle operation requires authentication.')
    const command = agentInstanceLifecycle().teams[action]
    const operation = await command({ ...req, actor } as never)
    const state = operation.state
    if (state.status === 'running') throw new Error('Team lifecycle operation did not complete.')
    return {
      id: operation.id,
      revision: operation.revision,
      teamId: state.teamId,
      teamRevision: state.teamRevision,
      action: state.action,
      status: state.status,
      outcomes: state.outcomes,
      startedAt: state.startedAt,
      ...(state.completedAt === undefined ? {} : { completedAt: state.completedAt })
    }
  }

  createRootAgentInstance = async (
    req: MagicAgentPlatformCreateRootAgentInstanceReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp> => {
    const actor = invocation?.authenticatedActor
    if (!actor || actor.kind !== 'user')
      throw new Error('Root Agent creation requires an authenticated user.')
    return {
      instance: agentInstanceResourceDto(agentInstanceCommands().createRoot({ ...req, actor }))
    }
  }

  createChildAgentInstance = async (
    req: MagicAgentPlatformCreateChildAgentInstanceReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp> => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Child Agent creation requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.parentInstanceId)
      throw new Error('Agent may only create its own direct child.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Child Agent creation actor must be an Agent or user.')
    return {
      instance: agentInstanceResourceDto(agentInstanceCommands().createChild({ ...req, actor }))
    }
  }

  createAgentConfigVersion = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformCreateAgentConfigVersionReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor || (actor.kind !== 'agent' && actor.kind !== 'user'))
      throw new Error('Agent config creation requires an authenticated Agent or user.')
    const resource = agentInstanceCommands().createConfigVersion({
      ...req,
      config: createMagicAgentConfigContent({ ...req.config, createdBy: actor })
    })
    return {
      version: resource.state.version,
      definitionId: resource.state.definitionId,
      contentDigest: resource.state.contentDigest,
      createdAt: resource.state.createdAt
    }
  }

  stageAgentConfig = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformStageAgentConfigReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent config mutation requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.instanceId)
      throw new Error('Agent may only mutate its own config version.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Agent config actor must be an Agent or user.')
    return {
      instance: agentInstanceResourceDto(agentInstanceCommands().stageConfig({ ...req, actor }))
    }
  }

  activateAgentConfig = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformActivateAgentConfigReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent config mutation requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.instanceId)
      throw new Error('Agent may only mutate its own config version.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Agent config actor must be an Agent or user.')
    return {
      instance: agentInstanceResourceDto(
        agentInstanceCommands().activateStagedConfig({ ...req, actor })
      )
    }
  }

  rollbackAgentConfig = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformRollbackAgentConfigReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent config mutation requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.instanceId)
      throw new Error('Agent may only mutate its own config version.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Agent config actor must be an Agent or user.')
    return {
      instance: agentInstanceResourceDto(agentInstanceCommands().rollbackConfig({ ...req, actor }))
    }
  }

  startAgentInstance = async (
    req: MagicAgentPlatformStartAgentInstanceReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp> => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent start requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.instanceId)
      throw new Error('Agent may only start itself.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Agent start actor must be an Agent or user.')
    await agentInstanceCommands().start({ ...req, actor })
    const instance = agentInstanceCommands().get(req.instanceId)
    if (!instance) throw new Error('Agent instance disappeared after start.')
    return { instance: agentInstanceResourceDto(instance) }
  }

  pauseAgentInstance = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformPauseAgentInstanceReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent pause requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.instanceId)
      throw new Error('Agent may only pause itself.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Agent pause actor must be an Agent or user.')
    return {
      instance: agentInstanceResourceDto(await agentInstanceCommands().pause({ ...req, actor }))
    }
  }

  resumeAgentInstance = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformResumeAgentInstanceReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent resume requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.instanceId)
      throw new Error('Agent may only resume itself.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Agent resume actor must be an Agent or user.')
    return { instance: agentInstanceResourceDto(agentInstanceCommands().resume({ ...req, actor })) }
  }

  stopAgentInstance = async (
    req: MagicAgentPlatformStopAgentInstanceReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp> => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent stop requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.instanceId)
      throw new Error('Agent may only stop itself.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Agent stop actor must be an Agent or user.')
    await agentInstanceCommands().stop({ ...req, actor })
    const instance = agentInstanceCommands().get(req.instanceId)
    if (!instance) throw new Error('Agent instance disappeared after stop.')
    return { instance: agentInstanceResourceDto(instance) }
  }

  replaceAgentInstance = async (
    req: import('@shared/api/svcMagicAgentPlatform').MagicAgentPlatformReplaceAgentInstanceReq,
    invocation?: ServiceInvocationContext
  ) => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent replacement requires authentication.')
    return agentInstanceResourceDto(await agentInstanceCommands().replace({ ...req, actor }))
  }

  removeAgentInstance = async (
    req: MagicAgentPlatformRemoveAgentInstanceReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformAgentInstanceMutationResp> => {
    const actor = invocation?.authenticatedActor
    if (!actor) throw new Error('Agent removal requires an authenticated actor.')
    if (actor.kind === 'agent' && actor.id !== req.instanceId)
      throw new Error('Agent may only remove itself.')
    if (actor.kind !== 'agent' && actor.kind !== 'user')
      throw new Error('Agent removal actor must be an Agent or user.')
    return { instance: agentInstanceResourceDto(agentInstanceCommands().remove({ ...req, actor })) }
  }

  listDrives = async (
    _req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListDrivesResp> => ({
    drives: driveCommands().listDrives().map(driveResourceDto)
  })

  getDrive = async (
    req: MagicAgentPlatformGetDriveReq
  ): Promise<MagicAgentPlatformGetDriveResp> => {
    const drive = driveCommands().getDrive(req.driveId)
    return drive ? { drive: driveResourceDto(drive) } : {}
  }

  createDrive = async (
    req: MagicAgentPlatformCreateDriveReq
  ): Promise<MagicAgentPlatformDriveMutationResp> => ({
    drive: driveResourceDto(driveCommands().create(req as never))
  })

  transitionDrive = async (
    req: MagicAgentPlatformTransitionDriveReq
  ): Promise<MagicAgentPlatformDriveMutationResp> => ({
    drive: driveResourceDto(driveCommands().transition(req as never))
  })

  reportDriveProgress = async (
    req: MagicAgentPlatformReportDriveProgressReq
  ): Promise<MagicAgentPlatformDriveMutationResp> => ({
    drive: driveResourceDto(driveCommands().reportProgress(req as never))
  })

  retryDelivery = async (
    req: MagicAgentPlatformRetryDriveDeliveryReq
  ): Promise<MagicAgentPlatformDriveMutationResp> => ({
    drive: driveResourceDto(driveCommands().retryDelivery(req))
  })

  transferDrive = async (
    req: MagicAgentPlatformTransferDriveReq
  ): Promise<MagicAgentPlatformDriveMutationResp> => ({
    drive: driveResourceDto(driveCommands().transfer(req))
  })

  setDriveLinks = async (
    req: MagicAgentPlatformSetDriveLinksReq
  ): Promise<MagicAgentPlatformDriveMutationResp> => ({
    drive: driveResourceDto(driveCommands().setLinks(req as never))
  })

  listTriggers = async (
    _req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListTriggersResp> => ({
    triggers: triggerCommands().listTriggers().map(triggerResourceDto)
  })

  createTrigger = async (
    req: MagicAgentPlatformCreateTriggerReq
  ): Promise<MagicAgentPlatformCreateTriggerResp> => ({
    trigger: triggerResourceDto(triggerCommands().createTrigger(req))
  })

  updateTrigger = async (
    req: MagicAgentPlatformUpdateTriggerReq
  ): Promise<MagicAgentPlatformTriggerMutationResp> => ({
    trigger: triggerResourceDto(triggerCommands().update(req))
  })

  enableTrigger = async (req: MagicAgentPlatformTriggerControlReq) =>
    this.controlTrigger(req, 'enable')
  disableTrigger = async (req: MagicAgentPlatformTriggerControlReq) =>
    this.controlTrigger(req, 'disable')
  pauseTrigger = async (req: MagicAgentPlatformTriggerControlReq) =>
    this.controlTrigger(req, 'pause')
  resumeTrigger = async (req: MagicAgentPlatformTriggerControlReq) =>
    this.controlTrigger(req, 'resume')
  retryTrigger = async (req: MagicAgentPlatformTriggerControlReq) =>
    this.controlTrigger(req, 'retry')

  manualFireTrigger = async (
    req: MagicAgentPlatformManualFireTriggerReq
  ): Promise<MagicAgentPlatformManualFireTriggerResp> => ({
    occurrence: triggerResourceDto(triggerCommands().manualFire(req))
  })

  getTrigger = async (
    req: MagicAgentPlatformGetTriggerReq
  ): Promise<MagicAgentPlatformGetTriggerResp> => {
    const trigger = triggerCommands().getTrigger(req.triggerId)
    return trigger ? { trigger: triggerResourceDto(trigger) } : {}
  }

  listGraphs = async (
    _req: MagicAgentPlatformEmptyReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphListResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    return { graphs: await this.getGraphCatalog().list({}) }
  }

  listGraphCatalog = async (
    req: MagicAgentPlatformGraphCatalogListReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphListResp> => {
    const route = req.route ? this.authorizeRoute(req.route, invocation) : undefined
    if (!route) {
      this.authorizeAgentStudioInvocation(invocation)
    }
    return {
      graphs: await this.getGraphCatalog().list({
        ...(route ? { route } : {}),
        ...(req.allowedToolNames !== undefined ? { allowedToolNames: req.allowedToolNames } : {}),
        availableTools: this.getAdapter().listTools()
      })
    }
  }

  createGraph = async (
    req: MagicAgentGraphCreateRequest,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphSaveResp> => this.saveGraph(req, invocation)

  saveGraphV2 = async (
    req: MagicAgentPlatformGraphV2SaveReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphV2SaveResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: getAgentSessionKey(route),
      toolName: 'graph.save',
      toolInput: { graphId: req.graph.graphId, version: 'v2', replace: req.replace === true }
    })
    const graph = await this.getUserGraphStore().saveV2(req.graph, {
      route,
      replace: req.replace
    })
    this.getGraphRuntime().create({ graph, route, replace: true })
    return { graph, definitionV2: req.graph }
  }

  getGraphV2 = async (
    req: MagicAgentPlatformGraphV2GetReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphV2GetResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    const definitionV2 = await this.getUserGraphStore().getV2(req.graphId, route)
    return definitionV2 ? { definitionV2 } : {}
  }

  publishGraphV2 = async (
    req: MagicAgentPlatformGraphV2PublishReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphV2PublishResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: getAgentSessionKey(route),
      toolName: 'graph.publish',
      toolInput: { graphId: req.graphId, version: 'v2' }
    })
    return { definitionV2: await this.getUserGraphStore().publishV2(req.graphId, route) }
  }

  getPublishedGraphV2 = async (
    req: MagicAgentPlatformGraphV2GetPublishedReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphV2GetPublishedResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    const definitionV2 = await this.getUserGraphStore().getPublishedV2(
      req.graphId,
      req.version,
      route
    )
    return definitionV2 ? { definitionV2 } : {}
  }

  listPublishedGraphsV2 = async (
    req: MagicAgentPlatformGraphV2GetReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphV2ListPublishedResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    return {
      definitionsV2: await this.getUserGraphStore().listPublishedV2(req.graphId, route)
    }
  }

  listGraphV2NodeRegistry = async (
    _req: MagicAgentPlatformEmptyReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphV2NodeRegistryResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    const adapter = this.getAdapter()
    const creativeTools = new Map(
      adapter.listTools({ source: 'creative' }).map((tool) => [tool.name, tool] as const)
    )
    const assistantTools = new Set(
      (this.deps.assistantRuntime ?? getAssistantRuntime()).listTools().map((tool) => tool.name)
    )
    let mcpAvailabilityReason: string | undefined
    try {
      await (this.deps.ensureMcpRuntimeAvailable ?? syncMcpClientManager)()
    } catch (error) {
      mcpAvailabilityReason = `MCP client configuration is unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    const disabledReason = (descriptor: GraphV2NodeDescriptor): string | undefined => {
      switch (descriptor.kind) {
        case 'channel-message':
          return getProductionRuntimeChannelLifecycle()
            ? undefined
            : 'Communication family is unconfigured in this environment.'
        case 'automation-trigger':
          return getProductionTriggerLifecycle()
            ? undefined
            : 'Automation Trigger service is unconfigured in this environment.'
        case 'mcp-tool':
          return mcpAvailabilityReason
        case 'memory-search':
          return this.deps.semanticMemory ? undefined : 'Semantic Memory provider is unavailable.'
        case 'coding-task':
          return assistantTools.size ? undefined : 'Coding tool registry is unavailable.'
        case 'comfyui-workflow': {
          const tool = creativeTools.get('comfyui.workflow.submit')
          return !tool || tool.unavailableReason
            ? tool?.unavailableReason || 'ComfyUI creative tool is unavailable.'
            : undefined
        }
        default:
          return undefined
      }
    }
    return {
      descriptors: GRAPH_V2_FIRST_PARTY_NODE_REGISTRY.map((descriptor) => {
        const reason = disabledReason(descriptor)
        const missingFields = Object.entries(descriptor.configSchema.properties)
          .filter(
            ([key, field]) =>
              field.required &&
              (descriptor.defaultConfig[key] === undefined ||
                (field.type === 'string' && !String(descriptor.defaultConfig[key]).trim()))
          )
          .map(([key]) => key)
        return {
          ...structuredClone(descriptor),
          executable: descriptor.executable && !reason,
          ...(reason ? { disabledReason: reason } : {}),
          ...(!reason && missingFields.length
            ? {
                configurationNeeded: `Configure required fields after adding: ${missingFields.join(', ')}.`
              }
            : {})
        }
      })
    }
  }

  saveGraph = async (
    req: MagicAgentGraphCreateRequest,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphSaveResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: getAgentSessionKey(route),
      toolName: 'graph.save',
      toolInput: { graphId: req.graph.graphId, replace: req.replace === true }
    })
    const kernel = this.getAgentKernel()
    const session = kernel.registerSession(route, { source: 'kernel' })
    const graph = await this.getUserGraphStore().save({ ...req, route })
    this.getGraphRuntime().create({ graph, route, replace: true })
    kernel.recordEvent({
      runId: `magic-agent-graph:create:${graph.graphId}`,
      sessionKey: session.sessionKey,
      type: 'run.updated',
      message: `MagicAgentGraph saved: ${graph.graphId}`,
      metadata: {
        graphEventType: 'graph.saved',
        graphId: graph.graphId,
        source: 'magicAgentPlatform'
      }
    })
    return { graph }
  }

  deleteGraph = async (
    req: MagicAgentPlatformGraphDeleteReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphDeleteResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: getAgentSessionKey(route),
      toolName: 'graph.delete',
      toolInput: { graphId: req.graphId }
    })
    return { deleted: await this.getUserGraphStore().delete(req.graphId, route) }
  }

  forkGraph = async (
    req: MagicAgentPlatformGraphForkReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphForkResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: getAgentSessionKey(route),
      toolName: 'graph.fork',
      toolInput: {
        graphId: req.graphId,
        ...(req.targetGraphId ? { targetGraphId: req.targetGraphId } : {})
      }
    })
    const entry = await this.getGraphCatalog().inspect(req.graphId, {
      route,
      availableTools: this.getAdapter().listTools()
    })
    if (!entry) {
      throw new Error(`MagicAgentGraph "${req.graphId}" does not exist.`)
    }
    if (!entry.forkable) {
      throw new Error(`MagicAgentGraph "${req.graphId}" is not forkable.`)
    }
    const graph = await this.getUserGraphStore().forkGraph(entry.graph, route, {
      ...(req.targetGraphId ? { graphId: req.targetGraphId } : {}),
      ...(req.name ? { name: req.name } : {}),
      ...(req.replace ? { replace: true } : {})
    })
    this.getGraphRuntime().create({ graph, route, replace: true })
    return { graph }
  }

  forkSessionAtEvent = async (
    req: MagicAgentPlatformSessionForkReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformSessionForkResp> => {
    const sourceRoute = normalizeAgentRoute(req.sourceRoute) as AssistantRoute
    const targetRoute = normalizeAgentRoute(req.targetRoute) as AssistantRoute
    if (invocation?.authenticatedActor?.kind !== 'user') {
      throw new Error('Session fork requires an authenticated user.')
    }
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: sourceRoute,
      sessionId: getAgentSessionKey(sourceRoute),
      toolName: 'session.fork',
      toolInput: {
        sourceEventId: req.sourceEventId,
        targetSessionKey: getAgentSessionKey(targetRoute),
        idempotencyKey: req.idempotencyKey,
        effect: 'high'
      }
    })
    const runtime = this.deps.assistantRuntime || getAssistantRuntime()
    const existing = await runtime.getSession(targetRoute)
    if (existing?.lineage) {
      const lineage = existing.lineage
      if (
        lineage.sourceSessionKey !== getAgentSessionKey(sourceRoute) ||
        lineage.sourceEventId !== req.sourceEventId
      )
        throw new Error('Idempotency conflict: fork target exists with different lineage.')
      return {
        targetSessionKey: existing.sessionKey,
        lineage: {
          sourceSessionKey: lineage.sourceSessionKey,
          sourceEventId: lineage.sourceEventId,
          sourceRunId: lineage.sourceRunId,
          forkedAt: lineage.forkedAt
        },
        warning: lineage.warning,
        counts: {
          messages: existing.messages.length,
          runs: existing.runs.length,
          events: existing.eventLog.length,
          artifacts: existing.artifacts.length
        }
      }
    }
    const result = await runtime.forkSessionAtEvent(sourceRoute, req.sourceEventId, targetRoute)
    return {
      targetSessionKey: result.session.sessionKey,
      lineage: {
        sourceSessionKey: result.lineage.sourceSessionKey,
        sourceEventId: result.lineage.sourceEventId,
        sourceRunId: result.lineage.sourceRunId,
        forkedAt: result.lineage.forkedAt
      },
      warning: result.lineage.warning,
      counts: {
        messages: result.session.messages.length,
        runs: result.session.runs.length,
        events: result.session.eventLog.length,
        artifacts: result.session.artifacts.length
      }
    }
  }

  exportSession = async (
    req: MagicAgentPlatformSessionExportReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformSessionExportResp> => {
    const route = normalizeAgentRoute(req.sourceRoute) as AssistantRoute
    if (invocation?.authenticatedActor?.kind !== 'user')
      throw new Error('Session export requires an authenticated user.')
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: getAgentSessionKey(route),
      toolName: 'session.export',
      toolInput: { format: req.format, effect: 'read' }
    })
    const runtime = this.deps.assistantRuntime || getAssistantRuntime()
    const projection = await runtime.getSessionProjection(route)
    if (!projection) throw new Error('Session not found.')
    const body = await runtime.exportSession(route, req.format)
    if (body === null) throw new Error('Session not found.')
    const metadata = {
      markdown: ['text/markdown; charset=utf-8', 'md'],
      html: ['text/html; charset=utf-8', 'html'],
      jsonl: ['application/x-ndjson; charset=utf-8', 'jsonl']
    } as const
    const [mimeType, extension] = metadata[req.format]
    return {
      format: req.format,
      mimeType,
      filename: `assistant-session-${projection.session.sessionKey.replace(/[^a-z0-9._-]+/gi, '-')}.${extension}`,
      body,
      availability: projection.availability
    }
  }

  diffSessions = async (
    req: MagicAgentPlatformSessionDiffReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformSessionDiffResp> => {
    const leftRoute = normalizeAgentRoute(req.leftRoute) as AssistantRoute
    const rightRoute = normalizeAgentRoute(req.rightRoute) as AssistantRoute
    if (invocation?.authenticatedActor?.kind !== 'user')
      throw new Error('Session diff requires an authenticated user.')
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: leftRoute,
      sessionId: getAgentSessionKey(leftRoute),
      toolName: 'session.diff',
      toolInput: { rightSessionKey: getAgentSessionKey(rightRoute), effect: 'read' }
    })
    const result = await (this.deps.assistantRuntime || getAssistantRuntime()).diffSessions(
      leftRoute,
      rightRoute
    )
    if (!result) throw new Error('One or both sessions were not found.')
    return {
      schemaVersion: result.schemaVersion,
      leftSessionKey: result.leftSessionKey,
      rightSessionKey: result.rightSessionKey,
      relationship: result.lineage,
      dimensions: result.dimensions,
      timeline: result.mergedTimeline,
      sideBySide: result.sideBySide
    }
  }

  validateGraph = async (
    req: MagicAgentPlatformGraphValidateReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphValidateResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    return { validation: validateMagicAgentGraphDefinition(req.graph) }
  }

  preflightGraphRun = async (
    req: MagicAgentPlatformGraphPreflightRunReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphPreflightRunResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    const entry = await this.getGraphCatalog().inspect(req.graphId, {
      route,
      allowedToolNames: req.allowedToolNames,
      availableTools: this.getAdapter().listTools()
    })
    if (!entry) {
      throw new Error(`MagicAgentGraph "${req.graphId}" does not exist.`)
    }
    return { preflight: entry.preflight }
  }

  inspectGraph = async (
    req: MagicAgentPlatformGraphInspectReq,
    invocation?: ServiceInvocationContext
  ) => {
    this.authorizeAgentStudioInvocation(invocation)
    const entry = await this.getGraphCatalog().inspect(req.graphId, {
      availableTools: this.getAdapter().listTools()
    })
    return entry ? { graph: entry.graph } : {}
  }

  runGraph = async (
    req: MagicAgentPlatformGraphRunReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentGraphRunResult> => {
    const route = this.authorizeRoute(req.route, invocation)
    if (req.definitionV2) {
      if (req.definitionV2.graphId !== req.graphId)
        throw new Error('Graph V2 definition graphId must match the run request graphId.')
      const graph = await this.getUserGraphStore().saveV2(req.definitionV2, {
        route,
        replace: true
      })
      this.getGraphRuntime().create({ graph, route, replace: true })
    }
    const runtime = this.getGraphRuntime()
    const tools = this.getAdapter().listTools()
    const runtimeGraph = runtime.inspect?.(req.graphId)
    const shouldInspectCatalog =
      !req.definitionV2 &&
      !runtimeGraph &&
      (!this.deps.graphRuntime || Boolean(this.deps.userGraphStore || this.deps.packageStore))
    const entry = shouldInspectCatalog
      ? await this.getGraphCatalog().inspect(req.graphId, {
          route,
          allowedToolNames: req.allowedToolNames,
          availableTools: tools
        })
      : undefined
    const preflight =
      entry?.preflight ||
      (runtimeGraph
        ? createMagicAgentGraphPreflightSnapshot(runtimeGraph, {
            allowedToolNames: req.allowedToolNames,
            availableTools: tools
          })
        : undefined)
    if (!entry && !runtimeGraph && !this.deps.graphRuntime) {
      throw new Error(`MagicAgentGraph "${req.graphId}" does not exist.`)
    }
    if (entry && !entry.runnable) {
      throw new Error(
        entry.unavailableReason || `MagicAgentGraph "${req.graphId}" is not runnable.`
      )
    }
    if (preflight && !preflight.safeToRun) {
      throw new Error(
        preflight.issues.find((issue) => issue.severity === 'error')?.message ||
          `MagicAgentGraph "${req.graphId}" failed preflight.`
      )
    }

    const graphForRun: MagicAgentGraphDefinition | undefined = entry?.graph || runtimeGraph
    if (entry && graphForRun && (!entry.builtIn || !runtime.inspect(graphForRun.graphId))) {
      runtime.create({ graph: graphForRun, route, replace: true })
    }

    const kernel = this.getAgentKernel()
    const session = kernel.registerSession(route, { source: 'kernel' })
    const kernelRun = kernel.createMasterRun({
      session,
      goal: req.input,
      label: `MagicAgentGraph ${req.graphId}`,
      parallelism: 1,
      requestedBy: 'svcMagicAgentPlatform.runGraph',
      metadata: {
        ...(req.metadata || {}),
        source: 'magicAgentPlatform',
        graphId: req.graphId,
        executionBoundary: 'magicAgentGraphRuntime',
        route: session.route,
        sessionKey: session.sessionKey,
        ...(graphForRun ? { graphSnapshot: graphForRun } : {}),
        ...(preflight
          ? { permissionSnapshot: preflight.permissions, preflightSnapshot: preflight }
          : {})
      }
    })
    kernel.updateRun(kernelRun.runId, { status: 'running', startedAt: Date.now() })

    try {
      const result = await runtime.run({
        ...req,
        route,
        metadata: {
          ...(req.metadata || {}),
          ...(graphForRun ? { graphSnapshot: graphForRun } : {}),
          ...(preflight
            ? { permissionSnapshot: preflight.permissions, preflightSnapshot: preflight }
            : {}),
          kernelRunId: kernelRun.runId,
          route: session.route,
          sessionKey: session.sessionKey
        }
      })
      for (const graphEvent of result.events || []) {
        const graphRuntimeEventType =
          graphEvent.type === 'node.started'
            ? 'step.started'
            : graphEvent.type === 'node.completed'
              ? 'step.completed'
              : graphEvent.type === 'node.failed'
                ? 'step.failed'
                : 'run.updated'
        kernel.recordEvent({
          runId: kernelRun.runId,
          sessionKey: session.sessionKey,
          type: graphRuntimeEventType,
          message: graphEvent.message,
          metadata: {
            ...(graphEvent.metadata || {}),
            graphEventType: graphEvent.type,
            graphId: graphEvent.graphId,
            graphRunId: graphEvent.runId,
            graphNodeId: graphEvent.nodeId,
            graphChannelId: graphEvent.channelId,
            graphOutputId: graphEvent.outputId
          }
        })
      }
      const kernelStatus =
        result.status === 'completed'
          ? 'completed'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed'
      kernel.updateRun(kernelRun.runId, {
        status: kernelStatus,
        endedAt: Date.now(),
        metadata: {
          ...(kernelRun.metadata || {}),
          graphRunId: result.runId,
          graphStatus: result.status,
          route: session.route,
          sessionKey: session.sessionKey
        }
      })
      const kernelEventType =
        kernelStatus === 'completed'
          ? 'run.completed'
          : kernelStatus === 'cancelled'
            ? 'run.updated'
            : 'run.failed'
      const graphEventType =
        kernelStatus === 'completed'
          ? 'graph.completed'
          : kernelStatus === 'cancelled'
            ? 'graph.cancelled'
            : 'graph.failed'
      kernel.recordEvent({
        runId: kernelRun.runId,
        sessionKey: session.sessionKey,
        type: kernelEventType,
        message: `MagicAgentGraph run ${result.status}: ${req.graphId}`,
        metadata: {
          graphEventType,
          graphId: req.graphId,
          graphRunId: result.runId,
          graphStatus: result.status
        }
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      kernel.updateRun(kernelRun.runId, {
        status: 'failed',
        endedAt: Date.now(),
        metadata: {
          ...(kernelRun.metadata || {}),
          error: message,
          route: session.route,
          sessionKey: session.sessionKey
        }
      })
      kernel.recordEvent({
        runId: kernelRun.runId,
        sessionKey: session.sessionKey,
        type: 'run.failed',
        message: `MagicAgentGraph run failed: ${req.graphId}`,
        metadata: { graphEventType: 'graph.failed', graphId: req.graphId, error: message }
      })
      throw error
    }
  }

  listGraphRuns = async (
    req: MagicAgentPlatformGraphRunListReq,
    invocation?: ServiceInvocationContext
  ) => {
    const route = this.authorizeRoute(req.route, invocation)
    const session = this.getAgentKernel().registerSession(route, {
      source: 'kernel'
    })
    const runtime = this.getGraphRuntime()
    const listRunsForRoute = (
      runtime as {
        listRunsForRoute?: (
          route: AgentRouteLike,
          graphId?: string,
          limit?: number
        ) => Promise<MagicAgentGraphRunResult[]>
      }
    ).listRunsForRoute
    if (typeof listRunsForRoute === 'function') {
      return {
        runs: (await listRunsForRoute.call(runtime, route, req.graphId, req.limit)).map(
          projectPublicGraphRun
        )
      }
    }
    return {
      runs: runtime.listRuns(session.sessionKey, req.graphId, req.limit).map(projectPublicGraphRun)
    }
  }

  getGraphRun = async (
    req: MagicAgentPlatformGraphRunGetReq,
    invocation?: ServiceInvocationContext
  ) => {
    const route = this.authorizeRoute(req.route, invocation)
    const session = this.getAgentKernel().registerSession(route, {
      source: 'kernel'
    })
    const runtime = this.getGraphRuntime()
    const getRunByRoute = (
      runtime as {
        getRunByRoute?: (
          runId: string,
          route: AgentRouteLike
        ) => Promise<MagicAgentGraphRunResult | undefined>
      }
    ).getRunByRoute
    const run =
      typeof getRunByRoute === 'function'
        ? await getRunByRoute.call(runtime, req.runId, route)
        : runtime.getRun(req.runId, session.sessionKey)
    return run ? { run: projectPublicGraphRun(run) } : {}
  }

  getRuntimeGraphTopology = async (
    req: MagicAgentPlatformRuntimeGraphTopologyReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformRuntimeGraphTopologyResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    const run = await this.getGraphRuntime().getRunByRoute(req.runId, route)
    if (!run) throw new Error(`Graph run ${req.runId} was not found for this route.`)
    if (!run.runtimeTopology) {
      throw new Error(`Graph run ${req.runId} does not contain runtime topology attribution.`)
    }
    const topology = run.runtimeTopology
    const resourceIds = new Set(topology.resources.map((resource) => resource.resourceId))
    for (const resource of topology.resources) {
      if (
        (resource.sourceResourceId && !resourceIds.has(resource.sourceResourceId)) ||
        (resource.targetResourceId && !resourceIds.has(resource.targetResourceId))
      ) {
        throw new Error(`Graph run ${req.runId} contains invalid runtime topology endpoints.`)
      }
    }
    return {
      runId: run.runId,
      graphId: run.graphId,
      status: run.status,
      revision: topology.revision,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      resources: topology.resources.map((resource) => ({ ...resource }))
    }
  }

  listGraphRunEvents = async (
    req: MagicAgentPlatformGraphRunEventListReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformGraphRunEventListResp> => {
    const route = this.authorizeRoute(req.route, invocation)
    const runtime = this.getGraphRuntime()
    const getRunByRoute = (
      runtime as {
        getRunByRoute?: (
          runId: string,
          route: AgentRouteLike
        ) => Promise<MagicAgentGraphRunResult | undefined>
      }
    ).getRunByRoute
    const run =
      typeof getRunByRoute === 'function'
        ? await getRunByRoute.call(runtime, req.runId, route)
        : runtime.getRun(req.runId, getAgentSessionKey(route))
    if (!run) {
      return { events: [] }
    }
    const limit =
      Number.isInteger(req.limit) && Number(req.limit) > 0 ? Number(req.limit) : undefined
    const allEvents = run.events || []
    const events = limit === undefined ? allEvents : allEvents.slice(-limit)
    return { events }
  }

  attachGraphRun = async (
    req: MagicAgentPlatformGraphRunAttachReq,
    resp: ServerStreaming<MagicAgentGraphRunPublicEvent>,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    const route = this.authorizeRoute(req.route, invocation)
    const run = await this.getGraphRuntime().getRunByRoute(req.runId, route)
    if (!run) throw new Error(`Graph run ${req.runId} was not found for this route.`)
    const store = this.getRunEventStore()
    let lastSequence = 0
    let settled = false
    let replaying = true
    let draining = false
    let unsubscribe: (() => void) | undefined
    const pending = new Map<string, MagicAgentGraphRunPublicEvent>()
    const recentEventIds = new Set<string>()
    const recentEventIdOrder: string[] = []
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: unknown): void => {
        if (settled) return
        settled = true
        unsubscribe?.()
        unsubscribe = undefined
        error ? reject(error) : resolve()
      }
      const emit = (event: MagicAgentGraphRunPublicEvent): boolean => {
        if (settled || event.sequence <= lastSequence || recentEventIds.has(event.eventId)) {
          return false
        }
        lastSequence = event.sequence
        recentEventIds.add(event.eventId)
        recentEventIdOrder.push(event.eventId)
        if (recentEventIdOrder.length > ATTACH_GRAPH_RUN_MAX_BUFFERED_EVENTS) {
          recentEventIds.delete(recentEventIdOrder.shift()!)
        }
        try {
          resp.onData(event)
        } catch (error) {
          settle(error)
        }
        return TERMINAL_GRAPH_RUN_EVENT_KINDS.has(event.kind)
      }
      const drain = (): void => {
        if (settled || draining || replaying) return
        draining = true
        try {
          while (!settled && pending.size > 0) {
            const next = [...pending.values()].sort(
              (left, right) =>
                left.sequence - right.sequence || left.eventId.localeCompare(right.eventId)
            )[0]!
            if (next.sequence <= lastSequence) {
              pending.delete(next.eventId)
              continue
            }
            // Once delivery has started, retain later live events until any sequence gap is filled.
            if (lastSequence > 0 && next.sequence !== lastSequence + 1) break
            pending.delete(next.eventId)
            if (emit(next)) settle()
          }
        } finally {
          draining = false
        }
      }
      const enqueue = (event: MagicAgentGraphRunPublicEvent): void => {
        if (
          settled ||
          event.sequence <= lastSequence ||
          recentEventIds.has(event.eventId) ||
          pending.has(event.eventId) ||
          [...pending.values()].some((pendingEvent) => pendingEvent.sequence === event.sequence)
        ) {
          return
        }
        if (pending.size >= ATTACH_GRAPH_RUN_MAX_BUFFERED_EVENTS) {
          settle(new Error('Graph run attach buffer exceeded its safety limit.'))
          return
        }
        pending.set(event.eventId, event)
        drain()
      }
      resp.abortReceiver?.onAbort(() => settle())
      if (resp.abortReceiver?.isAborted()) return settle()
      // Subscribe before touching the durable snapshot. New appends remain buffered until replay
      // is merged, preventing a later live sequence from advancing past earlier durable events.
      unsubscribe = store.subscribe(req.runId, enqueue)
      try {
        store.appendMany(run.events || [])
        for (const event of store.listAfter(req.runId, req.afterEventId)) enqueue(event)
        replaying = false
        drain()
      } catch (error) {
        settle(error)
      }
    })
  }

  watchGraphRun = async (
    req: MagicAgentPlatformGraphRunWatchReq,
    resp: ServerStreaming<MagicAgentGraphRunStreamEvent>,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    assertMagicAgentPlatformEnabled()
    const route = this.authorizeRoute(req.route, invocation)
    const kernel = this.getAgentKernel()
    const session = kernel.registerSession(route, {
      source: 'kernel'
    })
    const runtime = this.getGraphRuntime()
    let unsubscribe: (() => void) | undefined
    let settled = false

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        const currentUnsubscribe = unsubscribe
        unsubscribe = undefined
        currentUnsubscribe?.()
      }
      const settle = (error?: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const handleStreamEvent = (event: MagicAgentGraphRunStreamEvent): void => {
        if (settled) return
        try {
          resp.onData(event.run ? { ...event, run: projectPublicGraphRun(event.run) } : event)
        } catch (error) {
          settle(error)
          return
        }
        if (event.type === 'closed') {
          settle()
        }
      }

      resp.abortReceiver?.onAbort(() => settle())
      if (resp.abortReceiver?.isAborted()) {
        settle()
        return
      }

      const subscribeWithGrace = async (): Promise<void> => {
        const deadline = Date.now() + WATCH_GRAPH_RUN_SUBSCRIBE_TIMEOUT_MS
        while (!settled) {
          try {
            const nextUnsubscribe = runtime.subscribeToRun(
              req.runId,
              session.sessionKey,
              handleStreamEvent
            )
            if (nextUnsubscribe) {
              if (settled) {
                nextUnsubscribe()
              } else {
                unsubscribe = nextUnsubscribe
              }
              return
            }
          } catch (error) {
            settle(error)
            return
          }

          if (Date.now() >= deadline) {
            settle(new Error(`Graph run ${req.runId} was not found for this route.`))
            return
          }
          await delay(WATCH_GRAPH_RUN_SUBSCRIBE_RETRY_MS)
        }
      }

      void subscribeWithGrace().catch(settle)
    })
  }

  cancelGraphRun = async (
    req: MagicAgentPlatformGraphCancelReq,
    invocation?: ServiceInvocationContext
  ) => {
    const kernel = this.getAgentKernel()
    const route = this.authorizeRoute(req.route, invocation)
    const session = kernel.registerSession(route, { source: 'kernel' })
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: session.sessionKey,
      toolName: 'graph.cancel',
      toolInput: { runId: req.runId, ...(req.reason ? { reason: req.reason } : {}) }
    })
    const result = this.getGraphRuntime().cancel(req.runId, session.sessionKey, req.reason)
    kernel.recordEvent({
      runId: req.runId,
      sessionKey: session.sessionKey,
      type: 'run.updated',
      message: result.cancelled
        ? `MagicAgentGraph run cancelled: ${req.runId}`
        : `MagicAgentGraph run cancel failed: ${req.runId}`,
      metadata: {
        runId: req.runId,
        cancelled: result.cancelled,
        status: result.status,
        error: result.error,
        graphEventType: result.cancelled ? 'graph.cancelled' : 'graph.cancel.failed'
      }
    })
    return result
  }

  pauseGraphRun = async (
    req: MagicAgentPlatformGraphPauseReq,
    invocation?: ServiceInvocationContext
  ) => {
    const route = this.authorizeRoute(req.route, invocation)
    const session = this.getAgentKernel().registerSession(route, { source: 'kernel' })
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: session.sessionKey,
      toolName: 'graph.pause',
      toolInput: { runId: req.runId }
    })
    const result = await this.getGraphRuntime().pause(req.runId, session.sessionKey)
    this.getAgentKernel().recordEvent({
      runId: req.runId,
      sessionKey: session.sessionKey,
      type: 'run.updated',
      message: `MagicAgentGraph pause ${result.paused ? 'completed' : 'failed'}: ${req.runId}`,
      metadata: { graphEventType: result.paused ? 'graph.paused' : 'graph.pause.failed', ...result }
    })
    return result
  }

  resumeGraphRun = async (
    req: MagicAgentPlatformGraphResumeReq,
    invocation?: ServiceInvocationContext
  ) => {
    const route = this.authorizeRoute(req.route, invocation)
    const session = this.getAgentKernel().registerSession(route, { source: 'kernel' })
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: session.sessionKey,
      toolName: 'graph.resume',
      toolInput: { runId: req.runId }
    })
    const result = this.getGraphRuntime().resume(req.runId, session.sessionKey)
    this.getAgentKernel().recordEvent({
      runId: req.runId,
      sessionKey: session.sessionKey,
      type: 'run.updated',
      message: `MagicAgentGraph resume ${result.resumed ? 'completed' : 'failed'}: ${req.runId}`,
      metadata: {
        graphEventType: result.resumed ? 'graph.resumed' : 'graph.resume.failed',
        ...result
      }
    })
    return result
  }

  injectPendingInput = async (
    req: MagicAgentPlatformInjectPendingInputReq,
    invocation?: ServiceInvocationContext
  ) => this.mutatePendingInput('inject', req, invocation)

  editPendingInput = async (
    req: MagicAgentPlatformEditPendingInputReq,
    invocation?: ServiceInvocationContext
  ) => this.mutatePendingInput('edit', req, invocation)

  cancelPendingInput = async (
    req: MagicAgentPlatformPendingInputMutationReq,
    invocation?: ServiceInvocationContext
  ) => this.mutatePendingInput('cancel', req, invocation)

  private mutatePendingInput = async (
    action: 'inject' | 'edit' | 'cancel',
    req:
      | MagicAgentPlatformInjectPendingInputReq
      | MagicAgentPlatformEditPendingInputReq
      | MagicAgentPlatformPendingInputMutationReq,
    invocation?: ServiceInvocationContext
  ) => {
    const route = this.authorizeRoute(req.route, invocation)
    const session = this.getAgentKernel().registerSession(route, { source: 'kernel' })
    const toolInput = {
      runId: req.runId,
      pendingInputId: req.pendingInputId,
      expectedRevision: req.expectedRevision
    }
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route,
      sessionId: session.sessionKey,
      toolName: `graph.input.${action}`,
      toolInput
    })
    const runtime = this.getGraphRuntime()
    const request = { ...req, sessionKey: session.sessionKey }
    if (action === 'inject')
      return runtime.injectPendingInput(request as Parameters<typeof runtime.injectPendingInput>[0])
    if (action === 'edit')
      return runtime.editPendingInput(request as Parameters<typeof runtime.editPendingInput>[0])
    return runtime.cancelPendingInput(request)
  }

  validatePackageManifest = async (
    req: MagicAgentPlatformValidatePackageManifestReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformValidatePackageManifestResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    assertMagicAgentPlatformEnabled()
    return { validation: validateMagicAgentPackageManifest(req.manifest) }
  }

  scanPackage = async (
    req: MagicAgentPlatformPackagePathReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformPackageScanResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    const packageStore = this.getPackageStore()
    return redactPackageInspection(
      await packageStore.scanLocalDirectory(assertPackagePathApproved(packageStore, req.packageDir))
    )
  }

  installPackage = async (
    req: MagicAgentPlatformPackagePathReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformPackageInstallResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: {
        channel: 'agent-studio',
        scopeType: 'channel',
        scopeId: `package:${req.packageDir}`
      },
      sessionId: `package:${req.packageDir}`,
      toolName: 'package.install',
      toolInput: { packageDir: req.packageDir }
    })
    const packageStore = this.getPackageStore()
    try {
      const result = await packageStore.install(
        assertPackagePathApproved(packageStore, req.packageDir)
      )
      return { replaced: result.replaced, installed: redactInstalledPackage(result.installed) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(redactLocalPathFragments(message))
    }
  }

  listPackages = async (
    _req: MagicAgentPlatformEmptyReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformPackageListResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    return { packages: (await this.getPackageStore().list()).map(redactInstalledPackage) }
  }

  inspectPackage = async (
    req: MagicAgentPlatformPackageInspectReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformPackageInspectResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    const packageStore = this.getPackageStore()
    if (isPathLikePackageIdentifier(req.packageIdOrDir)) {
      return redactPackageInspection(
        await packageStore.scanLocalDirectory(
          assertPackagePathApproved(packageStore, req.packageIdOrDir)
        )
      )
    }
    return redactPackageInspection(await packageStore.inspect(req.packageIdOrDir))
  }

  uninstallPackage = async (
    req: MagicAgentPlatformPackageUninstallReq,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentPlatformPackageUninstallResp> => {
    this.authorizeAgentStudioInvocation(invocation)
    getAssistantTerminalPolicyRuntime().authorizeAssistantMutation({
      route: {
        channel: 'agent-studio',
        scopeType: 'channel',
        scopeId: `package:${req.packageId}`
      },
      sessionId: `package:${req.packageId}`,
      toolName: 'package.uninstall',
      toolInput: { packageId: req.packageId }
    })
    return { uninstalled: await this.getPackageStore().uninstall(req.packageId) }
  }
}
