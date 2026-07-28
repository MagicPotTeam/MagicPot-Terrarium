import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'

const SHA256_PATTERN = /^[0-9a-f]{64}$/

export interface ArtifactExpectation {
  size: number
  sha256: string
}

export interface VerifiedArtifact {
  path: string
  size: number
  sha256: string
}

export class ArtifactVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactVerificationError'
  }
}

export async function verifyLocalArtifact(
  artifactPath: string,
  expected: ArtifactExpectation
): Promise<VerifiedArtifact> {
  if (!Number.isSafeInteger(expected.size) || expected.size < 0)
    throw new TypeError('Artifact size must be a non-negative safe integer')
  if (!SHA256_PATTERN.test(expected.sha256))
    throw new TypeError('Artifact SHA-256 must be 64 lowercase hexadecimal characters')

  const stat = await fsp.lstat(artifactPath)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ArtifactVerificationError('Artifact must be a regular file and not a symbolic link')
  if (stat.size !== expected.size)
    throw new ArtifactVerificationError(
      `Artifact size mismatch: expected ${expected.size}, received ${stat.size}`
    )

  const hash = createHash('sha256')
  let bytesRead = 0
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(artifactPath)
    stream.on('data', (chunk: string | Buffer) => {
      bytesRead += Buffer.byteLength(chunk)
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })

  if (bytesRead !== expected.size)
    throw new ArtifactVerificationError(
      `Artifact size changed during verification: expected ${expected.size}, received ${bytesRead}`
    )
  const sha256 = hash.digest('hex')
  if (sha256 !== expected.sha256) throw new ArtifactVerificationError('Artifact SHA-256 mismatch')
  return { path: artifactPath, size: bytesRead, sha256 }
}
