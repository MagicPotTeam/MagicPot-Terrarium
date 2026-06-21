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
import { shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { normalizeAllowedExternalUrl } from '../utils/externalUrl'

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

function requireHttpUrl(value: string): string {
  const parsed = new URL(value)
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

function getContentLength(headers: Headers): number | undefined {
  const value = headers.get('content-length')
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
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
    const url = requireHttpUrl(req.url)
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

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`.trim())
    }
    if (!response.body) {
      throw new Error('Download failed: empty response body')
    }

    const totalBytes = getContentLength(response.headers)
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
    try {
      emitProgress(true)
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        new Transform({
          transform(
            chunk: Buffer,
            _encoding: BufferEncoding,
            callback: (error?: Error | null, data?: Buffer) => void
          ) {
            downloadedBytes += chunk.length
            emitProgress()
            callback(null, chunk)
          }
        }),
        fs.createWriteStream(tempPath)
      )
      emitProgress(true)
      await fs.promises.rename(tempPath, fullPath)
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
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
    const url = requireHttpUrl(req.url)
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
