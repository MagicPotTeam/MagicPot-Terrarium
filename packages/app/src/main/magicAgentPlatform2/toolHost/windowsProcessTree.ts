import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import path from 'node:path'

/**
 * Stopping a process tree on Windows without a Job Object.
 *
 * `taskkill /PID <root> /T /F` enumerates the tree once. A process the tree creates between that
 * enumeration and the death of its parent is not killed and keeps running. This module keeps the
 * immediate taskkill (no added delay before the first kill) and then sweeps: it takes snapshots of
 * the process table (pid, parent pid, creation time), kills every live process that descends from
 * a recorded member of the tree, remembers every member it has seen (after a kill the links of the
 * tree point at dead pids) and repeats until one snapshot shows no live member, bounded by a
 * deadline. A process created before its claimed parent is not that parent's child (pid reuse).
 *
 * Only integers ever reach a command line: taskkill gets `/PID <n>` pairs, the snapshot runs a
 * constant PowerShell script from the fixed System32 path (never PATH).
 */

export type WindowsProcessEntry = Readonly<{
  pid: number
  parentPid: number
  /** Creation time in microseconds since the Unix epoch; null when Windows reports none. */
  createdAtUs: number | null
}>

/** Resolves to the whole process table, or undefined when no snapshot could be taken in time. */
export type WindowsProcessSnapshotProvider = (
  timeoutMs: number
) => Promise<readonly WindowsProcessEntry[] | undefined>

export type WindowsProcessSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

export type WindowsProcessTreeStopOutcome = 'converged' | 'snapshot-unavailable' | 'deadline'

export type WindowsProcessTreeStopReport = Readonly<{
  /** One snapshot taken after the first kill showed no live member of the tree. */
  confirmed: boolean
  outcome: WindowsProcessTreeStopOutcome
  /** The immediate `taskkill /PID <root> /T /F`. */
  initialKill: Readonly<{ exitCode: number | null; failed: boolean; timedOut: boolean }>
  /** Snapshots evaluated. */
  snapshots: number
  /** Processes the sweep killed after the initial taskkill. */
  swept: number
}>

export type WindowsProcessTreeStopOptions = Readonly<{
  /** Date.now() read before the root was spawned: the root cannot have been created earlier. */
  rootCreatedNotBeforeMs: number
  spawnProcess?: WindowsProcessSpawn
  /** Defaults to the PowerShell / CIM snapshot started through `spawnProcess`. */
  snapshot?: WindowsProcessSnapshotProvider
  now?: () => number
  /** Bound of the whole sweep, about 5 s. */
  deadlineMs?: number
  /** Bound of the initial taskkill. */
  initialKillTimeoutMs?: number
  systemRoot?: string
  /** Called as soon as the initial taskkill fails or exits non-zero (today's fallback hook). */
  onInitialKillFailed?: () => void
  /** Never killed, whatever a snapshot says (defaults to this process and its parent). */
  protectedPids?: readonly number[]
}>

export const WINDOWS_TREE_SWEEP_DEADLINE_MS = 5_000
const INITIAL_KILL_TIMEOUT_MS = 3_000
const MIN_SNAPSHOT_TIMEOUT_MS = 1_500
const MAX_SNAPSHOT_TIMEOUT_MS = 4_000
const MAX_PIDS_PER_TASKKILL = 32
/**
 * Windows stamps a process with the coarse system time (about 16 ms steps) while Date.now() is
 * precise, so a root may look created slightly before the Date.now() read before its spawn.
 */
const ROOT_CREATION_SKEW_US = 250_000
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n
const MAX_PID = 0xffff_ffff

const systemRootOf = (systemRoot?: string): string =>
  systemRoot || process.env.SystemRoot || 'C:\\Windows'

export const windowsTaskkillPath = (systemRoot?: string): string =>
  path.win32.join(systemRootOf(systemRoot), 'System32', 'taskkill.exe')

export const windowsPowerShellPath = (systemRoot?: string): string =>
  path.win32.join(
    systemRootOf(systemRoot),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )

/** The only way a pid reaches a command line: a decimal integer in the Windows pid range. */
export const windowsPidArgument = (pid: number): string => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PID)
    throw new Error('A Windows pid must be a positive integer.')
  return String(pid)
}

/** A constant script: no value from the caller, the workspace or a process is interpolated. */
const SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$rows = @(Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
  "  $created = ''",
  '  if ($null -ne $_.CreationDate) { $created = [string]$_.CreationDate.ToFileTimeUtc() }',
  '  [pscustomobject]@{ p = [long]$_.ProcessId; q = [long]$_.ParentProcessId; c = $created }',
  '})',
  '[Console]::Out.Write((ConvertTo-Json -InputObject $rows -Compress))'
].join('\n')

export const WINDOWS_PROCESS_SNAPSHOT_ARGS: readonly string[] = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-EncodedCommand',
  Buffer.from(SNAPSHOT_SCRIPT, 'utf16le').toString('base64')
])

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

/**
 * Strict parser of the snapshot JSON: an array of objects with exactly the keys p, q (integers in
 * the pid range) and c (decimal FILETIME string or ''), no duplicate pid. Anything else is
 * rejected as a whole (undefined).
 */
export function parseWindowsProcessSnapshot(text: string): WindowsProcessEntry[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(text.trim())
  } catch {
    return undefined
  }
  if (!Array.isArray(value)) return undefined
  const entries: WindowsProcessEntry[] = []
  const seen = new Set<number>()
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
    const keys = Object.keys(row).sort()
    if (keys.length !== 3 || keys[0] !== 'c' || keys[1] !== 'p' || keys[2] !== 'q') return undefined
    const { p, q, c } = row as Record<string, unknown>
    if (!isPidValue(p) || !isPidValue(q) || typeof c !== 'string') return undefined
    if (seen.has(p)) return undefined
    seen.add(p)
    let createdAtUs: number | null = null
    if (c !== '') {
      if (!/^[0-9]{1,19}$/.test(c)) return undefined
      const ticks = BigInt(c) - FILETIME_UNIX_EPOCH
      if (ticks < 0n) return undefined
      createdAtUs = Number(ticks / 10n)
      if (!Number.isSafeInteger(createdAtUs)) return undefined
    }
    entries.push(Object.freeze({ pid: p, parentPid: q, createdAtUs }))
  }
  return entries
}

const isPidValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PID

/** Process-table snapshot through `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. */
export const createWindowsPowerShellSnapshot =
  (
    spawnProcess: WindowsProcessSpawn = spawn as unknown as WindowsProcessSpawn,
    systemRoot?: string
  ): WindowsProcessSnapshotProvider =>
  (timeoutMs) =>
    new Promise((resolve) => {
      let settled = false
      let size = 0
      const chunks: Buffer[] = []
      let child: ChildProcess | undefined
      const finish = (value: readonly WindowsProcessEntry[] | undefined) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const stopChild = () => {
        try {
          child?.kill()
        } catch {
          // Already gone.
        }
      }
      const timer = setTimeout(() => {
        stopChild()
        finish(undefined)
      }, timeoutMs)
      try {
        child = spawnProcess(windowsPowerShellPath(systemRoot), WINDOWS_PROCESS_SNAPSHOT_ARGS, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        })
      } catch {
        finish(undefined)
        return
      }
      child.stdout?.on('data', (chunk: Buffer | string) => {
        const data = Buffer.from(chunk)
        size += data.length
        if (size > MAX_SNAPSHOT_BYTES) {
          stopChild()
          finish(undefined)
          return
        }
        chunks.push(data)
      })
      child.once('error', () => finish(undefined))
      child.once('close', (code) => {
        finish(
          code === 0
            ? parseWindowsProcessSnapshot(Buffer.concat(chunks).toString('utf8'))
            : undefined
        )
      })
    })

type KillResult = { exitCode: number | null; failed: boolean; timedOut: boolean }

function runTaskkill(
  spawnProcess: WindowsProcessSpawn,
  systemRoot: string | undefined,
  args: readonly string[],
  timeoutMs: number
): Promise<KillResult> {
  return new Promise((resolve) => {
    let settled = false
    let killer: ChildProcess | undefined
    const finish = (result: KillResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        killer?.kill()
      } catch {
        // Already gone.
      }
      finish({ exitCode: null, failed: false, timedOut: true })
    }, timeoutMs)
    try {
      killer = spawnProcess(windowsTaskkillPath(systemRoot), args, {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      })
    } catch {
      finish({ exitCode: null, failed: true, timedOut: false })
      return
    }
    killer.once('error', () => finish({ exitCode: null, failed: true, timedOut: false }))
    killer.once('close', (code) => finish({ exitCode: code, failed: false, timedOut: false }))
  })
}

type Member = { createdAtUs: number | null; notBeforeUs: number; notAfterUs: number }
/** Every identity ever recorded for a pid: a pid may be reused inside the tree, too. */
export type WindowsTreeMembers = Map<number, Member[]>

const memberLowerBound = (member: Member): number => member.createdAtUs ?? member.notBeforeUs

/**
 * Adds every live descendant of a recorded member to `members` and returns the live members that
 * may be killed. Exported for tests.
 */
export function collectLiveTreeMembers(
  table: readonly WindowsProcessEntry[],
  members: WindowsTreeMembers,
  protectedPids: ReadonlySet<number>
): WindowsProcessEntry[] {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]))
  const identifies = (member: Member, entry: WindowsProcessEntry): boolean => {
    if (entry.createdAtUs === null) return false
    if (member.createdAtUs !== null) return entry.createdAtUs === member.createdAtUs
    // The root: only its pid and the window in which it was created are known.
    return entry.createdAtUs >= member.notBeforeUs && entry.createdAtUs <= member.notAfterUs
  }
  const live = new Map<number, WindowsProcessEntry>()
  for (const entry of table) {
    const member = members.get(entry.pid)?.find((candidate) => identifies(candidate, entry))
    if (!member) continue
    member.createdAtUs = entry.createdAtUs
    live.set(entry.pid, entry)
  }
  let grew = true
  while (grew) {
    grew = false
    for (const entry of table) {
      const createdAtUs = entry.createdAtUs
      if (live.has(entry.pid) || createdAtUs === null || entry.pid === entry.parentPid) continue
      // A process created before its claimed parent is not its child (the parent pid was reused).
      const parents = members
        .get(entry.parentPid)
        ?.filter((member) => createdAtUs >= memberLowerBound(member))
      if (!parents?.length) continue
      // The parent pid belongs to a live process outside the tree that already existed when this
      // one was created: that process is the parent.
      const holder = byPid.get(entry.parentPid)
      if (
        holder &&
        !live.has(holder.pid) &&
        holder.createdAtUs !== null &&
        holder.createdAtUs <= createdAtUs
      )
        continue
      const identities = members.get(entry.pid) ?? []
      if (!identities.some((member) => member.createdAtUs === createdAtUs))
        identities.push({ createdAtUs, notBeforeUs: createdAtUs, notAfterUs: createdAtUs })
      members.set(entry.pid, identities)
      live.set(entry.pid, entry)
      grew = true
    }
  }
  return [...live.values()].filter((entry) => !protectedPids.has(entry.pid) && entry.pid > 4)
}

/**
 * Kills the tree of `rootPid` as `taskkill /PID <root> /T /F` does today (immediately), then
 * sweeps the process table until no member of the tree is alive or the deadline passes.
 */
export async function stopWindowsProcessTree(
  rootPid: number,
  options: WindowsProcessTreeStopOptions
): Promise<WindowsProcessTreeStopReport> {
  const root = windowsPidArgument(rootPid)
  const spawnProcess = options.spawnProcess ?? (spawn as unknown as WindowsProcessSpawn)
  const snapshot =
    options.snapshot ?? createWindowsPowerShellSnapshot(spawnProcess, options.systemRoot)
  const now = options.now ?? Date.now
  const startedAt = now()
  const deadline = startedAt + (options.deadlineMs ?? WINDOWS_TREE_SWEEP_DEADLINE_MS)
  const protectedPids = new Set(options.protectedPids ?? [process.pid, process.ppid])
  const snapshotTimeout = () =>
    Math.min(MAX_SNAPSHOT_TIMEOUT_MS, Math.max(MIN_SNAPSHOT_TIMEOUT_MS, deadline - now()))
  const takeSnapshot = () => snapshot(snapshotTimeout()).catch(() => undefined)

  // First kill: today's command, with no delay before it.
  const initialKill = runTaskkill(
    spawnProcess,
    options.systemRoot,
    ['/PID', root, '/T', '/F'],
    options.initialKillTimeoutMs ?? INITIAL_KILL_TIMEOUT_MS
  )
  // Started in parallel; it may still see members that the taskkill has not reached yet.
  let pending = takeSnapshot()
  const initial = await initialKill
  if (initial.failed || initial.timedOut || initial.exitCode !== 0) options.onInitialKillFailed?.()

  const members: WindowsTreeMembers = new Map([
    [
      rootPid,
      [
        {
          createdAtUs: null,
          notBeforeUs: options.rootCreatedNotBeforeMs * 1000 - ROOT_CREATION_SKEW_US,
          notAfterUs: startedAt * 1000
        }
      ]
    ]
  ])
  let snapshots = 0
  let swept = 0
  const report = (confirmed: boolean, outcome: WindowsProcessTreeStopOutcome) =>
    Object.freeze({ confirmed, outcome, initialKill: Object.freeze(initial), snapshots, swept })
  for (;;) {
    const table = await pending
    if (!table) return report(false, now() >= deadline ? 'deadline' : 'snapshot-unavailable')
    snapshots += 1
    const live = collectLiveTreeMembers(table, members, protectedPids)
    if (!live.length) return report(true, 'converged')
    if (now() >= deadline) return report(false, 'deadline')
    for (let index = 0; index < live.length; index += MAX_PIDS_PER_TASKKILL) {
      const args = live
        .slice(index, index + MAX_PIDS_PER_TASKKILL)
        .flatMap((entry) => ['/PID', windowsPidArgument(entry.pid)])
      // Exit codes are not trusted here: the next snapshot decides.
      await runTaskkill(
        spawnProcess,
        options.systemRoot,
        [...args, '/F'],
        Math.max(500, deadline - now())
      )
    }
    swept += live.length
    if (now() >= deadline) return report(false, 'deadline')
    pending = takeSnapshot()
  }
}
