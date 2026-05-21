import type { ChatAttachment, OCRResult } from '@shared/api/svcLLMProxy'
import type {
  SaveImageToPathReq,
  SaveImageToPathResp,
  WriteTextFileReq,
  WriteTextFileResp
} from '@shared/api/svcFs'
import type {
  CanvasTargetFinding,
  CanvasTargetReport,
  CanvasTargetReportStage
} from '@shared/canvasTarget'
import type { ReportBundleManifest, ReportBundleManifestEntry } from '@shared/reportBundle'
import { REPORT_BUNDLE_MANIFEST_VERSION } from '@shared/reportBundle'

import { sanitizeFilePart } from './canvasExportNamingUtils'
import { guardCanvasTargetTextForUi } from './canvasTargetTextGuard'

export type CanvasTargetAgentMessagePayload = {
  content: string
  attachments: ChatAttachment[]
}

export type CanvasTargetAgentBundleOptions = {
  bundleRootDir?: string
  saveImageToPath?: (req: SaveImageToPathReq) => Promise<SaveImageToPathResp>
  writeTextFile?: (req: WriteTextFileReq) => Promise<WriteTextFileResp>
}

type CanvasTargetBundleMaterialization = {
  bundleId: string
  manifest: ReportBundleManifest
  manifestUrl: string
}

const CANVAS_TARGET_MAX_FINAL_CHAT_TEXT_CHARS = 12_000
const REPORT_BUNDLES_ROOT_DIR = '.report_bundles'

function formatMetadataItem(label: string, value: string, isChineseUi: boolean): string {
  return `- **${label}**${isChineseUi ? '：' : ': '}${value}`
}

function formatReportTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

function formatStageStatus(
  status: CanvasTargetReportStage['status'],
  isChineseUi: boolean
): string {
  if (status === 'fallback') {
    return isChineseUi ? '回退执行' : 'Fallback'
  }
  return isChineseUi ? '已完成' : 'Completed'
}

function formatFindingSeverity(
  severity: CanvasTargetFinding['severity'],
  isChineseUi: boolean
): string {
  switch (severity) {
    case 'error':
      return isChineseUi ? '错误' : 'Error'
    case 'warning':
      return isChineseUi ? '警告' : 'Warning'
    default:
      return isChineseUi ? '提示' : 'Info'
  }
}

function formatFindingCategory(
  category: CanvasTargetFinding['category'],
  isChineseUi: boolean
): string {
  switch (category) {
    case 'layout':
      return isChineseUi ? '布局' : 'Layout'
    case 'visual':
      return isChineseUi ? '视觉' : 'Visual'
    case 'content':
      return isChineseUi ? '内容' : 'Content'
    case 'consistency':
      return isChineseUi ? '一致性' : 'Consistency'
    case 'usability':
      return isChineseUi ? '可用性' : 'Usability'
    case 'accessibility':
      return isChineseUi ? '无障碍' : 'Accessibility'
    default:
      return isChineseUi ? '其他' : 'Other'
  }
}

function formatAttachmentType(type: ChatAttachment['type'], isChineseUi: boolean): string {
  switch (type) {
    case 'image':
      return isChineseUi ? '图片' : 'Image'
    case 'video':
      return isChineseUi ? '视频' : 'Video'
    case 'model3d':
      return isChineseUi ? '3D 模型' : '3D model'
    default:
      return isChineseUi ? '文件' : 'File'
  }
}

function formatFileSize(sizeBytes: number, isChineseUi: boolean): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return String(sizeBytes)
  }

  const units = isChineseUi ? ['B', 'KB', 'MB', 'GB'] : ['B', 'KB', 'MB', 'GB']
  let value = sizeBytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const displayValue = value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)
  return `${displayValue} ${units[unitIndex]}`
}

function formatSourceResolution(
  attachment: Pick<ChatAttachment, 'sourceWidth' | 'sourceHeight'>
): string | null {
  if (
    !Number.isFinite(attachment.sourceWidth) ||
    !Number.isFinite(attachment.sourceHeight) ||
    !attachment.sourceWidth ||
    !attachment.sourceHeight
  ) {
    return null
  }

  return `${attachment.sourceWidth} x ${attachment.sourceHeight} px`
}

function resolveAttachmentDisplayName(
  attachment: Pick<ChatAttachment, 'fileName' | 'type'>,
  index: number
): string {
  return attachment.fileName?.trim() || `${attachment.type}-${index + 1}`
}

function buildInlineAssetUrl(url: string): string {
  return url.startsWith('data:') ? url : encodeURI(url)
}

function normalizeAttachmentLabel(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/]+/g, '/')
      .split('/')
      .pop()
      ?.toLowerCase() || ''
  )
}

function dedupeSourceAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  const seen = new Set<string>()
  return attachments.filter((attachment, index) => {
    const key = [
      attachment.type,
      resolveAttachmentDisplayName(attachment, index),
      attachment.url.trim()
    ].join('::')
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function getStageResponseText(
  stage: CanvasTargetReportStage,
  includeFallbackReason = true
): string {
  const responseText =
    stage.responseContent?.trim() ||
    stage.responseOcrResult?.text?.trim() ||
    stage.rawResponse?.trim()
  if (responseText) {
    return guardCanvasTargetTextForUi(responseText, { kind: 'response' }) || ''
  }

  if (!includeFallbackReason) {
    return ''
  }

  return (
    guardCanvasTargetTextForUi(stage.fallbackReason?.trim(), {
      kind: 'error'
    }) || ''
  )
}

function extractNamedModelFeedbackByAttachment(
  stage: CanvasTargetReportStage,
  attachments: ChatAttachment[]
): Map<string, string> {
  const responseText = getStageResponseText(stage, false)
  if (!responseText) {
    return new Map()
  }

  const attachmentLabels = new Set(
    attachments
      .map((attachment, index) =>
        normalizeAttachmentLabel(resolveAttachmentDisplayName(attachment, index))
      )
      .filter(Boolean)
  )
  if (attachmentLabels.size === 0) {
    return new Map()
  }

  const matches = new Map<string, string>()
  const lines = responseText.split(/\r?\n/)
  let currentLabel: string | null = null
  let currentBody: string[] = []

  const flushCurrent = () => {
    if (!currentLabel) {
      return
    }

    const normalizedLabel = normalizeAttachmentLabel(currentLabel)
    if (!attachmentLabels.has(normalizedLabel)) {
      currentLabel = null
      currentBody = []
      return
    }

    const body = currentBody.join('\n').trim()
    if (body) {
      matches.set(normalizedLabel, body)
    }
    currentLabel = null
    currentBody = []
  }

  for (const line of lines) {
    const headingMatch = line.match(/^##(?!#)\s+(.+?)\s*$/)
    if (headingMatch) {
      flushCurrent()
      currentLabel = headingMatch[1]
      currentBody = []
      continue
    }

    if (currentLabel) {
      currentBody.push(line)
    }
  }

  flushCurrent()
  return matches
}

type StageSourceAssetEntry = {
  attachment: ChatAttachment
  displayName: string
  feedback?: string
}

function resolveStageSourceAssetEntries(stage: CanvasTargetReportStage): StageSourceAssetEntry[] {
  const attachments = dedupeSourceAttachments(stage.inputSourceAttachments || [])
  if (attachments.length === 0) {
    return []
  }

  const feedbackByAttachment = extractNamedModelFeedbackByAttachment(stage, attachments)
  if (feedbackByAttachment.size > 0) {
    return attachments.flatMap((attachment, index) => {
      const displayName = resolveAttachmentDisplayName(attachment, index)
      const feedback = feedbackByAttachment.get(normalizeAttachmentLabel(displayName))
      return feedback ? [{ attachment, displayName, feedback }] : []
    })
  }

  if (attachments.length === 1) {
    return [
      {
        attachment: attachments[0],
        displayName: resolveAttachmentDisplayName(attachments[0], 0),
        feedback: getStageResponseText(stage, false) || undefined
      }
    ]
  }

  if (stage.status === 'fallback') {
    return []
  }

  return attachments.map((attachment, index) => ({
    attachment,
    displayName: resolveAttachmentDisplayName(attachment, index)
  }))
}

function appendStageSourceAssetSections(
  lines: string[],
  stage: CanvasTargetReportStage,
  isChineseUi: boolean,
  headings: {
    section: string
    asset: string
    feedback: string
  }
): void {
  const assetEntries = resolveStageSourceAssetEntries(stage)
  if (assetEntries.length === 0) {
    return
  }

  lines.push('')
  lines.push(`${headings.section} ${isChineseUi ? '对应源文件' : 'Source Assets'}`)

  for (const entry of assetEntries) {
    lines.push('')
    lines.push(`${headings.asset} ${entry.displayName}`)
    lines.push('')
    lines.push(
      formatMetadataItem(
        isChineseUi ? '本地文件名' : 'Local file name',
        `\`${entry.displayName}\``,
        isChineseUi
      )
    )
    lines.push(
      formatMetadataItem(
        isChineseUi ? '附件类型' : 'Attachment type',
        formatAttachmentType(entry.attachment.type, isChineseUi),
        isChineseUi
      )
    )

    if (entry.attachment.mimeType?.trim()) {
      lines.push(
        formatMetadataItem(
          isChineseUi ? 'MIME 类型' : 'MIME type',
          `\`${entry.attachment.mimeType.trim()}\``,
          isChineseUi
        )
      )
    }

    if (typeof entry.attachment.sizeBytes === 'number' && entry.attachment.sizeBytes > 0) {
      lines.push(
        formatMetadataItem(
          isChineseUi ? '文件大小' : 'File size',
          formatFileSize(entry.attachment.sizeBytes, isChineseUi),
          isChineseUi
        )
      )
    }

    const resolution = formatSourceResolution(entry.attachment)
    if (resolution) {
      lines.push(
        formatMetadataItem(isChineseUi ? '像素尺寸' : 'Resolution', resolution, isChineseUi)
      )
    }

    if (entry.attachment.type === 'image' && entry.attachment.url.trim()) {
      lines.push('')
      lines.push(`![${entry.displayName}](<${buildInlineAssetUrl(entry.attachment.url.trim())}>)`)
    }

    if (entry.feedback?.trim()) {
      lines.push('')
      lines.push(`${headings.feedback} ${isChineseUi ? '模型反馈' : 'Model Feedback'}`)
      lines.push('')
      lines.push(entry.feedback.trim())
    }
  }
}

function encodeTextAsDataUrl(content: string, mimeType: string): string {
  const bytes = new TextEncoder().encode(content)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

function buildTextAttachment(options: {
  fileName: string
  content: string
  mimeType?: string
}): ChatAttachment {
  const mimeType = options.mimeType || 'text/markdown'
  const sizeBytes = new TextEncoder().encode(options.content).byteLength

  return {
    type: 'file',
    url: encodeTextAsDataUrl(options.content, mimeType),
    mimeType,
    fileName: options.fileName,
    sizeBytes
  }
}

function resolveStageSource(options: {
  stage: Pick<CanvasTargetReportStage, 'modelId' | 'displayModelLabel'>
  isChineseUi: boolean
  sourceLabel?: string
  modelLabel?: string
}) {
  const sourceLabel =
    options.sourceLabel?.trim() ||
    options.stage.displayModelLabel?.trim() ||
    options.stage.modelId?.trim() ||
    ''

  if (sourceLabel) {
    const modelId = options.stage.modelId?.trim() || ''
    return {
      typeLabel: options.modelLabel || (options.isChineseUi ? '来源模型' : 'Source model'),
      sourceLabel,
      modelId: modelId && modelId !== sourceLabel ? modelId : undefined
    }
  }

  return {
    typeLabel: options.isChineseUi ? '来源能力' : 'Source capability',
    sourceLabel: options.isChineseUi ? 'MagicPot 内置能力' : 'MagicPot built-in capability',
    modelId: undefined
  }
}

function pushQuotedSummary(lines: string[], summary: string): void {
  const normalized = summary.trim()
  if (!normalized) {
    return
  }

  lines.push(...normalized.split(/\r?\n/).map((line) => `> ${line}`))
}

function parseOverviewLine(line: string): { label: string; value: string } | null {
  const match = line.match(/^([^:：]{1,40})[:：]\s*(.+)$/)
  if (!match) {
    return null
  }

  return {
    label: match[1].trim(),
    value: match[2].trim()
  }
}

function appendFormattedTextBlock(lines: string[], content: string, isChineseUi: boolean): void {
  const normalized = content.trim()
  if (!normalized) {
    return
  }

  const nonEmptyLines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  if (nonEmptyLines.length === 0) {
    return
  }

  const structuredLines = nonEmptyLines.map(parseOverviewLine)
  if (structuredLines.every((entry): entry is { label: string; value: string } => Boolean(entry))) {
    lines.push(
      ...structuredLines.map((entry) => formatMetadataItem(entry.label, entry.value, isChineseUi))
    )
    return
  }

  const blocks = normalized
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)

  blocks.forEach((block, index) => {
    if (index > 0) {
      lines.push('')
    }
    lines.push(block)
  })
}

function formatFindingBlock(finding: CanvasTargetFinding, isChineseUi: boolean): string {
  const severityLabel = formatFindingSeverity(finding.severity, isChineseUi)
  const categoryLabel = formatFindingCategory(finding.category, isChineseUi)
  const lines = [`### ${severityLabel} | ${finding.title}`, '', finding.summary, '']

  lines.push(
    formatMetadataItem(
      isChineseUi ? '问题等级' : 'Severity',
      isChineseUi
        ? `${severityLabel}（${finding.severity}）`
        : `${severityLabel} (${finding.severity})`,
      isChineseUi
    )
  )
  lines.push(
    formatMetadataItem(
      isChineseUi ? '问题类型' : 'Category',
      isChineseUi
        ? `${categoryLabel}（${finding.category}）`
        : `${categoryLabel} (${finding.category})`,
      isChineseUi
    )
  )

  if (finding.itemIds.length > 0) {
    lines.push(
      formatMetadataItem(
        isChineseUi ? '关联元素' : 'Related items',
        finding.itemIds.map((itemId) => `\`${itemId}\``).join(', '),
        isChineseUi
      )
    )
  }

  if (finding.sourceStageLabel?.trim()) {
    lines.push(
      formatMetadataItem(
        isChineseUi ? '来源阶段' : 'Source stage',
        finding.sourceStageLabel.trim(),
        isChineseUi
      )
    )
  }

  if (finding.evidence.length > 0) {
    lines.push('')
    lines.push(`#### ${isChineseUi ? '证据' : 'Evidence'}`)
    lines.push(...finding.evidence.map((entry) => `- ${entry}`))
  }

  if (finding.suggestions.length > 0) {
    lines.push('')
    lines.push(`#### ${isChineseUi ? '建议' : 'Suggestions'}`)
    lines.push(...finding.suggestions.map((entry) => `- ${entry}`))
  }

  return lines.join('\n')
}

function buildStageMarkdown(
  stage: CanvasTargetReportStage,
  isChineseUi: boolean,
  sourceLabel?: string
): string {
  const stageSource = resolveStageSource({
    stage,
    isChineseUi,
    sourceLabel,
    modelLabel: isChineseUi ? '执行模型' : 'Model'
  })
  const lines = [`# ${stage.label}`, '']

  pushQuotedSummary(lines, stage.summary)
  lines.push('')
  lines.push(`## ${isChineseUi ? '阶段信息' : 'Stage Details'}`)
  lines.push(
    formatMetadataItem(
      isChineseUi ? '执行状态' : 'Status',
      formatStageStatus(stage.status, isChineseUi),
      isChineseUi
    )
  )
  lines.push(formatMetadataItem(stageSource.typeLabel, stageSource.sourceLabel, isChineseUi))
  if (stageSource.modelId) {
    lines.push(
      formatMetadataItem(
        isChineseUi ? '模型标识' : 'Model ID',
        `\`${stageSource.modelId}\``,
        isChineseUi
      )
    )
  }
  lines.push(
    formatMetadataItem(
      isChineseUi ? '发现问题' : 'Findings',
      String(stage.findings.length),
      isChineseUi
    )
  )

  if (stage.overview.trim()) {
    lines.push('')
    lines.push(`## ${isChineseUi ? '阶段说明' : 'Explanation'}`)
    lines.push('')
    appendFormattedTextBlock(lines, stage.overview, isChineseUi)
  }

  if (stage.findings.length > 0) {
    lines.push('')
    lines.push(`## ${isChineseUi ? '问题明细' : 'Findings'}`)
    lines.push('')
    lines.push(...stage.findings.map((finding) => formatFindingBlock(finding, isChineseUi)))
  }

  appendStageSourceAssetSections(lines, stage, isChineseUi, {
    section: '##',
    asset: '###',
    feedback: '####'
  })

  const detailedContent = getStageResponseText(stage)
  if (detailedContent) {
    lines.push('')
    lines.push(`## ${isChineseUi ? '模型原始输出' : 'Model Output'}`)
    lines.push('')
    lines.push(detailedContent)
  }

  return `${lines.join('\n')}\n`
}

function buildReportMarkdown(
  report: CanvasTargetReport,
  isChineseUi: boolean,
  sourceLabel?: string
): string {
  const finalStage = report.stages?.find((stage) => stage.kind === 'control-summary')
  const reportSource = resolveStageSource({
    stage: {
      modelId: report.modelId,
      displayModelLabel: finalStage?.displayModelLabel
    },
    isChineseUi,
    sourceLabel,
    modelLabel: isChineseUi ? '主模型' : 'Primary Model'
  })
  const stageCount = report.stages?.length || 0
  const fallbackStageCount =
    report.stages?.filter((stage) => stage.status === 'fallback').length || 0
  const lines = [`# ${isChineseUi ? '画布目标报告' : 'Canvas Target Report'}`, '']

  pushQuotedSummary(lines, report.summary)
  lines.push('')
  lines.push(`## ${isChineseUi ? '报告信息' : 'Report Details'}`)
  lines.push(
    formatMetadataItem(
      isChineseUi ? '生成时间（UTC）' : 'Generated At (UTC)',
      formatReportTimestamp(report.generatedAt),
      isChineseUi
    )
  )
  lines.push(formatMetadataItem(reportSource.typeLabel, reportSource.sourceLabel, isChineseUi))
  if (reportSource.modelId) {
    lines.push(
      formatMetadataItem(
        isChineseUi ? '模型标识' : 'Model ID',
        `\`${reportSource.modelId}\``,
        isChineseUi
      )
    )
  }
  lines.push(
    formatMetadataItem(isChineseUi ? '目标阶段' : 'Stages', String(stageCount), isChineseUi)
  )
  lines.push(
    formatMetadataItem(
      isChineseUi ? '发现问题' : 'Findings',
      String(report.findings.length),
      isChineseUi
    )
  )
  if (fallbackStageCount > 0) {
    lines.push(
      formatMetadataItem(
        isChineseUi ? '回退阶段' : 'Fallback stages',
        String(fallbackStageCount),
        isChineseUi
      )
    )
  }

  if (report.overview.trim()) {
    lines.push('')
    lines.push(`## ${isChineseUi ? '总体概览' : 'Overview'}`)
    lines.push('')
    appendFormattedTextBlock(lines, report.overview, isChineseUi)
  }

  if (report.stages && report.stages.length > 0) {
    lines.push('')
    lines.push(`## ${isChineseUi ? '分阶段结果' : 'Stage Results'}`)
    for (const stage of report.stages) {
      const stageSource = resolveStageSource({
        stage,
        isChineseUi,
        modelLabel: isChineseUi ? '执行模型' : 'Model'
      })
      lines.push('')
      lines.push(`### ${stage.label}`)
      lines.push('')
      pushQuotedSummary(lines, stage.summary)
      lines.push('')
      lines.push(
        formatMetadataItem(
          isChineseUi ? '执行状态' : 'Status',
          formatStageStatus(stage.status, isChineseUi),
          isChineseUi
        )
      )
      lines.push(formatMetadataItem(stageSource.typeLabel, stageSource.sourceLabel, isChineseUi))
      if (stageSource.modelId) {
        lines.push(
          formatMetadataItem(
            isChineseUi ? '模型标识' : 'Model ID',
            `\`${stageSource.modelId}\``,
            isChineseUi
          )
        )
      }
      lines.push(
        formatMetadataItem(
          isChineseUi ? '发现问题' : 'Findings',
          String(stage.findings.length),
          isChineseUi
        )
      )
      if (stage.overview.trim()) {
        lines.push('')
        lines.push(`#### ${isChineseUi ? '阶段说明' : 'Explanation'}`)
        lines.push('')
        appendFormattedTextBlock(lines, stage.overview, isChineseUi)
      }
      appendStageSourceAssetSections(lines, stage, isChineseUi, {
        section: '####',
        asset: '#####',
        feedback: '######'
      })
    }
  }

  if (report.findings.length > 0) {
    lines.push('')
    lines.push(`## ${isChineseUi ? '问题明细' : 'Findings'}`)
    lines.push('')
    lines.push(...report.findings.map((finding) => formatFindingBlock(finding, isChineseUi)))
  }
  const finalOutput =
    getStageResponseText(finalStage || ({} as CanvasTargetReportStage), false) ||
    report.rawResponse?.trim() ||
    ''

  if (finalOutput) {
    lines.push('')
    lines.push(`## ${isChineseUi ? '最终输出' : 'Final Output'}`)
    lines.push('')
    lines.push(finalOutput)
  }

  return `${lines.join('\n')}\n`
}

function buildSafeFileStem(value: string, fallback: string): string {
  const safeValue = sanitizeFilePart(value.replace(/\s+/g, '_')).trim()
  return safeValue || fallback
}

function buildStageReportFileName(stage: CanvasTargetReportStage): string {
  const fileStem =
    stage.kind === 'control-summary'
      ? 'canvas-target-report'
      : `canvas-target-${buildSafeFileStem(stage.label, stage.kind)}`

  return `${fileStem}.md`
}

function buildStageReportContent(options: {
  stage: CanvasTargetReportStage
  report: CanvasTargetReport
  isChineseUi: boolean
  sourceLabel?: string
}): string {
  return options.stage.kind === 'control-summary'
    ? buildReportMarkdown(options.report, options.isChineseUi, options.sourceLabel)
    : buildStageMarkdown(options.stage, options.isChineseUi, options.sourceLabel)
}

function buildOcrFileName(stage: CanvasTargetReportStage, ocrResult: OCRResult): string {
  const fileStem = buildSafeFileStem(stage.label, stage.kind)
  return `canvas-target-${fileStem}-ocr-${ocrResult.kind}.json`
}

function buildOcrAttachmentContent(ocrResult: OCRResult): string {
  return JSON.stringify(ocrResult, null, 2)
}

function joinBundlePath(...segments: string[]): string {
  const normalizedSegments = segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment, index) => {
      const normalized = segment.replace(/[\\/]+/g, '/')
      if (index === 0) {
        return normalized.replace(/\/+$/, '')
      }
      return normalized.replace(/^\/+/, '').replace(/\/+$/, '')
    })

  return normalizedSegments.join('/')
}

function toLocalMediaUrl(fullPath: string): string {
  return `local-media:///${fullPath.replace(/[\\/]+/g, '/').replace(/^\/+/, '')}`
}

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

function getImageExtensionFromAttachment(attachment: ChatAttachment, index: number): string {
  const fileName = attachment.fileName?.trim() || ''
  const extension = getFileExtension(fileName)
  if (extension) {
    return extension
  }

  switch (attachment.mimeType?.toLowerCase()) {
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    case 'image/bmp':
      return '.bmp'
    case 'image/svg+xml':
      return '.svg'
    default:
      return index === 1 ? '.png' : '.png'
  }
}

function decodeTextAttachmentContent(attachment: ChatAttachment): string | null {
  if (!attachment.url.startsWith('data:')) {
    return null
  }

  const [, base64 = ''] = attachment.url.split(',', 2)
  try {
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function isBundleImageAttachment(attachment: ChatAttachment): boolean {
  return attachment.type === 'image'
}

function attachBundleMetadata(
  attachment: ChatAttachment,
  materialization: CanvasTargetBundleMaterialization,
  role: ReportBundleManifestEntry['role'],
  refName: string
): ChatAttachment {
  return {
    ...attachment,
    reportBundleId: materialization.bundleId,
    reportBundleRole: role,
    reportBundleRefName: refName,
    reportBundleManifestUrl: materialization.manifestUrl,
    reportBundleLabel: materialization.manifest.title
  }
}

async function buildBundleImageAttachment(options: {
  attachment: ChatAttachment
  bundleImagesDir: string
  imageIndex: number
  materialization: CanvasTargetBundleMaterialization
  saveImageToPath: (req: SaveImageToPathReq) => Promise<SaveImageToPathResp>
}): Promise<{
  attachment: ChatAttachment
  manifestEntry: ReportBundleManifestEntry
}> {
  const extension = getImageExtensionFromAttachment(options.attachment, options.imageIndex)
  const baseName =
    buildSafeFileStem(
      options.attachment.fileName?.replace(/\.[^.]+$/, '') || `figure-${options.imageIndex}`,
      `figure-${options.imageIndex}`
    ) || `figure-${options.imageIndex}`
  const fileName = `fig-${String(options.imageIndex).padStart(2, '0')}-${baseName}${extension}`
  const refName = fileName

  try {
    const response = await fetch(options.attachment.url)
    if (!response.ok) {
      throw new Error(`Failed to load image attachment (${response.status})`)
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    const saved = await options.saveImageToPath({
      image: bytes,
      outputPath: options.bundleImagesDir,
      filename: fileName
    })

    const localAttachment = attachBundleMetadata(
      {
        ...options.attachment,
        url: toLocalMediaUrl(saved.fullPath),
        fileName,
        sizeBytes: options.attachment.sizeBytes ?? bytes.byteLength
      },
      options.materialization,
      'report-image',
      refName
    )

    return {
      attachment: localAttachment,
      manifestEntry: {
        role: 'report-image',
        fileName,
        mimeType: localAttachment.mimeType,
        refName,
        relativePath: `images/${fileName}`,
        sizeBytes: localAttachment.sizeBytes
      }
    }
  } catch (error) {
    console.warn(
      '[CanvasTarget] Failed to persist bundle image attachment:',
      options.attachment,
      error
    )

    const remoteAttachment = attachBundleMetadata(
      options.attachment,
      options.materialization,
      'report-image',
      refName
    )

    return {
      attachment: remoteAttachment,
      manifestEntry: {
        role: 'report-image',
        fileName: options.attachment.fileName || fileName,
        mimeType: options.attachment.mimeType,
        refName,
        sourceUrl: options.attachment.url,
        sizeBytes: options.attachment.sizeBytes
      }
    }
  }
}

function buildStageReportAttachment(
  stage: CanvasTargetReportStage,
  report: CanvasTargetReport,
  isChineseUi: boolean,
  sourceLabel?: string
): ChatAttachment {
  const content = buildStageReportContent({
    stage,
    report,
    isChineseUi,
    sourceLabel
  })

  return buildTextAttachment({
    fileName: buildStageReportFileName(stage),
    content,
    mimeType: 'text/markdown'
  })
}

function buildOcrAttachment(stage: CanvasTargetReportStage, ocrResult: OCRResult): ChatAttachment {
  const content = buildOcrAttachmentContent(ocrResult)
  const textAttachment = buildTextAttachment({
    fileName: buildOcrFileName(stage, ocrResult),
    content,
    mimeType: 'application/json'
  })

  return {
    ...textAttachment,
    ocrResult
  }
}

function sortReportBundleAttachmentsForDisplay(attachments: ChatAttachment[]): ChatAttachment[] {
  return [...attachments].sort((left, right) => {
    const leftRank =
      left.reportBundleRole === 'primary-report'
        ? 0
        : left.reportBundleRole === 'report-image'
          ? 1
          : left.reportBundleRole === 'report-ocr'
            ? 2
            : 3
    const rightRank =
      right.reportBundleRole === 'primary-report'
        ? 0
        : right.reportBundleRole === 'report-image'
          ? 1
          : right.reportBundleRole === 'report-ocr'
            ? 2
            : 3

    return leftRank - rightRank
  })
}

export async function materializeCanvasTargetAgentMessagePayload(
  options: {
    report: CanvasTargetReport
    stage: CanvasTargetReportStage
    isChineseUi: boolean
    sourceLabel?: string
    includeReportFile?: boolean
  } & CanvasTargetAgentBundleOptions
): Promise<CanvasTargetAgentMessagePayload> {
  const payload = buildCanvasTargetAgentMessagePayload(options)

  if (!options.bundleRootDir?.trim() || !options.writeTextFile || !options.saveImageToPath) {
    return payload
  }

  const stageReportAttachment = payload.attachments.find(
    (attachment) =>
      attachment.type === 'file' && attachment.fileName === buildStageReportFileName(options.stage)
  )
  const stageReportContent = stageReportAttachment
    ? decodeTextAttachmentContent(stageReportAttachment)
    : null

  if (!stageReportAttachment || stageReportContent === null) {
    return payload
  }

  const stageReportFileName =
    stageReportAttachment.fileName || buildStageReportFileName(options.stage)

  const bundleId = `canvas-target-${options.stage.id || buildSafeFileStem(options.stage.label, options.stage.kind)}`
  const bundleDir = joinBundlePath(options.bundleRootDir, REPORT_BUNDLES_ROOT_DIR, bundleId)
  const bundleImagesDir = joinBundlePath(bundleDir, 'images')
  const manifestPath = joinBundlePath(bundleDir, 'manifest.json')
  const manifestUrl = toLocalMediaUrl(manifestPath)
  const materialization: CanvasTargetBundleMaterialization = {
    bundleId,
    manifestUrl,
    manifest: {
      version: REPORT_BUNDLE_MANIFEST_VERSION,
      bundleId,
      title: options.stage.label,
      createdAt: new Date().toISOString(),
      primaryRefName: stageReportFileName,
      entries: []
    }
  }

  const primaryWriteResult = await options.writeTextFile({
    outputPath: bundleDir,
    filename: stageReportFileName,
    content: stageReportContent
  })

  const primaryAttachment = attachBundleMetadata(
    {
      ...stageReportAttachment,
      url: toLocalMediaUrl(primaryWriteResult.fullPath),
      sizeBytes:
        stageReportAttachment.sizeBytes || new TextEncoder().encode(stageReportContent).byteLength
    },
    materialization,
    'primary-report',
    stageReportFileName
  )

  materialization.manifest.entries.push({
    role: 'primary-report',
    fileName: primaryAttachment.fileName || buildStageReportFileName(options.stage),
    mimeType: primaryAttachment.mimeType,
    refName: primaryAttachment.reportBundleRefName,
    relativePath: primaryAttachment.fileName,
    sizeBytes: primaryAttachment.sizeBytes
  })

  const persistedBundleAttachments: ChatAttachment[] = [primaryAttachment]
  let imageIndex = 0

  for (const attachment of payload.attachments) {
    if (attachment === stageReportAttachment) {
      continue
    }

    if (isBundleImageAttachment(attachment)) {
      imageIndex += 1
      const persistedImage = await buildBundleImageAttachment({
        attachment,
        bundleImagesDir,
        imageIndex,
        materialization,
        saveImageToPath: options.saveImageToPath
      })
      materialization.manifest.entries.push(persistedImage.manifestEntry)
      persistedBundleAttachments.push(persistedImage.attachment)
      continue
    }

    if (attachment.type === 'file' && attachment.ocrResult) {
      const ocrContent =
        decodeTextAttachmentContent(attachment) || buildOcrAttachmentContent(attachment.ocrResult)
      const ocrWriteResult = await options.writeTextFile({
        outputPath: bundleDir,
        filename: attachment.fileName || buildOcrFileName(options.stage, attachment.ocrResult),
        content: ocrContent
      })
      const persistedOcrAttachment = attachBundleMetadata(
        {
          ...attachment,
          url: toLocalMediaUrl(ocrWriteResult.fullPath),
          sizeBytes: attachment.sizeBytes || new TextEncoder().encode(ocrContent).byteLength
        },
        materialization,
        'report-ocr',
        attachment.fileName || buildOcrFileName(options.stage, attachment.ocrResult)
      )
      materialization.manifest.entries.push({
        role: 'report-ocr',
        fileName:
          persistedOcrAttachment.fileName || buildOcrFileName(options.stage, attachment.ocrResult),
        mimeType: persistedOcrAttachment.mimeType,
        refName: persistedOcrAttachment.reportBundleRefName,
        relativePath: persistedOcrAttachment.fileName,
        sizeBytes: persistedOcrAttachment.sizeBytes
      })
      persistedBundleAttachments.push(persistedOcrAttachment)
      continue
    }

    persistedBundleAttachments.push(attachment)
  }

  await options.writeTextFile({
    outputPath: bundleDir,
    filename: 'manifest.json',
    content: JSON.stringify(materialization.manifest, null, 2)
  })

  return {
    ...payload,
    attachments: sortReportBundleAttachmentsForDisplay(persistedBundleAttachments)
  }
}

export function buildCanvasTargetAgentMessagePayload(options: {
  report: CanvasTargetReport
  stage: CanvasTargetReportStage
  isChineseUi: boolean
  sourceLabel?: string
  includeReportFile?: boolean
}): CanvasTargetAgentMessagePayload {
  const stageSource = resolveStageSource(options)
  const includeReportFile = options.includeReportFile === true
  const generatedAttachments: ChatAttachment[] = includeReportFile
    ? [
        buildStageReportAttachment(
          options.stage,
          options.report,
          options.isChineseUi,
          options.sourceLabel
        )
      ]
    : []

  if (includeReportFile && options.stage.responseOcrResult) {
    generatedAttachments.push(buildOcrAttachment(options.stage, options.stage.responseOcrResult))
  }

  const content = !includeReportFile
    ? options.isChineseUi
      ? [
          options.stage.responseAttachments?.length
            ? `已生成“${options.stage.label}”目标结果。`
            : options.stage.summary || `“${options.stage.label}”已完成。`,
          `${stageSource.typeLabel}：${stageSource.sourceLabel}`
        ].join('\n')
      : [
          options.stage.responseAttachments?.length
            ? `Generated target results for "${options.stage.label}".`
            : options.stage.summary || `"${options.stage.label}" completed.`,
          `${stageSource.typeLabel}: ${stageSource.sourceLabel}`
        ].join('\n')
    : options.isChineseUi
      ? [
          `已生成“${options.stage.label}”目标结果文件。`,
          `${stageSource.typeLabel}：${stageSource.sourceLabel}`,
          '可拖到画布后，双击展开查看具体内容。'
        ].join('\n')
      : [
          `Generated files for "${options.stage.label}".`,
          `${stageSource.typeLabel}: ${stageSource.sourceLabel}`,
          'Drag them onto the canvas, then double-click to inspect the full content.'
        ].join('\n')

  return {
    content,
    attachments: sortReportBundleAttachmentsForDisplay([
      ...generatedAttachments,
      ...(options.stage.responseAttachments || [])
    ])
  }
}

export function buildCanvasTargetAgentFinalSummaryText(options: {
  stage: CanvasTargetReportStage
}): string {
  const summaryText = options.stage.summary.trim()
  const responseText = options.stage.responseContent?.trim()

  if (!summaryText && !responseText) {
    return ''
  }

  if (!responseText) {
    return summaryText
  }

  const guardedResponseText = guardCanvasTargetTextForUi(responseText, {
    kind: 'response'
  })
  if (!guardedResponseText) {
    return summaryText
  }

  if (guardedResponseText !== responseText) {
    return guardedResponseText
  }

  if (responseText.length > CANVAS_TARGET_MAX_FINAL_CHAT_TEXT_CHARS && summaryText) {
    return summaryText
  }

  return responseText
}
