export function downloadFile(url: string, fileName: string = '') {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
}

export async function selectFile(extensions: string[] = []) {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.style.display = 'none'

    if (extensions.length > 0) {
      const accept = extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)).join(',')
      input.accept = accept
    }

    const handleFileSelect = (event) => {
      const file = event.target.files[0]
      resolve(file || null)
      cleanup()
    }

    const handleCancel = () => {
      setTimeout(() => {
        resolve(null)
        cleanup()
      }, 100)
    }

    const cleanup = () => {
      input.removeEventListener('change', handleFileSelect)
      input.removeEventListener('cancel', handleCancel)
      document.body.removeChild(input)
    }

    input.addEventListener('change', handleFileSelect)
    input.addEventListener('cancel', handleCancel)

    document.body.appendChild(input)
    input.click()
  })
}

export function bytesToObjectUrl(bytes: Uint8Array, type: string = 'image/png') {
  return URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader()
    fileReader.onload = async (event) => {
      resolve(event.target?.result as string)
    }
    fileReader.onerror = async (event) => {
      reject(event.target?.error)
    }
    fileReader.readAsDataURL(file)
  })
}

export function fileToBlobUrl(file: File): string {
  return URL.createObjectURL(file)
}

export function checkFileSize(file: File, maxSizeMB: number = 100): boolean {
  const maxSizeBytes = maxSizeMB * 1024 * 1024
  return file.size <= maxSizeBytes
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const decodePngTextMetadata = (bytes: Uint8Array): Map<string, string> | null => {
  const metadata = new Map<string, string>()
  let offset = PNG_SIGNATURE.length

  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return null
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const nextOffset = dataEnd + 4
    if (dataEnd < dataStart || nextOffset > bytes.length) return null

    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    )
    const chunkData = bytes.subarray(dataStart, dataEnd)
    if (chunkType === 'tEXt') {
      const separator = chunkData.indexOf(0)
      if (separator >= 0) {
        const keyword = new TextDecoder('latin1').decode(chunkData.subarray(0, separator))
        const value = new TextDecoder('latin1').decode(chunkData.subarray(separator + 1))
        if (keyword === 'workflow' || keyword === 'prompt' || keyword === 'comfy') {
          metadata.set(keyword, value)
        }
      }
    } else if (chunkType === 'iTXt') {
      const keywordEnd = chunkData.indexOf(0)
      if (keywordEnd >= 0) {
        let cursor = keywordEnd + 1
        const compressionFlag = chunkData[cursor++]
        const compressionMethod = chunkData[cursor++]
        const languageEnd = chunkData.indexOf(0, cursor)
        if (languageEnd < 0) return null
        cursor = languageEnd + 1
        const translatedKeywordEnd = chunkData.indexOf(0, cursor)
        if (translatedKeywordEnd < 0) return null
        cursor = translatedKeywordEnd + 1
        if (compressionFlag === 0 && compressionMethod === 0) {
          const keyword = new TextDecoder().decode(chunkData.subarray(0, keywordEnd))
          const value = new TextDecoder().decode(chunkData.subarray(cursor))
          if (keyword === 'workflow' || keyword === 'prompt' || keyword === 'comfy') {
            metadata.set(keyword, value)
          }
        }
      }
    }

    if (chunkType === 'IEND') return metadata
    offset = nextOffset
  }

  return null
}

export async function extractWorkflowFromPNG(file: File): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const arrayBuffer = event.target?.result as ArrayBuffer
        if (!arrayBuffer) {
          resolve(null)
          return
        }

        const bytes = new Uint8Array(arrayBuffer)

        if (
          bytes.length < 8 ||
          bytes[0] !== 0x89 ||
          bytes[1] !== 0x50 ||
          bytes[2] !== 0x4e ||
          bytes[3] !== 0x47 ||
          bytes[4] !== 0x0d ||
          bytes[5] !== 0x0a ||
          bytes[6] !== 0x1a ||
          bytes[7] !== 0x0a
        ) {
          resolve(null)
          return
        }

        const workflowChunks = decodePngTextMetadata(bytes)
        if (!workflowChunks) {
          resolve(null)
          return
        }

        for (const key of ['prompt', 'workflow', 'comfy']) {
          const value = workflowChunks.get(key)
          if (!value) continue

          try {
            JSON.parse(value)
            resolve(value)
            return
          } catch {
            resolve(value)
            return
          }
        }

        resolve(null)
      } catch (error) {
        reject(error)
      }
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsArrayBuffer(file)
  })
}

export async function extractWorkflowFromImage(
  imageSource: string | File,
  promptId?: string
): Promise<{ workflow: Record<string, unknown>; source: 'metadata' | 'history' } | null> {
  if (imageSource instanceof File) {
    const workflowStr = await extractWorkflowFromPNG(imageSource)
    if (workflowStr) {
      try {
        const workflow = JSON.parse(workflowStr)
        return { workflow, source: 'metadata' }
      } catch {
        void 0
      }
    }
  }

  if (promptId) {
    try {
      const { api } = await import('@renderer/utils/windowUtils')
      const history = await api().svcComfy.getHistory({ prompt_id: promptId })
      if (history[promptId]?.prompt?.[2]) {
        return { workflow: history[promptId].prompt[2], source: 'history' }
      }
    } catch (error) {
      console.error('从历史记录获取工作流失败:', error)
    }
  }

  if (typeof imageSource === 'string' && imageSource.startsWith('blob:')) {
    try {
      const response = await fetch(imageSource)
      const blob = await response.blob()
      const file = new File([blob], 'image.png', { type: 'image/png' })
      const workflowStr = await extractWorkflowFromPNG(file)
      if (workflowStr) {
        try {
          const workflow = JSON.parse(workflowStr)
          return { workflow, source: 'metadata' }
        } catch {
          void 0
        }
      }
    } catch (error) {
      console.error('从 blob URL 提取工作流失败:', error)
    }
  }

  return null
}
