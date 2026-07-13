import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest,
  hasLocalMediaTraversal,
  resolveAuthorizedLocalMediaPath
} from './localMediaAccess'

const cleanupPaths: string[] = []

afterEach(() => {
  clearScopedLocalMediaPathsForTest()
  cleanupPaths.splice(0).forEach((target) => fs.rmSync(target, { recursive: true, force: true }))
})

function makeTempDir(prefix: string): string {
  fs.mkdirSync('/tmp', { recursive: true })
  const directory = fs.mkdtempSync(path.join('/tmp', prefix))
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
