/**
 * The one local-media URL <-> file path conversion shared by the renderer (producer of
 * report-bundle and canvas URLs) and MAIN (report-bundle registry), so both sides build and
 * parse byte-identical URLs. Pure string code: no Node or DOM APIs.
 */

function encodeLocalMediaPathSegments(filePath: string): string {
  return filePath
    .split('/')
    .map((segment, index) =>
      index === 1 && /^[a-zA-Z]:$/.test(segment) ? segment : encodeURIComponent(segment)
    )
    .join('/')
}

/** Builds a `local-media://` URL for an absolute POSIX, Windows drive or UNC path. */
export function toLocalMediaUrl(filePath: string): string | null {
  const trimmed = filePath.trim()
  if (!trimmed) return null

  const normalizedPath = trimmed.replace(/\\/g, '/')
  if (normalizedPath.startsWith('//')) {
    const [hostname, ...segments] = normalizedPath.slice(2).split('/')
    if (!hostname) return null
    return `local-media://${encodeURIComponent(hostname)}/${segments
      .map(encodeURIComponent)
      .join('/')}`
  }

  const pathname = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`
  return `local-media://${encodeLocalMediaPathSegments(pathname)}`
}

/**
 * Inverse of {@link toLocalMediaUrl} for `local-media:` and `file:` URLs. Returns a path with
 * forward slashes (`C:/dir/file`, `/dir/file` or `//host/share/file`), or null when the value
 * is not such a URL or cannot be decoded. Callers that make security decisions must still
 * reject query, fragment and traversal segments and canonicalize the result themselves.
 */
export function localMediaUrlToFilePath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'local-media:' && parsed.protocol !== 'file:') return null
    const decodedPathSegments = parsed.pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
    let filePath = decodedPathSegments.join('/').replace(/^\/([a-zA-Z]:\/)/, '$1')
    if (/^[a-zA-Z]$/.test(parsed.hostname)) {
      filePath = `${parsed.hostname}:/${filePath.replace(/^\/+/, '')}`
    } else if (parsed.hostname) {
      filePath = `//${decodeURIComponent(parsed.hostname)}/${filePath.replace(/^\/+/, '')}`
    }
    return filePath
  } catch {
    return null
  }
}
