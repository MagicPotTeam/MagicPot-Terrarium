import {
  MAGIC_AGENT_CONTRACT_VERSION,
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
import { normalizeMagicAgentSpec, validateMagicAgentSpec, type AgentSpec } from './spec'

export const MAGIC_AGENT_PACKAGE_MAGIC = 'MAGICPOT_MAGIC_AGENT'
export const MAGIC_AGENT_PACKAGE_VERSION = 1

export type MagicAgentPackageManifest = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  license?: string
  keywords: string[]
  compatibleAppVersions?: string
  metadata?: MagicAgentRecord
}

export type MagicAgentPackage = {
  magic: typeof MAGIC_AGENT_PACKAGE_MAGIC
  packageVersion: number
  contractVersion: number
  createdAt: string
  manifest: MagicAgentPackageManifest
  agent: AgentSpec
  assets?: MagicAgentRecord
  metadata?: MagicAgentRecord
}

export const normalizeMagicAgentPackageManifest = (
  manifest: Partial<MagicAgentPackageManifest> & MagicAgentRecord,
  fallback?: Partial<AgentSpec>
): MagicAgentPackageManifest => {
  const id = normalizeMagicAgentId(manifest.id || fallback?.id, 'agent')
  const name =
    normalizeMagicAgentOptionalText(manifest.name) ||
    normalizeMagicAgentOptionalText(fallback?.title) ||
    id

  return {
    id,
    name,
    version: normalizeMagicAgentVersion(manifest.version || fallback?.version),
    keywords: [...new Set(normalizeMagicAgentStringArray(manifest.keywords))],
    ...(normalizeMagicAgentOptionalText(manifest.description || fallback?.description)
      ? {
          description: normalizeMagicAgentOptionalText(
            manifest.description || fallback?.description
          )
        }
      : {}),
    ...(normalizeMagicAgentOptionalText(manifest.author)
      ? { author: normalizeMagicAgentOptionalText(manifest.author) }
      : {}),
    ...(normalizeMagicAgentOptionalText(manifest.license)
      ? { license: normalizeMagicAgentOptionalText(manifest.license) }
      : {}),
    ...(normalizeMagicAgentOptionalText(manifest.compatibleAppVersions)
      ? { compatibleAppVersions: normalizeMagicAgentOptionalText(manifest.compatibleAppVersions) }
      : {}),
    ...(normalizeMagicAgentRecord(manifest.metadata)
      ? { metadata: normalizeMagicAgentRecord(manifest.metadata) }
      : {})
  }
}

export const normalizeMagicAgentPackage = (
  pkg: Partial<MagicAgentPackage> & MagicAgentRecord
): MagicAgentPackage => {
  const rawAgent = isPlainRecord(pkg.agent) ? pkg.agent : {}
  const agent = normalizeMagicAgentSpec(rawAgent as Partial<AgentSpec> & MagicAgentRecord)
  const rawManifest = isPlainRecord(pkg.manifest) ? pkg.manifest : {}

  return {
    magic: MAGIC_AGENT_PACKAGE_MAGIC,
    packageVersion: Number.isFinite(Number(pkg.packageVersion))
      ? Math.max(1, Math.trunc(Number(pkg.packageVersion)))
      : MAGIC_AGENT_PACKAGE_VERSION,
    contractVersion: Number.isFinite(Number(pkg.contractVersion))
      ? Math.max(1, Math.trunc(Number(pkg.contractVersion)))
      : MAGIC_AGENT_CONTRACT_VERSION,
    createdAt: normalizeMagicAgentOptionalText(pkg.createdAt) || new Date().toISOString(),
    manifest: normalizeMagicAgentPackageManifest(
      rawManifest as Partial<MagicAgentPackageManifest> & MagicAgentRecord,
      agent
    ),
    agent,
    ...(normalizeMagicAgentRecord(pkg.assets)
      ? { assets: normalizeMagicAgentRecord(pkg.assets) }
      : {}),
    ...(normalizeMagicAgentRecord(pkg.metadata)
      ? { metadata: normalizeMagicAgentRecord(pkg.metadata) }
      : {})
  }
}

export const validateMagicAgentPackageManifest = (
  value: unknown
): MagicAgentValidationResult<MagicAgentPackageManifest> => {
  const issues: MagicAgentValidationIssue[] = []
  const manifest = validateMagicAgentRecord(value, 'manifest', issues, 'manifest')
  validateMagicAgentRequiredText(manifest.id, 'manifest.id', issues, 'manifest id')
  validateMagicAgentRequiredText(manifest.name, 'manifest.name', issues, 'manifest name')

  if (manifest.keywords !== undefined && !Array.isArray(manifest.keywords)) {
    issues.push(makeMagicAgentIssue('manifest.keywords', 'manifest keywords must be an array.'))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentPackageManifest(manifest), issues)
}

export const validateMagicAgentPackage = (
  value: unknown
): MagicAgentValidationResult<MagicAgentPackage> => {
  const issues: MagicAgentValidationIssue[] = []
  const pkg = validateMagicAgentRecord(value, 'package', issues, 'package')

  if (pkg.magic !== MAGIC_AGENT_PACKAGE_MAGIC) {
    issues.push(makeMagicAgentIssue('package.magic', 'package magic is not a MagicAgent package.'))
  }

  if (!isPlainRecord(pkg.manifest)) {
    issues.push(makeMagicAgentIssue('package.manifest', 'package manifest must be an object.'))
  } else {
    const manifestResult = validateMagicAgentPackageManifest(pkg.manifest)
    issues.push(
      ...manifestResult.issues.map((issue) => ({ ...issue, path: `package.${issue.path}` }))
    )
  }

  if (!isPlainRecord(pkg.agent)) {
    issues.push(makeMagicAgentIssue('package.agent', 'package agent must be an object.'))
  } else {
    const agentResult = validateMagicAgentSpec(pkg.agent)
    issues.push(...agentResult.issues.map((issue) => ({ ...issue, path: `package.${issue.path}` })))
  }

  if (pkg.assets !== undefined && !isPlainRecord(pkg.assets)) {
    issues.push(makeMagicAgentIssue('package.assets', 'package assets must be an object.'))
  }

  return createMagicAgentValidationResult(normalizeMagicAgentPackage(pkg), issues)
}

export const createMagicAgentPackage = (params: {
  agent: AgentSpec
  manifest?: Partial<MagicAgentPackageManifest>
  assets?: MagicAgentRecord
  metadata?: MagicAgentRecord
  createdAt?: string
}): MagicAgentPackage =>
  normalizeMagicAgentPackage({
    magic: MAGIC_AGENT_PACKAGE_MAGIC,
    packageVersion: MAGIC_AGENT_PACKAGE_VERSION,
    contractVersion: MAGIC_AGENT_CONTRACT_VERSION,
    createdAt: params.createdAt || new Date().toISOString(),
    manifest: normalizeMagicAgentPackageManifest(
      (params.manifest || {}) as Partial<MagicAgentPackageManifest> & MagicAgentRecord,
      params.agent
    ),
    agent: params.agent,
    ...(params.assets ? { assets: params.assets } : {}),
    ...(params.metadata ? { metadata: params.metadata } : {})
  })
