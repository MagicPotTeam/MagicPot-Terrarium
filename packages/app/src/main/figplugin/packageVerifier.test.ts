import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import fs, { type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import {
  FIGPLUGIN_PACKAGE_FORMAT,
  FigPluginPackageSchema,
  MAX_ENVELOPE_BYTES,
  MAX_FILE_BYTES,
  canonicalFigPluginPackageIndex,
  getFigPluginPackageSigningPayload,
  type FigPluginPackage
} from '@shared/figplugin/package'
import { readAndVerifyFigPluginPackageFile, verifyFigPluginPackage } from './packageVerifier'

vi.unmock('fs')
vi.unmock('node:fs')
vi.unmock('fs/promises')
vi.unmock('node:fs/promises')

const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const roots: string[] = []

function resign(pkg: FigPluginPackage, privateKey: KeyObject): void {
  pkg.manifest.signature.value = sign(
    null,
    Buffer.from(getFigPluginPackageSigningPayload(pkg)),
    privateKey
  ).toString('base64url')
}

function fixture(contents = [Buffer.from('globalThis.figpluginVerifierExecuted = true;')]) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const files = contents.map((content, index) => ({
    path: `plugin/file-${index}.js`,
    bytes: content.length,
    sha256: hash(content),
    contentBase64: content.toString('base64')
  }))
  const pkg = FigPluginPackageSchema.parse({
    format: FIGPLUGIN_PACKAGE_FORMAT,
    manifest: {
      schemaVersion: 1,
      id: 'synthetic.figplugin',
      name: 'Synthetic FIGPLUGIN',
      version: '1.0.0',
      host: 'figma',
      entryPath: files[0].path,
      capabilities: ['dialogue'],
      permissions: { dialogue: 'prompt' },
      limits: {},
      provenance: {
        publisherId: 'synthetic-publisher',
        publisherName: 'Synthetic Publisher',
        source: 'user-provided',
        artifactSha256: '0'.repeat(64),
        sourceUrl: 'https://figplugin.invalid/never-fetch',
        issuedAt: '2026-01-01T00:00:00.000Z'
      },
      signature: {
        algorithm: 'ed25519',
        keyId: 'synthetic-key',
        value: '0'.repeat(128),
        signedAt: '2026-01-01T00:00:00.000Z'
      },
      assets: files.map((file, index) => ({
        id: `asset-${index}`,
        path: file.path,
        sizeBytes: file.bytes,
        sha256: file.sha256
      }))
    },
    files
  })
  pkg.manifest.provenance.artifactSha256 = hash(canonicalFigPluginPackageIndex(pkg))
  resign(pkg, privateKey)
  return { pkg, publicKeyPem, publicKey, privateKey }
}

async function temporaryPackage() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'figplugin-verifier-'))
  roots.push(root)
  // Resolve platform-owned aliases (e.g. macOS /var) before selecting our own file.
  const canonicalRoot = await fs.realpath(root)
  const filename = path.join(canonicalRoot, 'selected package.json')
  const data = fixture()
  await fs.writeFile(filename, JSON.stringify(data.pkg))
  return { ...data, root: canonicalRoot, filename }
}

async function rejectsSafely(operation: () => unknown, code: string): Promise<void> {
  let caught: unknown
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ServiceError)
  const error = caught as ServiceError
  expect(error.code).toBe(code)
  expect(error.cause).toBeUndefined()
  expect(error.payload).toBeUndefined()
  expect(error.toJSON()).toEqual({ code, message: error.message })
  expect(error.message).toMatch(/^FIGPLUGIN package /)
  expect(JSON.stringify(error)).not.toMatch(
    /figplugin\.invalid|synthetic|selected package|ENOENT|issues/
  )
}

function captureOpen(onOpen: (handle: FileHandle) => void) {
  const open = fs.open.bind(fs)
  return vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args)
    onOpen(handle)
    return handle
  })
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

describe('verifyFigPluginPackage', () => {
  it('verifies synthetic Ed25519 bytes, canonical index and DER SPKI fingerprint without effects', () => {
    const { pkg, publicKeyPem, publicKey } = fixture()
    const fetch = vi.fn(() => {
      throw new Error('must not fetch')
    })
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('figpluginVerifierExecuted', false)
    const result = verifyFigPluginPackage(pkg, publicKeyPem)
    expect(result.package).toEqual(pkg)
    expect(result.keyFingerprint).toBe(hash(publicKey.export({ format: 'der', type: 'spki' })))
    expect(result.artifactSha256).toBe(hash(canonicalFigPluginPackageIndex(pkg)))
    expect(result.files).toEqual([
      { path: pkg.files[0].path, data: Buffer.from(pkg.files[0].contentBase64, 'base64') }
    ])
    expect(fetch).not.toHaveBeenCalled()
    expect(Reflect.get(globalThis, 'figpluginVerifierExecuted')).toBe(false)
  })

  it.each(['hex', 'base64url', 'padded-base64url'] as const)(
    'accepts canonical %s signatures',
    (encoding) => {
      const { pkg, publicKeyPem, privateKey } = fixture()
      const signature = sign(null, Buffer.from(getFigPluginPackageSigningPayload(pkg)), privateKey)
      pkg.manifest.signature.value =
        encoding === 'hex'
          ? signature.toString('hex')
          : signature.toString('base64url') + (encoding === 'padded-base64url' ? '==' : '')
      expect(verifyFigPluginPackage(pkg, publicKeyPem).files).toHaveLength(1)
    }
  )

  it('rejects changed content even when its canonical base64 shape and length still match', async () => {
    const { pkg, publicKeyPem } = fixture()
    const content = Buffer.from(pkg.files[0].contentBase64, 'base64')
    content[0] ^= 1
    pkg.files[0].contentBase64 = content.toString('base64')
    await rejectsSafely(() => verifyFigPluginPackage(pkg, publicKeyPem), 'INTEGRITY_FAILED')
  })

  it.each(['name', 'signedAt', 'keyId', 'sourceUrl'])(
    'authenticates manifest %s',
    async (field) => {
      const { pkg, publicKeyPem } = fixture()
      if (field === 'name') pkg.manifest.name = 'Changed name'
      if (field === 'signedAt') pkg.manifest.signature.signedAt = '2026-01-02T00:00:00.000Z'
      if (field === 'keyId') pkg.manifest.signature.keyId = 'changed-key'
      if (field === 'sourceUrl') pkg.manifest.provenance.sourceUrl = 'https://changed.invalid/'
      await rejectsSafely(() => verifyFigPluginPackage(pkg, publicKeyPem), 'INVALID_SIGNATURE')
    }
  )

  it('rejects a different Ed25519 public key', async () => {
    const { pkg } = fixture()
    const { publicKeyPem } = fixture()
    await rejectsSafely(() => verifyFigPluginPackage(pkg, publicKeyPem), 'INVALID_SIGNATURE')
  })

  it('rejects a correctly signed but incorrect provenance index hash', async () => {
    const { pkg, publicKeyPem, privateKey } = fixture()
    pkg.manifest.provenance.artifactSha256 = 'f'.repeat(64)
    resign(pkg, privateKey)
    await rejectsSafely(() => verifyFigPluginPackage(pkg, publicKeyPem), 'INTEGRITY_FAILED')
  })

  it.each(['missing', 'malformed', 'noncanonical'])(
    'rejects %s signature shape safely',
    async (kind) => {
      const { pkg, publicKeyPem } = fixture()
      if (kind === 'missing') Reflect.deleteProperty(pkg.manifest, 'signature')
      else
        pkg.manifest.signature.value =
          kind === 'malformed' ? 'not-a-signature' : `${'A'.repeat(85)}B`
      await rejectsSafely(() => verifyFigPluginPackage(pkg, publicKeyPem), 'INVALID_PACKAGE')
    }
  )

  it.each(['private', 'rsa', 'certificate', 'oversized', 'prefixed', 'multiple', 'der-tail'])(
    'rejects %s PEM',
    async (kind) => {
      const { pkg, publicKeyPem, publicKey, privateKey } = fixture()
      let pem = publicKeyPem
      if (kind === 'private') pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
      if (kind === 'rsa')
        pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
          .publicKey.export({ format: 'pem', type: 'spki' })
          .toString()
      if (kind === 'certificate') pem = pem.replaceAll('PUBLIC KEY', 'CERTIFICATE')
      if (kind === 'oversized') pem += 'x'.repeat(4096)
      if (kind === 'prefixed') pem = `secret-prefix\n${pem}`
      if (kind === 'multiple') pem += publicKeyPem
      if (kind === 'der-tail')
        pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([publicKey.export({ format: 'der', type: 'spki' }), Buffer.from([0])]).toString('base64')}\n-----END PUBLIC KEY-----\n`
      await rejectsSafely(() => verifyFigPluginPackage(pkg, pem), 'INVALID_SIGNER')
    }
  )

  it('accepts the exact 2 MiB/file and 8 MiB aggregate limits', () => {
    const { pkg, publicKeyPem } = fixture(
      Array.from({ length: 4 }, () => Buffer.alloc(MAX_FILE_BYTES, 0x61))
    )
    const result = verifyFigPluginPackage(pkg, publicKeyPem)
    expect(result.files.reduce((size, file) => size + file.data.length, 0)).toBe(8 * 1024 * 1024)
  })

  it.each(['file', 'aggregate', 'declared', 'base64'])(
    'rejects excessive or inconsistent %s bytes',
    async (kind) => {
      const { pkg, publicKeyPem } = fixture()
      if (kind === 'file')
        pkg.files[0].contentBase64 = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64')
      if (kind === 'aggregate') {
        const { pkg: large } = fixture(
          Array.from({ length: 4 }, () => Buffer.alloc(MAX_FILE_BYTES))
        )
        pkg.files = [...large.files, { ...large.files[0], path: 'extra.js' }]
      }
      if (kind === 'declared') pkg.files[0].bytes += 1
      if (kind === 'base64') pkg.files[0].contentBase64 += '\n'
      await rejectsSafely(() => verifyFigPluginPackage(pkg, publicKeyPem), 'INVALID_PACKAGE')
    }
  )
})

describe('readAndVerifyFigPluginPackageFile (trusted native selection only)', () => {
  it('reads an ordinary absolute temporary .json file and always closes its handle', async () => {
    const { filename, pkg, publicKeyPem } = await temporaryPackage()
    const closed = vi.fn()
    captureOpen((handle) => {
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        closed()
      })
    })
    expect((await readAndVerifyFigPluginPackageFile(filename, publicKeyPem)).package).toEqual(pkg)
    expect(closed).toHaveBeenCalledOnce()
  })

  it.each([
    'relative.json',
    '//server/share/a.json',
    '\\\\server\\share\\a.json',
    'C:relative.json',
    '/tmp/ambiguous\\file',
    'bad\0name'
  ])('rejects ambiguous path %s before I/O', async (filename) => {
    const lstat = vi.spyOn(fs, 'lstat')
    await rejectsSafely(() => readAndVerifyFigPluginPackageFile(filename, ''), 'INVALID_PACKAGE')
    expect(lstat).not.toHaveBeenCalled()
  })

  it('rejects more than 64 path segments before I/O', async () => {
    const { root } = await temporaryPackage()
    const lstat = vi.spyOn(fs, 'lstat')
    await rejectsSafely(
      () => readAndVerifyFigPluginPackageFile(path.join(root, ...Array<string>(65).fill('a')), ''),
      'INVALID_PACKAGE'
    )
    expect(lstat).not.toHaveBeenCalled()
  })

  it('rejects missing files without exposing the temporary path', async () => {
    const { root, publicKeyPem } = await temporaryPackage()
    await rejectsSafely(
      () => readAndVerifyFigPluginPackageFile(path.join(root, 'missing.json'), publicKeyPem),
      'INVALID_PACKAGE'
    )
  })

  it('rejects a parent junction/symlink without opening its target', async () => {
    const { root, filename, publicKeyPem } = await temporaryPackage()
    const target = path.join(root, 'target')
    const alias = path.join(root, 'alias')
    await fs.mkdir(target)
    await fs.rename(filename, path.join(target, 'package.json'))
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const open = vi.spyOn(fs, 'open')
    await rejectsSafely(
      () => readAndVerifyFigPluginPackageFile(path.join(alias, 'package.json'), publicKeyPem),
      'INVALID_PACKAGE'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects hardlinked files and directory selections', async () => {
    const { filename, root, publicKeyPem } = await temporaryPackage()
    await fs.link(filename, path.join(root, 'hardlink.json'))
    await rejectsSafely(
      () => readAndVerifyFigPluginPackageFile(filename, publicKeyPem),
      'INVALID_PACKAGE'
    )
    await rejectsSafely(
      () => readAndVerifyFigPluginPackageFile(root, publicKeyPem),
      'INVALID_PACKAGE'
    )
  })

  it('rejects envelopes over 12 MiB before opening a read handle', async () => {
    const { filename, publicKeyPem } = await temporaryPackage()
    await fs.truncate(filename, MAX_ENVELOPE_BYTES + 1)
    const open = vi.spyOn(fs, 'open')
    await rejectsSafely(
      () => readAndVerifyFigPluginPackageFile(filename, publicKeyPem),
      'INVALID_PACKAGE'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['utf8', 'json'])('rejects invalid %s without raw errors', async (kind) => {
    const { filename, publicKeyPem } = await temporaryPackage()
    await fs.writeFile(
      filename,
      kind === 'utf8' ? Buffer.from([0xc3, 0x28]) : '{private-source-secret'
    )
    await rejectsSafely(
      () => readAndVerifyFigPluginPackageFile(filename, publicKeyPem),
      'INVALID_PACKAGE'
    )
  })

  it.each(['cancelled', 'expired'])(
    'rejects %s operations before any filesystem access',
    async (kind) => {
      const controller = new AbortController()
      if (kind === 'cancelled') controller.abort(new Error('secret-cancellation-reason'))
      const lstat = vi.spyOn(fs, 'lstat')
      await rejectsSafely(
        () =>
          readAndVerifyFigPluginPackageFile('unused', '', {
            signal: controller.signal,
            deadlineAt: kind === 'expired' ? Date.now() - 1 : undefined
          }),
        'INVALID_PACKAGE'
      )
      expect(lstat).not.toHaveBeenCalled()
    }
  )

  it('cancels between reads and closes the open handle', async () => {
    const { filename, publicKeyPem } = await temporaryPackage()
    const controller = new AbortController()
    let closed: Promise<void> | undefined
    captureOpen((handle) => {
      const read = handle.read.bind(handle)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(() => (closed = close()))
      vi.spyOn(handle, 'read').mockImplementation(
        async (...args: Parameters<typeof handle.read>) => {
          const result = await read(...args)
          controller.abort()
          return result
        }
      )
    })
    await rejectsSafely(
      () =>
        readAndVerifyFigPluginPackageFile(filename, publicKeyPem, { signal: controller.signal }),
      'INVALID_PACKAGE'
    )
    // The abort race can reject one microtask before the read continuation closes.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(closed).toBeDefined()
    await closed
  })

  it.each(['growth', 'shrink', 'mtime', 'identity'])(
    'rejects %s races and closes the handle',
    async (kind) => {
      const { filename, publicKeyPem } = await temporaryPackage()
      let closed: Promise<void> | undefined
      let requestedBytes = 0
      captureOpen((handle) => {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementation(() => (closed = close()))
        if (kind === 'identity') {
          const stat = handle.stat.bind(handle)
          vi.spyOn(handle, 'stat').mockImplementation(async () => {
            const info = await stat({ bigint: true })
            info.ino += 1n
            return info
          })
        } else {
          const read = handle.read.bind(handle)
          let changed = false
          vi.spyOn(handle, 'read').mockImplementation(
            async (...args: Parameters<typeof handle.read>) => {
              const result = await read(...args)
              requestedBytes += result.bytesRead
              if (!changed) {
                changed = true
                if (kind === 'growth') await fs.appendFile(filename, 'extra')
                if (kind === 'shrink') await fs.truncate(filename, 1)
                if (kind === 'mtime') await fs.utimes(filename, new Date(0), new Date(0))
              }
              return result
            }
          )
        }
      })
      const originalSize = (await fs.stat(filename)).size
      await rejectsSafely(
        () => readAndVerifyFigPluginPackageFile(filename, publicKeyPem),
        'INTEGRITY_FAILED'
      )
      expect(requestedBytes).toBeLessThanOrEqual(originalSize + 1)
      expect(closed).toBeDefined()
      await closed
    }
  )

  it('uses one deadline across pending I/O and closes a late-opened handle', async () => {
    const { filename, publicKeyPem } = await temporaryPackage()
    const open = fs.open.bind(fs)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const opening = new Promise<void>((resolve) => {
      entered = resolve
    })
    let closed!: () => void
    const closure = new Promise<void>((resolve) => {
      closed = resolve
    })
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      entered()
      await gate
      const handle = await open(...args)
      const close = handle.close.bind(handle)
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close()
        closed()
      })
      return handle
    })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      const rejected = rejectsSafely(
        () => readAndVerifyFigPluginPackageFile(filename, publicKeyPem),
        'INVALID_PACKAGE'
      )
      await opening
      await vi.advanceTimersByTimeAsync(10_000)
      await rejected
      release()
      await closure
    } finally {
      release()
      vi.useRealTimers()
    }
  })
})
