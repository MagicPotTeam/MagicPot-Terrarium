import {
  MAGIC_AGENT_PACKAGE_AGENT_IDENTIFIER_PATTERN,
  MAGIC_AGENT_PACKAGE_AGENT_MAX_TOOL_ITERATIONS,
  MAGIC_AGENT_PACKAGE_AGENT_PROFILE_ID_MAX_LENGTH,
  MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION,
  MAGIC_AGENT_PACKAGE_AGENT_SYSTEM_PROMPT_MAX_LENGTH,
  MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_COUNT,
  MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_LENGTH,
  MAGIC_AGENT_PACKAGE_DESCRIPTION_MAX_LENGTH,
  MAGIC_AGENT_PACKAGE_NAME_MAX_LENGTH,
  type MagicAgentInstalledPackage,
  type MagicAgentPackageAgentDefinition,
  type MagicAgentPackageAgentSpec,
  type MagicAgentPackageValidationIssue
} from '@shared/magicAgentRuntime/packageContracts'

const AGENT_SPEC_KEYS = new Set([
  'schemaVersion',
  'name',
  'description',
  'systemPrompt',
  'toolNames',
  'maxToolIterations',
  'profileId'
])

const TOOL_NAME_PATTERN = MAGIC_AGENT_PACKAGE_AGENT_IDENTIFIER_PATTERN
const PROFILE_ID_PATTERN = MAGIC_AGENT_PACKAGE_AGENT_IDENTIFIER_PATTERN

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const pushIssue = (
  issues: MagicAgentPackageValidationIssue[],
  path: string,
  message: string
): void => {
  issues.push({ path, message })
}

const normalizeOptionalText = (
  value: unknown,
  path: string,
  issues: MagicAgentPackageValidationIssue[],
  options: { maxLength?: number } = {}
): string | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    pushIssue(issues, path, `Expected string at "${path}".`)
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    return undefined
  }
  if (options.maxLength && normalized.length > options.maxLength) {
    pushIssue(issues, path, `Expected "${path}" to be at most ${options.maxLength} characters.`)
    return undefined
  }
  return normalized
}

const normalizeToolNames = (
  value: unknown,
  path: string,
  issues: MagicAgentPackageValidationIssue[]
): string[] | null | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return null
  }
  if (!Array.isArray(value)) {
    pushIssue(issues, path, `Expected "${path}" to be an array of strings or null.`)
    return undefined
  }

  if (value.length > MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_COUNT) {
    pushIssue(
      issues,
      path,
      `Expected "${path}" to contain at most ${MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_COUNT} tool names.`
    )
  }

  const toolNames: string[] = []
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}.${index}`
    const toolName = normalizeOptionalText(item, itemPath, issues)
    if (!toolName) {
      pushIssue(issues, itemPath, 'Expected tool name to be a non-empty string.')
      continue
    }
    if (toolName.length > MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_LENGTH) {
      pushIssue(
        issues,
        itemPath,
        `Expected tool name to be at most ${MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_LENGTH} characters.`
      )
      continue
    }
    if (!TOOL_NAME_PATTERN.test(toolName)) {
      pushIssue(issues, itemPath, 'Expected tool name to match MagicAgent tool name rules.')
      continue
    }
    if (!toolNames.includes(toolName)) {
      toolNames.push(toolName)
    }
  }
  return toolNames
}

export type MagicAgentPackageAgentSpecValidationResult =
  | { ok: true; spec: MagicAgentPackageAgentSpec; warnings: MagicAgentPackageValidationIssue[] }
  | {
      ok: false
      errors: MagicAgentPackageValidationIssue[]
      warnings: MagicAgentPackageValidationIssue[]
    }

export function validateMagicAgentPackageAgentSpec(
  value: unknown
): MagicAgentPackageAgentSpecValidationResult {
  const errors: MagicAgentPackageValidationIssue[] = []
  const warnings: MagicAgentPackageValidationIssue[] = []

  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'Expected agent spec to be a JSON object.' }],
      warnings
    }
  }

  for (const key of Object.keys(value)) {
    if (!AGENT_SPEC_KEYS.has(key)) {
      pushIssue(errors, key, `Unknown agent spec field "${key}".`)
    }
  }

  if (value.schemaVersion !== MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION) {
    pushIssue(
      errors,
      'schemaVersion',
      `Expected schemaVersion to be ${MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION}.`
    )
  }

  const spec: Record<string, unknown> = { schemaVersion: MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION }
  const name = normalizeOptionalText(value.name, 'name', errors, {
    maxLength: MAGIC_AGENT_PACKAGE_NAME_MAX_LENGTH
  })
  if (!name) {
    pushIssue(errors, 'name', 'Expected non-empty string at "name".')
  } else {
    spec.name = name
  }

  const description = normalizeOptionalText(value.description, 'description', errors, {
    maxLength: MAGIC_AGENT_PACKAGE_DESCRIPTION_MAX_LENGTH
  })
  if (description) {
    spec.description = description
  }

  const systemPrompt = normalizeOptionalText(value.systemPrompt, 'systemPrompt', errors, {
    maxLength: MAGIC_AGENT_PACKAGE_AGENT_SYSTEM_PROMPT_MAX_LENGTH
  })
  if (systemPrompt) {
    spec.systemPrompt = systemPrompt
  }

  const toolNames = normalizeToolNames(value.toolNames, 'toolNames', errors)
  if (toolNames !== undefined) {
    spec.toolNames = toolNames
  }

  if (value.maxToolIterations !== undefined) {
    if (
      typeof value.maxToolIterations === 'number' &&
      Number.isInteger(value.maxToolIterations) &&
      Number.isFinite(value.maxToolIterations) &&
      value.maxToolIterations >= 0 &&
      value.maxToolIterations <= MAGIC_AGENT_PACKAGE_AGENT_MAX_TOOL_ITERATIONS
    ) {
      spec.maxToolIterations = value.maxToolIterations
    } else {
      pushIssue(
        errors,
        'maxToolIterations',
        `Expected maxToolIterations to be a non-negative integer no greater than ${MAGIC_AGENT_PACKAGE_AGENT_MAX_TOOL_ITERATIONS}.`
      )
    }
  }

  const profileId = normalizeOptionalText(value.profileId, 'profileId', errors, {
    maxLength: MAGIC_AGENT_PACKAGE_AGENT_PROFILE_ID_MAX_LENGTH
  })
  if (profileId) {
    if (!PROFILE_ID_PATTERN.test(profileId)) {
      pushIssue(errors, 'profileId', 'Expected profileId to match MagicAgent profile id rules.')
    } else {
      spec.profileId = profileId
    }
  }

  return errors.length > 0
    ? { ok: false, errors, warnings }
    : { ok: true, spec: spec as MagicAgentPackageAgentSpec, warnings }
}

export function packageAgentSpecToDefinition(input: {
  installedPackage: MagicAgentInstalledPackage
  contributionId: string
  contributionTitle?: string
  spec: MagicAgentPackageAgentSpec
}): MagicAgentPackageAgentDefinition {
  const { installedPackage, contributionId, contributionTitle, spec } = input
  return {
    id: `package.${installedPackage.id}.${contributionId}`,
    name: spec.name,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.toolNames !== undefined ? { toolNames: spec.toolNames } : {}),
    ...(spec.maxToolIterations !== undefined ? { maxToolIterations: spec.maxToolIterations } : {}),
    ...(spec.profileId ? { profileId: spec.profileId } : {}),
    sourcePackageId: installedPackage.id,
    sourcePackageName: installedPackage.name,
    sourcePackageVersion: installedPackage.version,
    contributionId,
    ...(contributionTitle ? { contributionTitle } : {})
  }
}
