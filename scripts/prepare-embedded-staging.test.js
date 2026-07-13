import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeGitFileSymlinks } from './embedded-staging-symlinks.mjs'

const tempRoots = []

function createTempRepository() {
  const trashRoot = path.join(process.cwd(), '.magicpot-trash')
  fs.mkdirSync(trashRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(trashRoot, 'embedded-staging-symlink-test-'))
  tempRoots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'MagicPot Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'magicpot-test@example.invalid'], { cwd: root })
  return root
}

function runGit(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    input: options.input
  })
}

function addGitSymlink(root, relativePath, target) {
  const blobId = runGit(root, ['hash-object', '-w', '--stdin'], { input: target }).trim()
  runGit(root, ['update-index', '--add', '--cacheinfo', `120000,${blobId},${relativePath}`])
}

function writeIndexToHead(root) {
  const treeId = runGit(root, ['write-tree']).trim()
  const commitId = runGit(root, ['commit-tree', treeId, '-m', 'test tree'], {
    input: '',
    encoding: 'utf8'
  }).trim()
  runGit(root, ['update-ref', 'HEAD', commitId])
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('prepare-embedded-staging Git symlinks', () => {
  it('materializes a core.symlinks=false checkout as a regular file', () => {
    const root = createTempRepository()
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# ComfyUI instructions\n')
    runGit(root, ['add', 'AGENTS.md'])
    addGitSymlink(root, 'CLAUDE.md', 'AGENTS.md')
    writeIndexToHead(root)
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'AGENTS.md')

    expect(materializeGitFileSymlinks(root)).toBe(1)

    const materialized = path.join(root, 'CLAUDE.md')
    expect(fs.lstatSync(materialized).isSymbolicLink()).toBe(false)
    expect(fs.statSync(materialized).isFile()).toBe(true)
    expect(fs.readFileSync(materialized, 'utf8')).toBe('# ComfyUI instructions\n')
  })

  it('resolves chained Git symlinks from repository metadata', () => {
    const root = createTempRepository()
    fs.writeFileSync(path.join(root, 'target.txt'), 'final payload\n')
    runGit(root, ['add', 'target.txt'])
    addGitSymlink(root, 'a-link.txt', 'z-link.txt')
    addGitSymlink(root, 'z-link.txt', 'target.txt')
    writeIndexToHead(root)
    fs.writeFileSync(path.join(root, 'a-link.txt'), 'z-link.txt')
    fs.writeFileSync(path.join(root, 'z-link.txt'), 'target.txt')

    expect(materializeGitFileSymlinks(root)).toBe(2)
    expect(fs.readFileSync(path.join(root, 'a-link.txt'), 'utf8')).toBe('final payload\n')
    expect(fs.readFileSync(path.join(root, 'z-link.txt'), 'utf8')).toBe('final payload\n')
  })

  it('rejects a Git symlink target that escapes the staged source tree', () => {
    const root = createTempRepository()
    addGitSymlink(root, 'CLAUDE.md', '../outside.md')
    writeIndexToHead(root)
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '../outside.md')

    expect(() => materializeGitFileSymlinks(root)).toThrow(
      'Git symlink target CLAUDE.md -> ../outside.md escapes the staged source tree'
    )
  })
})
