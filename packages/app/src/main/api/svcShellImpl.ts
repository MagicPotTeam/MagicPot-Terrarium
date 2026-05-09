import {
  DownloadFileReq,
  DownloadFileResp,
  EnsureDirectoryReq,
  EnsureDirectoryResp,
  InstallGitRepositoryReq,
  InstallGitRepositoryResp,
  ShellSvc
} from '@shared/api/svcShell'
import { spawn } from 'child_process'
import { shell } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

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
    return shell.openExternal(url)
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
  downloadFile = async (req: DownloadFileReq): Promise<DownloadFileResp> => {
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

    const tempPath = `${fullPath}.download-${process.pid}-${Date.now()}`
    try {
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        fs.createWriteStream(tempPath)
      )
      await fs.promises.rename(tempPath, fullPath)
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }

    return { fullPath, alreadyExists: false }
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
