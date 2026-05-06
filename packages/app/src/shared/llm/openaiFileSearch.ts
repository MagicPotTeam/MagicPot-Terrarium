import type { ChatAttachment, ChatMessage } from './types'

const FILE_SEARCH_READY_TIMEOUT_MS = 30_000
const FILE_SEARCH_POLL_INTERVAL_MS = 1_000

const FILE_SEARCH_SUPPORTED_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'csv',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'log',
  'md',
  'markdown',
  'pdf',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svg',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml'
])

const FILE_SEARCH_SUPPORTED_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/xml'
])

export type OpenAIFileSearchSession = {
  cleanup: () => Promise<void>
  vectorStoreIds: string[]
}

const sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(typeof signal?.reason === 'string' ? signal.reason : 'The request was aborted.')
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)

    const handleAbort = () => {
      clearTimeout(timeoutId)
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error(
              typeof signal?.reason === 'string' ? signal.reason : 'The request was aborted.'
            )
      )
    }

    signal?.addEventListener('abort', handleAbort, { once: true })
  })
}

const normalizeMimeType = (value?: string): string =>
  String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase()

const inferFileNameFromUrl = (value: string): string => {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('data:')) {
    return ''
  }

  try {
    const url = new URL(trimmed)
    return decodeURIComponent(url.pathname.split('/').pop() || '')
  } catch {
    return decodeURIComponent(trimmed.split(/[\\/]/).pop() || '')
  }
}

const inferAttachmentFileName = (attachment: ChatAttachment, index: number): string =>
  attachment.fileName?.trim() ||
  attachment.relativePath?.trim() ||
  inferFileNameFromUrl(attachment.url) ||
  `attachment-${index + 1}.txt`

const inferAttachmentExtension = (attachment: ChatAttachment, index: number): string => {
  const fileName = inferAttachmentFileName(attachment, index)
  const lastDot = fileName.lastIndexOf('.')
  return lastDot >= 0 && lastDot < fileName.length - 1
    ? fileName.slice(lastDot + 1).toLowerCase()
    : ''
}

export const isOpenAIFileSearchAttachment = (attachment: ChatAttachment, index = 0): boolean => {
  if (attachment.type !== 'file') {
    return false
  }

  const mimeType = normalizeMimeType(attachment.mimeType)
  if (mimeType.startsWith('text/') || FILE_SEARCH_SUPPORTED_MIME_TYPES.has(mimeType)) {
    return true
  }

  const extension = inferAttachmentExtension(attachment, index)
  return FILE_SEARCH_SUPPORTED_EXTENSIONS.has(extension)
}

const dataUrlToBlob = (value: string): Blob | null => {
  const match = value.match(/^data:([^;,]+)?;base64,(.+)$/i)
  if (!match) {
    return null
  }

  const mimeType = normalizeMimeType(match[1]) || 'application/octet-stream'
  const base64 = match[2]
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
  return new Blob([bytes], { type: mimeType })
}

const loadAttachmentBlob = async (
  attachment: ChatAttachment,
  index: number,
  signal?: AbortSignal
): Promise<{ blob: Blob; fileName: string }> => {
  const fileName = inferAttachmentFileName(attachment, index)
  const directBlob = dataUrlToBlob(attachment.url)
  if (directBlob) {
    return { blob: directBlob, fileName }
  }

  const response = await fetch(attachment.url, { signal })
  if (!response.ok) {
    throw new Error(
      `OpenAI file search could not download ${fileName}: ${response.status} ${response.statusText}`
    )
  }

  const blob = await response.blob()
  return {
    blob: blob.type
      ? blob
      : new Blob([await blob.arrayBuffer()], {
          type: normalizeMimeType(attachment.mimeType) || 'application/octet-stream'
        }),
    fileName
  }
}

const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey.trim()
    ? {
        Authorization: `Bearer ${apiKey}`
      }
    : {}

const jsonHeaders = (apiKey: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...authHeaders(apiKey)
})

const safeText = async (response: Response): Promise<string> => response.text().catch(() => '')

const uploadFile = async (
  apiKey: string,
  baseUrl: string,
  attachment: ChatAttachment,
  index: number,
  signal?: AbortSignal
): Promise<string> => {
  const { blob, fileName } = await loadAttachmentBlob(attachment, index, signal)
  const formData = new FormData()
  formData.append('purpose', 'assistants')
  formData.append('file', blob, fileName)

  const response = await fetch(`${baseUrl}/files`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: formData,
    signal
  })

  if (!response.ok) {
    throw new Error(
      `OpenAI file upload failed for ${fileName}: ${response.status} ${response.statusText} ${await safeText(
        response
      )}`
    )
  }

  const payload = (await response.json()) as { id?: string }
  if (!payload.id) {
    throw new Error(`OpenAI file upload returned no file id for ${fileName}.`)
  }

  return payload.id
}

const createVectorStore = async (
  apiKey: string,
  baseUrl: string,
  signal?: AbortSignal
): Promise<string> => {
  const response = await fetch(`${baseUrl}/vector_stores`, {
    method: 'POST',
    headers: jsonHeaders(apiKey),
    body: JSON.stringify({
      name: `magicpot-file-search-${Date.now()}`
    }),
    signal
  })

  if (!response.ok) {
    throw new Error(
      `OpenAI vector store creation failed: ${response.status} ${response.statusText} ${await safeText(
        response
      )}`
    )
  }

  const payload = (await response.json()) as { id?: string }
  if (!payload.id) {
    throw new Error('OpenAI vector store creation returned no id.')
  }

  return payload.id
}

const addFileToVectorStore = async (
  apiKey: string,
  baseUrl: string,
  vectorStoreId: string,
  fileId: string,
  signal?: AbortSignal
): Promise<void> => {
  const response = await fetch(
    `${baseUrl}/vector_stores/${encodeURIComponent(vectorStoreId)}/files`,
    {
      method: 'POST',
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({
        file_id: fileId
      }),
      signal
    }
  )

  if (!response.ok) {
    throw new Error(
      `OpenAI vector store file attach failed: ${response.status} ${response.statusText} ${await safeText(
        response
      )}`
    )
  }
}

const waitForVectorStoreFiles = async (
  apiKey: string,
  baseUrl: string,
  vectorStoreId: string,
  fileIds: string[],
  signal?: AbortSignal
): Promise<void> => {
  const deadline = Date.now() + FILE_SEARCH_READY_TIMEOUT_MS

  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl}/vector_stores/${encodeURIComponent(vectorStoreId)}/files`,
      {
        method: 'GET',
        headers: authHeaders(apiKey),
        signal
      }
    )

    if (!response.ok) {
      throw new Error(
        `OpenAI vector store polling failed: ${response.status} ${response.statusText} ${await safeText(
          response
        )}`
      )
    }

    const payload = (await response.json()) as {
      data?: Array<{
        file_id?: string
        last_error?: { message?: string }
        status?: string
      }>
    }
    const records = Array.isArray(payload.data) ? payload.data : []
    const relevantRecords = records.filter(
      (record) => record.file_id && fileIds.includes(record.file_id)
    )

    if (relevantRecords.length === fileIds.length) {
      const failedRecord = relevantRecords.find((record) =>
        ['cancelled', 'expired', 'failed'].includes(String(record.status || '').toLowerCase())
      )
      if (failedRecord) {
        throw new Error(
          failedRecord.last_error?.message ||
            `OpenAI file search indexing failed with status "${failedRecord.status || 'unknown'}".`
        )
      }

      if (
        relevantRecords.every(
          (record) =>
            String(record.status || '')
              .trim()
              .toLowerCase() === 'completed'
        )
      ) {
        return
      }
    }

    await sleep(FILE_SEARCH_POLL_INTERVAL_MS, signal)
  }

  throw new Error('OpenAI file search indexing timed out before the files became ready.')
}

const safeDelete = async (apiKey: string, url: string): Promise<void> => {
  try {
    await fetch(url, {
      method: 'DELETE',
      headers: authHeaders(apiKey)
    })
  } catch {
    // Best-effort cleanup only.
  }
}

export function collectOpenAIFileSearchAttachments(messages: ChatMessage[]): ChatAttachment[] {
  const attachments: ChatAttachment[] = []
  const seen = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }

    for (const attachment of message.attachments || []) {
      const nextIndex = attachments.length
      if (!isOpenAIFileSearchAttachment(attachment, nextIndex)) {
        continue
      }

      const key = `${attachment.type}:${attachment.fileName || attachment.relativePath || ''}:${attachment.url}`
      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      attachments.push(attachment)
    }
  }

  return attachments
}

export function buildOpenAIFileSearchTool(vectorStoreIds: string[]): Record<string, unknown> {
  return {
    type: 'file_search',
    vector_store_ids: vectorStoreIds
  }
}

export async function createOpenAIFileSearchSession(options: {
  apiKey: string
  baseUrl: string
  messages: ChatMessage[]
  signal?: AbortSignal
}): Promise<OpenAIFileSearchSession | null> {
  const attachments = collectOpenAIFileSearchAttachments(options.messages)
  if (!attachments.length) {
    return null
  }

  const fileIds: string[] = []
  let vectorStoreId = ''

  try {
    for (const [index, attachment] of attachments.entries()) {
      fileIds.push(
        await uploadFile(options.apiKey, options.baseUrl, attachment, index, options.signal)
      )
    }

    vectorStoreId = await createVectorStore(options.apiKey, options.baseUrl, options.signal)
    for (const fileId of fileIds) {
      await addFileToVectorStore(
        options.apiKey,
        options.baseUrl,
        vectorStoreId,
        fileId,
        options.signal
      )
    }

    await waitForVectorStoreFiles(
      options.apiKey,
      options.baseUrl,
      vectorStoreId,
      fileIds,
      options.signal
    )

    return {
      vectorStoreIds: [vectorStoreId],
      cleanup: async () => {
        if (vectorStoreId) {
          await safeDelete(
            options.apiKey,
            `${options.baseUrl}/vector_stores/${encodeURIComponent(vectorStoreId)}`
          )
        }

        await Promise.allSettled(
          fileIds.map((fileId) =>
            safeDelete(options.apiKey, `${options.baseUrl}/files/${encodeURIComponent(fileId)}`)
          )
        )
      }
    }
  } catch (error) {
    if (vectorStoreId) {
      await safeDelete(
        options.apiKey,
        `${options.baseUrl}/vector_stores/${encodeURIComponent(vectorStoreId)}`
      )
    }

    await Promise.allSettled(
      fileIds.map((fileId) =>
        safeDelete(options.apiKey, `${options.baseUrl}/files/${encodeURIComponent(fileId)}`)
      )
    )

    throw error
  }
}
