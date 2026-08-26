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
    const host = await createFilesHost(authorization, root, (audit) => audits.push(audit))
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
    const host = await createFilesHost(authorization, root, (audit) => audits.push(audit))
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
    const host = await createFilesHost(authorization, root, (item) => evidence.push(item))
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
    const host = await createFilesHost(authorization, root, (item) => evidence.push(item))
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
    const host = await createFilesHost(authorization, root, (item) => evidence.push(item))
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
    const host = await createFilesHost(authorization, root, (item) => evidence.push(item))
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
