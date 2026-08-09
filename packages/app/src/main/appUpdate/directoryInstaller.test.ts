import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { vol } from 'memfs'
import { beforeEach, describe, expect, it } from 'vitest'
import { installPreExtractedDirectory } from './directoryInstaller'

const runtimeId = 'comfy-win-x64-20260701-a1b2c3d'
let rootSequence = 0
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

async function temporaryRoot(): Promise<string> {
  const root = `/magicpot-installer-${++rootSequence}-${randomUUID()}`
  await fs.mkdir(root, { recursive: true })
  return root
}

async function writeRuntime(source: string, overrides: Record<string, unknown> = {}) {
  const payloads = [
    { path: 'python_embeded/python.exe', content: 'python' },
    { path: 'ComfyUI/main.py', content: 'main' }
  ]
  for (const payload of payloads) {
    const target = path.join(source, payload.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, payload.content)
  }
  const files = payloads.map(({ path: filePath, content }) => ({
    path: filePath,
    size: Buffer.byteLength(content),
    sha256: sha256(content)
  }))
  const manifest = {
    schema: 1,
    kind: 'magicpot-runtime',
    runtimeId,
    platform: 'win32',
    arch: 'x64',
    createdAt: '2026-07-01T03:00:00Z',
    entrypoints: { python: 'python_embeded/python.exe', comfyui: 'ComfyUI/main.py' },
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    files,
    ...overrides
  }
  await fs.writeFile(path.join(source, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

beforeEach(() => vol.reset())

describe('installPreExtractedDirectory', () => {
  it('installs a verified tree through a unique partial without changing active state', async () => {
    const root = await temporaryRoot()
    const managed = path.join(root, 'managed')
    const source = path.join(root, 'source')
    await writeRuntime(source)
    await fs.mkdir(managed, { recursive: true })
    await fs.writeFile(path.join(managed, 'active.json'), 'unchanged')

    const result = await installPreExtractedDirectory({
      root: managed,
      sourceDirectory: source,
      kind: 'runtime',
      expectedId: runtimeId,
      uniqueId: () => 'transaction'
    })

    expect(result).toMatchObject({
      installed: true,
      destination: path.join(managed, 'runtimes', runtimeId)
    })
    await expect(fs.readFile(path.join(managed, 'active.json'), 'utf8')).resolves.toBe('unchanged')
    await expect(
      fs.stat(path.join(managed, 'runtimes', `${runtimeId}.transaction.partial`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a hash mismatch and cleans the partial directory', async () => {
    const root = await temporaryRoot()
    const managed = path.join(root, 'managed')
    const source = path.join(root, 'source')
    await writeRuntime(source)
    await fs.writeFile(path.join(source, 'ComfyUI', 'main.py'), 'evil')
    await expect(
      installPreExtractedDirectory({
        root: managed,
        sourceDirectory: source,
        kind: 'runtime',
        expectedId: runtimeId,
        uniqueId: () => 'failed'
      })
    ).rejects.toThrow(/SHA-256 mismatch/)
    await expect(
      fs.stat(path.join(managed, 'runtimes', `${runtimeId}.failed.partial`))
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(managed, 'runtimes', runtimeId))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects undeclared files', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source')
    await writeRuntime(source)
    await fs.writeFile(path.join(source, 'extra.txt'), 'extra')
    await expect(
      installPreExtractedDirectory({
        root: path.join(root, 'managed'),
        sourceDirectory: source,
        kind: 'runtime',
        expectedId: runtimeId
      })
    ).rejects.toThrow(/Undeclared file/)
  })

  it('rejects symlinks anywhere in the tree', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source')
    await writeRuntime(source)
    await fs.symlink(path.join(source, 'ComfyUI', 'main.py'), path.join(source, 'linked.py'))
    await expect(
      installPreExtractedDirectory({
        root: path.join(root, 'managed'),
        sourceDirectory: source,
        kind: 'runtime',
        expectedId: runtimeId
      })
    ).rejects.toThrow(/Symbolic links/)
  })

  it('is idempotent for an identical target and conflicts for changed content', async () => {
    const root = await temporaryRoot()
    const managed = path.join(root, 'managed')
    const source = path.join(root, 'source')
    await writeRuntime(source)
    const options = {
      root: managed,
      sourceDirectory: source,
      kind: 'runtime' as const,
      expectedId: runtimeId
    }
    await expect(installPreExtractedDirectory(options)).resolves.toMatchObject({ installed: true })
    await expect(installPreExtractedDirectory(options)).resolves.toMatchObject({ installed: false })
    await fs.writeFile(path.join(managed, 'runtimes', runtimeId, 'ComfyUI', 'main.py'), 'evil')
    await expect(installPreExtractedDirectory(options)).rejects.toThrow(/already exists/)
  })

  it('rejects unsafe manifest paths', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'source')
    await writeRuntime(source, { files: [{ path: '../outside', size: 1, sha256: '0'.repeat(64) }] })
    await expect(
      installPreExtractedDirectory({
        root: path.join(root, 'managed'),
        sourceDirectory: source,
        kind: 'runtime',
        expectedId: runtimeId
      })
    ).rejects.toThrow(/schema 1/)
  })
})
