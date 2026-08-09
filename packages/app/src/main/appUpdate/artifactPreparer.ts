import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { AppArtifactV1, RuntimeArtifactV1 } from './channelManifestProtocol'
import { extractZipSafely, type SafeZipExtractionOptions } from './safeZipExtractor'

export interface PrepareArtifactInput {
  artifact: AppArtifactV1 | RuntimeArtifactV1
  downloadedPath: string
  kind: 'app' | 'runtime'
}

export class LauncherArtifactPreparationError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_FORMAT' | 'ARTIFACT_MISMATCH',
    message: string
  ) {
    super(message)
    this.name = 'LauncherArtifactPreparationError'
  }
}

export interface ArtifactPreparerOptions {
  stagingParent: string
  zipLimits?: Omit<SafeZipExtractionOptions, 'archivePath' | 'stagingParent'>
}

function extensionFromUrl(url: string): string {
  return path.posix.extname(new URL(url).pathname).toLocaleLowerCase('en-US')
}

export interface PreparedArtifact {
  sourceDirectory: string
  cleanup?: () => Promise<void>
}

export function createArtifactPreparer(
  options: ArtifactPreparerOptions
): (input: PrepareArtifactInput) => Promise<PreparedArtifact> {
  return async (input) => {
    if (input.kind !== input.artifact.kind)
      throw new LauncherArtifactPreparationError(
        'ARTIFACT_MISMATCH',
        `Artifact kind ${input.artifact.kind} does not match preparation kind ${input.kind}`
      )
    const extension = extensionFromUrl(input.artifact.url)
    if (extension === '.7z')
      throw new LauncherArtifactPreparationError(
        'UNSUPPORTED_FORMAT',
        `${input.kind === 'runtime' ? 'Runtime' : 'App'} .7z preparation is unsupported: no safe built-in Node.js 7z extractor is available`
      )
    if (extension !== '.zip')
      throw new LauncherArtifactPreparationError(
        'UNSUPPORTED_FORMAT',
        `Unsupported ${input.kind} artifact format: ${extension || '(none)'}`
      )
    const configuredCompressedLimit = options.zipLimits?.maxCompressedBytes
    const configuredUncompressedLimit = options.zipLimits?.maxUncompressedBytes
    if (configuredCompressedLimit !== undefined && configuredCompressedLimit > input.artifact.size)
      throw new LauncherArtifactPreparationError(
        'ARTIFACT_MISMATCH',
        'Configured compressed ZIP budget cannot exceed artifact manifest size'
      )
    if (
      configuredUncompressedLimit !== undefined &&
      configuredUncompressedLimit > input.artifact.unpackedSize
    )
      throw new LauncherArtifactPreparationError(
        'ARTIFACT_MISMATCH',
        'Configured unpacked ZIP budget cannot exceed artifact manifest size'
      )
    const sourceDirectory = await extractZipSafely({
      archivePath: input.downloadedPath,
      stagingParent: options.stagingParent,
      ...options.zipLimits,
      maxCompressedBytes: configuredCompressedLimit ?? input.artifact.size,
      maxUncompressedBytes: configuredUncompressedLimit ?? input.artifact.unpackedSize,
      expectedUncompressedBytes: input.artifact.unpackedSize
    })
    return {
      sourceDirectory,
      cleanup: () => rm(sourceDirectory, { recursive: true, force: true })
    }
  }
}
