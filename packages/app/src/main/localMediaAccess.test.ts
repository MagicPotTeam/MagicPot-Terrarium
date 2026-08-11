import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  authorizeScopedLocalMediaDirectory,
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest,
  flushLocalMediaAccessGrants,
  hasLocalMediaTraversal,
  initializeLocalMediaAccess,
  resolveAuthorizedLocalMediaPath
} from './localMediaAccess'

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

  it('rejects unscoped network paths before application-root fallback', () => {
    const networkPath = '//server/share/image.png'
    const canonical = path.resolve(networkPath)
    const realpathSpy = vi.spyOn(fs.realpathSync, 'native').mockReturnValue(canonical)

    expect(resolveAuthorizedLocalMediaPath(networkPath, [canonical])).toBeNull()
    realpathSpy.mockRestore()
  })

  it('allows an exact network path only after a trusted picker grant', () => {
    const networkPath = '//server/share/image.png'
    const canonical = path.resolve(networkPath)
    const realpathSpy = vi.spyOn(fs.realpathSync, 'native').mockReturnValue(canonical)

    expect(authorizeScopedLocalMediaPath(networkPath)).toBe(true)
    expect(resolveAuthorizedLocalMediaPath(networkPath, [])).toBe(canonical)
    realpathSpy.mockRestore()
  })

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
