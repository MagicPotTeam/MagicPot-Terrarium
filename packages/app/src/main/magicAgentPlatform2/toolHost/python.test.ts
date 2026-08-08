import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandJobRecord, CommandsBackgroundInput } from './commandJobs'
import { PythonToolHost, type PythonJobManager, type PythonProvenance } from './python'

const roots: string[] = []
const provenance: PythonProvenance = {
  executable: path.resolve('/trusted/python'),
  sha256: 'a'.repeat(64),
  implementation: 'CPython',
  version: '3.12.1',
  platform: 'test'
}

function root(): string {
  const value = path.resolve(`.tmp-python-tool-${process.pid}-${Math.random()}`)
  mkdirSync(value, { recursive: true })
  roots.push(value)
  return value
}
afterEach(() => roots.splice(0).forEach((value) => rmSync(value, { recursive: true, force: true })))

function manager(onBackground?: (input: CommandsBackgroundInput) => void): PythonJobManager {
  let record: CommandJobRecord | undefined
  return {
    background: vi.fn(async (input: CommandsBackgroundInput) => {
      onBackground?.(input)
      await input.beforeConsume?.()
      record = {
        jobId: '00000000-0000-0000-0000-000000000001',
        routeKey: input.routeKey,
        sessionId: input.sessionId,
        state: 'completed',
        outcome: 'known',
        command: input.command,
        args: input.args ?? [],
        cwd: input.cwd,
        createdAt: 1,
        finishedAt: 2,
        exitCode: 0,
        stdoutBytes: 2,
        stderrBytes: 0,
        logsTruncated: false
      }
      return record
    }),
    status: vi.fn(() => record!),
    read: vi.fn((input) => ({
      data: input.stream === 'stdout' ? 'ok' : '',
      cursor: 0,
      nextCursor: 2,
      eof: true,
      truncated: false
    })),
    stop: vi.fn(async () => record!)
  }
}

function host(
  workspaceRoot: string,
  jobManager = manager(),
  probe: (executable: string) => PythonProvenance = vi.fn(() => provenance)
) {
  return new PythonToolHost({
    workspaceRoot,
    interpreter: provenance.executable,
    manager: jobManager,
    probe
  })
}
function executionInput(tool: PythonToolHost, code = 'print("ok")') {
  const common = { routeKey: 'route', sessionId: 'session', code }
  return {
    ...common,
    authorizationId: 'auth',
    idempotencyKey: 'key',
    request: tool.createPolicyRequest({ ...common, target: 'python.run' })
  }
}

describe('PythonToolHost', () => {
  it('requires exactly one bounded mode and contains cwd/file paths', () => {
    const workspace = root()
    const tool = host(workspace)
    expect(() =>
      tool.createPolicyRequest({ target: 'python.run', routeKey: 'r', sessionId: 's' })
    ).toThrow(/Exactly one/)
    expect(() =>
      tool.createPolicyRequest({
        target: 'python.run',
        routeKey: 'r',
        sessionId: 's',
        code: 'x',
        file: 'x.py'
      })
    ).toThrow(/Exactly one/)
    expect(() =>
      tool.createPolicyRequest({
        target: 'python.run',
        routeKey: 'r',
        sessionId: 's',
        file: '../x.py'
      })
    ).toThrow(/workspace-relative|escapes/)
    writeFileSync(path.join(workspace, 'x.txt'), 'x')
    expect(() =>
      tool.createPolicyRequest({
        target: 'python.run',
        routeKey: 'r',
        sessionId: 's',
        file: 'x.txt'
      })
    ).toThrow(/\.py/)
  })

  it('uses only fixed isolation argv and stripped minimal environment', async () => {
    const workspace = root()
    let spawned: CommandsBackgroundInput | undefined
    const tool = host(
      workspace,
      manager((input) => {
        spawned = input
      })
    )
    await tool.run(executionInput(tool))
    expect(spawned?.args?.slice(0, 4)).toEqual(['-I', '-S', '-B', '-u'])
    expect(spawned?.args).toHaveLength(5)
    expect(spawned?.env).toEqual({
      PIP_NO_INDEX: '1',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PYTHONNOUSERSITE: '1'
    })
    expect(spawned?.shell).toBe(false)
  })

  it('binds high-risk policy fields and revalidates identity before manager consumption', async () => {
    const workspace = root()
    const calls: string[] = []
    const probe = vi.fn(() => {
      calls.push('probe')
      return provenance
    })
    const jobs = manager((input) => {
      calls.push('background')
      expect(input.beforeConsume).toBeTypeOf('function')
    })
    const tool = host(workspace, jobs, probe)
    const input = executionInput(tool)
    expect(input.request.action).toBe('python.execute')
    expect(input.request.effects.map((effect) => [effect.kind, effect.risk])).toContainEqual([
      'process.execute',
      'high'
    ])
    expect(input.request.input).toMatchObject({
      interpreterSha256: provenance.sha256,
      cwd: workspace
    })
    await tool.run(input)
    expect(calls).toEqual(['probe', 'background', 'probe'])
  })

  it('fails closed when interpreter identity changes before permit/spawn', async () => {
    const workspace = root()
    let count = 0
    const tool = host(workspace, manager(), () => ({
      ...provenance,
      sha256: (++count === 1 ? 'a' : 'b').repeat(64)
    }))
    await expect(tool.run(executionInput(tool))).rejects.toThrow(/identity changed/)
  })

  it('returns durable background identity and captures only declared regular artifacts for run', async () => {
    const workspace = root()
    writeFileSync(path.join(workspace, 'result.txt'), 'value')
    const tool = host(workspace)
    const common = { routeKey: 'r', sessionId: 's', code: 'pass', artifacts: ['result.txt'] }
    const request = tool.createPolicyRequest({ ...common, target: 'python.run' })
    const result = await tool.run({ ...common, request, authorizationId: 'a', idempotencyKey: 'i' })
    expect(result.stdout).toBe('ok')
    expect(result.artifacts).toEqual([
      { path: 'result.txt', size: 5, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }
    ])
    const bgCommon = { routeKey: 'r', sessionId: 's', code: 'pass' }
    const bg = await tool.background({
      ...bgCommon,
      request: tool.createPolicyRequest({ ...bgCommon, target: 'python.background' }),
      authorizationId: 'a',
      idempotencyKey: 'b'
    })
    expect(bg.job.jobId).toMatch(/00000000/)
    expect(bg.provenance).toEqual(provenance)
  })
})
