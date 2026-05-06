import type { GetMcpStatusResp } from '@shared/api/svcState'
import type { Config, McpExternalServerConfig } from '@shared/config/config'
import type { CustomSkill } from '@shared/config/config'
import {
  MAGICPOT_CHAT_APPS_RESOURCE_URI,
  MAGICPOT_CHAT_TOOLS_RESOURCE_URI,
  MAGICPOT_APP_CATALOG_SCHEMA_VERSION,
  MAGICPOT_CORE_APP_ID,
  MAGICPOT_CORE_TOOL_DESCRIPTORS,
  MAGICPOT_CUSTOM_SKILL_APP_ID_PREFIX,
  QUICK_APP_IMAGE_INTERROGATION_APP_ID,
  QUICK_APP_PROMPT_TRANSLATION_APP_ID,
  type MagicPotAppCatalogSnapshot,
  type MagicPotAppDefinition
} from './types'

export { QUICK_APP_IMAGE_INTERROGATION_APP_ID, QUICK_APP_PROMPT_TRANSLATION_APP_ID } from './types'

export type MagicPotAppDiscoverySnapshot = {
  id: string
  name: string
  enabled: boolean
  status: MagicPotAppDefinition['status']
  transport: MagicPotAppDefinition['transport']
  source: MagicPotAppDefinition['source']
  toolNames: string[]
  resourceUris: string[]
  discovery: NonNullable<MagicPotAppDefinition['discovery']>
}

const buildCustomSkillDiscovery = (
  skill: CustomSkill
): NonNullable<MagicPotAppDefinition['discovery']> => ({
  transport: {
    kind: 'local',
    mode: 'runtime'
  },
  auth: {
    kind: 'none',
    configured: false
  },
  state: {
    enabled: true,
    status: 'ready'
  },
  config: {
    kind: 'customSkill',
    skillId: skill.id
  }
})

const buildCoreAppDiscovery = (): NonNullable<MagicPotAppDefinition['discovery']> => ({
  transport: {
    kind: 'local',
    mode: 'builtin'
  },
  auth: {
    kind: 'none',
    configured: false
  },
  state: {
    enabled: true,
    status: 'ready'
  },
  config: {
    kind: 'core'
  }
})

const buildQAppDiscovery = (
  key: 'imageInterrogation' | 'promptTranslation',
  profileId?: string
): NonNullable<MagicPotAppDefinition['discovery']> => ({
  transport: {
    kind: 'qapp',
    mode: 'builtin'
  },
  auth: {
    kind: 'none',
    configured: false
  },
  state: {
    enabled: true,
    status: 'ready'
  },
  config: {
    kind: 'qapp',
    key,
    ...(profileId ? { profileId } : {})
  }
})

const buildMcpDiscovery = (
  server: McpExternalServerConfig
): NonNullable<MagicPotAppDefinition['discovery']> => ({
  transport: {
    kind: 'mcp',
    mode: server.command || server.url ? 'configured' : 'builtin',
    ...(server.url ? { endpoint: server.url } : {}),
    ...(server.command ? { command: server.command } : {}),
    ...(server.toolPrefix ? { toolPrefix: server.toolPrefix } : {})
  },
  auth: {
    kind: server.headers && Object.keys(server.headers).length > 0 ? 'header' : 'none',
    configured: Boolean(server.headers && Object.keys(server.headers).length > 0),
    labels: server.headers ? Object.keys(server.headers) : [],
    source: server.url ? 'remote' : 'local'
  },
  state: {
    enabled: server.enabled,
    status: server.enabled ? 'ready' : 'disabled'
  },
  config: {
    kind: 'mcpClientServer',
    serverId: server.id
  }
})

const buildMcpClientApp = (server: McpExternalServerConfig): MagicPotAppDefinition => ({
  id: `mcp.${server.id}`,
  name: server.id,
  description:
    server.transport === 'streamable-http'
      ? 'External MCP application exposed over HTTP.'
      : 'External MCP application exposed over stdio.',
  enabled: server.enabled,
  status: server.enabled ? 'ready' : 'disabled',
  transport: 'mcp',
  source: 'mcp-client',
  configRef: {
    kind: 'mcpClientServer',
    serverId: server.id
  },
  capabilities: {
    tools: [],
    resources: []
  },
  metadata: {
    transport: server.transport,
    toolPrefix: server.toolPrefix || '',
    ...(server.command ? { command: server.command } : {}),
    ...(server.url ? { url: server.url } : {})
  },
  discovery: buildMcpDiscovery(server)
})

const buildCustomSkillApp = (skill: CustomSkill): MagicPotAppDefinition => ({
  id: `${MAGICPOT_CUSTOM_SKILL_APP_ID_PREFIX}.${skill.id}`,
  name: skill.skillName?.trim() || skill.id,
  description: skill.description?.trim() || 'User-authored custom skill.',
  enabled: true,
  status: 'ready',
  transport: 'local',
  source: 'custom-skill',
  configRef: {
    kind: 'customSkill',
    skillId: skill.id
  },
  capabilities: {
    tools: [],
    resources: [
      { uri: `magicpot://custom-skills/${skill.id}` },
      { uri: `magicpot://custom-skills/${skill.id}/instructions` },
      { uri: `magicpot://custom-skills/${skill.id}/bindings` }
    ]
  },
  discovery: buildCustomSkillDiscovery(skill),
  metadata: {
    skillId: skill.id,
    category: skill.category?.trim() || '',
    type: skill.type,
    version: skill.version,
    builtinOrigin: skill.builtinOrigin,
    bindingCount: skill.bindings?.length || 0,
    resourceCount: skill.resources?.length || 0,
    scriptCount: skill.scripts?.length || 0,
    hasInstructions: Boolean(skill.instructions?.systemPrompt || skill.instructions?.userPrompt)
  }
})

export const buildMagicPotAppCatalog = (
  config: Config | null | undefined
): MagicPotAppDefinition[] => {
  if (!config) {
    return []
  }

  const magicPotCore: MagicPotAppDefinition = {
    id: MAGICPOT_CORE_APP_ID,
    name: 'MagicPot Core',
    description: 'Built-in chat runtime capabilities provided by MagicPot itself.',
    enabled: true,
    status: 'ready',
    transport: 'local',
    source: 'magicpot-core',
    configRef: {
      kind: 'core'
    },
    capabilities: {
      resources: [
        { uri: MAGICPOT_CHAT_APPS_RESOURCE_URI },
        { uri: MAGICPOT_CHAT_TOOLS_RESOURCE_URI },
        { uri: 'magicpot://mcp/status' }
      ],
      tools: [...MAGICPOT_CORE_TOOL_DESCRIPTORS]
    },
    discovery: buildCoreAppDiscovery()
  }

  const qappImageInterrogation: MagicPotAppDefinition = {
    id: QUICK_APP_IMAGE_INTERROGATION_APP_ID,
    name: 'Quick App Image Interrogation',
    description: 'Reuses the Quick App image interrogation prompt and vision-model defaults.',
    enabled: config.plugin_config?.useImageInterrogation ?? config.llm_config.useImageInterrogation,
    status:
      (config.plugin_config?.useImageInterrogation ?? config.llm_config.useImageInterrogation)
        ? 'ready'
        : 'disabled',
    transport: 'qapp',
    source: 'builtin',
    configRef: {
      kind: 'qapp',
      key: 'imageInterrogation'
    },
    capabilities: {
      resources: [
        { uri: 'qapp.imageInterrogation.systemPrompt' },
        { uri: 'qapp.imageInterrogation.userPrompt' }
      ],
      tools: []
    },
    metadata: {
      profileId:
        config.plugin_config?.imageInterrogationProfileId ??
        config.llm_config.imageInterrogationProfileId
    },
    discovery: buildQAppDiscovery(
      'imageInterrogation',
      config.plugin_config?.imageInterrogationProfileId ??
        config.llm_config.imageInterrogationProfileId
    )
  }

  const qappPromptTranslation: MagicPotAppDefinition = {
    id: QUICK_APP_PROMPT_TRANSLATION_APP_ID,
    name: 'Quick App Prompt Translation',
    description: 'Reuses the Quick App prompt translation prompt and model defaults.',
    enabled: config.plugin_config?.usePromptTranslation ?? config.llm_config.usePromptTranslation,
    status:
      (config.plugin_config?.usePromptTranslation ?? config.llm_config.usePromptTranslation)
        ? 'ready'
        : 'disabled',
    transport: 'qapp',
    source: 'builtin',
    configRef: {
      kind: 'qapp',
      key: 'promptTranslation'
    },
    capabilities: {
      resources: [
        { uri: 'qapp.promptTranslation.systemPrompt' },
        { uri: 'qapp.promptTranslation.userPrompt' }
      ],
      tools: []
    },
    metadata: {
      profileId:
        config.plugin_config?.promptTranslationProfileId ??
        config.llm_config.promptTranslationProfileId
    },
    discovery: buildQAppDiscovery(
      'promptTranslation',
      config.plugin_config?.promptTranslationProfileId ??
        config.llm_config.promptTranslationProfileId
    )
  }

  const mcpApps = (config.mcp_config?.client?.servers || []).map(buildMcpClientApp)

  return [magicPotCore, qappImageInterrogation, qappPromptTranslation, ...mcpApps]
}

export const buildCustomSkillAppCatalog = (
  customSkills: CustomSkill[] | null | undefined
): MagicPotAppDefinition[] => (customSkills || []).map(buildCustomSkillApp)

export const buildUnifiedMagicPotAppCatalog = (
  config: Config | null | undefined,
  customSkills?: CustomSkill[] | null,
  runtimeStatus?: GetMcpStatusResp | null
): MagicPotAppDefinition[] =>
  enrichMagicPotAppCatalogWithRuntime(
    [
      ...buildMagicPotAppCatalog(config),
      ...buildCustomSkillAppCatalog(customSkills ?? config?.llm_config?.customSkills)
    ],
    runtimeStatus
  )

export const buildMagicPotAppCatalogSnapshot = (
  config: Config | null | undefined,
  options: {
    customSkills?: CustomSkill[] | null
    runtimeStatus?: GetMcpStatusResp | null
    generatedAt?: string
  } = {}
): MagicPotAppCatalogSnapshot => ({
  schemaVersion: MAGICPOT_APP_CATALOG_SCHEMA_VERSION,
  generatedAt: options.generatedAt || new Date().toISOString(),
  apps: buildUnifiedMagicPotAppCatalog(config, options.customSkills, options.runtimeStatus)
})

export const enrichMagicPotAppCatalogWithRuntime = (
  apps: MagicPotAppDefinition[],
  runtimeStatus: GetMcpStatusResp | null | undefined
): MagicPotAppDefinition[] => {
  if (!runtimeStatus) {
    return apps
  }

  const runtimeByServerId = new Map(
    runtimeStatus.client.connections.map((connection) => [connection.id, connection])
  )

  return apps.map((app): MagicPotAppDefinition => {
    const configRef = app.configRef
    if (configRef?.kind !== 'mcpClientServer') {
      return app
    }

    const runtimeConnection = runtimeByServerId.get(configRef.serverId)
    if (!runtimeConnection) {
      return app
    }

    return {
      ...app,
      status: runtimeConnection.status === 'connected' ? 'ready' : runtimeConnection.status,
      capabilities: {
        ...app.capabilities,
        tools:
          runtimeConnection.toolAliases.length > 0
            ? runtimeConnection.toolAliases.map((toolName) => ({ name: toolName }))
            : app.capabilities.tools
      },
      metadata: {
        ...(app.metadata || {}),
        aliasPrefix: runtimeConnection.aliasPrefix,
        toolCount: runtimeConnection.toolCount,
        ...(runtimeConnection.lastError ? { lastError: runtimeConnection.lastError } : {})
      }
    }
  })
}

export const findMagicPotAppById = (
  apps: MagicPotAppDefinition[],
  appId: string | null | undefined
): MagicPotAppDefinition | null => {
  if (!appId) return null
  return apps.find((app) => app.id === appId) || null
}

export const getMagicPotAppDiscoverySnapshot = (
  app: MagicPotAppDefinition
): MagicPotAppDiscoverySnapshot => ({
  id: app.id,
  name: app.name,
  enabled: app.enabled,
  status: app.discovery?.state.status ?? app.status,
  transport: app.discovery?.transport.kind ?? app.transport,
  source: app.source,
  toolNames: app.capabilities.tools.map((tool) => tool.name),
  resourceUris: app.capabilities.resources.map((resource) => resource.uri),
  discovery: app.discovery ?? {
    transport: {
      kind: app.transport
    },
    auth: {
      kind: 'unknown',
      configured: false
    },
    state: {
      enabled: app.enabled,
      status: app.status
    }
  }
})

export const listMagicPotAppsByTransport = (
  apps: MagicPotAppDefinition[],
  transport: MagicPotAppDefinition['transport']
): MagicPotAppDefinition[] => apps.filter((app) => app.transport === transport)

export const listMagicPotAppsBySource = (
  apps: MagicPotAppDefinition[],
  source: MagicPotAppDefinition['source']
): MagicPotAppDefinition[] => apps.filter((app) => app.source === source)

export const listMagicPotAppCapabilityNames = (app: MagicPotAppDefinition): string[] => [
  ...app.capabilities.tools.map((tool) => tool.name),
  ...app.capabilities.resources.map((resource) => resource.uri)
]
