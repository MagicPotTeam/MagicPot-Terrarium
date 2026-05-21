const getCryptoSource = (): Crypto => {
  const cryptoSource = globalThis.crypto
  if (!cryptoSource || typeof cryptoSource.getRandomValues !== 'function') {
    throw new Error('Secure random generator is unavailable')
  }
  return cryptoSource
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export function createSecureIdSegment(byteLength = 6): string {
  const cryptoSource = getCryptoSource()
  const randomUUID = (cryptoSource as Crypto & { randomUUID?: () => string }).randomUUID

  if (typeof randomUUID === 'function') {
    return randomUUID
      .call(cryptoSource)
      .replace(/-/g, '')
      .slice(0, byteLength * 2)
  }

  const bytes = new Uint8Array(byteLength)
  cryptoSource.getRandomValues(bytes)
  return bytesToHex(bytes)
}

export function createTimestampedSecureId(prefix: string): string {
  return `${prefix}-${Date.now()}-${createSecureIdSegment()}`
}

export function createSecureRandomUint32(): number {
  const values = new Uint32Array(1)
  getCryptoSource().getRandomValues(values)
  return values[0]
}
