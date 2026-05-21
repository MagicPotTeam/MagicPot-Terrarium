import type { Api } from '@shared/api'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { Config } from '@shared/config/config'
import type { FileItem, Workflow } from '@shared/comfy/types'
import { fileItemToValue } from '@shared/comfy/funcs'
import type { QAppCfg, QAppCfgAuto, QAppCfgInput, QAppCfgInputLLMAPI } from '@shared/qApp/cfgTypes'
import type { ResultItem } from '@shared/qApp/resultTypes'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import type { JsonDict, JsonValue } from '@shared/utils/utilTypes'
import { valueIsJsonDict } from '@shared/utils/utilTypes'
import { guessMimeTypeFromFileName } from '@renderer/utils/fileDisplay'
import { findQAppApiProfile } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/qAppApiProfiles'
import {
  isQAppLlmProfileUsableInWorkflow,
  resolveQAppLlmProfileSlotValues
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/qAppLlmProfileSlots'
import { transformResults } from '../QuickAppPage/ResultList/resultTransformers'
import { dispatchQAppResultsToCanvas } from '../QuickAppPage/utils/qAppCanvasDispatch'
import { buildQAppSubmitWorkflowRequest } from '../QuickAppPage/utils/qAppSubmitWorkflow'
import { waitForQAppPromptResult } from '../QuickAppPage/utils/qAppPromptResult'
import { createSecureIdSegment, createSecureRandomUint32 } from './secureId'
import type {
  CanvasTargetOutputTarget,
  CanvasTargetQuickAppAction,
  CanvasTargetQuickAppInputAssignment
} from './canvasTargetCapabilities'
import type { CanvasItem } from './types'

type CanvasTargetQuickAppSourceAttachments = {
  sourceAttachments: ChatAttachment[]
  snapshotAttachment?: ChatAttachment | null
  upstreamAttachments?: ChatAttachment[]
}

type ResolvedQuickAppInputAssignment = {
  assignment?: CanvasTargetQuickAppInputAssignment
  assignmentIndex?: number
}

export type CanvasTargetQuickAppRunResult = {
  qAppKey: string
  qAppName: string
  promptId?: string
  content: string
  attachments: ChatAttachment[]
  resultItems: ResultItem[]
  canvasDispatchCount: number
  placedCanvasItemIds: string[]
  placedCanvasItems: CanvasItem[]
}

export type RunCanvasTargetQuickAppActionOptions = CanvasTargetQuickAppSourceAttachments & {
  action: CanvasTargetQuickAppAction
  api: Pick<Api, 'svcQApp' | 'svcComfy'>
  config: Config
  projectId?: string
  userIntent: string
  controlProfileId?: string | null
  generationSessionId?: string
  resolvedInputAssignmentAttachments?: ChatAttachment[][]
}

const cloneWorkflow = (workflow: Workflow): Workflow =>
  JSON.parse(JSON.stringify(workflow)) as Workflow

const toWorkflowJson = (workflow: Workflow): JsonDict => workflow as unknown as JsonDict

const normalizeLabelKey = (value: string | undefined): string => value?.trim().toLowerCase() || ''

const randomSeed = () => createSecureRandomUint32()

const looksLikeTransferableUrl = (value: string): boolean =>
  /^(data|blob|https?|file|local-media):/i.test(value.trim())

const getAssignmentValue = (
  assignment: CanvasTargetQuickAppInputAssignment | undefined,
  sources: CanvasTargetQuickAppSourceAttachments,
  userIntent: string
): JsonValue | undefined => {
  if (!assignment) return undefined
  if (assignment.value !== undefined) return assignment.value

  switch (assignment.source) {
    case 'user_intent':
      return userIntent
    case 'selection_snapshot':
      return sources.snapshotAttachment?.url
    case 'first_source_image':
      return sources.sourceAttachments.find((attachment) => attachment.type === 'image')?.url
    case 'first_source_video':
      return sources.sourceAttachments.find((attachment) => attachment.type === 'video')?.url
    case 'first_source_asset':
      return sources.sourceAttachments[0]?.url
    case 'first_upstream_image':
      return sources.upstreamAttachments?.find((attachment) => attachment.type === 'image')?.url
    case 'first_upstream_video':
      return sources.upstreamAttachments?.find((attachment) => attachment.type === 'video')?.url
    case 'first_upstream_asset':
      return sources.upstreamAttachments?.[0]?.url
    default:
      return undefined
  }
}

const hasSlot = (value: QAppCfgInput): value is QAppCfgInput & { slot: string } =>
  'slot' in value && typeof value.slot === 'string' && value.slot.trim().length > 0

const hasMediaReferenceAssignment = (
  assignment: CanvasTargetQuickAppInputAssignment | undefined
): boolean =>
  Boolean(
    assignment &&
    (assignment.value !== undefined ||
      assignment.source ||
      assignment.sourceStageId ||
      assignment.sourceStageIds?.length ||
      assignment.artifactId ||
      assignment.artifactIds?.length ||
      assignment.itemIds?.length)
  )

const hasExplicitReferenceAssignment = (
  assignment: CanvasTargetQuickAppInputAssignment | undefined
): boolean =>
  Boolean(
    assignment &&
    (assignment.sourceStageId?.trim() ||
      assignment.sourceStageIds?.some((stageId) => stageId.trim()) ||
      assignment.artifactId?.trim() ||
      assignment.artifactIds?.some((artifactId) => artifactId.trim()) ||
      assignment.itemIds?.some((itemId) => itemId.trim()))
  )

const resolveAssignmentForInput = (
  input: QAppCfgInput,
  assignments: CanvasTargetQuickAppInputAssignment[]
): ResolvedQuickAppInputAssignment => {
  if (hasSlot(input)) {
    const bySlotIndex = assignments.findIndex((assignment) => assignment.slot === input.slot)
    if (bySlotIndex >= 0) {
      return {
        assignment: assignments[bySlotIndex],
        assignmentIndex: bySlotIndex
      }
    }
  }

  const labelKey = normalizeLabelKey(input.label)
  if (labelKey) {
    const byLabelIndex = assignments.findIndex(
      (assignment) => normalizeLabelKey(assignment.label) === labelKey
    )
    if (byLabelIndex >= 0) {
      return {
        assignment: assignments[byLabelIndex],
        assignmentIndex: byLabelIndex
      }
    }
  }

  if (input.component === 'InputComfyImage' || input.component === 'InputComfyVideo') {
    const byMediaIndex = assignments.findIndex(hasMediaReferenceAssignment)
    return byMediaIndex >= 0
      ? {
          assignment: assignments[byMediaIndex],
          assignmentIndex: byMediaIndex
        }
      : {}
  }

  return {}
}

const resolveLlmSlots = (
  cfg: QAppCfgInputLLMAPI | Extract<QAppCfgAuto, { component: 'AutoLLMAPI' }>,
  workflow: Workflow
): [string, string, string, string] => {
  if (cfg.seperateSlots) {
    return [cfg.modelNameSlot, cfg.baseUrlSlot, cfg.apiKeySlot, cfg.isOllamaSlot]
  }

  const nodeSlot = cfg.nodeSlot
  if (!nodeSlot) {
    throw new Error('QuickApp LLM API nodeSlot is missing.')
  }

  const llmLoaderNode = getJsonPath(nodeSlot, workflow as unknown as JsonValue)
  if (
    !valueIsJsonDict(llmLoaderNode) ||
    !('inputs' in llmLoaderNode) ||
    !valueIsJsonDict(llmLoaderNode.inputs)
  ) {
    throw new Error(`QuickApp LLM API nodeSlot is not a valid node: ${nodeSlot}`)
  }

  return [
    `${nodeSlot}.inputs.model_name`,
    `${nodeSlot}.inputs.base_url`,
    `${nodeSlot}.inputs.api_key`,
    `${nodeSlot}.inputs.is_ollama`
  ]
}

const applyLlmProfileSlots = (
  workflow: Workflow,
  cfg: QAppCfgInputLLMAPI | Extract<QAppCfgAuto, { component: 'AutoLLMAPI' }>,
  config: Config,
  preferredProfileId?: string | null
) => {
  const profile = findQAppApiProfile(config, {
    needVisionModel: Boolean(cfg.needVisionModel),
    profileId: preferredProfileId || undefined
  })

  if (!profile || !isQAppLlmProfileUsableInWorkflow(config, profile)) {
    throw new Error('QuickApp API profile is not configured for this workflow.')
  }

  const [modelNameSlot, baseUrlSlot, apiKeySlot, isOllamaSlot] = resolveLlmSlots(cfg, workflow)
  const slotValues = resolveQAppLlmProfileSlotValues(config, profile)
  const workflowJson = toWorkflowJson(workflow)

  setJsonPath(modelNameSlot, workflowJson, slotValues.modelName)
  setJsonPath(baseUrlSlot, workflowJson, slotValues.baseUrl)
  setJsonPath(apiKeySlot, workflowJson, slotValues.apiKey)
  setJsonPath(isOllamaSlot, workflowJson, slotValues.isOllama)
}

const fileNameFromAttachment = (
  attachment: ChatAttachment,
  fallback: string,
  expectedExtension: string
): string => {
  const fileName = attachment.fileName?.trim()
  if (fileName) return fileName
  return `${fallback}${expectedExtension}`
}

const readAttachmentBytes = async (attachment: ChatAttachment): Promise<Uint8Array> => {
  const response = await fetch(attachment.url)
  if (!response.ok) {
    throw new Error(`Failed to read attachment (${response.status})`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

const uploadAttachmentForQApp = async (
  api: Pick<Api, 'svcComfy'>,
  attachment: ChatAttachment,
  fallbackName: string,
  expectedExtension: string
): Promise<FileItem> => {
  const image = await readAttachmentBytes(attachment)
  const fileName = fileNameFromAttachment(attachment, fallbackName, expectedExtension)
  const uploadResult = await api.svcComfy.uploadImage({
    fileItem: { filename: fileName, type: 'input' },
    image
  })

  if (!uploadResult.filename) {
    throw new Error(`QuickApp upload did not return a filename for ${fileName}.`)
  }

  return uploadResult
}

const pickAttachmentForSource = (
  source: CanvasTargetQuickAppInputAssignment['source'] | undefined,
  sources: CanvasTargetQuickAppSourceAttachments,
  expectedType: ChatAttachment['type']
): ChatAttachment | undefined => {
  switch (source) {
    case 'selection_snapshot':
      return sources.snapshotAttachment?.type === expectedType
        ? sources.snapshotAttachment
        : undefined
    case 'first_source_video':
      return sources.sourceAttachments.find((attachment) => attachment.type === 'video')
    case 'first_source_image':
      return sources.sourceAttachments.find((attachment) => attachment.type === 'image')
    case 'first_source_asset':
      return sources.sourceAttachments.find((attachment) => attachment.type === expectedType)
    case 'first_upstream_video':
      return sources.upstreamAttachments?.find((attachment) => attachment.type === 'video')
    case 'first_upstream_image':
      return sources.upstreamAttachments?.find((attachment) => attachment.type === 'image')
    case 'first_upstream_asset':
      return sources.upstreamAttachments?.find((attachment) => attachment.type === expectedType)
    default:
      return sources.sourceAttachments.find((attachment) => attachment.type === expectedType)
  }
}

const createAssignedUrlAttachment = (
  expectedType: 'image' | 'video',
  url: string,
  fallbackName: string,
  extension: string,
  mimeType: string
): ChatAttachment => ({
  type: expectedType,
  url,
  fileName: `${fallbackName}${extension}`,
  mimeType
})

const getResolvedAssignmentAttachments = (
  options: RunCanvasTargetQuickAppActionOptions,
  assignmentIndex: number | undefined
): ChatAttachment[] => {
  if (assignmentIndex == null) return []
  return options.resolvedInputAssignmentAttachments?.[assignmentIndex] || []
}

const describeExplicitReferenceAssignment = (
  assignment: CanvasTargetQuickAppInputAssignment | undefined
): string => {
  if (!assignment) return 'none'
  return [
    assignment.sourceStageId ? `sourceStageId=${assignment.sourceStageId}` : null,
    ...(assignment.sourceStageIds || []).map((stageId) => `sourceStageId=${stageId}`),
    assignment.artifactId ? `artifactId=${assignment.artifactId}` : null,
    ...(assignment.artifactIds || []).map((artifactId) => `artifactId=${artifactId}`),
    ...(assignment.itemIds || []).map((itemId) => `itemId=${itemId}`)
  ]
    .filter(Boolean)
    .join(', ')
}

const resolveAssignedMediaAttachment = (
  assignment: CanvasTargetQuickAppInputAssignment | undefined,
  options: RunCanvasTargetQuickAppActionOptions,
  expectedType: 'image' | 'video',
  mediaIndex: number,
  assignmentIndex: number | undefined
): ChatAttachment | undefined => {
  const assignedValue = getAssignmentValue(assignment, options, options.userIntent)
  const assignedUrl =
    typeof assignedValue === 'string' && looksLikeTransferableUrl(assignedValue)
      ? assignedValue.trim()
      : undefined

  if (assignedUrl) {
    return createAssignedUrlAttachment(
      expectedType,
      assignedUrl,
      expectedType === 'image'
        ? `target-qapp-image-${mediaIndex + 1}`
        : `target-qapp-video-${mediaIndex + 1}`,
      expectedType === 'image' ? '.png' : '.mp4',
      expectedType === 'image' ? 'image/png' : 'video/mp4'
    )
  }

  if (hasExplicitReferenceAssignment(assignment)) {
    return getResolvedAssignmentAttachments(options, assignmentIndex).find(
      (attachment) => attachment.type === expectedType
    )
  }

  if (assignment?.source) {
    return pickAttachmentForSource(assignment.source, options, expectedType)
  }

  return options.sourceAttachments.filter((attachment) => attachment.type === expectedType)[
    mediaIndex
  ]
}

const buildMissingAssignedMediaMessage = (
  expectedType: 'image' | 'video',
  assignment: CanvasTargetQuickAppInputAssignment | undefined
): string => {
  if (hasExplicitReferenceAssignment(assignment)) {
    return `QuickApp ${expectedType} input references ${describeExplicitReferenceAssignment(
      assignment
    )}, but no matching ${expectedType} attachment was resolved.`
  }
  return expectedType === 'image'
    ? 'QuickApp image input requires a selected image or selection snapshot.'
    : 'QuickApp video input requires a selected video.'
}

const applyImageInput = async (
  workflow: Workflow,
  slot: string,
  assignment: CanvasTargetQuickAppInputAssignment | undefined,
  options: RunCanvasTargetQuickAppActionOptions,
  imageIndex: number,
  assignmentIndex: number | undefined
) => {
  const workflowJson = toWorkflowJson(workflow)
  const attachment = resolveAssignedMediaAttachment(
    assignment,
    options,
    'image',
    imageIndex,
    assignmentIndex
  )

  if (!attachment) {
    throw new Error(buildMissingAssignedMediaMessage('image', assignment))
  }

  const uploadResult = await uploadAttachmentForQApp(
    options.api,
    attachment,
    `target-qapp-image-${imageIndex + 1}`,
    '.png'
  )
  setJsonPath(slot, workflowJson, fileItemToValue(uploadResult))
}

const applyVideoInput = async (
  workflow: Workflow,
  slot: string,
  assignment: CanvasTargetQuickAppInputAssignment | undefined,
  options: RunCanvasTargetQuickAppActionOptions,
  videoIndex: number,
  assignmentIndex: number | undefined
) => {
  const workflowJson = toWorkflowJson(workflow)
  const attachment = resolveAssignedMediaAttachment(
    assignment,
    options,
    'video',
    videoIndex,
    assignmentIndex
  )

  if (!attachment) {
    throw new Error(buildMissingAssignedMediaMessage('video', assignment))
  }

  const uploadResult = await uploadAttachmentForQApp(
    options.api,
    attachment,
    `target-qapp-video-${videoIndex + 1}`,
    '.mp4'
  )
  setJsonPath(slot, workflowJson, fileItemToValue(uploadResult))
}

const applyStructuredInputAssignment = (
  input: QAppCfgInput,
  workflow: Workflow,
  assignment: CanvasTargetQuickAppInputAssignment | undefined,
  options: RunCanvasTargetQuickAppActionOptions
): boolean => {
  const assignedValue = getAssignmentValue(assignment, options, options.userIntent)
  if (assignedValue === undefined) return false

  const workflowJson = toWorkflowJson(workflow)

  if (input.component === 'InputImageSize' && assignedValue && typeof assignedValue === 'object') {
    const value = assignedValue as Record<string, unknown>
    const width = typeof value.width === 'number' ? value.width : undefined
    const height = typeof value.height === 'number' ? value.height : undefined
    if (input.seperateSlots && width && height) {
      setJsonPath(input.widthSlot, workflowJson, width)
      setJsonPath(input.heightSlot, workflowJson, height)
      return true
    }
    if (!input.seperateSlots && input.nodeSlot && width && height) {
      setJsonPath(`${input.nodeSlot}.inputs.width`, workflowJson, width)
      setJsonPath(`${input.nodeSlot}.inputs.height`, workflowJson, height)
      return true
    }
  }

  if (input.component === 'InputCamera3D' && assignedValue && typeof assignedValue === 'object') {
    const value = assignedValue as Record<string, unknown>
    if (typeof value.horizontal === 'number') {
      setJsonPath(input.horizontalSlot, workflowJson, value.horizontal)
    }
    if (typeof value.vertical === 'number') {
      setJsonPath(input.verticalSlot, workflowJson, value.vertical)
    }
    if (typeof value.zoom === 'number') {
      setJsonPath(input.zoomSlot, workflowJson, value.zoom)
    }
    return true
  }

  if (hasSlot(input)) {
    setJsonPath(input.slot, workflowJson, assignedValue)
    return true
  }

  return false
}

const applyQuickAppInputs = async (
  cfg: QAppCfg,
  workflow: Workflow,
  options: RunCanvasTargetQuickAppActionOptions
) => {
  let imageInputIndex = 0
  let videoInputIndex = 0

  for (const input of cfg.inputs) {
    if (input.component === 'Section' || input.component === 'Description') {
      continue
    }

    const resolvedAssignment = resolveAssignmentForInput(input, options.action.inputAssignments)
    const assignment = resolvedAssignment.assignment
    if (input.component === 'InputLLMAPI') {
      applyLlmProfileSlots(
        workflow,
        input,
        options.config,
        options.action.preferredProfileId || options.controlProfileId
      )
      continue
    }

    if (input.component === 'InputComfyImage' && hasSlot(input)) {
      await applyImageInput(
        workflow,
        input.slot,
        assignment,
        options,
        imageInputIndex,
        resolvedAssignment.assignmentIndex
      )
      imageInputIndex += 1
      continue
    }

    if (input.component === 'InputComfyVideo' && hasSlot(input)) {
      await applyVideoInput(
        workflow,
        input.slot,
        assignment,
        options,
        videoInputIndex,
        resolvedAssignment.assignmentIndex
      )
      videoInputIndex += 1
      continue
    }

    if (input.component === 'InputPrompt' && hasSlot(input)) {
      const assignedValue = getAssignmentValue(assignment, options, options.userIntent)
      const promptValue = typeof assignedValue === 'string' ? assignedValue : options.userIntent
      setJsonPath(
        input.slot,
        toWorkflowJson(workflow),
        input.suffixPrompt ? `${promptValue}, ${input.suffixPrompt}` : promptValue
      )
      continue
    }

    if (input.component === 'InputText' && hasSlot(input)) {
      const assignedValue = getAssignmentValue(assignment, options, options.userIntent)
      setJsonPath(
        input.slot,
        toWorkflowJson(workflow),
        typeof assignedValue === 'string' ? assignedValue : options.userIntent
      )
      continue
    }

    if (input.component === 'InputSeed' && hasSlot(input)) {
      const assignedValue = getAssignmentValue(assignment, options, options.userIntent)
      setJsonPath(
        input.slot,
        toWorkflowJson(workflow),
        typeof assignedValue === 'number' ? assignedValue : randomSeed()
      )
      continue
    }

    applyStructuredInputAssignment(input, workflow, assignment, options)
  }

  for (const input of cfg.autoInputs || []) {
    if (input.component === 'AutoSeed') {
      setJsonPath(input.slot, toWorkflowJson(workflow), randomSeed())
      continue
    }

    if (input.component === 'AutoLLMAPI') {
      applyLlmProfileSlots(
        workflow,
        input,
        options.config,
        options.action.preferredProfileId || options.controlProfileId
      )
    }
  }
}

const formatQAppHistoryError = (result: Awaited<ReturnType<typeof waitForQAppPromptResult>>) => {
  const messages = result.status.messages
    .map((message) => {
      if (message[0] === 'prompt_error') {
        return message[1].error?.message
      }
      if (message[0] === 'execution_error') {
        return message[1].exception_message
      }
      return undefined
    })
    .filter(Boolean)

  return messages.join('; ') || 'QuickApp workflow execution failed.'
}

const summarizeResultItems = (items: ResultItem[]) => {
  let imageCount = 0
  let videoCount = 0
  let textCount = 0

  for (const item of items) {
    if (item.type === 'image') imageCount += 1
    if (item.type === 'video') videoCount += 1
    if (item.type === 'text' || item.type === 'texts') textCount += 1
  }

  return [
    imageCount > 0 ? `${imageCount} image(s)` : null,
    videoCount > 0 ? `${videoCount} video(s)` : null,
    textCount > 0 ? `${textCount} text result(s)` : null
  ]
    .filter(Boolean)
    .join(', ')
}

const buildTextFromResultItems = (items: ResultItem[]): string => {
  const lines: string[] = []

  for (const item of items) {
    if (item.type === 'text') {
      lines.push(item.text)
      continue
    }
    if (item.type === 'texts') {
      lines.push(...item.resultItems.map((entry) => entry.text))
    }
  }

  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n\n')
}

const resultItemToAttachment = (item: ResultItem): ChatAttachment | null => {
  if (item.type === 'image') {
    return {
      type: 'image',
      url: item.objectUrl,
      fileName: item.fileItem.filename,
      mimeType: guessMimeTypeFromFileName(item.fileItem.filename, 'image/png'),
      sourceWidth: item.sourceWidth,
      sourceHeight: item.sourceHeight
    }
  }

  if (item.type === 'video') {
    return {
      type: 'video',
      url: item.objectUrl,
      fileName: item.fileItem.filename,
      mimeType: guessMimeTypeFromFileName(item.fileItem.filename, 'video/mp4')
    }
  }

  return null
}

const shouldDispatchQAppResultToCanvas = (
  outputTarget: CanvasTargetOutputTarget,
  resultItems: ResultItem[]
): boolean => {
  if (outputTarget === 'canvas' || outputTarget === 'both') {
    return true
  }
  if (outputTarget === 'agent') {
    return false
  }
  return resultItems.some((item) => item.type === 'image' || item.type === 'video')
}

const isCanvasItemLike = (value: unknown): value is CanvasItem => {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.type === 'string'
}

const waitForCanvasPlacementCallbacks = (
  expectedCount: number,
  placedItems: CanvasItem[],
  timeoutMs = 5000
): Promise<void> => {
  if (expectedCount <= 0 || placedItems.length >= expectedCount) return Promise.resolve()

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const check = () => {
      if (placedItems.length >= expectedCount || Date.now() - startedAt >= timeoutMs) {
        resolve()
        return
      }
      window.setTimeout(check, 25)
    }
    check()
  })
}

const dispatchQAppResultsToCanvasAndWait = async (
  resultItems: ResultItem[],
  projectId?: string,
  generationSessionId?: string
): Promise<{ totalCount: number; placedCanvasItems: CanvasItem[] }> => {
  const placedCanvasItems: CanvasItem[] = []
  const counts = dispatchQAppResultsToCanvas(resultItems, projectId, generationSessionId, {
    onCanvasItemAdded: (item) => {
      if (isCanvasItemLike(item)) {
        placedCanvasItems.push(item)
      }
    }
  })
  await waitForCanvasPlacementCallbacks(counts.totalCount, placedCanvasItems)
  return {
    totalCount: counts.totalCount,
    placedCanvasItems
  }
}

export async function runCanvasTargetQuickAppAction(
  options: RunCanvasTargetQuickAppActionOptions
): Promise<CanvasTargetQuickAppRunResult> {
  const qAppResponse = await options.api.svcQApp.getQAppCfg({ key: options.action.qAppKey })
  const workflow = cloneWorkflow(qAppResponse.workflow)
  await applyQuickAppInputs(qAppResponse.cfg, workflow, options)

  const { prompt_id: promptId } = await options.api.svcComfy.submitWorkflow(
    buildQAppSubmitWorkflowRequest({
      prompt: workflow,
      qAppKey: options.action.qAppKey,
      sessionKey:
        options.generationSessionId ||
        `canvas-target-${options.projectId || 'canvas'}-${Date.now()}-${createSecureIdSegment()}`
    })
  )

  const result = await waitForQAppPromptResult(options.api.svcComfy, promptId)
  if (result.status.status_str === 'error') {
    throw new Error(formatQAppHistoryError(result))
  }

  const resultItems = await transformResults(promptId, result, qAppResponse.cfg.outputNodeIds)
  const canvasDispatch = shouldDispatchQAppResultToCanvas(options.action.outputTarget, resultItems)
    ? await dispatchQAppResultsToCanvasAndWait(
        resultItems,
        options.projectId,
        options.generationSessionId
      )
    : {
        totalCount: 0,
        placedCanvasItems: []
      }
  const canvasDispatchCount = canvasDispatch.totalCount
  const attachments = resultItems
    .map((item) => resultItemToAttachment(item))
    .filter((entry): entry is ChatAttachment => Boolean(entry))
  const text = buildTextFromResultItems(resultItems)
  const summary = summarizeResultItems(resultItems)

  return {
    qAppKey: options.action.qAppKey,
    qAppName: qAppResponse.manifest?.name || options.action.label || options.action.qAppKey,
    promptId,
    content: [
      `QuickApp "${qAppResponse.manifest?.name || options.action.qAppKey}" completed.`,
      summary ? `Generated: ${summary}.` : null,
      canvasDispatchCount > 0
        ? `Placed ${canvasDispatchCount} media result(s) on the canvas.`
        : null,
      text
    ]
      .filter(Boolean)
      .join('\n\n'),
    attachments,
    resultItems,
    canvasDispatchCount,
    placedCanvasItemIds: canvasDispatch.placedCanvasItems.map((item) => item.id),
    placedCanvasItems: canvasDispatch.placedCanvasItems
  }
}
