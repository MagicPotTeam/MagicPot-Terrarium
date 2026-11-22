import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalPolicyRequest,
  type PolicyConstraints,
  type PolicyRule
} from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService, PermitConsumedError } from '../policy'
import {
  TerminalRunAuthorizationError,
  TerminalRunToolHost,
  TerminalRunValidationError,
  type TerminalRunAuditEvidence
} from '.'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

// Several tests here stop a real process. On win32 without the Job Object helper a stop is
// reported only after the process-table sweep (PowerShell snapshots, about 1 to 3 s, bounded at
// about 5 s), which does not fit vitest's default budget of 5 s per test on a slow PC.
vi.setConfig({ testTimeout: 20_000 })

const actor = { kind: 'agent', id: 'agent-1' } as const
const approver = { kind: 'user', id: 'approver-1' } as const
const command = process.execPath
const roots: string[] = []
const stores: MagicAgentEventStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(effect: PolicyRule['effect'] = 'require-approval', constraints?: PolicyConstraints) {
  const workerId = process.env.VITEST_WORKER_ID ?? '0'
  let root = path.join(
    tmpdir(),
    `magic-tool-host-${process.pid}-${workerId}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(root)
  root = realpathSync.native(root)
  roots.push(root)
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const authorization = new MagicAgentPolicyAuthorizationService({
    store,
    rules: [
      {
        ruleId: 'terminal',
        priority: 1,
        effect,
        explanation: effect,
        ...(effect === 'require-approval'
          ? {
              approvalRequirement: {
                scopeKind: 'request' as const,
                scopeValue: '*',
                maxUses: 1,
                expiresInMs: 60_000,
                reason: 'test approval'
              }
            }
          : {}),
        ...(constraints === undefined ? {} : { constraints })
      }
    ],
    policyVersion: 'policy-1',
    storeId: 'store-1',
    trustedApprovers: [approver]
  })
  return { root, store, authorization }
}

function request(
  root: string,
  args: string[],
  overrides: Partial<{ command: string; cwd: string }> = {}
) {
  return createTerminalPolicyRequest({
    requestId: `request-${Math.random()}`,
    actor,
    target: { kind: 'tool', id: 'terminal.run' },
    command: overrides.command ?? command,
    args,
    cwd: overrides.cwd ?? root,
    filesystem: { cwd: overrides.cwd ?? root, allowedRoots: [root] }
  })
}

function input(
  root: string,
  args: string[],
  authorization?: MagicAgentPolicyAuthorizationService,
  overrides: Partial<{ command: string; cwd: string }> = {}
) {
  const policyRequest = request(root, args, overrides)
  const authorizationId = `authorization-${Math.random()}`
  const result = {
    authorizationId,
    idempotencyKey: `execution-${Math.random()}`,
    request: policyRequest,
    command: overrides.command ?? command,
    args,
    cwd: overrides.cwd ?? root
  }
  if (!authorization) return result
  const now = Date.now()
  authorization.createApprovalGrant({
    grantId: `grant-${authorizationId}`,
    request: policyRequest,
    approvedBy: approver,
    issuedAt: now,
    expiresAt: now + 30_000,
    maxUses: 1,
    idempotencyKey: `grant-${authorizationId}`
  })
  return { ...result, grantId: `grant-${authorizationId}`, expectedGrantUseCount: 0 }
}

// Liveness that ignores zombies. PID 1 of a container may reap reparented
// orphans late (measured 1.4-1.9 s here; on ubuntu-latest CI, PID 1 is systemd
// and reaps promptly), and kill(pid, 0) still succeeds for a zombie although it
// has exited and runs no code. On Linux the state letter after the LAST ')' of
// /proc/<pid>/stat decides (comm may contain ')'): Z or X is not running, any
// other state (R, S, D, T, t, I ...) is. PID reuse can only make a caller that
// expects "not running" fail falsely, never pass falsely.
function processIsRunning(pid: number): boolean {
  if (process.platform === 'linux') {
    let stat: string
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1)
    const state = afterComm.trim().charAt(0)
    return state !== 'Z' && state !== 'X'
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

describe('TerminalRunToolHost', () => {
  it('authorizes and consumes the one-shot permit before process side effects', async () => {
    const { root, authorization } = setup()
    const marker = path.join(root, 'marker.txt')
    const runInput = input(
      root,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      authorization
    )
    const originalConsume = authorization.consumeExecutionPermit.bind(authorization)
    authorization.consumeExecutionPermit = ((consumeInput) => {
      expect(existsSync(marker)).toBe(false)
      const consumed = originalConsume(consumeInput)
      expect(() =>
        originalConsume({ ...consumeInput, idempotencyKey: 'replay-different' })
      ).toThrow(PermitConsumedError)
      return consumed
    }) as typeof authorization.consumeExecutionPermit

    const result = await new TerminalRunToolHost(authorization, {
      allowedRoots: [root],
      allowedCommands: [command]
    }).run(runInput)

    expect(result).toMatchObject({ status: 'completed', exitCode: 0 })
    expect(readFileSync(marker, 'utf8')).toBe('ran')
  })

  it('does not spawn when authorization is denied', async () => {
    const { root, authorization } = setup('deny')
    const marker = path.join(root, 'denied.txt')
    await expect(
      new TerminalRunToolHost(authorization, {
        allowedRoots: [root],
        allowedCommands: [command]
      }).run(
        input(root, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`])
      )
    ).rejects.toBeInstanceOf(TerminalRunAuthorizationError)
    expect(existsSync(marker)).toBe(false)
  })

  it('constrains cwd to canonical allowed roots', async () => {
    const { root, authorization } = setup()
    const outside = path.join(
      tmpdir(),
      `magic-tool-host-outside-${process.pid}-${process.env.VITEST_WORKER_ID ?? '0'}-${Math.random().toString(36).slice(2)}`
    )
    mkdirSync(outside)
    roots.push(outside)
    await expect(
      new TerminalRunToolHost(authorization, {
        allowedRoots: [root],
        allowedCommands: [command]
      }).run(input(outside, ['-e', 'process.stdout.write("bad")'], authorization))
    ).rejects.toThrow('outside Tool Host allowed roots')
  })

  it('enforces command and environment allowlists', async () => {
    const { root, authorization } = setup()
    await expect(
      new TerminalRunToolHost(authorization, {
        allowedRoots: [root],
        allowedCommands: ['definitely-not-node']
      }).run(input(root, ['-e', 'process.stdout.write("bad")'], authorization))
    ).rejects.toThrow('Command is not allowed')

    const second = setup()
    await expect(
      new TerminalRunToolHost(second.authorization, {
        allowedRoots: [second.root],
        allowedCommands: [command],
        allowedEnvironmentKeys: ['SAFE_VALUE']
      }).run({
        ...input(second.root, ['-e', 'process.stdout.write("bad")'], second.authorization),
        env: { SECRET: 'x' }
      })
    ).rejects.toThrow('Environment key is not allowed')
  })

  it('applies Tool Host and policy cwd roots as an intersection', async () => {
    const { root, authorization } = setup('require-approval', { allowedRoots: [tmpdir()] })
    const hostRoot = path.join(root, 'host-root')
    const policyOnly = path.join(root, 'policy-only')
    mkdirSync(hostRoot)
    mkdirSync(policyOnly)
    const host = new TerminalRunToolHost(authorization, { allowedRoots: [hostRoot] })

    await expect(host.run(input(root, [], authorization, { cwd: policyOnly }))).rejects.toThrow(
      'cwd is outside Tool Host allowed roots'
    )
  })

  it('turns spawn failures into failed outcomes and audit evidence', async () => {
    const { root, authorization } = setup()
    const evidence: TerminalRunAuditEvidence[] = []
    const host = new TerminalRunToolHost(authorization, {
      allowedRoots: [root],
      onAudit: (item) => {
        evidence.push(item)
      }
    })

    const result = await host.run(
      input(root, [], authorization, { command: 'definitely-missing-magic-command' })
    )

    expect(result.status).toBe('failed')
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toBeTruthy()
    expect(evidence.at(-1)?.status).toBe('failed')
  })

  it('bounds output and emits content-free audit evidence with digests and counts', async () => {
    const { root, authorization } = setup('require-approval', { maxOutputChars: 40 })
    const evidence: TerminalRunAuditEvidence[] = []
    const args = ['-e', 'process.stdout.write("token=super-secret " + "x".repeat(200))']
    const result = await new TerminalRunToolHost(authorization, {
      allowedRoots: [root],
      allowedCommands: [command],
      onAudit: (item) => {
        evidence.push(item)
      }
    }).run(input(root, args, authorization))

    expect(result.status).toBe('output-limit')
    expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(40)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({
      status: 'output-limit',
      commandChars: command.length,
      argsCount: args.length,
      argsChars: args.reduce((count, arg) => count + arg.length, 0),
      cwdSha256: createHash('sha256').update(root).digest('hex'),
      stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
      stdoutChars: result.stdout.length,
      stderrSha256: createHash('sha256').update(result.stderr).digest('hex'),
      stderrChars: result.stderr.length,
      truncated: true
    })
    expect(Object.keys(evidence[0])).not.toEqual(
      expect.arrayContaining(['command', 'args', 'cwd', 'stdout', 'stderr'])
    )
    expect(JSON.stringify(evidence[0])).not.toMatch(
      /super-secret|token=|process\.stdout|magic-tool-host/
    )
  })

  it('kills execution at the bounded timeout', async () => {
    const { root, authorization } = setup('require-approval', { maxTimeoutMs: 50 })
    const marker = path.join(root, 'late.txt')
    const markerArgument = Buffer.from(marker).toString('base64')
    const result = await new TerminalRunToolHost(authorization, {
      allowedRoots: [root],
      allowedCommands: [command]
    }).run({
      ...input(
        root,
        [
          '-e',
          `setTimeout(() => require('node:fs').writeFileSync(Buffer.from('${markerArgument}', 'base64').toString(), 'late'), 500)`
        ],
        authorization
      ),
      timeoutMs: 5_000
    })

    expect(result.status).toBe('timed-out')
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(existsSync(marker)).toBe(false)
  })

  /**
   * Runs `parent` under a 100 ms bounded timeout that fires (fake setTimeout) exactly when
   * `ready()` first holds, so the moment of the kill does not depend on how fast the machine
   * starts node processes. Returns the settled outcome.
   */
  async function runAndTimeOutOnceReady(
    root: string,
    authorization: MagicAgentPolicyAuthorizationService,
    parent: string,
    ready: () => boolean,
    onAudit?: (evidence: TerminalRunAuditEvidence) => void
  ) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const running = new TerminalRunToolHost(authorization, {
        allowedRoots: [root],
        allowedCommands: [command],
        ...(onAudit ? { onAudit } : {})
      }).run({
        ...input(root, ['-e', parent], authorization),
        timeoutMs: 5_000
      })
      let settled = false
      running.then(
        () => (settled = true),
        () => (settled = true)
      )
      const deadline = Date.now() + 20_000
      while (!settled && !ready()) {
        if (Date.now() > deadline) {
          throw new Error('The test process tree did not start within 20 s.')
        }
        await delay(10)
      }
      vi.advanceTimersByTime(100)
      vi.useRealTimers()
      return await running
    } finally {
      vi.useRealTimers()
    }
  }

  const encodeArgument = (value: string) => Buffer.from(value).toString('base64')

  it('kills the complete process tree at the bounded timeout', async () => {
    const { root, authorization } = setup('require-approval', { maxTimeoutMs: 100 })
    const ready = path.join(root, 'grandchild-ready.txt')
    const marker = path.join(root, 'grandchild-late.txt')
    const grandchild = [
      "const fs = require('node:fs')",
      `const file = (value) => Buffer.from(value, 'base64').toString()`,
      `fs.writeFileSync(file('${encodeArgument(ready)}'), 'ready')`,
      `setTimeout(() => fs.writeFileSync(file('${encodeArgument(marker)}'), 'late'), 700)`
    ].join(';')
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
      'setTimeout(() => {}, 5000)'
    ].join(';')
    // The timeout fires once the whole tree exists (the grandchild wrote its ready file). Two real
    // node processes must start first, which takes seconds under load: 30 s timeout.
    const result = await runAndTimeOutOnceReady(root, authorization, parent, () =>
      existsSync(ready)
    )

    expect(result.status).toBe('timed-out')
    await delay(850)
    expect(existsSync(marker)).toBe(false)
  }, 30_000)

  // ---------------------------------------------------------------------------------------
  // Real process trees that can FAIL on Windows when the stop is wrong.
  //
  // The product promise: once the stop is reported, nothing of the tree runs any more. Every
  // leaf appends Date.now() to its own heartbeat file every 50 ms (appending, so a kill in the
  // middle of a write can only leave a shorter, smaller number). After the result arrives the
  // test waits 1.5 s and requires that no heartbeat is later than the result plus 250 ms (room
  // for a process that the OS is still tearing down).
  //
  // Why the leaves are started with `detached: true` on win32 (and only there): libuv puts every
  // NON-detached child of a node process into a kill-on-close Job Object of that node process,
  // so a tree made only of such children collapses by itself, level by level, as soon as its
  // root dies. Measured on Windows 11: a node-only tree without `detached` is gone after a
  // single `taskkill /PID <root> /T /F` in 5 of 5 runs, whatever the stop does afterwards, so
  // such a test can never fail there. A detached child gets no such job and behaves like a
  // child started by Python, cmd or PowerShell. On POSIX `detached` would move the leaf out of
  // the command's process group, which is the thing under test there, so it stays off.
  //
  // What stops such a tree:
  // - POSIX: one SIGKILL to the command's process group.
  // - win32 with the verified Job Object helper: terminating the helper closes the job and
  //   Windows kills every process in it (audit: processTreeStop 'job-object').
  // - win32 without the helper: `taskkill /T /F`, then a sweep of the process table that reaches
  //   processes linked by parent pid to the command ('tree-swept'). It closes the GROWING case
  //   and CANNOT close the ORPHAN case (see that test).
  //
  // No test leaves processes behind: every leaf exits by itself after 20 s, and the finally
  // block kills by pid whatever still writes heartbeats.
  // ---------------------------------------------------------------------------------------
  const detachedOnWindows = "detached: process.platform === 'win32', windowsHide: true"

  /**
   * win32: true when this checkout has the Job Object helper as the repository's build script
   * leaves it (the executable with its .sha256 manifest next to it; vitest runs in the repository
   * root, which is where the product looks for it outside a packaged build). Then the stop MUST
   * go through the job: a helper that is installed but silently not used would otherwise let
   * these tests pass through the weaker sweep expectations. To run them without the helper,
   * rename the executable (renaming only the manifest also works here, but other test files
   * decide by the executable alone).
   */
  const jobHelperInstalled = () => {
    const helper = path.resolve(
      process.cwd(),
      'packages/runtime-assets/resources/bin/magicpot-command-job/magicpot-command-job.exe'
    )
    return process.platform === 'win32' && existsSync(helper) && existsSync(`${helper}.sha256`)
  }
  const helperMustBeUsed =
    'the Job Object helper is installed in this checkout, so the stop must go through it (a stale or unverifiable helper: rebuild it with scripts/build-magicpot-command-job.mjs)'

  const heartbeatLeaf = (heartbeatDir: string) =>
    [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      `const dir = Buffer.from('${encodeArgument(heartbeatDir)}', 'base64').toString()`,
      "const file = path.join(dir, 'heartbeat-' + process.pid)",
      "const beat = () => fs.appendFileSync(file, Date.now() + '\\n')",
      'beat()',
      'setInterval(beat, 50)',
      'setTimeout(() => process.exit(0), 20000)'
    ].join(';')

  /** pid and last heartbeat of every leaf that ever wrote one. */
  const heartbeats = (heartbeatDir: string) =>
    (existsSync(heartbeatDir) ? readdirSync(heartbeatDir) : []).flatMap((name) => {
      const pid = Number(/^heartbeat-([0-9]+)$/.exec(name)?.[1])
      if (!pid) return []
      const beats = readFileSync(path.join(heartbeatDir, name), 'utf8')
        .split('\n')
        .filter((line) => /^[0-9]+$/.test(line))
        .map(Number)
      return [{ pid, last: Math.max(0, ...beats) }]
    })

  /** Waits 1.5 s, then lists the leaves whose heartbeat went on after the stop was reported. */
  const leavesRunningAfter = async (heartbeatDir: string, reportedAt: number) => {
    await delay(1_500)
    return heartbeats(heartbeatDir).flatMap(({ pid, last }) =>
      last > reportedAt + 250 ? [`pid ${pid}: ${last - reportedAt} ms after the result`] : []
    )
  }

  /** Cleanup for a failing run: kills by pid every leaf that wrote a heartbeat in the last second. */
  const killHeartbeatSurvivors = async (heartbeatDir: string) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const alive = heartbeats(heartbeatDir).filter(({ last }) => last > Date.now() - 1_000)
      if (!alive.length) return
      for (const { pid } of alive) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
      await delay(250)
    }
  }

  it('kills a process tree that is still growing at the bounded timeout', async () => {
    // GROWING: the timeout lands while the command is still creating leaves (one every 10 ms,
    // up to 50; the kill comes right after the first).
    // Against a single `taskkill /PID <pid> /T /F` this fails on Windows: taskkill enumerates
    // the tree once, and the leaves created between that enumeration and the command's
    // termination keep running (measured with a Python tree of this shape: 7 or 8 survivors in
    // 6 of 6 runs). It passes with the Job Object helper, and without it through the sweep
    // (those leaves still name the command as their parent).
    const { root, authorization } = setup('require-approval', { maxTimeoutMs: 100 })
    const growing = path.join(root, 'parent-growing.txt')
    const heartbeatDir = path.join(root, 'heartbeats')
    mkdirSync(heartbeatDir)
    const parent = [
      "const fs = require('node:fs')",
      "const { spawn } = require('node:child_process')",
      `const growing = Buffer.from('${encodeArgument(growing)}', 'base64').toString()`,
      'let spawned = 0',
      'const grow = () => {',
      `  spawn(process.execPath, ['-e', ${JSON.stringify(heartbeatLeaf(heartbeatDir))}], { stdio: 'ignore', ${detachedOnWindows} })`,
      '  spawned += 1',
      "  if (spawned === 1) fs.writeFileSync(growing, 'growing')",
      '  if (spawned < 50) setTimeout(grow, 10)',
      '}',
      'grow()',
      'setTimeout(() => process.exit(0), 20000)'
    ].join(';')
    const audit: TerminalRunAuditEvidence[] = []

    try {
      const result = await runAndTimeOutOnceReady(
        root,
        authorization,
        parent,
        () => existsSync(growing),
        (evidence) => audit.push(evidence)
      )
      const reportedAt = Date.now()

      expect(result.status).toBe('timed-out')
      // win32: the Job Object when the helper is installed, otherwise the sweep having found no
      // linked survivor. 'tree-unconfirmed' (no process-table snapshot on this PC, or the sweep
      // ran out of time) means the stop could not do its work.
      if (jobHelperInstalled())
        expect(audit[0]?.processTreeStop, helperMustBeUsed).toBe('job-object')
      else if (process.platform === 'win32') expect(audit[0]?.processTreeStop).toBe('tree-swept')
      else expect(audit[0]?.processTreeStop).toBeUndefined()
      expect(
        await leavesRunningAfter(heartbeatDir, reportedAt),
        'leaves of a growing process tree that still ran after the bounded-timeout stop was reported'
      ).toEqual([])
    } finally {
      await killHeartbeatSurvivors(heartbeatDir)
    }
  }, 30_000)

  it('kills a leaf whose parent has already exited (an orphan) at the bounded timeout', async () => {
    // ORPHAN: command -> middle -> leaf; the middle exits, then the timeout lands. Nothing in
    // the Windows process table links the leaf to the command any more (its parent pid names a
    // dead process), so `taskkill /T` does not reach it (measured with a Python tree of this
    // shape: the leaf survives a single taskkill in 5 of 5 runs).
    const { root, authorization } = setup('require-approval', { maxTimeoutMs: 100 })
    const middleGone = path.join(root, 'middle-gone.txt')
    const heartbeatDir = path.join(root, 'heartbeats')
    mkdirSync(heartbeatDir)
    const middle = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(heartbeatLeaf(heartbeatDir))}], { stdio: 'ignore', ${detachedOnWindows} })`,
      'setTimeout(() => process.exit(0), 150)'
    ].join(';')
    const parent = [
      "const fs = require('node:fs')",
      "const { spawn } = require('node:child_process')",
      `const gone = Buffer.from('${encodeArgument(middleGone)}', 'base64').toString()`,
      `const middle = spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: 'ignore', windowsHide: true })`,
      "middle.on('exit', () => fs.writeFileSync(gone, 'gone'))",
      'setTimeout(() => process.exit(0), 20000)'
    ].join(';')
    const audit: TerminalRunAuditEvidence[] = []

    try {
      // The stop comes once the middle has exited and the leaf is beating.
      const result = await runAndTimeOutOnceReady(
        root,
        authorization,
        parent,
        () => existsSync(middleGone) && heartbeats(heartbeatDir).length === 1,
        (evidence) => audit.push(evidence)
      )
      const reportedAt = Date.now()

      expect(result.status).toBe('timed-out')
      const running = await leavesRunningAfter(heartbeatDir, reportedAt)
      const treeStop = audit[0]?.processTreeStop
      if (jobHelperInstalled()) expect(treeStop, helperMustBeUsed).toBe('job-object')
      if (process.platform === 'win32' && treeStop !== 'job-object') {
        // KNOWN, DOCUMENTED GAP (win32 without the verified Job Object helper, or a command the
        // helper cannot launch): the sweep follows parent links from the command, the orphan
        // has none, so it is still running although the stop was reported, and the audit says
        // 'tree-swept' ("no linked survivor found"), never that the tree is gone. This branch
        // states that behaviour instead of skipping; it is not a pass of the product promise.
        // If the orphan is ever reached without a Job Object, this expectation fails: then
        // delete this branch and correct the 'tree-swept' documentation.
        expect(['tree-swept', 'tree-unconfirmed']).toContain(treeStop)
        expect(
          running,
          'known gap: without the Job Object helper the orphan survives the stop (cleaned up below)'
        ).toHaveLength(1)
      } else {
        if (process.platform !== 'win32') expect(treeStop).toBeUndefined()
        expect(
          running,
          'an orphaned leaf that still ran after the bounded-timeout stop was reported'
        ).toEqual([])
      }
    } finally {
      await killHeartbeatSurvivors(heartbeatDir)
    }
  }, 30_000)

  it('rejects policy request parameters that do not exactly match execution', async () => {
    const { root, authorization } = setup()
    const runInput = input(root, ['-e', 'process.stdout.write("safe")'])
    await expect(
      new TerminalRunToolHost(authorization, {
        allowedRoots: [root],
        allowedCommands: [command]
      }).run({ ...runInput, args: ['-e', 'process.stdout.write("different")'] })
    ).rejects.toBeInstanceOf(TerminalRunValidationError)
  })
})

describe('TerminalRunToolHost caller cancellation', () => {
  it('rejects an already stopped request before authorization or spawn', async () => {
    const { root, authorization } = setup()
    const marker = path.join(root, 'must-not-run.txt')
    const controller = new AbortController()
    controller.abort()
    const authorize = vi.spyOn(authorization, 'authorize')
    const host = new TerminalRunToolHost(authorization, { allowedRoots: [root] })
    const task = host.run({
      ...input(
        root,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
        authorization
      ),
      signal: controller.signal
    })
    await expect(task).rejects.toMatchObject({ name: 'AbortError' })
    expect(authorize).not.toHaveBeenCalled()
    expect(existsSync(marker)).toBe(false)
  })

  it('cancels a running command tree and waits for real process close before reporting cancelled', async () => {
    const { root, authorization } = setup()
    const ready = path.join(root, 'owned-processes.json')
    const controller = new AbortController()
    // Both processes exit by themselves after 20 s, so a failing run leaves nothing behind.
    const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(),20000)'],{stdio:'inherit'});require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setTimeout(()=>process.exit(),20000)`
    const audit: TerminalRunAuditEvidence[] = []
    const host = new TerminalRunToolHost(authorization, {
      allowedRoots: [root],
      onAudit: (e) => {
        audit.push(e)
      }
    })
    const task = host.run({
      ...input(root, ['-e', script, ready], authorization),
      signal: controller.signal,
      timeoutMs: 2500
    })
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 1500 })
    const ids: number[] = JSON.parse(readFileSync(ready, 'utf8'))
    // Proves the liveness helper is not vacuous: the sleeping child and
    // grandchild are reported running before the cancel.
    for (const pid of ids) expect(processIsRunning(pid)).toBe(true)
    controller.abort()
    const result = await task
    // Even a failing baseline must finish/close its owned tree before assertions.
    await vi.waitFor(
      () => {
        for (const pid of ids) expect(processIsRunning(pid)).toBe(false)
      },
      { timeout: 1500 }
    )
    expect(result.status).toBe('cancelled')
    expect(audit).toHaveLength(1)
    expect(audit[0].status).toBe('cancelled')
    // The cancel, not the 2.5 s timeout, ended the run. win32 without the Job Object helper
    // reports the stop only after the process-table sweep (PowerShell snapshots, bounded at
    // about 5 s), so there the status above carries the proof and the bound is the sweep's.
    const swept =
      audit[0].processTreeStop === 'tree-swept' || audit[0].processTreeStop === 'tree-unconfirmed'
    expect(result.durationMs).toBeLessThan(swept ? 8000 : 2000)
  })
})
