import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertPolicyRequest } from '../../../shared/magicAgentPlatform2'
import { GitToolHost, GitToolProcessError, GitToolValidationError } from '.'

const HEAD = '1'.repeat(40),
  NEXT = '2'.repeat(40),
  EMPTY = createHash('sha256').update('').digest('hex')
const BASE = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotepath=false']
type Tool =
  | 'git.status'
  | 'git.diff'
  | 'git.log'
  | 'git.show'
  | 'git.branch'
  | 'git.checkout'
  | 'git.add'
  | 'git.commit'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function workspace(index?: string) {
  const root = path.join(tmpdir(), `magic-git-${process.pid}-${Math.random()}`)
  mkdirSync(path.join(root, '.git'), { recursive: true })
  if (index !== undefined) writeFileSync(path.join(root, '.git', 'index'), index)
  roots.push(root)
  return root
}
function request(tool: Tool) {
  const write =
    tool.startsWith('git.') && !['git.status', 'git.diff', 'git.log', 'git.show'].includes(tool)
  return assertPolicyRequest({
    discriminator: 'magic-agent.policy-request.v1',
    version: 1,
    requestId: `r-${Math.random()}`,
    actor: { kind: 'agent', id: 'a' },
    origin: 'assistant',
    action: tool,
    target: { kind: 'tool', id: tool },
    input: {},
    effects: [
      { kind: write ? (tool as 'git.add') : 'filesystem.read', risk: write ? 'high' : 'read' }
    ]
  })
}
function authorization(
  order: string[],
  tools: Tool[] = [
    'git.status',
    'git.diff',
    'git.log',
    'git.show',
    'git.branch',
    'git.checkout',
    'git.add',
    'git.commit'
  ]
) {
  const permit = { constraints: { requireNoShell: true, allowedToolNames: tools } }
  return {
    authorize: vi.fn(() => {
      order.push('authorize')
      return { status: 'authorized', permit }
    }),
    isTrustedPermit: vi.fn((value) => value === permit),
    consumeExecutionPermit: vi.fn(() => order.push('consume'))
  } as never
}
function call(tool: Tool, input: Record<string, unknown>, signal?: AbortSignal) {
  return {
    authorizationId: 'auth',
    idempotencyKey: `key-${Math.random()}`,
    request: request(tool),
    input,
    signal,
    grantId: 'grant',
    expectedGrantUseCount: 0
  } as never
}

type Reply = { stdout?: string; stderr?: string; code?: number; hold?: boolean }
function harness(respond: (args: readonly string[], call: number) => Reply, order: string[] = []) {
  const calls: Array<{
    command: string
    args: readonly string[]
    options: Record<string, unknown>
  }> = []
  const spawn = vi.fn(
    (command: string, args: readonly string[], options: Record<string, unknown>) => {
      order.push('spawn')
      calls.push({ command, args, options })
      const reply = respond(args.slice(BASE.length), calls.length - 1)
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough
        stderr: PassThrough
        kill: ReturnType<typeof vi.fn>
      }
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
        return true
      })
      if (!reply.hold)
        queueMicrotask(() => {
          child.stdout.end(reply.stdout ?? '')
          child.stderr.end(reply.stderr ?? '')
          child.emit('close', reply.code ?? 0, null)
        })
      return child
    }
  )
  return { spawn: spawn as never, calls }
}
function stateHarness(
  options: {
    status?: string
    staged?: string
    addFailure?: boolean
    checkoutHead?: string
    parent?: string
  } = {},
  order: string[] = []
) {
  let head = HEAD
  const branches = new Map([
    ['main', HEAD],
    ['target', NEXT]
  ])
  return harness((args) => {
    const key = args.join('\0')
    if (key === 'rev-parse\0--verify\0HEAD') return { stdout: `${head}\n` }
    if (args[0] === 'rev-parse' && String(args[2]).startsWith('refs/heads/')) {
      const value = branches.get(String(args[2]).slice(11))
      return value ? { stdout: `${value}\n` } : { code: 128, stderr: 'unknown branch' }
    }
    if (
      key === 'status\0--porcelain=v1\0-z\0--untracked-files=all' ||
      key === 'status\0--porcelain=v1\0--branch\0-z\0--untracked-files=all'
    )
      return { stdout: options.status ?? '' }
    if (key === 'diff\0--cached\0--no-ext-diff\0--no-textconv\0--numstat\0--')
      return { stdout: options.staged ?? '' }
    if (args[0] === 'diff') return { stdout: '1\t0\tfile.txt\n' }
    if (args[0] === 'branch') {
      branches.set(String(args[2]), String(args[3]))
      return {}
    }
    if (args[0] === 'checkout') {
      head = options.checkoutHead ?? branches.get(String(args[2])) ?? head
      return {}
    }
    if (args[0] === 'add') return options.addFailure ? { code: 1, stderr: 'add failed' } : {}
    if (args[0] === 'commit') {
      head = NEXT
      return {}
    }
    if (args[0] === 'rev-parse' && String(args[2]).endsWith('^'))
      return { stdout: `${options.parent ?? HEAD}\n` }
    throw new Error(`Unexpected git argv: ${JSON.stringify(args)}`)
  }, order)
}

describe('GitToolHost', () => {
  it('status uses fixed argv and reports real HEAD and staged digest', async () => {
    const root = workspace(),
      order: string[] = [],
      staged = '2\t1\tstaged.txt\n',
      process = stateHarness({ status: '## main\0 M file.txt\0', staged }, order)
    const host = await GitToolHost.create(authorization(order), {
      allowedRoots: [root],
      spawn: process.spawn
    })
    const output = await host.status(call('git.status', {}))
    expect(order).toEqual(['authorize', 'consume', 'spawn', 'spawn', 'spawn'])
    expect(process.calls.map((c) => c.args)).toEqual([
      [...BASE, 'status', '--porcelain=v1', '--branch', '-z', '--untracked-files=all'],
      [...BASE, 'rev-parse', '--verify', 'HEAD'],
      [...BASE, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--numstat', '--']
    ])
    expect(process.calls.every((c) => c.command === 'git' && c.options.shell === false)).toBe(true)
    expect(output).toMatchObject({
      head: HEAD,
      stagedDiffDigest: createHash('sha256').update(staged).digest('hex')
    })
  })

  it('branch probes before approval, creates exactly at expected HEAD, and rejects stale/existing/invalid names', async () => {
    const root = workspace(),
      order: string[] = [],
      process = stateHarness({}, order),
      auth = authorization(order),
      host = await GitToolHost.create(auth, { allowedRoots: [root], spawn: process.spawn })
    await expect(
      host.branch(call('git.branch', { branch: 'feature/x', expectedHead: HEAD }))
    ).resolves.toMatchObject({ afterHead: HEAD })
    expect(process.calls.map((c) => c.args.slice(BASE.length))).toEqual([
      ['rev-parse', '--verify', 'HEAD'],
      ['rev-parse', '--verify', 'refs/heads/feature/x'],
      ['branch', '--', 'feature/x', HEAD],
      ['rev-parse', '--verify', 'refs/heads/feature/x']
    ])
    expect(order.slice(0, 5)).toEqual(['spawn', 'spawn', 'authorize', 'consume', 'spawn'])
    await expect(
      host.branch(call('git.branch', { branch: 'other', expectedHead: NEXT }))
    ).rejects.toThrow('Stale expected HEAD')
    await expect(
      host.branch(call('git.branch', { branch: 'main', expectedHead: HEAD }))
    ).rejects.toThrow('already exists')
    for (const branch of ['--force', 'x/../y', 'x/.hidden', '@'])
      await expect(
        host.branch(call('git.branch', { branch, expectedHead: HEAD }))
      ).rejects.toBeInstanceOf(GitToolValidationError)
  })

  it('checkout requires existing branch, matching clean status, and verifies post-checkout HEAD/status', async () => {
    const root = workspace(),
      clean = '',
      process = stateHarness(),
      host = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: process.spawn
      })
    const output = await host.checkout(
      call('git.checkout', { branch: 'target', expectedHead: HEAD, expectedStatusDigest: EMPTY })
    )
    expect(output.afterHead).toBe(NEXT)
    expect(process.calls.map((c) => c.args.slice(BASE.length))).toEqual([
      ['rev-parse', '--verify', 'HEAD'],
      ['rev-parse', '--verify', 'refs/heads/target'],
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      ['checkout', '--', 'target'],
      ['rev-parse', '--verify', 'HEAD'],
      ['status', '--porcelain=v1', '-z', '--untracked-files=all']
    ])
    const dirty = stateHarness({ status: ' M file.txt\0' }),
      dirtyHost = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: dirty.spawn
      })
    await expect(
      dirtyHost.checkout(
        call('git.checkout', {
          branch: 'target',
          expectedHead: HEAD,
          expectedStatusDigest: createHash('sha256').update(' M file.txt\0').digest('hex')
        })
      )
    ).rejects.toThrow('clean')
    await expect(
      host.checkout(
        call('git.checkout', { branch: 'missing', expectedHead: NEXT, expectedStatusDigest: EMPTY })
      )
    ).rejects.toThrow('does not exist')
    expect(clean).toBe('')
  })

  it('add contains paths, uses --, snapshots the index, and returns CAS digests', async () => {
    const root = workspace('original-index'),
      process = stateHarness({ status: ' M file.txt\0', staged: '1\t0\tfile.txt\n' }),
      host = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: process.spawn
      })
    const statusDigest = createHash('sha256').update(' M file.txt\0').digest('hex')
    const output = await host.add(
      call('git.add', {
        pathspecs: ['dir/file.txt'],
        expectedHead: HEAD,
        expectedStatusDigest: statusDigest
      })
    )
    expect(
      process.calls.some(
        (c) =>
          JSON.stringify(c.args.slice(BASE.length)) ===
          JSON.stringify(['add', '--', 'dir/file.txt'])
      )
    ).toBe(true)
    expect(readFileSync(path.join(root, output.indexSnapshot), 'utf8')).toBe('original-index')
    expect(output).toMatchObject({
      beforeHead: HEAD,
      afterHead: HEAD,
      rollback: 'not-needed',
      beforeStatusDigest: statusDigest
    })
    for (const bad of ['../secret', '/absolute', '--all'])
      await expect(
        host.add(
          call('git.add', {
            pathspecs: [bad],
            expectedHead: HEAD,
            expectedStatusDigest: statusDigest
          })
        )
      ).rejects.toBeInstanceOf(GitToolValidationError)
  })

  it('rolls back a failed add, including restoring an originally absent index', async () => {
    for (const original of ['index-data', undefined] as const) {
      const root = workspace(original),
        process = stateHarness({ addFailure: true }),
        audits: unknown[] = [],
        host = await GitToolHost.create(authorization([]), {
          allowedRoots: [root],
          spawn: process.spawn,
          onAudit: (e) => {
            audits.push(e)
          }
        })
      await expect(
        host.add(
          call('git.add', {
            pathspecs: ['file.txt'],
            expectedHead: HEAD,
            expectedStatusDigest: EMPTY
          })
        )
      ).rejects.toMatchObject({ mutationMayHaveOccurred: false })
      const index = path.join(root, '.git', 'index')
      expect(
        original === undefined
          ? (() => {
              try {
                readFileSync(index)
                return false
              } catch {
                return true
              }
            })()
          : readFileSync(index, 'utf8') === original
      ).toBe(true)
      expect(audits.at(-1)).toMatchObject({ rollback: 'restored', outcome: 'rejected' })
    }
  })

  it('commit rejects empty/stale staged state and uses bounded message argv without bypassing hooks', async () => {
    const root = workspace(),
      staged = '3\t1\tfile.txt\n',
      digest = createHash('sha256').update(staged).digest('hex'),
      process = stateHarness({ staged }),
      host = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: process.spawn
      })
    const output = await host.commit(
      call('git.commit', {
        message: '-safe literal message',
        expectedHead: HEAD,
        expectedStagedDiffDigest: digest
      })
    )
    const commit = process.calls.find((c) => c.args.includes('commit'))!
    expect(commit.args.slice(BASE.length)).toEqual(['commit', '-m', '-safe literal message'])
    expect(commit.args).not.toContain('--no-verify')
    expect(output).toMatchObject({
      beforeHead: HEAD,
      afterHead: NEXT,
      parentHead: HEAD,
      stagedDiffDigest: digest
    })
    const empty = stateHarness(),
      emptyHost = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: empty.spawn
      })
    await expect(
      emptyHost.commit(
        call('git.commit', { message: 'x', expectedHead: HEAD, expectedStagedDiffDigest: EMPTY })
      )
    ).rejects.toThrow('empty index')
    await expect(
      emptyHost.commit(
        call('git.commit', { message: '', expectedHead: HEAD, expectedStagedDiffDigest: EMPTY })
      )
    ).rejects.toBeInstanceOf(GitToolValidationError)
    await expect(
      emptyHost.commit(
        call('git.commit', {
          message: 'x'.repeat(16385),
          expectedHead: HEAD,
          expectedStagedDiffDigest: EMPTY
        })
      )
    ).rejects.toBeInstanceOf(GitToolValidationError)
  })

  it('fails uncertain when the new commit parent is not the approved HEAD', async () => {
    const root = workspace(),
      staged = '1\t0\tx\n',
      process = stateHarness({ staged, parent: '3'.repeat(40) }),
      host = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: process.spawn
      })
    await expect(
      host.commit(
        call('git.commit', {
          message: 'm',
          expectedHead: HEAD,
          expectedStagedDiffDigest: createHash('sha256').update(staged).digest('hex')
        })
      )
    ).rejects.toMatchObject({ mutationMayHaveOccurred: true })
  })

  it('kills the child on abort and timeout and audits without content or commit messages', async () => {
    const root = workspace(),
      audits: unknown[] = [],
      held = harness(() => ({ hold: true })),
      host = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: held.spawn,
        onAudit: (e) => {
          audits.push(e)
        }
      })
    const controller = new AbortController(),
      pending = host.branch(
        call('git.branch', { branch: 'x', expectedHead: HEAD }, controller.signal)
      )
    await new Promise((r) => setTimeout(r, 0))
    controller.abort()
    await expect(pending).rejects.toMatchObject({
      outcome: 'cancelled'
    } satisfies Partial<GitToolProcessError>)
    expect(
      (held.spawn as ReturnType<typeof vi.fn>).mock.results[0].value.kill
    ).toHaveBeenCalledWith('SIGKILL')
    const timed = harness(() => ({ hold: true })),
      timedHost = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: timed.spawn
      })
    await expect(
      timedHost.branch(call('git.branch', { branch: 'x', expectedHead: HEAD, timeoutMs: 1 }))
    ).rejects.toMatchObject({ outcome: 'timed-out' })
    expect(JSON.stringify(audits)).not.toMatch(/file contents|commit message|safe literal/i)
  })

  it('rejects argv injection, remote refs, traversal, and escaping gitdirs before spawn', async () => {
    const root = workspace(),
      process = harness(() => ({})),
      host = await GitToolHost.create(authorization([]), {
        allowedRoots: [root],
        spawn: process.spawn
      })
    await expect(
      host.show(call('git.show', { revision: '--upload-pack=evil' }))
    ).rejects.toBeInstanceOf(GitToolValidationError)
    await expect(
      host.diff(call('git.diff', { revision: 'https://host/repo', pathspecs: ['../secret'] }))
    ).rejects.toBeInstanceOf(GitToolValidationError)
    rmSync(path.join(root, '.git'), { recursive: true })
    const outside = path.join(tmpdir(), `outside-${Math.random()}`)
    mkdirSync(outside)
    roots.push(outside)
    writeFileSync(path.join(root, '.git'), `gitdir: ${outside}\n`)
    await expect(host.status(call('git.status', {}))).rejects.toThrow('escapes')
    expect(process.calls).toHaveLength(0)
  })
})
