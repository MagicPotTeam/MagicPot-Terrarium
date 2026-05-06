import type { Workflow } from '@shared/comfy/types'
import type { QAppCfg } from './cfgTypes'
import { normalizeQAppCategory, type QAppCategory } from './category'

export const QAPP_PACKAGE_MAGIC = 'MAGICPOT_QAPP'
export const QAPP_PACKAGE_VERSION = 2

export type QAppManifest = {
  name: string
  version: string
  author?: string
  description?: string
  category?: QAppCategory
  source?: string
  compatibleAppVersions?: string
}

export type QAppPackageFile = {
  magic: typeof QAPP_PACKAGE_MAGIC
  version: number
  name?: string
  createdAt?: string
  manifest?: Partial<QAppManifest> | null
  cfg: QAppCfg
  workflow: Workflow
}

export type ParsedQAppPackage = {
  packageVersion: number
  keyName: string
  exportedAt?: string
  manifest: QAppManifest
  cfg: QAppCfg
  workflow: Workflow
}

type QAppManifestDefaults = {
  name: string
  appVersion: string
  source?: string
  compatibleAppVersions?: string
}

const normalizeText = (value: unknown): string => String(value ?? '').trim()

const parseVersion = (value: string): number[] =>
  normalizeText(value)
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment))

export const compareAppVersions = (left: string, right: string): number => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  const maxLength = Math.max(a.length, b.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = a[index] ?? 0
    const rightPart = b[index] ?? 0
    if (leftPart === rightPart) continue
    return leftPart > rightPart ? 1 : -1
  }

  return 0
}

const satisfiesSingleConstraint = (currentVersion: string, constraint: string): boolean => {
  const normalized = normalizeText(constraint)
  if (!normalized || normalized === '*') return true

  if (normalized.startsWith('^')) {
    const baseVersion = normalized.slice(1)
    const [major = 0] = parseVersion(baseVersion)
    const [currentMajor = 0] = parseVersion(currentVersion)
    return currentMajor === major && compareAppVersions(currentVersion, baseVersion) >= 0
  }

  if (normalized.startsWith('~')) {
    const baseVersion = normalized.slice(1)
    const [major = 0, minor = 0] = parseVersion(baseVersion)
    const [currentMajor = 0, currentMinor = 0] = parseVersion(currentVersion)
    return (
      currentMajor === major &&
      currentMinor === minor &&
      compareAppVersions(currentVersion, baseVersion) >= 0
    )
  }

  for (const operator of ['>=', '<=', '>', '<', '='] as const) {
    if (!normalized.startsWith(operator)) continue
    const targetVersion = normalized.slice(operator.length)
    const comparison = compareAppVersions(currentVersion, targetVersion)
    switch (operator) {
      case '>=':
        return comparison >= 0
      case '<=':
        return comparison <= 0
      case '>':
        return comparison > 0
      case '<':
        return comparison < 0
      case '=':
        return comparison === 0
    }
  }

  return compareAppVersions(currentVersion, normalized) === 0
}

export const isAppVersionCompatible = (
  currentVersion: string,
  compatibleAppVersions?: string
): boolean => {
  const normalized = normalizeText(compatibleAppVersions)
  if (!normalized || normalized === '*') return true

  const constraints = normalized.split(/[,\s]+/).filter(Boolean)
  if (constraints.length === 0) return true
  return constraints.every((constraint) => satisfiesSingleConstraint(currentVersion, constraint))
}

export const normalizeQAppManifest = (
  manifest: Partial<QAppManifest> | null | undefined,
  defaults: QAppManifestDefaults
): QAppManifest => {
  const name = normalizeText(manifest?.name) || normalizeText(defaults.name) || 'quick-app'
  return {
    name,
    version: normalizeText(manifest?.version) || '1.0.0',
    ...(normalizeText(manifest?.author) ? { author: normalizeText(manifest?.author) } : {}),
    ...(normalizeText(manifest?.description)
      ? { description: normalizeText(manifest?.description) }
      : {}),
    ...(normalizeQAppCategory(manifest?.category)
      ? { category: normalizeQAppCategory(manifest?.category) as QAppCategory }
      : {}),
    ...(normalizeText(manifest?.source) || normalizeText(defaults.source)
      ? { source: normalizeText(manifest?.source) || normalizeText(defaults.source) }
      : {}),
    compatibleAppVersions:
      normalizeText(manifest?.compatibleAppVersions) ||
      normalizeText(defaults.compatibleAppVersions) ||
      `>=${defaults.appVersion}`
  }
}

export const buildDefaultQAppManifest = (
  name: string,
  appVersion: string,
  overrides?: Partial<QAppManifest> | null
): QAppManifest =>
  normalizeQAppManifest(overrides, {
    name,
    appVersion,
    source: 'local',
    compatibleAppVersions: `>=${appVersion}`
  })

const parsePackageObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const parseQAppPackage = (
  value: unknown,
  currentAppVersion: string,
  fallbackName: string
): ParsedQAppPackage => {
  const parsed = parsePackageObject(value)
  if (!parsed || parsed.magic !== QAPP_PACKAGE_MAGIC) {
    throw new Error('Not a valid MagicPot Quick App package.')
  }

  const cfg = parsed.cfg as QAppCfg | undefined
  const workflow = parsed.workflow as Workflow | undefined
  if (!cfg || !workflow) {
    throw new Error('The Quick App package is missing cfg or workflow data.')
  }

  const packageVersion =
    Number.isFinite(Number(parsed.version)) && Number(parsed.version) > 0
      ? Number(parsed.version)
      : 1
  const keyName =
    normalizeText(parsed.name) ||
    normalizeText((parsed.manifest as QAppManifest | undefined)?.name) ||
    fallbackName

  const manifest =
    packageVersion >= QAPP_PACKAGE_VERSION
      ? normalizeQAppManifest(parsed.manifest as Partial<QAppManifest> | undefined, {
          name: keyName,
          appVersion: currentAppVersion,
          source: 'imported',
          compatibleAppVersions: '*'
        })
      : normalizeQAppManifest(
          {
            name: keyName,
            source: 'imported',
            compatibleAppVersions: '*'
          },
          {
            name: keyName,
            appVersion: currentAppVersion,
            source: 'imported',
            compatibleAppVersions: '*'
          }
        )

  return {
    packageVersion,
    keyName,
    cfg,
    workflow,
    manifest,
    ...(normalizeText(parsed.createdAt) ? { exportedAt: normalizeText(parsed.createdAt) } : {})
  }
}

export const getQAppCompatibilityError = (
  currentAppVersion: string,
  manifest: QAppManifest
): string | null => {
  if (isAppVersionCompatible(currentAppVersion, manifest.compatibleAppVersions)) {
    return null
  }

  return `Quick App "${manifest.name}" requires MagicPot ${manifest.compatibleAppVersions || '*'}, but the current app version is ${currentAppVersion}.`
}

export const createQAppPackagePayload = (params: {
  cfg: QAppCfg
  workflow: Workflow
  manifest: QAppManifest
}): QAppPackageFile => ({
  magic: QAPP_PACKAGE_MAGIC,
  version: QAPP_PACKAGE_VERSION,
  createdAt: new Date().toISOString(),
  manifest: params.manifest,
  cfg: params.cfg,
  workflow: params.workflow
})
