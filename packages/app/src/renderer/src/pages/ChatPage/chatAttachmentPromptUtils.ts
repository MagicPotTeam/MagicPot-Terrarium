import type { ReportBundleManifest, ReportBundleManifestEntry } from '@shared/reportBundle'
import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { normalizeLocalMediaUrl } from './chatPageShared'

const TEXT_FILE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.html',
  '.css',
  '.xml',
  '.yaml',
  '.yml'
])

const MAX_FILE_PREVIEW_CHARS = 2000
const MIN_REPORT_INLINE_CHARS = 3000

type AttachmentTextReader = (url: string) => Promise<string>

type AugmentAttachmentOptions = {
  role?: ChatMessage['role']
  reportInlineCharLimit?: number
  skipAttachment?: (attachment: ChatAttachment) => boolean
}

const getAttachmentExtension = (attachment: ChatAttachment): string => {
  const fileName = attachment.fileName || ''
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : ''
}

const isTextLikeFileAttachment = (attachment: ChatAttachment): boolean => {
  if (attachment.type !== 'file') return false
  if (attachment.mimeType?.startsWith('text/')) return true
  return TEXT_FILE_EXTENSIONS.has(getAttachmentExtension(attachment))
}

const isPrimaryReportBundleAttachment = (attachment: ChatAttachment): boolean =>
  attachment.type === 'file' && attachment.reportBundleRole === 'primary-report'

const buildAttachmentLabel = (attachment: ChatAttachment): string =>
  attachment.fileName || `unnamed-${attachment.type}`

const buildAttachmentHeading = (attachment: ChatAttachment): string => {
  if (isPrimaryReportBundleAttachment(attachment)) return 'Attached report'
  if (attachment.type === 'image') return 'Attached image'
  if (attachment.type === 'video') return 'Attached video'
  if (attachment.type === 'model3d') return 'Attached 3D model'
  return 'Attached file'
}

const buildAttachmentTypeLabel = (attachment: ChatAttachment): string => {
  if (attachment.type === 'video') return 'video'
  if (attachment.type === 'model3d') return '3D model'
  if (isPrimaryReportBundleAttachment(attachment)) return 'report'
  return attachment.type
}

const buildFallbackSummary = (attachment: ChatAttachment): string =>
  `${buildAttachmentTypeLabel(attachment)} attached: ${buildAttachmentLabel(attachment)}${
    attachment.mimeType ? ` (${attachment.mimeType})` : ''
  }`

const buildAttachmentMetadataSummary = (attachment: ChatAttachment): string => {
  const parts: string[] = []

  if (attachment.fileName?.trim()) {
    parts.push(`fileName="${attachment.fileName.trim()}"`)
  }

  if (attachment.mimeType?.trim()) {
    parts.push(`mimeType="${attachment.mimeType.trim()}"`)
  }

  if (typeof attachment.sizeBytes === 'number' && Number.isFinite(attachment.sizeBytes)) {
    parts.push(`sizeBytes=${Math.max(0, Math.round(attachment.sizeBytes))}`)
  }

  if (
    typeof attachment.sourceWidth === 'number' &&
    Number.isFinite(attachment.sourceWidth) &&
    attachment.sourceWidth > 0 &&
    typeof attachment.sourceHeight === 'number' &&
    Number.isFinite(attachment.sourceHeight) &&
    attachment.sourceHeight > 0
  ) {
    parts.push(
      `resolution=${Math.round(attachment.sourceWidth)}x${Math.round(attachment.sourceHeight)}`
    )
  }

  return parts.length > 0 ? `Metadata: ${parts.join('; ')}` : ''
}

const buildAttachmentSummaryBlock = (attachment: ChatAttachment, detailContent: string): string =>
  [buildAttachmentMetadataSummary(attachment), detailContent].filter(Boolean).join('\n')

const hasEmbeddedFileSummary = (content: string, attachment: ChatAttachment): boolean => {
  const label = buildAttachmentLabel(attachment)
  return (
    content.includes(`[Canvas file] ${label}`) ||
    content.includes(`[Attached image] ${label}`) ||
    content.includes(`[Attached report] ${label}`) ||
    content.includes(`[Attached file] ${label}`) ||
    content.includes(`[Attached video] ${label}`) ||
    content.includes(`[Attached 3D model] ${label}`)
  )
}

const normalizePreviewText = (text: string): string => {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_FILE_PREVIEW_CHARS) {
    return trimmed
  }
  return `${trimmed.slice(0, MAX_FILE_PREVIEW_CHARS)}\n[Preview truncated]`
}

function buildReportInlineText(text: string, maxChars: number): string {
  const trimmed = text.trim()
  const effectiveLimit = Math.max(MIN_REPORT_INLINE_CHARS, maxChars)
  if (trimmed.length <= effectiveLimit) {
    return trimmed
  }

  const sections = trimmed
    .split(/\n(?=##\s+)/)
    .map((section) => section.trim())
    .filter(Boolean)

  const chosenSections: string[] = []
  let consumed = 0

  for (const section of sections) {
    const nextLength = consumed + section.length + (chosenSections.length > 0 ? 2 : 0)
    if (nextLength > effectiveLimit && chosenSections.length > 0) {
      break
    }
    if (nextLength > effectiveLimit) {
      chosenSections.push(`${section.slice(0, effectiveLimit)}\n[Report truncated]`)
      return chosenSections.join('\n\n')
    }
    chosenSections.push(section)
    consumed = nextLength
  }

  if (chosenSections.length === 0) {
    return `${trimmed.slice(0, effectiveLimit)}\n[Report truncated]`
  }

  if (chosenSections.join('\n\n').length >= trimmed.length) {
    return chosenSections.join('\n\n')
  }

  return `${chosenSections.join('\n\n')}\n\n[Report truncated]`
}

async function readAttachmentTextFromUrl(url: string): Promise<string> {
  const response = await fetch(normalizeLocalMediaUrl(url))
  if (!response.ok) {
    throw new Error(`Failed to read attachment text (${response.status})`)
  }
  return response.text()
}

function buildBundleUrlFromManifestEntry(
  manifestUrl: string,
  entry: ReportBundleManifestEntry
): string | null {
  if (entry.sourceUrl?.trim()) {
    return entry.sourceUrl.trim()
  }
  if (!entry.relativePath?.trim()) {
    return null
  }

  const normalizedManifestUrl = normalizeLocalMediaUrl(manifestUrl)
  if (normalizedManifestUrl.startsWith('local-media://')) {
    const manifestPath = normalizedManifestUrl.replace(/^local-media:\/\/\/?/, '')
    const baseSegments = manifestPath.split('/').slice(0, -1)
    const relativeSegments = entry.relativePath
      .split(/[\\/]+/)
      .map((segment) => segment.trim())
      .filter(Boolean)
    return `local-media:///${[...baseSegments, ...relativeSegments].join('/')}`
  }

  try {
    const baseUrl = new URL(normalizedManifestUrl)
    const basePath = baseUrl.pathname.replace(/\/[^/]*$/, '/')
    baseUrl.pathname = `${basePath}${entry.relativePath.replace(/^\/+/, '')}`
    return baseUrl.toString()
  } catch {
    return null
  }
}

function createBundleAttachmentFromEntry(
  entry: ReportBundleManifestEntry,
  manifest: ReportBundleManifest,
  manifestUrl: string
): ChatAttachment | null {
  const resolvedUrl = buildBundleUrlFromManifestEntry(manifestUrl, entry)
  if (!resolvedUrl) {
    return null
  }

  return {
    type: entry.role === 'report-image' ? 'image' : 'file',
    url: resolvedUrl,
    fileName: entry.fileName,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes,
    reportBundleId: manifest.bundleId,
    reportBundleRole: entry.role,
    reportBundleRefName: entry.refName || entry.fileName,
    reportBundleManifestUrl: manifestUrl,
    reportBundleLabel: manifest.title
  }
}

function buildAttachmentKey(attachment: ChatAttachment): string {
  return [
    attachment.reportBundleId || '',
    attachment.reportBundleRole || '',
    attachment.reportBundleRefName || '',
    attachment.type,
    attachment.url,
    attachment.fileName || ''
  ].join('::')
}

export async function expandReportBundleAttachments(
  attachments: ChatAttachment[] | undefined,
  readAttachmentText: AttachmentTextReader = readAttachmentTextFromUrl
): Promise<ChatAttachment[] | undefined> {
  if (!attachments?.length) {
    return attachments
  }

  const expanded = [...attachments]
  const seenKeys = new Set(expanded.map(buildAttachmentKey))
  const manifestUrls = Array.from(
    new Set(
      attachments
        .filter(isPrimaryReportBundleAttachment)
        .map((attachment) => attachment.reportBundleManifestUrl?.trim() || '')
        .filter(Boolean)
    )
  )

  for (const manifestUrl of manifestUrls) {
    try {
      const manifestText = await readAttachmentText(manifestUrl)
      const manifest = JSON.parse(manifestText) as ReportBundleManifest
      const bundleEntries = manifest.entries.filter((entry) => entry.role === 'report-image')
      for (const entry of bundleEntries) {
        const attachment = createBundleAttachmentFromEntry(entry, manifest, manifestUrl)
        if (!attachment) {
          continue
        }
        const key = buildAttachmentKey(attachment)
        if (seenKeys.has(key)) {
          continue
        }
        seenKeys.add(key)
        expanded.push(attachment)
      }
    } catch (error) {
      console.warn('[ChatPage] Failed to expand report bundle attachments:', manifestUrl, error)
    }
  }

  return expanded
}

export async function augmentMessageContentWithFileAttachments(
  attachments: ChatAttachment[] | undefined,
  content: string,
  readAttachmentText: AttachmentTextReader = readAttachmentTextFromUrl,
  options: AugmentAttachmentOptions = {}
): Promise<string> {
  if (!attachments?.length) {
    return content
  }

  const additions: string[] = []

  for (const attachment of attachments) {
    if (options.skipAttachment?.(attachment)) {
      continue
    }

    if (hasEmbeddedFileSummary(content, attachment)) {
      continue
    }

    const heading = buildAttachmentHeading(attachment)

    if (isPrimaryReportBundleAttachment(attachment)) {
      if (options.role !== 'user') {
        additions.push(
          `[${heading}] ${buildAttachmentLabel(attachment)}\n${buildAttachmentSummaryBlock(
            attachment,
            buildFallbackSummary(attachment)
          )}`
        )
        continue
      }

      try {
        const rawText = await readAttachmentText(attachment.url)
        const reportInlineText = buildReportInlineText(
          rawText,
          options.reportInlineCharLimit || MAX_FILE_PREVIEW_CHARS
        )
        additions.push(
          `[${heading}] ${buildAttachmentLabel(attachment)}\n${buildAttachmentSummaryBlock(
            attachment,
            reportInlineText || buildFallbackSummary(attachment)
          )}`
        )
      } catch (error) {
        console.warn(
          '[ChatPage] Failed to read report bundle attachment:',
          attachment.fileName,
          error
        )
        additions.push(
          `[${heading}] ${buildAttachmentLabel(attachment)}\n${buildAttachmentSummaryBlock(
            attachment,
            buildFallbackSummary(attachment)
          )}`
        )
      }
      continue
    }

    if (attachment.type !== 'file') {
      additions.push(
        `[${heading}] ${buildAttachmentLabel(attachment)}\n${buildAttachmentSummaryBlock(
          attachment,
          buildFallbackSummary(attachment)
        )}`
      )
      continue
    }

    if (!isTextLikeFileAttachment(attachment)) {
      additions.push(
        `[${heading}] ${buildAttachmentLabel(attachment)}\n${buildAttachmentSummaryBlock(
          attachment,
          buildFallbackSummary(attachment)
        )}`
      )
      continue
    }

    try {
      const rawText = await readAttachmentText(attachment.url)
      const previewText = normalizePreviewText(rawText)
      additions.push(
        `[${heading}] ${buildAttachmentLabel(attachment)}\n${buildAttachmentSummaryBlock(
          attachment,
          previewText || buildFallbackSummary(attachment)
        )}`
      )
    } catch (error) {
      console.warn(
        '[ChatPage] Failed to read file attachment text preview:',
        attachment.fileName,
        error
      )
      additions.push(
        `[${heading}] ${buildAttachmentLabel(attachment)}\n${buildAttachmentSummaryBlock(
          attachment,
          buildFallbackSummary(attachment)
        )}`
      )
    }
  }

  if (additions.length === 0) {
    return content
  }

  return [content.trim(), additions.join('\n\n')].filter(Boolean).join('\n\n')
}

export const augmentContentWithFileAttachmentSummaries = augmentMessageContentWithFileAttachments
