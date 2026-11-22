import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { buildFixtureSession, createDeterministicPng, isChatImageMemoryReady } from './chatImageMemoryBenchmark.mjs'
import zlib from 'node:zlib'


test('accepts a virtualized near-viewport image set without requiring all 100 images mounted', () => {
  assert.equal(
    isChatImageMemoryReady({ messageCount: 500, expectedMessageCount: 500, mountedImageCount: 12, nearViewportMountedImageCount: 8, expectsImages: true }),
    true
  )
  assert.equal(
    isChatImageMemoryReady({ messageCount: 500, expectedMessageCount: 500, mountedImageCount: 0, nearViewportMountedImageCount: 0, expectsImages: true }),
    false
  )
  assert.equal(
    isChatImageMemoryReady({ messageCount: 499, expectedMessageCount: 500, mountedImageCount: 12, nearViewportMountedImageCount: 8, expectsImages: true }),
    false
  )
})

test('creates byte-stable valid PNG attachments', () => {
  const first = createDeterministicPng(7, 32, 24)
  const second = createDeterministicPng(7, 32, 24)
  const different = createDeterministicPng(8, 32, 24)
  assert.deepEqual(first, second)
  assert.notDeepEqual(first, different)
  assert.deepEqual([...first.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
})

test('synthesizes a 4096 square RGBA PNG with reproducible decompressible pixels', () => {
  const width = 4096
  const height = 4096
  const bytes = createDeterministicPng(7, width, height)
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(bytes.readUInt32BE(16), width)
  assert.equal(bytes.readUInt32BE(20), height)
  assert.equal(bytes[24], 8)
  assert.equal(bytes[25], 6)
  const idat = []
  let offset = 8
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + size))
    offset += 12 + size
    if (type === 'IEND') break
  }
  assert.equal(offset, bytes.length)
  const scanlines = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: height * (1 + width * 4) })
  assert.equal(scanlines.length, height * (1 + width * 4))
  for (const [x, y] of [[0, 0], [123, 456], [4095, 4095]]) {
    const row = y * (1 + width * 4)
    assert.equal(scanlines[row], 0)
    assert.deepEqual([...scanlines.subarray(row + 1 + x * 4, row + 5 + x * 4)], [
      (x * 3 + 7 * 17) & 0xff,
      (y * 5 + 7 * 29) & 0xff,
      ((x ^ y) + 7 * 43) & 0xff,
      255
    ])
  }
})

test('builds an evenly distributed image-heavy 500-message session', () => {
  const paths = Array.from({ length: 100 }, (_, index) =>
    path.resolve('fixture', `image-${index}.png`)
  )
  const session = buildFixtureSession(paths, 500)
  const attachments = session.messages.flatMap((message) => message.attachments || [])
  assert.equal(session.messages.length, 500)
  assert.equal(attachments.length, 100)
  assert.equal(new Set(attachments.map((attachment) => attachment.url)).size, 100)
  assert.equal(session.storageScope, 'tab-project-chat-image-memory-benchmark.agent-1')
  assert.equal(
    session.storageKey,
    `tab-project-chat-image-memory-benchmark.agent-1\u0000${session.id}`
  )
  assert.ok(session.messages.every((message) => message.content.includes('Deterministic benchmark')))
})
