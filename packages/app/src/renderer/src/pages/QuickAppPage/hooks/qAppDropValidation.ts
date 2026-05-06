const QUICK_APP_FILE_EXTENSION = '.mpqapp'
const QUICK_APP_DROP_BASE_MESSAGE =
  '当前快应用根区域只支持拖入带工作流的图片、从结果卡拖入的内部视频，或 .mpqapp 文件，不支持直接导入 '

export const QUICK_APP_IMPORT_PROMPT = '请拖放带工作流的图片、从结果卡拖入的视频或 .mpqapp 文件'
export const QUICK_APP_WORKFLOW_EXTRACT_ERROR = '无法从拖入内容中提取快应用工作流信息'

const getFileLabel = (fileName: string): string => {
  const trimmed = fileName.trim()
  const lastDot = trimmed.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return trimmed || 'unnamed file'
  }

  return trimmed.slice(lastDot).toLowerCase()
}

export const isQuickAppImportImageFile = (file: Pick<File, 'type'>): boolean =>
  file.type.startsWith('image/') && file.type !== 'image/svg+xml'

export const isQuickAppImportVideoFile = (file: Pick<File, 'type'>): boolean =>
  file.type.startsWith('video/')

export const isQuickAppBundleFile = (file: Pick<File, 'name'>): boolean =>
  file.name.toLowerCase().endsWith(QUICK_APP_FILE_EXTENSION)

export const getUnsupportedQuickAppDropMessage = (
  files: Array<Pick<File, 'name' | 'type'>>
): string | null => {
  if (files.length === 0) return null

  const unsupportedFiles = files.filter(
    (file) =>
      !isQuickAppBundleFile(file) &&
      !isQuickAppImportImageFile(file) &&
      !isQuickAppImportVideoFile(file)
  )

  if (unsupportedFiles.length === 0) {
    const droppedVideos = files.filter((file) => isQuickAppImportVideoFile(file))
    if (droppedVideos.length === 0) return null

    return '外部视频文件本身不包含可恢复的快应用工作流，请从快应用结果卡拖入视频，或改用带工作流的图片 / .mpqapp 文件。'
  }

  const unsupportedLabels = Array.from(
    new Set(unsupportedFiles.map((file) => getFileLabel(file.name)))
  )

  const droppedVideos = files.filter((file) => isQuickAppImportVideoFile(file))
  if (droppedVideos.length > 0) {
    return `${QUICK_APP_DROP_BASE_MESSAGE}${unsupportedLabels.join(', ')}。外部视频文件请从快应用结果卡拖入。`
  }

  return `${QUICK_APP_DROP_BASE_MESSAGE}${unsupportedLabels.join(', ')}。`
}
