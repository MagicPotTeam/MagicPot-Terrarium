import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import path from 'node:path'

/**
 * Stopping a process tree on Windows without a Job Object: a best effort, not a guarantee.
 *
 * `taskkill /PID <root> /T /F` enumerates the tree once. A process the tree creates between that
 * enumeration and the death of its parent is not killed and keeps running. This module keeps the
 * immediate taskkill (no added delay before the first kill) and then sweeps: it takes snapshots of
 * the process table (pid, parent pid, creation time), kills every live process whose parent is a
 * recorded member of the tree, remembers every member it has seen (after a kill the links of the
 * tree point at dead pids) and repeats until one snapshot shows no such process, bounded by a
 * deadline.
 *
 * WHAT THE SWEEP REACHES: live processes linked by parent pid to the root, or to a member that a
 * snapshot saw alive. That covers the leaves a still-growing root creates while taskkill runs
 * (their parent is the root; with a single taskkill 7 or 8 of them survived in 6 of 6 runs on
 * Windows 11).
 *
 * WHAT IT CANNOT REACH (only the Job Object helper closes these cases):
 * - an orphan: a descendant whose parent exited before the stop. Windows keeps no link from a
 *   process to its grandparent, the dead parent was never recorded, so nothing ties the orphan to
 *   the tree. It survives the taskkill (5 of 5 runs on Windows 11) and the sweep cannot find it.
 * - a process created by a member below the root while the first taskkill runs, when that member
 *   is dead before any snapshot saw it. The first snapshot needs a PowerShell start (0.5 to 1.5 s)
 *   and may not delay the first kill (about 250 ms), so in practice members below the root are
 *   rarely recorded.
 * So `confirmed` / 'converged' means "no live process linked to the tree was found", never "no
 * process of the tree is running".
 *
 * WHAT IT MUST NOT KILL: a process outside the tree whose parent pid merely equals the pid of a
 * dead member (pids are reused). A child is accepted only when it was created inside the lifetime
 * of its claimed parent: not before the parent was created and not after the parent was dead.
 * The snapshot started in parallel with the first kill only records members and never decides a
 * kill: what it shows alive is, most of the time, killed by that first kill a moment later.
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

export type WindowsProcessTreeStopOutcome =
  | 'converged'
  | 'snapshot-unavailable'
  | 'deadline'
  /** A live process linked to the tree holds a protected pid (or a system pid): never killed. */
  | 'protected-member'

export type WindowsProcessTreeStopReport = Readonly<{
  /**
   * One snapshot started after the last kill showed no live process linked by parent pid to the
   * root or to a member a snapshot saw alive. It does NOT prove that nothing of the tree runs:
   * orphans (their parent exited before the stop) and children of members that were never
   * recorded are out of reach without a Job Object (see the module comment).
   */
  confirmed: boolean
  outcome: WindowsProcessTreeStopOutcome
  /**
   * The immediate `taskkill /PID <root> /T /F`. `skipped`: the root had already exited, so no
   * taskkill was aimed at its pid (exitCode stays null).
   */
  initialKill: Readonly<{
    exitCode: number | null
    failed: boolean
    timedOut: boolean
    skipped: boolean
  }>
  /** Snapshots evaluated. */
  snapshots: number
  /** Processes the sweep killed after the initial taskkill. */
  swept: number
}>

export type WindowsProcessTreeStopOptions = Readonly<{
  /** Date.now() read before the root was spawned: the root cannot have been created earlier. */
  rootCreatedNotBeforeMs: number
  /**
   * Date.now() of the root's 'exit' event when the root had already exited before the stop (a
   * descendant may keep its pipes open, so the run is still pending). Whatever holds the root's
   * pid by now is a stranger, so no taskkill is aimed at that pid (it could only fail, or kill
   * the stranger and its whole tree), and a process created after the exit is not the root's
   * child, whatever its parent pid says. The sweep still kills the children the root left behind.
   */
  rootExitedAtMs?: number
  /**
   * Read on every round: Date.now() of the root's 'exit' event once it has been seen, else
   * undefined. Node keeps the process handle open until that event, so the root's pid cannot be
   * reused before it: the event dates the root's death exactly, also when the initial taskkill
   * exited non-zero.
   */
  rootExitObservedAtMs?: () => number | undefined
  spawnProcess?: WindowsProcessSpawn
  /** Defaults to the PowerShell / CIM snapshot started through `spawnProcess`. */
  snapshot?: WindowsProcessSnapshotProvider
  now?: () => number
  /** Bound of the whole sweep, about 5 s. */
  deadlineMs?: number
  /** Bound of the initial taskkill. */
  initialKillTimeoutMs?: number
  systemRoot?: string
  /**
   * Called as soon as the initial taskkill fails, exits non-zero or was skipped (today's
   * fallback hook).
   */
  onInitialKillFailed?: () => void
  /**
   * Never killed, whatever a snapshot says (defaults to this process and its parent), as long as
   * the process holding the pid is older than the root: a holder created after the root was
   * spawned cannot be this process or its parent (the parent pid may be dead and reused).
   */
  protectedPids?: readonly number[]
}>

export const WINDOWS_TREE_SWEEP_DEADLINE_MS = 5_000
const INITIAL_KILL_TIMEOUT_MS = 3_000
const MIN_SNAPSHOT_TIMEOUT_MS = 1_500
const MAX_SNAPSHOT_TIMEOUT_MS = 4_000
const MAX_PIDS_PER_TASKKILL = 32
/** taskkill's exit code when a pid is not found: its holder was gone at that moment. */
const TASKKILL_NOT_FOUND = 128
/** Second bound of the sweep, for a clock that does not advance: rounds of snapshot and kill. */
const MAX_SWEEP_ROUNDS = 64
/** Bound of the last kill of known live members when the deadline has already passed. */
const FINAL_KILL_TIMEOUT_MS = 1_000
/**
 * Windows stamps a process with the system time (possibly in about 16 ms steps) while Date.now()
 * follows its own interpolated clock, so a creation time may look slightly earlier or later than
 * a Date.now() read around the same event. Every comparison between the two allows this much.
 */
const CLOCK_SKEW_US = 250_000
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

/**
 * A constant script: no value from the caller, the workspace or a process is interpolated.
 * - The query names the three properties it needs, so WMI does not build the expensive ones
 *   (command line, executable path) of every process.
 * - It uses only cmdlets, operators and casts to core types (string, long, DateTime methods), so
 *   it also runs under PowerShell Constrained Language Mode (WDAC / AppLocker PCs), where calls
 *   such as [Console]::Out.Write are refused.
 * - The JSON is built from integers only and written as plain pipeline output, one short row per
 *   line, so no host line wrapping can split a number.
 */
const SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$rows = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process' | ForEach-Object {",
  "  $created = ''",
  '  if ($null -ne $_.CreationDate) { $created = [string]$_.CreationDate.ToFileTimeUtc() }',
  `  '{"p":' + [string][long]$_.ProcessId + ',"q":' + [string][long]$_.ParentProcessId + ',"c":"' + $created + '"}'`,
  '})',
  "'[' + ($rows -join \",`n\") + ']'"
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

type Member = {
  createdAtUs: number | null
  notBeforeUs: number
  notAfterUs: number
  /**
   * The moment by which this member was dead: the upper bound for the creation of its children.
   * Set when a snapshot first lacks the member (to the earlier of that snapshot's arrival and a
   * successful kill), or by the caller for a root that had exited before the stop.
   */
  deadByUs?: number
  /** Completion time of a kill of this pid that reported success. */
  killedAtUs?: number
}
/** Every identity ever recorded for a pid: a pid may be reused inside the tree, too. */
export type WindowsTreeMembers = Map<number, Member[]>

/** When a snapshot was requested and when its answer arrived (microseconds, caller's clock). */
export type WindowsSnapshotWindow = Readonly<{ startedAtUs: number; observedAtUs: number }>

const memberLowerBound = (member: Member): number => member.createdAtUs ?? member.notBeforeUs

/**
 * Adds every live process whose parent is a recorded member to `members` and returns the live
 * members that may be killed. `window` dates the snapshot: a member the table lacks was dead when
 * the answer arrived, and a member it shows alive survived every kill that had completed before
 * the snapshot was requested. Exported for tests.
 */
export function collectLiveTreeMembers(
  table: readonly WindowsProcessEntry[],
  members: WindowsTreeMembers,
  protectedPids: ReadonlySet<number> | ((entry: WindowsProcessEntry) => boolean),
  window?: WindowsSnapshotWindow,
  /** Receives the live members that are never killed (protected or system pids). */
  withheld?: WindowsProcessEntry[]
): WindowsProcessEntry[] {
  const isProtected =
    typeof protectedPids === 'function'
      ? protectedPids
      : (entry: WindowsProcessEntry) => protectedPids.has(entry.pid)
  const byPid = new Map(table.map((entry) => [entry.pid, entry]))
  const identifies = (member: Member, entry: WindowsProcessEntry): boolean => {
    if (entry.createdAtUs === null) return false
    if (member.createdAtUs !== null) return entry.createdAtUs === member.createdAtUs
    // The root: only its pid and the window in which it was created are known.
    return entry.createdAtUs >= member.notBeforeUs && entry.createdAtUs <= member.notAfterUs
  }
  const live = new Map<number, WindowsProcessEntry>()
  const liveMembers = new Set<Member>()
  for (const entry of table) {
    const member = members.get(entry.pid)?.find((candidate) => identifies(candidate, entry))
    if (!member) continue
    member.createdAtUs = entry.createdAtUs
    // Alive although a kill had completed before this snapshot was requested: that kill missed.
    if (window && member.killedAtUs !== undefined && member.killedAtUs <= window.startedAtUs)
      delete member.killedAtUs
    liveMembers.add(member)
    live.set(entry.pid, entry)
  }
  // A member this table lacks is dead: from now on it can no longer become a parent.
  if (window)
    for (const identities of members.values())
      for (const member of identities)
        if (!liveMembers.has(member) && member.deadByUs === undefined)
          member.deadByUs = Math.min(member.killedAtUs ?? Infinity, window.observedAtUs)
  let grew = true
  while (grew) {
    grew = false
    for (const entry of table) {
      const createdAtUs = entry.createdAtUs
      if (live.has(entry.pid) || createdAtUs === null || entry.pid === entry.parentPid) continue
      // A child is created inside the lifetime of its parent. Created before its claimed parent,
      // or after that parent was dead: the parent pid was reused, this is somebody else's child.
      const parents = members
        .get(entry.parentPid)
        ?.filter(
          (member) =>
            createdAtUs >= memberLowerBound(member) &&
            (member.deadByUs === undefined || createdAtUs <= member.deadByUs + CLOCK_SKEW_US)
        )
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
  const killable: WindowsProcessEntry[] = []
  for (const entry of live.values()) {
    if (!isProtected(entry) && entry.pid > 4) killable.push(entry)
    else withheld?.push(entry)
  }
  return killable
}

/**
 * Kills the tree of `rootPid` as `taskkill /PID <root> /T /F` does today (immediately), then
 * sweeps the process table until no live process linked to the tree is found or the deadline
 * passes. See the module comment for what this reaches and what it cannot reach.
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
  const protectedPidSet = new Set(options.protectedPids ?? [process.pid, process.ppid])
  const snapshotTimeout = () =>
    Math.min(MAX_SNAPSHOT_TIMEOUT_MS, Math.max(MIN_SNAPSHOT_TIMEOUT_MS, deadline - now()))
  const takeSnapshot = async () => {
    const startedAtUs = now() * 1000
    try {
      const table = await snapshot(snapshotTimeout())
      return table ? { table, window: { startedAtUs, observedAtUs: now() * 1000 } } : undefined
    } catch {
      return undefined
    }
  }

  const rootExitedAtUs =
    options.rootExitedAtMs === undefined ? undefined : options.rootExitedAtMs * 1000
  // First kill: today's command, with no delay before it. Not for a root that has already
  // exited: its pid may belong to a stranger by now.
  const initialKill: Promise<KillResult> =
    rootExitedAtUs === undefined
      ? runTaskkill(
          spawnProcess,
          options.systemRoot,
          ['/PID', root, '/T', '/F'],
          options.initialKillTimeoutMs ?? INITIAL_KILL_TIMEOUT_MS
        )
      : Promise.resolve({ exitCode: null, failed: false, timedOut: false })
  // Started in parallel so that it does not delay the kill. It may still see members that the
  // taskkill has not reached yet, so it only RECORDS members and never decides a kill: by the
  // time its answer arrives the first kill has usually ended the processes it shows, and their
  // pids may already belong to somebody else.
  const early = takeSnapshot()
  const initial = { ...(await initialKill), skipped: rootExitedAtUs !== undefined }
  const initialKillDoneUs = now() * 1000
  if (initial.failed || initial.timedOut || initial.exitCode !== 0) options.onInitialKillFailed?.()

  const rootMember: Member = {
    createdAtUs: null,
    notBeforeUs: options.rootCreatedNotBeforeMs * 1000 - CLOCK_SKEW_US,
    notAfterUs:
      rootExitedAtUs !== undefined
        ? // The root has exited: whatever holds its pid now is not the root.
          -Infinity
        : startedAt * 1000,
    ...(rootExitedAtUs === undefined ? {} : { deadByUs: rootExitedAtUs }),
    // Exit code 0: taskkill terminated the root (and what it had enumerated below it).
    ...(initial.exitCode === 0 ? { killedAtUs: initialKillDoneUs } : {})
  }
  const members: WindowsTreeMembers = new Map([[rootPid, [rootMember]]])
  // Protection by identity: this process and its parent were created before the root.
  const protectedPids = (entry: WindowsProcessEntry): boolean =>
    protectedPidSet.has(entry.pid) &&
    (entry.createdAtUs === null || entry.createdAtUs < rootMember.notBeforeUs)
  const applyRootExit = () => {
    const exitedAtMs = options.rootExitObservedAtMs?.()
    if (exitedAtMs === undefined) return
    const exitedAtUs = exitedAtMs * 1000
    if (rootMember.deadByUs === undefined || exitedAtUs < rootMember.deadByUs)
      rootMember.deadByUs = exitedAtUs
  }
  let snapshots = 0
  let swept = 0
  const report = (confirmed: boolean, outcome: WindowsProcessTreeStopOutcome) =>
    Object.freeze({ confirmed, outcome, initialKill: Object.freeze(initial), snapshots, swept })
  // A kill that succeeded, or that found no such pid, proves the member was dead by now: the
  // upper bound for the creation of its children. Any other answer leaves the bound open.
  const dateDeath = (entry: WindowsProcessEntry, result: KillResult) => {
    const member = members
      .get(entry.pid)
      ?.find((candidate) => candidate.createdAtUs === entry.createdAtUs)
    if (!member) return
    const atUs = now() * 1000
    if (result.exitCode === 0) member.killedAtUs = atUs
    else if (result.exitCode === TASKKILL_NOT_FOUND && member.deadByUs === undefined)
      member.deadByUs = atUs
  }
  const kill = async (live: readonly WindowsProcessEntry[], timeoutMs: () => number) => {
    for (let index = 0; index < live.length; index += MAX_PIDS_PER_TASKKILL) {
      const batch = live.slice(index, index + MAX_PIDS_PER_TASKKILL)
      const args = batch.flatMap((entry) => ['/PID', windowsPidArgument(entry.pid)])
      // Whether a member is gone is decided by the next snapshot, not by this exit code; a
      // success only dates the death (the upper bound for the member's children).
      const result = await runTaskkill(
        spawnProcess,
        options.systemRoot,
        [...args, '/F'],
        timeoutMs()
      )
      if (result.exitCode === 0) {
        for (const entry of batch) dateDeath(entry, result)
        continue
      }
      // Non-zero: at least one pid of the batch failed (often one that exited by itself after
      // the snapshot). Without a per-pid answer no member's death would be dated until the next
      // snapshot arrives, which would stretch the window in which a reused pid's child is taken
      // for a member's child. Kill one pid per taskkill so each answer dates its own pid.
      if (batch.length === 1) {
        dateDeath(batch[0], result)
        continue
      }
      for (const entry of batch) {
        const single = await runTaskkill(
          spawnProcess,
          options.systemRoot,
          ['/PID', windowsPidArgument(entry.pid), '/F'],
          timeoutMs()
        )
        dateDeath(entry, single)
      }
    }
    swept += live.length
  }

  // Requested after the first kill has completed: the first snapshot that may decide a kill.
  let pending = takeSnapshot()
  let recordOnly: typeof early | undefined = early
  for (let round = 1; ; round += 1) {
    const shot = await pending
    if (recordOnly) {
      // Used only when its answer is already there: it must not hold up the deciding snapshot.
      const recorded = await Promise.race([recordOnly, undefined])
      recordOnly = undefined
      if (recorded) {
        snapshots += 1
        applyRootExit()
        collectLiveTreeMembers(recorded.table, members, protectedPids, recorded.window)
      }
    }
    if (!shot) return report(false, now() >= deadline ? 'deadline' : 'snapshot-unavailable')
    snapshots += 1
    applyRootExit()
    const withheld: WindowsProcessEntry[] = []
    const live = collectLiveTreeMembers(shot.table, members, protectedPids, shot.window, withheld)
    // A live linked process that may not be killed: never report the stop as confirmed.
    if (!live.length) return withheld.length ? report(false, 'protected-member') : report(true, 'converged')
    if (now() >= deadline || round >= MAX_SWEEP_ROUNDS) {
      // Out of time with members known to be alive: kill them once more, then report honestly.
      await kill(live, () => FINAL_KILL_TIMEOUT_MS)
      return report(false, 'deadline')
    }
    await kill(live, () => Math.max(500, deadline - now()))
    if (now() >= deadline) return report(false, 'deadline')
    pending = takeSnapshot()
  }
}
