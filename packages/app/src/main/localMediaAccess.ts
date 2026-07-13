import fs from 'node:fs'
import path from 'node:path'

const MAX_SCOPED_LOCAL_MEDIA_PATHS = 1_000
const scopedLocalMediaPaths = new Map<string, string>()

function comparisonKey(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath
}

function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function canonicalizeExistingPath(filePath: string): string | null {
  try {
    return path.resolve(fs.realpathSync.native(filePath))
  } catch {
    return null
  }
}

/** Authorizes one file obtained from an OS file picker or Electron File object. */
export function authorizeScopedLocalMediaPath(filePath: string): boolean {
  const trimmed = String(filePath || '').trim()
  if (!trimmed || trimmed.includes('\0') || !path.isAbsolute(trimmed)) return false

  const canonical = canonicalizeExistingPath(trimmed)
  if (!canonical) return false

  const key = comparisonKey(canonical)
  scopedLocalMediaPaths.delete(key)
  scopedLocalMediaPaths.set(key, canonical)
  while (scopedLocalMediaPaths.size > MAX_SCOPED_LOCAL_MEDIA_PATHS) {
    const oldest = scopedLocalMediaPaths.keys().next().value
    if (!oldest) break
    scopedLocalMediaPaths.delete(oldest)
  }
  return true
}

export function hasLocalMediaTraversal(url: string): boolean {
  const pathPart = url.slice(url.indexOf(':') + 1).split(/[?#]/, 1)[0]
  let decoded = pathPart
  for (let index = 0; index < 3; index += 1) {
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) break
      decoded = next
    } catch {
      return true
    }
  }
  return decoded.split(/[\\/]+/).some((segment) => segment === '..')
}

/** Returns a canonical path only when it is under an application root or explicitly scoped. */
export function resolveAuthorizedLocalMediaPath(
  filePath: string,
  allowedRoots: readonly string[]
): string | null {
  const trimmed = String(filePath || '').trim()
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    trimmed.startsWith('\\\\') ||
    trimmed.startsWith('//') ||
    !path.isAbsolute(trimmed)
  ) {
    return null
  }

  const canonical = canonicalizeExistingPath(trimmed)
  if (!canonical) return null
  if (scopedLocalMediaPaths.has(comparisonKey(canonical))) return canonical

  return allowedRoots.some((root) => {
    const canonicalRoot = canonicalizeExistingPath(root)
    return canonicalRoot ? isSameOrInside(canonicalRoot, canonical) : false
  })
    ? canonical
    : null
}

export function clearScopedLocalMediaPathsForTest(): void {
  scopedLocalMediaPaths.clear()
}
