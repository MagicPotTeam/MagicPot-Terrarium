import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitIgnoreFilter, compileGitIgnoreLine, isAlwaysSkippedDirectory } from './gitignore'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const tempRoot = () => {
  const root = path.join(
    tmpdir(),
    `magic-gitignore-${process.pid}-${Math.random().toString(36).slice(2)}`
  )
  mkdirSync(root)
  roots.push(root)
  return root
}
const matches = (line: string, candidate: string) =>
  compileGitIgnoreLine(line)!.regex.test(candidate)

describe('gitignore line compilation', () => {
  it('skips blanks and comments and keeps escaped leading characters literal', () => {
    for (const line of ['', '   ', '# comment', '/'])
      expect(compileGitIgnoreLine(line)).toBeUndefined()
    expect(compileGitIgnoreLine('!keep.txt')).toMatchObject({ include: false })
    expect(compileGitIgnoreLine('\\!bang')).toMatchObject({ include: true })
    expect(matches('\\!bang', '!bang')).toBe(true)
    expect(matches('\\#hash', '#hash')).toBe(true)
  })

  it('matches unanchored names at any depth and anchored paths from their directory', () => {
    expect(matches('*.log', 'a.log')).toBe(true)
    expect(matches('*.log', 'deep/dir/a.log')).toBe(true)
    expect(matches('/top.txt', 'top.txt')).toBe(true)
    expect(matches('/top.txt', 'sub/top.txt')).toBe(false)
    expect(matches('docs/*.md', 'docs/a.md')).toBe(true)
    expect(matches('docs/*.md', 'docs/sub/a.md')).toBe(false)
    expect(matches('file?.txt', 'file1.txt')).toBe(true)
    expect(matches('file[0-9].txt', 'filex.txt')).toBe(false)
    expect(matches('file[!0-9].txt', 'filex.txt')).toBe(true)
  })

  it('supports ** in leading, middle and trailing positions and directory-only rules', () => {
    expect(matches('**/cache', 'a/b/cache')).toBe(true)
    expect(matches('a/**/z', 'a/z')).toBe(true)
    expect(matches('a/**/z', 'a/b/c/z')).toBe(true)
    expect(matches('out/**', 'out/x/y')).toBe(true)
    expect(compileGitIgnoreLine('build/')).toMatchObject({ dirOnly: true })
  })

  it('skips the same noise directories as KohakuTerrarium walks', () => {
    for (const name of [
      '.git',
      'node_modules',
      '__pycache__',
      '.venv',
      'venv',
      '.cache',
      'pkg.egg-info'
    ])
      expect(isAlwaysSkippedDirectory(name)).toBe(true)
    expect(isAlwaysSkippedDirectory('src')).toBe(false)
  })
})

describe('directory-scoped gitignore filter', () => {
  it('loads rules from the repository root above the search root', async () => {
    const repo = tempRoot()
    mkdirSync(path.join(repo, '.git'))
    mkdirSync(path.join(repo, 'pkg', 'src'), { recursive: true })
    writeFileSync(path.join(repo, '.gitignore'), '*.tmp\n')
    const filter = await GitIgnoreFilter.create(path.join(repo, 'pkg'))
    expect(filter.boundary).toBe(repo)
    expect(await filter.isIgnored(path.join(repo, 'pkg', 'src', 'a.tmp'), false)).toBe(true)
    expect(await filter.isIgnored(path.join(repo, 'pkg', 'src', 'a.ts'), false)).toBe(false)
  })

  it('lets a deeper file override a shallower one but never re-includes below an excluded directory', async () => {
    const root = tempRoot()
    mkdirSync(path.join(root, 'sub'))
    mkdirSync(path.join(root, 'gone'))
    writeFileSync(path.join(root, '.gitignore'), '*.log\ngone/\n!gone/keep.txt\n')
    writeFileSync(path.join(root, 'sub', '.gitignore'), '!keep.log\n')
    const filter = await GitIgnoreFilter.create(root)
    expect(await filter.isIgnored(path.join(root, 'a.log'), false)).toBe(true)
    expect(await filter.isIgnored(path.join(root, 'sub', 'keep.log'), false)).toBe(false)
    expect(await filter.isIgnored(path.join(root, 'sub', 'other.log'), false)).toBe(true)
    expect(await filter.isIgnored(path.join(root, 'gone'), true)).toBe(true)
    expect(await filter.isIgnored(path.join(root, 'gone', 'keep.txt'), false)).toBe(true)
  })

  it('applies directory-only rules to directories, not to files of the same name', async () => {
    const root = tempRoot()
    writeFileSync(path.join(root, '.gitignore'), 'build/\n')
    const filter = await GitIgnoreFilter.create(root)
    expect(await filter.isIgnored(path.join(root, 'build'), true)).toBe(true)
    expect(await filter.isIgnored(path.join(root, 'build'), false)).toBe(false)
  })
})
