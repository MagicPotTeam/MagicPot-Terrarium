import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  collectLiveTreeMembers,
  createWindowsPowerShellSnapshot,
  parseWindowsProcessSnapshot,
  stopWindowsProcessTree,
  WINDOWS_PROCESS_SNAPSHOT_ARGS,
  windowsPidArgument,
  type WindowsProcessEntry,
  type WindowsProcessSpawn,
  type WindowsTreeMembers
} from './windowsProcessTree'

const T0 = 1_700_000_000_000
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n
const filetime = (ms: number) => String(BigInt(Math.round(ms * 10_000)) + FILETIME_UNIX_EPOCH)
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

class FakeProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  killed = 0
  constructor(readonly pid: number) {
    super()
  }
  kill(): boolean {
    this.killed += 1
    return true
  }
}

type Proc = { pid: number; ppid: number; createdMs: number; alive: boolean }

/**
 * A fake Windows: a process table, `taskkill` (with /T it enumerates the tree once, then the race
 * hook may let members create processes, then the enumerated processes die) and the PowerShell
 * snapshot answering JSON from the table.
 */
class FakeWindows {
  readonly table = new Map<number, Proc>()
  readonly calls: { file: string; args: string[]; options: SpawnOptions }[] = []
  /** Runs inside a taskkill between its enumeration and the kills. */
  onKill?: (enumerated: number[], call: number) => void
  powershell: 'answer' | 'missing' | 'garbage' | 'silent' = 'answer'
  taskkillExitCode?: number
  private killerPid = 9000
  private kills = 0

  add(pid: number, ppid: number, createdMs: number): void {
    this.table.set(pid, { pid, ppid, createdMs, alive: true })
  }
  alive(pid: number): boolean {
    return this.table.get(pid)?.alive === true
  }
  entries(): WindowsProcessEntry[] {
    return [...this.table.values()]
      .filter((proc) => proc.alive)
      .map((proc) => ({ pid: proc.pid, parentPid: proc.ppid, createdAtUs: proc.createdMs * 1000 }))
  }
  readonly spawn: WindowsProcessSpawn = (file, args, options) => {
    this.calls.push({ file, args: [...args], options })
    const child = new FakeProcess(this.killerPid++)
    if (file === TASKKILL) {
      queueMicrotask(() => {
        const pids: number[] = []
        args.forEach((arg, index) => {
          if (arg === '/PID') pids.push(Number(args[index + 1]))
        })
        const missing = pids.some((pid) => !this.alive(pid))
        const enumerated = new Set(pids.filter((pid) => this.alive(pid)))
        if (args.includes('/T')) {
          let grew = true
          while (grew) {
            grew = false
            for (const proc of this.table.values())
              if (proc.alive && enumerated.has(proc.ppid) && !enumerated.has(proc.pid)) {
                enumerated.add(proc.pid)
                grew = true
              }
          }
        }
        this.onKill?.([...enumerated], this.kills++)
        for (const pid of enumerated) this.table.get(pid)!.alive = false
        child.emit('close', this.taskkillExitCode ?? (missing ? 128 : 0), null)
      })
    } else if (file === POWERSHELL) {
      queueMicrotask(() => {
        if (this.powershell === 'missing') {
          child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
          return
        }
        if (this.powershell === 'silent') return
        const rows = [...this.table.values()]
          .filter((proc) => proc.alive)
          .map((proc) => ({ p: proc.pid, q: proc.ppid, c: filetime(proc.createdMs) }))
        child.stdout.write(this.powershell === 'garbage' ? 'not json' : JSON.stringify(rows))
        child.stdout.end()
        child.emit('close', 0, null)
      })
    } else {
      throw new Error(`unexpected spawn ${file}`)
    }
    return child as unknown as ChildProcess
  }
}

const fakeClock = (start = T0 + 1000) => {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    }
  }
}

const stopOptions = (os: FakeWindows, now: () => number) => ({
  rootCreatedNotBeforeMs: T0,
  spawnProcess: os.spawn,
  systemRoot: 'C:\\Windows',
  now,
  protectedPids: [1]
})

describe('stopWindowsProcessTree', () => {
  it('kills immediately, then sweeps a grandchild born after the first kill and another born after the second', async () => {
    const os = new FakeWindows()
    os.add(1, 0, T0 - 10_000) // unrelated
    os.add(100, 1, T0 + 10) // root
    os.add(101, 100, T0 + 20)
    os.add(300, 1, T0 + 30) // unrelated, alive throughout
    os.onKill = (enumerated, call) => {
      // The root forks while taskkill runs: its new child was not enumerated.
      if (call === 0) os.add(102, 100, T0 + 500)
      // The swept grandchild forks while it is being killed.
      if (call === 1 && enumerated.includes(102)) os.add(103, 102, T0 + 900)
    }
    const clock = fakeClock()
    const report = await stopWindowsProcessTree(100, stopOptions(os, clock.now))

    expect(os.calls[0]).toEqual({
      file: TASKKILL,
      args: ['/PID', '100', '/T', '/F'],
      options: { shell: false, windowsHide: true, stdio: 'ignore' }
    })
    expect(os.calls[1].file).toBe(POWERSHELL)
    expect(report).toMatchObject({
      confirmed: true,
      outcome: 'converged',
      initialKill: { exitCode: 0, failed: false, timedOut: false },
      snapshots: 3,
      swept: 2
    })
    for (const pid of [100, 101, 102, 103]) expect(os.alive(pid), `pid ${pid}`).toBe(false)
    expect(os.alive(1)).toBe(true)
    expect(os.alive(300)).toBe(true)
    const killed = os.calls.filter((call) => call.file === TASKKILL).map((call) => call.args)
    expect(killed).toEqual([
      ['/PID', '100', '/T', '/F'],
      ['/PID', '102', '/F'],
      ['/PID', '103', '/F']
    ])
  })

  it('never kills a process created before its claimed parent (pid reuse)', async () => {
    const os = new FakeWindows()
    os.add(1, 0, T0 - 10_000)
    // An old orphan whose dead parent once had pid 102, the pid the root's new child gets.
    os.add(200, 102, T0 - 5_000)
    os.add(100, 1, T0 + 10)
    os.onKill = (_enumerated, call) => {
      if (call === 0) os.add(102, 100, T0 + 500)
    }
    const clock = fakeClock()
    const report = await stopWindowsProcessTree(100, stopOptions(os, clock.now))
    expect(report.confirmed).toBe(true)
    expect(os.alive(200)).toBe(true)
    expect(os.alive(102)).toBe(false)
    expect(os.calls.flatMap((call) => call.args)).not.toContain('200')
  })

  it('ends at the deadline and reports a sweep that never converges', async () => {
    const os = new FakeWindows()
    os.add(1, 0, T0 - 10_000)
    os.add(100, 1, T0 + 10)
    const clock = fakeClock()
    let next = 500
    // Every kill lets each enumerated member create one more child first.
    os.onKill = (enumerated) => {
      for (const pid of enumerated) {
        next += 1
        os.add(next, pid, clock.now())
      }
      clock.advance(400)
    }
    const report = await stopWindowsProcessTree(100, {
      ...stopOptions(os, clock.now),
      deadlineMs: 5_000
    })
    expect(report).toMatchObject({ confirmed: false, outcome: 'deadline' })
    expect(report.snapshots).toBeGreaterThan(1)
    expect(clock.now()).toBeGreaterThanOrEqual(T0 + 1000 + 5_000)
    expect(clock.now()).toBeLessThan(T0 + 1000 + 7_000)
  })

  it('passes only integers and fixed flags to any command line', async () => {
    const os = new FakeWindows()
    os.add(1, 0, T0 - 10_000)
    os.add(100, 1, T0 + 10)
    os.onKill = (_enumerated, call) => {
      if (call === 0) for (let pid = 110; pid < 150; pid += 1) os.add(pid, 100, T0 + pid)
    }
    const clock = fakeClock()
    await stopWindowsProcessTree(100, stopOptions(os, clock.now))
    for (const call of os.calls) {
      if (call.file === TASKKILL) {
        for (const arg of call.args) expect(arg).toMatch(/^(?:\/PID|\/T|\/F|[1-9][0-9]*)$/)
      } else {
        expect(call.file).toBe(POWERSHELL)
        expect(call.args).toEqual(WINDOWS_PROCESS_SNAPSHOT_ARGS)
      }
      expect(call.options.shell).toBe(false)
    }
    // 40 survivors are killed in batches of at most 32 pids.
    const sweepKills = os.calls.filter((call) => call.file === TASKKILL).slice(1)
    expect(sweepKills.map((call) => call.args.filter((arg) => arg === '/PID').length)).toEqual([
      32, 8
    ])
    expect(() => windowsPidArgument(1.5)).toThrow()
    expect(() => windowsPidArgument(-1)).toThrow()
    expect(() => windowsPidArgument(Number.NaN)).toThrow()
    expect(() => windowsPidArgument('1 & calc' as unknown as number)).toThrow()
  })

  it.each(['missing', 'garbage'] as const)(
    'keeps the immediate taskkill and reports the stop unconfirmed when PowerShell is %s',
    async (mode) => {
      const os = new FakeWindows()
      os.powershell = mode
      os.add(100, 1, T0 + 10)
      os.onKill = (_enumerated, call) => {
        if (call === 0) os.add(102, 100, T0 + 500)
      }
      const clock = fakeClock()
      const report = await stopWindowsProcessTree(100, stopOptions(os, clock.now))
      expect(os.calls[0].args).toEqual(['/PID', '100', '/T', '/F'])
      expect(report).toMatchObject({
        confirmed: false,
        outcome: 'snapshot-unavailable',
        initialKill: { exitCode: 0 }
      })
      expect(os.alive(100)).toBe(false)
    }
  )

  it("calls today's fallback as soon as the initial taskkill fails", async () => {
    const os = new FakeWindows()
    os.add(100, 1, T0 + 10)
    os.taskkillExitCode = 1
    const onInitialKillFailed = vi.fn()
    const clock = fakeClock()
    const report = await stopWindowsProcessTree(100, {
      ...stopOptions(os, clock.now),
      onInitialKillFailed
    })
    expect(onInitialKillFailed).toHaveBeenCalledTimes(1)
    expect(report.initialKill.exitCode).toBe(1)

    const throwing = (() => {
      throw new Error('spawn EPERM')
    }) as unknown as WindowsProcessSpawn
    const failed = vi.fn()
    const unavailable = await stopWindowsProcessTree(100, {
      rootCreatedNotBeforeMs: T0,
      spawnProcess: throwing,
      onInitialKillFailed: failed
    })
    expect(failed).toHaveBeenCalledTimes(1)
    expect(unavailable).toMatchObject({
      confirmed: false,
      outcome: 'snapshot-unavailable',
      initialKill: { failed: true }
    })
  })

  it('never kills a protected pid, even when a snapshot claims it descends from the tree', async () => {
    const os = new FakeWindows()
    os.add(100, 1, T0 + 10)
    os.onKill = (_enumerated, call) => {
      if (call === 0) {
        os.add(4242, 100, T0 + 500)
        os.add(4243, 100, T0 + 500)
      }
    }
    const clock = fakeClock()
    await stopWindowsProcessTree(100, { ...stopOptions(os, clock.now), protectedPids: [4242] })
    expect(os.alive(4242)).toBe(true)
    expect(os.alive(4243)).toBe(false)
  })
})

describe('collectLiveTreeMembers', () => {
  const entry = (pid: number, parentPid: number, ms: number | null): WindowsProcessEntry => ({
    pid,
    parentPid,
    createdAtUs: ms === null ? null : ms * 1000
  })
  const rootMembers = (): WindowsTreeMembers =>
    new Map([
      [100, [{ createdAtUs: null, notBeforeUs: T0 * 1000, notAfterUs: (T0 + 1000) * 1000 }]]
    ])

  it('follows dead members, refuses a reused parent pid and keeps identities per creation time', () => {
    const members = rootMembers()
    // Round 1: the root is dead, its child 102 is alive and has a child of its own.
    let live = collectLiveTreeMembers(
      [entry(102, 100, T0 + 500), entry(103, 102, T0 + 600), entry(200, 100, T0 - 1)],
      members,
      new Set()
    )
    expect(live.map((item) => item.pid).sort()).toEqual([102, 103])
    // Round 2: 102 died and its pid now belongs to an unrelated process (created later) whose own
    // child must stay; an orphan of the old 102 created before the new holder is still swept.
    live = collectLiveTreeMembers(
      [entry(102, 1, T0 + 2000), entry(104, 102, T0 + 2100), entry(105, 102, T0 + 700)],
      members,
      new Set()
    )
    expect(live.map((item) => item.pid)).toEqual([105])
    // The root pid reused after the kill started is not the root.
    live = collectLiveTreeMembers([entry(100, 1, T0 + 5000)], members, new Set())
    expect(live).toEqual([])
    // Unknown creation times are never adopted.
    expect(collectLiveTreeMembers([entry(106, 103, null)], members, new Set())).toEqual([])
  })

  it('recognizes the root while it is still alive in a snapshot taken in parallel with the kill', () => {
    const members = rootMembers()
    const live = collectLiveTreeMembers(
      [entry(100, 1, T0 + 10), entry(101, 100, T0 + 20)],
      members,
      new Set()
    )
    expect(live.map((item) => item.pid)).toEqual([100, 101])
    expect(members.get(100)?.[0].createdAtUs).toBe((T0 + 10) * 1000)
  })
})

describe('Windows process snapshot', () => {
  it('parses the PowerShell JSON strictly', () => {
    expect(
      parseWindowsProcessSnapshot(
        `[{"p":0,"q":0,"c":""},{"p":4,"q":0,"c":"${filetime(T0)}"},{"p":4242,"q":4,"c":"${filetime(T0 + 1.5)}"}]\r\n`
      )
    ).toEqual([
      { pid: 0, parentPid: 0, createdAtUs: null },
      { pid: 4, parentPid: 0, createdAtUs: T0 * 1000 },
      { pid: 4242, parentPid: 4, createdAtUs: T0 * 1000 + 1500 }
    ])
    expect(parseWindowsProcessSnapshot('[]')).toEqual([])
    for (const invalid of [
      '',
      'null',
      '{"p":1,"q":0,"c":""}',
      '[{"p":1,"q":0}]',
      '[{"p":1,"q":0,"c":"","x":1}]',
      '[{"p":"1","q":0,"c":""}]',
      '[{"p":1.5,"q":0,"c":""}]',
      '[{"p":-1,"q":0,"c":""}]',
      '[{"p":4294967296,"q":0,"c":""}]',
      '[{"p":1,"q":0,"c":"12a"}]',
      '[{"p":1,"q":0,"c":5}]',
      '[{"p":1,"q":0,"c":"1"}]',
      '[{"p":1,"q":0,"c":""},{"p":1,"q":0,"c":""}]',
      '[null]',
      '[[1,0,""]]'
    ])
      expect(parseWindowsProcessSnapshot(invalid), invalid).toBeUndefined()
  })

  it('runs a constant script from the fixed System32 PowerShell, never PATH', async () => {
    const os = new FakeWindows()
    os.add(7, 1, T0)
    const table = await createWindowsPowerShellSnapshot(os.spawn, 'C:\\Windows')(1000)
    expect(table).toEqual([{ pid: 7, parentPid: 1, createdAtUs: T0 * 1000 }])
    expect(os.calls).toEqual([
      {
        file: POWERSHELL,
        args: [...WINDOWS_PROCESS_SNAPSHOT_ARGS],
        options: { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      }
    ])
    const script = Buffer.from(WINDOWS_PROCESS_SNAPSHOT_ARGS[4], 'base64').toString('utf16le')
    expect(script).toContain('Get-CimInstance -ClassName Win32_Process')
    expect(script).toContain('ToFileTimeUtc()')
    expect(WINDOWS_PROCESS_SNAPSHOT_ARGS.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand'
    ])
  })

  it('gives up on a PowerShell that does not answer in time and stops it', async () => {
    const os = new FakeWindows()
    os.powershell = 'silent'
    const children: FakeProcess[] = []
    const spawn: WindowsProcessSpawn = (file, args, options) => {
      const child = os.spawn(file, args, options)
      children.push(child as unknown as FakeProcess)
      return child
    }
    await expect(createWindowsPowerShellSnapshot(spawn, 'C:\\Windows')(20)).resolves.toBeUndefined()
    expect(children[0].killed).toBe(1)
  })
})
