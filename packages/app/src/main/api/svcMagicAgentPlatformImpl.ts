import path from 'node:path'
import { app } from 'electron'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { normalizeMagicPotToolName } from '@shared/app/types'
import type { AgentRouteLike } from '@shared/agent'
import type { AssistantRoute } from '../assistantRuntime/types'
import { getAgentKernel, type AgentKernel } from '../agentKernel'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformEmptyReq,
  MagicAgentPlatformGraphCancelReq,
  MagicAgentPlatformGraphInspectReq,
  MagicAgentPlatformGraphRunGetReq,
  MagicAgentPlatformGraphRunListReq,
  MagicAgentPlatformGraphRunWatchReq,
  MagicAgentPlatformListAgentsResp,
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
  MagicAgentPlatformRegisterAgentReq,
  MagicAgentPlatformRegisterAgentResp,
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
  type MagicAgentGraphRunRequest,
  type MagicAgentGraphRunResult,
  type MagicAgentGraphRunStreamEvent
} from '@shared/magicAgent'
import type {
  MagicAgentInstalledPackage,
  MagicAgentPackageAgentDefinition,
  MagicAgentPackageInspection
} from '@shared/magicAgentRuntime'
import {
  getMagicAgentPlatformAdapter,
  type MagicAgentPlatformAdapter
} from '../magicAgentRuntime/platformAdapter'
import { getMagicAgentGraphRuntime, type MagicAgentGraphRuntime } from '../magicAgentRuntime/graph'
import {
  MagicAgentPackageStore,
  validateMagicAgentPackageManifest
} from '../magicAgentRuntime/package'
import {
  assertMagicAgentPlatformEnabled,
  isMagicAgentPlatformEnabled,
  MAGIC_AGENT_PLATFORM_ENV
} from '../magicAgentRuntime/featureFlag'
import { authorizeMagicAgentTrustedRoute } from '../magicAgentRuntime/trustedRouteBinding'
import { isMagicAgentPlatformDeniedToolName } from '../magicAgentRuntime/toolPolicy'

export type MagicAgentPlatformRouteAuthorizer = (
  route: AgentRouteLike,
  invocation?: ServiceInvocationContext
) => AgentRouteLike

export type MagicAgentPlatformSvcImplDeps = {
  adapter?: MagicAgentPlatformAdapter
  graphRuntime?: MagicAgentGraphRuntime
  packageStore?: MagicAgentPackageStore
  agentKernel?: AgentKernel
  routeAuthorizer?: MagicAgentPlatformRouteAuthorizer
}

const WATCH_GRAPH_RUN_SUBSCRIBE_TIMEOUT_MS = 2_000
const WATCH_GRAPH_RUN_SUBSCRIBE_RETRY_MS = 25

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const resolveDefaultPackageRoot = (): string => {
  const userData = app?.getPath?.('userData') || process.cwd()
  return path.join(userData, 'magic-agent-packages')
}

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

export class MagicAgentPlatformSvcImpl implements MagicAgentPlatformSvc {
  private readonly deps: MagicAgentPlatformSvcImplDeps
  private adapterInstance?: MagicAgentPlatformAdapter
  private graphRuntimeInstance?: MagicAgentGraphRuntime
  private packageStoreInstance?: MagicAgentPackageStore
  private agentKernelInstance?: AgentKernel

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

  private getGraphRuntime(): MagicAgentGraphRuntime {
    assertMagicAgentPlatformEnabled()
    if (!this.graphRuntimeInstance) {
      if (this.deps.graphRuntime) {
        this.graphRuntimeInstance = this.deps.graphRuntime
      } else {
        const adapter = this.getAdapter()
        this.graphRuntimeInstance = getMagicAgentGraphRuntime({
          runAgent: (request) => adapter.runAgent(request),
          callTool: (request) => adapter.callTool(request)
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
    invocation?: ServiceInvocationContext
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
        return adapter.runAgent({
          ...authorizedReq,
          systemPrompt: authorizedReq.systemPrompt ?? packageAgent.systemPrompt,
          profileId: authorizedReq.profileId ?? packageAgent.profileId,
          maxToolIterations: authorizedReq.maxToolIterations ?? packageAgent.maxToolIterations,
          ...(allowedToolNames !== undefined ? { allowedToolNames } : {})
        })
      }
    }
    return this.getAdapter().runAgent(authorizedReq)
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

  listGraphs = async (_req: MagicAgentPlatformEmptyReq, invocation?: ServiceInvocationContext) => {
    this.authorizeAgentStudioInvocation(invocation)
    return { graphs: this.getGraphRuntime().list() }
  }

  createGraph = async (
    req: MagicAgentGraphCreateRequest,
    invocation?: ServiceInvocationContext
  ) => {
    const route = this.authorizeRoute(req.route, invocation)
    const kernel = this.getAgentKernel()
    const session = kernel.registerSession(route, { source: 'kernel' })
    const graph = this.getGraphRuntime().create({ ...req, route })
    kernel.recordEvent({
      runId: `magic-agent-graph:create:${graph.graphId}`,
      sessionKey: session.sessionKey,
      type: 'run.updated',
      message: `MagicAgentGraph created: ${graph.graphId}`,
      metadata: {
        graphEventType: 'graph.created',
        graphId: graph.graphId,
        source: 'magicAgentPlatform'
      }
    })
    return { graph }
  }

  inspectGraph = async (
    req: MagicAgentPlatformGraphInspectReq,
    invocation?: ServiceInvocationContext
  ) => {
    this.authorizeAgentStudioInvocation(invocation)
    const graph = this.getGraphRuntime().inspect(req.graphId)
    return graph ? { graph } : {}
  }

  runGraph = async (
    req: MagicAgentGraphRunRequest,
    invocation?: ServiceInvocationContext
  ): Promise<MagicAgentGraphRunResult> => {
    const route = this.authorizeRoute(req.route, invocation)
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
        sessionKey: session.sessionKey
      }
    })
    kernel.updateRun(kernelRun.runId, { status: 'running', startedAt: Date.now() })

    try {
      const result = await this.getGraphRuntime().run({
        ...req,
        route,
        metadata: {
          ...(req.metadata || {}),
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
    const session = this.getAgentKernel().registerSession(
      this.authorizeRoute(req.route, invocation),
      {
        source: 'kernel'
      }
    )
    return { runs: this.getGraphRuntime().listRuns(session.sessionKey, req.graphId, req.limit) }
  }

  getGraphRun = async (
    req: MagicAgentPlatformGraphRunGetReq,
    invocation?: ServiceInvocationContext
  ) => {
    const session = this.getAgentKernel().registerSession(
      this.authorizeRoute(req.route, invocation),
      {
        source: 'kernel'
      }
    )
    const run = this.getGraphRuntime().getRun(req.runId, session.sessionKey)
    return run ? { run } : {}
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
          resp.onData(event)
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
    const session = kernel.registerSession(this.authorizeRoute(req.route, invocation), {
      source: 'kernel'
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
    return { uninstalled: await this.getPackageStore().uninstall(req.packageId) }
  }
}
