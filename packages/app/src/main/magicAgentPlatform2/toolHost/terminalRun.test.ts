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
    ready: () => boolean
  ) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const running = new TerminalRunToolHost(authorization, {
        allowedRoots: [root],
        allowedCommands: [command]
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

  it('kills a process tree that is still growing at the bounded timeout', async () => {
    // The timeout lands while the parent is still creating grandchildren: it starts one every
    // 25 ms for about a second and the kill comes right after the first. Every grandchild reports
    // itself 700 ms after it starts unless it was killed. On POSIX one process-group SIGKILL
    // covers a fork in flight. On win32 the product runs `taskkill /PID <pid> /T /F`, which
    // enumerates the tree once, so a grandchild created between that enumeration and the
    // parent's termination survives: a known product gap (a Job Object kill would close it, see
    // windowsJobObjectConfinement.ts), which this test is meant to keep showing until fixed.
    const { root, authorization } = setup('require-approval', { maxTimeoutMs: 100 })
    const growing = path.join(root, 'parent-growing.txt')
    const lateDir = path.join(root, 'late')
    mkdirSync(lateDir)
    const grandchild = [
      "const fs = require('node:fs')",
      "const path = require('node:path')",
      `const dir = Buffer.from('${encodeArgument(lateDir)}', 'base64').toString()`,
      "setTimeout(() => fs.writeFileSync(path.join(dir, 'late-' + process.pid), 'late'), 700)"
    ].join(';')
    const parent = [
      "const fs = require('node:fs')",
      "const { spawn } = require('node:child_process')",
      `const growing = Buffer.from('${encodeArgument(growing)}', 'base64').toString()`,
      'let spawned = 0',
      'const grow = () => {',
      `  spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
      '  spawned += 1',
      "  if (spawned === 1) fs.writeFileSync(growing, 'growing')",
      '  if (spawned < 40) setTimeout(grow, 25)',
      '}',
      'grow()',
      'setTimeout(() => {}, 5000)'
    ].join(';')

    const result = await runAndTimeOutOnceReady(root, authorization, parent, () =>
      existsSync(growing)
    )

    expect(result.status).toBe('timed-out')
    // 700 ms report delay plus room for a surviving grandchild that is still booting.
    await delay(1_500)
    expect(
      readdirSync(lateDir),
      'grandchildren that survived the bounded-timeout kill of a growing process tree'
    ).toEqual([])
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
    const script = `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});require('node:fs').writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`
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
    expect(result.durationMs).toBeLessThan(2000)
    expect(audit).toHaveLength(1)
    expect(audit[0].status).toBe('cancelled')
  })
})
