import { constants as fsConstants, promises as fs } from 'node:fs'
import path from 'node:path'
import { type PathGlobItem, type SegmentToken, collapsePathGlob, matchPathGlob } from './pathGlob'

/**
 * Directory-scoped .gitignore matching for one traversal, following KohakuTerrarium
 * (utils/file/ignore.py): rules load from the nearest repository root (or the search
 * root outside a repository) down to each directory, the last matching rule wins,
 * deeper files override shallower ones, and an excluded parent cannot be re-included
 * by a rule below it. Git's index, global excludes and .git/info/exclude are not read.
 * Unlike upstream, the .git search stops at the authorized root, and only bounded regular
 * .gitignore files are read (see readGitIgnore).
 */

type Rule = Readonly<{ include: boolean; dirOnly: boolean; test: (relative: string) => boolean }>
/** Text of a bounded regular .gitignore file, or undefined to skip it. */
export type GitIgnoreReader = (file: string) => Promise<string | undefined>
type Context = readonly (readonly [directory: string, rules: readonly Rule[]])[]

/** A .gitignore larger than this is ignored as a whole rather than read. */
export const GITIGNORE_MAX_BYTES = 256 * 1024

/** Directories skipped by every walk, as KohakuTerrarium utils/file/walk.py:31-55. */
const ALWAYS_SKIP_NAMES = new Set([
  '.git',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'node_modules',
  '.tox',
  '.eggs',
  '.venv',
  'venv',
  '.cache'
])

export function isAlwaysSkippedDirectory(name: string): boolean {
  return ALWAYS_SKIP_NAMES.has(name) || name.endsWith('.egg-info')
}

const caseFold = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value

/** One segment's tokens: \x escapes, * and ?, and [..] classes with ! or ^ negation. */
function segmentTokens(segment: string): SegmentToken[] {
  const tokens: SegmentToken[] = []
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]
    if (char === '\\' && i + 1 < segment.length) {
      tokens.push({ kind: 'char', value: segment[++i] })
    } else if (char === '*') {
      tokens.push({ kind: 'star' })
    } else if (char === '?') {
      tokens.push({ kind: 'any' })
    } else if (char === '[') {
      const end = segment.indexOf(']', i + 2)
      if (end < 0) {
        tokens.push({ kind: 'char', value: '[' })
        continue
      }
      let body = segment.slice(i + 1, end)
      const negated = body.startsWith('!') || body.startsWith('^')
      if (negated) body = body.slice(1)
      let chars = ''
      const ranges: [number, number][] = []
      for (let j = 0; j < body.length; j++) {
        if (body[j + 1] === '-' && j + 2 < body.length) {
          ranges.push([body.charCodeAt(j), body.charCodeAt(j + 2)])
          j += 2
        } else chars += body[j]
      }
      tokens.push({ kind: 'class', negated, chars, ranges })
      i = end
    } else tokens.push({ kind: 'char', value: char })
  }
  return tokens
}

/**
 * Compile one .gitignore line, or undefined for blanks and comments. Rules never become a
 * RegExp: matchPathGlob checks them without backtracking, so a line such as `**` repeated
 * before `zzz` against a deep path costs O(items x depth), not exponential time.
 */
export function compileGitIgnoreLine(raw: string): Rule | undefined {
  let line = raw.replace(/(?<!\\)\s+$/, '')
  if (!line || line.startsWith('#')) return undefined
  let include = true
  if (line.startsWith('!')) {
    include = false
    line = line.slice(1)
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1)
  line = caseFold(line)
  const dirOnly = line.endsWith('/')
  if (dirOnly) line = line.replace(/\/+$/, '')
  if (!line) return undefined
  const anchored = line.includes('/')
  if (line.startsWith('/')) line = line.slice(1)
  const segments = line.split('/')
  const items: PathGlobItem[] = anchored ? [] : [{ kind: 'many', min: 0 }]
  segments.forEach((segment, index) => {
    // A trailing ** matches everything inside (one or more segments); elsewhere zero or more.
    if (segment === '**') items.push({ kind: 'many', min: index === segments.length - 1 ? 1 : 0 })
    else items.push({ kind: 'segment', tokens: segmentTokens(segment) })
  })
  const compiled = collapsePathGlob(items)
  return { include, dirOnly, test: (relative) => matchPathGlob(compiled, relative.split('/')) }
}

export class GitIgnoreFilter {
  private readonly contexts = new Map<string, Promise<Context>>()
  private readonly excluded = new Map<string, Promise<boolean>>()

  private constructor(
    readonly boundary: string,
    private readonly read: GitIgnoreReader = readGitIgnore
  ) {
    this.excluded.set(boundary, Promise.resolve(false))
  }

  /**
   * Rules load from the nearest ancestor holding .git, or from the search root when there is
   * none. The upward search never leaves `authorizedRoot` (the workspace root, or the approved
   * external directory itself), so nothing outside the granted scope is probed or read.
   */
  static async create(
    searchRoot: string,
    authorizedRoot: string,
    /** Replaces the bounded direct read, e.g. with a grant-checked reader. */
    read?: GitIgnoreReader
  ): Promise<GitIgnoreFilter> {
    const start = path.resolve(searchRoot),
      limit = path.resolve(authorizedRoot)
    // Searching from the authorized root itself cannot move the boundary, so nothing is probed.
    if (start === limit || !inside(limit, start)) return new GitIgnoreFilter(start, read)
    for (let current = start; ; current = path.dirname(current)) {
      if (await exists(path.join(current, '.git'))) return new GitIgnoreFilter(current, read)
      if (current === limit || path.dirname(current) === current)
        return new GitIgnoreFilter(start, read)
    }
  }

  private context(directory: string): Promise<Context> {
    const cached = this.contexts.get(directory)
    if (cached) return cached
    const parent = path.dirname(directory)
    const promise = (async () => {
      const outer: Context =
        directory === this.boundary || parent === directory ? [] : await this.context(parent)
      const text = await this.read(path.join(directory, '.gitignore'))
      if (text === undefined) return outer
      const rules = text
        .split(/\r?\n/)
        .map(compileGitIgnoreLine)
        .filter((rule): rule is Rule => rule !== undefined)
        .reverse()
      return rules.length ? [...outer, [directory, rules] as const] : outer
    })()
    this.contexts.set(directory, promise)
    return promise
  }

  private async matches(target: string, isDirectory: boolean): Promise<boolean> {
    let ignored = false
    for (const [directory, rules] of await this.context(path.dirname(target))) {
      const relative = caseFold(path.relative(directory, target).split(path.sep).join('/'))
      for (const rule of rules) {
        if (rule.dirOnly && !isDirectory) continue
        if (!rule.test(relative)) continue
        ignored = rule.include
        break
      }
    }
    return ignored
  }

  private directoryIgnored(directory: string): Promise<boolean> {
    const cached = this.excluded.get(directory)
    if (cached) return cached
    const parent = path.dirname(directory)
    const promise =
      parent === directory
        ? Promise.resolve(false)
        : (async () => (await this.directoryIgnored(parent)) || this.matches(directory, true))()
    this.excluded.set(directory, promise)
    return promise
  }

  /** Whether a path is ignored, including through an ignored parent directory. */
  async isIgnored(target: string, isDirectory: boolean): Promise<boolean> {
    const absolute = path.resolve(target)
    if (absolute === this.boundary || !inside(this.boundary, absolute)) return false
    if (isDirectory) return this.directoryIgnored(absolute)
    return (await this.directoryIgnored(path.dirname(absolute))) || this.matches(absolute, false)
  }
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Read a .gitignore only when it is a regular file of at most GITIGNORE_MAX_BYTES. Symbolic
 * links, FIFOs, devices and directories are skipped: lstat rejects them up front, and the open
 * uses O_NOFOLLOW and O_NONBLOCK (POSIX) with an fstat recheck, so a file swapped in between
 * can neither redirect the read nor block it.
 */
async function readGitIgnore(file: string): Promise<string | undefined> {
  try {
    const before = await fs.lstat(file)
    if (!before.isFile() || before.size > GITIGNORE_MAX_BYTES) return undefined
    const handle = await fs.open(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > GITIGNORE_MAX_BYTES) return undefined
      const buffer = Buffer.alloc(GITIGNORE_MAX_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > GITIGNORE_MAX_BYTES) return undefined
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}
