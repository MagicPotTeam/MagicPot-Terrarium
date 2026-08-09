import { spawn } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import type { PolicyConstraints } from '../../../shared/magicAgentPlatform2'
import { type CommandJobsConfinementAdapter, type CommandJobsSpawnProcess } from './commandJobs'
import { createWindowsJobObjectConfinementAdapter } from './windowsJobObjectConfinement'

const PRLIMIT_CANDIDATES = ['/usr/bin/prlimit', '/bin/prlimit'] as const

export const createLinuxPrlimitConfinementAdapter = (
  platform: NodeJS.Platform = process.platform,
  candidates: readonly string[] = PRLIMIT_CANDIDATES
): CommandJobsConfinementAdapter | undefined => {
  if (platform !== 'linux') return undefined
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) return undefined
  const canonical = realpathSync.native(executable)
  if (!statSync(canonical).isFile()) return undefined
  return Object.freeze({
    platform: `linux-prlimit:${canonical}`,
    capabilities: Object.freeze({
      memory: true,
      cpu: true,
      processCount: false,
      networkDeny: false,
      networkHosts: false
    }),
    prepare: (constraints: PolicyConstraints): CommandJobsSpawnProcess => {
      const limits = buildPrlimitArguments(constraints)
      return ((command, args, options) =>
        spawn(canonical, [...limits, '--', command, ...args], options)) as CommandJobsSpawnProcess
    }
  })
}

export const createProductionCommandJobsConfinementAdapter = (
  platform: NodeJS.Platform = process.platform
): CommandJobsConfinementAdapter | undefined => {
  if (platform === 'darwin') return undefined
  if (platform === 'win32') return createWindowsJobObjectConfinementAdapter(platform)
  return createLinuxPrlimitConfinementAdapter(platform)
}

export const buildPrlimitArguments = (constraints: PolicyConstraints): string[] => {
  const metadata = constraints.metadata
  const memory = positiveInteger(metadata?.maxMemoryBytes, 'maxMemoryBytes')
  const cpuMs = positiveInteger(metadata?.maxCpuTimeMs, 'maxCpuTimeMs')
  const args: string[] = []
  if (memory !== undefined) args.push(`--as=${memory}:${memory}`)
  if (cpuMs !== undefined) {
    const seconds = Math.max(1, Math.ceil(cpuMs / 1000))
    args.push(`--cpu=${seconds}:${seconds}`)
  }
  return args
}

const positiveInteger = (value: unknown, name: string): number | undefined => {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${name} must be a positive safe integer.`)
  return Number(value)
}
