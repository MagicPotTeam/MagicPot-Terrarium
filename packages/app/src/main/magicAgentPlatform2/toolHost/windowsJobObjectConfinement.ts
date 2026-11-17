import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { PolicyConstraints } from '../../../shared/magicAgentPlatform2'
import { type CommandJobsConfinementAdapter, type CommandJobsSpawnProcess } from './commandJobs'

const HELPER_NAME = 'magicpot-command-job.exe'
const MAX_WINDOWS_PROCESS_COUNT = 0xffff_ffff
const MAX_WINDOWS_CPU_TIME_MS = 922_337_203_685_477

export interface WindowsCommandJobFileOps {
  realpath(path: string): string
  isFile(path: string): boolean
  read(path: string, encoding?: BufferEncoding): Buffer | string
}

const defaultFileOps: WindowsCommandJobFileOps = {
  realpath: (value) => realpathSync.native(value),
  isFile: (value) => statSync(value).isFile(),
  read: (value, encoding) =>
    encoding === undefined ? readFileSync(value) : readFileSync(value, { encoding })
}

export const resolveWindowsCommandJobHelper = (
  candidates: readonly string[] = defaultCandidates(),
  fileOps: WindowsCommandJobFileOps = defaultFileOps
): string | undefined => {
  for (const candidate of candidates) {
    try {
      const canonical = fileOps.realpath(candidate)
      if (!fileOps.isFile(canonical)) continue
      const expected = String(fileOps.read(`${canonical}.sha256`, 'ascii'))
        .trim()
        .toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(expected)) continue
      const actual = createHash('sha256')
        .update(fileOps.read(canonical) as Buffer)
        .digest('hex')
      if (actual === expected) return canonical
    } catch {
      // Missing, non-canonical or unverifiable helpers are intentionally ignored.
    }
  }
  return undefined
}

/**
 * The answer of the current helper to `--capabilities`. It must stay equal to the string printed by
 * packages/magicpot-command-job/src/main.rs and checked by agentThreadHtmlProcess.ts and
 * scripts/test-magicpot-command-job.mjs.
 */
export const WINDOWS_COMMAND_JOB_CAPABILITY = 'magicpot-command-job:atomic-job-list-empty-v2'

/** Runs `<helper> --capabilities` (bounded, no shell) and returns its trimmed output on exit 0. */
export const probeWindowsCommandJobHelperCapability = (
  helper: string,
  spawnProcess: CommandJobsSpawnProcess = spawn,
  timeoutMs = 2_000
): Promise<string | undefined> =>
  new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        probe?.kill()
      } catch {
        // The probe may already be gone; it is reported as unavailable either way.
      }
      finish(undefined)
    }, timeoutMs)
    let probe: ReturnType<CommandJobsSpawnProcess> | undefined
    try {
      probe = spawnProcess(helper, ['--capabilities'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      finish(undefined)
      return
    }
    probe.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
      if (output.length > 1024) {
        try {
          probe?.kill()
        } catch {
          // Oversized answers are never a valid capability.
        }
        finish(undefined)
      }
    })
    probe.once('error', () => finish(undefined))
    probe.once('close', (code) => finish(code === 0 ? output.trim() : undefined))
  })

/**
 * The verified helper (fixed candidates and SHA-256 manifest, never PATH or the workspace) that
 * also answers the current capability, or undefined. A helper that is missing, fails verification
 * or reports another capability counts as absent.
 */
export const resolveCapableWindowsCommandJobHelper = async (
  options: Readonly<{
    candidates?: readonly string[]
    fileOps?: WindowsCommandJobFileOps
    probe?: (helper: string) => Promise<string | undefined>
  }> = {}
): Promise<string | undefined> => {
  const helper = resolveWindowsCommandJobHelper(options.candidates, options.fileOps)
  if (!helper) return undefined
  const capability = await (options.probe ?? probeWindowsCommandJobHelperCapability)(helper).catch(
    () => undefined
  )
  if (capability !== WINDOWS_COMMAND_JOB_CAPABILITY) return undefined
  // The file that answered must still be the verified one when it is launched.
  return resolveWindowsCommandJobHelper([helper], options.fileOps) === helper ? helper : undefined
}

export const createWindowsJobObjectConfinementAdapter = (
  platform: NodeJS.Platform = process.platform,
  candidates?: readonly string[],
  spawnProcess: CommandJobsSpawnProcess = spawn,
  fileOps: WindowsCommandJobFileOps = defaultFileOps
): CommandJobsConfinementAdapter | undefined => {
  if (platform !== 'win32') return undefined
  const helper = resolveWindowsCommandJobHelper(candidates, fileOps)
  if (!helper) return undefined
  return Object.freeze({
    platform: `windows-job-object:${helper}`,
    capabilities: Object.freeze({
      memory: true,
      cpu: true,
      processCount: true,
      networkDeny: false,
      networkHosts: false
    }),
    prepare: (constraints: PolicyConstraints): CommandJobsSpawnProcess => {
      const preparedHelper = resolveWindowsCommandJobHelper([helper], fileOps)
      if (preparedHelper !== helper) {
        throw new Error('Windows Job Object helper identity changed before execution.')
      }
      const helperArgs = buildWindowsJobObjectArguments(constraints)
      return ((command, args, options) => {
        const launchHelper = resolveWindowsCommandJobHelper([helper], fileOps)
        if (launchHelper !== helper) {
          throw new Error('Windows Job Object helper identity changed before spawn.')
        }
        return spawnProcess(helper, [...helperArgs, '--', command, ...args], options)
      }) as CommandJobsSpawnProcess
    }
  })
}

export const buildWindowsJobObjectArguments = (constraints: PolicyConstraints): string[] => {
  const metadata = constraints.metadata
  return [
    integerOrDash(metadata?.maxMemoryBytes, 'maxMemoryBytes'),
    integerOrDash(metadata?.maxCpuTimeMs, 'maxCpuTimeMs', MAX_WINDOWS_CPU_TIME_MS),
    integerOrDash(metadata?.maxProcessCount, 'maxProcessCount', MAX_WINDOWS_PROCESS_COUNT)
  ]
}

const defaultCandidates = (): string[] => [
  path.join(path.dirname(process.execPath), 'bin', 'magicpot-command-job', HELPER_NAME),
  path.join(
    process.cwd(),
    'packages',
    'runtime-assets',
    'resources',
    'bin',
    'magicpot-command-job',
    HELPER_NAME
  )
]

const integerOrDash = (value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): string => {
  if (value === undefined) return '-'
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${name} must be a positive safe integer.`)
  if (Number(value) > maximum) throw new Error(`${name} exceeds the Windows Job Object limit.`)
  return String(value)
}
