import type { ChatAttachment } from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'

const VIDEO_FRAME_CAPTURE_OFFSET_SECONDS = 0.05
const FIRST_FRAME_SUFFIX = 'first-frame'
const LAST_FRAME_SUFFIX = 'last-frame'

type VideoFrameExtractor = (videoSrc: string) => Promise<{
  firstFrameDataUrl?: string
  lastFrameDataUrl?: string
}>

function waitForMediaEvent(
  media: HTMLMediaElement,
  type: 'loadedmetadata' | 'loadeddata' | 'seeked' | 'error'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener(type, handleResolve)
      media.removeEventListener('error', handleError)
    }

    const handleResolve = () => {
      cleanup()
      resolve()
    }

    const handleError = () => {
      cleanup()
      reject(new Error(`Failed while waiting for media event "${type}"`))
    }

    media.addEventListener(type, handleResolve, { once: true })
    media.addEventListener('error', handleError, { once: true })
  })
}

function captureVideoFrameDataUrl(video: HTMLVideoElement): string | undefined {
  if (!video.videoWidth || !video.videoHeight) {
    return undefined
  }

  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  if (!context) {
    return undefined
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

async function captureVideoFrameAtTime(
  video: HTMLVideoElement,
  timeInSeconds: number
): Promise<string | undefined> {
  const duration = Number.isFinite(video.duration) ? video.duration : 0
  const clampedTime = Math.min(Math.max(timeInSeconds, 0), Math.max(duration, 0))

  if (Math.abs((video.currentTime || 0) - clampedTime) > 0.01) {
    const seekPromise = waitForMediaEvent(video, 'seeked')
    video.currentTime = clampedTime
    await seekPromise
  }

  return captureVideoFrameDataUrl(video)
}

export async function extractVideoBoundaryFrameDataUrls(videoSrc: string): Promise<{
  firstFrameDataUrl?: string
  lastFrameDataUrl?: string
}> {
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  video.src = videoSrc
  video.load()

  try {
    if (video.readyState < 1) {
      await waitForMediaEvent(video, 'loadedmetadata')
    }
    if (video.readyState < 2) {
      await waitForMediaEvent(video, 'loadeddata')
    }

    const firstFrameDataUrl = await captureVideoFrameAtTime(video, 0)
    const hasDuration = Number.isFinite(video.duration) && video.duration > 0
    const lastFrameTime = hasDuration
      ? Math.max(video.duration - VIDEO_FRAME_CAPTURE_OFFSET_SECONDS, 0)
      : 0
    const lastFrameDataUrl = await captureVideoFrameAtTime(video, lastFrameTime)

    return {
      firstFrameDataUrl,
      lastFrameDataUrl
    }
  } finally {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }
}

function buildVideoFrameNote(fileName: string, kind: 'first frame' | 'last frame'): string {
  return `Included the ${kind} from video "${fileName}".`
}

function getVideoDisplayName(attachment: ChatAttachment): string {
  return attachment.fileName || 'unnamed-video'
}

function getVideoFrameFileName(
  attachment: ChatAttachment,
  suffix: typeof FIRST_FRAME_SUFFIX | typeof LAST_FRAME_SUFFIX
): string {
  const sourceName = attachment.fileName || 'video'
  const lastDotIndex = sourceName.lastIndexOf('.')
  const baseName = lastDotIndex > 0 ? sourceName.slice(0, lastDotIndex) : sourceName
  return `${baseName}-${suffix}.png`
}

function hasBoundaryFrameNotes(content: string, attachment: ChatAttachment): boolean {
  const fileName = getVideoDisplayName(attachment)
  return (
    content.includes(buildVideoFrameNote(fileName, 'first frame')) &&
    content.includes(buildVideoFrameNote(fileName, 'last frame'))
  )
}

function hasVideoFrameAttachment(
  attachments: ChatAttachment[],
  attachment: ChatAttachment,
  suffix: typeof FIRST_FRAME_SUFFIX | typeof LAST_FRAME_SUFFIX
): boolean {
  const expectedFileName = getVideoFrameFileName(attachment, suffix)
  return attachments.some(
    (item) =>
      item.type === 'image' && item.fileName === expectedFileName && item.mimeType === 'image/png'
  )
}

export async function augmentAttachmentsWithVideoBoundaryFrames(
  attachments: ChatAttachment[] | undefined,
  content: string,
  extractFrames: VideoFrameExtractor = extractVideoBoundaryFrameDataUrls
): Promise<{ attachments: ChatAttachment[] | undefined; content: string }> {
  if (!attachments?.length) {
    return { attachments, content }
  }

  const nextAttachments = [...attachments]
  const supplementalNotes: string[] = []

  for (const attachment of attachments) {
    if (attachment.type !== 'video' || !attachment.url) {
      continue
    }

    const hasFirstFrameAttachment = hasVideoFrameAttachment(
      nextAttachments,
      attachment,
      FIRST_FRAME_SUFFIX
    )
    const hasLastFrameAttachment = hasVideoFrameAttachment(
      nextAttachments,
      attachment,
      LAST_FRAME_SUFFIX
    )
    const hasNotes = hasBoundaryFrameNotes(content, attachment)

    if (hasFirstFrameAttachment && hasLastFrameAttachment && hasNotes) {
      continue
    }

    try {
      const { firstFrameDataUrl, lastFrameDataUrl } = await extractFrames(attachment.url)
      const displayName = getVideoDisplayName(attachment)

      if (!hasFirstFrameAttachment && firstFrameDataUrl) {
        nextAttachments.push({
          type: 'image',
          url: firstFrameDataUrl,
          mimeType: 'image/png',
          fileName: getVideoFrameFileName(attachment, FIRST_FRAME_SUFFIX)
        })
      }

      if (!hasLastFrameAttachment && lastFrameDataUrl) {
        nextAttachments.push({
          type: 'image',
          url: lastFrameDataUrl,
          mimeType: 'image/png',
          fileName: getVideoFrameFileName(attachment, LAST_FRAME_SUFFIX)
        })
      }

      if (!content.includes(buildVideoFrameNote(displayName, 'first frame')) && firstFrameDataUrl) {
        supplementalNotes.push(buildVideoFrameNote(displayName, 'first frame'))
      }

      if (!content.includes(buildVideoFrameNote(displayName, 'last frame')) && lastFrameDataUrl) {
        supplementalNotes.push(buildVideoFrameNote(displayName, 'last frame'))
      }
    } catch (error) {
      console.warn(
        '[ChatPage] Failed to extract video boundary frames:',
        attachment.fileName,
        error
      )
    }
  }

  if (supplementalNotes.length === 0) {
    return { attachments, content }
  }

  return {
    attachments: nextAttachments,
    content: [content.trim(), supplementalNotes.join('\n')].filter(Boolean).join('\n\n')
  }
}
