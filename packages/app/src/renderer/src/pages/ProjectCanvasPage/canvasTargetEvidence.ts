import type { CanvasTargetEvidenceMode, CanvasTargetEvidencePolicy } from '@shared/canvasTarget'

export type { CanvasTargetEvidenceMode } from '@shared/canvasTarget'

export const CANVAS_TARGET_EVIDENCE_MODES = [
  'structured_only',
  'selection_region',
  'selected_sources'
] as const satisfies readonly CanvasTargetEvidenceMode[]

export const DEFAULT_CANVAS_TARGET_EVIDENCE_MODE: CanvasTargetEvidenceMode = 'selection_region'

export function isCanvasTargetEvidenceMode(value: unknown): value is CanvasTargetEvidenceMode {
  return typeof value === 'string' && CANVAS_TARGET_EVIDENCE_MODES.includes(value as never)
}

export function normalizeCanvasTargetEvidenceMode(value: unknown): CanvasTargetEvidenceMode {
  return isCanvasTargetEvidenceMode(value) ? value : DEFAULT_CANVAS_TARGET_EVIDENCE_MODE
}

export function resolveCanvasTargetEvidencePolicy(
  value: unknown,
  preferredLanguage: 'zh-CN' | 'en-US' = 'en-US'
): CanvasTargetEvidencePolicy {
  const mode = normalizeCanvasTargetEvidenceMode(value)
  const isChinese = preferredLanguage === 'zh-CN'

  if (mode === 'structured_only') {
    return {
      mode,
      label: isChinese ? '严格隐私' : 'Strict privacy',
      tokenCost: 'low',
      includeSelectionSnapshot: false,
      includeSelectedSourceAssets: false,
      privacyBoundary: isChinese
        ? '只发送结构化画布数据和脱敏执行回执；不发送选区截图或源素材。'
        : 'Only structured canvas data and redacted execution receipts are sent; no selection screenshot or source assets are attached.'
    }
  }

  if (mode === 'selected_sources') {
    return {
      mode,
      label: isChinese ? '完整选中源素材' : 'Selected source assets',
      tokenCost: 'high',
      includeSelectionSnapshot: true,
      includeSelectedSourceAssets: true,
      privacyBoundary: isChinese
        ? '发送选区截图，并附加被选中元素的原始源素材；若只框住素材一部分，完整源素材也可能被读取。'
        : 'Sends the selection screenshot and original source assets for selected items; if only part of an asset is boxed, the full selected source asset may still be read.'
    }
  }

  return {
    mode,
    label: isChinese ? '选区证据' : 'Selection evidence',
    tokenCost: 'medium',
    includeSelectionSnapshot: true,
    includeSelectedSourceAssets: false,
    privacyBoundary: isChinese
      ? '默认只发送软件层按目标框选区域裁出的截图和结构化画布数据；不附加完整源素材。'
      : 'Sends the software-cropped target selection screenshot plus structured canvas data; full source assets are not attached.'
  }
}

export function buildCanvasTargetEvidencePolicyPrompt(
  value: unknown,
  preferredLanguage: 'zh-CN' | 'en-US' = 'en-US'
): string {
  const policy = resolveCanvasTargetEvidencePolicy(value, preferredLanguage)
  return [
    'Canvas target evidence policy:',
    `mode=${policy.mode}`,
    `label=${policy.label}`,
    `token_cost=${policy.tokenCost}`,
    `include_selection_snapshot=${policy.includeSelectionSnapshot ? 'yes' : 'no'}`,
    `include_selected_source_assets=${policy.includeSelectedSourceAssets ? 'yes' : 'no'}`,
    `privacy_boundary=${policy.privacyBoundary}`
  ].join('\n')
}
