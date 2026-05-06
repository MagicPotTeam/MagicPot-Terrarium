import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import type { Config } from '@shared/config/config'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_CHARS = 12_000
const MAX_OUTPUT_CHARS = 60_000
const DEFAULT_GIT_LOG_LIMIT = 20
const MAX_GIT_LOG_LIMIT = 50

type AgentTerminalCommandInput = {
  command?: unknown
  args?: unknown
  cwd?: unknown
  confirm?: unknown
  timeoutMs?: unknown
  maxOutputChars?: unknown
}

type AgentTerminalRunContext = {
  config: Config
  workspaceRoots?: string[]
  signal?: AbortSignal
}

type ResolvedAgentTerminalCwd = {
  cwd: string
  allowedRoots: string[]
}

export type AgentTerminalCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  cwd: string
  command: {
    executable: string
    args: string[]
    requested: string
  }
}

type NormalizedAgentTerminalCommand = {
  executable: 'node' | 'git'
  requestedArgs: string[]
  spawnArgs: string[]
  requested: string
}

const cleanString = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\0/g, '').trim() : ''

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

const normalizeComparablePath = (value: string): string => {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const isSameOrInside = (parentDir: string, targetPath: string): boolean => {
  const parent = normalizeComparablePath(parentDir)
  const target = normalizeComparablePath(targetPath)
  return target === parent || target.startsWith(`${parent}/`)
}

const uniqueResolvedPaths = (paths: string[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []

  for (const entry of paths) {
    const cleaned = cleanString(entry)
    if (!cleaned) {
      continue
    }

    const resolved = path.resolve(cleaned)
    const key = normalizeComparablePath(resolved)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(resolved)
  }

  return result
}

const safeRealpath = async (targetPath: string): Promise<string | undefined> => {
  try {
    return await fs.realpath(targetPath)
  } catch {
    return undefined
  }
}

const resolveExistingDirectory = async (targetPath: string): Promise<string> => {
  const resolved = path.resolve(targetPath)
  const stats = await fs.stat(resolved)
  if (!stats.isDirectory()) {
    throw new Error(`agent.terminal.run cwd is not a directory: ${resolved}`)
  }
  return fs.realpath(resolved)
}

const collectAllowedRoots = async (
  config: Config,
  workspaceRoots: string[] | undefined
): Promise<string[]> => {
  const candidateRoots = uniqueResolvedPaths([
    process.cwd(),
    config.download_dir,
    config.output_dir,
    config.workflow_dir,
    ...(workspaceRoots || [])
  ])

  const realRoots = await Promise.all(candidateRoots.map((root) => safeRealpath(root)))
  return uniqueResolvedPaths(realRoots.filter((root): root is string => Boolean(root)))
}

const resolveAgentTerminalCwd = async (
  cwd: unknown,
  context: AgentTerminalRunContext
): Promise<ResolvedAgentTerminalCwd> => {
  const requestedCwd = cleanString(cwd) || process.cwd()
  const resolvedCwd = await resolveExistingDirectory(requestedCwd)
  const allowedRoots = await collectAllowedRoots(context.config, context.workspaceRoots)

  if (!allowedRoots.some((root) => isSameOrInside(root, resolvedCwd))) {
    throw new Error('agent.terminal.run cwd is outside the allowed roots.')
  }

  return {
    cwd: resolvedCwd,
    allowedRoots
  }
}

const normalizeArgs = (value: unknown): string[] => {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error('agent.terminal.run args must be an array of strings.')
  }

  if (value.length > 20) {
    throw new Error('agent.terminal.run accepts at most 20 args.')
  }

  return value.map((item) => {
    const arg = cleanString(item)
    if (!arg || typeof item !== 'string') {
      throw new Error('agent.terminal.run args must be non-empty strings.')
    }
    if (arg.length > 200 || /[\r\n;&|<>`$]/.test(arg)) {
      throw new Error('agent.terminal.run rejected an unsafe argument.')
    }
    return arg
  })
}

const normalizeExecutable = (value: unknown): 'node' | 'git' => {
  const raw = cleanString(value).toLowerCase()
  if (!raw) {
    throw new Error('agent.terminal.run requires command.')
  }
  if (raw.includes('/') || raw.includes('\\') || /[\r\n;&|<>`$]/.test(raw)) {
    throw new Error('agent.terminal.run command must be a bare allowlisted executable.')
  }

  const withoutWindowsSuffix = raw.endsWith('.exe') ? raw.slice(0, -4) : raw
  if (withoutWindowsSuffix === 'node' || withoutWindowsSuffix === 'git') {
    return withoutWindowsSuffix
  }

  throw new Error(`agent.terminal.run command is not allowlisted: ${raw}`)
}

const assertVersionArgs = (executable: 'node', args: string[]): string[] => {
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) {
    return args
  }
  throw new Error(`agent.terminal.run only allows ${executable} --version.`)
}

const normalizeGitStatusArgs = (args: string[]): string[] => {
  const allowedFlags = new Set([
    '--short',
    '--branch',
    '--porcelain',
    '--porcelain=v1',
    '--porcelain=v2',
    '--untracked-files=no',
    '--untracked-files=normal',
    '--untracked-files=all',
    '-s',
    '-sb',
    '-uno'
  ])

  if (args.slice(1).every((arg) => allowedFlags.has(arg))) {
    return args
  }

  throw new Error('agent.terminal.run only allows read-only git status flags.')
}

const normalizeGitDiffArgs = (args: string[]): string[] => {
  const allowedFlags = new Set([
    '--stat',
    '--shortstat',
    '--name-only',
    '--name-status',
    '--cached',
    '--staged',
    '--check'
  ])
  const userFlags = args.slice(1)

  if (!userFlags.every((arg) => allowedFlags.has(arg))) {
    throw new Error('agent.terminal.run only allows read-only git diff flags.')
  }

  return ['diff', '--no-ext-diff', '--no-textconv', ...userFlags]
}

const parseGitLogLimit = (value: string): number | undefined => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_GIT_LOG_LIMIT) {
    return undefined
  }
  return parsed
}

const normalizeGitLogArgs = (args: string[]): string[] => {
  const normalized = ['log']
  let hasLimit = false

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--oneline') {
      normalized.push(arg)
      continue
    }

    const maxCountMatch = arg.match(/^--max-count=(\d+)$/)
    if (maxCountMatch) {
      const limit = parseGitLogLimit(maxCountMatch[1])
      if (!limit) {
        throw new Error(`agent.terminal.run git log limit must be 1-${MAX_GIT_LOG_LIMIT}.`)
      }
      normalized.push(`--max-count=${limit}`)
      hasLimit = true
      continue
    }

    const shortCountMatch = arg.match(/^-(\d+)$/)
    if (shortCountMatch) {
      const limit = parseGitLogLimit(shortCountMatch[1])
      if (!limit) {
        throw new Error(`agent.terminal.run git log limit must be 1-${MAX_GIT_LOG_LIMIT}.`)
      }
      normalized.push(`-${limit}`)
      hasLimit = true
      continue
    }

    if (arg === '-n') {
      const limit = parseGitLogLimit(args[index + 1] || '')
      if (!limit) {
        throw new Error(`agent.terminal.run git log -n requires 1-${MAX_GIT_LOG_LIMIT}.`)
      }
      normalized.push('-n', String(limit))
      hasLimit = true
      index += 1
      continue
    }

    throw new Error('agent.terminal.run only allows read-only git log flags.')
  }

  if (!hasLimit) {
    normalized.push('-n', String(DEFAULT_GIT_LOG_LIMIT))
  }

  return normalized
}

const buildSafeGitArgs = (args: string[]): string[] => [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'diff.external=',
  '-c',
  'pager.status=false',
  '-c',
  'pager.diff=false',
  '-c',
  'pager.log=false',
  ...args
]

export const normalizeAgentTerminalCommand = (
  input: AgentTerminalCommandInput
): NormalizedAgentTerminalCommand => {
  const executable = normalizeExecutable(input.command)
  const requestedArgs = normalizeArgs(input.args)
  let spawnArgs: string[]

  if (executable === 'node') {
    spawnArgs = assertVersionArgs(executable, requestedArgs)
  } else if (requestedArgs[0] === 'status') {
    spawnArgs = buildSafeGitArgs(normalizeGitStatusArgs(requestedArgs))
  } else if (requestedArgs[0] === 'diff') {
    spawnArgs = buildSafeGitArgs(normalizeGitDiffArgs(requestedArgs))
  } else if (requestedArgs[0] === 'log') {
    spawnArgs = buildSafeGitArgs(normalizeGitLogArgs(requestedArgs))
  } else {
    throw new Error('agent.terminal.run only allows git status, git diff, or git log.')
  }

  return {
    executable,
    requestedArgs,
    spawnArgs,
    requested: [executable, ...requestedArgs].join(' ')
  }
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const stats = await fs.stat(filePath)
    return stats.isFile()
  } catch {
    return false
  }
}

const resolveExecutableFromPath = async (
  executable: 'node' | 'git',
  blockedRoots: string[]
): Promise<string | undefined> => {
  const blockedRealRoots = uniqueResolvedPaths(
    (
      await Promise.all(
        blockedRoots.map(async (root) => (await safeRealpath(root)) || path.resolve(root))
      )
    ).filter(Boolean)
  )
  const pathEntries = (process.env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => path.isAbsolute(entry))
    .map((entry) => path.resolve(entry))
  const candidateNames =
    process.platform === 'win32' ? [`${executable}.exe`, executable] : [executable]

  for (const entry of pathEntries) {
    const entryReal = await safeRealpath(entry)
    if (!entryReal || blockedRealRoots.some((root) => isSameOrInside(root, entryReal))) {
      continue
    }
    for (const name of candidateNames) {
      const candidate = path.join(entryReal, name)
      const candidateReal = await safeRealpath(candidate)
      if (
        candidateReal &&
        !blockedRealRoots.some((root) => isSameOrInside(root, candidateReal)) &&
        (await fileExists(candidateReal))
      ) {
        return candidateReal
      }
    }
  }

  return undefined
}

const resolveSpawnExecutable = async (
  executable: 'node' | 'git',
  cwd: string,
  allowedRoots: string[]
): Promise<string> => {
  const blockedRoots = uniqueResolvedPaths([cwd, process.cwd(), ...allowedRoots])

  if (executable === 'node') {
    if (!process.versions.electron) {
      return process.execPath
    }

    const resolvedNode = await resolveExecutableFromPath('node', blockedRoots)
    if (resolvedNode) {
      return resolvedNode
    }
  }

  const resolved = await resolveExecutableFromPath(executable, blockedRoots)
  if (resolved) {
    return resolved
  }

  throw new Error(`agent.terminal.run could not resolve ${executable} without using a shell.`)
}

const appendLimitedOutput = (
  current: string,
  chunk: Buffer | string,
  state: {
    remaining: number
    truncated: boolean
  }
): string => {
  if (state.remaining <= 0) {
    state.truncated = true
    return current
  }

  const text = chunk.toString()
  if (text.length <= state.remaining) {
    state.remaining -= text.length
    return current + text
  }

  state.truncated = true
  const nextText = text.slice(0, state.remaining)
  state.remaining = 0
  return current + nextText
}

export const runAgentTerminalCommand = async (
  input: AgentTerminalCommandInput,
  context: AgentTerminalRunContext
): Promise<AgentTerminalCommandResult> => {
  if (!context.config.project_trace_config?.enable_agent_terminal) {
    throw new Error('agent.terminal.run is disabled by project_trace_config.enable_agent_terminal.')
  }
  if (input.confirm !== true) {
    throw new Error('agent.terminal.run requires confirm: true.')
  }

  const { cwd, allowedRoots } = await resolveAgentTerminalCwd(input.cwd, context)
  const normalized = normalizeAgentTerminalCommand(input)
  const spawnExecutable = await resolveSpawnExecutable(normalized.executable, cwd, allowedRoots)
  const timeoutMs = clampInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS)
  const maxOutputChars = clampInteger(
    input.maxOutputChars,
    DEFAULT_MAX_OUTPUT_CHARS,
    100,
    MAX_OUTPUT_CHARS
  )

  if (context.signal?.aborted) {
    throw new Error('agent.terminal.run was aborted.')
  }

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null
    let timedOut = false
    let settled = false
    const outputState = {
      remaining: maxOutputChars,
      truncated: false
    }

    const child = spawn(spawnExecutable, normalized.spawnArgs, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat'
      }
    })

    const cleanup = (): void => {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', abortHandler)
    }

    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        truncated: outputState.truncated,
        cwd,
        command: {
          executable: normalized.executable,
          args: normalized.requestedArgs,
          requested: normalized.requested
        }
      })
    }

    const abortHandler = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (!child.killed) {
        child.kill()
      }
      cleanup()
      reject(new Error('agent.terminal.run was aborted.'))
    }

    const timer = setTimeout(() => {
      timedOut = true
      if (!child.killed) {
        child.kill()
      }
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout = appendLimitedOutput(stdout, chunk, outputState)
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendLimitedOutput(stderr, chunk, outputState)
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      exitCode = code
      finish()
    })
    context.signal?.addEventListener('abort', abortHandler, { once: true })
  })
}
