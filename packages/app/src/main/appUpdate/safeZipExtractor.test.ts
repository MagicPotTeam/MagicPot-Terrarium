import { deflateRawSync } from 'node:zlib'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractZipSafely, SafeZipError } from './safeZipExtractor'

interface EntrySpec {
  name: string
  data?: Buffer | string
  method?: number
  flags?: number
  mode?: number
  centralName?: string
  centralCrc?: number
  centralSize?: number
}

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  CRC_TABLE[index] = value >>> 0
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function zip(specs: EntrySpec[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const spec of specs) {
    const name = Buffer.from(spec.name)
    const centralName = Buffer.from(spec.centralName ?? spec.name)
    const data = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data ?? '')
    const method = spec.method ?? 0
    const compressed = method === 8 ? deflateRawSync(data) : data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(spec.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(spec.mode === undefined ? 20 : (3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(spec.flags ?? 0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(spec.centralCrc ?? crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(spec.centralSize ?? data.length, 24)
    central.writeUInt16LE(centralName.length, 28)
    central.writeUInt32LE(
      spec.mode === undefined ? (spec.name.endsWith('/') ? 0x10 : 0) : (spec.mode << 16) >>> 0,
      38
    )
    central.writeUInt32LE(offset, 42)
    centrals.push(central, centralName)
    offset += local.length + name.length + compressed.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(specs.length, 8)
  end.writeUInt16LE(specs.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

async function fixture(buffer: Buffer): Promise<{ archive: string; staging: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'safe-zip-test-'))
  const archive = path.join(root, 'artifact.zip')
  await writeFile(archive, buffer)
  return { archive, staging: path.join(root, 'staging') }
}

async function rejection(specs: EntrySpec[], options = {}): Promise<SafeZipError> {
  const { archive, staging } = await fixture(zip(specs))
  try {
    await extractZipSafely({ archivePath: archive, stagingParent: staging, ...options })
    throw new Error('expected extraction to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(SafeZipError)
    return error as SafeZipError
  }
}

describe('extractZipSafely', () => {
  it('extracts STORE and DEFLATE entries into a unique staging directory', async () => {
    const { archive, staging } = await fixture(
      zip([
        { name: 'app/', mode: 0o040755 },
        { name: 'app/plain.txt', data: 'plain' },
        { name: 'app/compressed.txt', data: 'compressed', method: 8 }
      ])
    )
    const result = await extractZipSafely({ archivePath: archive, stagingParent: staging })
    expect(await readFile(path.join(result, 'app/plain.txt'), 'utf8')).toBe('plain')
    expect(await readFile(path.join(result, 'app/compressed.txt'), 'utf8')).toBe('compressed')
    expect(path.dirname(result)).toBe(staging)
  })

  it.each(['../escape', '/absolute', 'C:/drive', 'a\\b', 'a/../b', 'CON', 'name.'])(
    'rejects unsafe path %s',
    async (name) => {
      expect((await rejection([{ name, data: 'x' }])).code).toBe('INVALID_PATH')
    }
  )

  it('rejects duplicate, case-conflicting, and file/descendant paths', async () => {
    expect(
      (
        await rejection([
          { name: 'A', data: 'x' },
          { name: 'a', data: 'y' }
        ])
      ).code
    ).toBe('PATH_CONFLICT')
    expect(
      (
        await rejection([
          { name: 'a', data: 'x' },
          { name: 'a/b', data: 'y' }
        ])
      ).code
    ).toBe('PATH_CONFLICT')
  })

  it('rejects symlinks, encryption, and unsupported compression', async () => {
    expect((await rejection([{ name: 'link', mode: 0o120777 }])).code).toBe('UNSUPPORTED_FILE_TYPE')
    expect((await rejection([{ name: 'secret', flags: 1 }])).code).toBe('ENCRYPTED')
    expect((await rejection([{ name: 'descriptor', flags: 1 << 3 }])).code).toBe(
      'UNSUPPORTED_FLAGS'
    )
    expect((await rejection([{ name: 'legacy', method: 12 }])).code).toBe('UNSUPPORTED_COMPRESSION')
  })

  it('rejects CRC and declared-size mismatches before writing', async () => {
    expect((await rejection([{ name: 'bad', data: 'content', centralCrc: 1 }])).code).toBe(
      'MALFORMED'
    )
    expect((await rejection([{ name: 'bad', data: 'content', centralSize: 2 }])).code).toBe(
      'MALFORMED'
    )
  })

  it('cleans staging when decompressed data fails CRC verification', async () => {
    const buffer = zip([{ name: 'bad', data: 'content' }])
    buffer[33] ^= 1
    const { archive, staging } = await fixture(buffer)
    await expect(
      extractZipSafely({ archivePath: archive, stagingParent: staging })
    ).rejects.toBeInstanceOf(SafeZipError)
    await expect(readdir(staging)).resolves.toHaveLength(0)
  })

  it('enforces entry and size budgets before creating staging', async () => {
    expect((await rejection([{ name: 'a' }, { name: 'b' }], { maxEntries: 1 })).code).toBe(
      'BUDGET_EXCEEDED'
    )
    expect((await rejection([{ name: 'a', data: '1234' }], { maxUncompressedBytes: 3 })).code).toBe(
      'BUDGET_EXCEEDED'
    )
    expect((await rejection([{ name: 'a', data: '1234' }], { maxEntryBytes: 3 })).code).toBe(
      'BUDGET_EXCEEDED'
    )
  })

  it('rejects truncated and malformed archives before writing', async () => {
    const truncated = await fixture(zip([{ name: 'a', data: 'x' }]).subarray(0, 12))
    await expect(
      extractZipSafely({ archivePath: truncated.archive, stagingParent: truncated.staging })
    ).rejects.toBeInstanceOf(SafeZipError)
    const malformed = zip([{ name: 'a', data: 'x' }])
    malformed.writeUInt32LE(0, malformed.length - 22 + 16)
    const bad = await fixture(malformed)
    await expect(
      extractZipSafely({ archivePath: bad.archive, stagingParent: bad.staging })
    ).rejects.toBeInstanceOf(SafeZipError)
  })

  it('rejects differing local and central names', async () => {
    expect((await rejection([{ name: 'local', centralName: 'central' }])).code).toBe('MALFORMED')
  })
})
