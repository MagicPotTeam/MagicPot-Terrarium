import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  AGENT_LOCAL_FILE_ERRORS,
  AGENT_LOCAL_FILE_LIMITS as LIMITS,
  agentLocalFilesSvcDef,
  type AgentLocalFileScope
} from '@shared/api/svcAgentLocalFiles'
import {
  ServiceValidationError,
  validateServiceValue
} from '@shared/api/apiUtils/serviceValidation'
import { createHash } from 'node:crypto'
import { LocalFileReadGrants } from './readGrants'
import { officeFixtures } from './documents/__fixtures__/officeFixtures'
import { pdfFixtures } from './documents/__fixtures__/pdfFixtures'
import type { DocumentProcessOutcome } from './documents/documentProcessSupervisor'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')

const scope: AgentLocalFileScope = {
  projectId: 'project-1',
  paneId: 'pane_1',
  sessionId: 'session-1'
}
const sender = 41
let root: string
let grants: LocalFileReadGrants
let request = 0
const params = (grantId: string, relativePath?: string) => ({
  grantId,
  relativePath,
  requestId: `request-${++request}`
})

async function fixture(name: string, content: string | Buffer = 'hello'): Promise<string> {
  const selected = path.join(root, name)
  await fs.mkdir(path.dirname(selected), { recursive: true })
  await fs.writeFile(selected, content)
  return selected
}

async function fileGrant(name = 'note.txt', content: string | Buffer = 'hello') {
  return grants.authorize(sender, scope, await fixture(name, content), 'file')
}

async function expectCode(
  promise: Promise<unknown>,
  code: keyof typeof AGENT_LOCAL_FILE_ERRORS
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code,
    message: AGENT_LOCAL_FILE_ERRORS[code],
    cause: undefined
  })
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'magicpot-local-read-test-')))
  grants = new LocalFileReadGrants()
  request = 0
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  grants.revoke(sender, scope, {})
  await fs.rm(root, { recursive: true, force: true })
})

describe('strict, safely logged public contract', () => {
  it('defines the scoped read-only methods and fixed limits', () => {
    expect(Object.keys(agentLocalFilesSvcDef)).toEqual([
      'setScope',
      'choose',
      'read',
      'list',
      'revoke',
      'cancel'
    ])
    expect(LIMITS).toEqual({
      fileBytes: 1048576,
      returnedBytes: 65536,
      responseBytes: 131072,
      listEntries: 100,
      ttlMs: 1800000,
      grants: 128,
      grantsPerScope: 16,
      deadlineMs: 10000
    })
  })

  it.each(['choose', 'read', 'list', 'revoke', 'cancel'] as const)(
    '%s rejects unknown keys without retaining secrets',
    (method) => {
      const base =
        method === 'choose'
          ? { scope, kind: 'file', requestId: 'request' }
          : method === 'cancel'
            ? { scope, requestId: 'request' }
            : method === 'revoke'
              ? { scope }
              : { scope, grantId: 'a'.repeat(32), requestId: 'request' }
      const validator = agentLocalFilesSvcDef[method].request as (value: unknown) => unknown
      expect(validator(base)).toEqual(base)
      for (const value of [
        { ...base, 'secret/fixture-data/path': 'private-token' },
        { ...base, scope: { ...scope, secret: 'private-token' } }
      ]) {
        let error: unknown
        try {
          validator(value)
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(ServiceValidationError)
        expect(error).toMatchObject({
          cause: undefined,
          issues: [{ path: [], message: 'Failed validation' }]
        })
        expect(JSON.stringify(error)).not.toMatch(/secret|private-token/)
      }
    }
  )

  it.each(['', '../escape', '/absolute', 'a.b', 'a b', 'a'.repeat(129)])(
    'rejects unsafe scope IDs %j',
    (projectId) => {
      expect(() =>
        validateServiceValue(
          { scope: { ...scope, projectId }, requestId: 'ok' },
          agentLocalFilesSvcDef.cancel.request
        )
      ).toThrow(ServiceValidationError)
    }
  )

  it('rejects forged internal params and invalid sender identity', async () => {
    const grant = await fileGrant()
    await expect(
      grants.read(sender, scope, { ...params(grant.id), scope } as never)
    ).rejects.toBeInstanceOf(ServiceValidationError)
    await expect(grants.read(NaN, scope, params(grant.id))).rejects.toBeInstanceOf(
      ServiceValidationError
    )
  })
})

describe('Office uses the same bytes-only grant contract after PDF proof', () => {
  it.each(['docx', 'xlsx', 'pptx'] as const)(
    'authorizes only owned %s bytes and preserves its document locators',
    async (format) => {
      const locator =
        format === 'docx'
          ? {
              kind: 'docx-table-cell' as const,
              part: 'word/document.xml' as const,
              table: 0,
              row: 0,
              column: 1
            }
          : format === 'xlsx'
            ? { kind: 'xlsx-cell' as const, sheet: 2, cell: 'C3' }
            : { kind: 'pptx-shape' as const, slide: 2, shape: 0, paragraph: 0 }
      const extract = vi.fn(async (request): Promise<DocumentProcessOutcome> => ({
        protocol: 'magicpot-document-text/v1',
        jobId: request.jobId,
        format,
        ok: true,
        segments: [{ text: 'OFFICE-UNIQUE', locator }],
        truncated: false,
        warnings: []
      }))
      grants = new LocalFileReadGrants({ extract, dispose: vi.fn() })
      const bytes = officeFixtures()[format]
      const grant = await fileGrant('owned.' + format, Buffer.from(bytes))
      const output = await grants.read(sender, scope, params(grant.id))
      expect(output.document).toMatchObject({ format, segments: [{ locator }] })
      expect(extract.mock.calls[0][0].bytes).toEqual(bytes)
      expect(Object.keys(extract.mock.calls[0][0]).sort()).toEqual([
        'bytes',
        'format',
        'jobId',
        'protocol'
      ])
    }
  )
})

describe('PDF bytes through the authorized single handle', () => {
  const result = (jobId: string): DocumentProcessOutcome => ({
    protocol: 'magicpot-document-text/v1',
    jobId,
    format: 'pdf',
    ok: true,
    segments: [{ text: 'OWNED-PDF-READ-UNIQUE', locator: { kind: 'pdf-item', page: 2, item: 0 } }],
    truncated: false,
    warnings: ['reading-order-unverified']
  })
  it('returns parent-computed provenance and pages without giving parser paths or grants', async () => {
    const bytes = pdfFixtures().multiPage
    const extract = vi.fn(async (request) => result(request.jobId))
    grants = new LocalFileReadGrants({ extract, dispose: vi.fn() })
    const selected = await fixture('owned.pdf', Buffer.from(bytes))
    const grant = await grants.authorize(sender, scope, selected, 'file')
    const response = await grants.read(sender, scope, params(grant.id))
    expect(response).toMatchObject({
      content: 'OWNED-PDF-READ-UNIQUE',
      document: {
        format: 'pdf',
        sourceSha256: createHash('sha256').update(bytes).digest('hex'),
        segments: [{ locator: { kind: 'pdf-item', page: 2, item: 0 } }]
      }
    })
    expect(Object.keys(extract.mock.calls[0][0]).sort()).toEqual([
      'bytes',
      'format',
      'jobId',
      'protocol'
    ])
    expect(extract.mock.calls[0][0].bytes).toEqual(bytes)
    expect(validateServiceValue(response, agentLocalFilesSvcDef.read.response)).toEqual(response)
    expect(JSON.stringify(response)).not.toContain(selected)
    expect(JSON.stringify(response)).not.toContain(grant.id)
  })

  it('rechecks the open file after extraction and rejects content changed while utility was running', async () => {
    let resolve!: (value: DocumentProcessOutcome) => void
    let entered!: () => void
    const started = new Promise<void>((done) => {
      entered = done
    })
    const extract = vi.fn((request) => {
      entered()
      return new Promise<DocumentProcessOutcome>((done) => {
        resolve = () => done(result(request.jobId))
      })
    })
    grants = new LocalFileReadGrants({ extract, dispose: vi.fn() })
    const selected = await fixture('changed.pdf', Buffer.from(pdfFixtures().multiPage))
    const grant = await grants.authorize(sender, scope, selected, 'file')
    const pending = grants.read(sender, scope, params(grant.id))
    await started
    await fs.appendFile(selected, '\nchanged')
    resolve({ ok: false, code: 'LIMIT' })
    await expectCode(pending, 'FILE_CHANGED')
  })

  it.each(['cancel', 'revoke', 'scope', 'timeout', 'expiry'] as const)(
    'waits document exit on %s and returns its explicit reason',
    async (phase) => {
      let finish!: () => void
      let entered!: () => void
      let signal!: AbortSignal
      const started = new Promise<void>((done) => {
        entered = done
      })
      grants = new LocalFileReadGrants({
        extract: async (_request, value) => {
          signal = value
          entered()
          return new Promise<DocumentProcessOutcome>((done) => {
            finish = () => done({ ok: false, code: 'CANCELLED' })
          })
        },
        dispose: vi.fn()
      })
      const grant = await fileGrant('wait.pdf', Buffer.from(pdfFixtures().multiPage))
      const req = params(grant.id)
      if (phase === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let settled = false
      const pending = grants.read(sender, scope, req).finally(() => {
        settled = true
      })
      await started
      if (phase === 'cancel') grants.cancel(sender, scope, { requestId: req.requestId })
      if (phase === 'revoke') grants.revoke(sender, scope, { grantId: grant.id })
      if (phase === 'scope') grants.revokeSender(sender)
      if (phase === 'timeout') {
        await vi.advanceTimersByTimeAsync(LIMITS.deadlineMs + 1)
      }
      if (phase === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
      await Promise.resolve()
      await Promise.resolve()
      expect(signal.aborted).toBe(phase !== 'expiry')
      expect(settled).toBe(false)
      finish()
      await expectCode(
        pending,
        phase === 'cancel'
          ? 'CANCELLED'
          : phase === 'scope'
            ? 'SCOPE_CHANGED'
            : phase === 'timeout'
              ? 'TIMEOUT'
              : 'GRANT_DENIED'
      )
    }
  )
})

describe('bounded text reads and capabilities', () => {
  it.each([
    ['plain.txt', 'hello\nworld\t!'],
    ['unicode 空 格.txt', '你好 café 🌱\r\n'],
    ['empty.txt', ''],
    ['bom.txt', '\ufeffhello'],
    ['boundary.txt', 'a'.repeat(LIMITS.returnedBytes)],
    ['unicode-boundary.txt', '🌱'.repeat(LIMITS.returnedBytes / 4)]
  ])('reads %s as exact UTF-8 text', async (name, content) => {
    const grant = await fileGrant(name, content)
    expect(grant).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
      kind: 'file',
      name,
      expiresAt: expect.any(Number),
      readOnly: true
    })
    expect(grant.expiresAt - Date.now()).toBeLessThanOrEqual(LIMITS.ttlMs)
    const result = await grants.read(sender, scope, params(grant.id))
    expect(result).toEqual({
      name,
      relativePath: '',
      content,
      encoding: 'utf-8',
      sizeBytes: Buffer.byteLength(content),
      returnedBytes: Buffer.byteLength(content),
      truncated: false
    })
    expect(validateServiceValue(result, agentLocalFilesSvcDef.read.response)).toEqual(result)
    expect(JSON.stringify(grant)).not.toContain(root)
  })

  it('scopes tokens to every scope field and the sender, including revoke/cancel', async () => {
    const grant = await fileGrant()
    for (const field of ['projectId', 'paneId', 'sessionId'] as const) {
      const other = { ...scope, [field]: 'other' }
      await expectCode(grants.read(sender, other, params(grant.id)), 'GRANT_DENIED')
      await expectCode(grants.list(sender, other, params(grant.id)), 'GRANT_DENIED')
      expect(() => grants.revoke(sender, other, { grantId: grant.id })).toThrowError(
        AGENT_LOCAL_FILE_ERRORS.GRANT_DENIED
      )
      grants.revoke(sender, other, {})
    }
    await expectCode(grants.read(sender + 1, scope, params(grant.id)), 'GRANT_DENIED')
    expect(() => grants.revoke(sender + 1, scope, { grantId: grant.id })).toThrowError(
      AGENT_LOCAL_FILE_ERRORS.GRANT_DENIED
    )
    await expectCode(grants.read(sender, scope, params('z'.repeat(32))), 'GRANT_DENIED')
    await expectCode(
      new LocalFileReadGrants().read(sender, scope, params(grant.id)),
      'GRANT_DENIED'
    )
    const req = params(grant.id)
    const read = grants.read(sender, scope, req)
    grants.cancel(sender + 1, scope, { requestId: req.requestId })
    grants.cancel(sender, { ...scope, sessionId: 'other' }, { requestId: req.requestId })
    await expect(read).resolves.toMatchObject({ content: 'hello' })
  })

  it('revokes one or all grants, without revoking another sender', async () => {
    const a = await fileGrant('a.txt')
    const b = await fileGrant('b.txt')
    const other = await grants.authorize(sender + 1, scope, path.join(root, 'a.txt'), 'file')
    grants.revoke(sender, scope, { grantId: a.id })
    await expectCode(grants.read(sender, scope, params(a.id)), 'GRANT_DENIED')
    await expect(grants.read(sender, scope, params(b.id))).resolves.toMatchObject({
      content: 'hello'
    })
    grants.revoke(sender, scope, {})
    await expectCode(grants.read(sender, scope, params(b.id)), 'GRANT_DENIED')
    await expect(grants.read(sender + 1, scope, params(other.id))).resolves.toMatchObject({
      content: 'hello'
    })
  })

  it('expires grants and denies mutation of public descriptors as authority', async () => {
    const grant = await fileGrant()
    const expiration = grant.expiresAt
    grant.expiresAt += LIMITS.ttlMs
    vi.spyOn(Date, 'now').mockReturnValue(expiration)
    await expectCode(grants.read(sender, scope, params(grant.id)), 'GRANT_DENIED')
  })

  it('enforces per-scope and global caps, including concurrent authorization', async () => {
    const selected = await fixture('limits.txt')
    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, () => grants.authorize(sender, scope, selected, 'file'))
    )
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(
      LIMITS.grantsPerScope
    )
    for (const result of attempts) {
      if (result.status === 'rejected') expect(result.reason.code).toBe('GRANT_LIMIT')
    }
    await expectCode(grants.authorize(sender + 1, scope, selected, 'file'), 'GRANT_LIMIT')
    for (let i = 1; i < LIMITS.grants / LIMITS.grantsPerScope; i++) {
      await Promise.all(
        Array.from({ length: LIMITS.grantsPerScope }, () =>
          grants.authorize(sender, { ...scope, sessionId: `session-${i + 1}` }, selected, 'file')
        )
      )
    }
    await expectCode(
      grants.authorize(sender, { ...scope, sessionId: 'overflow' }, selected, 'file'),
      'GRANT_LIMIT'
    )
    grants.revoke(sender, scope, {})
    await expect(grants.authorize(sender, scope, selected, 'file')).resolves.toMatchObject({
      readOnly: true
    })
  })

  it.each([
    ['large.txt', Buffer.alloc(LIMITS.fileBytes + 1, 97), 'FILE_TOO_LARGE'],
    ['long.txt', Buffer.alloc(LIMITS.returnedBytes + 1, 97), 'TEXT_TOO_LARGE'],
    ['long-unicode.txt', '🌱'.repeat(LIMITS.returnedBytes / 4 + 1), 'TEXT_TOO_LARGE']
  ] as const)('rejects %s before opening or reading', async (name, content, code) => {
    const grant = await fileGrant(name, content)
    const open = vi.spyOn(fs, 'open')
    const readFile = vi.spyOn(fs, 'readFile')
    await expectCode(grants.read(sender, scope, params(grant.id)), code)
    expect(open).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it.each([
    ['zero-byte.txt', Buffer.from([65, 0, 66]), 'BINARY_FILE'],
    ['control.txt', Buffer.from([65, 1, 66]), 'BINARY_FILE'],
    ['image.png', 'not an image', 'BINARY_FILE'],
    ['invalid.txt', Buffer.from([0xc3, 0x28]), 'INVALID_ENCODING'],
    ['utf16.txt', Buffer.from([0xff, 0xfe, 0x41, 0]), 'INVALID_ENCODING'],
    ['document.pdf', 'not text support', 'UNSUPPORTED_FORMAT'],
    ['disguised.txt', '%PDF-1.7\n', 'UNSUPPORTED_FORMAT'],
    ['document.docx', 'not text support', 'UNSUPPORTED_FORMAT']
  ] as const)('rejects %s explicitly', async (name, content, code) => {
    const grant = await fileGrant(name, content)
    await expectCode(grants.read(sender, scope, params(grant.id)), code)
  })

  it('maps missing and OS failures to safe fixed errors', async () => {
    const grant = await fileGrant()
    await fs.unlink(path.join(root, 'note.txt'))
    await expectCode(grants.read(sender, scope, params(grant.id)), 'NOT_FOUND')
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(
      Object.assign(new Error(`${root} secret-token`), { code: 'EIO' })
    )
    await expectCode(
      grants.authorize(sender, scope, path.join(root, 'missing.txt'), 'file'),
      'IO_ERROR'
    )
  })
})

describe('path and directory boundaries', () => {
  it('reads descendants only, lists nonrecursively, and never returns absolute paths', async () => {
    await fixture('folder/unicode 空 格.txt', '你好')
    await fixture('sibling.txt')
    const grant = await grants.authorize(sender, scope, root, 'directory')
    const result = await grants.read(sender, scope, params(grant.id, 'folder/unicode 空 格.txt'))
    expect(result).toMatchObject({
      name: 'unicode 空 格.txt',
      relativePath: 'folder/unicode 空 格.txt',
      content: '你好'
    })
    const listed = await grants.list(sender, scope, params(grant.id))
    expect(listed).toEqual({
      entries: [
        { name: 'folder', kind: 'directory' },
        { name: 'sibling.txt', kind: 'file' }
      ],
      truncated: false
    })
    expect(JSON.stringify(listed)).not.toContain(root)
    expect(validateServiceValue(listed, agentLocalFilesSvcDef.list.response)).toEqual(listed)
    expect(await grants.list(sender, scope, params(grant.id, 'folder'))).toEqual({
      entries: [{ name: 'unicode 空 格.txt', kind: 'file' }],
      truncated: false
    })
    await expectCode(grants.read(sender, scope, params(grant.id)), 'PATH_DENIED')
  })

  it.each([
    '../escape.txt',
    '..\\escape.txt',
    '/absolute',
    'C:\\absolute',
    'C:relative',
    '\\\\server\\share',
    '//server/share',
    'folder/../note.txt',
    'folder//note.txt',
    './note.txt',
    'note.txt:stream',
    'note.txt.',
    'note.txt ',
    'CON',
    '%00/../note.txt'
  ])('denies traversal/alias %s for read and list', async (relative) => {
    const grant = await grants.authorize(sender, scope, root, 'directory')
    await expectCode(grants.read(sender, scope, params(grant.id, relative)), 'PATH_DENIED')
    await expectCode(grants.list(sender, scope, params(grant.id, relative)), 'PATH_DENIED')
  })

  it('does not widen exact-file grants to siblings or directory listing', async () => {
    const grant = await fileGrant()
    await fixture('sibling.txt')
    for (const relative of [
      'sibling.txt',
      'note.txt',
      '../sibling.txt',
      path.join(root, 'sibling.txt')
    ]) {
      await expectCode(grants.read(sender, scope, params(grant.id, relative)), 'PATH_DENIED')
    }
    await expectCode(grants.list(sender, scope, params(grant.id)), 'PATH_DENIED')
  })

  it.each([
    'relative.txt',
    'C:relative.txt',
    '\\\\server\\share\\item',
    '//server/share/item',
    '\\\\?\\C:\\item'
  ])('rejects nonlocal selection %s before filesystem access', async (selected) => {
    const lstat = vi.spyOn(fs, 'lstat')
    await expectCode(grants.authorize(sender, scope, selected, 'file'), 'PATH_DENIED')
    expect(lstat).not.toHaveBeenCalled()
  })

  it.each([
    '.env',
    '.env.local',
    '.ssh/id_rsa',
    '.git/config',
    'auth.json',
    'Cookies',
    'cookies.sqlite',
    'private.pem',
    'private.key',
    'store.p12',
    'vault.kdbx',
    '.kohakuterrarium/sessions/example.json',
    'fixture.kohakutr',
    'fixture.kohakutr-wal',
    'fixture.kohakutr-shm',
    'fixture.kohakutr.backup-before-repair',
    'fixture.kt',
    'fixture.drives',
    'fixture.lock',
    'fixture.db-wal'
  ])('denies sensitive synthetic path %s before filesystem access', async (relative) => {
    const grant = await grants.authorize(sender, scope, root, 'directory')
    const lstat = vi.spyOn(fs, 'lstat')
    const open = vi.spyOn(fs, 'open')
    await expectCode(
      grants.authorize(sender, scope, path.join(root, relative), 'file'),
      'PATH_DENIED'
    )
    await expectCode(grants.read(sender, scope, params(grant.id, relative)), 'PATH_DENIED')
    expect(lstat).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('denies hardlinks at selection and after a grant was issued', async () => {
    const grant = await fileGrant()
    await fs.link(path.join(root, 'note.txt'), path.join(root, 'alias.txt'))
    await expectCode(
      grants.authorize(sender, scope, path.join(root, 'alias.txt'), 'file'),
      'PATH_DENIED'
    )
    await expectCode(grants.read(sender, scope, params(grant.id)), 'PATH_DENIED')
    const directory = await grants.authorize(sender, scope, root, 'directory')
    await expectCode(grants.read(sender, scope, params(directory.id, 'alias.txt')), 'PATH_DENIED')
    expect((await grants.list(sender, scope, params(directory.id))).entries).toEqual([])
  })

  it('denies directory symlink/junction chains and does not list them', async () => {
    await fixture('actual/note.txt')
    const alias = path.join(root, 'alias')
    await fs.symlink(
      path.join(root, 'actual'),
      alias,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expectCode(grants.authorize(sender, scope, alias, 'directory'), 'PATH_DENIED')
    await expectCode(
      grants.authorize(sender, scope, path.join(alias, 'note.txt'), 'file'),
      'PATH_DENIED'
    )
    const grant = await grants.authorize(sender, scope, root, 'directory')
    await expectCode(grants.read(sender, scope, params(grant.id, 'alias/note.txt')), 'PATH_DENIED')
    await expectCode(grants.list(sender, scope, params(grant.id, 'alias')), 'PATH_DENIED')
    expect((await grants.list(sender, scope, params(grant.id))).entries).toEqual([
      { name: 'actual', kind: 'directory' }
    ])
  })

  it('denies a file symlink (if the OS permits creating one)', async (context) => {
    const selected = await fixture('note.txt')
    const alias = path.join(root, 'alias.txt')
    try {
      await fs.symlink(selected, alias, 'file')
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip()
        return
      }
      throw error
    }
    await expectCode(grants.authorize(sender, scope, alias, 'file'), 'PATH_DENIED')
    const grant = await grants.authorize(sender, scope, root, 'directory')
    await expectCode(grants.read(sender, scope, params(grant.id, 'alias.txt')), 'PATH_DENIED')
  })

  it('detects a replaced grant root and a remote filesystem without reading content', async () => {
    await fixture('folder/note.txt')
    const grant = await grants.authorize(sender, scope, path.join(root, 'folder'), 'directory')
    await fs.rename(path.join(root, 'folder'), path.join(root, 'old-folder'))
    await fixture('folder/note.txt', 'replacement')
    await expectCode(grants.read(sender, scope, params(grant.id, 'note.txt')), 'FILE_CHANGED')
    const realStatfs = fs.statfs
    vi.spyOn(fs, 'statfs').mockImplementation((async (...args: Parameters<typeof fs.statfs>) => ({
      ...(await realStatfs(...args)),
      type: 0x6969n
    })) as typeof fs.statfs)
    await expectCode(grants.authorize(sender, scope, root, 'directory'), 'PATH_DENIED')
  })

  it('caps directory scans at 100 entries and filters sensitive names', async () => {
    await Promise.all(Array.from({ length: 105 }, (_, i) => fixture(`visible-${i}.txt`)))
    const grant = await grants.authorize(sender, scope, root, 'directory')
    const readFile = vi.spyOn(fs, 'readFile')
    const open = vi.spyOn(fs, 'open')
    const result = await grants.list(sender, scope, params(grant.id))
    expect(result.entries).toHaveLength(LIMITS.listEntries)
    expect(result.truncated).toBe(true)
    expect(result.entries.every((entry) => Object.keys(entry).join(',') === 'name,kind')).toBe(true)
    expect(readFile).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    await fs.mkdir(path.join(root, 'filtered'))
    await fixture('filtered/.env', 'synthetic only')
    await fixture('filtered/auth.json', 'synthetic only')
    await fixture('filtered/visible.txt')
    expect(await grants.list(sender, scope, params(grant.id, 'filtered'))).toEqual({
      entries: [{ name: 'visible.txt', kind: 'file' }],
      truncated: false
    })
  })
})

describe('single handle, atomic revocation and deadlines', () => {
  it('opens exactly once and catches mutation during a bounded read', async () => {
    const grant = await fileGrant()
    const realOpen = fs.open
    let mutated = false
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      const realRead = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation((async (
        ...readArgs: Parameters<typeof handle.read>
      ) => {
        if (!mutated) {
          mutated = true
          await fs.appendFile(path.join(root, 'note.txt'), 'growth')
        }
        return realRead(...readArgs)
      }) as typeof handle.read)
      return handle
    })
    await expectCode(grants.read(sender, scope, params(grant.id)), 'FILE_CHANGED')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it.each(['cancel', 'revoke', 'revoke-all', 'expiry', 'timeout'] as const)(
    'denies in-flight delivery on %s and closes its handle',
    async (action) => {
      const grant = await fileGrant()
      const realOpen = fs.open
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      let closed!: () => void
      const closing = new Promise<void>((resolve) => {
        closed = resolve
      })
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await realOpen(...args)
        const realRead = handle.read.bind(handle)
        const realClose = handle.close.bind(handle)
        vi.spyOn(handle, 'read').mockImplementation((async (
          ...readArgs: Parameters<typeof handle.read>
        ) => {
          entered()
          await gate
          return realRead(...readArgs)
        }) as typeof handle.read)
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          try {
            await realClose()
          } finally {
            closed()
          }
        })
        return handle
      })
      if (action === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const req = params(grant.id)
      const reading = grants.read(sender, scope, req)
      const expected = expectCode(
        reading,
        action === 'cancel' ? 'CANCELLED' : action === 'timeout' ? 'TIMEOUT' : 'GRANT_DENIED'
      )
      await waiting
      await expectCode(grants.read(sender, scope, req), 'BUSY')
      try {
        if (action === 'cancel') grants.cancel(sender, scope, { requestId: req.requestId })
        if (action === 'revoke') grants.revoke(sender, scope, { grantId: grant.id })
        if (action === 'revoke-all') grants.revoke(sender, scope, {})
        if (action === 'expiry') {
          vi.spyOn(Date, 'now').mockReturnValue(grant.expiresAt)
          release()
        }
        if (action === 'timeout') await vi.advanceTimersByTimeAsync(LIMITS.deadlineMs)
        await expected
      } finally {
        release()
        await closing
      }
    }
  )

  it('revoke-all also cancels pending authorization', async () => {
    const selected = await fixture('note.txt')
    const authorizing = grants.authorize(sender, scope, selected, 'file')
    grants.revoke(sender, scope, {})
    await expectCode(authorizing, 'GRANT_DENIED')
  })
})
