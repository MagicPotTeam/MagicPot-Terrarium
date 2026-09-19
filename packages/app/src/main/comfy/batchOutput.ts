import type { FileItem } from '@shared/comfy/types'
import { describePngFailure, inspectPng } from './batchPng'

export const COMFY_BATCH_PNG_DOWNLOAD_ATTEMPTS = 3

export type BatchOutputDownloadContext = {
  profileId: string
  promptId: string
  file: FileItem
}

export class ComfyBatchPngDownloadError extends Error {
  readonly retryable = false

  constructor(
    message: string,
    readonly attempts: number,
    readonly context: BatchOutputDownloadContext,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'ComfyBatchPngDownloadError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRetryableDownloadError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'retryable' in error &&
    (error as { retryable?: unknown }).retryable === true
  )
}

function outputFileContext(context: BatchOutputDownloadContext): string {
  const file = context.file
  const filename = file.subfolder ? `${file.subfolder}/${file.filename || ''}` : file.filename || ''
  return `profile=${context.profileId} promptId=${context.promptId} file=${filename} type=${file.type || 'unknown'}`
}

function validationError(bytes: Uint8Array): Error {
  const inspection = inspectPng(bytes)
  return new Error(
    `type=image/png byteLength=${bytes.byteLength} reason=${describePngFailure(inspection.failure)}`
  )
}

/**
 * Re-downloads only the output belonging to an already completed prompt. It
 * never resubmits the workflow. Transport and truncated/CRC responses get a
 * small bounded retry; a real non-PNG response stops immediately.
 */
export async function downloadCompletedBatchPng(
  download: () => Promise<Uint8Array>,
  context: BatchOutputDownloadContext,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<Uint8Array> {
  const attempts = Math.max(
    1,
    Math.min(
      COMFY_BATCH_PNG_DOWNLOAD_ATTEMPTS,
      options.attempts ?? COMFY_BATCH_PNG_DOWNLOAD_ATTEMPTS
    )
  )
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const bytes = await download()
      const inspection = inspectPng(bytes)
      if (inspection.valid) return bytes
      lastError = validationError(bytes)
      if (inspection.failure === 'non-png' || inspection.failure === 'invalid-structure') break
    } catch (error) {
      lastError = error
      if (!isRetryableDownloadError(error)) break
    }

    if (attempt < attempts && (options.delayMs ?? 25) > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 25))
    }
  }

  const detail = errorMessage(lastError || 'unknown PNG download failure')
  throw new ComfyBatchPngDownloadError(
    `ComfyUI output PNG download failed after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${outputFileContext(context)} ${detail}`,
    attempts,
    context,
    lastError
  )
}
