let lastFileTimestamp = ''
let fileTimestampSequence = 0

export const createAutoSaveFileName = (extension: string): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  if (timestamp === lastFileTimestamp) {
    fileTimestampSequence += 1
  } else {
    lastFileTimestamp = timestamp
    fileTimestampSequence = 0
  }

  const normalizedExtension = extension.startsWith('.') ? extension : `.${extension}`
  return `qapp_auto_${timestamp}_${fileTimestampSequence}${normalizedExtension}`
}
