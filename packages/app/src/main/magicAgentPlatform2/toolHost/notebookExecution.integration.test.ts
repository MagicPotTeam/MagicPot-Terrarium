import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
import type { PolicyRequest, PolicyRule } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { CommandJobsToolHost, type CommandJobsSpawnProcess } from './commandJobs'
import { NotebookExecutionCoordinator, PythonNotebookExecutionBoundary } from './notebookExecution'

const roots: string[] = []
const stores: MagicAgentEventStore[] = []
const approver = { kind: 'user', id: 'notebook-integration-user' } as const
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid: number

  constructor(pid: number) {
    super()
    this.pid = pid
  }

  kill(): boolean {
    queueMicrotask(() => this.close(null, 'SIGTERM'))
    return true
  }

  unref(): void {
    // Faithful no-op for the injected child process harness.
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end()
    this.stderr.end()
    this.emit('close', code, signal)
  }
}

type SpawnCall = Readonly<{
  command: string
  args: readonly string[]
  options: SpawnOptions
  wrapper: string
  payload: string
}>

function createSpawner(result: string) {
  const calls: SpawnCall[] = []
  let nextPid = 8100
  const spawnProcess = ((
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {}
  ) => {
    const child = new FakeChildProcess(nextPid++)
    const wrapperPath = args.at(-1)!
    const wrapper = readFileSync(wrapperPath, 'utf8')
    const inputPath = JSON.parse(wrapper.match(/open\((".*"),encoding=/)![1]) as string
    calls.push({
      command,
      args: [...args],
      options,
      wrapper,
      payload: readFileSync(inputPath, 'utf8')
    })
    queueMicrotask(() => {
      child.emit('spawn')
      child.stdout.write(`${result}\n`)
      child.close(0)
    })
    return child as unknown as ChildProcess
  }) as CommandJobsSpawnProcess
  return { calls, spawnProcess }
}

function createNotebook() {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        source: ['value = 40\n'],
        execution_count: null,
        outputs: []
      },
      {
        id: 'cell-2',
        cell_type: 'code',
        metadata: {},
        source: ['value + 2'],
        execution_count: null,
        outputs: []
      }
    ]
  }
}

function setup() {
  const root = path.join(tmpdir(), `notebook-composition-${process.pid}-${Math.random()}`)
  mkdirSync(root)
  roots.push(root)
  const notebookPath = path.join(root, 'composition.ipynb')
  writeFileSync(notebookPath, JSON.stringify(createNotebook()))
  const executable = path.join(root, 'faithful-fake-python')
  writeFileSync(executable, 'not executed')
  const provenance = {
    executable,
    sha256: sha256(readFileSync(executable)),
    implementation: 'CPython',
    version: '3.integration',
    platform: process.platform
  }
  const rules: PolicyRule[] = [
    {
      ruleId: 'notebook-integration',
      priority: 1,
      effect: 'require-approval',
      explanation: 'exercise the real policy and command-host composition',
      constraints: {
        allowedRoots: [root],
        allowedToolNames: ['notebook.execute-all'],
        requireNoShell: true,
        maxTimeoutMs: 2_000,
        maxOutputChars: 64 * 1024
      },
      approvalRequirement: {
        scopeKind: 'request',
        scopeValue: '*',
        maxUses: 1,
        expiresInMs: 60_000,
        reason: 'integration test'
      }
    }
  ]
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const authorization = new MagicAgentPolicyAuthorizationService({
    store,
    rules,
    policyVersion: 'integration',
    storeId: root,
    trustedApprovers: [approver]
  })
  const result = JSON.stringify({
    protocol: 'magicpot-notebook-result.v1',
    status: 'completed',
    cells: [
      {
        cellId: 'cell-1',
        executionCount: 1,
        stdout: 'computed\n',
        stderr: '',
        displays: []
      },
      {
        cellId: 'cell-2',
        executionCount: 2,
        stdout: '',
        stderr: '',
        displays: [{ mime: 'application/json', data: { answer: 42 } }],
        result: '42'
      }
    ]
  })
  const spawner = createSpawner(result)
  const jobs = new CommandJobsToolHost(authorization, {
    workspaceRoot: root,
    allowedCommands: [executable],
    allowedEnvironmentKeys: ['PYTHONNOUSERSITE', 'PIP_NO_INDEX'],
    spawnProcess: spawner.spawnProcess
  })
  const coordinator = new NotebookExecutionCoordinator(
    authorization,
    new PythonNotebookExecutionBoundary(jobs, executable),
    { workspaceRoot: root, provenance }
  )
  return { root, notebookPath, executable, provenance, authorization, coordinator, spawner }
}

function approve(authorization: MagicAgentPolicyAuthorizationService, request: PolicyRequest) {
  const grantId = `grant-${Math.random()}`
  const now = Date.now()
  authorization.createApprovalGrant({
    grantId,
    request,
    approvedBy: approver,
    issuedAt: now,
    expiresAt: now + 60_000,
    maxUses: 1,
    idempotencyKey: grantId
  })
  return { grantId, expectedGrantUseCount: 0 }
}

function requestFor(
  coordinator: NotebookExecutionCoordinator,
  expectedSha256: string,
  expectedGeneration = 0
) {
  return coordinator.createPolicyRequest({
    target: 'notebook.execute-all',
    routeKey: 'route',
    sessionId: 'session',
    path: 'composition.ipynb',
    expectedSha256,
    expectedGeneration
  })
}

function executeInput(
  request: PolicyRequest,
  expectedSha256: string,
  approval: ReturnType<typeof approve>
) {
  return {
    authorizationId: 'authorization',
    idempotencyKey: `execution-${Math.random()}`,
    request,
    routeKey: 'route',
    sessionId: 'session',
    path: 'composition.ipynb',
    expectedSha256,
    expectedGeneration: 0,
    timeoutMs: 2_000,
    maxOutputBytes: 64 * 1024,
    ...approval
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('notebook execution production composition', () => {
  it('runs coordinator -> Python boundary -> command host with a faithful fake child process', async () => {
    const t = setup()
    const before = readFileSync(t.notebookPath)
    const expectedSha256 = sha256(before)
    const request = requestFor(t.coordinator, expectedSha256)
    const grant = approve(t.authorization, request)

    const started = await t.coordinator.executeAll(executeInput(request, expectedSha256, grant))

    expect(started.state).toBe('running')
    expect(t.spawner.calls).toHaveLength(1)
    const spawn = t.spawner.calls[0]
    expect(spawn.command).toBe(t.executable)
    expect(spawn.args.slice(0, 4)).toEqual(['-I', '-S', '-B', '-u'])
    expect(spawn.args.at(-1)).toMatch(/\.wrapper\.py$/)
    expect(spawn.options).toMatchObject({
      cwd: t.root,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expect(spawn.payload).toContain('magicpot-notebook-input.v1')
    expect(spawn.wrapper).toContain("ast.parse(c['source']")

    await new Promise<void>((resolve) => setImmediate(resolve))
    const done = t.coordinator.status({
      routeKey: 'route',
      sessionId: 'session',
      path: 'composition.ipynb',
      executionId: started.executionId
    })

    expect(done.error).toBeUndefined()
    expect(done.state).toBe('completed-applied')
    const applied = JSON.parse(readFileSync(t.notebookPath, 'utf8'))
    expect(applied.cells[0]).toMatchObject({
      execution_count: 1,
      outputs: [{ name: 'stdout', output_type: 'stream', text: ['computed\n'] }]
    })
    expect(applied.cells[1].execution_count).toBe(2)
    expect(applied.cells[1].outputs).toEqual([
      { data: { 'application/json': { answer: 42 } }, metadata: {}, output_type: 'display_data' },
      {
        data: { 'text/plain': '42' },
        execution_count: 2,
        metadata: {},
        output_type: 'execute_result'
      }
    ])
    expect(readdirSync(path.dirname(t.notebookPath))).not.toContain(
      expect.stringMatching(/composition\.ipynb\..*\.tmp$/)
    )

    const nextSha = sha256(readFileSync(t.notebookPath))
    const secondRequest = requestFor(t.coordinator, nextSha, 1)
    await expect(
      t.coordinator.executeAll({
        ...executeInput(secondRequest, nextSha, grant),
        expectedGeneration: 1
      })
    ).rejects.toThrow()
    expect(t.spawner.calls).toHaveLength(1)
  })

  it('rejects tampered interpreter and notebook bindings before command-host spawn', async () => {
    const t = setup()
    const expectedSha256 = sha256(readFileSync(t.notebookPath))
    const request = requestFor(t.coordinator, expectedSha256)
    const grant = approve(t.authorization, request)
    const input = executeInput(request, expectedSha256, grant)
    const tamperedInterpreter = {
      ...request,
      input: { ...request.input, interpreterSha256: 'f'.repeat(64) }
    }

    await expect(
      t.coordinator.executeAll({ ...input, request: tamperedInterpreter })
    ).rejects.toThrow('Policy request does not match notebook execution')

    const tamperedNotebook = {
      ...request,
      input: { ...request.input, expectedSha256: 'e'.repeat(64) }
    }
    await expect(
      t.coordinator.executeAll({
        ...input,
        idempotencyKey: 'tampered-notebook',
        request: tamperedNotebook
      })
    ).rejects.toThrow('Policy request does not match notebook execution')
    expect(t.spawner.calls).toHaveLength(0)
  })
})
