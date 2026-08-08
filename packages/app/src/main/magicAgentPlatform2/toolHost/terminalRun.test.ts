import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  const root = path.join(
    tmpdir(),
    `magic-tool-host-${process.pid}-${workerId}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(root)
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
    const result = await new TerminalRunToolHost(authorization, {
      allowedRoots: [root],
      allowedCommands: [command]
    }).run({
      ...input(
        root,
        [
          '-e',
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)`
        ],
        authorization
      ),
      timeoutMs: 5_000
    })

    expect(result.status).toBe('timed-out')
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(existsSync(marker)).toBe(false)
  })

  it('kills the complete process tree at the bounded timeout', async () => {
    const { root, authorization } = setup('require-approval', { maxTimeoutMs: 100 })
    const marker = path.join(root, 'grandchild-late.txt')
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 700)`
    const parent = [
      "const { spawn } = require('node:child_process')",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
      'setTimeout(() => {}, 5000)'
    ].join(';')
    const result = await new TerminalRunToolHost(authorization, {
      allowedRoots: [root],
      allowedCommands: [command]
    }).run({
      ...input(root, ['-e', parent], authorization),
      timeoutMs: 5_000
    })

    expect(result.status).toBe('timed-out')
    await new Promise((resolve) => setTimeout(resolve, 850))
    expect(existsSync(marker)).toBe(false)
  })

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
