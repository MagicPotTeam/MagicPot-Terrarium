import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLocalFileResponse,
  LONG_WINDOWS_PATH_THRESHOLD,
  localMediaContentType,
  needsNodeFileResponse,
  parseSingleByteRange
} from './localMediaFileResponse'

// node:fs is the in-memory filesystem of the node test setup.
const base = path.join(process.cwd(), '.magicpot-trash', 'local-media-file-response')
// As deep as a managed chat original: a 64-hex namespace, a shard, then a 64-hex file name.
const longFile = path.join(
  base,
  'Data',
  '.chat_media',
  'user-output',
  'a'.repeat(64),
  'originals',
  'c6',
  `${'c'.repeat(64)}.png`
)
const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index))

function get(headers?: Record<string, string>, method = 'GET'): Request {
  return new Request('local-media:///synthetic', { method, headers })
}

describe('needsNodeFileResponse', () => {
  it('reads Windows paths near MAX_PATH with Node, leaves shorter ones and other systems to Chromium', () => {
    const atThreshold = `C:/${'x'.repeat(LONG_WINDOWS_PATH_THRESHOLD - 3)}`
    expect(atThreshold).toHaveLength(LONG_WINDOWS_PATH_THRESHOLD)
    expect(needsNodeFileResponse(atThreshold, 'win32')).toBe(true)
    expect(needsNodeFileResponse(atThreshold.slice(0, -1), 'win32')).toBe(false)
    // The 268-character original that failed to load in a dev build.
    expect(needsNodeFileResponse(`C:/${'y'.repeat(265)}`, 'win32')).toBe(true)
    expect(needsNodeFileResponse(`/home/${'y'.repeat(300)}`, 'linux')).toBe(false)
    expect(needsNodeFileResponse(`/Users/${'y'.repeat(300)}`, 'darwin')).toBe(false)
  })
})

describe('localMediaContentType', () => {
  it('names image, video and audio types by extension, case-insensitively', () => {
    expect(localMediaContentType('a.PNG')).toBe('image/png')
    expect(localMediaContentType('a.webp')).toBe('image/webp')
    expect(localMediaContentType('a.jpeg')).toBe('image/jpeg')
    expect(localMediaContentType('a.mp4')).toBe('video/mp4')
    expect(localMediaContentType('a.unknown')).toBe('application/octet-stream')
    expect(localMediaContentType('no-extension')).toBe('application/octet-stream')
  })
})

describe('parseSingleByteRange', () => {
  it('answers single ranges and refuses unsatisfiable ones', () => {
    expect(parseSingleByteRange(null, 10)).toBe('all')
    expect(parseSingleByteRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 })
    expect(parseSingleByteRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 })
    expect(parseSingleByteRange('bytes=8-100', 10)).toEqual({ start: 8, end: 9 })
    expect(parseSingleByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseSingleByteRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 })
    expect(parseSingleByteRange('bytes=10-', 10)).toBeNull()
    expect(parseSingleByteRange('bytes=5-2', 10)).toBeNull()
    expect(parseSingleByteRange('bytes=-0', 10)).toBeNull()
    // Several ranges or another unit: the whole file.
    expect(parseSingleByteRange('bytes=0-1,4-5', 10)).toBe('all')
    expect(parseSingleByteRange('items=0-1', 10)).toBe('all')
  })
})

describe('createLocalFileResponse', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(longFile), { recursive: true })
    fs.writeFileSync(longFile, bytes)
  })
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('streams the whole file with its type and length', async () => {
    const response = await createLocalFileResponse(longFile, get())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Length')).toBe('64')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('answers a byte range with 206 and the matching slice', async () => {
    const response = await createLocalFileResponse(longFile, get({ Range: 'bytes=10-19' }))
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe('bytes 10-19/64')
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true)
  })

  it('answers 416 for a range past the end', async () => {
    const response = await createLocalFileResponse(longFile, get({ Range: 'bytes=64-' }))
    expect(response.status).toBe(416)
    expect(response.headers.get('Content-Range')).toBe('bytes */64')
    expect(await response.text()).toBe('')
  })

  it('answers HEAD with the headers and no body', async () => {
    const response = await createLocalFileResponse(longFile, get(undefined, 'HEAD'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('64')
    expect(response.body).toBeNull()
  })

  it('answers 404 for a missing file or a folder', async () => {
    expect((await createLocalFileResponse(`${longFile}.missing`, get())).status).toBe(404)
    expect((await createLocalFileResponse(path.dirname(longFile), get())).status).toBe(404)
  })

  it('answers an empty file with an empty 200', async () => {
    const empty = path.join(path.dirname(longFile), 'empty.png')
    fs.writeFileSync(empty, Buffer.alloc(0))
    const response = await createLocalFileResponse(empty, get())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe('0')
    expect(await response.text()).toBe('')
  })
})
