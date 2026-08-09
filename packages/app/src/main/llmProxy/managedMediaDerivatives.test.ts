import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { importManagedMedia } from './managedMediaStore'
import {
  ensureManagedMediaDerivative,
  selectManagedMediaDerivativeBucket
} from './managedMediaDerivatives'

const sidecar = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock('../api/canvasThumbnailSidecarAdapter', () => ({
  generateCanvasThumbnailsViaSidecar: sidecar.generate
}))

function pngChunk(type: string, data: Buffer): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    let crc = value
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1) >>> 0
    return crc
  })
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length)
  return chunk
}

function png(width = 8, height = 4): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  for (let row = 0; row < height; row += 1) {
    scanlines[row * (1 + width * 4)] = 0
    scanlines.fill(0xff, row * (1 + width * 4) + 1, (row + 1) * (1 + width * 4))
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function gif(): Buffer {
  return Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
}

describe('selectManagedMediaDerivativeBucket', () => {
  it.each([
    [1, 1, 256],
    [256, 1, 256],
    [257, 1, 512],
    [256, 2, 512],
    [513, 2, 2048],
    [2049, 1, 2048]
  ])('selects bucket for css=%s dpr=%s', (css, dpr, expected) => {
    expect(selectManagedMediaDerivativeBucket(css, dpr)).toBe(expected)
  })

  it('does not select beyond the original dimensions', () => {
    expect(selectManagedMediaDerivativeBucket(1000, 2, { width: 300, height: 200 })).toBe(512)
  })
})

describe('ensureManagedMediaDerivative', () => {
  let tempRoot = ''
  let root = ''

  beforeEach(async () => {
    tempRoot = await createNodeTestArtifactDir('managed-media-derivatives')
    root = path.join(tempRoot, 'managed')
    await fs.mkdir(root, { recursive: true })
    sidecar.generate.mockReset()
    sidecar.generate.mockImplementation(async (request) => {
      const sourceBytes = await fs.readFile(request.items[0].path)
      const sourceHash = createHash('sha256').update(sourceBytes).digest('hex')
      const cacheKey = 'thumb-test'
      const entryRoot = path.join(request.cacheRoot, cacheKey)
      const output = path.join(entryRoot, 'generated.png')
      await fs.mkdir(entryRoot, { recursive: true })
      const bytes = png(8, 4)
      await fs.writeFile(output, bytes)
      const sourcePath = path.resolve(request.items[0].path)
      return {
        ok: true,
        binaryPath: 'test',
        args: [],
        stderr: '',
        stderrTruncated: false,
        response: {
          ok: true,
          cacheRoot: request.cacheRoot,
          results: [
            {
              id: request.items[0].id,
              ok: true,
              manifest: {
                schemaVersion: 1,
                id: request.items[0].id,
                cacheKey,
                canonicalPath: sourcePath,
                sourceSizeBytes: sourceBytes.length,
                sourceIdentity: {
                  kind: 'local-file',
                  canonicalPath: sourcePath,
                  sizeBytes: sourceBytes.length,
                  lastModifiedMs: 1,
                  cacheKey,
                  cacheRootDir: path.resolve(request.cacheRoot)
                },
                source: {
                  path: sourcePath,
                  canonicalPath: sourcePath,
                  byteLength: sourceBytes.length,
                  sizeBytes: sourceBytes.length,
                  width: 8,
                  height: 4,
                  orientedWidth: 8,
                  orientedHeight: 4,
                  colorType: 'rgba',
                  format: 'png'
                },
                hash: { algorithm: 'sha256', hex: sourceHash },
                levels: [
                  {
                    maxSide: request.thumbnail.levels[0],
                    width: 8,
                    height: 4,
                    filename: 'generated.png',
                    path: output,
                    src: output,
                    mimeType: 'image/png',
                    sizeBytes: bytes.length
                  }
                ],
                thumbnail: {
                  maxSide: request.thumbnail.levels[0],
                  path: output,
                  width: 8,
                  height: 4,
                  mimeType: 'image/png',
                  sizeBytes: bytes.length,
                  format: 'png'
                },
                manifestPath: path.join(entryRoot, 'manifest.json')
              }
            }
          ]
        }
      }
    })
  })
  afterEach(async () => fs.rm(tempRoot, { recursive: true, force: true }))

  async function imported(bytes = png(), mimeType = 'image/png', name = 'source.png') {
    return importManagedMedia(
      root,
      {
        bytes,
        mimeType,
        originalFileName: name,
        provenance: { source: 'test' }
      },
      { authorizedRoot: root }
    )
  }

  it('generates only the requested level with strict no-upscale limits and coalesces callers', async () => {
    const media = await imported()
    const [first, second] = await Promise.all([
      ensureManagedMediaDerivative({
        authorizedRoot: root,
        reference: media.reference,
        maxEdge: 512,
        format: 'png'
      }),
      ensureManagedMediaDerivative({
        authorizedRoot: root,
        reference: media.reference,
        maxEdge: 512,
        format: 'png'
      })
    ])
    expect(first).toEqual(second)
    expect(sidecar.generate).toHaveBeenCalledTimes(1)
    expect(sidecar.generate.mock.calls[0][0]).toMatchObject({
      thumbnail: { levels: [512], allowUpscale: false, cropTransparent: true, format: 'png' },
      maxConcurrency: 1,
      maxDecodedPixels: 64 * 1024 * 1024,
      maxOutputPixels: 512 * 512
    })
    expect(first.purpose).toBe('managed-media-derivative')
  })

  it('hits durable cache after completion and regenerates missing or corrupt files', async () => {
    const media = await imported()
    const first = await ensureManagedMediaDerivative({
      authorizedRoot: root,
      reference: media.reference,
      maxEdge: 256,
      format: 'png'
    })
    if (first.purpose !== 'managed-media-derivative') throw new Error('unexpected fallback')
    await ensureManagedMediaDerivative({
      authorizedRoot: root,
      reference: media.reference,
      maxEdge: 256,
      format: 'png'
    })
    expect(sidecar.generate).toHaveBeenCalledTimes(1)
    const derivative = path.join(root, ...first.relativePath.split('/'))
    await fs.chmod(derivative, 0o600)
    await fs.writeFile(derivative, Buffer.alloc(first.sizeBytes, 1))
    await ensureManagedMediaDerivative({
      authorizedRoot: root,
      reference: media.reference,
      maxEdge: 256,
      format: 'png'
    })
    expect(sidecar.generate).toHaveBeenCalledTimes(2)
    await fs.unlink(derivative)
    await ensureManagedMediaDerivative({
      authorizedRoot: root,
      reference: media.reference,
      maxEdge: 256,
      format: 'png'
    })
    expect(sidecar.generate).toHaveBeenCalledTimes(3)
  })

  it('rejects non-managed/traversal references and original corruption', async () => {
    const media = await imported()
    await expect(
      ensureManagedMediaDerivative({
        authorizedRoot: root,
        reference: { ...media.reference, relativePath: '../escape' },
        maxEdge: 256
      })
    ).rejects.toThrow()
    await fs.writeFile(media.absolutePath, Buffer.alloc(media.reference.sizeBytes!, 1))
    await expect(
      ensureManagedMediaDerivative({
        authorizedRoot: root,
        reference: media.reference,
        maxEdge: 256
      })
    ).rejects.toThrow(/integrity|corrupt/i)
    expect(sidecar.generate).not.toHaveBeenCalled()
  })

  it('rejects a symlinked derivative directory', async () => {
    const media = await imported()
    const outside = path.join(tempRoot, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(root, 'derivatives'), 'junction')
    await expect(
      ensureManagedMediaDerivative({
        authorizedRoot: root,
        reference: media.reference,
        maxEdge: 256,
        format: 'png'
      })
    ).rejects.toThrow(/unsafe/i)
  })

  it.each([
    [
      'result id',
      (
        result: Awaited<
          ReturnType<NonNullable<ReturnType<typeof sidecar.generate.getMockImplementation>>>
        >
      ) => {
        result.response.results[0].id = 'wrong-id'
      }
    ],
    [
      'manifest id',
      (
        result: Awaited<
          ReturnType<NonNullable<ReturnType<typeof sidecar.generate.getMockImplementation>>>
        >
      ) => {
        result.response.results[0].manifest!.id = 'wrong-id'
      }
    ],
    [
      'level',
      (
        result: Awaited<
          ReturnType<NonNullable<ReturnType<typeof sidecar.generate.getMockImplementation>>>
        >
      ) => {
        result.response.results[0].manifest!.levels![0].maxSide = 1024
      }
    ],
    [
      'source identity',
      (
        result: Awaited<
          ReturnType<NonNullable<ReturnType<typeof sidecar.generate.getMockImplementation>>>
        >
      ) => {
        result.response.results[0].manifest!.sourceIdentity!.sizeBytes += 1
      }
    ],
    [
      'output path',
      (
        result: Awaited<
          ReturnType<NonNullable<ReturnType<typeof sidecar.generate.getMockImplementation>>>
        >
      ) => {
        const manifest = result.response.results[0].manifest!
        manifest.levels![0].path = path.join(tempRoot, 'escaped.png')
        manifest.levels![0].src = manifest.levels![0].path
        manifest.thumbnail.path = manifest.levels![0].path
      }
    ]
  ])('rejects an invalid sidecar %s binding', async (_name, mutate) => {
    const media = await imported()
    const implementation = sidecar.generate.getMockImplementation()!
    sidecar.generate.mockImplementationOnce(async (request) => {
      const result = await implementation(request)
      mutate(result)
      return result
    })
    await expect(
      ensureManagedMediaDerivative({
        authorizedRoot: root,
        reference: media.reference,
        maxEdge: 256,
        format: 'png'
      })
    ).rejects.toThrow(/sidecar|response|mismatch|escaped/i)
  })

  it('returns a typed original fallback for GIF', async () => {
    const media = await imported(gif(), 'image/gif', 'source.gif')
    const result = await ensureManagedMediaDerivative({
      authorizedRoot: root,
      reference: media.reference,
      maxEdge: 256
    })
    expect(result).toMatchObject({
      purpose: 'original-fallback',
      status: 'unsupported',
      reason: 'animated-gif'
    })
    expect(sidecar.generate).not.toHaveBeenCalled()
  })

  it('cleans sidecar work files after failure', async () => {
    const media = await imported()
    sidecar.generate.mockRejectedValueOnce(new Error('sidecar exploded'))
    await expect(
      ensureManagedMediaDerivative({
        authorizedRoot: root,
        reference: media.reference,
        maxEdge: 256,
        format: 'png'
      })
    ).rejects.toThrow('sidecar exploded')
    const sha = createHash('sha256').update(png()).digest('hex')
    const directory = path.join(root, 'derivatives', sha.slice(0, 2), sha)
    expect(
      (await fs.readdir(directory)).filter(
        (name) => name.startsWith('.work-') || name.endsWith('.tmp')
      )
    ).toEqual([])
  })
})
