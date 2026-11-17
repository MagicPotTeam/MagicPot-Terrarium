import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalPolicyRequest } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import type { TerminalRunAuditEvidence } from '.'
import { TerminalRunToolHost, type TerminalRunProcessControl } from './terminalRun'
import {
  resolveCapableWindowsCommandJobHelper,
  WINDOWS_COMMAND_JOB_CAPABILITY
} from './windowsJobObjectConfinement'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const actor = { kind: 'agent', id: 'agent-1' } as const
const approver = { kind: 'user', id: 'approver-1' } as const
const roots: string[] = []
const stores: MagicAgentEventStore[] = []

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})

const HELPER = 'C:\\Program Files\\MagicPot\\bin\\magicpot-command-job\\magicpot-command-job.exe'

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kills: (NodeJS.Signals | number | undefined)[] = []
  closed = false
  constructor(readonly pid: number) {
    super()
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    return true
  }
  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return
    this.closed = true
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, signal)
  }
}

type SpawnCall = { file: string; args: string[]; options: SpawnOptions; child: FakeChild }

function fakeSpawner(onSpawn?: (call: SpawnCall) => void) {
  const calls: SpawnCall[] = []
  let nextPid = 7000
  const spawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
    const child = new FakeChild(nextPid++)
    const call = { file, args: [...args], options, child }
    calls.push(call)
    queueMicrotask(() => {
      child.emit('spawn')
      onSpawn?.(call)
    })
    return child as unknown as ChildProcess
  }) as TerminalRunProcessControl['spawn']
  return { calls, spawn }
}

function setup() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'magic-terminal-win-')))
  roots.push(root)
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const authorization = new MagicAgentPolicyAuthorizationService({
    store,
    rules: [
      {
        ruleId: 'terminal',
        priority: 1,
        effect: 'require-approval',
        explanation: 'test',
        approvalRequirement: {
          scopeKind: 'request',
          scopeValue: '*',
          maxUses: 1,
          expiresInMs: 60_000,
          reason: 'test approval'
        }
      }
    ],
    policyVersion: 'policy-1',
    storeId: 'store-1',
    trustedApprovers: [approver]
  })
  return { root, authorization }
}

function approvedInput(
  root: string,
  authorization: MagicAgentPolicyAuthorizationService,
  command: string,
  args: string[],
  extra: Partial<{ env: Record<string, string>; timeoutMs: number; signal: AbortSignal }> = {}
) {
  const request = createTerminalPolicyRequest({
    requestId: `request-${Math.random()}`,
    actor,
    target: { kind: 'tool', id: 'terminal.run' },
    command,
    args,
    cwd: root,
    filesystem: { cwd: root, allowedRoots: [root] }
  })
  const authorizationId = `authorization-${Math.random()}`
  const now = Date.now()
  authorization.createApprovalGrant({
    grantId: `grant-${authorizationId}`,
    request,
    approvedBy: approver,
    issuedAt: now,
    expiresAt: now + 30_000,
    maxUses: 1,
    idempotencyKey: `grant-${authorizationId}`
  })
  return {
    authorizationId,
    idempotencyKey: `execution-${Math.random()}`,
    request,
    command,
    args,
    cwd: root,
    grantId: `grant-${authorizationId}`,
    expectedGrantUseCount: 0,
    ...extra
  }
}

const windowsFiles = (files: readonly string[]) => {
  const set = new Set(files.map((file) => file.toLowerCase()))
  return {
    parentEnv: { Path: 'C:\\Windows\\System32' },
    isFile: (candidate: string) => set.has(candidate.toLowerCase())
  }
}

function host(
  root: string,
  authorization: MagicAgentPolicyAuthorizationService,
  control: Partial<TerminalRunProcessControl>,
  audit: TerminalRunAuditEvidence[] = []
) {
  return new TerminalRunToolHost(authorization, {
    allowedRoots: [root],
    allowedEnvironmentKeys: ['Path'],
    onAudit: (evidence) => {
      audit.push(evidence)
    },
    processControl: { platform: 'win32', ...control }
  })
}

const settledFlag = (promise: Promise<unknown>) => {
  const state = { settled: false }
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true)
  )
  return state
}

describe('terminal.run on win32 with the Job Object helper', () => {
  it('launches the resolved absolute command through the helper with no limits, same cwd, env and stdio', async () => {
    const { root, authorization } = setup()
    const fake = fakeSpawner(({ child }) => {
      child.stdout.write('out')
      child.stderr.write('err')
      child.close(0)
    })
    const args = ['plain', 'with space', 'quote"inside', 'trailing\\', 'trailing space\\', '']
    const result = await host(root, authorization, {
      spawn: fake.spawn,
      resolveWindowsJobHelper: async () => HELPER,
      windowsCommandLookup: windowsFiles(['C:\\Tools\\tool.exe'])
    }).run(approvedInput(root, authorization, 'tool', args, { env: { Path: 'C:\\Tools' } }))

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].file).toBe(HELPER)
    expect(fake.calls[0].args).toEqual(['-', '-', '-', '--', 'C:\\Tools\\tool.exe', ...args])
    expect(fake.calls[0].options).toEqual({
      cwd: root,
      env: { Path: 'C:\\Tools' },
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: 'pipe'
    })
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, stdout: 'out', stderr: 'err' })
  })

  it('keeps the exit code and output of a command that finishes normally', async () => {
    const { root, authorization } = setup()
    const fake = fakeSpawner(({ child }) => {
      child.stdout.write('partial result')
      child.close(3)
    })
    const audit: TerminalRunAuditEvidence[] = []
    const result = await host(
      root,
      authorization,
      {
        spawn: fake.spawn,
        resolveWindowsJobHelper: async () => HELPER,
        windowsCommandLookup: windowsFiles(['C:\\Windows\\System32\\tool.exe'])
      },
      audit
    ).run(approvedInput(root, authorization, 'tool', ['x']))
    expect(result).toMatchObject({ status: 'failed', exitCode: 3, stdout: 'partial result' })
    expect(audit[0]).not.toHaveProperty('processTreeStop')
  })

  it('a stop terminates the helper and reports only after the helper has closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { root, authorization } = setup()
    const fake = fakeSpawner()
    const audit: TerminalRunAuditEvidence[] = []
    const running = host(
      root,
      authorization,
      {
        spawn: fake.spawn,
        resolveWindowsJobHelper: async () => HELPER,
        windowsCommandLookup: windowsFiles(['C:\\Windows\\System32\\tool.exe'])
      },
      audit
    ).run(approvedInput(root, authorization, 'tool', [], { timeoutMs: 100 }))
    const state = settledFlag(running)
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    vi.advanceTimersByTime(100)
    const helper = fake.calls[0].child
    expect(helper.kills).toEqual(['SIGKILL'])
    // No taskkill and no snapshot: closing the helper's job is the whole stop.
    expect(fake.calls).toHaveLength(1)
    await Promise.resolve()
    expect(state.settled).toBe(false)
    helper.close(1)
    const result = await running
    expect(result.status).toBe('timed-out')
    expect(audit[0]).toMatchObject({ status: 'timed-out', processTreeStop: 'job-object' })
  })

  it('a cancel terminates the helper', async () => {
    const { root, authorization } = setup()
    const fake = fakeSpawner()
    const controller = new AbortController()
    const running = host(root, authorization, {
      spawn: fake.spawn,
      resolveWindowsJobHelper: async () => HELPER,
      windowsCommandLookup: windowsFiles(['C:\\Windows\\System32\\tool.exe'])
    }).run(approvedInput(root, authorization, 'tool', [], { signal: controller.signal }))
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    controller.abort()
    expect(fake.calls[0].child.kills).toEqual(['SIGKILL'])
    fake.calls[0].child.close(1)
    expect((await running).status).toBe('cancelled')
  })

  it('passes a command path and arguments with spaces and non-ASCII characters through unchanged', async () => {
    const { root, authorization } = setup()
    const fake = fakeSpawner(({ child }) => child.close(0))
    const tool = 'C:\\Program Files\\工具 集\\outil é.exe'
    const args = ['--name=名前 と 空白', 'C:\\データ\\été\\']
    await host(root, authorization, {
      spawn: fake.spawn,
      resolveWindowsJobHelper: async () => HELPER,
      windowsCommandLookup: windowsFiles([tool])
    }).run(approvedInput(root, authorization, tool, args))
    expect(fake.calls.map((call) => [call.file, call.args])).toEqual([
      [HELPER, ['-', '-', '-', '--', tool, ...args]]
    ])
    expect(fake.calls[0].options.cwd).toBe(root)
  })

  it('keeps the direct spawn for a command path beyond the classic Windows path limit', async () => {
    const { root, authorization } = setup()
    const fake = fakeSpawner(({ child }) => child.close(0))
    const tool = `C:\\${'d'.repeat(250)}\\tool.exe`
    await host(root, authorization, {
      spawn: fake.spawn,
      resolveWindowsJobHelper: async () => HELPER,
      windowsCommandLookup: windowsFiles([tool])
    }).run(approvedInput(root, authorization, tool, ['x']))
    expect(fake.calls.map((call) => [call.file, call.args])).toEqual([[tool, ['x']]])
  })

  it('keeps the direct spawn for commands the helper cannot launch the same way', async () => {
    const { root, authorization } = setup()
    for (const [command, files] of [
      ['missing', []],
      ['script.cmd', ['C:\\Windows\\System32\\script.cmd']],
      ['D:relative', ['D:relative.exe']]
    ] as const) {
      const fake = fakeSpawner(({ child }) => child.close(0))
      await host(root, authorization, {
        spawn: fake.spawn,
        resolveWindowsJobHelper: async () => HELPER,
        windowsCommandLookup: windowsFiles(files)
      }).run(approvedInput(root, authorization, command, ['a b']))
      expect(fake.calls.map((call) => [call.file, call.args])).toEqual([[command, ['a b']]])
    }
  })
})

describe('terminal.run on win32 without a usable helper', () => {
  const helperFixture = (content = 'helper-binary') => {
    const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'magic-terminal-helper-')))
    roots.push(dir)
    const helper = path.join(dir, 'magicpot-command-job.exe')
    writeFileSync(helper, content)
    writeFileSync(
      `${helper}.sha256`,
      `${createHash('sha256').update(readFileSync(helper)).digest('hex')}\n`
    )
    return helper
  }

  it.each([
    ['reports another capability', 'magicpot-command-job:atomic-job-list-empty-v1', false],
    ['does not answer', undefined, false],
    ['fails verification', WINDOWS_COMMAND_JOB_CAPABILITY, true]
  ] as const)('does not use a helper that %s', async (_name, capability, tamper) => {
    const { root, authorization } = setup()
    const helper = helperFixture()
    if (tamper) writeFileSync(helper, 'tampered')
    const probe = vi.fn(async () => capability)
    const fake = fakeSpawner(({ child, file }) => {
      if (file.endsWith('taskkill.exe')) return
      child.close(0)
    })
    await host(root, authorization, {
      spawn: fake.spawn,
      resolveWindowsJobHelper: () =>
        resolveCapableWindowsCommandJobHelper({ candidates: [helper], probe }),
      windowsCommandLookup: windowsFiles(['C:\\Windows\\System32\\tool.exe'])
    }).run(approvedInput(root, authorization, 'tool', ['x']))
    expect(fake.calls.map((call) => [call.file, call.args])).toEqual([['tool', ['x']]])
    expect(probe).toHaveBeenCalledTimes(tamper ? 0 : 1)
  })

  it('uses a verified helper that answers the current capability', async () => {
    const { root, authorization } = setup()
    const helper = helperFixture()
    const fake = fakeSpawner(({ child }) => child.close(0))
    await host(root, authorization, {
      spawn: fake.spawn,
      resolveWindowsJobHelper: () =>
        resolveCapableWindowsCommandJobHelper({
          candidates: [helper],
          probe: async () => WINDOWS_COMMAND_JOB_CAPABILITY
        }),
      windowsCommandLookup: windowsFiles(['C:\\Windows\\System32\\tool.exe'])
    }).run(approvedInput(root, authorization, 'tool', ['x']))
    expect(fake.calls.map((call) => [call.file, call.args])).toEqual([
      [helper, ['-', '-', '-', '--', 'C:\\Windows\\System32\\tool.exe', 'x']]
    ])
  })
})

describe('terminal.run on win32 without the helper: taskkill plus sweep', () => {
  const noHelper = async () => undefined
  /** The command itself: stays open until the test closes it. */
  const fakeCommand = fakeSpawner()
  const taskkillSpawner = (exitCode = 0) => {
    const fake = fakeSpawner(({ file, child }) => {
      if (!file.endsWith('taskkill.exe')) return
      fake.calls[0].child.close(1)
      child.close(exitCode)
    })
    return fake
  }

  it('kills at once with taskkill, then reports only after the sweep found no linked survivor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { root, authorization } = setup()
    const fake = taskkillSpawner()
    const answers: ((table: []) => void)[] = []
    const windowsSnapshot = vi.fn(() => new Promise<[]>((resolve) => answers.push(resolve)))
    const audit: TerminalRunAuditEvidence[] = []
    const running = host(
      root,
      authorization,
      {
        spawn: fake.spawn,
        resolveWindowsJobHelper: noHelper,
        windowsCommandLookup: windowsFiles(['C:\\Windows\\System32\\tool.exe']),
        windowsSnapshot
      },
      audit
    ).run(approvedInput(root, authorization, 'tool', ['x'], { timeoutMs: 100 }))
    const state = settledFlag(running)
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    expect(fake.calls[0].file).toBe('tool')
    vi.advanceTimersByTime(100)
    // The first kill is today's command, issued synchronously at the timeout.
    expect(fake.calls[1].file).toMatch(/[\\/]System32[\\/]taskkill\.exe$/)
    expect(fake.calls[1].args).toEqual(['/PID', String(fake.calls[0].child.pid), '/T', '/F'])
    // One snapshot starts in parallel with the kill (it only records members) ...
    expect(windowsSnapshot).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fake.calls[0].child.closed).toBe(true))
    // ... and the one that decides is requested once the taskkill has completed.
    await vi.waitFor(() => expect(windowsSnapshot).toHaveBeenCalledTimes(2))
    answers[0]([])
    await Promise.resolve()
    expect(state.settled).toBe(false)
    answers[1]([])
    const result = await running
    expect(result.status).toBe('timed-out')
    expect(fake.calls[0].child.kills).toEqual([])
    expect(audit[0]).toMatchObject({ status: 'timed-out', processTreeStop: 'tree-swept' })
  })

  it('reports an unconfirmed tree stop when no snapshot can be taken', async () => {
    const { root, authorization } = setup()
    const fake = taskkillSpawner()
    const controller = new AbortController()
    const audit: TerminalRunAuditEvidence[] = []
    const running = host(
      root,
      authorization,
      {
        spawn: fake.spawn,
        resolveWindowsJobHelper: noHelper,
        windowsCommandLookup: windowsFiles([]),
        windowsSnapshot: async () => undefined
      },
      audit
    ).run(approvedInput(root, authorization, 'tool', [], { signal: controller.signal }))
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    controller.abort()
    expect((await running).status).toBe('cancelled')
    expect(audit[0]).toMatchObject({ status: 'cancelled', processTreeStop: 'tree-unconfirmed' })
  })

  it('aims no taskkill at a command that has already exited and sweeps only what it left behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { root, authorization } = setup()
    const fake = fakeSpawner(({ child }) => child.close(0))
    let clock = 1_700_000_000_000
    const us = (ms: number) => ms * 1000
    const audit: TerminalRunAuditEvidence[] = []
    const running = host(
      root,
      authorization,
      {
        spawn: ((file, args, options) =>
          file === 'tool'
            ? fakeCommand.spawn(file, args, options)
            : fake.spawn(file, args, options)) as TerminalRunProcessControl['spawn'],
        now: () => clock,
        resolveWindowsJobHelper: noHelper,
        windowsCommandLookup: windowsFiles([]),
        // 7001 was started by the command (pid 7000) before it exited and keeps its pipes open;
        // 7002 names the same parent pid but was created after the command had exited.
        windowsSnapshot: async () => [
          ...(fake.calls.some((call) => call.args.includes('7001'))
            ? []
            : [{ pid: 7001, parentPid: 7000, createdAtUs: us(1_700_000_000_500) }]),
          { pid: 7002, parentPid: 7000, createdAtUs: us(1_700_000_020_000) }
        ]
      },
      audit
    ).run(approvedInput(root, authorization, 'tool', [], { timeoutMs: 100 }))
    await vi.waitFor(() => expect(fakeCommand.calls).toHaveLength(1))
    const commandChild = fakeCommand.calls[0].child
    clock += 1_000
    commandChild.emit('exit', 0, null)
    clock += 29_000
    vi.advanceTimersByTime(100)
    vi.useRealTimers()
    await vi.waitFor(() => expect(fake.calls.length).toBeGreaterThan(0))
    commandChild.close(0)
    await running
    expect(
      fake.calls
        .filter((call) => call.file.endsWith('taskkill.exe'))
        .map((call) => call.args.join(' '))
    ).toEqual(['/PID 7001 /F'])
    expect(audit[0]).toMatchObject({ status: 'timed-out' })
  })

  it('still kills the child directly when taskkill fails, as before', async () => {
    const { root, authorization } = setup()
    const fake = taskkillSpawner(1)
    const controller = new AbortController()
    const running = host(root, authorization, {
      spawn: fake.spawn,
      resolveWindowsJobHelper: noHelper,
      windowsCommandLookup: windowsFiles([]),
      windowsSnapshot: async () => []
    }).run(approvedInput(root, authorization, 'tool', [], { signal: controller.signal }))
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1))
    controller.abort()
    await running
    expect(fake.calls[0].child.kills).toEqual(['SIGKILL'])
  })
})
