import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { ServiceError } from '@shared/api/apiUtils/serviceValidation'
import {
  FigPluginPackageSchema,
  MAX_CONTENT_BYTES,
  MAX_ENVELOPE_BYTES,
  MAX_FILE_BYTES,
  canonicalFigPluginPackageIndex,
  getFigPluginPackageSigningPayload,
  parseFigPluginPackageText,
  type FigPluginPackage,
  type FigPluginPackageFile
} from '@shared/figplugin/package'

export type VerifiedFigPluginPackage = {
  package: FigPluginPackage
  keyFingerprint: string
  artifactSha256: string
  files: Array<{ path: string; data: Buffer }>
}

const MESSAGES = {
  INVALID_PACKAGE: 'FIGPLUGIN package is invalid or unavailable.',
  INVALID_SIGNATURE: 'FIGPLUGIN package signature is invalid.',
  INVALID_SIGNER: 'FIGPLUGIN package signer is invalid.',
  INTEGRITY_FAILED: 'FIGPLUGIN package integrity verification failed.'
} as const

type FailureCode = keyof typeof MESSAGES
type Check = () => void

class PackageVerificationError extends ServiceError {
  constructor(code: FailureCode) {
    super(MESSAGES[code], { code })
  }
}

function fail(code: FailureCode): never {
  throw new PackageVerificationError(code)
}

function guarded<T>(code: FailureCode, operation: () => T): T {
  try {
    return operation()
  } catch {
    return fail(code)
  }
}

function digest(value: string | Buffer, check: Check): string {
  check()
  const hash = guarded('INTEGRITY_FAILED', () => createHash('sha256').update(value).digest('hex'))
  check()
  return hash
}

function signer(publicKeyPem: string): { key: KeyObject; spki: Buffer } {
  return guarded('INVALID_SIGNER', () => {
    if (typeof publicKeyPem !== 'string' || Buffer.byteLength(publicKeyPem, 'utf8') > 4096) {
      return fail('INVALID_SIGNER')
    }
    const match =
      /^-----BEGIN PUBLIC KEY-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END PUBLIC KEY-----(?:\r?\n)?(?![\s\S])/.exec(
        publicKeyPem
      )
    if (!match) return fail('INVALID_SIGNER')
    const body = match[1].replace(/\r?\n/g, '')
    const der = Buffer.from(body, 'base64')
    if (der.toString('base64') !== body) return fail('INVALID_SIGNER')
    const key = createPublicKey({ key: publicKeyPem, format: 'pem', type: 'spki' })
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') return fail('INVALID_SIGNER')
    const spki = key.export({ format: 'der', type: 'spki' })
    // OpenSSL can accept trailing DER data; require exactly the exported SPKI.
    if (!spki.equals(der)) return fail('INVALID_SIGNER')
    return { key, spki }
  })
}

function decodeBoundedBuffer(file: FigPluginPackageFile, check: Check): Buffer {
  check()
  if (
    file.contentBase64.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
    Buffer.byteLength(file.contentBase64, 'base64') > MAX_FILE_BYTES
  ) {
    return fail('INVALID_PACKAGE')
  }
  const data = guarded('INVALID_PACKAGE', () => Buffer.from(file.contentBase64, 'base64'))
  if (data.length !== file.bytes || data.length > MAX_FILE_BYTES) return fail('INTEGRITY_FAILED')
  check()
  return data
}

function verifyPackage(
  value: unknown,
  publicKeyPem: string,
  check: Check
): VerifiedFigPluginPackage {
  check()
  const pkg = guarded('INVALID_PACKAGE', () => FigPluginPackageSchema.parse(value))
  check()
  const { key, spki } = signer(publicKeyPem)
  const keyFingerprint = digest(spki, check)
  check()
  const validSignature = guarded('INVALID_SIGNATURE', () => {
    const signature = pkg.manifest.signature.value
    const bytes = Buffer.from(signature, /^[A-Fa-f0-9]{128}$/.test(signature) ? 'hex' : 'base64url')
    return (
      bytes.length === 64 &&
      verify(null, Buffer.from(getFigPluginPackageSigningPayload(pkg), 'utf8'), key, bytes)
    )
  })
  check()
  if (!validSignature) return fail('INVALID_SIGNATURE')

  let contentBytes = 0
  const files = pkg.files.map((file) => {
    const data = decodeBoundedBuffer(file, check)
    contentBytes += data.length
    if (contentBytes > MAX_CONTENT_BYTES) return fail('INVALID_PACKAGE')
    if (digest(data, check) !== file.sha256) return fail('INTEGRITY_FAILED')
    return { path: file.path, data }
  })
  const artifactSha256 = digest(
    guarded('INVALID_PACKAGE', () => canonicalFigPluginPackageIndex(pkg)),
    check
  )
  if (artifactSha256 !== pkg.manifest.provenance.artifactSha256) return fail('INTEGRITY_FAILED')
  check()
  return { package: pkg, keyFingerprint, artifactSha256, files }
}

/** Verifies bytes and metadata only: never fetches provenance URLs or executes package content. */
export function verifyFigPluginPackage(
  value: unknown,
  publicKeyPem: string
): VerifiedFigPluginPackage {
  return verifyPackage(value, publicKeyPem, () => undefined)
}

const windows = process.platform === 'win32'
const MAX_PATH_SEGMENTS = 64
const DEFAULT_TIMEOUT_MS = 10_000
const READ_CHUNK_BYTES = 64 * 1024

function localAbsolute(filename: string): { filename: string; chain: string[] } {
  if (
    typeof filename !== 'string' ||
    filename.length > 32_768 ||
    filename.includes('\0') ||
    !path.isAbsolute(filename) ||
    (windows ? !/^[A-Za-z]:[\\/]/.test(filename) : filename.includes('\\'))
  ) {
    return fail('INVALID_PACKAGE')
  }
  const separated = windows ? filename.replace(/\\/g, '/') : filename
  const segments = separated.slice(windows ? 3 : 1).split('/')
  if (
    !segments.length ||
    segments.length > MAX_PATH_SEGMENTS ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        (windows &&
          (/[<>:"|?*]/.test(segment) ||
            /[. ]$/.test(segment) ||
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\.|$)/i.test(segment)))
    )
  ) {
    return fail('INVALID_PACKAGE')
  }
  let current = path.parse(filename).root
  const chain = [current]
  for (const segment of segments) {
    current = path.join(current, segment)
    chain.push(current)
  }
  return { filename: current, chain }
}

function samePath(left: string, right: string): boolean {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino === right.ino && left.dev === right.dev && left.mode === right.mode
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    sameIdentity(left, right) &&
    left.nlink === 1n &&
    right.nlink === 1n &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function boundedFile(stat: BigIntStats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size <= 0n ||
    stat.size > BigInt(MAX_ENVELOPE_BYTES)
  ) {
    fail('INVALID_PACKAGE')
  }
}

async function inspect(
  selected: ReturnType<typeof localAbsolute>,
  check: Check
): Promise<{ chain: BigIntStats[]; file: BigIntStats }> {
  const chain: BigIntStats[] = []
  for (const [index, filename] of selected.chain.entries()) {
    check()
    const stat = await fs.lstat(filename, { bigint: true })
    check()
    if (stat.isSymbolicLink()) return fail('INVALID_PACKAGE')
    if (index === selected.chain.length - 1) boundedFile(stat)
    else if (!stat.isDirectory()) return fail('INVALID_PACKAGE')
    chain.push(stat)
  }
  check()
  const real = await fs.realpath(selected.filename)
  check()
  if (!samePath(real, selected.filename)) return fail('INVALID_PACKAGE')
  return { chain, file: chain[chain.length - 1] }
}

function unchangedChain(left: BigIntStats[], right: BigIntStats[]): void {
  if (
    left.length !== right.length ||
    !left.every((stat, index) => sameIdentity(stat, right[index]))
  ) {
    fail('INTEGRITY_FAILED')
  }
}

async function readSelectedFile(filename: string, check: Check): Promise<string> {
  check()
  const selected = localAbsolute(filename)
  const original = await inspect(selected, check)
  check()
  const handle = await fs.open(
    selected.filename,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  )
  try {
    check()
    const before = await handle.stat({ bigint: true })
    check()
    boundedFile(before)
    if (!sameFile(original.file, before)) return fail('INTEGRITY_FAILED')
    const opened = await inspect(selected, check)
    unchangedChain(original.chain, opened.chain)
    if (!sameFile(before, opened.file)) return fail('INTEGRITY_FAILED')

    const buffer = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < buffer.length) {
      check()
      const { bytesRead } = await handle.read(
        buffer,
        length,
        Math.min(READ_CHUNK_BYTES, buffer.length - length),
        length
      )
      check()
      if (bytesRead === 0) break
      length += bytesRead
    }
    check()
    const after = await handle.stat({ bigint: true })
    check()
    if (BigInt(length) !== before.size || !sameFile(before, after)) return fail('INTEGRITY_FAILED')
    const finished = await inspect(selected, check)
    unchangedChain(original.chain, finished.chain)
    if (!sameFile(after, finished.file)) return fail('INTEGRITY_FAILED')
    check()
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length)
    )
  } finally {
    await handle.close()
  }
}

/**
 * Main-only: filename MUST come from an actual, approved native chooser selection,
 * never a renderer-supplied path. This does not grant read authority or detect
 * mapped network drives; the service/native chooser owns that authorization.
 */
export async function readAndVerifyFigPluginPackageFile(
  filename: string,
  publicKeyPem: string,
  options: { signal?: AbortSignal; deadlineAt?: number } = {}
): Promise<VerifiedFigPluginPackage> {
  const deadlineAt = options.deadlineAt ?? Date.now() + DEFAULT_TIMEOUT_MS
  let stopped = false
  const check = (): void => {
    if (
      stopped ||
      options.signal?.aborted ||
      !Number.isFinite(deadlineAt) ||
      Date.now() >= deadlineAt
    ) {
      fail('INVALID_PACKAGE')
    }
  }
  check()
  let rejectCancellation: (error: PackageVerificationError) => void = () => undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const cancel = (): void => {
    stopped = true
    rejectCancellation(new PackageVerificationError('INVALID_PACKAGE'))
  }
  // One absolute deadline spans I/O, parsing, decoding and every hash/signature check.
  const timer = setTimeout(cancel, Math.min(deadlineAt - Date.now(), 2_147_483_647))
  options.signal?.addEventListener('abort', cancel, { once: true })
  const operation = async (): Promise<VerifiedFigPluginPackage> => {
    try {
      const text = await readSelectedFile(filename, check)
      check()
      const pkg = guarded('INVALID_PACKAGE', () => parseFigPluginPackageText(text))
      return verifyPackage(pkg, publicKeyPem, check)
    } catch (error) {
      if (error instanceof PackageVerificationError) throw error
      return fail('INVALID_PACKAGE')
    }
  }
  try {
    // Native filesystem promises cannot be aborted. A late open/read checks stopped
    // before doing more work and its finally closes the handle, even after this race.
    return await Promise.race([operation(), cancellation])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
}
