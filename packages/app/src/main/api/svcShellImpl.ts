import {
  DownloadFileReq,
  DownloadFileProgressEvent,
  DownloadFileResp,
  EnsureDirectoryReq,
  EnsureDirectoryResp,
  InstallGitRepositoryReq,
  InstallGitRepositoryResp,
  ShellSvc
} from '@shared/api/svcShell'
import { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { spawn } from 'child_process'
import { net, shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { normalizeAllowedExternalUrl } from '../utils/externalUrl'
import { assertRemoteFetchHostnameIsNotExplicitlyLocal } from './remoteFetchPolicy'

function isLocallyAvailable(filePath: string): boolean {
  try {
    fs.statSync(filePath)
    return true
  } catch {
    return false
  }
}

function sanitizePathSegment(value: string): string {
  return Array.from(value.trim(), (char) =>
    char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '-' : char
  )
    .join('')
    .replace(/\.+$/g, '')
    .replace(/^\.+$/g, '')
    .slice(0, 160)
}

export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024 * 1024
const DOWNLOAD_TOTAL_TIMEOUT_MS = 24 * 60 * 60 * 1000
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const MAX_DOWNLOAD_REDIRECTS = 5
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])

function requireHttpsUrl(value: string): URL {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:') {
    throw new Error('Download URL must use https.')
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('Download URL must not include credentials or a fragment.')
  }
  return parsed
}

function requireGitUrl(value: string): string {
  const parsed = new URL(value)
  // Git's HTTP transport may be required by explicitly configured local mirrors.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`)
  }
  return parsed.href
}

function trimErrorOutput(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 1000) {
    return trimmed
  }
  return `${trimmed.slice(0, 1000)}...`
}

function getContentLength(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Download failed: invalid Content-Length header.')
  }
  return parsed
}

export function createDownloadByteLimitTransform(
  maxBytes: number,
  onChunk: (receivedBytes: number) => void
): Transform {
  let receivedBytes = 0
  return new Transform({
    transform(
      chunk: Buffer,
      _encoding: BufferEncoding,
      callback: (error?: Error | null, data?: Buffer) => void
    ) {
      receivedBytes += chunk.length
      if (receivedBytes > maxBytes) {
        callback(new Error('Download failed: response is too large.'))
        return
      }
      onChunk(receivedBytes)
      callback(null, chunk)
    }
  })
}

type DownloadResponse = {
  response: Response
  finalUrl: URL
}

async function requestDownload(
  initialUrl: URL,
  signal: AbortSignal,
  redirects = 0
): Promise<DownloadResponse> {
  assertRemoteFetchHostnameIsNotExplicitlyLocal(initialUrl.hostname)
  if (signal.aborted) throw signal.reason

  const idleTimeout = new AbortController()
  const abortForCaller = () => idleTimeout.abort(signal.reason)
  signal.addEventListener('abort', abortForCaller, { once: true })
  const idleTimer = setTimeout(
    () => idleTimeout.abort(new Error('Download failed: request was idle for too long.')),
    DOWNLOAD_IDLE_TIMEOUT_MS
  )

  let response: Response
  try {
    response = await net.fetch(initialUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: idleTimeout.signal
    })
  } finally {
    clearTimeout(idleTimer)
    signal.removeEventListener('abort', abortForCaller)
  }

  const status = response.status
  if (REDIRECT_STATUS_CODES.has(status)) {
    await response.body?.cancel().catch(() => undefined)
    const location = response.headers.get('location')
    if (!location) {
      throw new Error('Download failed: redirect has no location.')
    }
    if (redirects >= MAX_DOWNLOAD_REDIRECTS) {
      throw new Error('Download failed: too many redirects.')
    }
    const redirectUrl = requireHttpsUrl(new URL(location, initialUrl).toString())
    return requestDownload(redirectUrl, signal, redirects + 1)
  }
  if (status < 200 || status >= 300) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`Download failed: ${status} ${response.statusText || ''}`.trim())
  }
  if (!response.body) {
    throw new Error('Download failed: response body is empty.')
  }
  return { response, finalUrl: initialUrl }
}

function runGitClone(url: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth=1', url, targetDir], {
      windowsHide: true
    })
    let stderr = ''

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error) => {
      reject(new Error(`Failed to start git clone: ${error.message}`))
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`git clone failed${stderr ? `: ${trimErrorOutput(stderr)}` : ''}`))
    })
  })
}

export class ShellSvcImpl implements ShellSvc {
  openPath = async (targetPath: string): Promise<string> => {
    return shell.openPath(targetPath)
  }
  showItemInFolder = async (targetPath: string): Promise<void> => {
    return shell.showItemInFolder(targetPath)
  }
  openExternal = async (url: string): Promise<void> => {
    return shell.openExternal(normalizeAllowedExternalUrl(url))
  }
  getHomeDir = async (): Promise<string> => {
    return os.homedir()
  }
  fileExists = async (filePath: string): Promise<boolean> => {
    return isLocallyAvailable(filePath)
  }
  fileExistsBatch = async (paths: string[]): Promise<boolean[]> => {
    return paths.map((p) => isLocallyAvailable(p))
  }
  ensureDirectory = async (req: EnsureDirectoryReq): Promise<EnsureDirectoryResp> => {
    const resolvedPath = path.resolve(req.path)
    await fs.promises.mkdir(resolvedPath, { recursive: true })
    return { path: resolvedPath }
  }
  private downloadFileInternal = async (
    req: DownloadFileReq,
    onProgress?: (event: Extract<DownloadFileProgressEvent, { type: 'progress' }>) => void
  ): Promise<DownloadFileResp> => {
    const url = requireHttpsUrl(req.url)
    const filename = sanitizePathSegment(req.filename)
    if (!filename) {
      throw new Error('Download filename is required')
    }

    const outputDir = path.resolve(req.outputDir)
    await fs.promises.mkdir(outputDir, { recursive: true })

    const fullPath = path.join(outputDir, filename)
    if (isLocallyAvailable(fullPath)) {
      return { fullPath, alreadyExists: true }
    }

    const timeout = new AbortController()
    const totalTimeout = setTimeout(
      () => timeout.abort(new Error('Download failed: total timeout exceeded.')),
      DOWNLOAD_TOTAL_TIMEOUT_MS
    )
    const { response } = await requestDownload(url, timeout.signal).catch((error) => {
      clearTimeout(totalTimeout)
      throw error
    })
    let totalBytes: number | undefined
    try {
      totalBytes = getContentLength(response.headers.get('content-length') ?? undefined)
      if (totalBytes != null && totalBytes > MAX_DOWNLOAD_BYTES) {
        throw new Error('Download failed: response is too large.')
      }
    } catch (error) {
      await response.body?.cancel().catch(() => undefined)
      clearTimeout(totalTimeout)
      throw error
    }
    let downloadedBytes = 0
    const startTime = Date.now()
    let lastProgressAt = 0
    let canEmitProgress = Boolean(onProgress)
    const emitProgress = (force = false) => {
      if (!onProgress || !canEmitProgress) {
        return
      }

      const now = Date.now()
      if (!force && now - lastProgressAt < 250) {
        return
      }

      lastProgressAt = now
      const elapsedSeconds = Math.max((now - startTime) / 1000, 0.001)
      const event: Extract<DownloadFileProgressEvent, { type: 'progress' }> = {
        type: 'progress',
        downloadedBytes,
        ...(totalBytes ? { totalBytes } : {}),
        ...(totalBytes
          ? { percent: Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) }
          : {}),
        bytesPerSecond: Math.round(downloadedBytes / elapsedSeconds)
      }
      try {
        onProgress(event)
      } catch (error) {
        canEmitProgress = false
        console.warn('[ShellSvc] Download progress listener is unavailable:', error)
      }
    }

    const tempPath = `${fullPath}.download-${process.pid}-${Date.now()}`
    let bodyIdleTimer: ReturnType<typeof setTimeout> | undefined
    const byteLimitTransform = createDownloadByteLimitTransform(
      MAX_DOWNLOAD_BYTES,
      (receivedBytes) => {
        downloadedBytes = receivedBytes
        emitProgress()
        if (bodyIdleTimer) clearTimeout(bodyIdleTimer)
        bodyIdleTimer = setTimeout(
          () =>
            byteLimitTransform.destroy(
              new Error('Download failed: request was idle for too long.')
            ),
          DOWNLOAD_IDLE_TIMEOUT_MS
        )
      }
    )
    try {
      emitProgress(true)
      bodyIdleTimer = setTimeout(
        () =>
          byteLimitTransform.destroy(new Error('Download failed: request was idle for too long.')),
        DOWNLOAD_IDLE_TIMEOUT_MS
      )
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        byteLimitTransform,
        fs.createWriteStream(tempPath)
      )
      if (totalBytes != null && downloadedBytes !== totalBytes) {
        throw new Error('Download failed: response size did not match Content-Length.')
      }
      emitProgress(true)
      await fs.promises.rename(tempPath, fullPath)
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    } finally {
      if (bodyIdleTimer) clearTimeout(bodyIdleTimer)
      clearTimeout(totalTimeout)
    }

    return { fullPath, alreadyExists: false }
  }
  downloadFile = async (req: DownloadFileReq): Promise<DownloadFileResp> => {
    return this.downloadFileInternal(req)
  }
  downloadFileWithProgress = async (
    req: DownloadFileReq,
    resp: ServerStreaming<DownloadFileProgressEvent>
  ): Promise<void> => {
    const result = await this.downloadFileInternal(req, (event) => resp.onData(event))
    try {
      resp.onData({ type: 'complete', result })
    } catch (error) {
      console.warn('[ShellSvc] Download completion listener is unavailable:', error)
    }
  }
  installGitRepository = async (
    req: InstallGitRepositoryReq
  ): Promise<InstallGitRepositoryResp> => {
    const url = requireGitUrl(req.url)
    const directoryName = sanitizePathSegment(req.directoryName)
    if (!directoryName) {
      throw new Error('Repository directory name is required')
    }

    const outputDir = path.resolve(req.outputDir)
    const targetDir = path.join(outputDir, directoryName)
    await fs.promises.mkdir(outputDir, { recursive: true })

    if (fs.existsSync(targetDir)) {
      const entries = await fs.promises.readdir(targetDir).catch(() => [])
      if (entries.length > 0) {
        return { targetDir, alreadyExists: true }
      }
    }

    await runGitClone(url, targetDir)
    return { targetDir, alreadyExists: false }
  }
}
