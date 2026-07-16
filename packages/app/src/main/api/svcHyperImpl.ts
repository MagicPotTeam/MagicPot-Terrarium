import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'node:crypto'
import nodeOs from 'node:os'
import { dialog } from 'electron'
import { sleep } from '@shared/utils/utilFuncs'
import { ConfigUtils } from '@shared/config/configUtils'
import { connectSubProcess, killSubProcess, spawnSubProcess } from '../subprocess/subprocess'
import { ComfyFSCli } from '../comfy/fs'
import { ServerStreaming } from '@shared/api/apiUtils/streaming'
import { getBuildEnv } from '../config/buildEnv'
import { getConfig } from '../config/config'
import { createPortablePythonEnv } from '../config/portablePaths'
import { ensureVcRedistInstalled } from '../system/vcRedist'
import {
  HyperSvc,
  StartComfyUIReq,
  StartComfyUIResp,
  ComfyPortDetectReq,
  ComfyPortDetectResp,
  ListComfyFilesReq,
  ListComfyFilesResp,
  StartProcessReq,
  StartProcessResp,
  KillSubProcessReq,
  KillSubProcessResp,
  ConnectSubProcessReq,
  ConnectSubProcessResp,
  RunCommandSyncReq,
  RunCommandSyncResp,
  GetGPUInfoReq,
  GetGPUInfoResp,
  EnvironmentDetectReq,
  EnvironmentDetectResp,
  GetFastSettingValueReq,
  GetFastSettingValueResp,
  ListFastSettingTemplatesReq,
  ListFastSettingTemplatesResp,
  MigrateLegacyAssistantImageReq,
  MigrateLegacyAssistantImageResp,
  GetExtraModelPathsReq,
  GetExtraModelPathsResp,
  ReadClipboardHtmlReq,
  ReadClipboardHtmlResp,
  ReadClipboardImageReq,
  ReadClipboardImageResp,
  ReadClipboardTextReq,
  ReadClipboardTextResp,
  WriteImageToClipboardReq,
  WriteImageToClipboardResp,
  WriteSvgToClipboardReq,
  WriteSvgToClipboardResp
} from '@shared/api/svcHyper'
import { getFastSettingValue, listFastSettingTemplates } from '../config/fastSettingTemplates'

const MANAGER_DEFAULT_CHANNEL_ALIAS = 'default'
const MANAGER_DEFAULT_CHANNELS = [
  'default::https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main',
  'recent::https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/node_db/new',
  'legacy::https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/node_db/legacy',
  'forked::https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/node_db/forked',
  'dev::https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/node_db/dev',
  'tutorial::https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/node_db/tutorial'
].join('\n')
const LEGACY_MANAGER_CHANNEL_URLS = new Set([
  'https://cdn.jsdelivr.net/gh/ltdrdata/ComfyUI-Manager@main',
  'https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main'
])
const COMFY_HTTP_CHECK_TIMEOUT_MS = 2500
const COMFY_HTTP_EXISTING_PROCESS_ATTEMPTS = 10
const COMFY_HTTP_EXISTING_PROCESS_INTERVAL_MS = 500
const WINDOWS_RESERVED_FILE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
])
const INVALID_FILENAME_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])
const MAX_SAFE_DOWNLOAD_FILENAME_LENGTH = 240

const replaceUnsafeFilenameChars = (value: string): string =>
  Array.from(value, (char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || INVALID_FILENAME_CHARS.has(char) ? '_' : char
  }).join('')

export const sanitizeSaveImageFileName = (fileName: string): string => {
  const rawFileName = String(fileName || '').trim()
  if (!rawFileName) {
    throw new Error('Invalid file name: empty')
  }

  if (
    path.isAbsolute(rawFileName) ||
    path.win32.isAbsolute(rawFileName) ||
    rawFileName.includes('/') ||
    rawFileName.includes('\\') ||
    rawFileName.split(/[\\/]+/).some((segment) => segment === '..')
  ) {
    throw new Error('Invalid file name: path separators and traversal are not allowed')
  }

  const baseName = path.basename(path.win32.basename(path.posix.basename(rawFileName))).trim()
  const sanitized = replaceUnsafeFilenameChars(baseName)
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, MAX_SAFE_DOWNLOAD_FILENAME_LENGTH)

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new Error('Invalid file name: empty after sanitization')
  }

  const reservedStem = sanitized.split('.')[0]?.toLocaleLowerCase() || sanitized.toLocaleLowerCase()
  if (WINDOWS_RESERVED_FILE_NAMES.has(reservedStem)) {
    throw new Error(`Invalid file name: reserved name ${reservedStem}`)
  }

  return sanitized
}

const LEGACY_ASSISTANT_IMAGE_FILE_NAME_PATTERN =
  /^agent_auto_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:_\d+)?\.png$/
const LEGACY_ASSISTANT_IMAGE_MAX_BYTES = 64 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

type LegacyAssistantImageMigrationOptions = {
  fileName: string
  legacyRoot: string
  userDataRoot: string
}

const assertDirectoryWithoutSymlink = async (
  directoryPath: string,
  label: string
): Promise<void> => {
  const stats = await fs.lstat(directoryPath)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`)
  }
}

const isContainedRelativePath = (relativePath: string): boolean =>
  Boolean(relativePath) &&
  relativePath !== '..' &&
  !relativePath.startsWith(`..${path.sep}`) &&
  !path.isAbsolute(relativePath)

export const migrateLegacyAssistantImageFile = async (
  options: LegacyAssistantImageMigrationOptions
): Promise<MigrateLegacyAssistantImageResp> => {
  const fileName = String(options.fileName || '').trim()
  if (!LEGACY_ASSISTANT_IMAGE_FILE_NAME_PATTERN.test(fileName)) {
    throw new Error('Invalid legacy assistant image file name.')
  }
  if (!options.legacyRoot || !options.userDataRoot) {
    throw new Error('Legacy assistant image migration roots are unavailable.')
  }

  const legacyRoot = path.resolve(options.legacyRoot)
  const userDataRoot = path.resolve(options.userDataRoot)
  await assertDirectoryWithoutSymlink(legacyRoot, 'Legacy assistant image root')
  await assertDirectoryWithoutSymlink(userDataRoot, 'User data root')

  const canonicalLegacyRoot = await fs.realpath(legacyRoot)
  const sourcePath = path.join(legacyRoot, fileName)
  const sourceStats = await fs.lstat(sourcePath)
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error('Legacy assistant image source must be a regular file.')
  }
  if (sourceStats.size <= 0 || sourceStats.size > LEGACY_ASSISTANT_IMAGE_MAX_BYTES) {
    throw new Error('Legacy assistant image size is outside the allowed range.')
  }

  const canonicalSourcePath = await fs.realpath(sourcePath)
  const sourceRelativePath = path.relative(canonicalLegacyRoot, canonicalSourcePath)
  if (!isContainedRelativePath(sourceRelativePath) || path.dirname(sourceRelativePath) !== '.') {
    throw new Error('Legacy assistant image source escapes the historical export directory.')
  }

  const data = await fs.readFile(canonicalSourcePath)
  if (
    data.length !== sourceStats.size ||
    !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error('Legacy assistant image is not a valid PNG payload.')
  }

  const canonicalUserDataRoot = await fs.realpath(userDataRoot)
  let canonicalTargetRoot = canonicalUserDataRoot
  for (const segment of ['.chat_media', 'assistant-images', 'legacy']) {
    const nextTargetRoot = path.join(canonicalTargetRoot, segment)
    try {
      await fs.mkdir(nextTargetRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
    await assertDirectoryWithoutSymlink(nextTargetRoot, 'Legacy assistant image target')
    canonicalTargetRoot = await fs.realpath(nextTargetRoot)
    const targetRelativePath = path.relative(canonicalUserDataRoot, canonicalTargetRoot)
    if (!isContainedRelativePath(targetRelativePath)) {
      throw new Error('Legacy assistant image target escapes the user data directory.')
    }
  }

  const digest = createHash('sha256').update(data).digest('hex')
  const savedPath = path.join(canonicalTargetRoot, `legacy-${digest}.png`)
  const temporaryPath = path.join(canonicalTargetRoot, `.${digest}-${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporaryPath, data, { flag: 'wx' })
    await fs.link(temporaryPath, savedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error

    const existingStats = await fs.lstat(savedPath)
    if (!existingStats.isFile() || existingStats.isSymbolicLink()) {
      throw new Error('Legacy assistant image destination is not a regular file.')
    }
    const existingData = await fs.readFile(savedPath)
    if (!existingData.equals(data)) {
      throw new Error('Legacy assistant image destination failed integrity verification.')
    }
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  }

  return { savedPath }
}

const checkLocalComfyHttp = async (port: string): Promise<boolean> => {
  const normalizedPort = port.trim()
  if (!normalizedPort) {
    return false
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMFY_HTTP_CHECK_TIMEOUT_MS)

  try {
    const response = await fetch(`http://127.0.0.1:${normalizedPort}/system_stats`, {
      signal: controller.signal
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

const waitForLocalComfyHttp = async (port: string, attempts: number): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await checkLocalComfyHttp(port)) {
      return true
    }
    if (attempt < attempts - 1) {
      await sleep(COMFY_HTTP_EXISTING_PROCESS_INTERVAL_MS)
    }
  }
  return false
}

const parseIniSection = (content: string): Record<string, string> => {
  const parsed: Record<string, string> = {}
  let inDefaultSection = false

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      inDefaultSection = line.toLowerCase() === '[default]'
      continue
    }
    if (!inDefaultSection) {
      continue
    }
    const separatorIndex = rawLine.indexOf('=')
    if (separatorIndex < 0) {
      continue
    }
    const key = rawLine.slice(0, separatorIndex).trim()
    const value = rawLine.slice(separatorIndex + 1).trim()
    if (key) {
      parsed[key] = value
    }
  }

  return parsed
}

const serializeIniSection = (section: Record<string, string>): string => {
  const keys = Object.keys(section)
  return `[default]\n${keys.map((key) => `${key} = ${section[key] ?? ''}`).join('\n')}\n`
}

async function ensureComfyManagerBootstrapConfig(comfyUIDir: string): Promise<void> {
  const managerDir = path.join(comfyUIDir, 'user', '__manager')
  const configPath = path.join(managerDir, 'config.ini')
  const channelsPath = path.join(managerDir, 'channels.list')

  await fs.mkdir(managerDir, { recursive: true })

  try {
    const currentChannels = await fs.readFile(channelsPath, 'utf8')
    if (
      !currentChannels.includes(
        'default::https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main'
      )
    ) {
      await fs.writeFile(channelsPath, `${MANAGER_DEFAULT_CHANNELS}\n`, 'utf8')
    }
  } catch {
    await fs.writeFile(channelsPath, `${MANAGER_DEFAULT_CHANNELS}\n`, 'utf8')
  }

  let existing: Record<string, string> = {}
  try {
    existing = parseIniSection(await fs.readFile(configPath, 'utf8'))
  } catch {
    existing = {}
  }

  const next = { ...existing }

  if (!next.channel_url || LEGACY_MANAGER_CHANNEL_URLS.has(next.channel_url)) {
    next.channel_url = MANAGER_DEFAULT_CHANNEL_ALIAS
  }
  next.windows_selector_event_loop_policy = 'True'
  next.network_mode = next.network_mode || 'public'
  next.update_policy = next.update_policy || 'stable-comfyui'
  next.db_mode = next.db_mode || 'cache'
  next.security_level = next.security_level || 'normal'
  next.preview_method = next.preview_method || 'none'
  next.file_logging = next.file_logging || 'True'

  const serialized = serializeIniSection(next)
  const existingSerialized = serializeIniSection(existing)
  if (serialized !== existingSerialized) {
    await fs.writeFile(configPath, serialized, 'utf8')
  }
}

export class HyperSvcImpl implements HyperSvc {
  async listFastSettingTemplates(
    req: ListFastSettingTemplatesReq
  ): Promise<ListFastSettingTemplatesResp> {
    return await listFastSettingTemplates()
  }
  async getFastSettingValue(req: GetFastSettingValueReq): Promise<GetFastSettingValueResp> {
    const { key, inputPath } = req
    return await getFastSettingValue(inputPath, key)
  }
  async getExtraModelPaths(req: GetExtraModelPathsReq): Promise<GetExtraModelPathsResp> {
    const config = getConfig()
    const buildEnv = getBuildEnv()
    const configUtils = new ConfigUtils(config, buildEnv, path)
    const [comfyUIDir, confyUIDirAvailable] = configUtils.getComfyUIDir()
    if (!confyUIDirAvailable) {
      throw new Error('comfyUIDir is not available')
    }

    const fs = new ComfyFSCli()
    const extraModelPaths = await fs.getExtraModelPaths()

    const basePath = path.join(comfyUIDir, extraModelPaths.base_path ?? '')

    const rawResult: GetExtraModelPathsResp = {
      checkpoints_dir: extraModelPaths.checkpoints,
      vae_dir: extraModelPaths.vae,
      lora_dir: extraModelPaths.loras,
      controlnet_dir: extraModelPaths.controlnet
    }

    const result: GetExtraModelPathsResp = Object.fromEntries(
      Object.entries(rawResult)
        // 清理掉其他字段
        .filter(([_, value]) => value !== undefined)
        // 转换为绝对路径
        .map(([key, value]) => [key, path.isAbsolute(value) ? value : path.join(basePath, value)])
    )
    return result
  }
  async startComfyUI(
    _req: StartComfyUIReq,
    resp: ServerStreaming<StartComfyUIResp>
  ): Promise<void> {
    let pid = 0
    let command = ''

    const logInfo = (msg: string) => {
      console.log('[comfyui] ' + msg)
      resp.onData({
        pid,
        command,
        status: 'running',
        logLine: '[comfyui] ' + msg
      })
    }

    const logError = (msg: string) => {
      console.error('[comfyui] ' + msg)
      resp.onData({
        pid,
        command,
        status: 'error',
        logLine: '[comfyui] ' + msg
      })
    }

    const config = getConfig()
    const buildEnv = getBuildEnv()
    const configUtils = new ConfigUtils(config, buildEnv, path)

    const [comfyUIDirRaw, confyUIDirAvailable] = configUtils.getComfyUIDir()
    if (!confyUIDirAvailable) {
      logError('comfyUIDir is not available')
    }
    const [pythonCmdRaw, pythonCmdAvailable] = configUtils.getPythonCmd()
    if (!pythonCmdAvailable) {
      logError('pythonCmd is not available')
    }

    if (!confyUIDirAvailable || !pythonCmdAvailable) {
      return
    }

    // 将相对路径解析为绝对路径（相对于应用根目录）
    const appRoot = buildEnv.pathMap.file
    const comfyUIDir = path.isAbsolute(comfyUIDirRaw)
      ? comfyUIDirRaw
      : path.join(appRoot, comfyUIDirRaw)
    const pythonCmd = path.isAbsolute(pythonCmdRaw)
      ? pythonCmdRaw
      : path.join(appRoot, pythonCmdRaw)

    const comfyMain = path.join(comfyUIDir, 'main.py')
    const comfyArgs = configUtils.getComfyUIArgs()

    // 检测是否是 ComfyUI-aki-v2
    // 从日志看，使用 python\python.exe 也能正常启动，所以统一不使用 -s 参数
    const isComfyUIAkiV2 =
      pythonCmd.includes('ComfyUI-aki-v2') || comfyUIDir.includes('ComfyUI-aki-v2')

    let args: string[]

    if (isComfyUIAkiV2) {
      // ComfyUI-aki-v2 不使用 -s 参数
      args = [comfyMain, ...comfyArgs]
      logInfo('检测到 ComfyUI-aki-v2，不使用 -s 参数')
    } else {
      // 其他环境使用 -s 参数
      args = ['-s', comfyMain, ...comfyArgs]
    }

    command = pythonCmd + ' ' + args.join(' ')
    logInfo('comfyUIDir: ' + comfyUIDir)
    logInfo('pythonCmd: ' + pythonCmd)
    logInfo('comfyMain: ' + comfyMain)
    logInfo('comfyArgs: ' + comfyArgs)

    const comfyPort = configUtils.getComfyUIPort()
    const existingPid = comfyPort
      ? await this.comfyPortDetect({})
          .then((result) => result.pid)
          .catch(() => 0)
      : 0

    if (comfyPort && existingPid > 0) {
      pid = existingPid
      const reachable = await waitForLocalComfyHttp(comfyPort, COMFY_HTTP_EXISTING_PROCESS_ATTEMPTS)
      if (reachable) {
        logInfo(
          `detected reachable existing ComfyUI on port ${comfyPort} with pid ${existingPid}; skip spawning duplicate process`
        )
        return
      }

      logError(
        `ComfyUI port ${comfyPort} is already occupied by pid ${existingPid}, but the HTTP API is not reachable; refusing to spawn a duplicate process`
      )
      return
    }

    logInfo('start ComfyUI...')

    await sleep(100)

    if (buildEnv.env.platform === 'windows' && buildEnv.env.buildMode === 'embedded') {
      let vcRedistResult: Awaited<ReturnType<typeof ensureVcRedistInstalled>>
      try {
        vcRedistResult = await ensureVcRedistInstalled(
          buildEnv.pathMap.file,
          {
            info: logInfo,
            warn: logError
          },
          {
            confirmInstall: async () => {
              const result = await dialog.showMessageBox({
                type: 'warning',
                buttons: ['安装并继续', '取消'],
                defaultId: 0,
                cancelId: 1,
                noLink: true,
                title: '需要安装 VC++ 运行库',
                message: '内置 ComfyUI 需要 Microsoft Visual C++ Redistributable x64',
                detail:
                  '检测到系统缺少该运行库。缺失时 ComfyUI 可能会直接崩溃并显示 0xC0000005。是否现在安装随包附带的 Microsoft 官方运行库？'
              })
              return result.response === 0
            }
          }
        )
      } catch (error) {
        logError(`VC++ Redistributable install failed: ${String(error)}`)
        return
      }

      if (vcRedistResult !== 'already-installed') {
        logInfo(`VC++ Redistributable check result: ${vcRedistResult}`)
      }
      if (
        vcRedistResult === 'declined' ||
        vcRedistResult === 'installer-missing' ||
        vcRedistResult === 'installed-not-detected'
      ) {
        logError('ComfyUI startup stopped because VC++ Redistributable x64 is required')
        return
      }
    }

    try {
      await ensureComfyManagerBootstrapConfig(comfyUIDir)
    } catch (error) {
      logError(`failed to prepare ComfyUI-Manager config: ${String(error)}`)
    }

    return spawnSubProcess('comfyui', {
      command: pythonCmd,
      args: args,
      cwd: comfyUIDir,
      env: createPortablePythonEnv(buildEnv.pathMap.data),
      hooks: {
        afterStart: (gotPid) => {
          pid = gotPid
          logInfo('comfyui started with pid: ' + pid)
        },
        onStdout: (data) => {
          logInfo(data)
        },
        onStderr: (data) => {
          logError(data)
        },
        onClose: (code, signal) => {
          const msg = `comfyProc closed with code ${code} and signal ${signal}`
          console.log('[comfyui] ' + msg)
          resp.onData({
            pid,
            command: 'comfyui',
            status: 'closed',
            logLine: msg
          })
        },
        onError: (error) => {
          logError('comfyui error: ' + error.message.toString())
        }
      }
    })
  }

  comfyPortDetect = async (req: ComfyPortDetectReq): Promise<ComfyPortDetectResp> => {
    const config = getConfig()
    const buildEnv = getBuildEnv()
    const configUtils = new ConfigUtils(config, buildEnv, path)

    const comfyPort = configUtils.getComfyUIPort()
    if (comfyPort === '') {
      throw new Error('can not get comfy port from config')
    }

    if (buildEnv.env.platform === 'windows') {
      // Windows 系统使用 netstat 命令检测端口占用
      try {
        const result = await this.runCommandSync({
          command: 'cmd',
          args: ['/c', 'netstat -ano -p tcp']
        })

        if (result.stdOut.trim()) {
          // 解析 netstat 输出获取 PID
          const lines = result.stdOut.split('\n')
          for (const line of lines) {
            if (line.toUpperCase().includes('LISTENING') && line.includes(':' + comfyPort)) {
              const parts = line.trim().split(/\s+/)
              const pid = parseInt(parts[parts.length - 1])
              if (!isNaN(pid)) {
                return { pid }
              }
            }
          }
        }
      } catch (error) {
        // findstr 未找到匹配时返回 code 1，视为端口未被占用
        return { pid: 0 }
      }
    } else {
      // macOS 和 Linux 系统使用 lsof 命令
      try {
        const result = await this.runCommandSync({
          command: 'lsof',
          args: ['-i', ':' + comfyPort, '-t', '-sTCP:LISTEN']
        })

        if (result.stdOut.trim()) {
          // lsof -t 只返回 PID，一行一个
          const pids = result.stdOut.trim().split('\n')
          const firstPid = parseInt(pids[0])
          return { pid: isNaN(firstPid) ? 0 : firstPid }
        }
      } catch (error) {
        // lsof 如果没有找到任何进程，会返回 code == 1
        // 这里偷懒，所有 error 当作未找到进程处理
        return { pid: 0 }
      }
    }
    return { pid: 0 }
  }

  async listComfyFiles(
    req: ListComfyFilesReq,
    resp: ServerStreaming<ListComfyFilesResp>
  ): Promise<void> {
    const fs = new ComfyFSCli()
    await fs.forEachFileInfo(req.dir, req.exts, async (file) => {
      resp.onData({ file })
    })
  }

  async listDirShallow(req: {
    dir: string
  }): Promise<{ entries: { name: string; path: string; isDirectory: boolean; size?: number }[] }> {
    const fsPromises = await import('fs/promises')
    const pathModule = await import('path')

    try {
      const dirents = await fsPromises.readdir(req.dir, { withFileTypes: true })
      const entries: { name: string; path: string; isDirectory: boolean; size?: number }[] = []

      for (const d of dirents) {
        if (d.name.startsWith('.')) continue // 隐藏文件跳过
        const fullPath = pathModule.join(req.dir, d.name)
        const isDir = d.isDirectory()
        let size: number | undefined
        if (!isDir) {
          try {
            const st = await fsPromises.stat(fullPath)
            size = st.size
          } catch {
            // 跳过无法 stat 的文件
          }
        }
        entries.push({ name: d.name, path: fullPath, isDirectory: isDir, size })
      }

      // 排序：目录在前，文件在后，各自字母排序
      entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      return { entries }
    } catch (err) {
      console.error('[HyperSvc] listDirShallow error:', err)
      return { entries: [] }
    }
  }

  startProcess = async (
    req: StartProcessReq,
    resp: ServerStreaming<StartProcessResp>
  ): Promise<void> => {
    let pid = 0
    const command = req.command + ' ' + req.args.join(' ')

    const logInfo = (msg: string) => {
      console.log(`[${req.name}] ` + msg)
      resp.onData({
        pid,
        name: req.name,
        command: command,
        status: 'running',
        logLine: `[${req.name}] ` + msg
      })
    }

    const logError = (msg: string) => {
      console.error(`[${req.name}] ` + msg)
      resp.onData({
        pid,
        name: req.name,
        command: command,
        status: 'error',
        logLine: `[${req.name}] ` + msg
      })
    }

    logInfo('start process...')

    await spawnSubProcess(req.name, {
      command: req.command,
      args: req.args,
      cwd: '',
      hooks: {
        afterStart: (gotPid) => {
          pid = gotPid
          logInfo('process started with pid: ' + pid)
        },
        onStdout: (data) => {
          logInfo(data)
        },
        onStderr: (data) => {
          logError(data)
        },
        onClose: (code, signal) => {
          const msg = `process closed with code ${code} and signal ${signal}`
          console.log(msg)
          resp.onData({
            pid,
            name: req.name,
            command: command,
            status: 'closed',
            logLine: msg
          })
        },
        onError: (error) => {
          logError('process error: ' + error.message.toString())
        }
      }
    })
  }

  async killSubProcess(req: KillSubProcessReq): Promise<KillSubProcessResp> {
    await killSubProcess(req.pid)
    return {}
  }

  async connectSubProcess(
    req: ConnectSubProcessReq,
    resp: ServerStreaming<ConnectSubProcessResp>
  ): Promise<void> {
    const pid = req.pid

    const logInfo = (msg: string) => {
      console.log('[comfyui] ' + msg)
      resp.onData({
        pid,
        command: 'comfyui',
        status: 'running',
        logLine: '[comfyui] ' + msg
      })
    }

    const logError = (msg: string) => {
      console.error('[comfyui] ' + msg)
      resp.onData({
        pid,
        command: 'comfyui',
        status: 'error',
        logLine: '[comfyui] ' + msg
      })
    }

    logInfo('connect ComfyUI...')
    await connectSubProcess({
      pid: req.pid,
      hooks: {
        afterStart: (gotPid) => {
          logInfo('connected to comfyui with pid: ' + gotPid)
        },
        onStdout: (data) => {
          logInfo(data)
        },
        onStderr: (data) => {
          logError(data)
        },
        onClose: (code, signal) => {
          const msg = `comfyProc closed with code ${code} and signal ${signal}`
          console.log('[comfyui] ' + msg)
          resp.onData({
            pid,
            command: 'comfyui',
            status: 'closed',
            logLine: msg
          })
        },
        onError: (error) => {
          logError('comfyui error: ' + error.message.toString())
        }
      }
    })
  }

  runCommandSync = async (req: RunCommandSyncReq): Promise<RunCommandSyncResp> => {
    const { command, args } = req
    let stdout = ''
    let stderr = ''
    let retCode: number | null = null
    let retSignal: string | null = null
    let retErr: Error | null = null

    await spawnSubProcess(command, {
      command,
      args,
      hooks: {
        onStdout: (data) => {
          stdout += data
        },
        onStderr: (data) => {
          stderr += data
        },
        onClose: (code, signal) => {
          retCode = code
          retSignal = signal
        },
        onError: (error) => {
          retErr = error
        }
      }
    })

    if (retErr) throw retErr
    if (retCode !== 0) {
      throw new Error('Command failed with code: ' + retCode + ' and signal: ' + retSignal)
    }

    return { stdOut: stdout.trim(), stdErr: stderr.trim() }
  }

  getGPUInfo = async (_req: GetGPUInfoReq): Promise<GetGPUInfoResp> => {
    const buildEnv = getBuildEnv()
    try {
      if (buildEnv.env.platform === 'windows') {
        // 1) 先试 nvidia-smi（走 PATH）
        try {
          const res = await this.runCommandSync({
            command: 'nvidia-smi',
            args: ['--query-gpu=name', '--format=csv,noheader']
          })
          const name = res.stdOut
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)[0]
          if (name) return { gpuInfo: name }
        } catch {
          /* ignore and try explicit path */
        }

        // 2) 再试显式路径（NVSMI 的默认安装目录）
        try {
          const nvsmipath = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'
          const res2 = await this.runCommandSync({
            command: nvsmipath,
            args: ['--query-gpu=name', '--format=csv,noheader']
          })
          const name2 = res2.stdOut
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)[0]
          if (name2) return { gpuInfo: name2 }
        } catch {
          /* ignore and fallback to CIM */
        }

        // 3) 最后用 PowerShell / CIM（WMIC 已弃用）
        try {
          const ps = await this.runCommandSync({
            command: 'powershell',
            args: [
              '-NoProfile',
              '-Command',
              'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'
            ]
          })
          const name3 = ps.stdOut
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)[0]
          if (name3) return { gpuInfo: name3 }
        } catch {
          /* ignore */
        }

        return { gpuInfo: '未检测到显卡信息' }
      } else {
        // macOS / Linux：保留你原来的实现（不会影响你队友）
        const result = await this.runCommandSync({
          command: 'system_profiler',
          args: ['SPDisplaysDataType']
        })
        if (result.stdOut.includes('Chipset Model:')) {
          const match = result.stdOut.match(/Chipset Model:\s*(.+)/)
          return { gpuInfo: match ? match[1].trim() : '未检测到显卡信息' }
        }
        return { gpuInfo: '未检测到显卡信息' }
      }
    } catch {
      return { gpuInfo: '获取显卡信息失败' }
    }
  }

  environmentDetect = async (
    _req: EnvironmentDetectReq,
    resp: ServerStreaming<EnvironmentDetectResp>
  ): Promise<void> => {
    const buildEnv = getBuildEnv()
    const config = getConfig()
    const configUtils = new ConfigUtils(config, buildEnv, path)
    const [pythonCmd, pythonCmdAvailable] = configUtils.getPythonCmd()
    if (!pythonCmdAvailable) {
      resp.onData({
        pythonVersion: 'Python 未设置',
        pytorchVersion: 'Python 未设置',
        gpuInfo: 'Python 未设置',
        cudaVersion: 'Python 未设置'
      })
      return
    }

    // 检测 Python 版本
    const pythonVersionResult = await this.runCommandSync({
      command: pythonCmd,
      args: ['--version']
    })
    const pythonVersion = pythonVersionResult.stdOut.trim()
    resp.onData({ pythonVersion })

    // 检测 PyTorch 版本
    const pytorchVersionResult = await this.runCommandSync({
      command: pythonCmd,
      args: ['-c', 'import torch; print(torch.__version__)']
    })
    const pytorchVersion = pytorchVersionResult.stdOut.trim()
    resp.onData({ pytorchVersion })

    // 检测 GPU 信息
    const gpuInfo = await this.getGPUInfo({})
    resp.onData({ gpuInfo: gpuInfo.gpuInfo })

    // CUDA 版本检测已关闭，不返回数据
  }

  async saveImageToDir(req: {
    data: Uint8Array
    fileName: string
    dir?: string
  }): Promise<{ savedPath: string }> {
    const fsPromises = await import('fs/promises')
    const pathModule = await import('path')
    const os = await import('os')

    // 文件名必须在主进程边界做净化，防止附件名路径穿越。
    const originalFileName = sanitizeSaveImageFileName(req.fileName)

    // 默认保存到桌面/魔壶图片保存
    const targetDir = pathModule.resolve(
      req.dir || pathModule.join(os.homedir(), 'Desktop', '魔壶图片保存')
    )

    // 确保目录存在
    await fsPromises.mkdir(targetDir, { recursive: true })

    const ext = pathModule.extname(originalFileName)
    const base = pathModule.basename(originalFileName, ext)
    const data = Buffer.from(req.data)
    let counter = 0
    while (true) {
      const fileName = counter === 0 ? originalFileName : `${base}_${counter}${ext}`
      const filePath = pathModule.resolve(targetDir, fileName)
      const relativePath = pathModule.relative(targetDir, filePath)
      if (!relativePath || relativePath.startsWith('..') || pathModule.isAbsolute(relativePath)) {
        throw new Error('Invalid file name: resolved path escapes target directory')
      }

      try {
        await fsPromises.writeFile(filePath, data, { flag: 'wx' })
        return { savedPath: filePath }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw error
        }
        counter += 1
      }
    }
  }

  async migrateLegacyAssistantImage(
    req: MigrateLegacyAssistantImageReq
  ): Promise<MigrateLegacyAssistantImageResp> {
    return migrateLegacyAssistantImageFile({
      fileName: req.fileName,
      legacyRoot: path.join(nodeOs.homedir(), 'Desktop', '魔壶图片保存'),
      userDataRoot: getBuildEnv().pathMap.data
    })
  }

  async writeImageToClipboard(req: WriteImageToClipboardReq): Promise<WriteImageToClipboardResp> {
    const { nativeImage, clipboard } = await import('electron')
    // req.data has the typed array, convert to Buffer
    const image = nativeImage.createFromBuffer(Buffer.from(req.data))
    if (!image.isEmpty()) {
      clipboard.writeImage(image)
      return { success: true }
    }
    return { success: false }
  }

  async readClipboardText(_: ReadClipboardTextReq): Promise<ReadClipboardTextResp> {
    const { clipboard } = await import('electron')
    return {
      text: clipboard.readText()
    }
  }

  async readClipboardHtml(_: ReadClipboardHtmlReq): Promise<ReadClipboardHtmlResp> {
    const { clipboard } = await import('electron')
    return {
      html: clipboard.readHTML()
    }
  }

  async readClipboardImage(_: ReadClipboardImageReq): Promise<ReadClipboardImageResp> {
    const { clipboard } = await import('electron')
    const image = clipboard.readImage()
    if (image.isEmpty()) {
      return { success: false }
    }

    return {
      success: true,
      data: new Uint8Array(image.toPNG()),
      mimeType: 'image/png'
    }
  }

  async writeSvgToClipboard(req: WriteSvgToClipboardReq): Promise<WriteSvgToClipboardResp> {
    const { clipboard } = await import('electron')

    try {
      const svgBuffer = Buffer.from(req.svg, 'utf8')
      clipboard.clear()
      clipboard.write({
        text: req.svg,
        html: req.svg
      })
      clipboard.writeBuffer('image/svg+xml', svgBuffer)
      return { success: true }
    } catch (error) {
      console.error('[HyperSvc] Failed to write SVG to clipboard:', error)
      return { success: false }
    }
  }
}
