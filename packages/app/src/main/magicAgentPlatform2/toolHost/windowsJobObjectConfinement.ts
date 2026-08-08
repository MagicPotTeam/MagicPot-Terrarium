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
  read: (value, encoding) => readFileSync(value, encoding)
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
