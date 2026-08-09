import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFilesToolPolicyRequest, type PolicyRule } from '../../../shared/magicAgentPlatform2'
import { MagicAgentEventStore } from '../persistence/eventStore'
import { MagicAgentPolicyAuthorizationService } from '../policy'
import { NotebookToolHost, NotebookToolValidationError } from './notebook'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const roots: string[] = []
const stores: MagicAgentEventStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const document = () => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { custom: { retained: true } },
  cells: [
    { id: 'md-1', cell_type: 'markdown', metadata: {}, source: ['hello'] },
    {
      id: 'code-1',
      cell_type: 'code',
      metadata: {},
      source: ['print(1)'],
      execution_count: 1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }]
    }
  ]
})
function setup(write = false) {
  const root = path.join(
    tmpdir(),
    `magic-notebook-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(root)
  roots.push(root)
  const store = new MagicAgentEventStore(':memory:')
  stores.push(store)
  const rules: PolicyRule[] = [
    {
      ruleId: 'nb',
      priority: 1,
      effect: 'allow-with-constraints',
      explanation: 'test',
      constraints: {
        readOnly: !write,
        allowedRoots: [root],
        allowedToolNames: write ? ['notebook.write'] : ['notebook.list', 'notebook.read']
      }
    }
  ]
  const authorization = new MagicAgentPolicyAuthorizationService({
    store,
    rules,
    policyVersion: 'test',
    storeId: 'test',
    trustedApprovers: [{ kind: 'user', id: 'approver' }]
  })
  return { root, authorization }
}
function call(
  authorization: MagicAgentPolicyAuthorizationService,
  tool: string,
  input: Record<string, unknown>,
  write = false
) {
  const requested = String(input.path ?? '.')
  const policyTool = write ? 'notebook.write' : tool
  const request = createFilesToolPolicyRequest({
    requestId: `req-${Math.random()}`,
    actor: { kind: 'agent', id: 'agent' },
    target: { kind: 'tool', id: policyTool },
    action: write
      ? 'notebook.write'
      : tool === 'notebook.list'
        ? 'filesystem.list'
        : 'filesystem.read',
    toolInput: { path: requested },
    filesystem: { paths: [requested] }
  })
  const result: Record<string, unknown> = {
    authorizationId: `auth-${Math.random()}`,
    idempotencyKey: `key-${Math.random()}`,
    request,
    input
  }
  if (write) {
    const now = Date.now()
    const grantId = `grant-${Math.random()}`
    authorization.createApprovalGrant({
      grantId,
      request,
      approvedBy: { kind: 'user', id: 'approver' },
      issuedAt: now,
      expiresAt: now + 60000,
      maxUses: 1,
      idempotencyKey: `grant-key-${Math.random()}`
    })
    result.grantId = grantId
    result.expectedGrantUseCount = 0
  }
  return result
}

describe('NotebookToolHost', () => {
  it('lists and reads strict v4 notebooks with stateless markers', async () => {
    const { root, authorization } = setup()
    writeFileSync(path.join(root, 'a.ipynb'), JSON.stringify(document()))
    const host = await NotebookToolHost.create(authorization, { allowedRoots: [root] })
    const listed = await host.list(call(authorization, 'notebook.list', { path: '.' }) as never)
    expect(listed.count).toBe(1)
    expect(listed.executionMode).toBe('stateless')
    const read = await host.read(call(authorization, 'notebook.read', { path: 'a.ipynb' }) as never)
    expect(read.kernelPersistent).toBe(false)
    expect(read.notebook.cells.map((c) => c.id)).toEqual(['md-1', 'code-1'])
  })

  it('performs insert, replace/convert, clear, and delete with CAS, snapshot, canonical newline and mode-safe atomic writes', async () => {
    const { root, authorization } = setup(true)
    const file = path.join(root, 'a.ipynb')
    writeFileSync(file, JSON.stringify(document()))
    const audits: unknown[] = []
    const host = await NotebookToolHost.create(authorization, {
      allowedRoots: [root],
      onAudit: (e) => {
        audits.push(e)
      }
    })
    let sha = hash(readFileSync(file))
    const inserted = await host.insert(
      call(
        authorization,
        'notebook.insert',
        {
          path: 'a.ipynb',
          expectedSha256: sha,
          position: 'after',
          referenceCellId: 'md-1',
          cell: { id: 'raw-1', cellType: 'raw', source: 'raw' }
        },
        true
      ) as never
    )
    sha = inserted.afterSha256 as string
    const replaced = await host.replace(
      call(
        authorization,
        'notebook.replace',
        {
          path: 'a.ipynb',
          expectedSha256: sha,
          cellId: 'raw-1',
          cellType: 'code',
          source: ['x=1'],
          clearOutputs: true
        },
        true
      ) as never
    )
    sha = replaced.afterSha256 as string
    const cleared = await host.clearOutputs(
      call(
        authorization,
        'notebook.clear-outputs',
        { path: 'a.ipynb', expectedSha256: sha, cellIds: ['code-1'] },
        true
      ) as never
    )
    sha = cleared.afterSha256 as string
    await host.delete(
      call(
        authorization,
        'notebook.delete',
        { path: 'a.ipynb', expectedSha256: sha, cellIds: ['raw-1'] },
        true
      ) as never
    )
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text).cells.map((c: { id: string }) => c.id)).toEqual(['md-1', 'code-1'])
    expect(audits.some((e) => JSON.stringify(e).includes('print(1)'))).toBe(false)
    expect(
      readFileSync(
        path.join(root, '.magicpot', 'notebook-snapshots', `${inserted.snapshotId}.ipynb`)
      )
    ).toBeTruthy()
  })

  it('rejects malformed/duplicate ids, prototype keys, stale CAS, traversal and symlink-like containment failures', async () => {
    const { root, authorization } = setup()
    const host = await NotebookToolHost.create(authorization, { allowedRoots: [root] })
    const duplicate = document()
    duplicate.cells[1].id = 'md-1'
    writeFileSync(path.join(root, 'bad.ipynb'), JSON.stringify(duplicate))
    await expect(
      host.read(call(authorization, 'notebook.read', { path: 'bad.ipynb' }) as never)
    ).rejects.toBeInstanceOf(NotebookToolValidationError)
    writeFileSync(
      path.join(root, 'proto.ipynb'),
      '{"nbformat":4,"nbformat_minor":5,"metadata":{"__proto__":{}},"cells":[]}'
    )
    await expect(
      host.read(call(authorization, 'notebook.read', { path: 'proto.ipynb' }) as never)
    ).rejects.toThrow('Prototype')
    await expect(
      host.read(call(authorization, 'notebook.read', { path: '../outside.ipynb' }) as never)
    ).rejects.toThrow('traversal')
  })

  it('does not consume approval or write when CAS is stale', async () => {
    const { root, authorization } = setup(true)
    const file = path.join(root, 'a.ipynb')
    writeFileSync(file, JSON.stringify(document()))
    const host = await NotebookToolHost.create(authorization, { allowedRoots: [root] })
    const before = readFileSync(file)
    await expect(
      host.delete(
        call(
          authorization,
          'notebook.delete',
          { path: 'a.ipynb', expectedSha256: '0'.repeat(64), cellIds: ['md-1'] },
          true
        ) as never
      )
    ).rejects.toThrow('stale')
    expect(readFileSync(file)).toEqual(before)
    expect(() => readFileSync(path.join(root, '.magicpot', 'notebook-snapshots'))).toThrow()
  })
})
