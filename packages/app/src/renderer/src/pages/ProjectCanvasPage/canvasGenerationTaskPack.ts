import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasHtmlItem,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasTextItem,
  CanvasVideoItem
} from './types'

export type GenerationRouteChoice =
  | {
      type: 'project-style-model'
      modelId: string
      modelLabel: string
    }
  | {
      type: 'default-agent'
    }

export type GenerationTaskPackEntry = {
  id: string
  title: string
  excerpt?: string
  contentText?: string
}

export type GenerationTaskPackAssetEntry = {
  id: string
  title: string
  assetType: 'image' | 'video' | 'model3d'
}

export type GenerationTaskPack = {
  projectId: string
  projectName: string
  selectedItemIds: string[]
  summary: {
    totalItems: number
    requirementDocs: number
    referenceDocs: number
    referenceImages: number
    styleReferenceImages: number
    taskNotes: number
    existingAssets: number
  }
  requirementDocs: GenerationTaskPackEntry[]
  referenceDocs: GenerationTaskPackEntry[]
  referenceImages: GenerationTaskPackEntry[]
  styleReferenceImages: GenerationTaskPackEntry[]
  taskNotes: GenerationTaskPackEntry[]
  existingAssets: GenerationTaskPackAssetEntry[]
}

type BuildCanvasGenerationTaskPackOptions = {
  projectId: string
  projectName: string
  items: CanvasItem[]
}

const REQUIREMENT_KEYWORDS = [
  '需求',
  'brief',
  'requirement',
  '任务',
  '说明',
  '目标',
  '脚本',
  '文案'
]
const STYLE_KEYWORDS = ['风格', 'style', '调性', '甲方参考', '氛围', '质感', '视觉']
const REFERENCE_KEYWORDS = ['参考', 'reference', 'ref', '对标', '样例', '示例']
const NOTE_KEYWORDS = ['备注', 'note', '注释', '补充', '要求']

function normalizeText(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function buildExcerpt(value: string | undefined, limit = 140): string | undefined {
  const normalized = normalizeText(value)
  if (!normalized) return undefined
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized
}

function buildPromptContent(value: string | undefined, limit = 4000): string | undefined {
  const normalized = normalizeText(value)
  if (!normalized) return undefined
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized
}

function matchesKeywords(value: string, keywords: string[]): boolean {
  const normalized = value.toLowerCase()
  return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))
}

function getItemTitle(item: CanvasItem): string {
  switch (item.type) {
    case 'file':
      return item.fileName
    case 'image':
      return item.fileName || `图片 ${item.id}`
    case 'video':
      return item.fileName || `视频 ${item.id}`
    case 'model3d':
      return item.fileName || `模型 ${item.id}`
    case 'text':
      return buildExcerpt(item.text, 48) || `文本 ${item.id}`
    case 'html':
      return buildExcerpt(item.htmlData.replace(/<[^>]+>/g, ' '), 48) || `HTML ${item.id}`
    case 'annotation':
      return buildExcerpt(item.text || item.label, 48) || `标注 ${item.id}`
    default:
      return ''
  }
}

function getItemSearchText(item: CanvasItem): string {
  switch (item.type) {
    case 'file':
      return [item.fileName, item.previewText, item.content].filter(Boolean).join(' ')
    case 'image':
      return [item.fileName, item.promptId].filter(Boolean).join(' ')
    case 'video':
    case 'model3d':
      return item.fileName
    case 'text':
      return item.text
    case 'html':
      return item.htmlData.replace(/<[^>]+>/g, ' ')
    case 'annotation':
      return [item.label, item.text].filter(Boolean).join(' ')
    default:
      return ''
  }
}

function buildFileEntry(item: CanvasFileItem): GenerationTaskPackEntry {
  const contentText = buildPromptContent(item.content || item.previewText)
  return {
    id: item.id,
    title: item.fileName,
    excerpt: buildExcerpt(item.previewText || item.content),
    ...(contentText ? { contentText } : {})
  }
}

function buildTextEntry(
  item: CanvasTextItem | CanvasAnnotationItem | CanvasHtmlItem
): GenerationTaskPackEntry {
  const sourceText =
    item.type === 'text'
      ? item.text
      : item.type === 'annotation'
        ? item.text || item.label
        : item.htmlData.replace(/<[^>]+>/g, ' ')

  const contentText = buildPromptContent(sourceText)

  return {
    id: item.id,
    title: getItemTitle(item),
    excerpt: buildExcerpt(sourceText, 200),
    ...(contentText ? { contentText } : {})
  }
}

function buildImageEntry(item: CanvasImageItem): GenerationTaskPackEntry {
  return {
    id: item.id,
    title: item.fileName || `图片 ${item.id}`,
    excerpt: item.promptId ? `已有生成资产，promptId: ${item.promptId}` : undefined
  }
}

function buildAssetEntry(
  item: CanvasImageItem | CanvasVideoItem | CanvasModel3DItem
): GenerationTaskPackAssetEntry {
  return {
    id: item.id,
    title: getItemTitle(item),
    assetType: item.type
  }
}

function classifyFileItem(
  item: CanvasFileItem,
  taskPack: Omit<GenerationTaskPack, 'summary'>
): void {
  const searchText = getItemSearchText(item)

  if (matchesKeywords(searchText, REQUIREMENT_KEYWORDS)) {
    taskPack.requirementDocs.push(buildFileEntry(item))
    return
  }

  if (matchesKeywords(searchText, STYLE_KEYWORDS)) {
    taskPack.referenceDocs.push(buildFileEntry(item))
    return
  }

  if (matchesKeywords(searchText, REFERENCE_KEYWORDS)) {
    taskPack.referenceDocs.push(buildFileEntry(item))
    return
  }

  taskPack.requirementDocs.push(buildFileEntry(item))
}

function classifyImageItem(
  item: CanvasImageItem,
  taskPack: Omit<GenerationTaskPack, 'summary'>
): void {
  const searchText = getItemSearchText(item)
  if (item.promptId) {
    taskPack.existingAssets.push(buildAssetEntry(item))
    return
  }

  if (matchesKeywords(searchText, STYLE_KEYWORDS)) {
    taskPack.styleReferenceImages.push(buildImageEntry(item))
    return
  }

  taskPack.referenceImages.push(buildImageEntry(item))
}

function classifyNoteItem(
  item: CanvasTextItem | CanvasAnnotationItem | CanvasHtmlItem,
  taskPack: Omit<GenerationTaskPack, 'summary'>
): void {
  const entry = buildTextEntry(item)
  const searchText = getItemSearchText(item)

  if (matchesKeywords(searchText, NOTE_KEYWORDS)) {
    taskPack.taskNotes.push(entry)
    return
  }

  if (matchesKeywords(searchText, REQUIREMENT_KEYWORDS)) {
    taskPack.requirementDocs.push(entry)
    return
  }

  if (matchesKeywords(searchText, STYLE_KEYWORDS)) {
    taskPack.referenceDocs.push(entry)
    return
  }

  if (matchesKeywords(searchText, REFERENCE_KEYWORDS)) {
    taskPack.referenceDocs.push(entry)
    return
  }

  taskPack.taskNotes.push(entry)
}

export function buildCanvasGenerationTaskPack(
  options: BuildCanvasGenerationTaskPackOptions
): GenerationTaskPack {
  const baseTaskPack: Omit<GenerationTaskPack, 'summary'> = {
    projectId: options.projectId,
    projectName: options.projectName,
    selectedItemIds: options.items.map((item) => item.id),
    requirementDocs: [],
    referenceDocs: [],
    referenceImages: [],
    styleReferenceImages: [],
    taskNotes: [],
    existingAssets: []
  }

  for (const item of options.items) {
    switch (item.type) {
      case 'file':
        classifyFileItem(item, baseTaskPack)
        break
      case 'image':
        classifyImageItem(item, baseTaskPack)
        break
      case 'video':
      case 'model3d':
        baseTaskPack.existingAssets.push(buildAssetEntry(item))
        break
      case 'text':
      case 'annotation':
      case 'html':
        classifyNoteItem(item, baseTaskPack)
        break
      default:
        break
    }
  }

  return {
    ...baseTaskPack,
    summary: {
      totalItems: options.items.length,
      requirementDocs: baseTaskPack.requirementDocs.length,
      referenceDocs: baseTaskPack.referenceDocs.length,
      referenceImages: baseTaskPack.referenceImages.length,
      styleReferenceImages: baseTaskPack.styleReferenceImages.length,
      taskNotes: baseTaskPack.taskNotes.length,
      existingAssets: baseTaskPack.existingAssets.length
    }
  }
}

function formatEntries(
  label: string,
  entries: Array<GenerationTaskPackEntry | GenerationTaskPackAssetEntry>
): string[] {
  if (entries.length === 0) return []
  return [
    `${label}（${entries.length}）`,
    ...entries.map((entry) => {
      if ('contentText' in entry && entry.contentText) {
        const normalizedTitle = normalizeText(entry.title)
        const normalizedContent = normalizeText(entry.contentText)
        if (!normalizedTitle || normalizedTitle === normalizedContent) {
          return `- ${entry.contentText}`
        }
        return `- ${entry.title}: ${entry.contentText}`
      }

      if ('excerpt' in entry && entry.excerpt) {
        const normalizedTitle = normalizeText(entry.title)
        const normalizedExcerpt = normalizeText(entry.excerpt)
        if (!normalizedTitle || normalizedTitle === normalizedExcerpt) {
          return `- ${entry.excerpt}`
        }
        return `- ${entry.title}: ${entry.excerpt}`
      }

      return 'assetType' in entry ? `- ${entry.title} [${entry.assetType}]` : `- ${entry.title}`
    })
  ]
}

function formatImageReferenceSummary(label: string, count: number, guidance: string): string[] {
  if (count === 0) return []
  return [`${label}：已附上 ${count} 张，请直接结合图像内容${guidance}。`]
}

export function buildCanvasGenerationTaskPackPrompt(
  taskPack: GenerationTaskPack,
  route: GenerationRouteChoice
): string {
  const routeLine =
    route.type === 'project-style-model'
      ? `风格约束：本轮请按项目模型「${route.modelLabel}」对应的视觉方向组织出图。`
      : ''

  return [
    taskPack.projectName ? `项目：${taskPack.projectName}` : '',
    `任务概况：本次选中了 ${taskPack.summary.totalItems} 个画板元素，其中需求文档 ${taskPack.summary.requirementDocs}，参考文档 ${taskPack.summary.referenceDocs}，参考图 ${taskPack.summary.referenceImages}，风格参考图 ${taskPack.summary.styleReferenceImages}，任务备注 ${taskPack.summary.taskNotes}，已有素材 ${taskPack.summary.existingAssets}。`,
    routeLine,
    '请先理解需求和参考，再给出可继续推进的候选图方向、关键画面描述、生成要点和下一步建议。',
    ...formatEntries('需求文档', taskPack.requirementDocs),
    ...formatEntries('参考文档', taskPack.referenceDocs),
    ...formatImageReferenceSummary(
      '参考图',
      taskPack.referenceImages.length,
      '理解主体、动作和场景'
    ),
    ...formatImageReferenceSummary(
      '风格参考图',
      taskPack.styleReferenceImages.length,
      '理解整体风格、材质和氛围'
    ),
    ...formatEntries('任务备注', taskPack.taskNotes),
    ...formatEntries('现有素材', taskPack.existingAssets)
  ]
    .filter(Boolean)
    .join('\n')
}
