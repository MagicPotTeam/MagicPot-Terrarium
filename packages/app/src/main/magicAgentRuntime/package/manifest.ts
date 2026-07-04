import {
  MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS,
  MAGIC_AGENT_PACKAGE_DESCRIPTION_MAX_LENGTH,
  MAGIC_AGENT_PACKAGE_ID_PATTERN,
  MAGIC_AGENT_PACKAGE_MANIFEST_VERSION,
  MAGIC_AGENT_PACKAGE_NAME_MAX_LENGTH,
  type MagicAgentPackageContribution,
  type MagicAgentPackageContributionKind,
  type MagicAgentPackageManifest,
  type MagicAgentPackageValidationIssue,
  type MagicAgentPackageValidationResult
} from '@shared/magicAgentRuntime/packageContracts'

const SEMVER_LIKE_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const MANIFEST_KEYS = new Set([
  'manifestVersion',
  'id',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'license',
  'compatibleAppVersions',
  'keywords',
  'contributions'
])
const CONTRIBUTION_KEYS = new Set(['id', 'kind', 'title', 'description', 'entry', 'config'])
const CONTRIBUTION_KIND_SET = new Set<string>(MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS)
const WINDOWS_DRIVE_ENTRY_PATTERN = /^[A-Za-z]:[\\/]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOptionalText(
  value: unknown,
  path: string,
  issues: MagicAgentPackageValidationIssue[]
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    pushIssue(issues, path, `Expected string at "${path}".`)
    return undefined
  }

  const normalized = value.trim()
  return normalized ? normalized : undefined
}

function pushIssue(
  issues: MagicAgentPackageValidationIssue[],
  path: string,
  message: string
): void {
  issues.push({ path, message })
}

function readRequiredString(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  issues: MagicAgentPackageValidationIssue[],
  options?: {
    pattern?: RegExp
    maxLength?: number
  }
): void {
  const value = input[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    pushIssue(issues, key, `Expected non-empty string at "${key}".`)
    return
  }

  const normalized = value.trim()
  if (options?.maxLength && normalized.length > options.maxLength) {
    pushIssue(issues, key, `Expected "${key}" to be at most ${options.maxLength} characters.`)
    return
  }

  if (options?.pattern && !options.pattern.test(normalized)) {
    pushIssue(issues, key, `Invalid "${key}" format.`)
    return
  }

  output[key] = normalized
}

function readOptionalString(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  key: string,
  issues: MagicAgentPackageValidationIssue[],
  options?: {
    maxLength?: number
  }
): void {
  if (!(key in input)) {
    return
  }

  const normalized = normalizeOptionalText(input[key], key, issues)
  if (!normalized) {
    return
  }

  if (options?.maxLength && normalized.length > options.maxLength) {
    pushIssue(issues, key, `Expected "${key}" to be at most ${options.maxLength} characters.`)
    return
  }

  output[key] = normalized
}

function normalizeKeywords(
  value: unknown,
  issues: MagicAgentPackageValidationIssue[]
): string[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    pushIssue(issues, 'keywords', 'Expected "keywords" to be an array of strings.')
    return undefined
  }

  const keywords: string[] = []
  for (const [index, item] of value.entries()) {
    const keyword = normalizeOptionalText(item, `keywords.${index}`, issues)
    if (!keyword) {
      pushIssue(issues, `keywords.${index}`, 'Expected keyword to be a non-empty string.')
      continue
    }

    if (!keywords.includes(keyword)) {
      keywords.push(keyword)
    }
  }

  return keywords.length > 0 ? keywords : undefined
}

function normalizeContribution(
  value: unknown,
  index: number,
  issues: MagicAgentPackageValidationIssue[]
): MagicAgentPackageContribution | undefined {
  const path = `contributions.${index}`
  if (!isRecord(value)) {
    pushIssue(issues, path, 'Expected contribution to be an object.')
    return undefined
  }

  for (const key of Object.keys(value)) {
    if (!CONTRIBUTION_KEYS.has(key)) {
      pushIssue(issues, `${path}.${key}`, `Unknown contribution field "${key}".`)
    }
  }

  const contribution: Partial<MagicAgentPackageContribution> = {}

  const id = normalizeOptionalText(value.id, `${path}.id`, issues)
  if (!id || !MAGIC_AGENT_PACKAGE_ID_PATTERN.test(id)) {
    pushIssue(issues, `${path}.id`, 'Expected contribution id to match package id rules.')
  } else {
    contribution.id = id
  }

  const kind = normalizeOptionalText(value.kind, `${path}.kind`, issues)
  if (!kind || !CONTRIBUTION_KIND_SET.has(kind)) {
    pushIssue(
      issues,
      `${path}.kind`,
      `Expected contribution kind to be one of: ${MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS.join(', ')}.`
    )
  } else {
    contribution.kind = kind as MagicAgentPackageContributionKind
  }

  const title = normalizeOptionalText(value.title, `${path}.title`, issues)
  if (title) {
    contribution.title = title
  }

  const description = normalizeOptionalText(value.description, `${path}.description`, issues)
  if (description) {
    contribution.description = description
  }

  const entry = normalizeOptionalText(value.entry, `${path}.entry`, issues)
  if (entry) {
    const normalizedEntry = entry.replace(/\\/g, '/')
    if (
      normalizedEntry.includes('..') ||
      normalizedEntry.startsWith('/') ||
      WINDOWS_DRIVE_ENTRY_PATTERN.test(entry)
    ) {
      pushIssue(issues, `${path}.entry`, 'Contribution entry must be a relative package path.')
    } else {
      contribution.entry = entry
    }
  }

  if (contribution.kind === 'agent' || contribution.kind === 'graph') {
    const contributionLabel = contribution.kind === 'agent' ? 'Agent' : 'Graph'
    if (!contribution.entry) {
      pushIssue(
        issues,
        `${path}.entry`,
        `${contributionLabel} contributions must declare a JSON entry file.`
      )
    } else if (!contribution.entry.toLowerCase().endsWith('.json')) {
      pushIssue(
        issues,
        `${path}.entry`,
        `${contributionLabel} contribution entry must be a JSON file.`
      )
    }
  }

  if (value.config !== undefined) {
    if (isRecord(value.config)) {
      contribution.config = value.config
    } else {
      pushIssue(issues, `${path}.config`, 'Expected contribution config to be an object.')
    }
  }

  return contribution.id && contribution.kind
    ? (contribution as MagicAgentPackageContribution)
    : undefined
}

function normalizeContributions(
  value: unknown,
  issues: MagicAgentPackageValidationIssue[],
  warnings: MagicAgentPackageValidationIssue[]
): MagicAgentPackageContribution[] | undefined {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    pushIssue(issues, 'contributions', 'Expected "contributions" to be an array.')
    return undefined
  }

  const contributions: MagicAgentPackageContribution[] = []
  const contributionIds = new Set<string>()
  for (const [index, item] of value.entries()) {
    const contribution = normalizeContribution(item, index, issues)
    if (!contribution) {
      continue
    }

    if (contributionIds.has(contribution.id)) {
      pushIssue(issues, `contributions.${index}.id`, 'Duplicate contribution id is not allowed.')
      continue
    }

    contributionIds.add(contribution.id)
    contributions.push(contribution)
  }

  return contributions.length > 0 ? contributions : undefined
}

export function validateMagicAgentPackageManifest(
  value: unknown
): MagicAgentPackageValidationResult {
  const errors: MagicAgentPackageValidationIssue[] = []
  const warnings: MagicAgentPackageValidationIssue[] = []

  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'Expected manifest to be a JSON object.' }],
      warnings
    }
  }

  const manifestVersion = value.manifestVersion
  if (manifestVersion !== MAGIC_AGENT_PACKAGE_MANIFEST_VERSION) {
    pushIssue(
      errors,
      'manifestVersion',
      `Expected manifestVersion to be ${MAGIC_AGENT_PACKAGE_MANIFEST_VERSION}.`
    )
  }

  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) {
      pushIssue(errors, key, `Unknown manifest field "${key}".`)
    }
  }

  const manifest: Record<string, unknown> = {
    manifestVersion: MAGIC_AGENT_PACKAGE_MANIFEST_VERSION
  }

  readRequiredString(value, manifest, 'id', errors, {
    pattern: MAGIC_AGENT_PACKAGE_ID_PATTERN
  })
  readRequiredString(value, manifest, 'name', errors, {
    maxLength: MAGIC_AGENT_PACKAGE_NAME_MAX_LENGTH
  })
  readRequiredString(value, manifest, 'version', errors, {
    pattern: SEMVER_LIKE_PATTERN
  })
  readOptionalString(value, manifest, 'description', errors, {
    maxLength: MAGIC_AGENT_PACKAGE_DESCRIPTION_MAX_LENGTH
  })
  readOptionalString(value, manifest, 'author', errors)
  readOptionalString(value, manifest, 'homepage', errors)
  readOptionalString(value, manifest, 'license', errors)
  readOptionalString(value, manifest, 'compatibleAppVersions', errors)

  const keywords = normalizeKeywords(value.keywords, errors)
  if (keywords) {
    manifest.keywords = keywords
  }

  const contributions = normalizeContributions(value.contributions, errors, warnings)
  if (contributions) {
    manifest.contributions = contributions
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings }
  }

  return {
    ok: true,
    manifest: manifest as MagicAgentPackageManifest,
    warnings
  }
}
