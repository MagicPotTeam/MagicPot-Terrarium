import { Unzlib } from 'fflate'
import type { FigPluginPixelTarget } from './pixelAudit'

const MAX_DIMENSION = 512
const MAX_ENCODED_BYTES = 4 * 1024 * 1024
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const MAX_CACHE_FRAMES = 64
const TTL_MS = 24 * 60 * 60 * 1000
const fail = (): never => {
  throw new Error('PIXELS_UNAVAILABLE')
}
type Point = { sha256: string; width: number; height: number }
type Frame = Point & { rgba: Uint8Array; capturedAt: number }
const checkPoint = (value: Point): void => {
  if (
    !value ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > MAX_DIMENSION ||
    value.height > MAX_DIMENSION
  )
    fail()
}
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let value = n
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[n] = value >>> 0
}
const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff
  for (const value of data) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c,
    x = Math.abs(p - a),
    y = Math.abs(p - b),
    z = Math.abs(p - c)
  return x <= y && x <= z ? a : y <= z ? b : c
}
/** Strict, bounded PNG subset: 8-bit non-interlaced grayscale/RGB/indexed/GA/RGBA.
 * Other formats remain explicitly unavailable, never equated to identical pixels.
 */
function decodePng(input: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (
    !(input instanceof Uint8Array) ||
    input.length < 57 ||
    input.length > MAX_ENCODED_BYTES ||
    [137, 80, 78, 71, 13, 10, 26, 10].some((value, i) => input[i] !== value)
  )
    return fail()
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  let offset = 8,
    width = 0,
    height = 0,
    channels = 0,
    color = -1,
    ended = false,
    idatEnded = false
  let palette: Uint8Array | undefined, alpha: Uint8Array | undefined
  const parts: Uint8Array[] = []
  let compressedSize = 0,
    chunks = 0
  while (offset < input.length) {
    if (++chunks > 4096 || offset + 12 > input.length) return fail()
    const length = view.getUint32(offset, false)
    const end = offset + 12 + length
    if (end > input.length || length > MAX_ENCODED_BYTES) return fail()
    const type = String.fromCharCode(...input.subarray(offset + 4, offset + 8))
    const data = input.subarray(offset + 8, end - 4)
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      crc32(input.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4, false)
    )
      return fail()
    if (offset === 8 && type !== 'IHDR') return fail()
    if (type === 'IHDR') {
      if (width || length !== 13 || offset !== 8) return fail()
      width = view.getUint32(offset + 8, false)
      height = view.getUint32(offset + 12, false)
      color = data[9]
      channels =
        color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : color === 6 ? 4 : 0
      if (
        width < 1 ||
        width > MAX_DIMENSION ||
        height < 1 ||
        height > MAX_DIMENSION ||
        !channels ||
        data[8] !== 8 ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        return fail()
    } else if (type === 'PLTE') {
      if (
        palette ||
        parts.length ||
        !length ||
        length > 768 ||
        length % 3 ||
        color === 0 ||
        color === 4
      )
        return fail()
      palette = data
    } else if (type === 'tRNS') {
      if (
        alpha ||
        parts.length ||
        (color === 3 && (!palette || !length || length > palette.length / 3)) ||
        (color === 0 && length !== 2) ||
        (color === 2 && length !== 6) ||
        ![0, 2, 3].includes(color)
      )
        return fail()
      alpha = data
    } else if (type === 'IDAT') {
      if (idatEnded || (color === 3 && !palette)) return fail()
      compressedSize += length
      if (compressedSize > MAX_ENCODED_BYTES) return fail()
      parts.push(data)
    } else if (type === 'IEND') {
      if (length || !parts.length || end !== input.length) return fail()
      ended = true
    } else if (/^[A-Z]/.test(type) || ['acTL', 'fcTL', 'fdAT'].includes(type)) return fail()
    if (parts.length && type !== 'IDAT') idatEnded = true
    offset = end
  }
  if (!ended || compressedSize < 6) return fail()
  const compressed = new Uint8Array(compressedSize)
  offset = 0
  for (const part of parts) {
    compressed.set(part, offset)
    offset += part.length
  }
  if (
    (compressed[0] & 15) !== 8 ||
    compressed[0] >>> 4 > 7 ||
    ((compressed[0] << 8) + compressed[1]) % 31 ||
    compressed[1] & 32
  )
    return fail()
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  let written = 0,
    final = false
  const inflater = new Unzlib((chunk, last) => {
    if (written + chunk.length > raw.length) return fail()
    raw.set(chunk, written)
    written += chunk.length
    final = last
  })
  // Feed bounded chunks: a bomb cannot allocate its entire declared output in one inflate.
  for (let at = 0; at < compressed.length; at += 1024)
    inflater.push(
      compressed.subarray(at, Math.min(at + 1024, compressed.length)),
      at + 1024 >= compressed.length
    )
  if (!final || written !== raw.length) return fail()
  let adlerA = 1,
    adlerB = 0
  for (const value of raw) {
    adlerA = (adlerA + value) % 65521
    adlerB = (adlerB + adlerA) % 65521
  }
  if (
    ((adlerB << 16) | adlerA) >>> 0 !==
    new DataView(compressed.buffer).getUint32(compressed.length - 4, false)
  )
    return fail()
  const decoded = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter > 4) return fail()
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x
      const a = x >= channels ? decoded[index - channels] : 0
      const b = y ? decoded[index - stride] : 0
      const c = y && x >= channels ? decoded[index - stride - channels] : 0
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >>> 1
                : paeth(a, b, c)
      decoded[index] = (raw[y * (stride + 1) + x + 1] + predictor) & 255
    }
  }
  const rgba = new Uint8Array(width * height * 4)
  const transparent =
    alpha && color !== 3
      ? new DataView(alpha.buffer, alpha.byteOffset, alpha.byteLength)
      : undefined
  for (let pixel = 0; pixel < width * height; pixel++) {
    const at = pixel * channels,
      out = pixel * 4
    let r = 0,
      g = 0,
      b = 0,
      a = 255
    if (color === 3) {
      const index = decoded[at]
      if (!palette || index * 3 + 2 >= palette.length) return fail()
      r = palette[index * 3]
      g = palette[index * 3 + 1]
      b = palette[index * 3 + 2]
      a = alpha?.[index] ?? 255
    } else if (color === 0 || color === 4) {
      r = g = b = decoded[at]
      a = color === 4 ? decoded[at + 1] : transparent?.getUint16(0, false) === r ? 0 : 255
    } else {
      r = decoded[at]
      g = decoded[at + 1]
      b = decoded[at + 2]
      a =
        color === 6
          ? decoded[at + 3]
          : transparent &&
              transparent.getUint16(0, false) === r &&
              transparent.getUint16(2, false) === g &&
              transparent.getUint16(4, false) === b
            ? 0
            : 255
    }
    rgba[out] = a ? r : 0
    rgba[out + 1] = a ? g : 0
    rgba[out + 2] = a ? b : 0
    rgba[out + 3] = a
  }
  return { width, height, rgba }
}

export function createPixelAuditCache(
  options: { now?: () => number; maxFrames?: number; maxBytes?: number } = {}
) {
  const now = options.now ?? Date.now
  const maxFrames = options.maxFrames ?? MAX_CACHE_FRAMES
  const maxBytes = options.maxBytes ?? MAX_CACHE_BYTES
  if (
    !Number.isInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > MAX_CACHE_FRAMES ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 4 ||
    maxBytes > MAX_CACHE_BYTES
  )
    fail()
  const frames = new Map<string, Frame>()
  let size = 0,
    generation = 0
  const remove = (key: string) => {
    const frame = frames.get(key)
    if (frame) {
      size -= frame.rgba.byteLength
      frame.rgba.fill(0)
      frames.delete(key)
    }
  }
  const prune = () => {
    const at = now()
    for (const [key, frame] of frames)
      if (frame.capturedAt > at || frame.capturedAt + TTL_MS <= at) remove(key)
  }
  const store = (point: Point, rgba: Uint8Array, epoch: number) => {
    checkPoint(point)
    if (epoch !== generation) return
    if (rgba.byteLength !== point.width * point.height * 4 || rgba.byteLength > maxBytes)
      return fail()
    prune()
    remove(point.sha256)
    while (frames.size >= maxFrames || size + rgba.byteLength > maxBytes) {
      const first = frames.keys().next().value
      if (!first) return fail()
      remove(first)
    }
    // Own the buffer; native dispose or caller mutation cannot change retained evidence.
    const copy = new Uint8Array(rgba)
    for (let i = 0; i < copy.length; i += 4) if (copy[i + 3] === 0) copy.fill(0, i, i + 3)
    frames.set(point.sha256, { ...point, rgba: copy, capturedAt: now() })
    size += copy.byteLength
  }
  return Object.freeze({
    epoch: () => generation,
    clear: () => {
      generation++
      for (const key of frames.keys()) remove(key)
    },
    rememberPng(point: Point, bytes: Uint8Array, epoch = generation) {
      checkPoint(point)
      if (epoch !== generation) return
      const decoded = decodePng(bytes)
      if (decoded.width !== point.width || decoded.height !== point.height) return fail()
      store(point, decoded.rgba, epoch)
    },
    rememberPixels(point: Point, data: Uint8Array, components: number, epoch = generation) {
      checkPoint(point)
      if (epoch !== generation) return
      if (
        !(data instanceof Uint8Array) ||
        ![3, 4].includes(components) ||
        data.byteLength !== point.width * point.height * components
      )
        return fail()
      const rgba = new Uint8Array(point.width * point.height * 4)
      for (let i = 0; i < point.width * point.height; i++) {
        rgba[i * 4] = data[i * components]
        rgba[i * 4 + 1] = data[i * components + 1]
        rgba[i * 4 + 2] = data[i * components + 2]
        rgba[i * 4 + 3] = components === 4 ? data[i * components + 3] : 255
      }
      store(point, rgba, epoch)
    },
    compare(
      targets: Array<{ targetId: string; baseline: Point; current: Point }>
    ): FigPluginPixelTarget[] {
      if (
        !Array.isArray(targets) ||
        !targets.length ||
        targets.length > 20 ||
        new Set(targets.map((target) => target.targetId)).size !== targets.length
      )
        return fail()
      prune()
      return targets.map((target) => {
        if (
          typeof target.targetId !== 'string' ||
          !target.targetId.length ||
          target.targetId.length > 160
        )
          return fail()
        checkPoint(target.baseline)
        checkPoint(target.current)
        const common = { targetId: target.targetId }
        const before = frames.get(target.baseline.sha256),
          after = frames.get(target.current.sha256)
        // Missing pixels never pass, even when hashes happen to be equal.
        if (
          !before ||
          !after ||
          before.width !== target.baseline.width ||
          before.height !== target.baseline.height ||
          after.width !== target.current.width ||
          after.height !== target.current.height
        )
          return { ...common, status: 'unavailable' as const }
        if (before.width !== after.width || before.height !== after.height)
          return { ...common, status: 'dimensions-changed' as const }
        let changedPixels = 0,
          maxChannelDelta = 0,
          absoluteDelta = 0,
          left = after.width,
          top = after.height,
          right = -1,
          bottom = -1
        for (let pixel = 0; pixel < after.width * after.height; pixel++) {
          let changed = false
          for (let channel = 0; channel < 4; channel++) {
            const delta = Math.abs(
              before.rgba[pixel * 4 + channel] - after.rgba[pixel * 4 + channel]
            )
            absoluteDelta += delta
            maxChannelDelta = Math.max(maxChannelDelta, delta)
            changed ||= delta > 0
          }
          if (changed) {
            changedPixels++
            const x = pixel % after.width,
              y = Math.floor(pixel / after.width)
            left = Math.min(left, x)
            top = Math.min(top, y)
            right = Math.max(right, x)
            bottom = Math.max(bottom, y)
          }
        }
        return {
          ...common,
          status: 'compared' as const,
          pixelCount: after.width * after.height,
          changedPixels,
          maxChannelDelta,
          absoluteDelta,
          changedBounds: changedPixels
            ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
            : null
        }
      })
    }
  })
}
export const hostPixelAudit = createPixelAuditCache()
