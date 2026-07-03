import path from 'node:path'
import { app } from 'electron'
import type { AssistantRoute } from '../assistantRuntime/types'
import { getAgentKernel, type AgentKernel } from '../agentKernel'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformEmptyReq,
  MagicAgentPlatformGraphCancelReq,
  MagicAgentPlatformGraphInspectReq,
  MagicAgentPlatformGraphRunGetReq,
  MagicAgentPlatformGraphRunListReq,
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
import type {
  MagicAgentGraphCreateRequest,
  MagicAgentGraphRunRequest,
  MagicAgentGraphRunResult
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

export type MagicAgentPlatformSvcImplDeps = {
  adapter?: MagicAgentPlatformAdapter
  graphRuntime?: MagicAgentGraphRuntime
  packageStore?: MagicAgentPackageStore
  agentKernel?: AgentKernel
}

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
    packageToolNames.map((toolName) => String(toolName || '').trim()).filter(Boolean)
  )
  return requested
    .map((toolName) => String(toolName || '').trim())
    .filter((toolName) => Boolean(toolName) && packageToolNameSet.has(toolName))
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
      this.graphRuntimeInstance = this.deps.graphRuntime || getMagicAgentGraphRuntime()
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

  getStatus = async (_req: MagicAgentPlatformEmptyReq): Promise<MagicAgentPlatformStatusResp> => {
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
    _req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformListAgentsResp> => {
    return { agents: await this.listAllAgents() }
  }

  registerAgent = async (
    req: MagicAgentPlatformRegisterAgentReq
  ): Promise<MagicAgentPlatformRegisterAgentResp> => {
    return { agent: this.getAdapter().registerAgent(req.agent) }
  }

  runAgent = async (req: MagicAgentPlatformRunReq): Promise<MagicAgentPlatformRunResp> => {
    const agentId = req.agentId?.trim()
    if (agentId) {
      const adapter = this.getAdapter()
      const packageAgents = await this.listPackageAgents()
      mergeAgentDefinitions(adapter.listAgents(), packageAgents)
      const packageAgent = packageAgents.find((agent) => agent.id === agentId)
      if (packageAgent) {
        const allowedToolNames = resolvePackageAgentAllowedToolNames(
          req.allowedToolNames,
          packageAgent.toolNames
        )
        return adapter.runAgent({
          ...req,
          systemPrompt: req.systemPrompt ?? packageAgent.systemPrompt,
          profileId: req.profileId ?? packageAgent.profileId,
          maxToolIterations: req.maxToolIterations ?? packageAgent.maxToolIterations,
          ...(allowedToolNames !== undefined ? { allowedToolNames } : {})
        })
      }
    }
    return this.getAdapter().runAgent(req)
  }

  listTools = async (
    req: MagicAgentPlatformListToolsReq
  ): Promise<MagicAgentPlatformListToolsResp> => {
    return { tools: this.getAdapter().listTools(req) }
  }

  callTool = async (
    req: MagicAgentPlatformToolCallReq
  ): Promise<MagicAgentPlatformToolCallResp> => {
    return this.getAdapter().callTool(req)
  }

  listGraphs = async (_req: MagicAgentPlatformEmptyReq) => {
    return { graphs: this.getGraphRuntime().list() }
  }

  createGraph = async (req: MagicAgentGraphCreateRequest) => {
    const kernel = this.getAgentKernel()
    const session = kernel.registerSession(req.route as AssistantRoute, { source: 'kernel' })
    const graph = this.getGraphRuntime().create(req)
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

  inspectGraph = async (req: MagicAgentPlatformGraphInspectReq) => {
    const graph = this.getGraphRuntime().inspect(req.graphId)
    return graph ? { graph } : {}
  }

  runGraph = async (req: MagicAgentGraphRunRequest): Promise<MagicAgentGraphRunResult> => {
    const kernel = this.getAgentKernel()
    const session = kernel.registerSession(req.route as AssistantRoute, { source: 'kernel' })
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
        metadata: {
          ...(req.metadata || {}),
          kernelRunId: kernelRun.runId,
          route: session.route,
          sessionKey: session.sessionKey
        }
      })
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
      kernel.recordEvent({
        runId: kernelRun.runId,
        sessionKey: session.sessionKey,
        type: kernelStatus === 'completed' ? 'run.completed' : 'run.failed',
        message: `MagicAgentGraph run ${result.status}: ${req.graphId}`,
        metadata: {
          graphEventType: kernelStatus === 'completed' ? 'graph.completed' : 'graph.failed',
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

  listGraphRuns = async (req: MagicAgentPlatformGraphRunListReq) => {
    const session = this.getAgentKernel().registerSession(req.route as AssistantRoute, {
      source: 'kernel'
    })
    return { runs: this.getGraphRuntime().listRuns(session.sessionKey, req.graphId, req.limit) }
  }

  getGraphRun = async (req: MagicAgentPlatformGraphRunGetReq) => {
    const session = this.getAgentKernel().registerSession(req.route as AssistantRoute, {
      source: 'kernel'
    })
    const run = this.getGraphRuntime().getRun(req.runId, session.sessionKey)
    return run ? { run } : {}
  }

  cancelGraphRun = async (req: MagicAgentPlatformGraphCancelReq) => {
    const kernel = this.getAgentKernel()
    const session = kernel.registerSession(req.route as AssistantRoute, { source: 'kernel' })
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
    req: MagicAgentPlatformValidatePackageManifestReq
  ): Promise<MagicAgentPlatformValidatePackageManifestResp> => {
    assertMagicAgentPlatformEnabled()
    return { validation: validateMagicAgentPackageManifest(req.manifest) }
  }

  scanPackage = async (
    req: MagicAgentPlatformPackagePathReq
  ): Promise<MagicAgentPlatformPackageScanResp> => {
    const packageStore = this.getPackageStore()
    return redactPackageInspection(
      await packageStore.scanLocalDirectory(assertPackagePathApproved(packageStore, req.packageDir))
    )
  }

  installPackage = async (
    req: MagicAgentPlatformPackagePathReq
  ): Promise<MagicAgentPlatformPackageInstallResp> => {
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
    _req: MagicAgentPlatformEmptyReq
  ): Promise<MagicAgentPlatformPackageListResp> => {
    return { packages: (await this.getPackageStore().list()).map(redactInstalledPackage) }
  }

  inspectPackage = async (
    req: MagicAgentPlatformPackageInspectReq
  ): Promise<MagicAgentPlatformPackageInspectResp> => {
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
    req: MagicAgentPlatformPackageUninstallReq
  ): Promise<MagicAgentPlatformPackageUninstallResp> => {
    return { uninstalled: await this.getPackageStore().uninstall(req.packageId) }
  }
}
