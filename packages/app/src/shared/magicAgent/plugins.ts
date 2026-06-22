import {
  MAGIC_AGENT_DEFAULT_VERSION,
  createMagicAgentValidationResult,
  isPlainRecord,
  makeMagicAgentIssue,
  normalizeMagicAgentId,
  normalizeMagicAgentOptionalText,
  normalizeMagicAgentRecord,
  normalizeMagicAgentStringArray,
  normalizeMagicAgentVersion,
  validateMagicAgentRecord,
  validateMagicAgentRequiredText,
  type MagicAgentRecord,
  type MagicAgentValidationIssue,
  type MagicAgentValidationResult
} from './common'

export const MAGIC_AGENT_PLUGIN_KINDS = [
  'runtime',
  'tool',
  'ui',
  'memory',
  'model',
  'policy'
] as const

export type MagicAgentPluginKind = (typeof MAGIC_AGENT_PLUGIN_KINDS)[number]

export type MagicAgentPluginSpec = {
  id: string
  kind: MagicAgentPluginKind
  title: string
  version: string
  description?: string
  entry?: string
  permissions: string[]
  config?: MagicAgentRecord
  metadata?: MagicAgentRecord
}

const PLUGIN_KIND_SET = new Set<string>(MAGIC_AGENT_PLUGIN_KINDS)

export const isMagicAgentPluginKind = (value: unknown): value is MagicAgentPluginKind =>
  PLUGIN_KIND_SET.has(String(value || ''))

export const normalizeMagicAgentPluginKind = (value: unknown): MagicAgentPluginKind =>
  isMagicAgentPluginKind(value) ? value : 'runtime'

export const normalizeMagicAgentPluginSpec = (
  plugin: Partial<MagicAgentPluginSpec> & MagicAgentRecord
): MagicAgentPluginSpec => {
  const title =
    normalizeMagicAgentOptionalText(plugin.title) ||
    normalizeMagicAgentOptionalText(plugin.id) ||
    'Plugin'

  return {
    id: normalizeMagicAgentId(plugin.id, 'plugin'),
    kind: normalizeMagicAgentPluginKind(plugin.kind),
    title,
    version: normalizeMagicAgentVersion(plugin.version || MAGIC_AGENT_DEFAULT_VERSION),
    permissions: normalizeMagicAgentStringArray(plugin.permissions),
    ...(normalizeMagicAgentOptionalText(plugin.description)
      ? { description: normalizeMagicAgentOptionalText(plugin.description) }
      : {}),
    ...(normalizeMagicAgentOptionalText(plugin.entry)
      ? { entry: normalizeMagicAgentOptionalText(plugin.entry) }
      : {}),
    ...(normalizeMagicAgentRecord(plugin.config)
      ? { config: normalizeMagicAgentRecord(plugin.config) }
      : {}),
    ...(normalizeMagicAgentRecord(plugin.metadata)
      ? { metadata: normalizeMagicAgentRecord(plugin.metadata) }
      : {})
  }
}

export const validateMagicAgentPluginSpec = (
  value: unknown
): MagicAgentValidationResult<MagicAgentPluginSpec> => {
  const issues: MagicAgentValidationIssue[] = []
  const plugin = validateMagicAgentRecord(value, 'plugin', issues, 'plugin')
  validateMagicAgentRequiredText(plugin.id, 'plugin.id', issues, 'plugin id')
  validateMagicAgentRequiredText(plugin.title, 'plugin.title', issues, 'plugin title')

  if (plugin.kind !== undefined && !isMagicAgentPluginKind(plugin.kind)) {
    issues.push(
      makeMagicAgentIssue('plugin.kind', `Unsupported plugin kind: ${String(plugin.kind)}.`)
    )
  }

  if (plugin.permissions !== undefined && !Array.isArray(plugin.permissions)) {
    issues.push(makeMagicAgentIssue('plugin.permissions', 'plugin permissions must be an array.'))
  }

  if (plugin.config !== undefined && !isPlainRecord(plugin.config)) {
    issues.push(makeMagicAgentIssue('plugin.config', 'plugin config must be an object.'))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentPluginSpec(plugin), issues)
}
