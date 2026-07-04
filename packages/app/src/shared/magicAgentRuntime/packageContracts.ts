import type { MagicAgentGraphDefinition } from '../magicAgent/graphTypes'

export const MAGIC_AGENT_PACKAGE_MANIFEST_FILE = 'magicpot-package.json'

export const MAGIC_AGENT_PACKAGE_MANIFEST_VERSION = 1

export const MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION = 1

export const MAGIC_AGENT_PACKAGE_ID_PATTERN = /^(?!.*\.\.)[a-z0-9][a-z0-9._-]{0,63}$/

export const MAGIC_AGENT_PACKAGE_NAME_MAX_LENGTH = 120

export const MAGIC_AGENT_PACKAGE_DESCRIPTION_MAX_LENGTH = 2000

export const MAGIC_AGENT_PACKAGE_AGENT_SYSTEM_PROMPT_MAX_LENGTH = 12000

export const MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_COUNT = 32

export const MAGIC_AGENT_PACKAGE_AGENT_TOOL_NAME_MAX_LENGTH = 128

export const MAGIC_AGENT_PACKAGE_AGENT_MAX_TOOL_ITERATIONS = 16

export const MAGIC_AGENT_PACKAGE_AGENT_PROFILE_ID_MAX_LENGTH = 128

export const MAGIC_AGENT_PACKAGE_AGENT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const MAGIC_AGENT_PACKAGE_EXECUTABLE_CONTRIBUTION_KINDS = [
  'tool',
  'trigger',
  'plugin'
] as const

export const MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS = [
  'agent',
  ...MAGIC_AGENT_PACKAGE_EXECUTABLE_CONTRIBUTION_KINDS,
  'graph'
] as const

export type MagicAgentPackageContributionKind =
  (typeof MAGIC_AGENT_PACKAGE_CONTRIBUTION_KINDS)[number]

export type MagicAgentPackageExecutableContributionKind =
  (typeof MAGIC_AGENT_PACKAGE_EXECUTABLE_CONTRIBUTION_KINDS)[number]

export type MagicAgentPackageContribution = {
  id: string
  kind: MagicAgentPackageContributionKind
  title?: string
  description?: string
  entry?: string
  config?: Record<string, unknown>
}

export type MagicAgentPackageAgentSpec = {
  schemaVersion: typeof MAGIC_AGENT_PACKAGE_AGENT_SPEC_VERSION
  name: string
  description?: string
  systemPrompt?: string
  toolNames?: string[] | null
  maxToolIterations?: number
  profileId?: string
}

export type MagicAgentPackageAgentDefinition = {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  toolNames?: string[] | null
  maxToolIterations?: number
  profileId?: string
  sourcePackageId: string
  sourcePackageName: string
  sourcePackageVersion: string
  contributionId: string
  contributionTitle?: string
}

export type MagicAgentPackageGraphDefinition = MagicAgentGraphDefinition & {
  sourcePackageId: string
  sourcePackageName: string
  sourcePackageVersion: string
  contributionId: string
  contributionTitle?: string
  runnable: false
  unavailableReason: string
}

export type MagicAgentPackageManifest = {
  manifestVersion: typeof MAGIC_AGENT_PACKAGE_MANIFEST_VERSION
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  license?: string
  compatibleAppVersions?: string
  keywords?: string[]
  contributions?: MagicAgentPackageContribution[]
}

export type MagicAgentPackageValidationIssue = {
  path: string
  message: string
}

export type MagicAgentPackageValidationResult =
  | {
      ok: true
      manifest: MagicAgentPackageManifest
      warnings: MagicAgentPackageValidationIssue[]
    }
  | {
      ok: false
      errors: MagicAgentPackageValidationIssue[]
      warnings: MagicAgentPackageValidationIssue[]
    }

export type MagicAgentPackageInstallSource = {
  packageDir: string
}

export type MagicAgentInstalledPackage = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  installedAt: string
  sourcePath: string
  packagePath: string
  manifest: MagicAgentPackageManifest
}

export type MagicAgentPackageInspection = {
  manifestPath: string
  packagePath: string
  validation: MagicAgentPackageValidationResult
  installed?: MagicAgentInstalledPackage
}

export type MagicAgentPackageListEntry = MagicAgentInstalledPackage

export type MagicAgentPackageInstallResult = {
  installed: MagicAgentInstalledPackage
  replaced: boolean
}
