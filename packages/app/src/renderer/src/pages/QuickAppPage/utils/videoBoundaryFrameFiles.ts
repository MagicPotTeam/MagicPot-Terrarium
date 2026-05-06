import { extractVideoBoundaryFrameDataUrls } from '../../ChatPage/chatVideoAttachmentUtils'

type VideoFrameExtractor = typeof extractVideoBoundaryFrameDataUrls
type VideoFrameKind = 'first' | 'last'

const frameDataUrlToFile = async (dataUrl: string, fileName: string): Promise<File> => {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return new File([blob], fileName, {
    type: blob.type || 'image/png'
  })
}

export const getVideoBoundaryFrameFileName = (
  sourceFileName: string,
  kind: VideoFrameKind
): string => {
  const lastDotIndex = sourceFileName.lastIndexOf('.')
  const baseName = lastDotIndex > 0 ? sourceFileName.slice(0, lastDotIndex) : sourceFileName
  const suffix = kind === 'first' ? 'first-frame' : 'last-frame'
  return `${baseName}-${suffix}.png`
}

export const createVideoBoundaryFrameFiles = async (
  videoFile: File,
  extractFrames: VideoFrameExtractor = extractVideoBoundaryFrameDataUrls
): Promise<{
  firstFrameFile?: File
  lastFrameFile?: File
}> => {
  const videoUrl = URL.createObjectURL(videoFile)

  try {
    const { firstFrameDataUrl, lastFrameDataUrl } = await extractFrames(videoUrl)
    const [firstFrameFile, lastFrameFile] = await Promise.all([
      firstFrameDataUrl
        ? frameDataUrlToFile(
            firstFrameDataUrl,
            getVideoBoundaryFrameFileName(videoFile.name || 'video', 'first')
          )
        : undefined,
      lastFrameDataUrl
        ? frameDataUrlToFile(
            lastFrameDataUrl,
            getVideoBoundaryFrameFileName(videoFile.name || 'video', 'last')
          )
        : undefined
    ])

    return {
      firstFrameFile,
      lastFrameFile
    }
  } finally {
    URL.revokeObjectURL(videoUrl)
  }
}
