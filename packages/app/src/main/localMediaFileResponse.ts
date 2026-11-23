import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

/**
 * Chromium's file:// loader opens a Windows path without the extended-length prefix, so a path
 * at or over MAX_PATH (260 with its terminator) answers net::ERR_FILE_NOT_FOUND, whatever URL
 * form names it (plain, \\?\, localhost, admin share; measured with Electron on Windows 11).
 * Managed chat media sit deep under the data folder (a 64-hex namespace, then a 64-hex file
 * name), and a derivative path is longer still. Node's fs prefixes long paths itself, so those
 * files are read here instead. The margin under 260 keeps a path that is close to the limit on
 * the side that is known to work.
 */
export const LONG_WINDOWS_PATH_THRESHOLD = 240

export function needsNodeFileResponse(
  localPath: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && localPath.length >= LONG_WINDOWS_PATH_THRESHOLD
}

// The types the app shows or plays from local-media; anything else is sent as bytes.
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf'
}

export function localMediaContentType(localPath: string): string {
  return CONTENT_TYPES[path.extname(localPath).toLowerCase()] ?? 'application/octet-stream'
}

type ByteRange = { start: number; end: number }

/** One `bytes=` range of a file of `size` bytes; null when unsatisfiable, 'all' when ignored. */
export function parseSingleByteRange(
  header: string | null,
  size: number
): ByteRange | null | 'all' {
  if (!header) return 'all'
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header)
  // Several ranges or another unit: answer with the whole file, as a server may.
  if (!match) return 'all'
  const [, first, last] = match
  if (!first && !last) return 'all'
  if (!first) {
    const suffix = Number(last)
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  const end = last ? Math.min(Number(last), size - 1) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start >= size || end < start) return null
  return { start, end }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

/**
 * The file's bytes as net.fetch(file://) would answer them for GET and HEAD: its type from the
 * extension, its length, and single byte ranges (206; 416 when unsatisfiable). The body streams
 * from disk and closes the file when the reader is done or cancels. A missing file is 404.
 */
export async function createLocalFileResponse(
  localPath: string,
  request: Request
): Promise<Response> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(localPath)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return new Response('Not found', { status: 404 })
    if (code === 'EACCES' || code === 'EPERM') return new Response('Forbidden', { status: 403 })
    throw error
  }
  if (!stat.isFile()) return new Response('Not found', { status: 404 })

  const size = stat.size
  const headers = new Headers({
    'Content-Type': localMediaContentType(localPath),
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString()
  })
  const range = parseSingleByteRange(request.headers.get('Range'), size)
  if (range === null) {
    headers.set('Content-Range', `bytes */${size}`)
    headers.set('Content-Length', '0')
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers })
  }
  const partial = range !== 'all'
  const start = partial ? range.start : 0
  const end = partial ? range.end : size - 1
  headers.set('Content-Length', String(size === 0 ? 0 : end - start + 1))
  if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  const status = partial ? 206 : 200
  const statusText = partial ? 'Partial Content' : 'OK'

  if (request.method.toUpperCase() === 'HEAD' || size === 0) {
    return new Response(null, { status, statusText, headers })
  }
  const stream = fs.createReadStream(localPath, { start, end })
  const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status, statusText, headers })
}
