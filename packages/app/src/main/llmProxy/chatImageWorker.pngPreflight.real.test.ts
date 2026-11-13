import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import { expect, it } from 'vitest'

// Manual private-worker integration only. Never point this at a released binary.
// Rejection of an incomplete IHDR-only image checks ordering, not successful decode.
const worker = process.env.MAGICPOT_TEST_CHAT_IMAGE_WORKER
const runWithPrivateWorker = worker ? it : it.skip
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function ihdrOnly(width: number, height: number): Buffer {
  const result = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(result)
  result.writeUInt32BE(13, 8)
  result.write('IHDR', 12)
  result.writeUInt32BE(width, 16)
  result.writeUInt32BE(height, 20)
  result.set([8, 6, 0, 0, 0], 24)
  result.writeUInt32BE(crc32(result.subarray(12, 29)), 29)
  return result
}
function run(input: Buffer) {
  expect(worker && path.isAbsolute(worker)).toBe(true)
  const output = spawnSync(
    worker!,
    ['--chat-image', '--target-bytes', '512000', '--max-edge', '2000'],
    {
      input,
      timeout: 15_000,
      windowsHide: true,
      shell: false
    }
  )
  expect(output.error).toBeUndefined()
  expect(output.status).toBe(1)
  expect(output.stdout.byteLength).toBe(0)
  return output.stderr.toString('utf8').trim()
}
runWithPrivateWorker(
  'rejects a declared >40M PNG before needing IDAT and defers an equal-limit PNG to decoder',
  () => {
    expect(run(ihdrOnly(6400, 6251))).toBe('CHAT_IMAGE_DIMENSIONS_LIMIT')
    expect(run(ihdrOnly(6400, 6250))).toBe('CHAT_IMAGE_DECODE_ERROR')
    expect(run(ihdrOnly(0, 1))).toBe('CHAT_IMAGE_DIMENSIONS_LIMIT')
  }
)

function pngChunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length, 0)
  result.write(type, 4, 'ascii')
  data.copy(result, 8)
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4)
  return result
}

function transparentPng(width: number, height: number, noisy = true): Buffer {
  const rows = Buffer.alloc((width * 4 + 1) * height)
  let state = 0x5a17c9e3
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      rows.writeUInt32LE(noisy ? state >>> 0 : 0x7f38220c, y * (width * 4 + 1) + 1 + x * 4)
    }
  }
  return Buffer.concat([
    ihdrOnly(width, height),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function encodePng(source: Buffer, target = 512_000) {
  expect(worker && path.isAbsolute(worker)).toBe(true)
  return spawnSync(
    worker!,
    ['--chat-image', '--target-bytes', String(target), '--max-edge', '2000'],
    {
      input: source,
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
      shell: false
    }
  )
}

function inspectTransparentOutput(bytes: Buffer): { width: number; height: number; alpha: number } {
  expect(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe(true)
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  expect(width).toBeGreaterThan(0)
  expect(height).toBeGreaterThan(0)
  expect(Math.max(width, height)).toBeLessThanOrEqual(2000)
  expect(bytes[24]).toBe(8)
  expect(bytes[25]).toBe(6)
  expect(bytes[28]).toBe(0)
  const idat: Buffer[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset)
    expect(offset + 12 + size).toBeLessThanOrEqual(bytes.length)
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      idat.push(bytes.subarray(offset + 8, offset + 8 + size))
    }
    offset += size + 12
  }
  expect(offset).toBe(bytes.length)
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (width * 4 + 1) * height })
  expect(raw.length).toBe((width * 4 + 1) * height)
  expect(raw[0]).toBeLessThanOrEqual(4)
  // The first pixel of the first row has zero left/up predictors for every PNG
  // filter, so its alpha byte needs no image-decoder implementation in this test.
  expect(raw[4]).toBeGreaterThan(0)
  expect(raw[4]).toBeLessThan(255)
  return { width, height, alpha: raw[4] }
}

runWithPrivateWorker(
  'fits a high-entropy transparent PNG without changing its source',
  () => {
    const source = transparentPng(1024, 1024)
    const before = createHash('sha256').update(source).digest('hex')
    const output = encodePng(source)
    expect(output.error).toBeUndefined()
    expect(output.status, output.stderr.toString('utf8')).toBe(0)
    expect(output.stdout.byteLength).toBeGreaterThan(0)
    expect(output.stdout.byteLength).toBeLessThanOrEqual(512_000)
    inspectTransparentOutput(output.stdout)
    expect(createHash('sha256').update(source).digest('hex')).toBe(before)
  },
  45_000
)

runWithPrivateWorker('keeps a fitting small transparent PNG at its original dimensions', () => {
  const source = transparentPng(4, 3, false)
  const output = encodePng(source)
  expect(output.error).toBeUndefined()
  expect(output.status, output.stderr.toString('utf8')).toBe(0)
  expect(inspectTransparentOutput(output.stdout)).toEqual({ width: 4, height: 3, alpha: 127 })
})

runWithPrivateWorker(
  'fits a transparent PNG wider than 2000 pixels and preserves its aspect ratio',
  () => {
    const source = transparentPng(2016, 1024)
    const before = createHash('sha256').update(source).digest('hex')
    const output = encodePng(source)
    expect(output.error).toBeUndefined()
    expect(output.status, output.stderr.toString('utf8')).toBe(0)
    expect(output.stdout.byteLength).toBeLessThanOrEqual(512_000)
    const { width, height } = inspectTransparentOutput(output.stdout)
    expect(Math.abs(width / height - 2016 / 1024)).toBeLessThan(0.01)
    expect(createHash('sha256').update(source).digest('hex')).toBe(before)
  },
  45_000
)

runWithPrivateWorker(
  'fails boundedly when a tiny transparent PNG cannot fit the byte target',
  () => {
    const output = encodePng(transparentPng(4, 3, false), 1)
    expect(output.error).toBeUndefined()
    expect(output.status).toBe(1)
    expect(output.stdout.byteLength).toBe(0)
    expect(output.stderr.toString('utf8').trim()).toBe('CHAT_IMAGE_TARGET_UNREACHABLE')
  }
)
