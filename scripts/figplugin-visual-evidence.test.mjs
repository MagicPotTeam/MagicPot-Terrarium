import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import Module from 'node:module'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const source = fs.readFileSync(
  new URL('../packages/figplugin-hosts/shared/visual-evidence.js', import.meta.url),
  'utf8'
)
const pixelSource = fs.readFileSync(
  new URL('../packages/figplugin-hosts/shared/pixel-audit.js', import.meta.url),
  'utf8'
)

const createContext = (withTextEncoder = true) =>
  vm.createContext({
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

const load = (withTextEncoder = true) => {
  const context = createContext(withTextEncoder)
  vm.runInContext(source, context, { filename: 'visual-evidence.js' })
  return { context, api: context.MagicPotVisualEvidenceV1 }
}

const loadPhotoshopContext = () => {
  const context = createContext(false)
  const module = { exports: {} }
  const filename = 'photoshop-context-commonjs.js'
  const execute = vm.runInContext(Module.wrap(`${pixelSource}\n${source}`), context, {
    filename
  })
  execute(
    module.exports,
    () => assert.fail('context helpers must not require native or browser APIs'),
    module,
    filename,
    '.'
  )
  assert.equal(context.MagicPotPixelAuditBundle, undefined, 'bundle remains module-local')
  assert.equal(Object.isFrozen(context.MagicPotContextPngV1), true)
  assert.deepEqual(Object.getOwnPropertyDescriptor(context, 'MagicPotContextPngV1'), {
    value: context.MagicPotContextPngV1,
    writable: false,
    enumerable: false,
    configurable: false
  })
  return { context, api: context.MagicPotVisualEvidenceV1 }
}

const photoshopContextFixture = (options = {}) => {
  const requests = []
  const reads = []
  const disposals = []
  const snapshot = {
    historyStateId: options.historyStateId ?? 11,
    bounds: options.bounds ?? {
      left: 0,
      top: 0,
      right: options.width ?? 2,
      bottom: options.height ?? 1
    }
  }
  const imaging = {
    async getPixels(request) {
      const index = requests.length
      requests.push(JSON.parse(JSON.stringify(request)))
      const frame = options.frame?.(request, index) ?? {}
      const components = options.components ?? 4
      let data
      return {
        sourceBounds: { ...snapshot.bounds },
        level: 0,
        ...frame.result,
        imageData: {
          width: request.targetSize.width,
          height: request.targetSize.height,
          components,
          componentSize: 8,
          pixelFormat: components === 4 ? 'RGBA' : 'RGB',
          colorSpace: 'RGB',
          colorProfile: 'sRGB IEC61966-2.1',
          hasAlpha: components === 4,
          type: 'image/uncompressed',
          async getData(settings) {
            reads.push({ index, settings: JSON.parse(JSON.stringify(settings)) })
            data =
              options.pixels?.(request.targetSize, index) ??
              new Uint8Array(request.targetSize.width * request.targetSize.height * components)
            return data
          },
          dispose() {
            disposals.push(index)
            options.onDispose?.(index, data)
          },
          ...frame.imageData
        }
      }
    }
  }
  return { imaging, requests, reads, disposals, snapshot }
}

test('Photoshop context uses the module-scoped public encoder, preserves alpha and does not store audit pixels', async () => {
  const { api, context } = loadPhotoshopContext()
  for (const name of [
    'Buffer',
    'TextEncoder',
    'TextDecoder',
    'btoa',
    'atob',
    'document',
    'OffscreenCanvas'
  ])
    assert.equal(typeof context[name], 'undefined')
  for (const components of [3, 4]) {
    const data =
      components === 4
        ? new Uint8Array([91, 82, 73, 0, 64, 55, 46, 127])
        : new Uint8Array([91, 82, 73, 64, 55, 46])
    const expected = context.MagicPotContextPngV1.encode(2, 1, data, components)
    const fixture = photoshopContextFixture({
      components,
      pixels: () => data,
      onDispose: (_index, nativeData) => nativeData?.fill(255)
    })
    const image = await api.capturePhotoshopContextImage(
      fixture.imaging,
      7,
      9,
      'a'.repeat(32),
      fixture.snapshot
    )
    const bytes = Buffer.from(image.bytesBase64, 'base64')
    assert.deepEqual(
      bytes,
      Buffer.from(expected),
      'native disposal cannot corrupt owned pixels or alpha'
    )
    assert.deepEqual(JSON.parse(JSON.stringify(image)), {
      version: 1,
      kind: 'host-context-image',
      captureId: 'a'.repeat(32),
      targetId: '9',
      mimeType: 'image/png',
      width: 2,
      height: 1,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytesBase64: bytes.toString('base64')
    })
    assert.equal(Object.isFrozen(image), true)
    assert.deepEqual(
      fixture.requests,
      [{ width: 2, height: 1 }].map((targetSize) => ({
        documentID: 7,
        layerID: 9,
        historyStateID: 11,
        sourceBounds: { left: 0, top: 0, right: 2, bottom: 1 },
        targetSize,
        colorSpace: 'RGB',
        colorProfile: 'sRGB IEC61966-2.1',
        componentSize: 8,
        applyAlpha: false
      }))
    )
    assert.deepEqual(fixture.reads, [{ index: 0, settings: { chunky: true } }])
    assert.deepEqual(fixture.disposals, [0])
    const point = { sha256: image.sha256, width: image.width, height: image.height }
    assert.equal(
      context.MagicPotPixelAuditV1.compare([
        { targetId: image.targetId, baseline: point, current: point }
      ])[0].status,
      'unavailable',
      'context capture must not remember pixels in the execution cache'
    )
  }
})

test('Photoshop context needs only the public encoder and never accesses the execution pixel cache', async () => {
  const { api, context } = load(false)
  context.MagicPotContextPngV1 = loadPhotoshopContext().context.MagicPotContextPngV1
  context.MagicPotPixelAuditV1 = new Proxy(
    {},
    {
      get() {
        assert.fail('context capture must not access execution pixel-audit cache')
      }
    }
  )
  const fixture = photoshopContextFixture()
  const image = await api.capturePhotoshopContextImage(
    fixture.imaging,
    7,
    9,
    'a'.repeat(32),
    fixture.snapshot
  )
  assert.equal(image.width, 2)
  assert.equal(image.height, 1)
  assert.equal(context.MagicPotPixelAuditBundle, undefined)
  assert.deepEqual(fixture.disposals, [0])
})

test('Photoshop context uses real PNG compression and descending, proportional native bounds', async () => {
  for (const [width, height] of [
    [512, 256],
    [256, 512]
  ]) {
    const { api } = loadPhotoshopContext()
    const fixture = photoshopContextFixture({
      width,
      height,
      pixels: (size) => {
        let state = 12345
        return Uint8Array.from({ length: size.width * size.height * 4 }, () => {
          state ^= state << 13
          state ^= state >>> 17
          state ^= state << 5
          return state & 255
        })
      }
    })
    const image = await api.capturePhotoshopContextImage(
      fixture.imaging,
      7,
      9,
      'a'.repeat(32),
      fixture.snapshot
    )
    assert.deepEqual(
      fixture.requests.map((request) => request.targetSize),
      [
        ...[256, 128, 64].map((edge) => ({
          width: width > height ? edge : edge / 2,
          height: width > height ? edge / 2 : edge
        }))
      ]
    )
    assert.equal(Math.max(image.width, image.height), 64)
    assert.ok(image.sizeBytes <= 24576)
    assert.equal(Buffer.from(image.bytesBase64, 'base64').length, image.sizeBytes)
    assert.equal(fixture.reads.length, 3)
    assert.deepEqual(fixture.disposals, [0, 1, 2])
    assert.ok(
      fixture.requests.every(
        (request) =>
          request.historyStateID === 11 &&
          JSON.stringify(request.sourceBounds) === JSON.stringify(fixture.snapshot.bounds)
      )
    )
    assert.ok(
      fixture.requests.every(
        (request) => request.targetSize.width <= 256 && request.targetSize.height <= 256
      )
    )
  }
})

test('Photoshop context preserves odd negative DOM geometry across supported pyramid covers', async () => {
  const { api } = loadPhotoshopContext()
  const bounds = { left: -7, top: -3, right: 504, bottom: 254 }
  for (const level of [0, 1, 2, 3, 4]) {
    const scale = 2 ** level
    const valid = photoshopContextFixture({
      bounds,
      frame: () => ({
        result: {
          sourceBounds: {
            left: Math.floor(bounds.left / scale),
            top: Math.floor(bounds.top / scale),
            right: Math.ceil(bounds.right / scale),
            bottom: Math.ceil(bounds.bottom / scale)
          },
          level
        }
      })
    })
    const image = await api.capturePhotoshopContextImage(
      valid.imaging,
      7,
      9,
      'a'.repeat(32),
      valid.snapshot
    )
    assert.equal(image.width, 256)
    assert.equal(
      image.height,
      129,
      'aspect ratio comes from precise DOM bounds, not the pyramid cover'
    )
    assert.deepEqual(valid.requests[0].sourceBounds, bounds)
    assert.equal(valid.requests[0].historyStateID, 11)
    assert.deepEqual(valid.disposals, [0])
  }
})

test('Photoshop context pins history and exact bounds before awaits and isolates every native request object', async () => {
  const { api } = loadPhotoshopContext()
  const bounds = { left: -7, top: -3, right: 504, bottom: 254 }
  const snapshot = { historyStateId: 19, bounds: { ...bounds } }
  const requests = []
  const sources = []
  const targets = []
  const disposals = []
  let release
  const imaging = {
    async getPixels(request) {
      const index = requests.length
      requests.push(JSON.parse(JSON.stringify(request)))
      sources.push(request.sourceBounds)
      targets.push(request.targetSize)
      const size = { ...request.targetSize }
      request.sourceBounds.left = 100000
      request.targetSize.width = 100000
      if (index === 0)
        await new Promise((resolve) => {
          release = resolve
        })
      const level = index + 1
      const scale = 2 ** level
      return {
        sourceBounds: {
          left: Math.floor(bounds.left / scale),
          top: Math.floor(bounds.top / scale),
          right: Math.ceil(bounds.right / scale),
          bottom: Math.ceil(bounds.bottom / scale)
        },
        level,
        imageData: {
          ...size,
          components: 4,
          componentSize: 8,
          pixelFormat: 'RGBA',
          colorSpace: 'RGB',
          colorProfile: 'sRGB IEC61966-2.1',
          async getData() {
            let state = 12345
            return Uint8Array.from({ length: size.width * size.height * 4 }, () => {
              state ^= state << 13
              state ^= state >>> 17
              state ^= state << 5
              return state & 255
            })
          },
          dispose() {
            disposals.push(index)
          }
        }
      }
    }
  }
  const pending = api.capturePhotoshopContextImage(imaging, 7, 9, 'a'.repeat(32), snapshot)
  snapshot.historyStateId = 999
  snapshot.bounds.left = 200000
  snapshot.bounds = { left: 0, top: 0, right: 1, bottom: 1 }
  release()
  const image = await pending
  assert.equal(image.width, 64)
  assert.equal(image.height, 32)
  assert.deepEqual(
    requests.map((request) => request.targetSize),
    [
      { width: 256, height: 129 },
      { width: 128, height: 64 },
      { width: 64, height: 32 }
    ]
  )
  assert.ok(requests.every((request) => request.historyStateID === 19))
  for (const request of requests) assert.deepEqual(request.sourceBounds, bounds)
  assert.equal(new Set(sources).size, 3)
  assert.equal(new Set(targets).size, 3)
  assert.deepEqual(disposals, [0, 1, 2])
})

test('Photoshop context rejects crop, translation and excess coverage instead of tolerating geometry changes', async () => {
  const { api } = loadPhotoshopContext()
  const bounds = { left: -7, top: -3, right: 504, bottom: 254 }
  for (const sourceBounds of [
    { left: -1, top: -1, right: 126, bottom: 64 },
    { left: -2, top: 0, right: 126, bottom: 64 },
    { left: -2, top: -1, right: 125, bottom: 64 },
    { left: -2, top: -1, right: 126, bottom: 63 },
    { left: -1, top: -1, right: 127, bottom: 64 },
    { left: -3, top: -1, right: 126, bottom: 64 },
    { left: -2, top: -1, right: 127, bottom: 64 },
    { left: -2, top: -2, right: 126, bottom: 64 },
    { left: -2, top: -1, right: 126, bottom: 65 }
  ]) {
    const invalid = photoshopContextFixture({
      bounds,
      frame: () => ({ result: { sourceBounds, level: 2 } })
    })
    await assert.rejects(
      () =>
        api.capturePhotoshopContextImage(invalid.imaging, 7, 9, 'a'.repeat(32), invalid.snapshot),
      /VISUAL_EVIDENCE_UNAVAILABLE/
    )
    assert.deepEqual(
      invalid.requests.map((request) => request.targetSize),
      [{ width: 256, height: 129 }]
    )
    assert.deepEqual(invalid.reads, [])
    assert.deepEqual(invalid.disposals, [0])
  }
})

test('Photoshop context refuses unknown geometry and invalid native format while disposing every acquired image', async () => {
  const { api } = loadPhotoshopContext()
  for (const result of [
    { sourceBounds: undefined },
    { level: undefined },
    { level: -1 },
    { level: 1.5 },
    { level: 31 },
    { sourceBounds: { left: 0, top: 0, right: 0, bottom: 1 } },
    { sourceBounds: { left: 0, top: 0, right: Infinity, bottom: 1 } },
    { sourceBounds: { left: 0, top: 0, right: 2, bottom: 1, width: 9 } },
    {
      sourceBounds: {
        left: Number.MAX_SAFE_INTEGER,
        top: 0,
        right: Number.MAX_SAFE_INTEGER + 1,
        bottom: 1
      }
    }
  ]) {
    const fixture = photoshopContextFixture({ frame: () => ({ result }) })
    await assert.rejects(
      () =>
        api.capturePhotoshopContextImage(fixture.imaging, 7, 9, 'a'.repeat(32), fixture.snapshot),
      /VISUAL_EVIDENCE_UNAVAILABLE/
    )
    assert.deepEqual(fixture.reads, [])
    assert.deepEqual(fixture.disposals, [0])
  }
  for (const imageData of [
    { width: 257 },
    { width: 1 },
    { height: 0 },
    { height: 2 },
    { components: 2 },
    { componentSize: 16 },
    { pixelFormat: 'ARGB' },
    { colorSpace: 'CMYK' },
    { colorProfile: 'Adobe RGB (1998)' },
    { colorProfile: undefined },
    { hasAlpha: false },
    { type: 'image/jpeg' },
    { getData: undefined }
  ]) {
    const fixture = photoshopContextFixture({
      frame: () => ({ imageData })
    })
    await assert.rejects(
      () =>
        api.capturePhotoshopContextImage(fixture.imaging, 7, 9, 'a'.repeat(32), fixture.snapshot),
      /VISUAL_EVIDENCE_UNAVAILABLE/
    )
    assert.deepEqual(fixture.reads, [])
    assert.deepEqual(fixture.disposals, [0])
  }
})

test('Photoshop context releases native buffers on read failure, invalid bytes, encode failure and disposal failure', async () => {
  for (const pixels of [
    () => {
      throw new Error('Private native pixel failure')
    },
    () => new Uint8Array(7),
    () => new Uint16Array(4),
    () => new Uint8Array(9),
    () => new ArrayBuffer(8)
  ]) {
    const { api } = loadPhotoshopContext()
    const fixture = photoshopContextFixture({ pixels })
    await assert.rejects(
      () =>
        api.capturePhotoshopContextImage(fixture.imaging, 7, 9, 'a'.repeat(32), fixture.snapshot),
      /^Error: VISUAL_EVIDENCE_UNAVAILABLE$/
    )
    assert.deepEqual(fixture.disposals, [0])
  }
  for (const failedAt of [0, 1]) {
    const { api } = loadPhotoshopContext()
    const fixture = photoshopContextFixture({
      width: 512,
      height: 512,
      pixels: (size) => {
        let state = 12345
        return Uint8Array.from({ length: size.width * size.height * 4 }, () => {
          state ^= state << 13
          state ^= state >>> 17
          state ^= state << 5
          return state & 255
        })
      },
      frame: (_request, index) => {
        if (index === failedAt) throw new Error('Private native capture failure')
        return {}
      }
    })
    await assert.rejects(
      () =>
        api.capturePhotoshopContextImage(fixture.imaging, 7, 9, 'a'.repeat(32), fixture.snapshot),
      /^Error: VISUAL_EVIDENCE_UNAVAILABLE$/
    )
    assert.deepEqual(fixture.disposals, failedAt === 0 ? [] : [0])
  }
  const { api, context } = load(false)
  const fixture = photoshopContextFixture()
  context.MagicPotContextPngV1 = {
    encode: () => {
      throw new Error('Private encoder failure')
    }
  }
  await assert.rejects(
    () => api.capturePhotoshopContextImage(fixture.imaging, 7, 9, 'a'.repeat(32), fixture.snapshot),
    /^Error: VISUAL_EVIDENCE_UNAVAILABLE$/
  )
  assert.deepEqual(fixture.disposals, [0])
  const disposal = photoshopContextFixture({
    onDispose: () => {
      throw new Error('Private dispose failure')
    }
  })
  await assert.rejects(
    () =>
      loadPhotoshopContext().api.capturePhotoshopContextImage(
        disposal.imaging,
        7,
        9,
        'a'.repeat(32),
        disposal.snapshot
      ),
    /^Error: VISUAL_EVIDENCE_UNAVAILABLE$/
  )
  assert.deepEqual(disposal.disposals, [0])
})

test('Photoshop context requires a validated native history and exact bounds before capture', async () => {
  const { api } = loadPhotoshopContext()
  const fixture = photoshopContextFixture()
  const bounds = { left: 0, top: 0, right: 2, bottom: 1 }
  for (const snapshot of [
    undefined,
    null,
    {},
    { historyStateId: 0, bounds },
    { historyStateId: -1, bounds },
    { historyStateId: 1.5, bounds },
    { historyStateId: '11', bounds },
    { historyStateId: 11 },
    { historyStateId: 11, bounds: { ...bounds, left: -0.5 } },
    { historyStateId: 11, bounds: { ...bounds, right: NaN } },
    { historyStateId: 11, bounds: { ...bounds, right: 0 } },
    { historyStateId: 11, bounds: { ...bounds, left: -1, right: Number.MAX_SAFE_INTEGER } },
    { historyStateId: 11, bounds: { left: 0, top: 0, width: 2, height: 1 } }
  ])
    await assert.rejects(
      () => api.capturePhotoshopContextImage(fixture.imaging, 7, 9, 'a'.repeat(32), snapshot),
      /VISUAL_EVIDENCE_UNAVAILABLE/
    )
  assert.deepEqual(fixture.requests, [])
})

test('Photoshop context validates identities before native calls and does not upscale tiny layers', async () => {
  const { api } = loadPhotoshopContext()
  const fixture = photoshopContextFixture({ width: 1, height: 1 })
  for (const values of [
    [0, 9, 'a'.repeat(32)],
    [-1, 9, 'a'.repeat(32)],
    [1.5, 9, 'a'.repeat(32)],
    [7, 0, 'a'.repeat(32)],
    [7, '9', 'a'.repeat(32)],
    [7, 9, 'A'.repeat(32)],
    [7, 9, 'a'.repeat(31)],
    [7, 9, 'a'.repeat(32) + '\n']
  ])
    await assert.rejects(
      () => api.capturePhotoshopContextImage(fixture.imaging, ...values, fixture.snapshot),
      /VISUAL_EVIDENCE_UNAVAILABLE/
    )
  assert.deepEqual(fixture.requests, [])
  const image = await api.capturePhotoshopContextImage(
    fixture.imaging,
    7,
    9,
    'a'.repeat(32),
    fixture.snapshot
  )
  assert.equal(image.width, 1)
  assert.equal(image.height, 1)
  assert.deepEqual(
    fixture.requests.map((request) => request.targetSize),
    [{ width: 1, height: 1 }]
  )
  assert.deepEqual(fixture.disposals, [0])
  const missingEncoder = load(false)
  await assert.rejects(
    () =>
      missingEncoder.api.capturePhotoshopContextImage(
        fixture.imaging,
        7,
        9,
        'a'.repeat(32),
        fixture.snapshot
      ),
    /VISUAL_EVIDENCE_UNAVAILABLE/
  )
  assert.equal(fixture.requests.length, 1)
})

const png = (width, height, tail = []) => {
  const bytes = new Uint8Array(24 + tail.length)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8)
  new DataView(bytes.buffer).setUint32(16, width, false)
  new DataView(bytes.buffer).setUint32(20, height, false)
  bytes.set(tail, 24)
  return bytes
}

const imagePng = (width, height, extra = 0) => {
  const chunk = (type, data) => {
    const output = Buffer.alloc(data.length + 12)
    output.writeUInt32BE(data.length)
    output.write(type, 4)
    output.set(data, 8)
    let crc = 0xffffffff
    for (const byte of output.subarray(4, -4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4)
    return output
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...(extra ? [chunk('tEXt', Buffer.from('Padding\0' + 'x'.repeat(extra)))] : []),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 4)))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

test('Figma context image is a canonical bounded PNG and raw-byte digest without browser or pixel-cache APIs', async () => {
  const { api, context } = load(false)
  const calls = []
  const bytes = imagePng(23, 11)
  context.MagicPotPixelAuditV1 = new Proxy(
    {},
    {
      get() {
        assert.fail('context images must never access execution pixel-audit cache')
      }
    }
  )
  assert.equal(typeof context.btoa, 'undefined')
  assert.equal(typeof context.atob, 'undefined')
  const result = await api.captureFigmaContextImage(
    {
      id: '1:2',
      width: 23,
      height: 11,
      exportAsync: async (options) => {
        calls.push(options)
        return bytes
      }
    },
    { captureId: 'a'.repeat(32), targetId: '1:2' }
  )
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    version: 1,
    kind: 'host-context-image',
    captureId: 'a'.repeat(32),
    targetId: '1:2',
    mimeType: 'image/png',
    width: 23,
    height: 11,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytesBase64: bytes.toString('base64')
  })
  assert.equal(Object.isFrozen(result), true)
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      format: 'PNG',
      constraint: { type: 'WIDTH', value: 23 },
      contentsOnly: true,
      colorProfile: 'SRGB'
    }
  ])
})

test('Figma context image explicitly downscales through bounded edges and rejects oversized final output', async () => {
  const { api } = load()
  const edges = []
  const result = await api.captureFigmaContextImage(
    {
      id: '1:2',
      width: 1024,
      height: 512,
      exportAsync: async ({ constraint }) => {
        edges.push(constraint.value)
        return imagePng(constraint.value, constraint.value / 2, constraint.value > 64 ? 24576 : 0)
      }
    },
    { captureId: 'b'.repeat(32), targetId: '1:2' }
  )
  assert.deepEqual(edges, [256, 128, 64])
  assert.equal(result.width, 64)
  assert.equal(result.height, 32)
  assert.ok(result.sizeBytes <= 24576)
  edges.length = 0
  await assert.rejects(
    () =>
      api.captureFigmaContextImage(
        {
          id: '1:2',
          width: 512,
          height: 1024,
          exportAsync: async ({ constraint }) => {
            assert.equal(constraint.type, 'HEIGHT')
            edges.push(constraint.value)
            return imagePng(constraint.value / 2, constraint.value, 24576)
          }
        },
        { captureId: 'b'.repeat(32), targetId: '1:2' }
      ),
    /VISUAL_EVIDENCE_UNAVAILABLE/
  )
  assert.deepEqual(edges, [256, 128, 64, 32])
})

test('Figma context image base64 remains canonical at every padding boundary through exactly 24 KiB', async () => {
  const { api } = load(false)
  for (const sizeBytes of [24574, 24575, 24576]) {
    const bytes = imagePng(8, 4, sizeBytes - imagePng(8, 4, 1).length + 1)
    assert.equal(bytes.length, sizeBytes)
    const image = await api.captureFigmaContextImage(
      {
        id: '1:2',
        width: 8,
        height: 4,
        exportAsync: async () => bytes
      },
      { captureId: 'b'.repeat(32), targetId: '1:2' }
    )
    assert.equal(image.bytesBase64, bytes.toString('base64'))
    assert.equal(image.bytesBase64.length, 32768)
    assert.equal(image.sizeBytes, sizeBytes)
  }
})

test('Figma context image refuses malformed PNG headers, invalid dimensions and mismatched native identities', async () => {
  const { api } = load()
  const identity = { captureId: 'c'.repeat(32), targetId: '1:2' }
  const good = imagePng(128, 64)
  const badSignature = Buffer.from(good)
  badSignature[0] = 0
  const badHeader = Buffer.from(good)
  badHeader.writeUInt32BE(12, 8)
  const badType = Buffer.from(good)
  badType.write('IDAT', 12)
  for (const output of [
    good.subarray(0, 24),
    badSignature,
    badHeader,
    badType,
    imagePng(0, 64),
    imagePng(257, 64)
  ]) {
    await assert.rejects(
      () =>
        api.captureFigmaContextImage(
          {
            id: '1:2',
            width: 512,
            height: 256,
            exportAsync: async () => output
          },
          identity
        ),
      /VISUAL_EVIDENCE_UNAVAILABLE/
    )
  }
  for (const invalid of [
    { ...identity, captureId: 'c'.repeat(32) + '\n' },
    { ...identity, targetId: 'other' }
  ]) {
    await assert.rejects(
      () =>
        api.captureFigmaContextImage(
          {
            id: '1:2',
            width: 128,
            height: 64,
            exportAsync: async () =>
              assert.fail('invalid capture identity must be rejected before export')
          },
          invalid
        ),
      /VISUAL_EVIDENCE_UNAVAILABLE/
    )
  }
  await assert.rejects(
    () =>
      api.captureFigmaContextImage(
        {
          id: '1:2',
          width: 8,
          height: 4,
          exportAsync: async () => imagePng(9, 4)
        },
        identity
      ),
    /VISUAL_EVIDENCE_UNAVAILABLE/
  )
  for (const length of [128, 129]) {
    const targetId = 'x'.repeat(length)
    let exported = false
    const capture = api.captureFigmaContextImage(
      {
        id: targetId,
        width: 8,
        height: 4,
        exportAsync: async () => {
          exported = true
          return imagePng(8, 4)
        }
      },
      { captureId: identity.captureId, targetId }
    )
    if (length === 128) assert.equal((await capture).targetId, targetId)
    else await assert.rejects(capture, /VISUAL_EVIDENCE_UNAVAILABLE/)
    assert.equal(exported, length === 128)
  }
})

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
