;(() => {
  const API_NAME = 'MagicPotVisualEvidenceV1'
  const MAX_DIMENSION = 512
  const MAX_BYTES = 4 * 1024 * 1024
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
  const ROUND_CONSTANTS = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ])

  const fail = () => {
    throw new Error('VISUAL_EVIDENCE_UNAVAILABLE')
  }
  const rotateRight = (value, bits) => (value >>> bits) | (value << (32 - bits))
  const bytesOf = (value) => {
    if (value instanceof Uint8Array)
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (ArrayBuffer.isView(value))
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    return fail()
  }
  const concat = (parts) => {
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
    if (!Number.isSafeInteger(total) || total < 1 || total > MAX_BYTES + 4096) return fail()
    const output = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      output.set(part, offset)
      offset += part.byteLength
    }
    return output
  }
  const sha256 = (input) => {
    const bytes = bytesOf(input)
    if (bytes.byteLength > MAX_BYTES + 4096) return fail()
    const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64
    const message = new Uint8Array(paddedLength)
    message.set(bytes)
    message[bytes.byteLength] = 0x80
    const bitLength = bytes.byteLength * 8
    const view = new DataView(message.buffer)
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
    view.setUint32(paddedLength - 4, bitLength >>> 0, false)
    const state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ])
    const words = new Uint32Array(64)
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1)
        words[index] = view.getUint32(offset + index * 4, false)
      for (let index = 16; index < 64; index += 1) {
        const previous15 = words[index - 15]
        const previous2 = words[index - 2]
        const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3)
        const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10)
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
      }
      let a = state[0]
      let b = state[1]
      let c = state[2]
      let d = state[3]
      let e = state[4]
      let f = state[5]
      let g = state[6]
      let h = state[7]
      for (let index = 0; index < 64; index += 1) {
        const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
        const choice = (e & f) ^ (~e & g)
        const temporary1 = (h + upperSigma1 + choice + ROUND_CONSTANTS[index] + words[index]) >>> 0
        const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
        const majority = (a & b) ^ (a & c) ^ (b & c)
        const temporary2 = (upperSigma0 + majority) >>> 0
        h = g
        g = f
        f = e
        e = (d + temporary1) >>> 0
        d = c
        c = b
        b = a
        a = (temporary1 + temporary2) >>> 0
      }
      state[0] = (state[0] + a) >>> 0
      state[1] = (state[1] + b) >>> 0
      state[2] = (state[2] + c) >>> 0
      state[3] = (state[3] + d) >>> 0
      state[4] = (state[4] + e) >>> 0
      state[5] = (state[5] + f) >>> 0
      state[6] = (state[6] + g) >>> 0
      state[7] = (state[7] + h) >>> 0
    }
    return Array.from(state, (value) => value.toString(16).padStart(8, '0')).join('')
  }
  const hashWithMetadata = (domain, metadata, data) => {
    const encoder = new TextEncoder()
    const prefix = encoder.encode(`${domain}\u0000${JSON.stringify(metadata)}\u0000`)
    const bytes = bytesOf(data)
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) return fail()
    return sha256(concat([prefix, bytes]))
  }
  const point = (value) => {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isInteger(value.width) ||
      value.width < 1 ||
      value.width > MAX_DIMENSION ||
      !Number.isInteger(value.height) ||
      value.height < 1 ||
      value.height > MAX_DIMENSION
    )
      return fail()
    return Object.freeze({ sha256: value.sha256, width: value.width, height: value.height })
  }
  const combine = (targetId, beforeValue, afterValue) => {
    if (typeof targetId !== 'string' || targetId.length < 1 || targetId.length > 160) return fail()
    const before = point(beforeValue)
    const after = point(afterValue)
    return Object.freeze({
      targetId,
      before,
      after,
      changed:
        before.sha256 !== after.sha256 ||
        before.width !== after.width ||
        before.height !== after.height
    })
  }
  const parsePngSize = (bytes) => {
    if (bytes.byteLength < 24) return fail()
    for (let index = 0; index < PNG_SIGNATURE.length; index += 1)
      if (bytes[index] !== PNG_SIGNATURE[index]) return fail()
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52)
      return fail()
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(16, false)
    const height = view.getUint32(20, false)
    if (width < 1 || width > MAX_DIMENSION || height < 1 || height > MAX_DIMENSION) return fail()
    return { width, height }
  }
  const captureFigmaNode = async (node) => {
    const pixelCache = globalThis.MagicPotPixelAuditV1
    const pixelEpoch = pixelCache?.epoch()
    if (
      !node ||
      typeof node.exportAsync !== 'function' ||
      typeof node.width !== 'number' ||
      !Number.isFinite(node.width) ||
      node.width <= 0 ||
      typeof node.height !== 'number' ||
      !Number.isFinite(node.height) ||
      node.height <= 0
    )
      return fail()
    const dominant = node.width >= node.height ? 'WIDTH' : 'HEIGHT'
    const source = dominant === 'WIDTH' ? node.width : node.height
    const value = Math.max(1, Math.min(MAX_DIMENSION, Math.round(source)))
    const bytes = bytesOf(
      await node.exportAsync({
        format: 'PNG',
        constraint: { type: dominant, value },
        contentsOnly: true,
        colorProfile: 'SRGB'
      })
    )
    if (bytes.byteLength < 24 || bytes.byteLength > MAX_BYTES) return fail()
    const size = parsePngSize(bytes)
    const result = Object.freeze({
      sha256: hashWithMetadata('magicpot-figplugin-figma-png-v1', size, bytes),
      width: size.width,
      height: size.height
    })
    // Optional pixel decoding must not fabricate a comparison when the PNG is unsupported.
    try {
      pixelCache?.rememberPng(result, bytes, pixelEpoch)
    } catch {}
    return result
  }
  const capturePhotoshopLayer = async (imaging, documentId, layerId) => {
    const pixelCache = globalThis.MagicPotPixelAuditV1
    const pixelEpoch = pixelCache?.epoch()
    if (
      !imaging ||
      typeof imaging.getPixels !== 'function' ||
      !Number.isSafeInteger(documentId) ||
      documentId <= 0 ||
      !Number.isSafeInteger(layerId) ||
      layerId <= 0
    )
      return fail()
    const result = await imaging.getPixels({
      documentID: documentId,
      layerID: layerId,
      targetSize: { width: MAX_DIMENSION, height: MAX_DIMENSION },
      colorSpace: 'RGB',
      colorProfile: 'sRGB IEC61966-2.1',
      componentSize: 8,
      applyAlpha: false
    })
    const imageData = result && result.imageData
    if (!imageData) return fail()
    try {
      const metadata = {
        width: imageData.width,
        height: imageData.height,
        components: imageData.components,
        componentSize: imageData.componentSize,
        pixelFormat: imageData.pixelFormat,
        colorSpace: imageData.colorSpace
      }
      if (
        !Number.isInteger(metadata.width) ||
        metadata.width < 1 ||
        metadata.width > MAX_DIMENSION ||
        !Number.isInteger(metadata.height) ||
        metadata.height < 1 ||
        metadata.height > MAX_DIMENSION ||
        !Number.isInteger(metadata.components) ||
        metadata.components < 1 ||
        metadata.components > 4 ||
        metadata.componentSize !== 8 ||
        typeof metadata.pixelFormat !== 'string' ||
        metadata.pixelFormat.length > 32 ||
        typeof metadata.colorSpace !== 'string' ||
        metadata.colorSpace.length > 32 ||
        typeof imageData.getData !== 'function'
      )
        return fail()
      const data = bytesOf(await imageData.getData({ chunky: true }))
      if (data.byteLength !== metadata.width * metadata.height * metadata.components) return fail()
      const result = Object.freeze({
        sha256: hashWithMetadata(
          'magicpot-figplugin-photoshop-pixels-v1',
          { ...metadata, colorProfile: imageData.colorProfile ?? '' },
          data
        ),
        width: metadata.width,
        height: metadata.height
      })
      if (
        metadata.colorSpace === 'RGB' &&
        imageData.colorProfile === 'sRGB IEC61966-2.1' &&
        ((metadata.components === 3 && metadata.pixelFormat === 'RGB') ||
          (metadata.components === 4 && metadata.pixelFormat === 'RGBA'))
      ) {
        try {
          pixelCache?.rememberPixels(result, data, metadata.components, pixelEpoch)
        } catch {}
      }
      return result
    } finally {
      if (typeof imageData.dispose === 'function') imageData.dispose()
    }
  }

  if (Object.prototype.hasOwnProperty.call(globalThis, API_NAME)) return
  Object.defineProperty(globalThis, API_NAME, {
    value: Object.freeze({
      captureFigmaNode,
      capturePhotoshopLayer,
      combine,
      sha256
    }),
    configurable: false,
    enumerable: false,
    writable: false
  })
})()
