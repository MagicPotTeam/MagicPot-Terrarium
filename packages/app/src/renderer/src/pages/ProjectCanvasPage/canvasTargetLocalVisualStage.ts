import type {
  DuplicateCheckSvc,
  DuplicateCheckVisualAnalysisGroupKind,
  DuplicateCheckVisualAnalysisImage,
  DuplicateCheckVisualAnalysisResult
} from '@shared/api/svcDuplicateCheck'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { CanvasTargetStageExecutionResult } from './canvasTargetWorkflow'
import {
  LOCAL_MODEL_CANVAS_TARGET_OUTPUT_FORMATS,
  type CanvasTargetAuxiliaryOutputFormat
} from './canvasTargetTypes'
import { loadImageBytesFromSource } from '../QuickAppPage/duplicateCheck/imageSource'

export type CanvasTargetLocalVisualAttachmentGroup = {
  kind: DuplicateCheckVisualAnalysisGroupKind
  label: string
  attachments: ChatAttachment[]
}

type ExecuteCanvasTargetLocalVisualStageOptions = {
  duplicateCheckSvc: Pick<DuplicateCheckSvc, 'runVisualAnalysis'>
  modelId: string
  modelLabel: string
  attachmentGroups: CanvasTargetLocalVisualAttachmentGroup[]
  stageLabel?: string
  stagePrompt?: string
  referenceNotes?: string[]
  userNotes?: string
  preferredOutputFormats?: CanvasTargetAuxiliaryOutputFormat[]
  isChineseUi: boolean
}

const MAX_REPORTED_PAIR_RESULTS = 12

function isImageAttachment(
  attachment: ChatAttachment | null | undefined
): attachment is ChatAttachment {
  return Boolean(attachment && attachment.type === 'image' && attachment.url)
}

function normalizeStageOutputFormats(
  value: CanvasTargetAuxiliaryOutputFormat[] | undefined
): CanvasTargetAuxiliaryOutputFormat[] {
  const supported = new Set(LOCAL_MODEL_CANVAS_TARGET_OUTPUT_FORMATS)
  const requested = Array.isArray(value) ? value.filter((entry) => supported.has(entry)) : []
  return requested.length > 0 ? requested : ['markdown']
}

async function collectLocalVisualImages(
  attachmentGroups: CanvasTargetLocalVisualAttachmentGroup[]
): Promise<{
  images: DuplicateCheckVisualAnalysisImage[]
  ignoredAttachments: Array<{ fileName: string; reason: string }>
}> {
  const images: DuplicateCheckVisualAnalysisImage[] = []
  const ignoredAttachments: Array<{ fileName: string; reason: string }> = []

  for (const group of attachmentGroups) {
    for (let index = 0; index < group.attachments.length; index += 1) {
      const attachment = group.attachments[index]
      const fallbackName = attachment.fileName || `${group.kind}-${index + 1}`
      if (!isImageAttachment(attachment)) {
        ignoredAttachments.push({
          fileName: fallbackName,
          reason: 'non-image'
        })
        continue
      }

      try {
        const loaded = await loadImageBytesFromSource(attachment.url)
        images.push({
          id: `${group.kind}:${fallbackName}:${index + 1}`,
          name: fallbackName,
          data: loaded.data,
          mimeType: attachment.mimeType || loaded.mimeType,
          sourcePath: loaded.sourcePath,
          sourceUrl: attachment.url,
          originLabel: group.label,
          groupKind: group.kind,
          groupLabel: group.label
        })
      } catch (error) {
        ignoredAttachments.push({
          fileName: fallbackName,
          reason: error instanceof Error ? error.message : 'load-failed'
        })
      }
    }
  }

  return { images, ignoredAttachments }
}

function formatSimilarity(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'n/a'
}

function buildLocalVisualMarkdown(options: {
  result: DuplicateCheckVisualAnalysisResult
  modelLabel: string
  stageLabel?: string
  stagePrompt?: string
  referenceNotes?: string[]
  userNotes?: string
  ignoredAttachments: Array<{ fileName: string; reason: string }>
  isChineseUi: boolean
}): string {
  const { result, ignoredAttachments, isChineseUi } = options
  const lines: string[] = [
    isChineseUi ? '# 本地模型分析结果' : '# Local Model Analysis Result',
    '',
    `- ${isChineseUi ? '模型' : 'Model'}: ${options.modelLabel}`,
    `- ${isChineseUi ? '执行后端' : 'Execution backend'}: ${isChineseUi ? '本地模型后端（duplicateCheck.runVisualAnalysis）' : 'Local model backend (duplicateCheck.runVisualAnalysis)'}`,
    `- ${isChineseUi ? '阶段' : 'Stage'}: ${options.stageLabel || (isChineseUi ? '本地模型阶段' : 'Local model stage')}`,
    `- ${isChineseUi ? '提供图片数' : 'Images analyzed'}: ${result.imageCount}`,
    `- ${isChineseUi ? '配对模式' : 'Pair mode'}: ${result.pairMode}`,
    ''
  ]

  if (options.stagePrompt?.trim()) {
    lines.push(
      `## ${isChineseUi ? '主控阶段提示' : 'Control-stage prompt'}`,
      '',
      options.stagePrompt.trim(),
      ''
    )
  }
  if (options.userNotes?.trim()) {
    lines.push(`## ${isChineseUi ? '用户补充' : 'User notes'}`, '', options.userNotes.trim(), '')
  }
  if (Array.isArray(options.referenceNotes) && options.referenceNotes.length > 0) {
    lines.push(`## ${isChineseUi ? '主控备注' : 'Planner notes'}`, '')
    options.referenceNotes.forEach((note) => {
      lines.push(`- ${note}`)
    })
    lines.push('')
  }

  lines.push(`## ${isChineseUi ? '输入分组' : 'Input groups'}`, '')
  result.groups.forEach((group) => {
    lines.push(`- ${group.label}: ${group.imageCount}`)
  })
  lines.push('')

  if (ignoredAttachments.length > 0 || result.warnings.length > 0) {
    lines.push(`## ${isChineseUi ? '限制与告警' : 'Warnings and limits'}`, '')
    result.warnings.forEach((warning) => lines.push(`- ${warning}`))
    ignoredAttachments.forEach((entry) => {
      lines.push(
        `- ${entry.fileName}: ${isChineseUi ? '已忽略，原因' : 'Ignored because'} ${entry.reason}`
      )
    })
    lines.push(
      `- ${
        isChineseUi
          ? '该本地模型只执行固定的视觉相似度/特征比较，不会直接理解自然语言提示或方案文本文件。'
          : 'This local model only performs fixed visual similarity/feature analysis and does not directly interpret natural-language prompts or scheme text files.'
      }`,
      ''
    )
  }

  lines.push(`## ${isChineseUi ? '最高相关配对' : 'Top visual pairs'}`, '')
  if (result.pairResults.length === 0) {
    lines.push(
      isChineseUi ? '- 没有可比较的图片配对。' : '- No comparable image pairs were available.'
    )
  } else {
    lines.push('| Left | Right | Visual | Robust |', '| --- | --- | --- | --- |')
    result.pairResults.slice(0, MAX_REPORTED_PAIR_RESULTS).forEach((pair) => {
      lines.push(
        `| ${pair.leftName} (${pair.leftGroupLabel || pair.leftGroupKind}) | ${pair.rightName} (${pair.rightGroupLabel || pair.rightGroupKind}) | ${formatSimilarity(pair.visualSimilarity)} | ${formatSimilarity(pair.robustnessSimilarity)} |`
      )
    })
  }

  return lines.join('\n')
}

function buildLocalVisualPlainText(options: {
  result: DuplicateCheckVisualAnalysisResult
  modelLabel: string
  stageLabel?: string
  ignoredAttachments: Array<{ fileName: string; reason: string }>
  isChineseUi: boolean
}): string {
  const pairPreview =
    options.result.pairResults
      .slice(0, 5)
      .map(
        (pair, index) =>
          `${index + 1}. ${pair.leftName} <-> ${pair.rightName} | visual=${formatSimilarity(
            pair.visualSimilarity
          )} | robust=${formatSimilarity(pair.robustnessSimilarity)}`
      )
      .join('\n') ||
    (options.isChineseUi ? '没有可比较的图片配对。' : 'No comparable image pairs were available.')

  return [
    options.isChineseUi ? '本地模型分析结果' : 'Local model analysis result',
    `${options.isChineseUi ? '模型' : 'Model'}: ${options.modelLabel}`,
    `${options.isChineseUi ? '阶段' : 'Stage'}: ${
      options.stageLabel || (options.isChineseUi ? '本地模型阶段' : 'Local model stage')
    }`,
    `${options.isChineseUi ? '图片数' : 'Image count'}: ${options.result.imageCount}`,
    `${options.isChineseUi ? '配对模式' : 'Pair mode'}: ${options.result.pairMode}`,
    options.ignoredAttachments.length > 0
      ? `${options.isChineseUi ? '已忽略附件' : 'Ignored attachments'}: ${options.ignoredAttachments
          .map((entry) => entry.fileName)
          .join(', ')}`
      : null,
    '',
    pairPreview
  ]
    .filter(Boolean)
    .join('\n')
}

export async function executeCanvasTargetLocalVisualStage(
  options: ExecuteCanvasTargetLocalVisualStageOptions
): Promise<CanvasTargetStageExecutionResult> {
  const { images, ignoredAttachments } = await collectLocalVisualImages(options.attachmentGroups)

  if (images.length === 0) {
    return {
      modelId: options.modelId,
      content: options.isChineseUi
        ? '当前本地模型阶段没有可分析的图片输入。'
        : 'No compatible image inputs were available for the local model stage.',
      fallbackReason: options.isChineseUi
        ? '本地模型阶段缺少可分析图片'
        : 'Local model stage had no compatible image inputs'
    }
  }

  try {
    const result = await options.duplicateCheckSvc.runVisualAnalysis({
      modelId: options.modelId,
      images
    })
    const preferredOutputFormats = normalizeStageOutputFormats(options.preferredOutputFormats)
    const content =
      preferredOutputFormats[0] === 'json'
        ? JSON.stringify(
            {
              stageLabel: options.stageLabel,
              stagePrompt: options.stagePrompt,
              userNotes: options.userNotes,
              referenceNotes: options.referenceNotes,
              ignoredAttachments,
              result
            },
            null,
            2
          )
        : preferredOutputFormats[0] === 'plain_text'
          ? buildLocalVisualPlainText({
              result,
              modelLabel: options.modelLabel,
              stageLabel: options.stageLabel,
              ignoredAttachments,
              isChineseUi: options.isChineseUi
            })
          : buildLocalVisualMarkdown({
              result,
              modelLabel: options.modelLabel,
              stageLabel: options.stageLabel,
              stagePrompt: options.stagePrompt,
              referenceNotes: options.referenceNotes,
              userNotes: options.userNotes,
              ignoredAttachments,
              isChineseUi: options.isChineseUi
            })

    return {
      modelId: options.modelId,
      content,
      fallbackReason:
        ignoredAttachments.length > 0 || result.warnings.length > 0
          ? options.isChineseUi
            ? '本地模型阶段已忽略部分不兼容输入'
            : 'Local model stage ignored some incompatible inputs'
          : undefined
    }
  } catch (error) {
    return {
      modelId: options.modelId,
      content: options.isChineseUi
        ? '本地模型阶段执行失败。'
        : 'The local model stage failed to execute.',
      fallbackReason: error instanceof Error ? error.message : 'Local model stage failed'
    }
  }
}
