import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { test } from 'node:test'
import vm from 'node:vm'
import Module from 'node:module'
import { buildHostPixelAudit } from './build-figplugin-pixel-audit.mjs'
const source = readFileSync(
  new URL('../packages/figplugin-hosts/shared/pixel-audit.js', import.meta.url),
  'utf8'
)
function load(options = {}, withTextEncoder = true) {
  const context = vm.createContext({
    Uint8Array,
    ArrayBuffer,
    DataView,
    ...(withTextEncoder ? { TextEncoder } : {}),
    Date,
    console
  })
  vm.runInContext(source, context)
  return {
    api: context.MagicPotPixelAuditBundle.createPixelAuditCache(options),
    encode: context.MagicPotContextPngV1.encode,
    context
  }
}
const plain = (value) => JSON.parse(JSON.stringify(value))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const point = (data, width, height) => ({ sha256: hash(data), width, height })
function crc(data) {
  let value = 0xffffffff
  for (const byte of data) {
    value ^= byte
    for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const value = Buffer.alloc(data.length + 12)
  value.writeUInt32BE(data.length)
  value.write(type, 4, 'ascii')
  Buffer.from(data).copy(value, 8)
  value.writeUInt32BE(crc(value.subarray(4, -4)), value.length - 4)
  return value
}
function png(
  width,
  height,
  pixels,
  { color = 6, filter = 0, level = 6, palette, alpha, text, rawOverride, interlace = 0 } = {}
) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = color
  header[12] = interlace
  const stride = width * channels,
    raw = Buffer.alloc((stride + 1) * height)
  const paeth = (a, b, c) => {
    const p = a + b - c,
      x = Math.abs(p - a),
      y = Math.abs(p - b),
      z = Math.abs(p - c)
    return x <= y && x <= z ? a : y <= z ? b : c
  }
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x,
        a = x >= channels ? pixels[at - channels] : 0,
        b = y ? pixels[at - stride] : 0,
        c = y && x >= channels ? pixels[at - stride - channels] : 0
      const predictor = [0, a, b, (a + b) >>> 1, paeth(a, b, c)][filter] ?? 0
      raw[y * (stride + 1) + x + 1] = (pixels[at] - predictor) & 255
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(palette ? [chunk('PLTE', palette)] : []),
    ...(alpha ? [chunk('tRNS', alpha)] : []),
    ...(text ? [chunk('tEXt', Buffer.from(text))] : []),
    chunk('IDAT', deflateSync(rawOverride ?? raw, { level })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
function compare(api, a, b) {
  return plain(api.compare([{ targetId: 'owned', baseline: a, current: b }]))[0]
}

function decodeContextPng(bytes) {
  const input = Buffer.from(bytes)
  assert.deepEqual([...input.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const chunks = []
  let offset = 8
  while (offset < input.length) {
    const length = input.readUInt32BE(offset)
    const end = offset + length + 12
    assert.ok(end <= input.length)
    assert.equal(input.readUInt32BE(end - 4), crc(input.subarray(offset + 4, end - 4)))
    chunks.push({
      type: input.toString('ascii', offset + 4, offset + 8),
      data: input.subarray(offset + 8, end - 4)
    })
    offset = end
  }
  assert.equal(offset, input.length)
  assert.deepEqual(
    chunks.map(({ type }) => type),
    ['IHDR', 'sRGB', 'IDAT', 'IEND']
  )
  assert.equal(chunks[0].data.length, 13)
  assert.deepEqual([...chunks[0].data.subarray(8)], [8, 6, 0, 0, 0])
  assert.deepEqual([...chunks[1].data], [0])
  assert.equal(chunks[3].data.length, 0)
  const width = chunks[0].data.readUInt32BE(0)
  const height = chunks[0].data.readUInt32BE(4)
  const stride = width * 4
  const raw = inflateSync(chunks[2].data)
  assert.equal(raw.length, (stride + 1) * height)
  const rgba = new Uint8Array(stride * height)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
    return [a, b, c][distances.indexOf(Math.min(...distances))]
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    assert.ok(filter <= 4)
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x
      const a = x >= 4 ? rgba[at - 4] : 0
      const b = y ? rgba[at - stride] : 0
      const c = y && x >= 4 ? rgba[at - stride - 4] : 0
      rgba[at] =
        (raw[y * (stride + 1) + x + 1] + [0, a, b, (a + b) >>> 1, paeth(a, b, c)][filter]) & 255
    }
  }
  return { width, height, rgba }
}

test('CommonJS packaging exposes only a frozen public context encoder without leaking the module bundle', () => {
  const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView })
  const module = { exports: {} }
  const filename = 'pixel-audit-commonjs.js'
  const execute = vm.runInContext(Module.wrap(source), context, { filename })
  execute(
    module.exports,
    () => assert.fail('pixel helper must not require native or browser APIs'),
    module,
    filename,
    '.'
  )
  assert.equal(context.MagicPotPixelAuditBundle, undefined)
  assert.deepEqual(Object.keys(module.exports), [])
  assert.deepEqual(Object.keys(context.MagicPotContextPngV1), ['encode'])
  assert.equal(Object.isFrozen(context.MagicPotContextPngV1), true)
  assert.deepEqual(Object.getOwnPropertyDescriptor(context, 'MagicPotContextPngV1'), {
    value: context.MagicPotContextPngV1,
    writable: false,
    enumerable: false,
    configurable: false
  })
  assert.equal(Reflect.set(context, 'MagicPotContextPngV1', {}), false)
  assert.equal(Reflect.deleteProperty(context, 'MagicPotContextPngV1'), false)
  assert.equal(
    Reflect.set(context.MagicPotContextPngV1, 'encode', () => undefined),
    false
  )
  assert.equal('encode' in context.MagicPotPixelAuditV1, false)
  assert.equal('encodeContextPng' in context.MagicPotPixelAuditV1, false)
  const rgba = new Uint8Array([11, 22, 33, 0, 44, 55, 66, 127])
  const encoded = context.MagicPotContextPngV1.encode(2, 1, rgba, 4)
  assert.deepEqual(decodeContextPng(encoded), { width: 2, height: 1, rgba })
  const ref = point(encoded, 2, 1)
  assert.equal(compare(context.MagicPotPixelAuditV1, ref, ref).status, 'unavailable')
})

test('context PNG encoder preserves exact RGB and straight alpha without browser APIs or cache entries', () => {
  const { api, encode, context } = load({}, false)
  for (const name of ['Buffer', 'TextEncoder', 'TextDecoder', 'OffscreenCanvas', 'document'])
    assert.equal(typeof context[name], 'undefined')
  for (const components of [3, 4]) {
    const width = 17
    const height = 13
    const owned = Uint8Array.from(
      { length: width * height * components + 8 },
      (_, i) => (i * 71) & 255
    )
    const pixels = owned.subarray(4, -4)
    const before = new Uint8Array(pixels)
    const expected = Uint8Array.from({ length: width * height * 4 }, (_, i) =>
      i % 4 === 3 && components === 3 ? 255 : pixels[Math.floor(i / 4) * components + (i % 4)]
    )
    if (components === 4) {
      for (let i = 0; i < width * height; i++)
        expected[i * 4 + 3] = pixels[i * 4 + 3] = [0, 1, 127, 254, 255][i % 5]
      before.set(pixels)
    }
    const pngBytes = encode(width, height, pixels, components)
    const decoded = decodeContextPng(pngBytes)
    assert.deepEqual(decoded, { width, height, rgba: expected })
    assert.deepEqual(pixels, before, 'encoding must not mutate the native copy')
    assert.deepEqual(
      encode(width, height, pixels, components),
      pngBytes,
      'encoding is deterministic'
    )
    const ref = point(pngBytes, width, height)
    assert.equal(compare(api, ref, ref).status, 'unavailable', 'encoder does not remember pixels')
    api.rememberPng(ref, pngBytes)
    const native = point(pixels, width, height)
    api.rememberPixels(native, pixels, components)
    assert.equal(compare(api, ref, native).changedPixels, 0)
  }
})

test('context PNG encoder has a fixed 256-edge / 24 KiB budget with real compression', () => {
  const { encode } = load({}, false)
  const gradient = Uint8Array.from({ length: 256 * 256 * 4 }, (_, i) =>
    i % 4 === 3 ? 127 : (Math.floor(i / 4) + Math.floor(i / 1024)) & 255
  )
  const compressed = encode(256, 256, gradient, 4)
  assert.ok(compressed.length <= 24576)
  assert.deepEqual(decodeContextPng(compressed).rgba, gradient)
  for (const edge of [256, 128, 64, 32]) {
    let state = 12345
    const noisy = Uint8Array.from({ length: edge * edge * 4 }, () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return state & 255
    })
    const result = encode(edge, edge, noisy, 4)
    if (edge > 64) assert.equal(result, undefined)
    else {
      assert.ok(result.length <= 24576)
      assert.deepEqual(decodeContextPng(result).rgba, noisy)
    }
  }
})

test('context PNG encoder rejects invalid dimensions, layouts and byte arrays before compression', () => {
  const { encode } = load()
  for (const [width, height, data, components] of [
    [0, 1, new Uint8Array(0), 4],
    [257, 1, new Uint8Array(257 * 4), 4],
    [1, 257, new Uint8Array(257 * 4), 4],
    [1.5, 1, new Uint8Array(4), 4],
    [NaN, 1, new Uint8Array(4), 4],
    [1, Infinity, new Uint8Array(4), 4],
    [1, 1, new Uint8Array(3), 4],
    [1, 1, new Uint8Array(4), 3],
    [1, 1, new Uint8Array(2), 2],
    [1, 1, new Uint16Array(2), 4],
    [1, 1, [1, 2, 3, 4], 4]
  ])
    assert.throws(() => encode(width, height, data, components), /PIXELS_UNAVAILABLE/)
})

test('generated helper matches the pinned source and contains no network, storage or evaluation', async () => {
  assert.equal((await buildHostPixelAudit()).text, source)
  assert.match(source, /MIT License/)
  assert.doesNotMatch(
    source,
    /\beval\s*\(|new Function|fetch\(|XMLHttpRequest|localStorage|clientStorage/
  )
  assert.equal(Object.isFrozen(load().context.MagicPotPixelAuditV1), true)
})
for (const filter of [0, 1, 2, 3, 4])
  for (const level of [0, 1, 6, 9])
    test(`PNG filter ${filter} / compression ${level} matches native RGBA`, () => {
      const width = 17,
        height = 13,
        data = Uint8Array.from(
          { length: width * height * 4 },
          (_, i) => (i * 173 + Math.floor(i / 7) * 29) & 255
        )
      const image = png(width, height, data, { filter, level }),
        a = point(data, width, height),
        b = point(image, width, height),
        { api } = load()
      api.rememberPixels(a, data, 4)
      api.rememberPng(b, image)
      assert.equal(compare(api, a, b).changedPixels, 0)
    })
test('different PNG encoding and ancillary metadata with identical pixels passes exact comparison', () => {
  const data = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 127]),
    x = png(2, 1, data, { level: 1 }),
    y = png(2, 1, data, { level: 9, text: 'key\0value' })
  const a = point(x, 2, 1),
    b = point(y, 2, 1),
    { api } = load()
  assert.notEqual(a.sha256, b.sha256)
  api.rememberPng(a, x)
  api.rememberPng(b, y)
  assert.equal(compare(api, a, b).changedPixels, 0)
})
test('one changed pixel reports exact count, channel distance and bounded location', () => {
  const before = new Uint8Array(4 * 3 * 4).fill(255),
    after = new Uint8Array(before)
  after[(1 * 4 + 2) * 4] = 245
  const a = point(before, 4, 3),
    b = point(after, 4, 3),
    { api } = load()
  api.rememberPixels(a, before, 4)
  api.rememberPixels(b, after, 4)
  assert.deepEqual(compare(api, a, b), {
    targetId: 'owned',
    status: 'compared',
    pixelCount: 12,
    changedPixels: 1,
    maxChannelDelta: 10,
    absoluteDelta: 10,
    changedBounds: { x: 2, y: 1, width: 1, height: 1 }
  })
})
test('transparent RGB is normalized but an alpha-only change remains a pixel difference', () => {
  const { api } = load(),
    a = { sha256: 'a'.repeat(64), width: 1, height: 1 },
    b = { ...a, sha256: 'b'.repeat(64) },
    c = { ...a, sha256: 'c'.repeat(64) }
  api.rememberPixels(a, new Uint8Array([9, 8, 7, 0]), 4)
  api.rememberPixels(b, new Uint8Array([1, 2, 3, 0]), 4)
  api.rememberPixels(c, new Uint8Array([0, 0, 0, 1]), 4)
  assert.equal(compare(api, a, b).changedPixels, 0)
  assert.equal(compare(api, a, c).changedPixels, 1)
})
for (const [color, pixels, expected, extra] of [
  [0, [4, 8], [4, 4, 4, 255, 8, 8, 8, 255], {}],
  [2, [1, 2, 3, 4, 5, 6], [1, 2, 3, 255, 4, 5, 6, 255], {}],
  [4, [4, 255, 8, 128], [4, 4, 4, 255, 8, 8, 8, 128], {}],
  [
    3,
    [0, 1],
    [1, 2, 3, 255, 4, 5, 6, 128],
    { palette: Buffer.from([1, 2, 3, 4, 5, 6]), alpha: Buffer.from([255, 128]) }
  ],
  [0, [4, 8], [0, 0, 0, 0, 8, 8, 8, 255], { alpha: Buffer.from([0, 4]) }],
  [2, [1, 2, 3, 4, 5, 6], [0, 0, 0, 0, 4, 5, 6, 255], { alpha: Buffer.from([0, 1, 0, 2, 0, 3]) }]
])
  test(`decodes PNG color type ${color} with ${extra.alpha ? 'transparency' : 'opaque'} data`, () => {
    const image = png(2, 1, Uint8Array.from(pixels), { color, ...extra }),
      a = point(image, 2, 1),
      b = point(Uint8Array.from(expected), 2, 1),
      { api } = load()
    api.rememberPng(a, image)
    api.rememberPixels(b, Uint8Array.from(expected), 4)
    assert.equal(compare(api, a, b).changedPixels, 0)
  })
test('large incompressible and highly compressed PNGs stay bounded and decode correctly', () => {
  for (const level of [0, 9]) {
    let state = 7
    const data = Uint8Array.from({ length: 512 * 512 * 4 }, () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return state & 255
    })
    const image = png(512, 512, data, { level }),
      a = point(data, 512, 512),
      b = point(image, 512, 512),
      { api } = load()
    api.rememberPixels(a, data, 4)
    api.rememberPng(b, image)
    assert.equal(compare(api, a, b).changedPixels, 0)
  }
})
test('missing, evicted, expired and cleared pixels never become a match', () => {
  let now = 100
  const { api } = load({ now: () => now, maxFrames: 2, maxBytes: 8 })
  const a = { sha256: 'a'.repeat(64), width: 1, height: 1 },
    b = { ...a, sha256: 'b'.repeat(64) },
    c = { ...a, sha256: 'c'.repeat(64) }
  assert.equal(compare(api, a, a).status, 'unavailable')
  api.rememberPixels(a, new Uint8Array(4), 4)
  api.rememberPixels(b, new Uint8Array(4), 4)
  api.rememberPixels(c, new Uint8Array(4), 4)
  assert.equal(compare(api, a, b).status, 'unavailable')
  assert.equal(compare(api, b, c).status, 'compared')
  now += 24 * 60 * 60 * 1000
  assert.equal(compare(api, b, c).status, 'unavailable')
  const epoch = api.epoch()
  api.clear()
  api.rememberPixels(a, new Uint8Array(4), 4, epoch)
  assert.equal(compare(api, a, a).status, 'unavailable')
})
test('native buffer alias changes do not mutate stored evidence and size changes are not resampled', () => {
  const { api } = load(),
    data = new Uint8Array([1, 2, 3, 255]),
    a = point(data, 1, 1),
    b = { ...a, sha256: 'b'.repeat(64) },
    c = { ...a, width: 2, sha256: 'c'.repeat(64) }
  api.rememberPixels(a, data, 4)
  data[0] = 200
  api.rememberPixels(b, new Uint8Array([1, 2, 3, 255]), 4)
  api.rememberPixels(c, new Uint8Array(8), 4)
  assert.equal(compare(api, a, b).changedPixels, 0)
  assert.equal(compare(api, a, c).status, 'dimensions-changed')
})
test('bad CRC, truncated, interlaced, invalid filter, zip bomb and mismatched dimensions are unavailable', () => {
  const { api } = load(),
    data = new Uint8Array([1, 2, 3, 255]),
    good = png(1, 1, data),
    ref = point(good, 1, 1)
  const bad = Buffer.from(good)
  bad[29] ^= 1
  const cases = [
    bad,
    good.subarray(0, -1),
    png(1, 1, data, { interlace: 1 }),
    png(1, 1, data, { filter: 5 }),
    png(1, 1, data, { rawOverride: Buffer.alloc(2 * 1024 * 1024) }),
    png(2, 1, new Uint8Array(8))
  ]
  for (const value of cases)
    assert.throws(() => api.rememberPng(ref, value), /PIXELS_UNAVAILABLE|invalid/)
  assert.equal(compare(api, ref, ref).status, 'unavailable')
})
