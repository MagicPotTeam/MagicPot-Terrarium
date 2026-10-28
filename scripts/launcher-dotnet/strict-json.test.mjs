import assert from 'node:assert/strict'
import test from 'node:test'
import { parseStrictJson } from './strict-json.mjs'

test('parses strict JSON while preserving null-prototype objects', () => {
  const value = parseStrictJson('{"__proto__":{"safe":true},"items":[1,true,null]}', 'fixture')
  assert.equal(Object.getPrototypeOf(value), null)
  assert.deepEqual(value.items, [1, true, null])
})

test('rejects duplicate object keys including escaped-equivalent keys', () => {
  assert.throws(() => parseStrictJson('{"key":1,"key":2}', 'fixture'), /duplicate object key/)
  assert.throws(() => parseStrictJson('{"key":1,"\\u006bey":2}', 'fixture'), /duplicate object key/)
})

test('rejects malformed JSON and excessive nesting', () => {
  assert.throws(() => parseStrictJson('{"key":}', 'fixture'), /not valid strict JSON/)
  assert.throws(() => parseStrictJson('['.repeat(130) + ']'.repeat(130), 'fixture'), /nesting/)
})
