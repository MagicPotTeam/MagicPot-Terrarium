import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createArtifactPreparer } from './artifactPreparer'
import type { AppArtifactV1, RuntimeArtifactV1 } from './channelManifestProtocol'

const common = {
  platform: 'win32' as const,
  arch: 'x64' as const,
  size: 1,
  unpackedSize: 1,
  sha256: 'a'.repeat(64),
  entrypoint: 'app.exe',
  createdAt: '2026-01-01T00:00:00.000Z'
}

const app: AppArtifactV1 = {
  ...common,
  kind: 'app',
  buildId: 'build-1',
  runtimeId: 'runtime-1',
  version: '1.0.0',
  commitSha: 'b'.repeat(40),
  url: 'https://updates.example/app.zip'
}

const runtime: RuntimeArtifactV1 = {
  ...common,
  kind: 'runtime',
  runtimeId: 'runtime-1',
  url: 'https://updates.example/runtime.7z'
}

describe('createArtifactPreparer', () => {
  it('returns a diagnostic unsupported error for runtime 7z artifacts', async () => {
    const stagingParent = await mkdtemp(path.join(os.tmpdir(), 'preparer-test-'))
    const prepare = createArtifactPreparer({ stagingParent })
    await expect(
      prepare({ artifact: runtime, downloadedPath: 'runtime.7z', kind: 'runtime' })
    ).rejects.toMatchObject({
      name: 'LauncherArtifactPreparationError',
      code: 'UNSUPPORTED_FORMAT'
    })
  })

  it('routes runtime zip artifacts through the safe zip extractor', async () => {
    const stagingParent = await mkdtemp(path.join(os.tmpdir(), 'preparer-test-'))
    const prepare = createArtifactPreparer({ stagingParent })
    await expect(
      prepare({
        artifact: { ...runtime, url: 'https://updates.example/runtime.zip' },
        downloadedPath: 'missing-runtime.zip',
        kind: 'runtime'
      })
    ).rejects.not.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
  })

  it('rejects mismatched kinds and non-zip app formats', async () => {
    const stagingParent = await mkdtemp(path.join(os.tmpdir(), 'preparer-test-'))
    const prepare = createArtifactPreparer({ stagingParent })
    await expect(
      prepare({ artifact: app, downloadedPath: 'app.zip', kind: 'runtime' })
    ).rejects.toMatchObject({ code: 'ARTIFACT_MISMATCH' })
    await expect(
      prepare({
        artifact: { ...app, url: 'https://updates.example/app.tar' },
        downloadedPath: 'app.tar',
        kind: 'app'
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
  })
})
