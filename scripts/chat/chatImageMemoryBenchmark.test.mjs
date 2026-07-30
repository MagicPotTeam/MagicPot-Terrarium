import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { buildFixtureSession, createDeterministicPng } from './chatImageMemoryBenchmark.mjs'

test('creates byte-stable valid PNG attachments', () => {
  const first = createDeterministicPng(7, 32, 24)
  const second = createDeterministicPng(7, 32, 24)
  const different = createDeterministicPng(8, 32, 24)
  assert.deepEqual(first, second)
  assert.notDeepEqual(first, different)
  assert.deepEqual([...first.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
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
  assert.equal(session.storageScope, 'chat-image-memory-benchmark.agent-1')
  assert.equal(session.storageKey, `chat-image-memory-benchmark.agent-1\u0000${session.id}`)
  assert.ok(session.messages.every((message) => message.content.includes('Deterministic benchmark')))
})
