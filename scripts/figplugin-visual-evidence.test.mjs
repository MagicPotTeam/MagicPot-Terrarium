import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(
  new URL('../packages/figplugin-hosts/shared/visual-evidence.js', import.meta.url),
  'utf8'
)

const load = (withTextEncoder = true) => {
  const context = vm.createContext({
    ArrayBuffer,
    DataView,
    Error,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    ...(withTextEncoder ? { TextEncoder } : {}),
    Uint8Array
  })
  vm.runInContext(source, context, { filename: 'visual-evidence.js' })
  return { context, api: context.MagicPotVisualEvidenceV1 }
}

const png = (width, height, tail = []) => {
  const bytes = new Uint8Array(24 + tail.length)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8)
  new DataView(bytes.buffer).setUint32(16, width, false)
  new DataView(bytes.buffer).setUint32(20, height, false)
  bytes.set(tail, 24)
  return bytes
}

test('visual helper is immutable and implements the SHA-256 known vector', () => {
  const { context, api } = load()
  assert.equal(
    api.sha256(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
  assert.equal(Object.isFrozen(api), true)
  assert.equal(Object.getOwnPropertyDescriptor(context, 'MagicPotVisualEvidenceV1').writable, false)
  vm.runInContext('MagicPotVisualEvidenceV1 = null', context)
  assert.equal(context.MagicPotVisualEvidenceV1, api)
})

test('Figma capture exports a bounded PNG and hashes bytes plus dimensions', async () => {
  const { api } = load()
  const calls = []
  const first = await api.captureFigmaNode({
    width: 1200,
    height: 600,
    exportAsync: async (options) => {
      calls.push(options)
      return png(512, 256, [1, 2, 3])
    }
  })
  const second = await api.captureFigmaNode({
    width: 1200,
    height: 600,
    exportAsync: async () => png(512, 256, [1, 2, 4])
  })
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      format: 'PNG',
      constraint: { type: 'WIDTH', value: 512 },
      contentsOnly: true,
      colorProfile: 'SRGB'
    }
  ])
  assert.equal(first.width, 512)
  assert.equal(first.height, 256)
  assert.match(first.sha256, /^[a-f0-9]{64}$/)
  assert.notEqual(first.sha256, second.sha256)
  assert.deepEqual(JSON.parse(JSON.stringify(api.combine('node-1', first, first))), {
    targetId: 'node-1',
    before: JSON.parse(JSON.stringify(first)),
    after: JSON.parse(JSON.stringify(first)),
    changed: false
  })
  assert.equal(api.combine('node-1', first, second).changed, true)
  await assert.rejects(
    () =>
      api.captureFigmaNode({ width: 1, height: 1, exportAsync: async () => new Uint8Array(24) }),
    /VISUAL_EVIDENCE_UNAVAILABLE/
  )
})

test('Photoshop capture hashes bounded pixels and always disposes the image buffer', async () => {
  const { api } = load()
  let disposed = 0
  const calls = []
  const imaging = {
    getPixels: async (request) => {
      calls.push(request)
      return {
        imageData: {
          width: 2,
          height: 1,
          components: 4,
          componentSize: 8,
          pixelFormat: 'RGBA',
          colorSpace: 'RGB',
          getData: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
          dispose: () => {
            disposed += 1
          }
        }
      }
    }
  }
  const evidence = await api.capturePhotoshopLayer(imaging, 7, 9)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      documentID: 7,
      layerID: 9,
      targetSize: { width: 512, height: 512 },
      colorSpace: 'RGB',
      colorProfile: 'sRGB IEC61966-2.1',
      componentSize: 8,
      applyAlpha: false
    }
  ])
  assert.deepEqual({ width: evidence.width, height: evidence.height }, { width: 2, height: 1 })
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/)
  assert.equal(disposed, 1)

  await assert.rejects(
    () =>
      api.capturePhotoshopLayer(
        {
          getPixels: async () => ({
            imageData: {
              width: 2,
              height: 1,
              components: 4,
              componentSize: 8,
              pixelFormat: 'RGBA',
              colorSpace: 'RGB',
              getData: async () => new Uint8Array([1]),
              dispose: () => {
                disposed += 1
              }
            }
          })
        },
        7,
        9
      ),
    /VISUAL_EVIDENCE_UNAVAILABLE/
  )
  assert.equal(disposed, 2)
})

// Actual Photoshop UXP 27.5 exposes neither TextEncoder nor TextDecoder.
test('visual capture works without TextEncoder and preserves UTF-8 fingerprints', async () => {
  const { api, context } = load(false)
  assert.equal(typeof context.TextEncoder, 'undefined')
  const imaging = {
    getPixels: async () => ({
      imageData: {
        width: 1,
        height: 1,
        components: 4,
        componentSize: 8,
        pixelFormat: 'RGBA',
        colorSpace: 'RGB',
        colorProfile: '测试😀',
        getData: async () => new Uint8Array([9, 8, 7, 255]),
        dispose() {
          // This byte-array fixture owns no native image resource.
        }
      }
    })
  }
  const actual = await api.capturePhotoshopLayer(imaging, 1, 2)
  const expected = await load().api.capturePhotoshopLayer(imaging, 1, 2)
  assert.equal(actual.sha256, expected.sha256)
  assert.equal(typeof context.TextEncoder, 'undefined', 'must not install a global shim')
})

test('bounded UTF-8 matches native TextEncoder for code point boundaries and every UTF-16 code unit', () => {
  const { api } = load(false)
  const encoder = new TextEncoder()
  for (const text of [
    '',
    'A\0中文😀e\u0301',
    '\ud800',
    '\udfff',
    '\ud800x\udc00',
    String.fromCodePoint(0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff)
  ])
    assert.deepEqual(api.encodeUtf8(text), encoder.encode(text))
  for (let start = 0; start < 65536; start += 1024) {
    const text = Array.from({ length: 1024 }, (_, i) => String.fromCharCode(start + i)).join('')
    assert.deepEqual(api.encodeUtf8(text), encoder.encode(text))
  }
  assert.equal(api.encodeUtf8('中'.repeat(65536)).byteLength, 196608)
  assert.throws(() => api.encodeUtf8('x'.repeat(65537)), /VISUAL_EVIDENCE_UNAVAILABLE/)
  assert.throws(() => api.encodeUtf8({}), /VISUAL_EVIDENCE_UNAVAILABLE/)
})
