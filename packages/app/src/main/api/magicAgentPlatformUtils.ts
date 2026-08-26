import path from 'node:path'
import type {
  MagicAgentPlatformAgentDefinition,
  MagicAgentPlatformAgentInstanceResource,
  MagicAgentPlatformPackageScanResp,
  MagicAgentPlatformRunReq
} from '@shared/api/svcMagicAgentPlatform'
import { normalizeMagicPotToolName } from '@shared/app/types'
import type {
  MagicAgentInstanceState,
  RuntimeChannelState,
  RuntimeChannelWireState
} from '@shared/magicAgentPlatform2'
import type {
  MagicAgentGraphPendingInputRecord,
  MagicAgentGraphRunResult
} from '@shared/magicAgent'
import type {
  MagicAgentInstalledPackage,
  MagicAgentPackageAgentDefinition,
  MagicAgentPackageInspection
} from '@shared/magicAgentRuntime'
import { isMagicAgentPlatformDeniedToolName } from '../magicAgentRuntime/toolPolicy'
import type { MagicAgentPackageStore } from '../magicAgentRuntime/package'

export const projectPublicPendingInput = (
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

export const projectPublicGraphRun = (run: MagicAgentGraphRunResult): MagicAgentGraphRunResult => ({
  ...run,
  ...(run.pendingInput ? { pendingInput: projectPublicPendingInput(run.pendingInput) } : {})
})

export const redactInstalledPackage = (installed: MagicAgentInstalledPackage) => {
  const { sourcePath: _sourcePath, packagePath: _packagePath, ...safeInstalled } = installed
  return safeInstalled
}

const WINDOWS_ABSOLUTE_PATH_FRAGMENT = /[A-Za-z]:[\\/][^\r\n;,'"`)]+/g
const POSIX_ABSOLUTE_PATH_FRAGMENT = /(^|[\s'"`])\/[^\r\n;,'"`)]+/g

export const redactLocalPathFragments = (message: string): string =>
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

export const redactPackageInspection = (
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

export const packageAgentToPlatformAgent = (
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

export const mergeAgentDefinitions = (
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

export const composeSystemPrompt = (
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

export const resolvePackageAgentAllowedToolNames = (
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

export const isPathLikePackageIdentifier = (value: string): boolean =>
  path.isAbsolute(value) ||
  value.includes('/') ||
  value.includes('\\') ||
  value === '.' ||
  value.startsWith('..')

export const assertPackagePathApproved = (
  packageStore: Pick<MagicAgentPackageStore, 'getPackageRoot'>,
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

export const triggerResourceDto = (resource: {
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

export const agentInstanceResourceDto = (resource: {
  id: string
  revision: number
  state: MagicAgentInstanceState
  createdAt: number
  updatedAt: number
}): MagicAgentPlatformAgentInstanceResource => ({
  id: resource.id,
  revision: resource.revision,
  state: resource.state,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt
})

export const runtimeChannelWireResourceDto = (resource: {
  id: string
  revision: number
  state: RuntimeChannelWireState
  createdAt: number
  updatedAt: number
}) => ({
  id: resource.id,
  revision: resource.revision,
  state: resource.state,
  createdAt: resource.createdAt,
  updatedAt: resource.updatedAt
})

export const runtimeChannelResourceDto = (resource: {
  id: string
  revision: number
  state: RuntimeChannelState
  createdAt: number
  updatedAt: number
}) => ({
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

export const driveResourceDto = triggerResourceDto
