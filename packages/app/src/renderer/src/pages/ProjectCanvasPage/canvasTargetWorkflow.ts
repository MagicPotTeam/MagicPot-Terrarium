import type { ChatAttachment, LLMProxySvc, OCRResult } from '@shared/api/svcLLMProxy'
import type { LLMReasoningEffort } from '@shared/llm'
import type { OpenAIImageGenerationOptions } from '@shared/llm/types'
import type {
  CanvasTargetAssetMetadata,
  CanvasTargetContextPack,
  CanvasTargetEvidenceMode,
  CanvasTargetFinding
} from '@shared/canvasTarget'
import type { ProjectTraceReference } from '@shared/projectTrace'
import type { TargetScheme } from '@shared/targetScheme'
import {
  type CanvasTargetAuxiliaryInputKind,
  type CanvasTargetAuxiliaryOutputFormat,
  type CanvasTargetAuxiliaryResponsibilityType,
  type CanvasTargetExecutionBackend
} from './canvasTargetTypes'
import { buildDesignInspectionContextPack } from './designInspectionWorkflow'
import type { CanvasGroup, CanvasItem } from './types'
import { guardCanvasTargetTextForUi } from './canvasTargetTextGuard'
import {
  prepareCanvasTargetAttachmentsForProfile,
  type CanvasTargetSchemeImageAttachment
} from './canvasTargetWorkflowAttachments'
import {
  buildCanvasTargetAcceptanceFixPrompt,
  buildCanvasTargetControlPlanPrompt,
  buildCanvasTargetExecutionPrompt,
  buildCanvasTargetSummaryExecutionPrompt
} from './canvasTargetWorkflowPromptBuilders'
import {
  appendAuxiliaryConstraintNotes,
  appendAuxiliaryPromptContract,
  hasAuxiliaryAllowedInput,
  normalizeAuxiliaryAllowedInputs,
  normalizeAuxiliaryOutputFormats
} from './canvasTargetWorkflowAuxiliaryConstraints'
import {
  normalizeCanvasTargetLlmError,
  normalizeCanvasTargetOutputFormats,
  normalizeCanvasTargetResponseAttachments,
  resolveCanvasTargetImageGenerationOptions
} from './canvasTargetWorkflowPromptContext'
import type {
  CanvasTargetCapabilityAction,
  CanvasTargetCapabilityCatalog,
  CanvasTargetFinalPresentation
} from './canvasTargetCapabilityTypes'
import {
  normalizeCanvasTargetCapabilityActions,
  normalizeCanvasTargetFinalPresentation
} from './canvasTargetCapabilityNormalize'
import type { CanvasTargetExecutionJournalDigest } from './canvasTargetExecutionJournal'
import {
  buildCanvasTargetAssetMetadata,
  sanitizeCanvasItemForCheckContext
} from './canvasTargetWorkflowAssetMetadata'
import {
  buildCanvasTargetTask,
  createCanvasTargetId,
  parseJsonObjectFromPossiblyWrappedText,
  sanitizeCanvasTargetOcrResult,
  truncateText
} from './canvasTargetWorkflowCommon'
export { buildCanvasTargetAssetMetadata } from './canvasTargetWorkflowAssetMetadata'
export {
  buildCanvasTargetAttachments,
  buildCanvasTargetSchemeImageAttachments,
  buildCanvasTargetSourceAttachments,
  resolveCanvasTargetEvidenceAttachments,
  shouldAttachCanvasTargetSelectionSnapshot,
  type CanvasTargetSchemeImageAttachment,
  type CanvasTargetSourceAttachment
} from './canvasTargetWorkflowAttachments'

import {
  DEFAULT_CANVAS_TARGET_EVIDENCE_MODE,
  normalizeCanvasTargetEvidenceMode,
  resolveCanvasTargetEvidencePolicy
} from './canvasTargetEvidence'

type BoundsResolver = (item: CanvasItem) => {
  x: number
  y: number
  width: number
  height: number
} | null

type BuildCanvasTargetContextPackOptions = {
  scheme: TargetScheme
  projectId?: string
  projectName?: string
  targetItems: CanvasItem[]
  groups: CanvasGroup[]
  snapshotDataUrl?: string | null
  assetMetadata?: CanvasTargetAssetMetadata[]
  traceReferences?: ProjectTraceReference[]
  evidenceMode?: CanvasTargetEvidenceMode
  preferredLanguage?: 'zh-CN' | 'en-US'
  getItemBounds?: BoundsResolver
  now?: Date
}

type RequestCanvasTargetStageExecutionOptions = {
  scheme: TargetScheme
  contextPack: CanvasTargetContextPack
  llmProxy?: Pick<LLMProxySvc, 'chat' | 'listProfiles'> | null
  attachments?: ChatAttachment[]
  userNotes?: string
  profileId?: string | null
  preferExactProfile?: boolean
  preferredLanguage?: 'zh-CN' | 'en-US'
  stageLabel?: string
  stagePrompt?: string
  referenceNotes?: string[]
  allowedSchemeFileIds?: string[]
  executionJournalDigest?: CanvasTargetExecutionJournalDigest
  preferredOutputFormats?: CanvasTargetAuxiliaryOutputFormat[]
}

type RequestCanvasTargetControlPlanOptions = {
  scheme: TargetScheme
  contextPack: CanvasTargetContextPack
  llmProxy?: Pick<LLMProxySvc, 'chat' | 'listProfiles'> | null
  attachments?: ChatAttachment[]
  userIntent: string
  profileId?: string | null
  reasoningEffort?: LLMReasoningEffort
  preferExactProfile?: boolean
  preferredLanguage?: 'zh-CN' | 'en-US'
  stageProfiles: CanvasTargetControlStageCandidate[]
  runtimeCapabilities?: CanvasTargetCapabilityCatalog
}

type RequestCanvasTargetSummaryOptions = {
  scheme: TargetScheme
  contextPack: CanvasTargetContextPack
  llmProxy?: Pick<LLMProxySvc, 'chat' | 'listProfiles'> | null
  attachments?: ChatAttachment[]
  userIntent: string
  profileId?: string | null
  reasoningEffort?: LLMReasoningEffort
  preferExactProfile?: boolean
  preferredLanguage?: 'zh-CN' | 'en-US'
  controlPlan: CanvasTargetControlPlan
  executionJournalDigest?: CanvasTargetExecutionJournalDigest
  stageResults: Array<{
    id: string
    label: string
    modelId?: string
    summary: string
    overview: string
    findings: CanvasTargetFinding[]
    content?: string
    attachments?: ChatAttachment[]
    ocrResult?: OCRResult
    upstreamStageIds?: string[]
    fallbackReason?: string
  }>
}

type RequestCanvasTargetAcceptanceFixOptions = {
  scheme: TargetScheme
  contextPack: CanvasTargetContextPack
  llmProxy?: Pick<LLMProxySvc, 'chat' | 'listProfiles'> | null
  attachments?: ChatAttachment[]
  userIntent: string
  profileId?: string | null
  reasoningEffort?: LLMReasoningEffort
  preferExactProfile?: boolean
  preferredLanguage?: 'zh-CN' | 'en-US'
  controlPlan: CanvasTargetControlPlan
  executionJournalDigest?: CanvasTargetExecutionJournalDigest
  finalAcceptanceContent: string
  stageResults: RequestCanvasTargetSummaryOptions['stageResults']
  runtimeCapabilities?: CanvasTargetCapabilityCatalog
  availableCanvasSources?: CanvasTargetAvailableCanvasSource[]
}

export type CanvasTargetAvailableCanvasSource = {
  sourceStageId: string
  label?: string
  kind?: string
  modelId?: string
  canvasItemIds: string[]
  artifactIds?: string[]
  items?: Array<{
    id: string
    type: string
    fileName?: string
    x?: number
    y?: number
    width?: number
    height?: number
  }>
}

export type CanvasTargetControlStageCandidate = {
  candidateId?: string
  id: string
  label: string
  executionRule?: string
  executionBackend?: CanvasTargetExecutionBackend
  responsibilityType?: CanvasTargetAuxiliaryResponsibilityType
  mustFollow?: string
  forbiddenActions?: string
  allowedInputs?: CanvasTargetAuxiliaryInputKind[]
  outputFormats?: CanvasTargetAuxiliaryOutputFormat[]
  outputFormat?: CanvasTargetAuxiliaryOutputFormat
  modelUse?: string
  isVisionModel?: boolean
  isOcrModel?: boolean
  sourceType?: 'api' | 'local'
}

export type CanvasTargetControlPlanStage = {
  id: string
  label: string
  candidateId?: string
  modelId: string
  prompt: string
  referenceNotes: string[]
  allowedSchemeFileIds: string[]
  upstreamStageIds: string[]
  responsibilityType?: CanvasTargetAuxiliaryResponsibilityType
  allowedAuxiliaryInputs?: CanvasTargetAuxiliaryInputKind[]
  expectedOutputFormats?: CanvasTargetAuxiliaryOutputFormat[]
  expectedOutputFormat?: CanvasTargetAuxiliaryOutputFormat
  includeSourceAttachments?: boolean
  includeSelectionSnapshot?: boolean
  includeSchemeImageAttachments?: boolean
}

export type CanvasTargetControlPlan = {
  id: string
  generatedAt: string
  modelId?: string
  summary: string
  relevantSchemeFileIds: string[]
  stageInstructions: CanvasTargetControlPlanStage[]
  capabilityActions?: CanvasTargetCapabilityAction[]
  finalPresentation?: CanvasTargetFinalPresentation
  rawResponse?: string
  fallbackReason?: string
}

export type CanvasTargetAcceptanceFixPlan = {
  summary: string
  capabilityActions: CanvasTargetCapabilityAction[]
  attachments?: ChatAttachment[]
  modelId?: string
  rawResponse?: string
  fallbackReason?: string
}

type CanvasTargetControlPlanResponse = {
  summary?: unknown
  relevantSchemeFileIds?: unknown
  capabilityActions?: unknown
  finalPresentation?: unknown
  stageInstructions?: Array<{
    id?: unknown
    label?: unknown
    candidateId?: unknown
    modelId?: unknown
    prompt?: unknown
    referenceNotes?: unknown
    allowedSchemeFileIds?: unknown
    upstreamStageIds?: unknown
    expectedOutputFormats?: unknown
    expectedOutputFormat?: unknown
    includeSourceAttachments?: unknown
    includeSelectionSnapshot?: unknown
    includeSchemeImageAttachments?: unknown
  }>
}

export type CanvasTargetStageExecutionResult = {
  modelId?: string
  content: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  fallbackReason?: string
}

async function requestCanvasTargetRawOutput(options: {
  llmProxy?: Pick<LLMProxySvc, 'chat' | 'listProfiles'> | null
  attachments?: ChatAttachment[]
  profileId?: string | null
  reasoningEffort?: LLMReasoningEffort
  preferExactProfile?: boolean
  prompt: string
  fallbackContent?: string
  imageGenerationOptions?: OpenAIImageGenerationOptions
}): Promise<CanvasTargetStageExecutionResult> {
  if (!options.llmProxy) {
    return {
      content: options.fallbackContent || '',
      fallbackReason: 'LLM service unavailable'
    }
  }

  try {
    const profilesResponse = await options.llmProxy.listProfiles({})
    const selectedProfile = selectCanvasTargetProfile(
      profilesResponse.profiles,
      options.profileId,
      options.preferExactProfile
    )

    if (!selectedProfile) {
      return {
        content: options.fallbackContent || '',
        fallbackReason: options.profileId
          ? `Requested LLM profile unavailable: ${options.profileId}`
          : 'No available LLM profile'
      }
    }

    const preparedAttachments = await prepareCanvasTargetAttachmentsForProfile(
      options.attachments,
      selectedProfile
    )

    const response = await options.llmProxy.chat({
      profileId: selectedProfile.id,
      reasoningEffort: options.reasoningEffort,
      imageGenerationOptions: options.imageGenerationOptions,
      messages: [
        {
          role: 'user',
          content: options.prompt,
          attachments: preparedAttachments
        }
      ]
    })
    const responseAttachments = normalizeCanvasTargetResponseAttachments(response)

    const hasUsableResponse =
      Boolean(response?.content?.trim()) ||
      Boolean(responseAttachments && responseAttachments.length > 0) ||
      Boolean(response?.ocrResult)

    if (!hasUsableResponse) {
      return {
        modelId: selectedProfile.id,
        content: options.fallbackContent || '',
        fallbackReason: 'Empty LLM response'
      }
    }

    return {
      modelId: selectedProfile.id,
      content:
        guardCanvasTargetTextForUi(response.content || '', {
          kind: 'response'
        }) || '',
      attachments: responseAttachments,
      ocrResult: sanitizeCanvasTargetOcrResult(response.ocrResult)
    }
  } catch (error) {
    return {
      content: options.fallbackContent || '',
      fallbackReason: normalizeCanvasTargetLlmError(error)
    }
  }
}

export async function requestCanvasTargetStageExecution({
  scheme,
  contextPack,
  llmProxy,
  attachments,
  userNotes,
  profileId,
  preferExactProfile = false,
  preferredLanguage,
  stageLabel,
  stagePrompt,
  referenceNotes,
  allowedSchemeFileIds,
  executionJournalDigest,
  preferredOutputFormats,
  upstreamStageResults
}: RequestCanvasTargetStageExecutionOptions & {
  upstreamStageResults?: Array<{
    id: string
    label: string
    modelId?: string
    content?: string
    attachments?: ChatAttachment[]
    ocrResult?: OCRResult
    fallbackReason?: string
  }>
}): Promise<CanvasTargetStageExecutionResult> {
  return requestCanvasTargetRawOutput({
    llmProxy,
    attachments,
    profileId,
    preferExactProfile,
    prompt: buildCanvasTargetExecutionPrompt(scheme, contextPack, userNotes, {
      preferredLanguage,
      stageLabel,
      stagePrompt,
      referenceNotes,
      allowedSchemeFileIds,
      executionJournalDigest,
      preferredOutputFormats,
      upstreamStageResults
    }),
    imageGenerationOptions: resolveCanvasTargetImageGenerationOptions({
      preferredOutputFormats,
      attachments
    })
  })
}

export async function requestCanvasTargetSummaryExecution({
  scheme,
  contextPack,
  llmProxy,
  attachments,
  userIntent,
  profileId,
  reasoningEffort,
  preferExactProfile = false,
  preferredLanguage,
  controlPlan,
  executionJournalDigest,
  stageResults
}: RequestCanvasTargetSummaryOptions): Promise<CanvasTargetStageExecutionResult> {
  const fallbackContent = [
    'Summary fallback',
    controlPlan.summary,
    ...stageResults.map((stage) => `${stage.label}: ${stage.summary}`)
  ]
    .filter(Boolean)
    .join('\n')

  if (!llmProxy) {
    return {
      content: fallbackContent,
      fallbackReason: 'LLM service unavailable'
    }
  }

  const profilesResponse = await llmProxy.listProfiles({})
  const selectedProfile = selectCanvasTargetProfile(
    profilesResponse.profiles,
    profileId,
    preferExactProfile
  )

  if (!selectedProfile) {
    return {
      content: fallbackContent,
      fallbackReason: profileId
        ? `Requested LLM profile unavailable: ${profileId}`
        : 'No available LLM profile'
    }
  }

  if (selectedProfile.is_ocr_model) {
    return {
      modelId: selectedProfile.id,
      content: fallbackContent
    }
  }

  return requestCanvasTargetRawOutput({
    llmProxy,
    attachments,
    profileId: selectedProfile.id,
    reasoningEffort,
    preferExactProfile: true,
    prompt: buildCanvasTargetSummaryExecutionPrompt(
      scheme,
      contextPack,
      controlPlan,
      stageResults,
      userIntent,
      preferredLanguage,
      executionJournalDigest
    ),
    fallbackContent
  })
}

function normalizeAcceptanceFixCapabilityActions(
  rawActions: unknown,
  runtimeCapabilities: CanvasTargetCapabilityCatalog | undefined
): CanvasTargetCapabilityAction[] {
  return normalizeCanvasTargetCapabilityActions(rawActions, runtimeCapabilities).map(
    (action, index) => ({
      ...action,
      id: action.id.startsWith('acceptance-fix-')
        ? action.id
        : `acceptance-fix-${index + 1}-${action.id}`,
      phase: 'after_summary' as const
    })
  )
}

function collectCanvasTargetCapabilityActionList(value: unknown): unknown[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const looksLikeAction = Boolean(
    record.action ||
    record.name ||
    record.tool ||
    record.toolName ||
    record.qAppKey ||
    record.key ||
    record.function
  )
  if (looksLikeAction) return [value]

  return [
    record.capabilityActions,
    record.capability_actions,
    record.actions,
    record.toolCalls,
    record.tool_calls,
    record.canvasActions,
    record.canvas_actions,
    record.quickAppActions,
    record.quick_app_actions,
    record.calls,
    record.items
  ].flatMap(collectCanvasTargetCapabilityActionList)
}

function collectCanvasTargetCapabilityActionCandidates(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  const nestedCandidates = [
    record.capabilityActions,
    record.capability_actions,
    record.actions,
    record.toolCalls,
    record.tool_calls,
    record.canvasActions,
    record.canvas_actions,
    record.quickAppActions,
    record.quick_app_actions,
    record.calls,
    record.items
  ].flatMap(collectCanvasTargetCapabilityActionList)
  return nestedCandidates.length > 0
    ? nestedCandidates
    : collectCanvasTargetCapabilityActionList(value)
}

export async function requestCanvasTargetAcceptanceFixActions({
  scheme,
  contextPack,
  llmProxy,
  attachments,
  userIntent,
  profileId,
  reasoningEffort,
  preferExactProfile = false,
  preferredLanguage,
  controlPlan,
  executionJournalDigest,
  finalAcceptanceContent,
  stageResults,
  runtimeCapabilities,
  availableCanvasSources
}: RequestCanvasTargetAcceptanceFixOptions): Promise<CanvasTargetAcceptanceFixPlan> {
  if (!llmProxy) {
    return {
      summary: 'Acceptance fix skipped because the LLM service is unavailable.',
      capabilityActions: [],
      fallbackReason: 'LLM service unavailable'
    }
  }

  try {
    const profilesResponse = await llmProxy.listProfiles({})
    const selectedProfile = selectCanvasTargetProfile(
      profilesResponse.profiles,
      profileId,
      preferExactProfile
    )

    if (!selectedProfile) {
      return {
        summary: 'Acceptance fix skipped because no control model profile is available.',
        capabilityActions: [],
        fallbackReason: profileId
          ? `Requested LLM profile unavailable: ${profileId}`
          : 'No available LLM profile'
      }
    }

    if (selectedProfile.is_ocr_model) {
      return {
        summary: 'Acceptance fix skipped because the selected profile is OCR-only.',
        capabilityActions: [],
        modelId: selectedProfile.id
      }
    }

    const preparedAttachments = await prepareCanvasTargetAttachmentsForProfile(
      attachments,
      selectedProfile
    )
    const response = await llmProxy.chat({
      profileId: selectedProfile.id,
      reasoningEffort,
      messages: [
        {
          role: 'user',
          content: buildCanvasTargetAcceptanceFixPrompt({
            scheme,
            contextPack,
            controlPlan,
            userIntent,
            preferredLanguage,
            executionJournalDigest,
            finalAcceptanceContent,
            stageResults,
            runtimeCapabilities,
            availableCanvasSources
          }),
          attachments: preparedAttachments
        }
      ]
    })

    const responseAttachments = normalizeCanvasTargetResponseAttachments(response)

    if (!response?.content?.trim()) {
      const hasReturnedAttachments = Boolean(responseAttachments?.length)
      return {
        summary: hasReturnedAttachments
          ? 'Acceptance fix skipped because the control model returned media without executable tool calls.'
          : 'Acceptance fix skipped because the control model returned an empty response.',
        capabilityActions: [],
        attachments: responseAttachments,
        modelId: selectedProfile.id,
        fallbackReason: hasReturnedAttachments
          ? 'No executable correction tool calls returned'
          : 'Empty LLM response'
      }
    }

    let parsed: {
      summary?: unknown
      capabilityActions?: unknown
    } = {}
    try {
      parsed = parseJsonObjectFromPossiblyWrappedText(response.content) as {
        summary?: unknown
        capabilityActions?: unknown
      }
    } catch (parseError) {
      return {
        summary: 'Acceptance fix skipped because the control model did not return executable JSON.',
        capabilityActions: [],
        modelId: selectedProfile.id,
        rawResponse: guardCanvasTargetTextForUi(response.content, {
          kind: 'response'
        }),
        attachments: responseAttachments,
        fallbackReason: 'Missing executable JSON correction package'
      }
    }
    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Acceptance fix actions generated.'
    const rawActionCandidates = collectCanvasTargetCapabilityActionCandidates(parsed)
    const capabilityActions = normalizeAcceptanceFixCapabilityActions(
      rawActionCandidates,
      runtimeCapabilities
    )

    return {
      summary,
      capabilityActions,
      attachments: responseAttachments,
      modelId: selectedProfile.id,
      rawResponse: guardCanvasTargetTextForUi(response.content, {
        kind: 'response'
      }),
      fallbackReason:
        capabilityActions.length === 0
          ? rawActionCandidates.length > 0
            ? 'Returned correction tool calls were unsupported or malformed'
            : 'No executable correction tool calls returned'
          : undefined
    }
  } catch (error) {
    return {
      summary: 'Acceptance fix skipped because the control model fix request failed.',
      capabilityActions: [],
      fallbackReason: normalizeCanvasTargetLlmError(error)
    }
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
}

function selectCanvasTargetProfile(
  profiles: Awaited<
    ReturnType<NonNullable<RequestCanvasTargetStageExecutionOptions['llmProxy']>['listProfiles']>
  >['profiles'],
  profileId?: string | null,
  preferExactProfile = false
) {
  if (profileId) {
    const exactProfile = profiles.find((profile) => profile.id === profileId)
    if (exactProfile || preferExactProfile) {
      return exactProfile
    }
  }

  return profiles.find((profile) => profile.is_vision_model) || profiles[0]
}

function buildFallbackControlPlan(scheme: TargetScheme): CanvasTargetControlPlan {
  const relevantSchemeFileIds = scheme.files.map((file) => file.id)
  const fallbackFinalPresentation: CanvasTargetFinalPresentation = {
    target: 'auto'
  }

  return {
    id: createCanvasTargetId('canvas-target-control-plan'),
    generatedAt: new Date().toISOString(),
    summary:
      'The control model did not return a usable plan. No local semantic fallback plan was generated.',
    relevantSchemeFileIds,
    stageInstructions: [],
    capabilityActions: [],
    finalPresentation: fallbackFinalPresentation,
    fallbackReason: 'Control planning unavailable'
  }
}

// Build the regex from code points so mojibake literals never re-enter source.
const CORRUPTED_CANVAS_LABEL_HINT_CODES = [
  0x9359, 0x95c2, 0x7f02, 0x59ab, 0x8930, 0x93c7, 0x5bee, 0x9350, 0x7459, 0x6fde, 0x95bb, 0x951b,
  0x9286, 0x6dbd, 0x5b84, 0x6822
]
const CORRUPTED_CANVAS_LABEL_HINT_CHAR_CLASS = CORRUPTED_CANVAS_LABEL_HINT_CODES.map((code) =>
  String.fromCharCode(code)
).join('')
const CORRUPTED_CANVAS_LABEL_HINTS = new RegExp(`[${CORRUPTED_CANVAS_LABEL_HINT_CHAR_CLASS}]`, 'g')
const CORRUPTED_CANVAS_LABEL_HINT = new RegExp(`[${CORRUPTED_CANVAS_LABEL_HINT_CHAR_CLASS}]`)

function looksLikeCorruptedCanvasLabel(value: string): boolean {
  const normalized = value.trim()
  if (!normalized) return false

  const suspiciousMatches = normalized.match(CORRUPTED_CANVAS_LABEL_HINTS)
  if (suspiciousMatches && suspiciousMatches.length >= 2) {
    return true
  }

  return /[??]/.test(normalized) && CORRUPTED_CANVAS_LABEL_HINT.test(normalized)
}

function normalizeControlPlan(
  rawResponse: string,
  fallbackPlan: CanvasTargetControlPlan,
  stageProfiles: CanvasTargetControlStageCandidate[],
  modelId?: string,
  runtimeCapabilities?: CanvasTargetCapabilityCatalog
): CanvasTargetControlPlan {
  const parsed =
    parseJsonObjectFromPossiblyWrappedText<CanvasTargetControlPlanResponse>(rawResponse)
  const parsedRecord = parsed as Record<string, unknown>
  const rawStageInstructions =
    parsed.stageInstructions ||
    parsedRecord.stage_instructions ||
    parsedRecord.stages ||
    parsedRecord.modelStages ||
    parsedRecord.model_stages
  const parsedStages = Array.isArray(rawStageInstructions)
    ? (rawStageInstructions as NonNullable<CanvasTargetControlPlanResponse['stageInstructions']>)
    : []
  const normalizedCapabilityActions = normalizeCanvasTargetCapabilityActions(
    collectCanvasTargetCapabilityActionCandidates(parsed),
    runtimeCapabilities
  )
  const candidateByCandidateId = new Map(
    stageProfiles
      .map((profile) => [profile.candidateId, profile] as const)
      .filter((entry): entry is [string, CanvasTargetControlStageCandidate] => Boolean(entry[0]))
  )

  return {
    id: createCanvasTargetId('canvas-target-control-plan'),
    generatedAt: new Date().toISOString(),
    modelId,
    summary:
      typeof parsed.summary === 'string' &&
      parsed.summary.trim() &&
      !looksLikeCorruptedCanvasLabel(parsed.summary.trim())
        ? parsed.summary.trim()
        : fallbackPlan.summary,
    relevantSchemeFileIds: (() => {
      const ids = normalizeStringArray(parsed.relevantSchemeFileIds)
      return ids.length > 0 ? ids : fallbackPlan.relevantSchemeFileIds
    })(),
    stageInstructions: (() => {
      const normalizedStages: CanvasTargetControlPlanStage[] = []

      parsedStages.forEach((parsedStage, index) => {
        const parsedCandidateId =
          typeof parsedStage?.candidateId === 'string' && parsedStage.candidateId.trim()
            ? parsedStage.candidateId.trim()
            : undefined
        const parsedModelId =
          typeof parsedStage?.modelId === 'string' && parsedStage.modelId.trim()
            ? parsedStage.modelId.trim()
            : undefined
        const candidate =
          (parsedCandidateId ? candidateByCandidateId.get(parsedCandidateId) : undefined) ||
          (parsedModelId
            ? stageProfiles.find((profile) => profile.id === parsedModelId)
            : undefined)
        const parsedPrompt =
          typeof parsedStage?.prompt === 'string' && parsedStage.prompt.trim()
            ? parsedStage.prompt.trim()
            : undefined
        if (!candidate || !parsedPrompt) return

        const knownStageIds = new Set([
          ...normalizedCapabilityActions.map((action) => action.id),
          ...normalizedStages.map((stage) => stage.id)
        ])
        const requestedUpstreamStageIds = normalizeStringArray(
          parsedStage?.upstreamStageIds
        ).filter((stageId) => knownStageIds.has(stageId))
        const normalizedAllowedInputs = normalizeAuxiliaryAllowedInputs(candidate.allowedInputs)
        const normalizedReferenceNotes = appendAuxiliaryConstraintNotes(
          normalizeStringArray(parsedStage?.referenceNotes),
          candidate
        )
        const normalizedPrompt = appendAuxiliaryPromptContract(parsedPrompt, candidate, index)
        const supportsVisualInputs = Boolean(
          candidate.isVisionModel ||
          candidate.isOcrModel ||
          candidate.executionBackend === 'local_model'
        )
        const includeSourceAttachments = Boolean(
          supportsVisualInputs &&
          parsedStage?.includeSourceAttachments === true &&
          hasAuxiliaryAllowedInput(candidate, 'source_assets')
        )
        const includeSelectionSnapshot = Boolean(
          supportsVisualInputs &&
          parsedStage?.includeSelectionSnapshot === true &&
          hasAuxiliaryAllowedInput(candidate, 'selection_snapshot')
        )
        const includeSchemeImageAttachments = Boolean(
          supportsVisualInputs &&
          parsedStage?.includeSchemeImageAttachments === true &&
          hasAuxiliaryAllowedInput(candidate, 'scheme_images')
        )
        const allowedSchemeFileIds = hasAuxiliaryAllowedInput(candidate, 'scheme_files')
          ? normalizeStringArray(parsedStage?.allowedSchemeFileIds)
          : []
        const upstreamStageIds = hasAuxiliaryAllowedInput(candidate, 'upstream_results')
          ? requestedUpstreamStageIds
          : []
        const candidateOutputFormats = normalizeAuxiliaryOutputFormats(candidate)
        const parsedOutputFormats = normalizeCanvasTargetOutputFormats(
          Array.isArray(parsedStage?.expectedOutputFormats)
            ? parsedStage.expectedOutputFormats
            : typeof parsedStage?.expectedOutputFormat === 'string'
              ? [parsedStage.expectedOutputFormat]
              : []
        )
        const expectedOutputFormats = Array.from(
          new Set([...candidateOutputFormats, ...parsedOutputFormats])
        )
        const stageId =
          typeof parsedStage?.id === 'string' && parsedStage.id.trim()
            ? parsedStage.id.trim()
            : `stage-${index + 1}-${candidate.candidateId || candidate.id}`

        normalizedStages.push({
          id: stageId,
          label:
            typeof parsedStage?.label === 'string' &&
            parsedStage.label.trim() &&
            !looksLikeCorruptedCanvasLabel(parsedStage.label.trim())
              ? parsedStage.label.trim()
              : `Stage ${index + 1}: ${candidate.label}`,
          candidateId: candidate.candidateId,
          modelId: candidate.id,
          prompt: normalizedPrompt,
          referenceNotes: normalizedReferenceNotes,
          allowedSchemeFileIds,
          upstreamStageIds,
          responsibilityType: candidate.responsibilityType,
          allowedAuxiliaryInputs: normalizedAllowedInputs,
          expectedOutputFormats,
          expectedOutputFormat: candidate.outputFormat || parsedOutputFormats[0],
          includeSourceAttachments,
          includeSelectionSnapshot,
          includeSchemeImageAttachments
        })
      })

      return normalizedStages
    })(),
    capabilityActions: normalizedCapabilityActions,
    finalPresentation: normalizeCanvasTargetFinalPresentation(
      parsed.finalPresentation || parsedRecord.final_presentation || parsedRecord.presentation,
      fallbackPlan.finalPresentation
    ),
    rawResponse: guardCanvasTargetTextForUi(rawResponse, {
      kind: 'response'
    })
  }
}

export function applyCanvasTargetEvidenceModeToControlPlan(
  plan: CanvasTargetControlPlan,
  evidenceMode: CanvasTargetEvidenceMode = DEFAULT_CANVAS_TARGET_EVIDENCE_MODE
): CanvasTargetControlPlan {
  const normalizedMode = normalizeCanvasTargetEvidenceMode(evidenceMode)
  if (normalizedMode === 'selected_sources') {
    return plan
  }

  return {
    ...plan,
    stageInstructions: plan.stageInstructions.map((stage) => ({
      ...stage,
      includeSourceAttachments: false,
      ...(normalizedMode === 'structured_only' ? { includeSelectionSnapshot: false } : {})
    }))
  }
}

export function buildCanvasTargetContextPack({
  scheme,
  projectId,
  projectName,
  targetItems,
  groups,
  snapshotDataUrl,
  assetMetadata,
  traceReferences,
  evidenceMode,
  preferredLanguage,
  getItemBounds,
  now = new Date()
}: BuildCanvasTargetContextPackOptions): CanvasTargetContextPack {
  const designContext = buildDesignInspectionContextPack({
    task: buildCanvasTargetTask(scheme),
    projectId,
    projectName,
    targetItems,
    groups,
    snapshotDataUrl,
    getItemBounds,
    now
  })

  const relatedGroups = groups.filter((group) =>
    designContext.selection.groupIds.includes(group.id)
  )

  return {
    id: createCanvasTargetId('canvas-target-context'),
    createdAt: now.toISOString(),
    projectId,
    projectName,
    task: designContext.task,
    scheme: {
      id: scheme.id,
      name: scheme.name,
      description: scheme.description
    },
    schemeFiles: scheme.files.map((file) => ({
      ...file,
      attachmentUrl: file.attachmentUrl ? `attached://${file.name}` : undefined
    })),
    traceReferences: traceReferences
      ?.filter(
        (reference) =>
          reference.referencePack?.runtimePolicy.allowTargetReference !== false &&
          reference.runtimePolicy?.allowTargetReference !== false
      )
      .slice(0, 4)
      .map((reference) => ({
        ...reference,
        contentPreview:
          truncateText(reference.referencePack?.contentBrief || reference.contentPreview, 1400) ||
          '',
        ...(reference.referencePack
          ? {
              referencePack: {
                ...reference.referencePack,
                contentBrief: truncateText(reference.referencePack.contentBrief, 1400) || '',
                softwareRules: reference.referencePack.softwareRules.slice(0, 6),
                ...(reference.referencePack.semanticRules?.length
                  ? { semanticRules: reference.referencePack.semanticRules.slice(0, 4) }
                  : {}),
                unsupportedNotes: reference.referencePack.unsupportedNotes.slice(0, 4),
                safetyNotes: reference.referencePack.safetyNotes.slice(0, 6)
              }
            }
          : {})
      })),
    designContext,
    rawScene: {
      items: targetItems.map((item) => sanitizeCanvasItemForCheckContext(item)),
      groups: relatedGroups.map((group) => ({
        id: group.id,
        name: group.name,
        itemIds: [...group.itemIds],
        createdAt: group.createdAt,
        defaultIndex: group.defaultIndex,
        provenance: group.provenance ?? null
      }))
    },
    assetMetadata: assetMetadata ?? targetItems.map((item) => buildCanvasTargetAssetMetadata(item)),
    canvasSnapshot: designContext.canvasSnapshot,
    evidencePolicy: resolveCanvasTargetEvidencePolicy(
      evidenceMode || DEFAULT_CANVAS_TARGET_EVIDENCE_MODE,
      preferredLanguage
    )
  }
}

export async function requestCanvasTargetControlPlan({
  scheme,
  contextPack,
  llmProxy,
  attachments,
  userIntent,
  profileId,
  reasoningEffort,
  preferExactProfile = false,
  preferredLanguage,
  stageProfiles,
  runtimeCapabilities
}: RequestCanvasTargetControlPlanOptions): Promise<CanvasTargetControlPlan> {
  const fallbackPlan = buildFallbackControlPlan(scheme)

  if (!llmProxy) {
    return {
      ...fallbackPlan,
      fallbackReason: 'LLM service unavailable'
    }
  }

  try {
    const profilesResponse = await llmProxy.listProfiles({})
    const selectedProfile = selectCanvasTargetProfile(
      profilesResponse.profiles,
      profileId,
      preferExactProfile
    )

    if (!selectedProfile) {
      return {
        ...fallbackPlan,
        fallbackReason: profileId
          ? `Requested LLM profile unavailable: ${profileId}`
          : 'No available LLM profile'
      }
    }

    if (selectedProfile.is_ocr_model) {
      return {
        ...fallbackPlan,
        modelId: selectedProfile.id
      }
    }

    const preparedAttachments = await prepareCanvasTargetAttachmentsForProfile(
      attachments,
      selectedProfile
    )

    const response = await llmProxy.chat({
      profileId: selectedProfile.id,
      reasoningEffort,
      messages: [
        {
          role: 'user',
          content: buildCanvasTargetControlPlanPrompt(
            scheme,
            contextPack,
            userIntent,
            stageProfiles,
            preferredLanguage,
            runtimeCapabilities
          ),
          attachments: preparedAttachments
        }
      ]
    })

    if (!response?.content?.trim()) {
      return {
        ...fallbackPlan,
        modelId: selectedProfile.id,
        fallbackReason: 'Empty LLM response'
      }
    }

    return normalizeControlPlan(
      response.content,
      fallbackPlan,
      stageProfiles,
      selectedProfile.id,
      runtimeCapabilities
    )
  } catch (error) {
    return {
      ...fallbackPlan,
      fallbackReason: normalizeCanvasTargetLlmError(error)
    }
  }
}
