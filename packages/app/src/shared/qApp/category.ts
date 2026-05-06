import type { Workflow, WorkflowNode } from '@shared/comfy/types'
import type { QAppCfg } from './cfgTypes'

export type QAppCategory = 'image' | 'model3d' | 'video' | 'inspection'

type InferQAppCategoryOptions = {
  category?: QAppCategory | null
  cfg?: QAppCfg | null
  key?: string
  name?: string
  workflow?: Workflow | null
}

const VIDEO_INPUT_COMPONENTS = new Set(['InputComfyVideo', 'InputVideoBoundaryFrames'])
const MODEL3D_INPUT_COMPONENTS = new Set(['InputCamera3D'])

const VIDEO_KEYWORD_PATTERNS = [
  /(^|[^a-z])video([^a-z]|$)/i,
  /\bt2v\b/i,
  /\bi2v\b/i,
  /boundary.?frame/i,
  /videocombine/i,
  /savevideo/i,
  /loadvideo/i,
  /videoloader/i,
  /createvideo/i,
  /seedvr/i,
  /animatediff/i,
  /frame.?interp/i,
  /framepack/i,
  /\bvhs\b/i
]

const MODEL3D_KEYWORD_PATTERNS = [
  /hunyuan3d/i,
  /(^|[^a-z0-9])3d([^a-z0-9]|$)/i,
  /model3d/i,
  /\bmesh\b/i,
  /\bglb\b/i,
  /\bgltf\b/i,
  /\bfbx\b/i,
  /\bobj\b/i,
  /\bstl\b/i
]

const getKnownQAppCategory = (key?: string, name?: string): QAppCategory | null => {
  const normalizedKey = String(key || '')
    .replace(/\\/g, '/')
    .toLowerCase()
  const normalizedName = String(name || '').toLowerCase()
  const signal = `${normalizedKey} ${normalizedName}`

  if (normalizedKey === '~builtin/inspection/duplicate-check') {
    return 'inspection'
  }
  if (signal.includes('hunyuan3d')) {
    return 'model3d'
  }
  if (normalizedKey.startsWith('\u9ad8\u6e05\u653e\u5927/')) {
    return 'image'
  }

  return null
}

const matchesAnyPattern = (value: string, patterns: RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(value))

const getNodeSignalText = (node: WorkflowNode | undefined): string => {
  if (!node) {
    return ''
  }

  const inputNames = Object.keys(node.inputs || {})
  return [node.class_type, node._meta?.title || '', ...inputNames].join(' ').trim()
}

export const normalizeQAppCategory = (value: unknown): QAppCategory | null => {
  if (value === 'image' || value === 'model3d' || value === 'video' || value === 'inspection') {
    return value
  }
  return null
}

export const inferQAppCategory = ({
  category,
  cfg,
  key,
  name,
  workflow
}: InferQAppCategoryOptions): QAppCategory => {
  const knownCategory = getKnownQAppCategory(key, name)
  if (knownCategory) {
    return knownCategory
  }

  const explicitCategory = normalizeQAppCategory(category)
  if (explicitCategory) {
    return explicitCategory
  }

  let videoScore = 0
  let model3dScore = 0

  const addSignalFromText = (value: string, weight: number) => {
    if (!value) {
      return
    }

    if (matchesAnyPattern(value, VIDEO_KEYWORD_PATTERNS)) {
      videoScore += weight
    }
    if (matchesAnyPattern(value, MODEL3D_KEYWORD_PATTERNS)) {
      model3dScore += weight
    }
  }

  if (cfg) {
    for (const input of cfg.inputs || []) {
      if (VIDEO_INPUT_COMPONENTS.has(input.component)) {
        videoScore += 6
      }
      if (MODEL3D_INPUT_COMPONENTS.has(input.component)) {
        model3dScore += 6
      }
    }
  }

  if (workflow) {
    const outputNodeIds = cfg?.outputNodeIds || []
    const outputNodes =
      outputNodeIds.length > 0
        ? outputNodeIds.map((nodeId) => workflow[nodeId]).filter(Boolean)
        : ([] as WorkflowNode[])

    for (const node of outputNodes) {
      addSignalFromText(getNodeSignalText(node), 4)
    }

    for (const node of Object.values(workflow)) {
      addSignalFromText(getNodeSignalText(node), 1)
    }
  }

  addSignalFromText(`${key || ''} ${name || ''}`.trim(), 1)

  if (model3dScore > 0 && model3dScore >= videoScore) {
    return 'model3d'
  }
  if (videoScore > 0) {
    return 'video'
  }
  return 'image'
}
