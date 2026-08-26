import type { ObjectInfo, ObjectInfoMap, Workflow, WorkflowNode } from '@shared/comfy/types'
import type { QAppCfg } from './cfgTypes'

export type QAppBatchNormalization = {
  cfg: QAppCfg
  imageInputCandidates: string[]
  outputNodeCandidates: string[]
  imageInputSlot?: string
  outputNodeIds: string[]
  canBatch: boolean
}

const OUTPUT_NODE_CLASS_TYPES = new Set(['SaveImage', 'PreviewImage'])
const BATCH_SLOT_PATTERN = /^\$\.([^.[\]]+)\.inputs\.([^.[\]]+)$/

const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)))

/**
 * Return image slots explicitly configured in the QApp input section.
 *
 * These slots are the source of truth for the designer.  They must not depend
 * on ComfyUI object-info being available: a QApp can be designed while the
 * backend is disconnected, and the input component already declares that the
 * field is an image upload.
 */
export const getQAppImageInputSlots = (cfg: QAppCfg): string[] =>
  unique(
    (cfg.inputs || [])
      .filter(
        (input) =>
          input.component === 'InputComfyImage' || input.component === 'InputComfyImageMask'
      )
      .map((input) => ('slot' in input && typeof input.slot === 'string' ? input.slot : ''))
  )

const getInputFieldInfo = (
  objectInfo: ObjectInfo | undefined,
  field: string
): [unknown, unknown] | undefined =>
  objectInfo?.input?.required?.[field] ?? objectInfo?.input?.optional?.[field]

const isImageUploadField = (
  node: WorkflowNode,
  field: string,
  objectInfos: ObjectInfoMap
): boolean => {
  const objectInfo = objectInfos[node.class_type]
  const fieldInfo = getInputFieldInfo(objectInfo, field)
  if (objectInfo) {
    if (!Array.isArray(fieldInfo) || fieldInfo.length < 2) return false
    const options = fieldInfo[1]
    return (
      typeof options === 'object' &&
      options !== null &&
      (options as { image_upload?: unknown }).image_upload === true
    )
  }
  return node.class_type === 'LoadImage' && field === 'image'
}

const parseWorkflowSlot = (
  slot: string | undefined,
  workflow: Workflow
): { nodeId: string; field: string } | null => {
  if (!slot) return null
  const match = BATCH_SLOT_PATTERN.exec(slot)
  if (!match) return null
  const [, nodeId, field] = match
  const node = workflow[nodeId]
  if (!node || !Object.prototype.hasOwnProperty.call(node.inputs, field)) return null
  return { nodeId, field }
}

const parseDeclaredImageSlot = (
  slot: string | undefined,
  workflow: Workflow,
  objectInfos: ObjectInfoMap
): { nodeId: string; field: string } | null => {
  const parsed = parseWorkflowSlot(slot, workflow)
  if (!parsed) return null
  // If object-info for this custom node is unavailable, trust the explicit
  // QApp input declaration. The batch runner performs the authoritative
  // remote object-info validation before executing.
  const node = workflow[parsed.nodeId]
  if (!objectInfos[node.class_type]) return parsed
  return isImageUploadField(node, parsed.field, objectInfos) ? parsed : null
}

const formatSlot = (nodeId: string, field: string): string => `$.${nodeId}.inputs.${field}`

export const getValidQAppImageInputSlots = (
  cfg: QAppCfg,
  workflow: Workflow,
  objectInfos: ObjectInfoMap = {}
): string[] =>
  getQAppImageInputSlots(cfg).filter(
    (slot) => parseDeclaredImageSlot(slot, workflow, objectInfos) !== null
  )

const isOutputNode = (node: WorkflowNode, objectInfos: ObjectInfoMap): boolean => {
  if (OUTPUT_NODE_CLASS_TYPES.has(node.class_type)) return true
  const objectInfo = objectInfos[node.class_type]
  return (
    objectInfo?.output_node === true ||
    objectInfo?.output?.some((outputType) => outputType === 'IMAGE') === true
  )
}

function findImageInputCandidates(
  cfg: QAppCfg,
  workflow: Workflow,
  objectInfos: ObjectInfoMap
): string[] {
  // An explicit InputComfyImage/InputComfyImageMask entry is the designer's
  // source of truth. When object-info is available, still discard a slot that
  // is not actually an image-upload field; while disconnected, preserve the
  // explicit declaration so legacy QApps remain usable.
  const configuredInputs = getQAppImageInputSlots(cfg).filter(
    (slot) => parseDeclaredImageSlot(slot, workflow, objectInfos) !== null
  )

  if (configuredInputs.length > 0) return unique(configuredInputs)

  const candidates: string[] = []
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node?.inputs) continue
    for (const field of Object.keys(node.inputs)) {
      if (isImageUploadField(node, field, objectInfos)) {
        candidates.push(formatSlot(nodeId, field))
      }
    }
  }
  return unique(candidates)
}

function findOutputNodeCandidates(workflow: Workflow, objectInfos: ObjectInfoMap): string[] {
  return Object.entries(workflow)
    .filter(([, node]) => isOutputNode(node, objectInfos))
    .map(([nodeId]) => nodeId)
}

function validConfiguredOutputIds(
  cfg: QAppCfg,
  workflow: Workflow,
  objectInfos: ObjectInfoMap
): string[] {
  if (!Array.isArray(cfg.outputNodeIds)) return []
  return unique(
    cfg.outputNodeIds.filter(
      (nodeId) => Boolean(workflow[nodeId]) && isOutputNode(workflow[nodeId], objectInfos)
    )
  )
}

function chooseDefaultOutputNodeIds(candidates: string[], workflow: Workflow): string[] {
  if (candidates.length === 0) return []
  const saveImage = candidates.find((nodeId) => workflow[nodeId]?.class_type === 'SaveImage')
  if (saveImage) return [saveImage]
  const previewImage = candidates.find((nodeId) => workflow[nodeId]?.class_type === 'PreviewImage')
  if (previewImage) return [previewImage]
  return [candidates[0]]
}

export function normalizeQAppBatchConfig(
  cfg: QAppCfg,
  workflow: Workflow,
  objectInfos: ObjectInfoMap = {}
): QAppBatchNormalization {
  const imageInputCandidates = findImageInputCandidates(cfg, workflow, objectInfos)
  const outputNodeCandidates = findOutputNodeCandidates(workflow, objectInfos)
  const explicitImageInputSlots = getQAppImageInputSlots(cfg)
  const configuredBatchSlot =
    !explicitImageInputSlots.length ||
    explicitImageInputSlots.includes(cfg.batchProcess?.imageInputSlot || '')
      ? parseDeclaredImageSlot(cfg.batchProcess?.imageInputSlot, workflow, objectInfos)
      : null
  const imageInputSlot = configuredBatchSlot
    ? formatSlot(configuredBatchSlot.nodeId, configuredBatchSlot.field)
    : explicitImageInputSlots.length === 1 && imageInputCandidates.length === 1
      ? imageInputCandidates[0]
      : !explicitImageInputSlots.length && imageInputCandidates.length === 1
        ? imageInputCandidates[0]
        : undefined

  const hasExplicitOutputConfig = Array.isArray(cfg.outputNodeIds)
  const configuredOutputNodeIds = validConfiguredOutputIds(cfg, workflow, objectInfos)
  const outputNodeIds =
    configuredOutputNodeIds.length > 0
      ? configuredOutputNodeIds
      : hasExplicitOutputConfig
        ? []
        : chooseDefaultOutputNodeIds(outputNodeCandidates, workflow)
  const canBatch = Boolean(imageInputSlot) && outputNodeIds.length > 0
  const normalizedCfg: QAppCfg = {
    ...cfg,
    ...(outputNodeIds.length > 0
      ? { outputNodeIds }
      : hasExplicitOutputConfig
        ? { outputNodeIds: [] }
        : {}),
    ...(canBatch && imageInputSlot
      ? {
          batchProcess:
            cfg.batchProcess?.enabled === false
              ? { enabled: false, imageInputSlot }
              : { enabled: true, imageInputSlot }
        }
      : cfg.batchProcess
        ? { batchProcess: cfg.batchProcess }
        : {})
  }

  return {
    cfg: normalizedCfg,
    imageInputCandidates,
    outputNodeCandidates,
    imageInputSlot,
    outputNodeIds,
    canBatch
  }
}
