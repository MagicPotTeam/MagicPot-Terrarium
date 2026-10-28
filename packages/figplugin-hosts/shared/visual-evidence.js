;(() => {
  const API_NAME = 'MagicPotVisualEvidenceV1'
  const MAX_DIMENSION = 512
  const MAX_BYTES = 4 * 1024 * 1024
  const CONTEXT_IMAGE_MAX_BYTES = 24 * 1024
  const CONTEXT_IMAGE_EDGES = Object.freeze([256, 128, 64, 32])
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
  const sha256Bounded = (input, maxBytes) => {
    const bytes = bytesOf(input)
    if (bytes.byteLength > maxBytes) return fail()
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
  const sha256 = (input) => sha256Bounded(input, MAX_BYTES + 4096)
  const sha256SessionAsset = (input) => sha256Bounded(input, 8 * 1024 * 1024)
  const sha256PixelBuffer = (input) => sha256Bounded(input, 64 * 1024 * 1024)
  // Photoshop UXP does not expose the browser TextEncoder API. Keep the byte
  // contract identical (including replacement of lone UTF-16 surrogates), without
  // installing globals or weakening the existing hash/journal size limits.
  const encodeUtf8 = (text) => {
    if (typeof text !== 'string' || text.length > 65536) return fail()
    const output = new Uint8Array(text.length * 3)
    let offset = 0
    for (const char of text) {
      let point = char.codePointAt(0)
      if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd
      if (point <= 0x7f) output[offset++] = point
      else if (point <= 0x7ff) {
        output[offset++] = 0xc0 | (point >>> 6)
        output[offset++] = 0x80 | (point & 0x3f)
      } else if (point <= 0xffff) {
        output[offset++] = 0xe0 | (point >>> 12)
        output[offset++] = 0x80 | ((point >>> 6) & 0x3f)
        output[offset++] = 0x80 | (point & 0x3f)
      } else {
        output[offset++] = 0xf0 | (point >>> 18)
        output[offset++] = 0x80 | ((point >>> 12) & 0x3f)
        output[offset++] = 0x80 | ((point >>> 6) & 0x3f)
        output[offset++] = 0x80 | (point & 0x3f)
      }
    }
    return output.subarray(0, offset)
  }
  const hashWithMetadata = (domain, metadata, data) => {
    const prefix = encodeUtf8(`${domain}\u0000${JSON.stringify(metadata)}\u0000`)
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
    } catch {
      // Unsupported pixel decoding leaves comparison unavailable, not identical.
    }
    return result
  }
  const contextImageBase64 = (bytes) => {
    if (bytes.byteLength < 1 || bytes.byteLength > CONTEXT_IMAGE_MAX_BYTES) return fail()
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let result = ''
    for (let offset = 0; offset < bytes.byteLength; offset += 3) {
      const first = bytes[offset]
      const second = bytes[offset + 1] ?? 0
      const third = bytes[offset + 2] ?? 0
      result += alphabet[first >>> 2] + alphabet[((first & 3) << 4) | (second >>> 4)]
      result += offset + 1 < bytes.byteLength ? alphabet[((second & 15) << 2) | (third >>> 6)] : '='
      result += offset + 2 < bytes.byteLength ? alphabet[third & 63] : '='
    }
    return result
  }
  // Consent-bound planning images never enter the separate execution pixel-audit cache.
  const captureFigmaContextImage = async (node, identity) => {
    const captureId = identity?.captureId
    const targetId = identity?.targetId
    if (
      !node ||
      typeof node.exportAsync !== 'function' ||
      typeof captureId !== 'string' ||
      !/^[a-f0-9]{32}$(?![\s\S])/.test(captureId) ||
      typeof targetId !== 'string' ||
      targetId.length < 1 ||
      targetId.length > 128 ||
      targetId !== node.id ||
      !Number.isFinite(node.width) ||
      node.width <= 0 ||
      !Number.isFinite(node.height) ||
      node.height <= 0
    )
      return fail()
    const sourceWidth = node.width
    const sourceHeight = node.height
    const dominant = sourceWidth >= sourceHeight ? 'WIDTH' : 'HEIGHT'
    const sourceEdge = Math.max(sourceWidth, sourceHeight)
    let previousEdge = null
    for (const limit of CONTEXT_IMAGE_EDGES) {
      const edge = Math.min(limit, sourceEdge)
      if (edge === previousEdge) continue
      previousEdge = edge
      const bytes = bytesOf(
        await node.exportAsync({
          format: 'PNG',
          constraint: { type: dominant, value: edge },
          contentsOnly: true,
          colorProfile: 'SRGB'
        })
      )
      if (
        node.id !== targetId ||
        node.width !== sourceWidth ||
        node.height !== sourceHeight ||
        bytes.byteLength < 33 ||
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false) !== 13
      )
        return fail()
      const size = parsePngSize(bytes)
      if (
        size.width > limit ||
        size.height > limit ||
        size.width > Math.ceil(sourceWidth) ||
        size.height > Math.ceil(sourceHeight)
      )
        return fail()
      if (bytes.byteLength > CONTEXT_IMAGE_MAX_BYTES) continue
      return Object.freeze({
        version: 1,
        kind: 'host-context-image',
        captureId,
        targetId,
        mimeType: 'image/png',
        width: size.width,
        height: size.height,
        sizeBytes: bytes.byteLength,
        sha256: sha256(bytes),
        bytesBase64: contextImageBase64(bytes)
      })
    }
    return fail()
  }
  const photoshopContextBounds = (bounds) => {
    if (!bounds) return fail()
    const left = bounds.left
    const top = bounds.top
    const right = bounds.right ?? left + bounds.width
    const bottom = bounds.bottom ?? top + bounds.height
    if (
      ![left, top, right, bottom].every(Number.isSafeInteger) ||
      right <= left ||
      bottom <= top ||
      !Number.isSafeInteger(right - left) ||
      !Number.isSafeInteger(bottom - top) ||
      (bounds.width !== undefined && bounds.width !== right - left) ||
      (bounds.height !== undefined && bounds.height !== bottom - top)
    )
      return fail()
    return { left, top, right, bottom }
  }
  const checkPhotoshopContextGeometry = (result, sourceBounds) => {
    const level = result?.level
    if (!Number.isInteger(level) || level < 0 || level > 30) return fail()
    const bounds = photoshopContextBounds(result.sourceBounds)
    const scale = 2 ** level
    // Adobe defines the pyramid coordinate system, but not a rounding guarantee. We
    // support only the smallest integer grid rectangle covering the fixed native ROI.
    if (
      bounds.left !== Math.floor(sourceBounds.left / scale) ||
      bounds.top !== Math.floor(sourceBounds.top / scale) ||
      bounds.right !== Math.ceil(sourceBounds.right / scale) ||
      bounds.bottom !== Math.ceil(sourceBounds.bottom / scale)
    )
      return fail()
  }
  const capturePhotoshopContextImage = async (
    imaging,
    documentId,
    layerId,
    captureId,
    snapshot
  ) => {
    const encode = globalThis.MagicPotContextPngV1?.encode
    const historyStateId = snapshot?.historyStateId
    const nativeBounds = snapshot?.bounds
    const sourceBounds = photoshopContextBounds({
      left: nativeBounds?.left,
      top: nativeBounds?.top,
      right: nativeBounds?.right,
      bottom: nativeBounds?.bottom
    })
    if (
      !imaging ||
      typeof imaging.getPixels !== 'function' ||
      typeof encode !== 'function' ||
      !Number.isSafeInteger(documentId) ||
      documentId <= 0 ||
      !Number.isSafeInteger(layerId) ||
      layerId <= 0 ||
      !Number.isSafeInteger(historyStateId) ||
      historyStateId <= 0 ||
      typeof captureId !== 'string' ||
      !/^[a-f0-9]{32}$(?![\s\S])/.test(captureId)
    )
      return fail()
    const read = async (targetSize) => {
      const expectedWidth = targetSize.width
      const expectedHeight = targetSize.height
      const result = await imaging.getPixels({
        documentID: documentId,
        layerID: layerId,
        historyStateID: historyStateId,
        sourceBounds: { ...sourceBounds },
        targetSize: { width: expectedWidth, height: expectedHeight },
        colorSpace: 'RGB',
        colorProfile: 'sRGB IEC61966-2.1',
        componentSize: 8,
        applyAlpha: false
      })
      const imageData = result?.imageData
      if (!imageData) return fail()
      try {
        const width = imageData.width
        const height = imageData.height
        const components = imageData.components
        if (
          !Number.isInteger(width) ||
          width < 1 ||
          width !== expectedWidth ||
          !Number.isInteger(height) ||
          height < 1 ||
          height !== expectedHeight ||
          imageData.componentSize !== 8 ||
          imageData.colorSpace !== 'RGB' ||
          imageData.colorProfile !== 'sRGB IEC61966-2.1' ||
          !(
            (components === 3 && imageData.pixelFormat === 'RGB') ||
            (components === 4 && imageData.pixelFormat === 'RGBA')
          ) ||
          (imageData.hasAlpha !== undefined && imageData.hasAlpha !== (components === 4)) ||
          (imageData.type !== undefined && imageData.type !== 'image/uncompressed') ||
          typeof imageData.getData !== 'function' ||
          typeof imageData.dispose !== 'function'
        )
          return fail()
        checkPhotoshopContextGeometry(result, sourceBounds)
        const data = await imageData.getData({ chunky: true })
        if (!(data instanceof Uint8Array) || data.byteLength !== width * height * components)
          return fail()
        // Own the bytes before releasing the native image; do not retain an audit-cache entry.
        return { width, height, components, data: new Uint8Array(data) }
      } finally {
        if (typeof imageData.dispose === 'function') imageData.dispose()
      }
    }
    try {
      // Geometry and history are pinned before any await; coarse cache bounds never
      // determine the aspect ratio. Both target dimensions keep native allocation bounded.
      const sourceWidth = sourceBounds.right - sourceBounds.left
      const sourceHeight = sourceBounds.bottom - sourceBounds.top
      const sourceEdge = Math.max(sourceWidth, sourceHeight)
      let previousEdge = null
      for (const limit of CONTEXT_IMAGE_EDGES) {
        const edge = Math.min(limit, sourceEdge)
        if (edge === previousEdge) continue
        previousEdge = edge
        const targetSize = {
          width: Math.max(1, Math.round((sourceWidth / sourceEdge) * edge)),
          height: Math.max(1, Math.round((sourceHeight / sourceEdge) * edge))
        }
        const pixels = await read(targetSize)
        const bytes = encode(pixels.width, pixels.height, pixels.data, pixels.components)
        if (bytes === undefined) continue
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.byteLength < 57 ||
          bytes.byteLength > CONTEXT_IMAGE_MAX_BYTES
        )
          return fail()
        return Object.freeze({
          version: 1,
          kind: 'host-context-image',
          captureId,
          targetId: String(layerId),
          mimeType: 'image/png',
          width: pixels.width,
          height: pixels.height,
          sizeBytes: bytes.byteLength,
          sha256: sha256(bytes),
          bytesBase64: contextImageBase64(bytes)
        })
      }
    } catch {
      return fail()
    }
    return fail()
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
        } catch {
          // Hash evidence remains usable when the optional pixel cache refuses this frame.
        }
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
      captureFigmaContextImage,
      capturePhotoshopContextImage,
      capturePhotoshopLayer,
      combine,
      encodeUtf8,
      sha256,
      sha256SessionAsset,
      sha256PixelBuffer
    }),
    configurable: false,
    enumerable: false,
    writable: false
  })
})()
