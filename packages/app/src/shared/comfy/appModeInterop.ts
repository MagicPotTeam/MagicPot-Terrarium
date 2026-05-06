import { isJsonDict, valueIsJsonDict } from '@shared/utils/utilTypes'
import { QAppCfg, QAppCfgInput } from '@shared/qApp/cfgTypes'
import { ObjectInfoInputField, ObjectInfoMap, Workflow } from './types'
import { GuiNode, GuiWorkflow, isGuiWorkflow } from './guiWorkflowToPrompt'

type AppModeMetadata = {
  inputs: [string, string][]
  outputs: string[]
}

function createEmptyQAppCfg(): QAppCfg {
  return {
    icon: '',
    inputs: [],
    autoInputs: []
  }
}

function getNodeById(gui: GuiWorkflow, nodeId: string): GuiNode | undefined {
  return gui.nodes?.find((node) => String(node.id) === nodeId)
}

function getInputFieldInfo(
  objectInfos: ObjectInfoMap,
  classType: string,
  fieldName: string
): ObjectInfoInputField | undefined {
  return (
    objectInfos[classType]?.input?.required?.[fieldName] ??
    objectInfos[classType]?.input?.optional?.[fieldName]
  )
}

function prettifyFieldName(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^\w|\s\w)/g, (match) => match.toUpperCase())
}

function isPromptLikeField(fieldName: string, fieldCfg: unknown): boolean {
  const lower = fieldName.toLowerCase()
  if (
    lower.includes('prompt') ||
    lower.includes('text') ||
    lower.includes('caption') ||
    lower.includes('instruction') ||
    lower.includes('description') ||
    lower.includes('message')
  ) {
    return true
  }
  return isJsonDict(fieldCfg) && fieldCfg.multiline === true
}

function isSeedLikeField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase()
  return lower === 'seed' || lower.endsWith('_seed') || lower === 'noise_seed'
}

function isImageInputField(node: GuiNode | undefined, fieldName: string, value: unknown): boolean {
  const lower = fieldName.toLowerCase()
  if (lower === 'image' || lower.endsWith('_image')) {
    return node?.type === 'LoadImage' || typeof value === 'string'
  }
  return false
}

function isVideoInputField(
  fieldName: string,
  value: unknown,
  fieldCfg: unknown,
  node?: GuiNode
): boolean {
  const lower = fieldName.toLowerCase()
  if (!(lower === 'video' || lower.endsWith('_video') || lower.includes('video'))) {
    return false
  }

  const meta = isJsonDict(fieldCfg) ? fieldCfg : null
  const accept = typeof meta?.accept === 'string' ? meta.accept.toLowerCase() : ''
  const mediaType = typeof meta?.media_type === 'string' ? meta.media_type.toLowerCase() : ''
  const fileType = Array.isArray(meta?.file_type)
    ? meta.file_type.map((item) => String(item).toLowerCase())
    : []

  return (
    node?.type === 'LoadVideo' ||
    typeof value === 'string' ||
    meta?.video_upload === true ||
    accept.includes('video/') ||
    accept.includes('.mp4') ||
    accept.includes('.mov') ||
    mediaType === 'video' ||
    fileType.includes('video')
  )
}

function isImageMaskInputField(node: GuiNode | undefined, fieldName: string): boolean {
  const lower = fieldName.toLowerCase()
  return node?.type === 'LoadImageMask' || lower === 'mask' || lower.endsWith('_mask')
}

function toNumberFieldCfg(fieldCfg: unknown): { min?: number; max?: number; step?: number } {
  if (!isJsonDict(fieldCfg)) {
    return {}
  }

  const parse = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined

  return {
    min: parse(fieldCfg.min),
    max: parse(fieldCfg.max),
    step: parse(fieldCfg.step)
  }
}

function buildInputLabel(
  node: GuiNode | undefined,
  fieldName: string,
  usedLabels: Set<string>
): string {
  const base = node?.title?.trim() || prettifyFieldName(fieldName)
  if (!usedLabels.has(base)) {
    usedLabels.add(base)
    return base
  }

  const withField = `${base} (${prettifyFieldName(fieldName)})`
  if (!usedLabels.has(withField)) {
    usedLabels.add(withField)
    return withField
  }

  let index = 2
  let next = `${withField} ${index}`
  while (usedLabels.has(next)) {
    index += 1
    next = `${withField} ${index}`
  }
  usedLabels.add(next)
  return next
}

function buildQAppInputForAppModeField(
  nodeId: string,
  fieldName: string,
  workflow: Workflow,
  guiNode: GuiNode | undefined,
  objectInfos: ObjectInfoMap,
  usedLabels: Set<string>
): { input: QAppCfgInput | null; warning?: string } {
  const promptNode = workflow[nodeId]
  if (!promptNode) {
    return {
      input: null,
      warning: `APP Mode 输入 ${nodeId}.${fieldName} 未能在工作流里找到对应节点`
    }
  }

  const fieldInfo = getInputFieldInfo(objectInfos, promptNode.class_type, fieldName)
  const fieldType = fieldInfo?.[0]
  const fieldCfg = fieldInfo?.[1]
  const currentValue = promptNode.inputs[fieldName]
  const label = buildInputLabel(guiNode, fieldName, usedLabels)
  const slot = `$.${nodeId}.inputs.${fieldName}`

  if (isImageMaskInputField(guiNode, fieldName)) {
    return {
      input: {
        label,
        component: 'InputComfyImageMask',
        slot
      }
    }
  }

  if (isVideoInputField(fieldName, currentValue, fieldCfg, guiNode)) {
    return {
      input: {
        label,
        component: 'InputComfyVideo',
        slot
      }
    }
  }

  if (isImageInputField(guiNode, fieldName, currentValue)) {
    return {
      input: {
        label,
        component: 'InputComfyImage',
        slot
      }
    }
  }

  if (Array.isArray(fieldType)) {
    return {
      input: {
        label,
        component: 'InputComfySelect',
        slot
      }
    }
  }

  if (fieldType === 'INT' || fieldType === 'FLOAT' || typeof currentValue === 'number') {
    if (isSeedLikeField(fieldName)) {
      return {
        input: {
          label,
          component: 'InputSeed',
          slot
        }
      }
    }

    const { min, max, step } = toNumberFieldCfg(fieldCfg)
    return {
      input: {
        label,
        component: 'InputNumber',
        slot,
        min,
        max,
        step
      }
    }
  }

  if (fieldType === 'STRING' || typeof currentValue === 'string') {
    if (isPromptLikeField(fieldName, fieldCfg)) {
      return {
        input: {
          label,
          component: 'InputPrompt',
          slot
        }
      }
    }

    return {
      input: {
        label,
        component: 'InputText',
        slot
      }
    }
  }

  if (fieldType === 'BOOLEAN' || typeof currentValue === 'boolean') {
    return {
      input: null,
      warning: `APP Mode 输入 ${nodeId}.${fieldName} 是布尔值，当前未自动映射，请在设计器里手动补充`
    }
  }

  return {
    input: null,
    warning: `APP Mode 输入 ${nodeId}.${fieldName} 当前类型暂不支持自动映射，请在设计器里手动调整`
  }
}

export function extractAppModeMetadata(gui: unknown): AppModeMetadata | null {
  if (!isGuiWorkflow(gui) || !isJsonDict(gui)) {
    return null
  }

  const extra = gui.extra
  if (!valueIsJsonDict(extra) || !valueIsJsonDict(extra.linearData)) {
    return null
  }

  const rawInputs = extra.linearData.inputs
  const rawOutputs = extra.linearData.outputs
  if (!Array.isArray(rawInputs) || !Array.isArray(rawOutputs)) {
    return null
  }

  const inputs: [string, string][] = rawInputs
    .filter(
      (entry): entry is [string | number, string] =>
        Array.isArray(entry) &&
        entry.length >= 2 &&
        (typeof entry[0] === 'string' || typeof entry[0] === 'number') &&
        typeof entry[1] === 'string'
    )
    .map(([nodeId, fieldName]) => [String(nodeId), fieldName])

  const outputs = rawOutputs
    .filter(
      (entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number'
    )
    .map((entry) => String(entry))

  return {
    inputs,
    outputs
  }
}

export function buildQAppCfgFromAppMode(
  gui: unknown,
  workflow: Workflow,
  objectInfos: ObjectInfoMap = {}
): { cfg: QAppCfg; warnings: string[] } | null {
  if (!isGuiWorkflow(gui)) {
    return null
  }

  const appMode = extractAppModeMetadata(gui)
  if (!appMode) {
    return null
  }

  const warnings: string[] = []
  const usedLabels = new Set<string>()
  const inputs: QAppCfgInput[] = []

  for (const [nodeId, fieldName] of appMode.inputs) {
    const guiNode = getNodeById(gui, nodeId)
    const { input, warning } = buildQAppInputForAppModeField(
      nodeId,
      fieldName,
      workflow,
      guiNode,
      objectInfos,
      usedLabels
    )

    if (input) {
      inputs.push(input)
    }
    if (warning) {
      warnings.push(warning)
    }
  }

  const cfg = createEmptyQAppCfg()
  cfg.inputs = inputs
  if (appMode.outputs.length > 0) {
    cfg.outputNodeIds = Array.from(new Set(appMode.outputs))
  }

  return {
    cfg,
    warnings
  }
}
