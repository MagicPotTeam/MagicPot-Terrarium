import { lstatSync, statSync } from 'node:fs'

/**
 * Windows command lookup that reproduces what Node's `spawn(file, args, { shell: false, cwd, env })`
 * does on win32 today, so that a command can be handed to a launcher that does NOT search PATH
 * (the Job Object helper passes it to CreateProcessW as lpApplicationName) without changing which
 * file runs.
 *
 * Sources reproduced here (Node 24 / libuv 1.x):
 * - Node `normalizeSpawnArguments`: on win32 the env keys are sorted and only the first key of each
 *   case-insensitive group is kept; keys whose value is undefined are then dropped.
 * - libuv `make_program_env`: required variables missing from the passed env (PATH among them) are
 *   copied from the parent process; `find_path` then takes the first `PATH=` entry, ASCII
 *   case-insensitively.
 * - libuv `search_path`, `path_search_walk_ext` and `search_path_join_test`: a name with a path
 *   component (`\`, `/` or `:`) is looked up only there (relative to cwd); a bare name is looked up
 *   in cwd first (unless NoDefaultCurrentDirectoryInExePath is set in the parent environment) and
 *   then in each PATH entry (quotes stripped, relative entries relative to cwd); in each directory
 *   the name as given is tried only when it has a non-empty extension, then name + `.com`, then
 *   name + `.exe`; the first candidate that exists and is not a directory wins.
 *
 * The result is the exact string libuv would pass to CreateProcessW (not normalized), or undefined
 * when libuv would fail with ENOENT.
 */
export type WindowsCommandLookup = Readonly<{
  /** The calling process environment (process.env in production). */
  parentEnv: Readonly<Record<string, string | undefined>>
  /** GetFileAttributesW semantics: the path exists and is not a directory. */
  isFile: (candidate: string) => boolean
}>

export const defaultWindowsCommandLookup = (): WindowsCommandLookup => ({
  parentEnv: process.env,
  isFile: windowsPathIsNonDirectory
})

export function resolveWindowsSpawnCommand(
  file: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  lookup: WindowsCommandLookup = defaultWindowsCommandLookup()
): string | undefined {
  const searchPath = windowsSpawnSearchPath(env ?? lookup.parentEnv, lookup.parentEnv)
  if (searchPath === undefined) return undefined
  return searchWindowsPath(
    file,
    cwd,
    searchPath,
    needCurrentDirectoryForExePath(lookup.parentEnv),
    lookup.isFile
  )
}

/** The PATH value libuv searches for a spawn with this env. */
export function windowsSpawnSearchPath(
  env: Readonly<Record<string, string | undefined>>,
  parentEnv: Readonly<Record<string, string | undefined>>
): string | undefined {
  const keys: string[] = []
  // Same enumeration as Node (prototype keys included).
  for (const key in env) keys.push(key)
  const seen = new Set<string>()
  for (const key of keys.sort()) {
    const upper = key.toUpperCase()
    if (seen.has(upper)) continue
    seen.add(upper)
    const value = env[key]
    if (value !== undefined && isAsciiPathName(key)) return String(value)
  }
  // libuv copies a missing required PATH from the parent; GetEnvironmentVariableW is case-insensitive.
  for (const key of Object.keys(parentEnv).sort()) {
    const value = parentEnv[key]
    if (isAsciiPathName(key) && value !== undefined) return String(value)
  }
  return undefined
}

const isAsciiPathName = (key: string): boolean => /^[Pp][Aa][Tt][Hh]$/.test(key)

const needCurrentDirectoryForExePath = (
  parentEnv: Readonly<Record<string, string | undefined>>
): boolean =>
  !Object.keys(parentEnv).some(
    (key) =>
      key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath' && parentEnv[key] !== undefined
  )

function searchWindowsPath(
  file: string,
  cwd: string,
  searchPath: string,
  searchCwd: boolean,
  isFile: (candidate: string) => boolean
): string | undefined {
  if (file.length === 0 || file === '.') return undefined
  let nameStart = file.length
  while (nameStart > 0 && !'\\/:'.includes(file[nameStart - 1])) nameStart--
  const name = file.slice(nameStart)
  const dot = name.indexOf('.')
  const nameHasExtension = dot !== -1 && dot + 1 < name.length
  if (nameStart !== 0) {
    return walkExtensions(file.slice(0, nameStart), name, cwd, nameHasExtension, isFile)
  }
  if (searchCwd) {
    const found = walkExtensions('', file, cwd, nameHasExtension, isFile)
    if (found !== undefined) return found
  }
  let at = 0
  let first = true
  while (at < searchPath.length) {
    // libuv skips the separator it stopped on (and a leading one).
    if (!first || searchPath[0] === ';') at++
    first = false
    const start = at
    let end = start
    if (searchPath[start] === '"' || searchPath[start] === "'") {
      const close = searchPath.indexOf(searchPath[start], start + 1)
      end = close === -1 ? searchPath.length : close
    }
    const separator = searchPath.indexOf(';', end)
    end = separator === -1 ? searchPath.length : separator
    at = end
    if (end === start) continue
    let dir = searchPath.slice(start, end)
    if (dir[0] === '"' || dir[0] === "'") dir = dir.slice(1)
    if (dir.length && (dir[dir.length - 1] === '"' || dir[dir.length - 1] === "'"))
      dir = dir.slice(0, -1)
    const found = walkExtensions(dir, file, cwd, nameHasExtension, isFile)
    if (found !== undefined) return found
  }
  return undefined
}

function walkExtensions(
  dir: string,
  name: string,
  cwd: string,
  nameHasExtension: boolean,
  isFile: (candidate: string) => boolean
): string | undefined {
  for (const extension of nameHasExtension ? ['', 'com', 'exe'] : ['com', 'exe']) {
    const candidate = joinCandidate(dir, name, extension, cwd)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

function joinCandidate(dir: string, name: string, extension: string, cwd: string): string {
  let base = cwd
  if (dir.length > 2 && '\\/'.includes(dir[0]) && '\\/'.includes(dir[1])) {
    base = '' // UNC path
  } else if (dir.length >= 1 && '\\/'.includes(dir[0])) {
    base = cwd.slice(0, 2) // rooted without a drive: the drive of cwd
  } else if (dir.length >= 2 && dir[1] === ':' && (dir.length < 3 || !'\\/'.includes(dir[2]))) {
    // Drive-relative (D:foo): cwd when it is on that drive, otherwise the dir alone.
    if (cwd.length < 2 || cwd.slice(0, 2).toLowerCase() !== dir.slice(0, 2).toLowerCase()) base = ''
    else dir = dir.slice(2)
  } else if (dir.length > 2 && dir[1] === ':') {
    base = '' // absolute with a drive letter
  }
  let result = base
  if (base.length && !'\\/:'.includes(result[result.length - 1])) result += '\\'
  result += dir
  if (dir.length && !'\\/:'.includes(result[result.length - 1])) result += '\\'
  result += name
  if (extension) {
    if (name.length && result[result.length - 1] !== '.') result += '.'
    result += extension
  }
  return result
}

/** GetFileAttributesW-like check: the entry exists and is not a directory (links not followed, except to see a directory target). */
export function windowsPathIsNonDirectory(candidate: string): boolean {
  try {
    const entry = lstatSync(candidate)
    if (entry.isDirectory()) return false
    if (!entry.isSymbolicLink()) return true
    try {
      return !statSync(candidate).isDirectory()
    } catch {
      return true // a dangling file link still has attributes; CreateProcessW then fails as before
    }
  } catch {
    return false
  }
}

/**
 * The helper is a plain Win32 program without a long-path manifest, while the app that spawns
 * directly today is long-path aware. Whether CreateProcessW in the helper takes a command or a
 * working directory at or beyond the classic limits (MAX_PATH 260, directories 248) could not be
 * verified, so such launches deliberately keep the direct spawn (a stricter rule than libuv's).
 */
export const JOB_HELPER_MAX_PATH_CHARS = 247

/**
 * Node's own rule (src/util-inl.h IsWindowsBatchFile, applied in process_wrap.cc to the file name
 * AS GIVEN, before anything is searched): a name whose extension is .cmd or .bat, trailing dots
 * and spaces ignored, is refused with EINVAL when spawned without a shell. Such a name must keep
 * the direct spawn, so that it is refused as today instead of being resolved to another file
 * (`npm.cmd` -> `npm.cmd.exe` in the working directory).
 */
export function isWindowsBatchFileName(command: string): boolean {
  const match = /\.([a-zA-Z0-9]+)\s*[.\s]*$/.exec(command)
  return match !== null && ['cmd', 'bat'].includes(match[1].toLowerCase())
}

/**
 * True when `resolved` can be given to the Job Object helper: an absolute drive or UNC path to a
 * `.exe` or `.com` file, with the path and the working directory inside the classic length
 * limits. Anything else (batch files, which Node refuses without a shell, other extensions,
 * drive-relative results, long paths) keeps today's direct spawn so its behaviour is unchanged;
 * such a command is then stopped by taskkill plus the sweep, not by a Job Object.
 */
export function isJobHelperLaunchable(resolved: string, cwd = ''): boolean {
  return (
    /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(resolved) &&
    /\.(?:exe|com)$/i.test(resolved) &&
    resolved.length <= JOB_HELPER_MAX_PATH_CHARS &&
    cwd.length <= JOB_HELPER_MAX_PATH_CHARS
  )
}
