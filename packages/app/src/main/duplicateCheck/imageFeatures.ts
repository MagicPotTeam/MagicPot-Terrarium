import { nativeImage } from 'electron'
import crypto from 'crypto'

export type BasicImageHashes = {
  sha256: string
  width: number
  height: number
  dHash: string
  pHash: string
}

export type BasicImageHashInput = {
  buffer: Buffer
  sourcePath?: string
  mimeType?: string
  name?: string
}

const D_HASH_WIDTH = 9
const D_HASH_HEIGHT = 8
const P_HASH_SIZE = 32
const P_HASH_LOW_FREQUENCY_SIZE = 8

const decodeImage = ({ buffer, sourcePath, mimeType, name }: BasicImageHashInput) => {
  const normalizedPath = sourcePath?.trim()
  if (normalizedPath) {
    const imageFromPath = nativeImage.createFromPath(normalizedPath)
    if (!imageFromPath.isEmpty()) {
      return imageFromPath
    }
  }

  const normalizedMimeType = mimeType?.trim()
  if (normalizedMimeType) {
    const imageFromDataUrl = nativeImage.createFromDataURL(
      `data:${normalizedMimeType};base64,${buffer.toString('base64')}`
    )
    if (!imageFromDataUrl.isEmpty()) {
      return imageFromDataUrl
    }
  }

  const imageFromBuffer = nativeImage.createFromBuffer(buffer)
  if (!imageFromBuffer.isEmpty()) {
    return imageFromBuffer
  }

  throw new Error(`Unsupported or invalid image payload${name ? `: ${name}` : ''}`)
}

const readImageBitmap = (
  input: BasicImageHashInput,
  width: number,
  height: number
): Float64Array => {
  const image = decodeImage(input)

  const resized = image.resize({ width, height, quality: 'good' })
  const bitmap = resized.toBitmap()
  const grayscale = new Float64Array(width * height)

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    const blue = bitmap[offset] ?? 0
    const green = bitmap[offset + 1] ?? 0
    const red = bitmap[offset + 2] ?? 0
    grayscale[index] = red * 0.299 + green * 0.587 + blue * 0.114
  }

  return grayscale
}

const getImageSize = (input: BasicImageHashInput): { width: number; height: number } => {
  const image = decodeImage(input)
  const size = image.getSize()
  if (!size.width || !size.height) {
    throw new Error('Image dimensions are unavailable')
  }

  return size
}

const bitsToHex = (bits: readonly number[]): string => {
  let value = 0n
  for (const bit of bits) {
    value = (value << 1n) | BigInt(bit ? 1 : 0)
  }
  return value.toString(16).padStart(Math.ceil(bits.length / 4), '0')
}

const computeDHash = (input: BasicImageHashInput): string => {
  const grayscale = readImageBitmap(input, D_HASH_WIDTH, D_HASH_HEIGHT)
  const bits: number[] = []

  for (let y = 0; y < D_HASH_HEIGHT; y += 1) {
    for (let x = 0; x < D_HASH_WIDTH - 1; x += 1) {
      const left = grayscale[y * D_HASH_WIDTH + x]
      const right = grayscale[y * D_HASH_WIDTH + x + 1]
      bits.push(left < right ? 1 : 0)
    }
  }

  return bitsToHex(bits)
}

const dct1d = (input: Float64Array): Float64Array => {
  const length = input.length
  const result = new Float64Array(length)

  for (let u = 0; u < length; u += 1) {
    let sum = 0
    for (let x = 0; x < length; x += 1) {
      sum += input[x] * Math.cos((Math.PI / length) * (x + 0.5) * u)
    }

    const coefficient = u === 0 ? Math.sqrt(1 / length) : Math.sqrt(2 / length)
    result[u] = coefficient * sum
  }

  return result
}

const computePHash = (input: BasicImageHashInput): string => {
  const grayscale = readImageBitmap(input, P_HASH_SIZE, P_HASH_SIZE)
  const rowDct = new Float64Array(P_HASH_SIZE * P_HASH_SIZE)

  for (let row = 0; row < P_HASH_SIZE; row += 1) {
    const rowValues = new Float64Array(P_HASH_SIZE)
    for (let col = 0; col < P_HASH_SIZE; col += 1) {
      rowValues[col] = grayscale[row * P_HASH_SIZE + col]
    }
    const transformedRow = dct1d(rowValues)
    rowDct.set(transformedRow, row * P_HASH_SIZE)
  }

  const transformed = new Float64Array(P_HASH_SIZE * P_HASH_SIZE)
  for (let col = 0; col < P_HASH_SIZE; col += 1) {
    const columnValues = new Float64Array(P_HASH_SIZE)
    for (let row = 0; row < P_HASH_SIZE; row += 1) {
      columnValues[row] = rowDct[row * P_HASH_SIZE + col]
    }
    const transformedColumn = dct1d(columnValues)
    for (let row = 0; row < P_HASH_SIZE; row += 1) {
      transformed[row * P_HASH_SIZE + col] = transformedColumn[row]
    }
  }

  const lowFrequency: number[] = []
  for (let row = 0; row < P_HASH_LOW_FREQUENCY_SIZE; row += 1) {
    for (let col = 0; col < P_HASH_LOW_FREQUENCY_SIZE; col += 1) {
      lowFrequency.push(transformed[row * P_HASH_SIZE + col])
    }
  }

  const dcComponent = lowFrequency[0] ?? 0
  const average =
    lowFrequency.length > 1
      ? lowFrequency.slice(1).reduce((sum, value) => sum + value, 0) / (lowFrequency.length - 1)
      : dcComponent

  return bitsToHex(lowFrequency.map((value) => (value >= average ? 1 : 0)))
}

export const computeSha256 = (buffer: Buffer): string =>
  crypto.createHash('sha256').update(buffer).digest('hex')

export const computeBasicImageHashes = (input: BasicImageHashInput): BasicImageHashes => {
  const { width, height } = getImageSize(input)
  return {
    sha256: computeSha256(input.buffer),
    width,
    height,
    dHash: computeDHash(input),
    pHash: computePHash(input)
  }
}

const popCountLookup = new Uint8Array(256).map((_, value) => {
  let count = 0
  let current = value
  while (current) {
    count += current & 1
    current >>= 1
  }
  return count
})

export const hammingDistanceFromHex = (left: string, right: string): number => {
  const maxLength = Math.max(left.length, right.length)
  const paddedLeft = left.padStart(maxLength, '0')
  const paddedRight = right.padStart(maxLength, '0')
  let distance = 0

  for (let index = 0; index < maxLength; index += 2) {
    const leftByte = Number.parseInt(paddedLeft.slice(index, index + 2).padEnd(2, '0'), 16)
    const rightByte = Number.parseInt(paddedRight.slice(index, index + 2).padEnd(2, '0'), 16)
    distance += popCountLookup[(leftByte ^ rightByte) & 0xff] ?? 0
  }

  return distance
}
