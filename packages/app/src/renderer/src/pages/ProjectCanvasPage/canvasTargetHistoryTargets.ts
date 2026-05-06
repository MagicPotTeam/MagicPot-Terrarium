import type {
  TargetHistoryEntry,
  TargetHistoryQuickApp,
  TargetHistoryStage
} from '@shared/targetHistory'
import {
  CANVAS_TARGET_AUXILIARY_INPUT_KINDS,
  CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS,
  CANVAS_TARGET_AUXILIARY_RESPONSIBILITY_TYPES,
  applyCanvasTargetStageDraftProfileConstraints,
  normalizeCanvasTargetQuickAppDraft,
  normalizeCanvasTargetStageDraft,
  resolveCanvasTargetSupportedOutputFormats,
  sanitizeCanvasTargetStageOutputFormats,
  type CanvasTargetAuxiliaryInputKind,
  type CanvasTargetAuxiliaryOutputFormat,
  type CanvasTargetAuxiliaryResponsibilityType,
  type CanvasTargetQuickAppDraft,
  type CanvasTargetStageDraft
} from './canvasTargetTypes'
import {
  DEFAULT_CANVAS_TARGET_EVIDENCE_MODE,
  normalizeCanvasTargetEvidenceMode,
  type CanvasTargetEvidenceMode
} from './canvasTargetEvidence'

export type CanvasTargetHistoryProfileOption = {
  id: string
  label?: string
  modelUse?: string
  isVisionModel?: boolean
  isOcrModel?: boolean
  executionBackend?: 'llm' | 'local_model'
}

export type CanvasTargetHistoryQuickAppOption = {
  key: string
}

function createTargetHistoryId(): string {
  return `target-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeTraceReferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean))
  )
}

function compareTargetHistoryEntries(left: TargetHistoryEntry, right: TargetHistoryEntry): number {
  const leftTime =
    Date.parse(left.lastRunAt || left.updatedAt || left.createdAt || '') ||
    Date.parse(left.updatedAt || left.createdAt || '') ||
    0
  const rightTime =
    Date.parse(right.lastRunAt || right.updatedAt || right.createdAt || '') ||
    Date.parse(right.updatedAt || right.createdAt || '') ||
    0
  if (leftTime !== rightTime) return rightTime - leftTime
  return left.name.localeCompare(right.name)
}

function resolveStageProfileId(
  profileId: string,
  stageOptions: CanvasTargetHistoryProfileOption[],
  fallbackProfileId: string
): string {
  if (profileId && stageOptions.some((profile) => profile.id === profileId)) {
    return profileId
  }

  return fallbackProfileId
}

function isCanvasTargetOutputFormat(value: string): value is CanvasTargetAuxiliaryOutputFormat {
  return CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS.includes(value as CanvasTargetAuxiliaryOutputFormat)
}

function isCanvasTargetInputKind(value: string): value is CanvasTargetAuxiliaryInputKind {
  return CANVAS_TARGET_AUXILIARY_INPUT_KINDS.includes(value as CanvasTargetAuxiliaryInputKind)
}

function isCanvasTargetResponsibilityType(
  value: string
): value is CanvasTargetAuxiliaryResponsibilityType {
  return CANVAS_TARGET_AUXILIARY_RESPONSIBILITY_TYPES.includes(
    value as CanvasTargetAuxiliaryResponsibilityType
  )
}

export function materializeCanvasTargetStageProfilesForOptions(
  stageProfiles: Array<Partial<CanvasTargetStageDraft> | TargetHistoryStage> | undefined,
  stageOptions: CanvasTargetHistoryProfileOption[],
  fallbackProfileId: string
): CanvasTargetStageDraft[] {
  if (!stageOptions.length) {
    return []
  }

  if (!Array.isArray(stageProfiles) || stageProfiles.length === 0) {
    return []
  }

  const nextProfiles = stageProfiles.map((stageProfile) => {
    const normalizedStageProfile = normalizeCanvasTargetStageDraft({
      profileId: typeof stageProfile.profileId === 'string' ? stageProfile.profileId : '',
      responsibilityType:
        typeof stageProfile.responsibilityType === 'string' &&
        isCanvasTargetResponsibilityType(stageProfile.responsibilityType)
          ? stageProfile.responsibilityType
          : undefined,
      mustFollow: typeof stageProfile.mustFollow === 'string' ? stageProfile.mustFollow : '',
      forbiddenActions:
        typeof stageProfile.forbiddenActions === 'string' ? stageProfile.forbiddenActions : '',
      allowedInputs: Array.isArray(stageProfile.allowedInputs)
        ? (stageProfile.allowedInputs.filter(
            isCanvasTargetInputKind
          ) as CanvasTargetAuxiliaryInputKind[])
        : undefined,
      outputFormats: Array.isArray(stageProfile.outputFormats)
        ? (stageProfile.outputFormats.filter(
            isCanvasTargetOutputFormat
          ) as CanvasTargetAuxiliaryOutputFormat[])
        : undefined
    })
    const resolvedProfileId = resolveStageProfileId(
      normalizedStageProfile.profileId,
      stageOptions,
      fallbackProfileId
    )
    const matchedProfile = stageOptions.find((profile) => profile.id === resolvedProfileId)

    return applyCanvasTargetStageDraftProfileConstraints(
      {
        ...normalizedStageProfile,
        profileId: resolvedProfileId,
        outputFormats: sanitizeCanvasTargetStageOutputFormats(
          normalizedStageProfile.outputFormats,
          resolveCanvasTargetSupportedOutputFormats(matchedProfile)
        )
      },
      matchedProfile
    )
  })

  return nextProfiles.length > 0 ? nextProfiles : []
}

export function serializeCanvasTargetStageProfilesForHistory(
  stageProfiles: CanvasTargetStageDraft[]
): TargetHistoryStage[] {
  return stageProfiles
    .map((stageProfile) => normalizeCanvasTargetStageDraft(stageProfile))
    .filter((stageProfile) => stageProfile.profileId.trim())
    .map((stageProfile) => ({
      profileId: stageProfile.profileId,
      ...(stageProfile.responsibilityType
        ? { responsibilityType: stageProfile.responsibilityType }
        : {}),
      mustFollow: stageProfile.mustFollow,
      forbiddenActions: stageProfile.forbiddenActions,
      allowedInputs: [...stageProfile.allowedInputs],
      outputFormats: [...stageProfile.outputFormats]
    }))
}

export function materializeCanvasTargetQuickAppsForOptions(
  quickApps: Array<Partial<CanvasTargetQuickAppDraft> | TargetHistoryQuickApp> | undefined,
  quickAppOptions: CanvasTargetHistoryQuickAppOption[]
): CanvasTargetQuickAppDraft[] {
  if (!Array.isArray(quickApps) || quickApps.length === 0 || quickAppOptions.length === 0) {
    return []
  }

  const availableKeys = new Set(quickAppOptions.map((option) => option.key).filter(Boolean))
  const seenKeys = new Set<string>()

  return quickApps
    .map((quickApp) => normalizeCanvasTargetQuickAppDraft(quickApp))
    .filter((quickApp) => {
      if (
        !quickApp.qAppKey ||
        !availableKeys.has(quickApp.qAppKey) ||
        seenKeys.has(quickApp.qAppKey)
      ) {
        return false
      }
      seenKeys.add(quickApp.qAppKey)
      return true
    })
}

export function serializeCanvasTargetQuickAppsForHistory(
  quickApps: CanvasTargetQuickAppDraft[]
): TargetHistoryQuickApp[] {
  const seenKeys = new Set<string>()

  return quickApps
    .map((quickApp) => normalizeCanvasTargetQuickAppDraft(quickApp))
    .filter((quickApp) => {
      if (!quickApp.qAppKey || seenKeys.has(quickApp.qAppKey)) {
        return false
      }
      seenKeys.add(quickApp.qAppKey)
      return true
    })
    .map((quickApp) => ({
      qAppKey: quickApp.qAppKey,
      mustFollow: quickApp.mustFollow,
      forbiddenActions: quickApp.forbiddenActions
    }))
}

export function resolveCanvasTargetHistoryTargetDraft(options: {
  target: TargetHistoryEntry
  schemes: Array<{ id: string }>
  controlOptions: CanvasTargetHistoryProfileOption[]
  stageOptions: CanvasTargetHistoryProfileOption[]
  quickAppOptions?: CanvasTargetHistoryQuickAppOption[]
  fallbackControlProfileId: string
}): {
  targetName: string
  selectedSchemeId: string | null
  controlProfileId: string
  evidenceMode: CanvasTargetEvidenceMode
  userIntent: string
  stageProfiles: CanvasTargetStageDraft[]
  quickApps: CanvasTargetQuickAppDraft[]
  traceReferenceIds?: string[]
} {
  const resolvedSchemeId =
    options.schemes.find((scheme) => scheme.id === options.target.schemeId)?.id ||
    options.schemes[0]?.id ||
    null
  const resolvedControlProfileId =
    options.controlOptions.find((profile) => profile.id === options.target.controlProfileId)?.id ||
    options.fallbackControlProfileId ||
    options.controlOptions[0]?.id ||
    ''
  const stageFallbackProfileId =
    options.stageOptions.find((profile) => profile.id === options.target.controlProfileId)?.id ||
    resolvedControlProfileId ||
    options.stageOptions[0]?.id ||
    ''

  const traceReferenceIds = normalizeTraceReferenceIds(options.target.traceReferenceIds)

  return {
    targetName: options.target.name,
    selectedSchemeId: resolvedSchemeId,
    controlProfileId: resolvedControlProfileId,
    evidenceMode: normalizeCanvasTargetEvidenceMode(options.target.evidenceMode),
    userIntent: options.target.userIntent,
    stageProfiles: materializeCanvasTargetStageProfilesForOptions(
      options.target.stageProfiles,
      options.stageOptions,
      stageFallbackProfileId
    ),
    quickApps: materializeCanvasTargetQuickAppsForOptions(
      options.target.quickApps,
      options.quickAppOptions || []
    ),
    ...(traceReferenceIds.length ? { traceReferenceIds } : {})
  }
}

export function buildCanvasTargetHistoryTargetRecord(options: {
  selectedHistoryTargetId?: string | null
  historyTargets: TargetHistoryEntry[]
  targetName: string
  schemeId: string
  schemeName?: string | null
  controlProfileId: string
  evidenceMode?: CanvasTargetEvidenceMode
  userIntent: string
  stageProfiles: CanvasTargetStageDraft[]
  quickApps?: CanvasTargetQuickAppDraft[]
  traceReferenceIds?: string[]
  untitledName: string
  now?: string
}): TargetHistoryEntry {
  const now = options.now || new Date().toISOString()
  const trimmedName = options.targetName.trim()
  const matchedExisting =
    options.historyTargets.find((target) => target.id === options.selectedHistoryTargetId) ||
    (trimmedName
      ? options.historyTargets.find(
          (target) => target.name.trim().toLowerCase() === trimmedName.toLowerCase()
        )
      : undefined)

  const resolvedName =
    trimmedName ||
    matchedExisting?.name?.trim() ||
    options.schemeName?.trim() ||
    options.untitledName

  const traceReferenceIds = normalizeTraceReferenceIds(options.traceReferenceIds)
  const quickApps = serializeCanvasTargetQuickAppsForHistory(options.quickApps || [])

  return {
    id: matchedExisting?.id || createTargetHistoryId(),
    name: resolvedName,
    schemeId: options.schemeId,
    controlProfileId: options.controlProfileId,
    evidenceMode: normalizeCanvasTargetEvidenceMode(
      options.evidenceMode || matchedExisting?.evidenceMode || DEFAULT_CANVAS_TARGET_EVIDENCE_MODE
    ),
    userIntent: options.userIntent,
    stageProfiles: serializeCanvasTargetStageProfilesForHistory(options.stageProfiles),
    ...(quickApps.length ? { quickApps } : {}),
    ...(traceReferenceIds.length ? { traceReferenceIds } : {}),
    createdAt: matchedExisting?.createdAt || now,
    updatedAt: now,
    lastRunAt: now
  }
}

export function upsertCanvasTargetHistoryTargets(
  targets: TargetHistoryEntry[],
  nextTarget: TargetHistoryEntry
): TargetHistoryEntry[] {
  const nextTargets = [...targets.filter((target) => target.id !== nextTarget.id), nextTarget]

  return nextTargets.sort(compareTargetHistoryEntries)
}
