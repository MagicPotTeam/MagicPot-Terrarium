import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFERRED_COMFY_PERSIST_MAX_BYTES } from '@shared/comfy/deferredImages'
import { readPersistedDeferredFile } from './deferredFileAuthority'

const roots: string[] = []
const TEST_TEMP_ROOT = path.resolve('/tmp')

const makeRoot = async (): Promise<{ userData: string; authorityRoot: string }> => {
  await mkdir(TEST_TEMP_ROOT, { recursive: true })
  const userData = await mkdtemp(path.join(TEST_TEMP_ROOT, 'magicpot-deferred-authority-'))
  roots.push(userData)
  const authorityRoot = path.join(userData, 'qapp-input-images')
  await mkdir(authorityRoot)
  return { userData, authorityRoot }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readPersistedDeferredFile', () => {
  it('reads a regular file from the exact authority root', async () => {
    const { authorityRoot } = await makeRoot()
    const filePath = path.join(authorityRoot, 'nested', 'image.bin')
    await mkdir(path.dirname(filePath))
    await writeFile(filePath, new Uint8Array([1, 2, 3, 4]))

    await expect(
      readPersistedDeferredFile({ filePath, expectedSizeBytes: 4, authorizedRoot: authorityRoot })
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it.each(['traversal', 'prefix sibling'])(
    'rejects a %s path outside the authority root',
    async (kind) => {
      const { userData, authorityRoot } = await makeRoot()
      const outside =
        kind === 'traversal'
          ? path.resolve(authorityRoot, '..', 'outside.bin')
          : path.join(userData, 'qapp-input-images-evil', 'outside.bin')
      await mkdir(path.dirname(outside), { recursive: true })
      await writeFile(outside, new Uint8Array([1]))

      await expect(
        readPersistedDeferredFile({
          filePath: outside,
          expectedSizeBytes: 1,
          authorizedRoot: authorityRoot
        })
      ).rejects.toThrow('outside the authority root')
    }
  )

  it('rejects relative paths and paths containing control characters', async () => {
    const { authorityRoot } = await makeRoot()
    await expect(
      readPersistedDeferredFile({
        filePath: 'relative/file.bin',
        expectedSizeBytes: 1,
        authorizedRoot: authorityRoot
      })
    ).rejects.toThrow('absolute path')
    await expect(
      readPersistedDeferredFile({
        filePath: `${authorityRoot}${path.sep}bad\u0000name.bin`,
        expectedSizeBytes: 1,
        authorizedRoot: authorityRoot
      })
    ).rejects.toThrow('control characters')
  })

  it('rejects symbolic-link files and linked authority components', async () => {
    const { userData, authorityRoot } = await makeRoot()
    const outside = path.join(userData, 'outside.bin')
    await writeFile(outside, new Uint8Array([1, 2]))
    const linkedFile = path.join(authorityRoot, 'linked.bin')
    await symlink(outside, linkedFile, 'file')
    await expect(
      readPersistedDeferredFile({
        filePath: linkedFile,
        expectedSizeBytes: 2,
        authorizedRoot: authorityRoot
      })
    ).rejects.toThrow('symbolic links')

    const outsideDirectory = path.join(userData, 'outside-directory')
    await mkdir(outsideDirectory)
    await writeFile(path.join(outsideDirectory, 'nested.bin'), new Uint8Array([3]))
    const linkedDirectory = path.join(authorityRoot, 'linked-directory')
    await symlink(
      outsideDirectory,
      linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(
      readPersistedDeferredFile({
        filePath: path.join(linkedDirectory, 'nested.bin'),
        expectedSizeBytes: 1,
        authorizedRoot: authorityRoot
      })
    ).rejects.toThrow('symbolic links')
  })

  it('rejects directories and expected-size mismatches', async () => {
    const { authorityRoot } = await makeRoot()
    await expect(
      readPersistedDeferredFile({
        filePath: authorityRoot,
        expectedSizeBytes: 0,
        authorizedRoot: authorityRoot
      })
    ).rejects.toThrow()

    const filePath = path.join(authorityRoot, 'size.bin')
    await writeFile(filePath, new Uint8Array([1, 2, 3]))
    await expect(
      readPersistedDeferredFile({ filePath, expectedSizeBytes: 2, authorizedRoot: authorityRoot })
    ).rejects.toThrow('actual file size')
  })

  it.each([-1, 0.5, Number.NaN, DEFERRED_COMFY_PERSIST_MAX_BYTES + 1])(
    'rejects invalid expected size %s before reading',
    async (expectedSizeBytes) => {
      const { authorityRoot } = await makeRoot()
      const filePath = path.join(authorityRoot, 'size.bin')
      await writeFile(filePath, new Uint8Array([1]))
      await expect(
        readPersistedDeferredFile({ filePath, expectedSizeBytes, authorizedRoot: authorityRoot })
      ).rejects.toThrow('expected size')
    }
  )

  it('honors an already-aborted signal without reading the file', async () => {
    const { authorityRoot } = await makeRoot()
    const filePath = path.join(authorityRoot, 'abort.bin')
    await writeFile(filePath, new Uint8Array([1, 2, 3]))
    const controller = new AbortController()
    controller.abort(new Error('cancelled by test'))

    await expect(
      readPersistedDeferredFile({
        filePath,
        expectedSizeBytes: 3,
        authorizedRoot: authorityRoot,
        signal: controller.signal
      })
    ).rejects.toThrow('cancelled by test')
  })
})
