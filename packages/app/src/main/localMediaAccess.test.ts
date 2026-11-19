import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeLocalMediaImportSourcePathAsync,
  authorizeScopedLocalMediaDirectory,
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest,
  flushLocalMediaAccessGrants,
  hasLocalMediaTraversal,
  initializeLocalMediaAccess,
  isWindowsNetworkLocalMediaPath,
  resolveAuthorizedLocalMediaPath
} from './localMediaAccess'
import { normalizeLocalFilePath } from './utils/localFileUrl'

const cleanupPaths: string[] = []

afterEach(() => {
  clearScopedLocalMediaPathsForTest()
  cleanupPaths.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }))
})

function makeTempDir(prefix: string): string {
  const tempRoot = os.tmpdir()
  fs.mkdirSync(tempRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(tempRoot, prefix))
  cleanupPaths.push(directory)
  return directory
}

describe('local media access policy', () => {
  it('allows canonical files inside application roots', () => {
    const root = makeTempDir('magicpot-media-root-')
    const mediaPath = path.join(root, 'canvas', 'image.png')
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
    fs.writeFileSync(mediaPath, 'image')

    expect(resolveAuthorizedLocalMediaPath(mediaPath, [root])).toBe(
      path.resolve(fs.realpathSync.native(mediaPath))
    )
  })

  it('rejects arbitrary absolute files and traversal URL forms', () => {
    const root = makeTempDir('magicpot-media-root-')
    const outside = makeTempDir('magicpot-media-outside-')
    const secretPath = path.join(outside, 'secret.txt')
    fs.writeFileSync(secretPath, 'secret')

    expect(resolveAuthorizedLocalMediaPath(secretPath, [root])).toBeNull()
    expect(hasLocalMediaTraversal('local-media:///safe/%2e%2e/secret.txt')).toBe(true)
    expect(hasLocalMediaTraversal('local-media:///safe/%252e%252e/secret.txt')).toBe(true)
  })

  it('allows an explicitly scoped file without allowing its siblings', () => {
    const directory = makeTempDir('magicpot-media-selected-')
    const selected = path.join(directory, 'selected.png')
    const sibling = path.join(directory, 'sibling.png')
    fs.writeFileSync(selected, 'selected')
    fs.writeFileSync(sibling, 'sibling')

    expect(authorizeScopedLocalMediaPath(selected)).toBe(true)
    expect(resolveAuthorizedLocalMediaPath(selected, [])).toBe(
      path.resolve(fs.realpathSync.native(selected))
    )
    expect(resolveAuthorizedLocalMediaPath(sibling, [])).toBeNull()
  })

  it('allows files inside a trusted directory selection without allowing siblings outside it', () => {
    const selectedDirectory = makeTempDir('magicpot-media-selected-dir-')
    const selectedFile = path.join(selectedDirectory, 'nested', 'selected.png')
    const outsideDirectory = makeTempDir('magicpot-media-outside-dir-')
    const outsideFile = path.join(outsideDirectory, 'outside.png')
    fs.mkdirSync(path.dirname(selectedFile), { recursive: true })
    fs.writeFileSync(selectedFile, 'selected')
    fs.writeFileSync(outsideFile, 'outside')

    expect(authorizeScopedLocalMediaDirectory(selectedDirectory)).toBe(true)
    expect(resolveAuthorizedLocalMediaPath(selectedFile, [])).toBe(
      path.resolve(fs.realpathSync.native(selectedFile))
    )
    expect(resolveAuthorizedLocalMediaPath(outsideFile, [])).toBeNull()
  })

  it('does not turn a file path into a directory grant', () => {
    const directory = makeTempDir('magicpot-media-file-not-dir-')
    const selectedFile = path.join(directory, 'selected.png')
    const sibling = path.join(directory, 'sibling.png')
    fs.writeFileSync(selectedFile, 'selected')
    fs.writeFileSync(sibling, 'sibling')

    expect(authorizeScopedLocalMediaDirectory(selectedFile)).toBe(false)
    expect(resolveAuthorizedLocalMediaPath(sibling, [])).toBeNull()
  })

  it('persists trusted file and directory grants and reloads them after restart', () => {
    const persistenceRoot = makeTempDir('magicpot-media-persistence-')
    const grantsPath = path.join(persistenceRoot, 'local-media-grants.json')
    const selectedDirectory = path.join(persistenceRoot, 'selected-directory')
    const selectedFile = path.join(persistenceRoot, 'selected-file.png')
    const nestedFile = path.join(selectedDirectory, 'nested.png')
    fs.mkdirSync(selectedDirectory, { recursive: true })
    fs.writeFileSync(selectedFile, 'selected')
    fs.writeFileSync(nestedFile, 'nested')

    initializeLocalMediaAccess(grantsPath)
    expect(authorizeScopedLocalMediaPath(selectedFile)).toBe(true)
    expect(authorizeScopedLocalMediaDirectory(selectedDirectory)).toBe(true)
    flushLocalMediaAccessGrants()

    clearScopedLocalMediaPathsForTest()
    initializeLocalMediaAccess(grantsPath)

    expect(resolveAuthorizedLocalMediaPath(selectedFile, [])).toBe(
      path.resolve(fs.realpathSync.native(selectedFile))
    )
    expect(resolveAuthorizedLocalMediaPath(nestedFile, [])).toBe(
      path.resolve(fs.realpathSync.native(nestedFile))
    )
  })

  it('coalesces a burst of trusted grants into one explicit persistence flush', () => {
    const persistenceRoot = makeTempDir('magicpot-media-coalesce-')
    const grantsPath = path.join(persistenceRoot, 'local-media-grants.json')
    initializeLocalMediaAccess(grantsPath)
    const writeSpy = vi.spyOn(fs, 'writeFileSync')

    for (let index = 0; index < 25; index += 1) {
      const filePath = path.join(persistenceRoot, `image-${index}.png`)
      fs.writeFileSync(filePath, 'image')
      expect(authorizeScopedLocalMediaPath(filePath)).toBe(true)
    }
    const writesBeforeFlush = writeSpy.mock.calls.filter(([target]) =>
      String(target).includes('local-media-grants.json')
    )
    expect(writesBeforeFlush).toHaveLength(0)

    flushLocalMediaAccessGrants()
    const grantWrites = writeSpy.mock.calls.filter(([target]) =>
      String(target).includes('local-media-grants.json')
    )
    expect(grantWrites).toHaveLength(1)
    writeSpy.mockRestore()
  })

  it('prunes missing and wrong-type grants while reloading persisted state', () => {
    const persistenceRoot = makeTempDir('magicpot-media-prune-')
    const grantsPath = path.join(persistenceRoot, 'local-media-grants.json')
    const existingFile = path.join(persistenceRoot, 'existing.png')
    const existingDirectory = path.join(persistenceRoot, 'existing-directory')
    const missingFile = path.join(persistenceRoot, 'missing.png')
    fs.writeFileSync(existingFile, 'existing')
    fs.mkdirSync(existingDirectory)
    fs.writeFileSync(
      grantsPath,
      JSON.stringify({
        version: 1,
        files: [existingFile, missingFile, existingDirectory],
        directories: [existingDirectory, missingFile, existingFile]
      })
    )

    initializeLocalMediaAccess(grantsPath)

    expect(resolveAuthorizedLocalMediaPath(existingFile, [])).toBe(
      path.resolve(fs.realpathSync.native(existingFile))
    )
    expect(
      resolveAuthorizedLocalMediaPath(path.join(existingDirectory, 'missing-child.png'), [])
    ).toBeNull()
    expect(JSON.parse(fs.readFileSync(grantsPath, 'utf8'))).toEqual({
      version: 1,
      files: [path.resolve(fs.realpathSync.native(existingFile))],
      directories: [path.resolve(fs.realpathSync.native(existingDirectory))]
    })
  })

  function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    try {
      return run()
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  }

  it('rejects unscoped network paths before application-root fallback on Windows', () => {
    const networkPath = '//server/share/image.png'
    const canonical = path.resolve(networkPath)
    const realpathSpy = vi.spyOn(fs.realpathSync, 'native').mockReturnValue(canonical)

    withPlatform('win32', () => {
      expect(resolveAuthorizedLocalMediaPath(networkPath, [canonical])).toBeNull()
      expect(
        resolveAuthorizedLocalMediaPath('\\\\server\\share\\image.png', [canonical])
      ).toBeNull()
    })
    realpathSpy.mockRestore()
  })

  it('recognises every Windows network spelling, separators of either kind', () => {
    for (const networkPath of [
      '\\\\server\\share\\image.png',
      '//server/share/image.png',
      '/\\server\\share\\image.png',
      '\\/server/share/image.png',
      '\\\\?\\UNC\\server\\share\\image.png'
    ]) {
      expect(isWindowsNetworkLocalMediaPath(networkPath)).toBe(true)
    }
    for (const localPath of ['C:\\images\\image.png', 'C:/images/image.png', '/images/image.png']) {
      expect(isWindowsNetworkLocalMediaPath(localPath)).toBe(false)
    }
  })

  it('refuses an unscoped Windows network path before any filesystem call', async () => {
    const root = makeTempDir('magicpot-media-root-')
    const realpathSpy = vi.spyOn(fs.realpathSync, 'native')
    const statSpy = vi.spyOn(fs, 'statSync')
    const asyncRealpath = vi.fn(async (value: string) => value)

    withPlatform('win32', () => {
      // Both spellings are absolute for the path module these tests run with.
      expect(resolveAuthorizedLocalMediaPath('//server/share/image.png', [root])).toBeNull()
      expect(resolveAuthorizedLocalMediaPath('/\\server\\share\\image.png', [root])).toBeNull()
    })
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    try {
      await expect(
        authorizeLocalMediaImportSourcePathAsync('//server/share/image.png', [root], {
          realpath: asyncRealpath
        })
      ).resolves.toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }

    // No SMB contact: the host is never resolved.
    expect(realpathSpy).not.toHaveBeenCalled()
    expect(statSpy).not.toHaveBeenCalled()
    expect(asyncRealpath).not.toHaveBeenCalled()
    realpathSpy.mockRestore()
    statSpy.mockRestore()
  })

  it('allows an exact network path only after a trusted picker grant', () => {
    const networkPath = '//server/share/image.png'
    const canonical = path.resolve(networkPath)
    const realpathSpy = vi.spyOn(fs.realpathSync, 'native').mockReturnValue(canonical)

    withPlatform('win32', () => {
      expect(resolveAuthorizedLocalMediaPath(networkPath, [])).toBeNull()
      expect(authorizeScopedLocalMediaPath(networkPath)).toBe(true)
      expect(resolveAuthorizedLocalMediaPath(networkPath, [])).toBe(canonical)
    })
    realpathSpy.mockRestore()
  })

  // Chromium reads `local-media:///dir/file` (a standard scheme) with `dir` as the host, so on
  // POSIX an application-root file is asked for as `//dir/file`: the same local file.
  it.skipIf(process.platform === 'win32')(
    'reads the double-slash form of a POSIX path as the local file it is',
    () => {
      const root = makeTempDir('magicpot-media-root-')
      const outside = makeTempDir('magicpot-media-outside-')
      const mediaPath = path.join(root, 'canvas-thumbnails', '512.webp')
      const secretPath = path.join(outside, 'secret.txt')
      const linkedPath = path.join(root, 'linked.txt')
      fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
      fs.writeFileSync(mediaPath, 'image')
      fs.writeFileSync(secretPath, 'secret')
      fs.symlinkSync(secretPath, linkedPath, 'file')
      const canonicalMediaPath = path.resolve(fs.realpathSync.native(mediaPath))

      withPlatform('linux', () => {
        // Inside an application root: allowed, and answered with the canonical single-slash path.
        expect(resolveAuthorizedLocalMediaPath(`/${mediaPath}`, [root])).toBe(canonicalMediaPath)
        // Every refusal of the single-slash form still holds for the double-slash form.
        expect(resolveAuthorizedLocalMediaPath(`/${mediaPath}`, [])).toBeNull()
        expect(resolveAuthorizedLocalMediaPath(`/${secretPath}`, [root])).toBeNull()
        expect(resolveAuthorizedLocalMediaPath(`/${linkedPath}`, [root])).toBeNull()
        // A literal '..' (path.join would have removed it before the call).
        const escape = `/${root}/../${path.basename(outside)}/secret.txt`
        expect(escape).toContain('/../')
        expect(resolveAuthorizedLocalMediaPath(escape, [root])).toBeNull()
        expect(
          resolveAuthorizedLocalMediaPath(`/${path.join(root, 'missing.png')}`, [root])
        ).toBeNull()
      })
      // The same request is still a network path on Windows, refused before the root check.
      withPlatform('win32', () => {
        expect(resolveAuthorizedLocalMediaPath(`/${mediaPath}`, [root])).toBeNull()
      })
    }
  )

  // The protocol handler's whole check on POSIX, from the URL Chromium hands over (the first
  // path segment as the host) to the policy answer.
  it.skipIf(process.platform === 'win32')(
    'keeps encoded separators and traversal in a POSIX local-media URL inside the roots',
    () => {
      const root = makeTempDir('magicpot-media-root-')
      const outside = makeTempDir('magicpot-media-outside-')
      const mediaPath = path.join(root, 'canvas-thumbnails', '512 level.webp')
      const secretPath = path.join(outside, 'secret.txt')
      fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
      fs.writeFileSync(mediaPath, 'image')
      fs.writeFileSync(secretPath, 'secret')
      const canonicalMediaPath = path.resolve(fs.realpathSync.native(mediaPath))
      const encodePath = (filePath: string) => filePath.split('/').map(encodeURIComponent).join('/')
      const authorize = (url: string) =>
        hasLocalMediaTraversal(url)
          ? null
          : resolveAuthorizedLocalMediaPath(normalizeLocalFilePath(url), [root])

      for (const platform of ['linux', 'darwin'] as const) {
        withPlatform(platform, () => {
          expect(authorize(`local-media:/${encodePath(mediaPath)}`)).toBe(canonicalMediaPath)
          // A whole outside path packed into the host with encoded separators.
          expect(authorize(`local-media://${encodeURIComponent(secretPath.slice(1))}`)).toBeNull()
          expect(authorize(`local-media:/${encodePath(secretPath)}`)).toBeNull()
          // Traversal out of the root, plain, encoded and double-encoded.
          const escape = `${path.basename(outside)}/secret.txt`
          expect(authorize(`local-media:/${encodePath(root)}/../${escape}`)).toBeNull()
          expect(authorize(`local-media:/${encodePath(root)}%2F..%2F${escape}`)).toBeNull()
          expect(authorize(`local-media:/${encodePath(root)}/%252e%252e/${escape}`)).toBeNull()
        })
      }
    }
  )

  it('rejects symlink escapes from an allowed root', () => {
    const root = makeTempDir('magicpot-media-root-')
    const outside = makeTempDir('magicpot-media-outside-')
    const secretPath = path.join(outside, 'secret.txt')
    const linkedPath = path.join(root, 'linked.txt')
    fs.writeFileSync(secretPath, 'secret')

    try {
      fs.symlinkSync(secretPath, linkedPath, 'file')
    } catch {
      return
    }

    expect(resolveAuthorizedLocalMediaPath(linkedPath, [root])).toBeNull()
  })
})
