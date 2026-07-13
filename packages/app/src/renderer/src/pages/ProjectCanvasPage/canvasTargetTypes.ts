import type { LLMModelUse } from '@shared/config/config'

export const CANVAS_TARGET_AUXILIARY_RESPONSIBILITY_TYPES = [
  'ocr_extract',
  'visual_analysis',
  'rule_validation',
  'synthesis',
  'final_review'
] as const

export type CanvasTargetAuxiliaryResponsibilityType =
  (typeof CANVAS_TARGET_AUXILIARY_RESPONSIBILITY_TYPES)[number]

export const CANVAS_TARGET_AUXILIARY_INPUT_KINDS = [
  'source_assets',
  'selection_snapshot',
  'scheme_files',
  'scheme_images',
  'upstream_results'
] as const

export type CanvasTargetAuxiliaryInputKind = (typeof CANVAS_TARGET_AUXILIARY_INPUT_KINDS)[number]

export const CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS = [
  'plain_text',
  'markdown',
  'json',
  'table',
  'image',
  'video',
  'model3d'
] as const

export type CanvasTargetAuxiliaryOutputFormat =
  (typeof CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS)[number]

export type CanvasTargetExecutionBackend = 'llm' | 'local_model'

export function resolveCanvasTargetBaseProfile<T extends { id: string }>(
  listedProfile: { id: string; base_profile_id?: string },
  configuredProfiles: readonly T[]
): T | undefined {
  return configuredProfiles.find(
    (profile) => profile.id === (listedProfile.base_profile_id || listedProfile.id)
  )
}

export function resolveCanvasTargetCompositeProfile<
  TListed extends { id: string; base_profile_id?: string; model_name?: string },
  TConfigured extends { id: string }
>(
  listedProfile: TListed,
  configuredProfiles: readonly TConfigured[]
): TListed & Partial<TConfigured> {
  const baseProfile = resolveCanvasTargetBaseProfile(listedProfile, configuredProfiles)
  return {
    ...(baseProfile || {}),
    ...listedProfile,
    model_name: listedProfile.model_name
  } as TListed & Partial<TConfigured>
}

export type CanvasTargetStageDraft = {
  profileId: string
  responsibilityType?: CanvasTargetAuxiliaryResponsibilityType
  mustFollow: string
  forbiddenActions: string
  allowedInputs: CanvasTargetAuxiliaryInputKind[]
  outputFormats: CanvasTargetAuxiliaryOutputFormat[]
  outputFormat?: CanvasTargetAuxiliaryOutputFormat
  executionRule?: string
}

export type CanvasTargetQuickAppDraft = {
  qAppKey: string
  mustFollow: string
  forbiddenActions: string
}

export const DEFAULT_CANVAS_TARGET_AUXILIARY_INPUT_KINDS: CanvasTargetAuxiliaryInputKind[] = [
  'source_assets',
  'selection_snapshot',
  'scheme_files',
  'scheme_images',
  'upstream_results'
]

export const DEFAULT_CANVAS_TARGET_AUXILIARY_OUTPUT_FORMAT: CanvasTargetAuxiliaryOutputFormat =
  'markdown'

export const DEFAULT_CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS: CanvasTargetAuxiliaryOutputFormat[] = [
  DEFAULT_CANVAS_TARGET_AUXILIARY_OUTPUT_FORMAT
]

export const LOCAL_MODEL_CANVAS_TARGET_ALLOWED_INPUT_KINDS: CanvasTargetAuxiliaryInputKind[] = [
  'source_assets',
  'selection_snapshot',
  'scheme_images',
  'upstream_results'
]

export const LOCAL_MODEL_CANVAS_TARGET_OUTPUT_FORMATS: CanvasTargetAuxiliaryOutputFormat[] = [
  'markdown',
  'json',
  'plain_text'
]

function normalizeNonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isAuxiliaryResponsibilityType(
  value: unknown
): value is CanvasTargetAuxiliaryResponsibilityType {
  return CANVAS_TARGET_AUXILIARY_RESPONSIBILITY_TYPES.includes(
    value as CanvasTargetAuxiliaryResponsibilityType
  )
}

function isAuxiliaryInputKind(value: unknown): value is CanvasTargetAuxiliaryInputKind {
  return CANVAS_TARGET_AUXILIARY_INPUT_KINDS.includes(value as CanvasTargetAuxiliaryInputKind)
}

function isAuxiliaryOutputFormat(value: unknown): value is CanvasTargetAuxiliaryOutputFormat {
  return CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS.includes(value as CanvasTargetAuxiliaryOutputFormat)
}

function normalizeAuxiliaryOutputFormats(
  value: unknown,
  fallbackValue?: unknown
): CanvasTargetAuxiliaryOutputFormat[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.filter(isAuxiliaryOutputFormat)))
  }

  if (isAuxiliaryOutputFormat(value)) {
    return [value]
  }

  if (isAuxiliaryOutputFormat(fallbackValue)) {
    return [fallbackValue]
  }

  return [...DEFAULT_CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS]
}

function normalizeAuxiliaryInputKinds(value: unknown): CanvasTargetAuxiliaryInputKind[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_CANVAS_TARGET_AUXILIARY_INPUT_KINDS]
  }

  const normalized = value.filter(isAuxiliaryInputKind)
  return normalized.length > 0
    ? Array.from(new Set(normalized))
    : [...DEFAULT_CANVAS_TARGET_AUXILIARY_INPUT_KINDS]
}

export function formatCanvasTargetAuxiliaryResponsibility(
  value: CanvasTargetAuxiliaryResponsibilityType
): string {
  switch (value) {
    case 'ocr_extract':
      return 'OCR extraction'
    case 'visual_analysis':
      return 'Visual analysis'
    case 'rule_validation':
      return 'Rule validation'
    case 'synthesis':
      return 'Synthesis'
    case 'final_review':
      return 'Final review'
    default:
      return 'Visual analysis'
  }
}

export function formatCanvasTargetAuxiliaryInput(value: CanvasTargetAuxiliaryInputKind): string {
  switch (value) {
    case 'source_assets':
      return 'Original source assets'
    case 'selection_snapshot':
      return 'Selection snapshot'
    case 'scheme_files':
      return 'Scheme files'
    case 'scheme_images':
      return 'Scheme images'
    case 'upstream_results':
      return 'Upstream stage results'
    default:
      return 'Original source assets'
  }
}

export function formatCanvasTargetAuxiliaryOutputFormat(
  value: CanvasTargetAuxiliaryOutputFormat
): string {
  switch (value) {
    case 'plain_text':
      return 'Plain text'
    case 'markdown':
      return 'Markdown'
    case 'json':
      return 'JSON'
    case 'table':
      return 'Table'
    case 'image':
      return 'Image'
    case 'video':
      return 'Video'
    case 'model3d':
      return '3D'
    default:
      return 'Markdown'
  }
}

export function formatCanvasTargetAuxiliaryOutputFormats(
  values: CanvasTargetAuxiliaryOutputFormat[] | undefined
): string {
  const normalized = normalizeAuxiliaryOutputFormats(values, undefined)
  return normalized.map((value) => formatCanvasTargetAuxiliaryOutputFormat(value)).join(', ')
}

type CanvasTargetOutputCapabilityProfile = {
  profileId?: string | null
  profileLabel?: string | null
  modelUse?: LLMModelUse | 'default' | string | null
  isVisionModel?: boolean
  isOcrModel?: boolean
  executionBackend?: CanvasTargetExecutionBackend | null
}

const VIDEO_OUTPUT_KEYWORDS = [
  'video',
  'veo',
  'sora',
  'kling',
  'runway',
  'hunyuanvideo',
  'wan-video',
  'wan video'
]

const MODEL3D_OUTPUT_KEYWORDS = ['3d', 'model3d', 'hy3d', 'hunyuan3d', 'tripo', 'trellis', 'mesh']

function includesAnyKeyword(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword))
}

export function resolveCanvasTargetSupportedOutputFormats(
  profile: CanvasTargetOutputCapabilityProfile | null | undefined
): CanvasTargetAuxiliaryOutputFormat[] {
  if (profile?.executionBackend === 'local_model') {
    return [...LOCAL_MODEL_CANVAS_TARGET_OUTPUT_FORMATS]
  }

  const baseFormats: CanvasTargetAuxiliaryOutputFormat[] = [
    'plain_text',
    'markdown',
    'json',
    'table',
    'image'
  ]
  const capabilityText = [profile?.profileId, profile?.profileLabel, profile?.modelUse]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const nextFormats = [...baseFormats]
  const supportsVideoOutput = includesAnyKeyword(capabilityText, VIDEO_OUTPUT_KEYWORDS)
  const supportsModel3dOutput = includesAnyKeyword(capabilityText, MODEL3D_OUTPUT_KEYWORDS)

  if (supportsVideoOutput) nextFormats.push('video')
  if (supportsModel3dOutput) nextFormats.push('model3d')

  if (profile?.isOcrModel) {
    return baseFormats
  }

  return Array.from(new Set(nextFormats))
}

export function sanitizeCanvasTargetStageOutputFormats(
  outputFormats: CanvasTargetAuxiliaryOutputFormat[] | undefined,
  supportedOutputFormats: CanvasTargetAuxiliaryOutputFormat[] | undefined
): CanvasTargetAuxiliaryOutputFormat[] {
  const normalized = normalizeAuxiliaryOutputFormats(outputFormats, undefined)
  const supported = supportedOutputFormats?.length
    ? new Set(supportedOutputFormats)
    : new Set(CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS)
  return normalized.filter((value) => supported.has(value))
}

export function resolveCanvasTargetAllowedInputsForProfile(
  profile: Pick<CanvasTargetOutputCapabilityProfile, 'executionBackend'> | null | undefined,
  allowedInputs: CanvasTargetAuxiliaryInputKind[] | undefined
): CanvasTargetAuxiliaryInputKind[] {
  const normalized = normalizeAuxiliaryInputKinds(allowedInputs)
  if (profile?.executionBackend !== 'local_model') {
    return normalized
  }

  const nextAllowedInputs = normalized.filter((inputKind) =>
    LOCAL_MODEL_CANVAS_TARGET_ALLOWED_INPUT_KINDS.includes(inputKind)
  )
  return nextAllowedInputs.length > 0
    ? nextAllowedInputs
    : [...LOCAL_MODEL_CANVAS_TARGET_ALLOWED_INPUT_KINDS]
}

export function applyCanvasTargetStageDraftProfileConstraints(
  value: Partial<CanvasTargetStageDraft> | null | undefined,
  profile: CanvasTargetOutputCapabilityProfile | null | undefined
): CanvasTargetStageDraft {
  const normalized = normalizeCanvasTargetStageDraft(value)
  const { responsibilityType: _legacyResponsibilityType, ...normalizedWithoutResponsibility } =
    normalized
  const supportedOutputFormats = resolveCanvasTargetSupportedOutputFormats(profile)
  const outputFormats = sanitizeCanvasTargetStageOutputFormats(
    normalized.outputFormats,
    supportedOutputFormats
  )
  const responsibilityType =
    profile?.executionBackend === 'local_model' ? 'visual_analysis' : undefined

  return {
    ...normalizedWithoutResponsibility,
    ...(responsibilityType ? { responsibilityType } : {}),
    allowedInputs: resolveCanvasTargetAllowedInputsForProfile(profile, normalized.allowedInputs),
    outputFormats,
    outputFormat: outputFormats[0]
  }
}

export function createCanvasTargetStageDraft(
  overrides: Partial<CanvasTargetStageDraft> = {}
): CanvasTargetStageDraft {
  const legacyExecutionRule = normalizeNonEmptyString(overrides.executionRule).trim()
  const outputFormats = Array.isArray(overrides.outputFormats)
    ? Array.from(new Set(overrides.outputFormats.filter(isAuxiliaryOutputFormat)))
    : isAuxiliaryOutputFormat(overrides.outputFormat)
      ? [overrides.outputFormat]
      : []
  const responsibilityType = isAuxiliaryResponsibilityType(overrides.responsibilityType)
    ? overrides.responsibilityType
    : undefined

  return {
    profileId: normalizeNonEmptyString(overrides.profileId),
    ...(responsibilityType ? { responsibilityType } : {}),
    mustFollow: (normalizeNonEmptyString(overrides.mustFollow) || legacyExecutionRule).trim(),
    forbiddenActions: normalizeNonEmptyString(overrides.forbiddenActions).trim(),
    allowedInputs: normalizeAuxiliaryInputKinds(overrides.allowedInputs),
    outputFormats,
    outputFormat: outputFormats[0]
  }
}

export function normalizeCanvasTargetStageDraft(
  value: Partial<CanvasTargetStageDraft> | null | undefined
): CanvasTargetStageDraft {
  return createCanvasTargetStageDraft(value || {})
}

export function createCanvasTargetQuickAppDraft(
  overrides: Partial<CanvasTargetQuickAppDraft> = {}
): CanvasTargetQuickAppDraft {
  return {
    qAppKey: normalizeNonEmptyString(overrides.qAppKey).trim(),
    mustFollow: normalizeNonEmptyString(overrides.mustFollow).trim(),
    forbiddenActions: normalizeNonEmptyString(overrides.forbiddenActions).trim()
  }
}

export function normalizeCanvasTargetQuickAppDraft(
  value: Partial<CanvasTargetQuickAppDraft> | null | undefined
): CanvasTargetQuickAppDraft {
  return createCanvasTargetQuickAppDraft(value || {})
}

export function buildCanvasTargetAuxiliaryExecutionRuleSummary(
  value: Partial<CanvasTargetStageDraft> | null | undefined
): string | undefined {
  const normalized = normalizeCanvasTargetStageDraft(value)
  const segments = [
    normalized.responsibilityType
      ? `Responsibility: ${formatCanvasTargetAuxiliaryResponsibility(normalized.responsibilityType)}`
      : null,
    normalized.mustFollow ? `Must follow: ${normalized.mustFollow}` : null,
    normalized.forbiddenActions ? `Forbidden: ${normalized.forbiddenActions}` : null,
    normalized.allowedInputs.length > 0
      ? `Allowed inputs: ${normalized.allowedInputs.map(formatCanvasTargetAuxiliaryInput).join(', ')}`
      : null,
    normalized.outputFormats.length === 1
      ? `Additional requested output format: ${formatCanvasTargetAuxiliaryOutputFormat(normalized.outputFormats[0])}`
      : normalized.outputFormats.length > 1
        ? `Additional requested output formats: ${formatCanvasTargetAuxiliaryOutputFormats(
            normalized.outputFormats
          )}`
        : null
  ].filter(Boolean)

  return segments.length > 0 ? segments.join(' | ') : undefined
}
