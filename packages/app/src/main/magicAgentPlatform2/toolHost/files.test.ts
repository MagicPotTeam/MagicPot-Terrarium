import { createHash } from 'node:crypto'
import {
  promises as fs,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFilesToolPolicyRequest, type PolicyRule } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService, PermitConsumedError } from '../policy'
import { FilesToolHost, FilesToolValidationError, type FilesToolAuditEvidence } from '.'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const roots: string[] = []
const stores: MagicAgentEventStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = path.join(
    tmpdir(),
    `magic-files-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(root)
  roots.push(root)
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const rule: PolicyRule = {
    ruleId: 'files',
    priority: 1,
    effect: 'allow-with-constraints',
    explanation: 'test',
    constraints: {
      readOnly: true,
      allowedRoots: [root],
      allowedToolNames: ['files.tree', 'files.read', 'files.glob', 'files.grep', 'files.json.read']
    }
  }
  const authorization = new MagicAgentPolicyAuthorizationService({
    store,
    rules: [rule],
    policyVersion: 'test',
    storeId: 'test',
    trustedApprovers: [{ kind: 'user', id: 'approver' }]
  })
  return { root, authorization }
}

function createFilesHost(
  authorization: MagicAgentPolicyAuthorizationService,
  root: string,
  onAudit?: (evidence: FilesToolAuditEvidence) => void | Promise<void>
) {
  return FilesToolHost.create(authorization, {
    allowedRoots: [root],
    ...(onAudit ? { onAudit } : {})
  })
}

function call<TInput extends Record<string, unknown>>(
  tool: 'files.read' | 'files.glob' | 'files.grep' | 'files.json.read',
  input: TInput,
  authorization: MagicAgentPolicyAuthorizationService
) {
  const action =
    tool === 'files.glob'
      ? 'filesystem.list'
      : tool === 'files.grep'
        ? 'filesystem.search'
        : 'filesystem.read'
  const requestedPath = typeof input.path === 'string' ? input.path : '.'
  const request = createFilesToolPolicyRequest({
    requestId: `request-${Math.random()}`,
    actor: { kind: 'agent', id: 'agent' },
    target: { kind: 'tool', id: tool },
    action,
    toolInput: { path: requestedPath },
    filesystem: { paths: [requestedPath] }
  })
  return {
    authorizationId: `auth-${Math.random()}`,
    idempotencyKey: `call-${Math.random()}`,
    request,
    input
  }
}

function writeSetup() {
  const base = setup()
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const rule: PolicyRule = {
    ruleId: 'write',
    priority: 2,
    effect: 'allow-with-constraints',
    explanation: 'write test',
    constraints: {
      allowedRoots: [base.root],
      allowedToolNames: [
        'files.write',
        'files.edit',
        'files.patch',
        'files.multi-edit',
        'files.json.write',
        'files.diff',
        'files.snapshot.list',
        'files.snapshot.restore'
      ]
    }
  }
  return {
    root: base.root,
    authorization: new MagicAgentPolicyAuthorizationService({
      store,
      rules: [rule],
      policyVersion: 'test',
      storeId: 'write-test',
      trustedApprovers: [{ kind: 'user', id: 'approver' }]
    })
  }
}
function mutationCall<TInput extends Record<string, unknown>>(
  tool:
    | 'files.write'
    | 'files.edit'
    | 'files.patch'
    | 'files.multi-edit'
    | 'files.json.write'
    | 'files.snapshot.restore',
  input: TInput,
  authorization: MagicAgentPolicyAuthorizationService
) {
  const requestedPath = tool === 'files.multi-edit' ? '.' : String(input.path)
  const request = createFilesToolPolicyRequest({
    requestId: `request-${Math.random()}`,
    actor: { kind: 'agent', id: 'agent' },
    target: { kind: 'tool', id: tool },
    action: 'filesystem.write',
    toolInput: { path: requestedPath },
    filesystem: {
      paths:
        tool === 'files.multi-edit'
          ? (input.edits as Array<{ path: string }>).map((edit) => edit.path)
          : [requestedPath]
    }
  })
  const now = Date.now()
  const grantId = `grant-${Math.random()}`
  authorization.createApprovalGrant({
    grantId,
    request,
    approvedBy: { kind: 'user', id: 'approver' },
    issuedAt: now,
    expiresAt: now + 60_000,
    maxUses: 1,
    idempotencyKey: `grant-call-${Math.random()}`
  })
  return {
    authorizationId: `auth-${Math.random()}`,
    idempotencyKey: `call-${Math.random()}`,
    request,
    input,
    grantId,
    expectedGrantUseCount: 0
  }
}
function readCall<TInput extends Record<string, unknown>>(
  tool: 'files.diff' | 'files.snapshot.list',
  input: TInput
) {
  const requestedPath = typeof input.path === 'string' ? input.path : '.'
  return {
    authorizationId: `auth-${Math.random()}`,
    idempotencyKey: `call-${Math.random()}`,
    request: createFilesToolPolicyRequest({
      requestId: `request-${Math.random()}`,
      actor: { kind: 'agent', id: 'agent' },
      target: { kind: 'tool', id: tool },
      action: tool === 'files.snapshot.list' ? 'filesystem.list' : 'filesystem.read',
      toolInput: { path: requestedPath },
      filesystem: { paths: [requestedPath] }
    }),
    input
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')

describe('same-file edit modes retain failures and exact occurrence guards', () => {
  it.each(['partial', 'best_effort'] as const)(
    '%s cancelling accepted transforms to the original bytes emits no mutation',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      await fs.writeFile(path.join(root, 'edit.txt'), 'a')
      const error = await host
        .edit(
          mutationCall(
            'files.edit',
            {
              path: 'edit.txt',
              expectedSha256: digest('a'),
              mode,
              replacements: [
                { old: 'a', new: 'A', expectedOccurrences: 1 },
                { old: 'A', new: 'a', expectedOccurrences: 1 },
                { old: 'absent', new: 'b', expectedOccurrences: 1 }
              ]
            },
            authorization
          )
        )
        .catch((error) => error)
      expect(error).toMatchObject({
        code: 'MAGIC_AGENT_FILES_EDIT_FAILED',
        report: {
          mode,
          applied: 2,
          failed: 1,
          skipped: 0,
          writeStatus: 'not-written',
          fileChanged: false
        }
      })
      expect(error).not.toHaveProperty('mutation')
      expect(consume).not.toHaveBeenCalled()
      expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe('a')
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['strict', 'partial', 'best_effort'] as const)(
    '%s successful no-change retains the original approved snapshot contract',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      await fs.writeFile(path.join(root, 'edit.txt'), 'a')
      const result = await host.edit(
        mutationCall(
          'files.edit',
          {
            path: 'edit.txt',
            expectedSha256: digest('a'),
            mode,
            replacements: [{ old: 'a', new: 'a', expectedOccurrences: 1 }]
          },
          authorization
        )
      )
      expect(result).toMatchObject({
        beforeSha256: digest('a'),
        afterSha256: digest('a'),
        report: {
          mode,
          applied: 1,
          failed: 0,
          skipped: 0,
          writeStatus: 'committed',
          fileChanged: false,
          steps: [{ index: 0, status: 'unchanged', observedOccurrences: 1, expectedOccurrences: 1 }]
        }
      })
      expect(
        await fs.readFile(
          path.join(root, '.magicpot', 'tool-host', 'snapshots', result.snapshotId, 'content'),
          'utf8'
        )
      ).toBe('a')
    }
  )

  it.each(['partial', 'best_effort'] as const)(
    '%s deadline after snapshot does not commit or manufacture a match-failure receipt',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const audits: FilesToolAuditEvidence[] = []
      const host = await createFilesHost(authorization, root, (audit) => {
        audits.push(audit)
      })
      await fs.writeFile(path.join(root, 'edit.txt'), 'a')
      const call = mutationCall(
        'files.edit',
        {
          path: 'edit.txt',
          expectedSha256: digest('a'),
          mode,
          timeoutMs: 10_000,
          replacements: [
            { old: 'a', new: 'A', expectedOccurrences: 1 },
            { old: 'absent', new: 'b', expectedOccurrences: 1 }
          ]
        },
        authorization
      )
      const now = Date.now(),
        clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      const realWrite = fs.writeFile.bind(fs)
      const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const result = await realWrite(...args)
        if (String(args[0]).endsWith('manifest.json')) clock.mockReturnValue(now + 10_001)
        return result
      })
      try {
        const error = await host.edit(call).catch((error) => error)
        expect(error).toBeInstanceOf(FilesToolValidationError)
        expect(error.message).toBe('File tool runtime limit exceeded.')
        expect(error).not.toHaveProperty('report')
        expect(error).not.toHaveProperty('mutation')
        expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe('a')
        expect(audits.at(-1)).toMatchObject({ outcome: 'rejected', mutationUncertain: true })
        expect(audits.at(-1)).not.toHaveProperty('editWriteStatus')
      } finally {
        write.mockRestore()
        clock.mockRestore()
      }
    }
  )

  it.each(['strict', 'partial', 'best_effort'] as const)(
    '%s success retains ordered buffer visibility, exact counts and unchanged steps',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const before = 'aa aa\r\n',
        after = 'complete\r\n'
      await fs.writeFile(path.join(root, 'edit.txt'), before)
      const result = await host.edit(
        mutationCall(
          'files.edit',
          {
            path: 'edit.txt',
            expectedSha256: digest(before),
            mode,
            replacements: [
              { old: 'aa', new: 'x', expectedOccurrences: 2 },
              { old: 'x x', new: 'complete', expectedOccurrences: 1 },
              { old: 'complete', new: 'complete', expectedOccurrences: 1 }
            ]
          },
          authorization
        )
      )
      expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe(after)
      expect(result).toMatchObject({
        beforeSha256: digest(before),
        afterSha256: digest(after),
        report: {
          mode,
          applied: 3,
          failed: 0,
          skipped: 0,
          writeStatus: 'committed',
          fileChanged: true
        }
      })
      expect(result.report.steps.map((step) => step.status)).toEqual([
        'applied',
        'applied',
        'unchanged'
      ])
    }
  )

  it.each(['strict', 'partial', 'best_effort'] as const)(
    '%s never turns stale CAS, intermediate/result size or diff budget into a partial write',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      const before = 'old old\n'
      await fs.writeFile(path.join(root, 'edit.txt'), before)
      const base = {
        path: 'edit.txt',
        expectedSha256: digest(before),
        mode,
        replacements: [{ old: 'old', new: 'new', expectedOccurrences: 2 }]
      }
      for (const invalid of [
        { ...base, expectedSha256: '0'.repeat(64) },
        { ...base, maxDiffBytes: 1 },
        {
          ...base,
          maxBytes: Buffer.byteLength(before),
          replacements: [
            { old: 'old', new: 'x'.repeat(20), expectedOccurrences: 2 },
            { old: 'x'.repeat(20), new: 'ok', expectedOccurrences: 2 }
          ]
        },
        {
          ...base,
          replacements: [
            ...base.replacements,
            { old: 'not present', new: 'x', expectedOccurrences: 1 },
            { old: 'new', new: '\0', expectedOccurrences: 2 }
          ],
          mode: 'best_effort' as const
        }
      ]) {
        await expect(
          host.edit(mutationCall('files.edit', invalid, authorization))
        ).rejects.toBeInstanceOf(FilesToolValidationError)
        expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe(before)
        expect(consume).not.toHaveBeenCalled()
        await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
      }
    }
  )

  it.each(['partial', 'best_effort'] as const)(
    '%s consumes one permit once for a known partial commit and rejects its replay',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      await fs.writeFile(path.join(root, 'edit.txt'), 'a')
      const input = {
        path: 'edit.txt',
        expectedSha256: digest('a'),
        mode,
        replacements: [
          { old: 'a', new: 'A', expectedOccurrences: 1 },
          { old: 'absent', new: 'b', expectedOccurrences: 1 }
        ]
      }
      const call = mutationCall('files.edit', input, authorization)
      await expect(host.edit(call)).rejects.toMatchObject({
        code: 'MAGIC_AGENT_FILES_EDIT_FAILED',
        report: { writeStatus: 'committed' }
      })
      expect(consume).toHaveBeenCalledOnce()
      await expect(
        host.edit({ ...call, authorizationId: 'replay', idempotencyKey: 'replay' })
      ).rejects.toThrow()
      expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe('A')
      expect(consume).toHaveBeenCalledOnce()
    }
  )

  it.each(['partial', 'best_effort'] as const)(
    '%s cancellation after snapshot preserves original bytes without a fabricated normal edit failure',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const audits: FilesToolAuditEvidence[] = []
      const host = await createFilesHost(authorization, root, (audit) => {
        audits.push(audit)
      })
      const controller = new AbortController()
      const before = 'a'
      await fs.writeFile(path.join(root, 'edit.txt'), before)
      const realWrite = fs.writeFile.bind(fs)
      const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const result = await realWrite(...args)
        if (String(args[0]).endsWith('manifest.json')) controller.abort()
        return result
      })
      try {
        const error = await host
          .edit({
            ...mutationCall(
              'files.edit',
              {
                path: 'edit.txt',
                expectedSha256: digest(before),
                mode,
                replacements: [
                  { old: 'a', new: 'A', expectedOccurrences: 1 },
                  { old: 'absent', new: 'b', expectedOccurrences: 1 }
                ]
              },
              authorization
            ),
            signal: controller.signal
          })
          .catch((error) => error)
        expect(error).toMatchObject({ name: 'AbortError' })
        expect(error).not.toHaveProperty('report')
        expect(error).not.toHaveProperty('mutation')
        expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe(before)
        expect(audits.at(-1)).toMatchObject({ outcome: 'cancelled', mutationUncertain: true })
        expect(audits.at(-1)).not.toHaveProperty('editWriteStatus')
      } finally {
        write.mockRestore()
      }
    }
  )

  it.each(['partial', 'best_effort'] as const)(
    '%s rename failure remains unknown rather than a fabricated committed match-failure receipt',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const audits: FilesToolAuditEvidence[] = []
      const host = await createFilesHost(authorization, root, (audit) => {
        audits.push(audit)
      })
      await fs.writeFile(path.join(root, 'edit.txt'), 'a')
      const rename = vi
        .spyOn(fs, 'rename')
        .mockRejectedValueOnce(new Error('injected edit commit failure'))
      try {
        const error = await host
          .edit(
            mutationCall(
              'files.edit',
              {
                path: 'edit.txt',
                expectedSha256: digest('a'),
                mode,
                replacements: [
                  { old: 'a', new: 'A', expectedOccurrences: 1 },
                  { old: 'absent', new: 'b', expectedOccurrences: 1 }
                ]
              },
              authorization
            )
          )
          .catch((error) => error)
        expect(error.message).toContain('injected edit commit failure')
        expect(error).not.toHaveProperty('report')
        expect(error).not.toHaveProperty('mutation')
        expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe('a')
        expect(audits.at(-1)).toMatchObject({ outcome: 'rejected', mutationUncertain: true })
        expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
      } finally {
        rename.mockRestore()
      }
    }
  )

  it.each([null, false, '', 'STRICT', 'best-effort', 0, {}])(
    'rejects invalid direct-host mode %j rather than silently enabling relaxed matching',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      await fs.writeFile(path.join(root, 'edit.txt'), 'a')
      const input = {
        path: 'edit.txt',
        expectedSha256: digest('a'),
        mode,
        replacements: [{ old: 'a', new: 'A', expectedOccurrences: 1 }]
      }
      await expect(
        host.edit(mutationCall('files.edit', input, authorization) as never)
      ).rejects.toBeInstanceOf(FilesToolValidationError)
      expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe('a')
    }
  )

  it.each([
    {
      mode: 'strict',
      after: 'a b a\n',
      applied: 1,
      skipped: 2,
      statuses: ['applied', 'failed', 'skipped', 'skipped']
    },
    {
      mode: 'partial',
      after: 'A b A\n',
      applied: 1,
      skipped: 2,
      statuses: ['applied', 'failed', 'skipped', 'skipped']
    },
    {
      mode: 'best_effort',
      after: 'Z b Z\n',
      applied: 3,
      skipped: 0,
      statuses: ['applied', 'failed', 'applied', 'unchanged']
    }
  ] as const)(
    'ordered $mode reports failed evaluation separately from actual commit',
    async ({ mode, after, applied, skipped, statuses }) => {
      const { root, authorization } = writeSetup()
      const audits: FilesToolAuditEvidence[] = []
      const host = await createFilesHost(authorization, root, (audit) => {
        audits.push(audit)
      })
      const before = 'a b a\n',
        target = path.join(root, 'edit.txt')
      await fs.writeFile(target, before)
      const input = {
        path: 'edit.txt',
        expectedSha256: digest(before),
        mode,
        replacements: [
          { old: 'a', new: 'A', expectedOccurrences: 2 },
          { old: 'missing', new: 'X', expectedOccurrences: 1 },
          { old: 'A', new: 'Z', expectedOccurrences: 2 },
          { old: 'b', new: 'b', expectedOccurrences: 1 }
        ]
      }
      const error = await host
        .edit(mutationCall('files.edit', input, authorization))
        .catch((error) => error)
      expect(error).toMatchObject({
        code: 'MAGIC_AGENT_FILES_EDIT_FAILED',
        report: {
          mode,
          applied,
          failed: 1,
          skipped,
          writeStatus: mode === 'strict' ? 'not-written' : 'committed',
          fileChanged: mode !== 'strict'
        }
      })
      expect(error.report.steps.map((step: { status: string }) => step.status)).toEqual(statuses)
      expect(error.report.steps[1]).toMatchObject({
        index: 1,
        observedOccurrences: 0,
        expectedOccurrences: 1
      })
      expect(await fs.readFile(target, 'utf8')).toBe(after)
      expect(audits.at(-1)).toMatchObject({
        outcome: 'rejected',
        editMode: mode,
        editApplied: applied,
        editFailed: 1,
        editSkipped: skipped
      })
      if (mode === 'strict') {
        expect(error).not.toHaveProperty('mutation')
        await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
      } else {
        expect(error.mutation).toMatchObject({
          beforeSha256: digest(before),
          afterSha256: digest(after),
          path: 'edit.txt'
        })
        expect(error.mutation.diff).toContain(after.trim())
        expect(
          await fs.readFile(
            path.join(
              root,
              '.magicpot',
              'tool-host',
              'snapshots',
              error.mutation.snapshotId,
              'content'
            ),
            'utf8'
          )
        ).toBe(before)
      }
    }
  )

  it.each(['partial', 'best_effort'] as const)(
    '%s with no accepted change never manufactures a committed receipt',
    async (mode) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      await fs.writeFile(path.join(root, 'edit.txt'), 'old old')
      const error = await host
        .edit(
          mutationCall(
            'files.edit',
            {
              path: 'edit.txt',
              expectedSha256: digest('old old'),
              mode,
              replacements: [{ old: 'old', new: 'new', expectedOccurrences: 1 }]
            },
            authorization
          )
        )
        .catch((error) => error)
      expect(error).toMatchObject({
        code: 'MAGIC_AGENT_FILES_EDIT_FAILED',
        report: {
          mode,
          applied: 0,
          failed: 1,
          skipped: 0,
          writeStatus: 'not-written',
          fileChanged: false
        }
      })
      expect(error.report.steps[0]).toMatchObject({
        observedOccurrences: 2,
        expectedOccurrences: 1
      })
      expect(error).not.toHaveProperty('mutation')
      expect(await fs.readFile(path.join(root, 'edit.txt'), 'utf8')).toBe('old old')
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
})

function pdfWithStream(text: string, options?: { filter?: string; metadata?: string }): Buffer {
  const stream = `BT (${text}) Tj ET`
  const data =
    options?.filter === 'FlateDecode' ? deflateSync(Buffer.from(stream)) : Buffer.from(stream)
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< ${options?.metadata ?? ''} >>\nendobj\n2 0 obj\n<< /Length ${data.length}${options?.filter ? ` /Filter /${options.filter}` : ''} >>\nstream\n`
    ),
    data,
    Buffer.from('\nendstream\nendobj\n%%EOF\n')
  ])
}

describe('FilesToolHost bounded media reads', () => {
  it('keeps text compatibility and reads magic-verified images without auditing payloads', async () => {
    const { root, authorization } = setup()
    const audits: FilesToolAuditEvidence[] = []
    const host = await createFilesHost(authorization, root, (audit) => void audits.push(audit))
    writeFileSync(path.join(root, 'plain.txt'), 'legacy text')
    const text = await host.read(call('files.read', { path: 'plain.txt' }, authorization) as never)
    expect(text).toMatchObject({
      kind: 'text',
      content: 'legacy text',
      returnedBytes: 11,
      truncated: false
    })

    const png = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from('0000000d49484452', 'hex'),
      Buffer.from('0000000200000003', 'hex'),
      Buffer.alloc(32)
    ])
    writeFileSync(path.join(root, 'image.bin'), png)
    const image = await host.read(
      call('files.read', { path: 'image.bin', maxBytes: 32 }, authorization) as never
    )
    expect(image).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      width: 2,
      height: 3,
      bytes: png.length,
      returnedBytes: 32,
      truncated: true
    })
    expect(image.kind === 'image' && Buffer.from(image.base64, 'base64')).toEqual(
      png.subarray(0, 32)
    )
    expect(JSON.stringify(audits)).not.toContain('base64')
    expect(JSON.stringify(audits)).not.toContain(png.subarray(0, 32).toString('base64'))
  })

  it('rejects extension spoofing and unknown binaries', async () => {
    const { root, authorization } = setup()
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    writeFileSync(path.join(root, 'spoof.png'), 'not an image')
    writeFileSync(path.join(root, 'unknown.bin'), Buffer.from([0, 1, 2, 3]))
    await expect(
      host.read(call('files.read', { path: 'spoof.png' }, authorization) as never)
    ).rejects.toThrow('magic signature')
    await expect(
      host.read(call('files.read', { path: 'unknown.bin' }, authorization) as never)
    ).rejects.toThrow('Unknown binary')
  })

  it('extracts bounded PDF metadata and Flate text with redaction and truthful indicators', async () => {
    const { root, authorization } = setup()
    const audits: FilesToolAuditEvidence[] = []
    const host = await createFilesHost(authorization, root, (audit) => void audits.push(audit))
    writeFileSync(
      path.join(root, 'safe.pdf'),
      pdfWithStream('token=supersecret hello', {
        filter: 'FlateDecode',
        metadata: '/Title (password=hunter2 report)'
      })
    )
    const output = await host.read(call('files.read', { path: 'safe.pdf' }, authorization) as never)
    expect(output).toMatchObject({
      kind: 'pdf',
      encrypted: false,
      incomplete: false,
      unsupportedFilters: []
    })
    expect(output.kind === 'pdf' && output.content).toContain('token=[REDACTED]')
    expect(output.kind === 'pdf' && output.metadata.Title).toContain('password=[REDACTED]')
    expect(JSON.stringify(audits)).not.toContain('supersecret')
    expect(JSON.stringify(audits)).not.toContain('hunter2')

    writeFileSync(
      path.join(root, 'unsupported.pdf'),
      pdfWithStream('hidden', { filter: 'LZWDecode' })
    )
    const unsupported = await host.read(
      call('files.read', { path: 'unsupported.pdf' }, authorization) as never
    )
    expect(unsupported).toMatchObject({
      kind: 'pdf',
      incomplete: true,
      unsupportedFilters: ['LZWDecode']
    })
  })

  it('bounds malicious PDF decompression output', async () => {
    const { root, authorization } = setup()
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    writeFileSync(
      path.join(root, 'bomb.pdf'),
      pdfWithStream('A'.repeat(2_000_000), { filter: 'FlateDecode' })
    )
    const output = await host.read(
      call('files.read', { path: 'bomb.pdf', maxStringLength: 128 }, authorization) as never
    )
    expect(output).toMatchObject({ kind: 'pdf', incomplete: true })
    expect(output.kind === 'pdf' && output.content.length).toBeLessThanOrEqual(128)
  })
})

describe('FilesToolHost writable slice', () => {
  it.each([true, false].flatMap((oldLf) => [true, false].map((newLf) => ({ oldLf, newLf }))))(
    'complete-file EOF marker preserves oldLF=$oldLf newLF=$newLf independently',
    async ({ oldLf, newLf }) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const before = `old${oldLf ? '\n' : ''}`,
        after = `new${newLf ? '\n' : ''}`
      await fs.writeFile(path.join(root, 'eof.txt'), before)
      const marker = '\\ No newline at end of file'
      const patch = [
        '--- a/eof.txt',
        '+++ b/eof.txt',
        '@@ -1,1 +1,1 @@',
        '-old',
        ...(!oldLf ? [marker] : []),
        '+new',
        ...(!newLf ? [marker] : []),
        ''
      ].join('\n')
      const result = await host.patch(
        mutationCall(
          'files.patch',
          { path: 'eof.txt', expectedSha256: digest(before), patch },
          authorization
        )
      )
      expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe(after)
      expect(result).toMatchObject({
        beforeSha256: digest(before),
        afterSha256: digest(after),
        bytes: Buffer.byteLength(after)
      })
      expect(
        await fs.readFile(
          path.join(root, '.magicpot', 'tool-host', 'snapshots', result.snapshotId, 'content'),
          'utf8'
        )
      ).toBe(before)
    }
  )

  it.each([true, false].flatMap((lf) => [true, false].map((deleting) => ({ lf, deleting }))))(
    'complete-file EOF marker represents exact empty side deleting=$deleting LF=$lf',
    async ({ lf, deleting }) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const text = `line${lf ? '\n' : ''}`,
        before = deleting ? text : '',
        after = deleting ? '' : text
      await fs.writeFile(path.join(root, 'eof.txt'), before)
      const patch = [
        '--- a/eof.txt',
        '+++ b/eof.txt',
        `@@ -1,${deleting ? 1 : 0} +1,${deleting ? 0 : 1} @@`,
        `${deleting ? '-' : '+'}line`,
        ...(!lf ? ['\\ No newline at end of file'] : []),
        ''
      ].join('\n')
      const result = await host.patch(
        mutationCall(
          'files.patch',
          { path: 'eof.txt', expectedSha256: digest(before), patch },
          authorization
        )
      )
      expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe(after)
      expect(result).toMatchObject({
        beforeSha256: digest(before),
        afterSha256: digest(after),
        bytes: Buffer.byteLength(after)
      })
    }
  )

  it.each([
    {
      label: 'orphan',
      before: 'old',
      count: 1,
      body: ['\\ No newline at end of file', '-old', '+new']
    },
    {
      label: 'duplicate',
      before: 'old',
      count: 1,
      body: ['-old', '\\ No newline at end of file', '\\ No newline at end of file', '+new']
    },
    {
      label: 'old-side nonEOF',
      before: 'old\ntail',
      count: 2,
      body: ['-old', '\\ No newline at end of file', '+new', ' tail']
    },
    {
      label: 'new-side nonEOF',
      before: 'old\ntail',
      count: 2,
      body: ['-old', '+new', '\\ No newline at end of file', ' tail']
    },
    { label: 'raw interior blank', before: 'old\n', count: 1, body: ['-old', '', '+new'] }
  ])(
    'complete-file EOF marker rejects $label before permit/snapshot/write',
    async ({ before, count, body }) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      await fs.writeFile(path.join(root, 'eof.txt'), before)
      const patch = [
        '--- a/eof.txt',
        '+++ b/eof.txt',
        `@@ -1,${count} +1,${count} @@`,
        ...body,
        ''
      ].join('\n')
      await expect(
        host.patch(
          mutationCall(
            'files.patch',
            { path: 'eof.txt', expectedSha256: digest(before), patch },
            authorization
          )
        )
      ).rejects.toBeInstanceOf(FilesToolValidationError)
      expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe(before)
      expect(consume).not.toHaveBeenCalled()
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each([true, false].flatMap((lf) => [true, false].map((deleting) => ({ lf, deleting }))))(
    'complete-file EOF marker supports standard zero-origin empty range deleting=$deleting LF=$lf',
    async ({ lf, deleting }) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const text = `line${lf ? '\n' : ''}`,
        before = deleting ? text : '',
        after = deleting ? '' : text
      await fs.writeFile(path.join(root, 'eof.txt'), before)
      const patch = [
        '--- a/eof.txt',
        '+++ b/eof.txt',
        `@@ -${deleting ? '1,1' : '0,0'} +${deleting ? '0,0' : '1,1'} @@`,
        `${deleting ? '-' : '+'}line`,
        ...(!lf ? ['\\ No newline at end of file'] : []),
        ''
      ].join('\n')
      const result = await host.patch(
        mutationCall(
          'files.patch',
          { path: 'eof.txt', expectedSha256: digest(before), patch },
          authorization
        )
      )
      expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe(after)
      expect(result).toMatchObject({
        beforeSha256: digest(before),
        afterSha256: digest(after),
        bytes: Buffer.byteLength(after)
      })
    }
  )

  it.each([
    {
      label: 'old nonempty zero origin',
      before: 'old\n',
      header: '@@ -0,1 +1,1 @@',
      body: ['-old', '+new']
    },
    {
      label: 'new nonempty zero origin',
      before: 'old\n',
      header: '@@ -1,1 +0,1 @@',
      body: ['-old', '+new']
    },
    {
      label: 'out-of-range origin',
      before: 'old\n',
      header: '@@ -2,1 +1,1 @@',
      body: ['-old', '+new']
    },
    {
      label: 'empty non-terminated old line',
      before: '',
      header: '@@ -1,1 +1,1 @@',
      body: ['-', '\\ No newline at end of file', '+new']
    },
    {
      label: 'empty non-terminated new line',
      before: 'old\n',
      header: '@@ -1,1 +1,1 @@',
      body: ['-old', '+', '\\ No newline at end of file']
    }
  ])(
    'complete-file EOF marker rejects impossible $label before permit/write',
    async ({ before, header, body }) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      await fs.writeFile(path.join(root, 'eof.txt'), before)
      const patch = ['--- a/eof.txt', '+++ b/eof.txt', header, ...body, ''].join('\n')
      await expect(
        host.patch(
          mutationCall(
            'files.patch',
            { path: 'eof.txt', expectedSha256: digest(before), patch },
            authorization
          )
        )
      ).rejects.toBeInstanceOf(FilesToolValidationError)
      expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe(before)
      expect(consume).not.toHaveBeenCalled()
    }
  )

  it.each([
    {
      before: 'old',
      after: 'new\n',
      header: '@@ -1 +1 @@',
      body: ['-old', '\\ No newline at end of file', '+new']
    },
    {
      before: 'old\n',
      after: 'new',
      header: '@@ -1 +1 @@',
      body: ['-old', '+new', '\\ No newline at end of file']
    },
    { before: '', after: 'line\n', header: '@@ -0,0 +1 @@', body: ['+line'] },
    { before: 'line\n', after: '', header: '@@ -1 +0,0 @@', body: ['-line'] }
  ])(
    'complete-file EOF marker accepts omitted single-line counts $header',
    async ({ before, after, header, body }) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      await fs.writeFile(path.join(root, 'eof.txt'), before)
      const patch = ['--- a/eof.txt', '+++ b/eof.txt', header, ...body, ''].join('\n')
      const result = await host.patch(
        mutationCall(
          'files.patch',
          { path: 'eof.txt', expectedSha256: digest(before), patch },
          authorization
        )
      )
      expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe(after)
      expect(result).toMatchObject({ beforeSha256: digest(before), afterSha256: digest(after) })
    }
  )

  it.each([
    { label: 'result bytes', extra: { maxBytes: 3 }, message: 'Result exceeds the byte limit.' },
    {
      label: 'generated diff bytes',
      extra: { maxDiffBytes: 1 },
      message: 'Pre-write diff exceeds the byte limit.'
    },
    {
      label: 'existing bytes',
      extra: { maxBytes: 2 },
      message: 'Existing file exceeds the byte limit.'
    }
  ])(
    'complete-file EOF marker retains $label bound before permit/snapshot/write',
    async ({ extra, message }) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      await fs.writeFile(path.join(root, 'eof.txt'), 'old')
      const patch =
        '--- a/eof.txt\n+++ b/eof.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+longer\n'
      await expect(
        host.patch(
          mutationCall(
            'files.patch',
            { path: 'eof.txt', expectedSha256: digest('old'), patch, ...extra },
            authorization
          )
        )
      ).rejects.toThrow(message)
      expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe('old')
      expect(consume).not.toHaveBeenCalled()
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['pre-abort', 'staged-abort', 'deadline', 'rename', 'audit-after-commit'] as const)(
    'complete-file EOF marker retains %s boundary without fabricated mutation receipt',
    async (ending) => {
      const { root, authorization } = writeSetup()
      const audits: FilesToolAuditEvidence[] = []
      const host = await createFilesHost(authorization, root, (audit) => {
        audits.push(audit)
        if (ending === 'audit-after-commit' && audit.outcome === 'completed')
          throw Error('injected audit after commit failure')
      })
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      const controller = new AbortController()
      const patch =
        '--- a/eof.txt\n+++ b/eof.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n'
      await fs.writeFile(path.join(root, 'eof.txt'), 'old')
      const call = {
        ...mutationCall(
          'files.patch',
          { path: 'eof.txt', expectedSha256: digest('old'), patch, timeoutMs: 10_000 },
          authorization
        ),
        signal: controller.signal
      }
      // Freeze only after the real approval grant was issued; moving the clock
      // backwards would test invalid approval time instead of the intended I/O edge.
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      const originalWrite = fs.writeFile.bind(fs),
        originalOpen = fs.open.bind(fs),
        originalRename = fs.rename.bind(fs)
      const write = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
        const result = await originalWrite(...args)
        if (ending === 'deadline' && String(args[0]).endsWith('manifest.json'))
          clock.mockReturnValue(now + 10_001)
        return result
      })
      const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await originalOpen(...args)
        if (ending === 'staged-abort' && String(args[0]).endsWith('.tmp'))
          controller.abort(Error('staged patch cancelled'))
        return handle
      })
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
        // Host canonicalization may change the temporary root's Windows spelling.
        // This isolated host call has only one target rename, with this exact name.
        if (ending === 'rename' && path.basename(String(args[1])) === 'eof.txt')
          throw Error('injected patch rename failure')
        return originalRename(...args)
      })
      try {
        if (ending === 'pre-abort') controller.abort(Error('patch cancelled before execution'))
        const error = await host.patch(call).catch((error) => error)
        if (ending === 'rename') expect(rename).toHaveBeenCalledOnce()
        expect(error).toBeInstanceOf(Error)
        const expected = {
          'pre-abort': 'patch cancelled before execution',
          'staged-abort': 'staged patch cancelled',
          deadline: 'File tool runtime limit exceeded.',
          rename: 'injected patch rename failure',
          'audit-after-commit': 'injected audit after commit failure'
        }[ending]
        expect(error.message).toBe(expected)
        expect(error).not.toHaveProperty('mutation')
        expect(error).not.toHaveProperty('report')
        expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe(
          ending === 'audit-after-commit' ? 'new\n' : 'old'
        )
        expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
        expect(consume).toHaveBeenCalledTimes(ending === 'pre-abort' ? 0 : 1)
        if (ending === 'pre-abort')
          await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({
            code: 'ENOENT'
          })
        else {
          expect(audits.at(-1)).toMatchObject({ tool: 'files.patch', mutationUncertain: true })
          const snapshots = await fs.readdir(path.join(root, '.magicpot', 'tool-host', 'snapshots'))
          expect(snapshots).toHaveLength(1)
          expect(
            await fs.readFile(
              path.join(root, '.magicpot', 'tool-host', 'snapshots', snapshots[0], 'content'),
              'utf8'
            )
          ).toBe('old')
        }
      } finally {
        rename.mockRestore()
        open.mockRestore()
        write.mockRestore()
        clock.mockRestore()
      }
    }
  )

  it('complete-file EOF marker on final context preserves both sides without fabricating content', async () => {
    const { root, authorization } = writeSetup()
    const host = await createFilesHost(authorization, root)
    await fs.writeFile(path.join(root, 'eof.txt'), 'same')
    const patch = [
      '--- a/eof.txt',
      '+++ b/eof.txt',
      '@@ -1,1 +1,1 @@',
      ' same',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    const result = await host.patch(
      mutationCall(
        'files.patch',
        { path: 'eof.txt', expectedSha256: digest('same'), patch },
        authorization
      )
    )
    expect(await fs.readFile(path.join(root, 'eof.txt'), 'utf8')).toBe('same')
    expect(result).toMatchObject({ beforeSha256: digest('same'), afterSha256: digest('same') })
  })

  it('applies an exact-path complete-file unified patch with CAS and snapshot', async () => {
    const { root, authorization } = writeSetup()
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const file = path.join(root, 'patch.txt')
    writeFileSync(file, 'alpha\nbeta\n')
    const expectedSha256 = digest(readFileSync(file, 'utf8'))
    const patch = [
      '--- a/patch.txt',
      '+++ b/patch.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-beta',
      '+gamma',
      ''
    ].join('\n')
    const output = await host.patch(
      mutationCall('files.patch', { path: 'patch.txt', patch, expectedSha256 }, authorization)
    )
    expect(readFileSync(file, 'utf8')).toBe('alpha\ngamma\n')
    expect(output).toMatchObject({
      path: 'patch.txt',
      beforeSha256: expectedSha256,
      additions: 1,
      deletions: 1
    })
    expect(output.snapshotId).toMatch(/^[0-9a-f]{64}$/)

    await expect(
      host.patch(
        mutationCall(
          'files.patch',
          {
            path: 'patch.txt',
            patch: patch.replaceAll('patch.txt', 'other.txt'),
            expectedSha256: output.afterSha256
          },
          authorization
        )
      )
    ).rejects.toThrow('headers')
    expect(readFileSync(file, 'utf8')).toBe('alpha\ngamma\n')

    await expect(
      host.patch(
        mutationCall(
          'files.patch',
          {
            path: 'patch.txt',
            patch: patch.replace('@@ -1,2 +1,2 @@', '@@ -1,3 +1,2 @@'),
            expectedSha256: output.afterSha256
          },
          authorization
        )
      )
    ).rejects.toThrow('line counts')
    expect(readFileSync(file, 'utf8')).toBe('alpha\ngamma\n')

    await expect(
      host.patch(
        mutationCall(
          'files.patch',
          {
            path: '../patch.txt',
            patch: patch.replaceAll('patch.txt', '../patch.txt'),
            expectedSha256: output.afterSha256
          },
          authorization
        )
      )
    ).rejects.toThrow('traversal')
    expect(readFileSync(file, 'utf8')).toBe('alpha\ngamma\n')
  })

  it('validates every multi-edit before mutation and commits in deterministic path order', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'a.txt'), 'a')
    writeFileSync(path.join(root, 'b.txt'), 'b')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
    await expect(
      host.multiEdit(
        mutationCall(
          'files.multi-edit',
          {
            edits: [
              {
                path: 'a.txt',
                expectedSha256: digest('a'),
                replacements: [{ old: 'a', new: 'A', expectedOccurrences: 1 }]
              },
              {
                path: 'b.txt',
                expectedSha256: digest('stale'),
                replacements: [{ old: 'b', new: 'B', expectedOccurrences: 1 }]
              }
            ]
          },
          authorization
        )
      )
    ).rejects.toThrow('stale')
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('a')
    expect(consume).not.toHaveBeenCalled()

    const output = await host.multiEdit(
      mutationCall(
        'files.multi-edit',
        {
          edits: [
            {
              path: 'b.txt',
              expectedSha256: digest('b'),
              replacements: [{ old: 'b', new: 'B', expectedOccurrences: 1 }]
            },
            {
              path: 'a.txt',
              expectedSha256: digest('a'),
              replacements: [{ old: 'a', new: 'A', expectedOccurrences: 1 }]
            }
          ]
        },
        authorization
      )
    )
    expect(output.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('A')
    expect(readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe('B')
  })

  it('reports successful and failed multi-edit rollback evidence', async () => {
    const { root, authorization } = writeSetup()
    for (const name of ['a.txt', 'b.txt']) writeFileSync(path.join(root, name), name[0])
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const originalRename = fs.rename.bind(fs)
    const rename = vi.spyOn(fs, 'rename')
    rename.mockImplementationOnce(originalRename).mockRejectedValueOnce(new Error('commit failure'))
    await expect(
      host.multiEdit(
        mutationCall(
          'files.multi-edit',
          {
            edits: [
              {
                path: 'a.txt',
                expectedSha256: digest('a'),
                replacements: [{ old: 'a', new: 'A', expectedOccurrences: 1 }]
              },
              {
                path: 'b.txt',
                expectedSha256: digest('b'),
                replacements: [{ old: 'b', new: 'B', expectedOccurrences: 1 }]
              }
            ]
          },
          authorization
        )
      )
    ).rejects.toMatchObject({
      rollback: { attempted: true, succeeded: true, restoredPaths: ['a.txt'], failedPaths: [] }
    })
    expect(readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('a')
    rename.mockRestore()

    const host2 = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const rename2 = vi.spyOn(fs, 'rename')
    rename2
      .mockImplementationOnce(originalRename)
      .mockRejectedValueOnce(new Error('commit failure'))
      .mockRejectedValueOnce(new Error('rollback failure'))
    await expect(
      host2.multiEdit(
        mutationCall(
          'files.multi-edit',
          {
            edits: [
              {
                path: 'a.txt',
                expectedSha256: digest('a'),
                replacements: [{ old: 'a', new: 'A', expectedOccurrences: 1 }]
              },
              {
                path: 'b.txt',
                expectedSha256: digest('b'),
                replacements: [{ old: 'b', new: 'B', expectedOccurrences: 1 }]
              }
            ]
          },
          authorization
        )
      )
    ).rejects.toMatchObject({
      rollback: { attempted: true, succeeded: false, restoredPaths: [], failedPaths: ['a.txt'] }
    })
    rename2.mockRestore()
  })

  it('writes full/path JSON safely with create, CAS, finite, prototype, and size guards', async () => {
    const { root, authorization } = writeSetup()
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    await host.jsonWrite(
      mutationCall(
        'files.json.write',
        { path: 'data.json', value: { b: 2, a: [1] }, create: true },
        authorization
      )
    )
    expect(readFileSync(path.join(root, 'data.json'), 'utf8')).toBe(
      '{\n  "b": 2,\n  "a": [\n    1\n  ]\n}\n'
    )
    await host.jsonWrite(
      mutationCall(
        'files.json.write',
        {
          path: 'data.json',
          update: { path: 'a.0', value: 3 },
          expectedSha256: digest(readFileSync(path.join(root, 'data.json'), 'utf8'))
        },
        authorization
      )
    )
    expect(JSON.parse(readFileSync(path.join(root, 'data.json'), 'utf8')).a[0]).toBe(3)
    await expect(
      host.jsonWrite(
        mutationCall(
          'files.json.write',
          {
            path: 'data.json',
            value: { n: Infinity },
            expectedSha256: digest(readFileSync(path.join(root, 'data.json'), 'utf8'))
          },
          authorization
        )
      )
    ).rejects.toThrow('finite')
    await expect(
      host.jsonWrite(
        mutationCall(
          'files.json.write',
          {
            path: 'data.json',
            update: { path: '__proto__.x', value: true },
            expectedSha256: digest(readFileSync(path.join(root, 'data.json'), 'utf8'))
          },
          authorization
        )
      )
    ).rejects.toThrow('path')
    await expect(
      host.jsonWrite(
        mutationCall(
          'files.json.write',
          { path: 'large.json', value: '12345', create: true, maxBytes: 4 },
          authorization
        )
      )
    ).rejects.toThrow('byte limit')
  })

  it.each([
    ...[true, false].flatMap((oldLf) =>
      [true, false].map((newLf) => ({
        label: `replacement oldLF=${oldLf} newLF=${newLf}`,
        before: `old${oldLf ? '\n' : ''}`,
        after: `new${newLf ? '\n' : ''}`,
        header: '@@ -1,1 +1,1 @@',
        body: [
          '-old',
          ...(oldLf ? [] : ['\\ No newline at end of file']),
          '+new',
          ...(newLf ? [] : ['\\ No newline at end of file'])
        ],
        additions: 1,
        deletions: 1
      }))
    ),
    ...[true, false].flatMap((lf) =>
      [false, true].map((deleting) => ({
        label: `${deleting ? 'delete to' : 'populate'} empty LF=${lf}`,
        before: deleting ? `line${lf ? '\n' : ''}` : '',
        after: deleting ? '' : `line${lf ? '\n' : ''}`,
        header: deleting ? '@@ -1,1 +0,0 @@' : '@@ -0,0 +1,1 @@',
        body: [`${deleting ? '-' : '+'}line`, ...(lf ? [] : ['\\ No newline at end of file'])],
        additions: deleting ? 0 : 1,
        deletions: deleting ? 1 : 0
      }))
    ),
    {
      label: 'add final LF only',
      before: 'same',
      after: 'same\n',
      header: '@@ -1,1 +1,1 @@',
      body: ['-same', '\\ No newline at end of file', '+same'],
      additions: 1,
      deletions: 1
    },
    {
      label: 'remove final LF only',
      before: 'same\n',
      after: 'same',
      header: '@@ -1,1 +1,1 @@',
      body: ['-same', '+same', '\\ No newline at end of file'],
      additions: 1,
      deletions: 1
    },
    {
      label: 'empty to blank line',
      before: '',
      after: '\n',
      header: '@@ -0,0 +1,1 @@',
      body: ['+'],
      additions: 1,
      deletions: 0
    },
    {
      label: 'blank line to empty',
      before: '\n',
      after: '',
      header: '@@ -1,1 +0,0 @@',
      body: ['-'],
      additions: 0,
      deletions: 1
    },
    {
      label: 'add trailing blank line',
      before: 'same\n',
      after: 'same\n\n',
      header: '@@ -1,1 +1,2 @@',
      body: [' same', '+'],
      additions: 1,
      deletions: 0
    },
    {
      label: 'remove trailing blank line',
      before: 'same\n\n',
      after: 'same\n',
      header: '@@ -1,2 +1,1 @@',
      body: [' same', '-'],
      additions: 0,
      deletions: 1
    },
    {
      label: 'common prefix and nonterminated suffix',
      before: 'head\nold\ntail',
      after: 'head\nnew\ntail',
      header: '@@ -1,3 +1,3 @@',
      body: [' head', '-old', '+new', ' tail', '\\ No newline at end of file'],
      additions: 1,
      deletions: 1
    },
    {
      label: 'blank context plus UTF8 suffix',
      before: '\n旧\n末尾',
      after: '\n新\n末尾',
      header: '@@ -1,3 +1,3 @@',
      body: [' ', '-旧', '+新', ' 末尾', '\\ No newline at end of file'],
      additions: 1,
      deletions: 1
    },
    {
      label: 'unchanged empty',
      before: '',
      after: '',
      header: '',
      body: [],
      additions: 0,
      deletions: 0
    },
    {
      label: 'unchanged nonterminated',
      before: 'same',
      after: 'same',
      header: '',
      body: [],
      additions: 0,
      deletions: 0
    },
    {
      label: 'unchanged terminated',
      before: 'same\n',
      after: 'same\n',
      header: '',
      body: [],
      additions: 0,
      deletions: 0
    }
  ])(
    'bounded LF diff receipt $label is exact with matching counts and approved patch roundtrip',
    async ({ before, after, header, body, additions, deletions }) => {
      const { root, authorization } = writeSetup()
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      const host = await createFilesHost(authorization, root)
      await fs.writeFile(path.join(root, 'diff.txt'), before)
      const expected =
        before === after ? '' : ['--- a/diff.txt', '+++ b/diff.txt', header, ...body, ''].join('\n')
      const output = await host.diff(readCall('files.diff', { path: 'diff.txt', text: after }))
      expect(output).toMatchObject({
        currentSha256: digest(before),
        comparedSha256: digest(after),
        diff: expected,
        diffBytes: Buffer.byteLength(expected),
        additions,
        deletions,
        truncated: false
      })
      expect(await fs.readFile(path.join(root, 'diff.txt'), 'utf8')).toBe(before)
      expect(consume).toHaveBeenCalledOnce()
      expect(consume.mock.calls[0][0]).toMatchObject({ request: { action: 'filesystem.read' } })
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
      const mutation = await host.write(
        mutationCall(
          'files.write',
          { path: 'diff.txt', expectedSha256: digest(before), content: after },
          authorization
        )
      )
      expect(mutation).toMatchObject({
        beforeSha256: digest(before),
        afterSha256: digest(after),
        diff: expected,
        diffBytes: Buffer.byteLength(expected),
        additions,
        deletions,
        bytes: Buffer.byteLength(after)
      })
      expect(await fs.readFile(path.join(root, 'diff.txt'), 'utf8')).toBe(after)
      expect(
        await fs.readFile(
          path.join(root, '.magicpot', 'tool-host', 'snapshots', mutation.snapshotId, 'content'),
          'utf8'
        )
      ).toBe(before)
      if (expected) {
        const inverse = await host.diff(
          readCall('files.diff', { path: 'diff.txt', snapshotToken: mutation.restoreToken })
        )
        expect(inverse).toMatchObject({
          currentSha256: digest(after),
          comparedSha256: digest(before),
          additions: deletions,
          deletions: additions,
          truncated: false
        })
        await host.patch(
          mutationCall(
            'files.patch',
            { path: 'diff.txt', expectedSha256: digest(after), patch: inverse.diff },
            authorization
          )
        )
        expect(await fs.readFile(path.join(root, 'diff.txt'), 'utf8')).toBe(before)
        const replay = await host.patch(
          mutationCall(
            'files.patch',
            { path: 'diff.txt', expectedSha256: digest(before), patch: output.diff },
            authorization
          )
        )
        expect(replay).toMatchObject({
          diff: expected,
          additions,
          deletions,
          beforeSha256: digest(before),
          afterSha256: digest(after)
        })
        expect(await fs.readFile(path.join(root, 'diff.txt'), 'utf8')).toBe(after)
      }
    }
  )

  it.each([
    { text: '新', cut: 1 },
    { text: '新', cut: 2 },
    { text: '😀', cut: 1 },
    { text: '😀', cut: 2 },
    { text: '😀', cut: 3 }
  ])(
    'bounded LF diff receipt truncation within $text at byte $cut stays within UTF8 bound without inventing replacement chars',
    async ({ text, cut }) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      await fs.writeFile(path.join(root, 'diff.txt'), '')
      const prefix = '--- a/diff.txt\n+++ b/diff.txt\n@@ -0,0 +1,1 @@\n+'
      const maxDiffBytes = Buffer.byteLength(prefix) + cut
      const output = await host.diff(
        readCall('files.diff', { path: 'diff.txt', text: `${text}\n`, maxDiffBytes })
      )
      expect(output).toMatchObject({
        diff: prefix,
        diffBytes: Buffer.byteLength(prefix),
        truncated: true,
        additions: 1,
        deletions: 0
      })
      expect(output.diffBytes).toBeLessThanOrEqual(maxDiffBytes)
      expect(output.diff).not.toContain('\ufffd')
      expect(await fs.readFile(path.join(root, 'diff.txt'), 'utf8')).toBe('')
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['新', '😀'])(
    'bounded LF diff receipt each byte boundary around %s is a valid exact prefix',
    async (text) => {
      const { root, authorization } = writeSetup()
      const host = await createFilesHost(authorization, root)
      await fs.writeFile(path.join(root, 'diff.txt'), '')
      const prefix = '--- a/diff.txt\n+++ b/diff.txt\n@@ -0,0 +1,1 @@\n+'
      const complete = `${prefix}${text}\n`,
        encoded = Buffer.from(complete)
      for (let limit = 1; limit <= encoded.length + 1; limit++) {
        const output = await host.diff(
          readCall('files.diff', { path: 'diff.txt', text: `${text}\n`, maxDiffBytes: limit })
        )
        const expected =
          limit <= Buffer.byteLength(prefix)
            ? prefix.slice(0, limit)
            : limit < Buffer.byteLength(prefix + text)
              ? prefix
              : limit === Buffer.byteLength(prefix + text)
                ? prefix + text
                : complete
        expect(output).toMatchObject({
          diff: expected,
          diffBytes: Buffer.byteLength(expected),
          truncated: encoded.length > limit,
          additions: 1,
          deletions: 0
        })
        expect(output.diffBytes).toBeLessThanOrEqual(limit)
        expect(encoded.subarray(0, output.diffBytes)).toEqual(Buffer.from(output.diff))
        expect(output.diff).not.toContain('\ufffd')
      }
      expect(await fs.readFile(path.join(root, 'diff.txt'), 'utf8')).toBe('')
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it.each(['write', 'strict', 'partial', 'best_effort', 'patch', 'json', 'multi'] as const)(
    'bounded LF diff receipt %s marker overhead is included before any permit/snapshot/write',
    async (kind) => {
      const { root, authorization } = writeSetup()
      const audits: FilesToolAuditEvidence[] = []
      const host = await createFilesHost(authorization, root, (audit) => {
        audits.push(audit)
      })
      const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
      const before = kind === 'json' ? 'null' : 'old',
        after = kind === 'json' ? '"new"\n' : 'new\n'
      const expectedDiff = `--- a/diff.txt\n+++ b/diff.txt\n@@ -1,1 +1,1 @@\n-${before}\n\\ No newline at end of file\n+${after}`
      const limit = Buffer.byteLength(expectedDiff) - 1
      await fs.writeFile(path.join(root, 'diff.txt'), before)
      const base = { path: 'diff.txt', expectedSha256: digest(before), maxDiffBytes: limit }
      const replacements = [{ old: before, new: after, expectedOccurrences: 1 }]
      const pending =
        kind === 'write'
          ? host.write(mutationCall('files.write', { ...base, content: after }, authorization))
          : kind === 'json'
            ? host.jsonWrite(
                mutationCall('files.json.write', { ...base, value: 'new' }, authorization)
              )
            : kind === 'multi'
              ? host.multiEdit(
                  mutationCall(
                    'files.multi-edit',
                    {
                      maxDiffBytes: limit,
                      edits: [
                        { path: 'diff.txt', expectedSha256: base.expectedSha256, replacements }
                      ]
                    },
                    authorization
                  )
                )
              : kind === 'patch'
                ? host.patch(
                    mutationCall('files.patch', { ...base, patch: expectedDiff }, authorization)
                  )
                : host.edit(
                    mutationCall(
                      'files.edit',
                      {
                        ...base,
                        mode: kind,
                        replacements:
                          kind === 'strict'
                            ? replacements
                            : [
                                ...replacements,
                                { old: 'not present', new: 'x', expectedOccurrences: 1 }
                              ]
                      },
                      authorization
                    )
                  )
      const error = await pending.catch((error) => error)
      expect(error).toBeInstanceOf(FilesToolValidationError)
      expect(error.message).toBe('Pre-write diff exceeds the byte limit.')
      expect(error).not.toHaveProperty('mutation')
      expect(error).not.toHaveProperty('report')
      expect(consume).not.toHaveBeenCalled()
      expect(await fs.readFile(path.join(root, 'diff.txt'), 'utf8')).toBe(before)
      await expect(fs.stat(path.join(root, '.magicpot'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        audits.some((audit) => audit.outcome === 'completed' || audit.mutationUncertain === true)
      ).toBe(false)
    }
  )

  it('diffs text and snapshots within bounds, lists metadata only, and restores original/deletion safely', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'note.txt'), 'old')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const changed = await host.write(
      mutationCall(
        'files.write',
        { path: 'note.txt', content: 'new', expectedSha256: digest('old') },
        authorization
      )
    )
    const textDiff = await host.diff(
      readCall('files.diff', { path: 'note.txt', text: 'other', maxDiffBytes: 20 })
    )
    expect(textDiff.truncated).toBe(true)
    const snapshotDiff = await host.diff(
      readCall('files.diff', { path: 'note.txt', snapshotToken: changed.restoreToken })
    )
    expect(snapshotDiff.diff).toContain('-new')
    expect(snapshotDiff.diff).toContain('+old')
    const listed = await host.snapshotList(readCall('files.snapshot.list', { maxEntries: 1 }))
    expect(listed.snapshots[0]).not.toHaveProperty('content')
    expect(JSON.stringify(listed)).not.toContain('old')
    const restored = await host.snapshotRestore(
      mutationCall(
        'files.snapshot.restore',
        { path: 'note.txt', restoreToken: changed.restoreToken, expectedSha256: digest('new') },
        authorization
      )
    )
    expect(restored.deleted).toBe(false)
    expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('old')

    const created = await host.write(
      mutationCall(
        'files.write',
        { path: 'created.txt', content: 'created', create: true },
        authorization
      )
    )
    const deleted = await host.snapshotRestore(
      mutationCall(
        'files.snapshot.restore',
        {
          path: 'created.txt',
          restoreToken: created.restoreToken,
          expectedSha256: digest('created')
        },
        authorization
      )
    )
    expect(deleted.deleted).toBe(true)
    expect(() => statSync(path.join(root, 'created.txt'))).toThrow()
  })

  it('rejects restore stale CAS, tamper, token forgery, path mismatch, traversal, and reserved metadata', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'a.txt'), 'a')
    writeFileSync(path.join(root, 'b.txt'), 'b')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const snapshot = await host.write(
      mutationCall(
        'files.write',
        { path: 'a.txt', content: 'A', expectedSha256: digest('a') },
        authorization
      )
    )
    await expect(
      host.snapshotRestore(
        mutationCall(
          'files.snapshot.restore',
          { path: 'a.txt', restoreToken: snapshot.restoreToken, expectedSha256: digest('stale') },
          authorization
        )
      )
    ).rejects.toThrow('stale')
    await expect(
      host.snapshotRestore(
        mutationCall(
          'files.snapshot.restore',
          { path: 'b.txt', restoreToken: snapshot.restoreToken, expectedSha256: digest('b') },
          authorization
        )
      )
    ).rejects.toThrow('path')
    await expect(
      host.snapshotRestore(
        mutationCall(
          'files.snapshot.restore',
          {
            path: 'a.txt',
            restoreToken: `files-restore:${'0'.repeat(64)}`,
            expectedSha256: digest('A')
          },
          authorization
        )
      )
    ).rejects.toThrow()
    writeFileSync(
      path.join(root, '.magicpot', 'tool-host', 'snapshots', snapshot.snapshotId, 'content'),
      'tampered'
    )
    await expect(
      host.snapshotRestore(
        mutationCall(
          'files.snapshot.restore',
          { path: 'a.txt', restoreToken: snapshot.restoreToken, expectedSha256: digest('A') },
          authorization
        )
      )
    ).rejects.toThrow('hash')
    await expect(
      host.snapshotList(readCall('files.snapshot.list', { path: '../escape' }))
    ).rejects.toThrow('traversal')
    await expect(
      host.snapshotList(readCall('files.snapshot.list', { path: '.magicpot' }))
    ).rejects.toThrow('reserved')
  })

  it('honors M8 abort and emits audits without content or restore tokens', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'secret.txt'), 'super-secret')
    const evidence: FilesToolAuditEvidence[] = []
    const host = await createFilesHost(authorization, root, (item) => void evidence.push(item))
    const controller = new AbortController()
    controller.abort()
    await expect(
      host.diff({
        ...readCall('files.diff', { path: 'secret.txt', text: 'other-secret' }),
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(JSON.stringify(evidence)).not.toMatch(/super-secret|other-secret|files-restore:/)
  })

  it('creates explicitly, overwrites with CAS, edits exact occurrences, and snapshots the prior content', async () => {
    const { root, authorization } = writeSetup()
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const created = await host.write(
      mutationCall(
        'files.write',
        { path: 'note.txt', content: 'alpha alpha', create: true },
        authorization
      )
    )
    expect(created.created).toBe(true)
    expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('alpha alpha')
    await expect(
      host.write(
        mutationCall(
          'files.write',
          { path: 'note.txt', content: 'stale', expectedSha256: '0'.repeat(64) },
          authorization
        )
      )
    ).rejects.toThrow('stale')
    const edited = await host.edit(
      mutationCall(
        'files.edit',
        {
          path: 'note.txt',
          expectedSha256: digest('alpha alpha'),
          replacements: [{ old: 'alpha', new: 'beta', expectedOccurrences: 2 }]
        },
        authorization
      )
    )
    expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('beta beta')
    expect(
      readFileSync(
        path.join(root, '.magicpot', 'tool-host', 'snapshots', edited.snapshotId, 'content'),
        'utf8'
      )
    ).toBe('alpha alpha')
    expect(
      JSON.parse(
        readFileSync(
          path.join(
            root,
            '.magicpot',
            'tool-host',
            'snapshots',
            edited.snapshotId,
            'manifest.json'
          ),
          'utf8'
        )
      ).restoreToken
    ).toBe(edited.restoreToken)
  })

  it('rejects ambiguous exact edits and aborts before permit consumption/mutation', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'note.txt'), 'x x')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    await expect(
      host.edit(
        mutationCall(
          'files.edit',
          {
            path: 'note.txt',
            expectedSha256: digest('x x'),
            replacements: [{ old: 'x', new: 'y', expectedOccurrences: 1 }]
          },
          authorization
        )
      )
    ).rejects.toThrow('expectation')
    const controller = new AbortController()
    controller.abort()
    await expect(
      host.write({
        ...mutationCall(
          'files.write',
          { path: 'note.txt', content: 'y', expectedSha256: digest('x x') },
          authorization
        ),
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('x x')
  })

  it('requires approval for files.patch before consuming a permit or mutating', async () => {
    const { root, authorization } = writeSetup()
    const target = path.join(root, 'patch-approval.txt')
    writeFileSync(target, 'before\n')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
    const call = mutationCall(
      'files.patch',
      {
        path: 'patch-approval.txt',
        expectedSha256: digest('before\n'),
        patch: [
          '--- a/patch-approval.txt',
          '+++ b/patch-approval.txt',
          '@@ -1,1 +1,1 @@',
          '-before',
          '+after',
          ''
        ].join('\n')
      },
      authorization
    ) as any
    delete call.grantId
    delete call.expectedGrantUseCount

    await expect(host.patch(call)).rejects.toMatchObject({ status: 'awaiting-approval' })
    expect(consume).not.toHaveBeenCalled()
    expect(readFileSync(target, 'utf8')).toBe('before\n')
  })

  it('surfaces require-approval and deny policy outcomes before mutation', async () => {
    const { root, authorization } = writeSetup()
    const target = path.join(root, 'note.txt')
    writeFileSync(target, 'old')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const awaiting = mutationCall(
      'files.write',
      { path: 'note.txt', content: 'new', expectedSha256: digest('old') },
      authorization
    ) as any
    delete awaiting.grantId
    delete awaiting.expectedGrantUseCount
    await expect(host.write(awaiting)).rejects.toMatchObject({ status: 'awaiting-approval' })
    expect(readFileSync(target, 'utf8')).toBe('old')

    const store = new MagicAgentEventStore(':memory:')
    stores.push(store)
    const denied = new MagicAgentPolicyAuthorizationService({
      store,
      rules: [
        { ruleId: 'deny-write', priority: 99, effect: 'deny', explanation: 'denied by test' }
      ],
      policyVersion: 'test',
      storeId: 'deny-test',
      trustedApprovers: [{ kind: 'user', id: 'approver' }]
    })
    const deniedHost = await FilesToolHost.create(denied, { allowedRoots: [root] })
    const deniedCall = mutationCall(
      'files.write',
      { path: 'note.txt', content: 'new', expectedSha256: digest('old') },
      authorization
    ) as any
    delete deniedCall.grantId
    delete deniedCall.expectedGrantUseCount
    await expect(deniedHost.write(deniedCall)).rejects.toMatchObject({ status: 'denied' })
    expect(readFileSync(target, 'utf8')).toBe('old')
  })

  it('requires explicit create and CAS for overwrite without consuming validation failures', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'existing.txt'), 'before')
    const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    await expect(
      host.write(
        mutationCall('files.write', { path: 'missing.txt', content: 'new' }, authorization)
      )
    ).rejects.toThrow('create=true')
    await expect(
      host.write(
        mutationCall('files.write', { path: 'existing.txt', content: 'after' }, authorization)
      )
    ).rejects.toThrow('expectedSha256')
    await expect(
      host.write(
        mutationCall(
          'files.write',
          { path: 'existing.txt', content: 'after', expectedSha256: digest('stale') },
          authorization
        )
      )
    ).rejects.toThrow('stale')
    expect(consume).not.toHaveBeenCalled()
    expect(readFileSync(path.join(root, 'existing.txt'), 'utf8')).toBe('before')
  })

  it('applies ordered exact replacements and rejects ambiguity before permit consumption', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'ordered.txt'), 'a b a')
    const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const result = await host.edit(
      mutationCall(
        'files.edit',
        {
          path: 'ordered.txt',
          expectedSha256: digest('a b a'),
          replacements: [
            { old: 'a', new: 'x', expectedOccurrences: 2 },
            { old: 'x b x', new: 'done', expectedOccurrences: 1 }
          ]
        },
        authorization
      )
    )
    expect(result.diff).toContain('@@ -1,1 +1,1 @@')
    expect(readFileSync(path.join(root, 'ordered.txt'), 'utf8')).toBe('done')
    expect(consume).toHaveBeenCalledTimes(1)
    writeFileSync(path.join(root, 'ambiguous.txt'), 'same same')
    consume.mockClear()
    await expect(
      host.edit(
        mutationCall(
          'files.edit',
          {
            path: 'ambiguous.txt',
            expectedSha256: digest('same same'),
            replacements: [{ old: 'same', new: 'x', expectedOccurrences: 1 }]
          },
          authorization
        )
      )
    ).rejects.toThrow('found 2')
    expect(consume).not.toHaveBeenCalled()
  })

  it('rejects traversal, absolute, reserved metadata, symlink, binary, special, and oversized targets/results', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'binary'), Buffer.from([0, 1, 2]))
    mkdirSync(path.join(root, 'directory'))
    writeFileSync(path.join(root, 'large.txt'), '12345')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    for (const invalid of ['../escape', path.resolve(root, 'absolute'), '.magicpot/manifest.json'])
      await expect(
        host.write(
          mutationCall('files.write', { path: invalid, content: 'x', create: true }, authorization)
        )
      ).rejects.toBeInstanceOf(FilesToolValidationError)
    try {
      symlinkSync(path.join(root, 'large.txt'), path.join(root, 'link.txt'))
      await expect(
        host.write(
          mutationCall(
            'files.write',
            { path: 'link.txt', content: 'x', expectedSha256: digest('12345') },
            authorization
          )
        )
      ).rejects.toThrow('Symbolic')
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    }
    await expect(
      host.write(
        mutationCall(
          'files.write',
          { path: 'binary', content: 'x', expectedSha256: '0'.repeat(64) },
          authorization
        )
      )
    ).rejects.toThrow('Binary')
    await expect(
      host.write(
        mutationCall(
          'files.write',
          { path: 'directory', content: 'x', expectedSha256: digest('') },
          authorization
        )
      )
    ).rejects.toThrow('regular file')
    await expect(
      host.write(
        mutationCall(
          'files.write',
          { path: 'large.txt', content: 'x', expectedSha256: digest('12345'), maxBytes: 4 },
          authorization
        )
      )
    ).rejects.toThrow('byte limit')
    await expect(
      host.write(
        mutationCall(
          'files.write',
          { path: 'new.txt', content: '12345', create: true, maxBytes: 4 },
          authorization
        )
      )
    ).rejects.toThrow('Result exceeds')
  })

  it('bounds unified diffs and stores content-addressed snapshots outside normal writable paths', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'note.txt'), 'old')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    await expect(
      host.write(
        mutationCall(
          'files.write',
          {
            path: 'note.txt',
            content: 'a'.repeat(100),
            expectedSha256: digest('old'),
            maxDiffBytes: 10
          },
          authorization
        )
      )
    ).rejects.toThrow('diff exceeds')
    const output = await host.write(
      mutationCall(
        'files.write',
        { path: 'note.txt', content: 'new', expectedSha256: digest('old') },
        authorization
      )
    )
    const manifest = JSON.parse(
      readFileSync(
        path.join(root, '.magicpot', 'tool-host', 'snapshots', output.snapshotId, 'manifest.json'),
        'utf8'
      )
    )
    expect(manifest).toMatchObject({
      snapshotId: output.snapshotId,
      restoreToken: `files-restore:${output.snapshotId}`,
      path: 'note.txt',
      beforeSha256: digest('old'),
      afterSha256: digest('new')
    })
    expect(output.snapshotId).toBe(
      digest(
        JSON.stringify({
          version: 1,
          path: 'note.txt',
          existed: true,
          beforeSha256: digest('old'),
          afterSha256: digest('new'),
          bytes: 3
        })
      )
    )
    await expect(
      host.write(
        mutationCall(
          'files.write',
          {
            path: `.magicpot/tool-host/snapshots/${output.snapshotId}/content`,
            content: 'tamper',
            expectedSha256: digest('old')
          },
          authorization
        )
      )
    ).rejects.toThrow('reserved')
  })

  it('cleans atomic temporaries, leaves the original on rename failure, and reports uncertainty', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'note.txt'), 'original')
    const evidence: FilesToolAuditEvidence[] = []
    const host = await createFilesHost(authorization, root, (item) => void evidence.push(item))
    const rename = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('injected rename failure'), { code: 'EIO' }))
    await expect(
      host.write(
        mutationCall(
          'files.write',
          { path: 'note.txt', content: 'replacement', expectedSha256: digest('original') },
          authorization
        )
      )
    ).rejects.toThrow('injected')
    rename.mockRestore()
    expect(readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('original')
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(evidence.at(-1)).toMatchObject({ outcome: 'rejected', mutationUncertain: true })
  })

  it.runIf(process.platform !== 'win32')(
    'preserves mode bits on overwrite where portable',
    async () => {
      const { root, authorization } = writeSetup()
      const target = path.join(root, 'script.sh')
      writeFileSync(target, '#!/bin/sh\nold\n')
      chmodSync(target, 0o751)
      const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
      await host.write(
        mutationCall(
          'files.write',
          {
            path: 'script.sh',
            content: '#!/bin/sh\nnew\n',
            expectedSha256: digest('#!/bin/sh\nold\n')
          },
          authorization
        )
      )
      expect(statSync(target).mode & 0o777).toBe(0o751)
    }
  )

  it('honors pre-abort before authorization/mutation and keeps audits content-free', async () => {
    const { root, authorization } = writeSetup()
    writeFileSync(path.join(root, 'secret.txt'), 'raw-secret-content')
    const authorize = vi.spyOn(authorization, 'authorize')
    const consume = vi.spyOn(authorization, 'consumeExecutionPermit')
    const evidence: FilesToolAuditEvidence[] = []
    const host = await createFilesHost(authorization, root, (item) => void evidence.push(item))
    const controller = new AbortController()
    controller.abort()
    await expect(
      host.write({
        ...mutationCall(
          'files.write',
          {
            path: 'secret.txt',
            content: 'new-secret-content',
            expectedSha256: digest('raw-secret-content')
          },
          authorization
        ),
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(authorize).not.toHaveBeenCalled()
    expect(consume).not.toHaveBeenCalled()
    expect(readFileSync(path.join(root, 'secret.txt'), 'utf8')).toBe('raw-secret-content')
    expect(JSON.stringify(evidence)).not.toMatch(/raw-secret-content|new-secret-content/)
    expect(evidence.at(-1)).toMatchObject({ outcome: 'cancelled' })
    expect(evidence.at(-1)).not.toHaveProperty('mutationUncertain')
  })
})

describe('FilesToolHost focused file discovery tools', () => {
  it('glob supports *, ?, and ** with deterministic truncation', async () => {
    const { root, authorization } = setup()
    mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
    for (const file of ['b.ts', 'a.ts', 'x.js']) writeFileSync(path.join(root, 'src', file), file)
    writeFileSync(path.join(root, 'src', 'deep', 'c.ts'), 'c')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const all = await host.glob(call('files.glob', { pattern: '**/*.ts' }, authorization))
    expect(all.entries.map((entry) => entry.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/deep/c.ts'
    ])
    const one = await host.glob(
      call('files.glob', { pattern: 'src/?.ts', maxFiles: 1 }, authorization)
    )
    expect(one.entries.map((entry) => entry.path)).toEqual(['src/a.ts'])
    expect(one.truncated).toBe(true)
  })

  it('rejects traversal and absolute paths after consuming no filesystem access', async () => {
    const { root, authorization } = setup()
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    await expect(
      host.glob(call('files.glob', { path: '../outside', pattern: '**' }, authorization))
    ).rejects.toBeInstanceOf(FilesToolValidationError)
    await expect(
      host.glob(call('files.glob', { path: path.resolve(root), pattern: '**' }, authorization))
    ).rejects.toBeInstanceOf(FilesToolValidationError)
  })

  it('greps literal and safe regex matches, filters files, skips binary, and redacts credentials', async () => {
    const { root, authorization } = setup()
    writeFileSync(
      path.join(root, 'a.txt'),
      'zero needle\ntoken=super-secret needle\nhttps://user:pass@example.test needle'
    )
    writeFileSync(path.join(root, 'b.md'), 'needle')
    writeFileSync(path.join(root, 'binary.txt'), Buffer.from([0, 110, 101, 101, 100, 108, 101]))
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const literal = await host.grep(
      call('files.grep', { query: 'needle', fileGlob: '*.txt', maxMatches: 10 }, authorization)
    )
    expect(literal.matches.map(({ line, column }) => [line, column])).toEqual([
      [1, 6],
      [2, 20],
      [3, 32]
    ])
    expect(literal.binaryFilesSkipped).toBe(1)
    expect(JSON.stringify(literal.matches)).not.toContain('super-secret')
    expect(JSON.stringify(literal.matches)).not.toContain('user:pass')
    const regex = await host.grep(
      call('files.grep', { query: 'ne+dle', mode: 'regex', fileGlob: '*.md' }, authorization)
    )
    expect(regex.matchCount).toBe(1)
    await expect(
      host.grep(call('files.grep', { query: '(a+)+', mode: 'regex' }, authorization))
    ).rejects.toThrow('Unsafe')
  })

  it('reads BOM UTF-8 JSON, selects paths, bounds output, rejects prototype keys, and redacts secrets', async () => {
    const { root, authorization } = setup()
    writeFileSync(
      path.join(root, 'data.json'),
      '\uFEFF' + JSON.stringify({ nested: { items: [{ token: 'raw-secret', value: 'ok' }] } })
    )
    writeFileSync(path.join(root, 'bad.json'), '{"__proto__":{"polluted":true}}')
    const host = await FilesToolHost.create(authorization, { allowedRoots: [root] })
    const selected = await host.jsonRead(
      call(
        'files.json.read',
        { path: 'data.json', pointer: 'nested.items.0', maxStringLength: 20 },
        authorization
      )
    )
    expect(selected.value).toEqual(
      expect.objectContaining({ token: expect.not.stringContaining('raw-secret'), value: 'ok' })
    )
    const bounded = await host.jsonRead(
      call('files.json.read', { path: 'data.json', maxDepth: 1 }, authorization)
    )
    expect(bounded.truncated).toBe(true)
    await expect(
      host.jsonRead(call('files.json.read', { path: 'bad.json' }, authorization))
    ).rejects.toThrow('prototype')
    await expect(
      host.jsonRead(
        call('files.json.read', { path: 'data.json', pointer: '__proto__' }, authorization)
      )
    ).rejects.toThrow('selection')
  })

  it('consumes the permit before access, honors abort, and emits content-free audit evidence', async () => {
    const { root, authorization } = setup()
    writeFileSync(path.join(root, 'secret.txt'), 'needle token=do-not-audit')
    const evidence: FilesToolAuditEvidence[] = []
    const original = authorization.consumeExecutionPermit.bind(authorization)
    authorization.consumeExecutionPermit = ((input) => {
      const consumed = original(input)
      expect(() =>
        original({ ...input, idempotencyKey: `${input.idempotencyKey}:replay` })
      ).toThrow(PermitConsumedError)
      return consumed
    }) as typeof authorization.consumeExecutionPermit
    const host = await createFilesHost(authorization, root, (item) => void evidence.push(item))
    await host.grep(call('files.grep', { query: 'needle' }, authorization))
    expect(JSON.stringify(evidence)).not.toContain('do-not-audit')
    const controller = new AbortController()
    controller.abort()
    await expect(
      host.grep({
        ...call('files.grep', { query: 'needle' }, authorization),
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('FilesToolHost in-flight I/O cancellation', () => {
  interface OpenHandle {
    order: number
    closed: boolean
    reads: number
    length: number
  }

  // Narrow I/O instrumentation: wrap the *real* FileHandle returned by the real
  // fs.open for one target file only. readBounded opens the target first, then
  // hashFile opens a second handle and reads it in 64KiB blocks. We fire the
  // abort callback exactly once, after the real hash handle has completed its
  // first real block read (never by starting a promise and aborting instantly).
  async function instrumentTarget(target: string, onFirstHashBlock: () => void) {
    const realOpen = fs.open.bind(fs)
    // tmpdir may hand back a Windows 8.3 short path (ADMINI~1) while the real
    // open uses the long form (Administrator); canonicalize before matching.
    const canonicalTarget = (await fs.realpath(target)).toLowerCase()
    const handles: OpenHandle[] = []
    let ownOrder = 0
    let fired = false
    const spy = vi.spyOn(fs, 'open')
    spy.mockImplementation((async (file: unknown, flags: unknown, ...rest: unknown[]) => {
      const handle = await (realOpen as (...args: unknown[]) => Promise<unknown>)(
        file,
        flags,
        ...rest
      )
      if (String(file).toLowerCase() !== canonicalTarget) return handle
      const order = ownOrder++
      const entry: OpenHandle = { order, closed: false, reads: 0, length: 0 }
      handles.push(entry)
      const real = handle as {
        read: (...args: unknown[]) => Promise<{ bytesRead: number }>
        close: () => Promise<void>
      }
      const realRead = real.read.bind(real)
      const realClose = real.close.bind(real)
      const wrapped = {
        read: async (...args: unknown[]) => {
          const result = await realRead(...args)
          entry.reads += 1
          entry.length = Number(args[2])
          if (order === 1 && entry.reads === 1 && result.bytesRead > 0 && !fired) {
            fired = true
            onFirstHashBlock()
          }
          return result
        },
        close: async () => {
          await realClose()
          entry.closed = true
        }
      }
      return wrapped
    }) as never)
    return { handles, restore: () => spy.mockRestore() }
  }

  it('aborts a real files.read mid-hash after one block, closes the handle, and audits cancellation without leaking content', async () => {
    const { root, authorization } = setup()
    const target = path.join(root, 'large.txt')
    const marker = 'IN-FLIGHT-READ-MARKER-DO-NOT-LEAK'
    const content = `${marker}${'a'.repeat(200 * 1024)}`
    writeFileSync(target, content)
    const evidence: FilesToolAuditEvidence[] = []
    const host = await createFilesHost(authorization, root, (item) => void evidence.push(item))
    const controller = new AbortController()
    const inst = await instrumentTarget(target, () => controller.abort())
    try {
      await expect(
        host.read({
          ...call('files.read', { path: 'large.txt' }, authorization),
          signal: controller.signal
        })
      ).rejects.toMatchObject({ name: 'AbortError' })

      const boundedHandle = inst.handles.find((handle) => handle.order === 0)
      const hashHandle = inst.handles.find((handle) => handle.order === 1)
      expect(hashHandle).toBeDefined()
      if (!hashHandle) throw new Error('hash handle was never opened')
      expect(hashHandle.length).toBe(64 * 1024)
      expect(hashHandle.reads).toBe(1)
      expect(hashHandle.closed).toBe(true)
      expect(boundedHandle?.closed).toBe(true)

      expect(evidence.some((item) => item.outcome === 'cancelled')).toBe(true)
      expect(evidence.every((item) => item.outcome !== 'completed')).toBe(true)
      expect(JSON.stringify(evidence)).not.toContain(marker)
    } finally {
      inst.restore()
    }
  })

  it('lets an independent-signal read finish while another aborts, then allows re-reading the cancelled file', async () => {
    const { root, authorization } = setup()
    const targetA = path.join(root, 'a.txt')
    const markerA = 'AAA-READ-MARKER'
    const contentA = `${markerA}${'a'.repeat(200 * 1024)}`
    const contentB = `bbb-content-${'b'.repeat(1024)}`
    writeFileSync(targetA, contentA)
    writeFileSync(path.join(root, 'b.txt'), contentB)
    const evidence: FilesToolAuditEvidence[] = []
    const host = await createFilesHost(authorization, root, (item) => void evidence.push(item))
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    const inst = await instrumentTarget(targetA, () => controllerA.abort())
    try {
      const [resultA, resultB] = await Promise.allSettled([
        host.read({
          ...call('files.read', { path: 'a.txt' }, authorization),
          signal: controllerA.signal
        }),
        host.read({
          ...call('files.read', { path: 'b.txt' }, authorization),
          signal: controllerB.signal
        })
      ])
      expect(resultA.status).toBe('rejected')
      if (resultA.status === 'rejected')
        expect(resultA.reason).toMatchObject({ name: 'AbortError' })
      expect(resultB.status).toBe('fulfilled')
      if (resultB.status === 'fulfilled') {
        expect(resultB.value.kind).toBe('text')
        expect((resultB.value as { content?: string }).content).toBe(contentB)
      }
      expect(
        evidence.some((item) => item.tool === 'files.read' && item.outcome === 'cancelled')
      ).toBe(true)

      const reread = await host.read(call('files.read', { path: 'a.txt' }, authorization))
      expect(reread.kind).toBe('text')
      expect((reread as { content?: string }).content).toBe(contentA)
      expect((reread as { sha256?: string }).sha256).toBe(digest(contentA))
    } finally {
      inst.restore()
    }
  })
})

describe('file mutation cancellation before atomic commit', () => {
  it.each(['snapshot', 'temporary-sync'] as const)(
    'does not replace the real target when cancelled after %s',
    async (stage) => {
      const { root, authorization } = writeSetup()
      const target = path.join(root, 'owned-cancel.txt')
      writeFileSync(target, 'ORIGINAL_OWNED_BYTES')
      const controller = new AbortController()
      let observed = false
      const originalWriteFile = fs.writeFile.bind(fs)
      const originalOpen = fs.open.bind(fs)
      const writeSpy = vi
        .spyOn(fs, 'writeFile')
        .mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
          const result = await originalWriteFile(...args)
          if (
            stage === 'snapshot' &&
            String(args[0]).includes('snapshots') &&
            String(args[0]).endsWith('manifest.json')
          ) {
            observed = true
            controller.abort()
          }
          return result
        })
      const openSpy = vi
        .spyOn(fs, 'open')
        .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args)
          if (
            stage === 'temporary-sync' &&
            String(args[0]).includes('.owned-cancel.txt.') &&
            String(args[0]).endsWith('.tmp')
          ) {
            const sync = handle.sync.bind(handle)
            handle.sync = async () => {
              await sync()
              observed = true
              controller.abort()
            }
          }
          return handle
        })
      try {
        const host = await createFilesHost(authorization, root)
        await expect(
          host.write({
            ...mutationCall(
              'files.write',
              {
                path: 'owned-cancel.txt',
                content: 'MUST_NOT_COMMIT',
                expectedSha256: digest('ORIGINAL_OWNED_BYTES')
              },
              authorization
            ),
            signal: controller.signal
          })
        ).rejects.toMatchObject({ name: 'AbortError' })
        expect(observed).toBe(true)
        expect(readFileSync(target, 'utf8')).toBe('ORIGINAL_OWNED_BYTES')
        expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
      } finally {
        writeSpy.mockRestore()
        openSpy.mockRestore()
      }
    }
  )
})
