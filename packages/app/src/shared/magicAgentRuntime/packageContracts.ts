export const MAGIC_AGENT_PACKAGE_MANIFEST_FILE = 'magicpot-package.json'

export const MAGIC_AGENT_PACKAGE_MANIFEST_VERSION = 1

export const MAGIC_AGENT_PACKAGE_ID_PATTERN = /^(?!.*\.\.)[a-z0-9][a-z0-9._-]{0,63}$/

export const MAGIC_AGENT_PACKAGE_NAME_MAX_LENGTH = 120

export const MAGIC_AGENT_PACKAGE_DESCRIPTION_MAX_LENGTH = 2000

export type MagicAgentPackageContribution = {
  id: string
  kind: string
  title?: string
  description?: string
  entry?: string
  config?: Record<string, unknown>
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
