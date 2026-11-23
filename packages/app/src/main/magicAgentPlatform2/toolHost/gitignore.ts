import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Directory-scoped .gitignore matching for one traversal, following KohakuTerrarium
 * (utils/file/ignore.py): rules load from the nearest repository root (or the search
 * root outside a repository) down to each directory, the last matching rule wins,
 * deeper files override shallower ones, and an excluded parent cannot be re-included
 * by a rule below it. Git's index, global excludes and .git/info/exclude are not read.
 */

type Rule = Readonly<{ include: boolean; regex: RegExp; dirOnly: boolean }>
type Context = readonly (readonly [directory: string, rules: readonly Rule[]])[]

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

const escapeRegex = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')

function translateSegment(segment: string): string {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]
    if (char === '\\' && i + 1 < segment.length) {
      out += escapeRegex(segment[++i])
    } else if (char === '*') {
      out += '[^/]*'
    } else if (char === '?') {
      out += '[^/]'
    } else if (char === '[') {
      const end = segment.indexOf(']', i + 2)
      if (end < 0) {
        out += '\\['
        continue
      }
      let body = segment.slice(i + 1, end)
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      out += `[${body.replace(/\\/g, '\\\\')}]`
      i = end
    } else out += escapeRegex(char)
  }
  return out
}

/** Compile one .gitignore line, or undefined for blanks, comments and invalid lines. */
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
  let source = ''
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const last = i === segments.length - 1
    if (segment === '**') {
      if (last) source += '.*'
      else source += '(?:.*/)?'
      continue
    }
    source += translateSegment(segment)
    if (!last) source += '/'
  }
  if (!anchored) source = `(?:.*/)?${source}`
  try {
    return { include, regex: new RegExp(`^${source}$`), dirOnly }
  } catch {
    return undefined
  }
}

export class GitIgnoreFilter {
  private readonly contexts = new Map<string, Promise<Context>>()
  private readonly excluded = new Map<string, Promise<boolean>>()

  private constructor(readonly boundary: string) {
    this.excluded.set(boundary, Promise.resolve(false))
  }

  /** Rules load from the nearest ancestor holding .git, or from root when there is none. */
  static async create(root: string): Promise<GitIgnoreFilter> {
    const start = path.resolve(root)
    for (let current = start; ; current = path.dirname(current)) {
      if (await exists(path.join(current, '.git'))) return new GitIgnoreFilter(current)
      if (path.dirname(current) === current) return new GitIgnoreFilter(start)
    }
  }

  private context(directory: string): Promise<Context> {
    const cached = this.contexts.get(directory)
    if (cached) return cached
    const parent = path.dirname(directory)
    const promise = (async () => {
      const outer: Context =
        directory === this.boundary || parent === directory ? [] : await this.context(parent)
      let text: string
      try {
        text = await fs.readFile(path.join(directory, '.gitignore'), 'utf8')
      } catch {
        return outer
      }
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
        if (!rule.regex.test(relative)) continue
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

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}
