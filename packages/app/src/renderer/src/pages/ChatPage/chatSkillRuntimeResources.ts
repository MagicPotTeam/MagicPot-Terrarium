import type { GetMcpStatusResp } from '@shared/api/svcState'
import type { Config } from '@shared/config/config'
import { MAGICPOT_CHAT_TOOLS_RESOURCE_URI, type MagicPotAppDefinition } from '@shared/app/types'
import { api } from '@renderer/utils/windowUtils'
import { getQAppPromptSettings } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/qAppPromptSettings'
import type { SkillRuntimeSpec } from './chatSkillRuntime'

export type ResolvedSkillRuntimeResource = {
  key: string
  title: string
  content: string
  source: 'skill' | 'binding'
  status: 'resolved' | 'missing' | 'failed'
  resolutionKind: 'file' | 'qapp-setting' | 'runtime-app-catalog' | 'runtime-mcp-status'
  resolutionDetails: string
}

type ResolvedResourceText = {
  content: string
  resolutionKind: ResolvedSkillRuntimeResource['resolutionKind']
  resolutionDetails: string
}

const isChatToolCatalogResource = (uri: string): boolean => uri === MAGICPOT_CHAT_TOOLS_RESOURCE_URI

type ResolveSkillRuntimeResourceEntriesInput = {
  runtime: SkillRuntimeSpec
  config?: Config | null
  runtimeApps?: MagicPotAppDefinition[]
  runtimeMcpStatus?: GetMcpStatusResp | null
  readTextFile?: (fullPath: string) => Promise<string>
}

const buildBoundToolCatalogLines = (runtime: SkillRuntimeSpec): string[] =>
  runtime.boundBindings
    .flatMap((binding) =>
      binding.app.capabilities.tools
        .filter((tool) => binding.toolNames.includes(tool.name))
        .map(
          (tool) =>
            `${binding.app.name} (${binding.app.id}): ${tool.name}${
              tool.description ? ` - ${tool.description}` : ''
            }`
        )
    )
    .sort((left, right) => left.localeCompare(right))

const readTextFileViaApi = async (fullPath: string): Promise<string> => {
  const response = await api().svcFs.readTextFile({ fullPath })
  return response.content
}

const resolveResourceTextByUri = (
  uri: string,
  runtime: SkillRuntimeSpec,
  config?: Config | null,
  runtimeApps?: MagicPotAppDefinition[],
  runtimeMcpStatus?: GetMcpStatusResp | null
): ResolvedResourceText | null => {
  if (!config) {
    return null
  }

  const qappPromptSettings = getQAppPromptSettings(config)

  switch (uri) {
    case 'qapp.imageInterrogation.systemPrompt':
      return qappPromptSettings.imageInterrogationSystemPrompt?.trim()
        ? {
            content: qappPromptSettings.imageInterrogationSystemPrompt.trim(),
            resolutionKind: 'qapp-setting',
            resolutionDetails: 'qapp.imageInterrogation.systemPrompt'
          }
        : null
    case 'qapp.imageInterrogation.userPrompt':
      return qappPromptSettings.imageInterrogationUserPrompt?.trim()
        ? {
            content: qappPromptSettings.imageInterrogationUserPrompt.trim(),
            resolutionKind: 'qapp-setting',
            resolutionDetails: 'qapp.imageInterrogation.userPrompt'
          }
        : null
    case 'qapp.promptTranslation.systemPrompt':
      return qappPromptSettings.promptTranslationSystemPrompt?.trim()
        ? {
            content: qappPromptSettings.promptTranslationSystemPrompt.trim(),
            resolutionKind: 'qapp-setting',
            resolutionDetails: 'qapp.promptTranslation.systemPrompt'
          }
        : null
    case 'qapp.promptTranslation.userPrompt':
      return qappPromptSettings.promptTranslationUserPrompt?.trim()
        ? {
            content: qappPromptSettings.promptTranslationUserPrompt.trim(),
            resolutionKind: 'qapp-setting',
            resolutionDetails: 'qapp.promptTranslation.userPrompt'
          }
        : null
    case MAGICPOT_CHAT_TOOLS_RESOURCE_URI: {
      const toolLines = buildBoundToolCatalogLines(runtime)
      return toolLines.length > 0
        ? {
            content: toolLines.join('\n'),
            resolutionKind: 'runtime-app-catalog',
            resolutionDetails: `boundApps=${runtime.boundBindings.length}; boundTools=${toolLines.length}`
          }
        : null
    }
    case 'magicpot://mcp/status': {
      const boundMcpServerIds = new Set(
        runtime.boundBindings
          .filter((binding) => binding.resourceUris.includes('magicpot://mcp/status'))
          .map((binding) => binding.app.configRef)
          .filter(
            (
              configRef
            ): configRef is Extract<
              (typeof runtime.boundBindings)[number]['app']['configRef'],
              { kind: 'mcpClientServer' }
            > => configRef?.kind === 'mcpClientServer'
          )
          .map((configRef) => configRef.serverId)
      )

      if (boundMcpServerIds.size === 0) {
        return null
      }

      if (!runtimeMcpStatus) {
        return {
          content: 'MCP runtime status is unavailable.',
          resolutionKind: 'runtime-mcp-status',
          resolutionDetails: 'MCP status unavailable'
        }
      }
      const lines = runtimeMcpStatus.client.connections
        .filter((connection) => boundMcpServerIds.has(connection.id))
        .map((connection) => {
          const toolInfo =
            connection.toolAliases.length > 0
              ? `tools=${connection.toolAliases.join(', ')}`
              : `toolCount=${connection.toolCount}`
          return `${connection.id}: status=${connection.status}; prefix=${connection.aliasPrefix}; ${toolInfo}`
        })
      if (lines.length === 0) {
        return null
      }
      return {
        content: lines.join('\n'),
        resolutionKind: 'runtime-mcp-status',
        resolutionDetails: `connections=${lines.length}`
      }
    }
    default:
      return null
  }
}

const isUriLikeResource = (value: string): boolean =>
  value.includes('://') || value.startsWith('qapp.')

const resolveResourceKindByUri = (uri: string): ResolvedSkillRuntimeResource['resolutionKind'] => {
  if (isChatToolCatalogResource(uri)) {
    return 'runtime-app-catalog'
  }

  switch (uri) {
    case 'magicpot://mcp/status':
      return 'runtime-mcp-status'
    default:
      return 'qapp-setting'
  }
}

const buildResourceTitle = (resource: string): string => {
  if (resource.startsWith('qapp.')) {
    return resource
  }

  if (resource.includes('://')) {
    return resource
  }

  const normalized = resource.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

export const resolveSkillRuntimeResourceEntries = async (
  input: ResolveSkillRuntimeResourceEntriesInput
): Promise<ResolvedSkillRuntimeResource[]> => {
  const readTextFile = input.readTextFile || readTextFileViaApi
  const pendingEntries: Array<{ resource: string; source: 'skill' | 'binding' }> = [
    ...input.runtime.resources.map((resource) => ({ resource, source: 'skill' as const })),
    ...input.runtime.boundBindings.flatMap((binding) =>
      binding.resourceUris.map((resource) => ({ resource, source: 'binding' as const }))
    )
  ]
  const seen = new Set<string>()
  const resolvedEntries: ResolvedSkillRuntimeResource[] = []

  for (const entry of pendingEntries) {
    const resourceKey = `${entry.source}:${entry.resource}`
    if (seen.has(resourceKey)) {
      continue
    }
    seen.add(resourceKey)

    try {
      const resolved = isUriLikeResource(entry.resource)
        ? resolveResourceTextByUri(
            entry.resource,
            input.runtime,
            input.config,
            input.runtimeApps,
            input.runtimeMcpStatus
          )
        : {
            content: await readTextFile(entry.resource),
            resolutionKind: 'file' as const,
            resolutionDetails: 'read from file system'
          }

      if (!resolved) {
        resolvedEntries.push({
          key: entry.resource,
          title: buildResourceTitle(entry.resource),
          content: '',
          source: entry.source,
          status: 'missing',
          resolutionKind: isUriLikeResource(entry.resource)
            ? resolveResourceKindByUri(entry.resource)
            : 'file',
          resolutionDetails: 'No content was available for this resource.'
        })
        continue
      }

      const normalizedContent = resolved.content.trim()
      if (!normalizedContent) {
        resolvedEntries.push({
          key: entry.resource,
          title: buildResourceTitle(entry.resource),
          content: '',
          source: entry.source,
          status: 'missing',
          resolutionKind: resolved.resolutionKind,
          resolutionDetails: resolved.resolutionDetails || 'Resolved content was empty.'
        })
        continue
      }

      resolvedEntries.push({
        key: entry.resource,
        title: buildResourceTitle(entry.resource),
        content: normalizedContent,
        source: entry.source,
        status: 'resolved',
        resolutionKind: resolved.resolutionKind,
        resolutionDetails: resolved.resolutionDetails
      })
    } catch (error) {
      console.warn('[ChatPage] Failed to resolve skill runtime resource:', entry.resource, error)
      resolvedEntries.push({
        key: entry.resource,
        title: buildResourceTitle(entry.resource),
        content: '',
        source: entry.source,
        status: 'failed',
        resolutionKind: isUriLikeResource(entry.resource)
          ? resolveResourceKindByUri(entry.resource)
          : 'file',
        resolutionDetails: error instanceof Error ? error.message : String(error || 'Unknown error')
      })
    }
  }

  return resolvedEntries
}

export const buildSkillRuntimeResourceContext = (
  resources: ResolvedSkillRuntimeResource[]
): string | undefined => {
  if (resources.length === 0) {
    return undefined
  }

  const resolvedCount = resources.filter((resource) => resource.status === 'resolved').length
  const missingCount = resources.filter((resource) => resource.status === 'missing').length
  const failedCount = resources.filter((resource) => resource.status === 'failed').length

  return [
    `Loaded skill resources (resolved=${resolvedCount}, missing=${missingCount}, failed=${failedCount}):`,
    ...resources.map((resource) => {
      const header = `--- ${resource.title} [${resource.source}; ${resource.resolutionKind}; ${resource.status}] ---`
      const details = `meta: key=${resource.key}; ${resource.resolutionDetails}`
      return resource.status === 'resolved'
        ? `${header}\n${details}\n${resource.content}`
        : `${header}\n${details}`
    })
  ].join('\n')
}
