import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(
  new URL('../packages/figplugin-hosts/shared/visual-evidence.js', import.meta.url),
  'utf8'
)
const context = vm.createContext({ ArrayBuffer, DataView, Uint8Array })
vm.runInContext(source, context)
const api = context.MagicPotVisualEvidenceV1
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

test('pixel hashes use a dedicated raw buffer budget without expanding session or thumbnail hashes', () => {
  const bytes = new Uint8Array(8 * 1024 * 1024 + 1)
  bytes[0] = 17
  bytes[bytes.length - 1] = 33
  assert.equal(api.sha256PixelBuffer(bytes), hash(bytes))
  assert.throws(() => api.sha256SessionAsset(bytes))
  assert.throws(() => api.sha256(bytes))
  const small = new Uint8Array([1, 2, 3, 4])
  assert.equal(api.sha256PixelBuffer(small.subarray(1, 3)), hash(small.subarray(1, 3)))
})

test('pixel hashes accept exactly 64 MiB and refuse larger native buffers', () => {
  const bytes = new Uint8Array(64 * 1024 * 1024 + 1)
  assert.throws(() => api.sha256PixelBuffer(bytes))
  const exact = bytes.subarray(0, bytes.length - 1)
  assert.equal(api.sha256PixelBuffer(exact), hash(exact))
})
