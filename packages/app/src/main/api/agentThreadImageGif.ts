/** Bounded GIF framing inspection only, not LZW/pixel decoding or animation playback.
 * No native codec, path, network or authority is involved. Callers retain live checks.
 */
export const THREAD_IMAGE_GIF_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxEdge: 4096,
  maxCanvasPixels: 16 * 1024 * 1024,
  minFrames: 2,
  maxFrames: 16,
  maxTotalFramePixels: 64 * 1024 * 1024,
  maxStructuralBlocks: 16384
})
export type ThreadImageGifInfo = {
  width: number
  height: number
  frameCount: number
  totalFramePixels: number
}
export function inspectThreadImageGif(bytes: Buffer): ThreadImageGifInfo {
  const fail = (): never => {
    throw new Error('GIF output is malformed or exceeds the bounded animation limits.')
  }
  const limits = THREAD_IMAGE_GIF_LIMITS
  if (
    bytes.length < 14 ||
    bytes.length > limits.maxBytes ||
    !['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))
  )
    return fail()
  const width = bytes.readUInt16LE(6),
    height = bytes.readUInt16LE(8)
  const pixels = width * height
  if (
    !width ||
    !height ||
    width > limits.maxEdge ||
    height > limits.maxEdge ||
    pixels > limits.maxCanvasPixels
  )
    return fail()
  let offset = 13,
    blocks = 0,
    frameCount = 0
  const take = (size: number) => {
    if (offset + size > bytes.length) return fail()
    const start = offset
    offset += size
    return start
  }
  const block = () => {
    if (++blocks > limits.maxStructuralBlocks) return fail()
  }
  const table = (packed: number) => take(3 * 2 ** ((packed & 7) + 1))
  const globalTable = Boolean(bytes[10] & 0x80)
  if (globalTable) table(bytes[10])
  const subBlocks = () => {
    let length = 0
    for (;;) {
      block()
      const size = bytes[take(1)]
      if (!size) return length
      take(size)
      length += size
    }
  }
  while (offset < bytes.length) {
    block()
    const marker = bytes[take(1)]
    if (marker === 0x3b) {
      if (offset !== bytes.length || frameCount < limits.minFrames) return fail()
      return { width, height, frameCount, totalFramePixels: pixels * frameCount }
    }
    if (marker === 0x21) {
      const label = bytes[take(1)]
      if (label === 0xf9) {
        if (bytes[take(1)] !== 4) return fail()
        const start = take(4)
        if (bytes[start] & 0xe0 || ((bytes[start] >> 2) & 7) > 3 || bytes[take(1)] !== 0)
          return fail()
      } else if (label === 0xff) {
        if (bytes[take(1)] !== 11) return fail()
        take(11)
        subBlocks()
      } else if (label === 0xfe) {
        subBlocks()
      } else return fail() // Plain text/unknown rendering extensions are not admitted.
      continue
    }
    if (marker !== 0x2c) return fail()
    const start = take(9)
    const left = bytes.readUInt16LE(start),
      top = bytes.readUInt16LE(start + 2)
    const frameWidth = bytes.readUInt16LE(start + 4),
      frameHeight = bytes.readUInt16LE(start + 6)
    const packed = bytes[start + 8]
    if (
      !frameWidth ||
      !frameHeight ||
      left + frameWidth > width ||
      top + frameHeight > height ||
      packed & 0x18
    )
      return fail()
    frameCount++
    // Charge a full canvas per frame, including sparse rectangles/disposal surfaces.
    if (frameCount > limits.maxFrames || pixels * frameCount > limits.maxTotalFramePixels)
      return fail()
    if (packed & 0x80) table(packed)
    else if (!globalTable) return fail()
    const minCodeSize = bytes[take(1)]
    if (minCodeSize < 2 || minCodeSize > 8 || !subBlocks()) return fail()
  }
  return fail()
}
