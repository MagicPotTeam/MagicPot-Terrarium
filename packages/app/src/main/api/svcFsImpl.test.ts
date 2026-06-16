import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_READ_FILE_SLICE_BYTES } from '@shared/api/svcFs'
import { FsSvcImpl } from './svcFsImpl'

const getTestRoot = (): string =>
  path.join(
    process.cwd(),
    '.magicpot-trash',
    'svc-fs-impl',
    `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`
  )

describe('FsSvcImpl.readFileSlice', () => {
  let testRoot: string
  let service: FsSvcImpl

  beforeEach(() => {
    testRoot = getTestRoot()
    fs.mkdirSync(testRoot, { recursive: true })
    service = new FsSvcImpl()
  })

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  it('reads only the requested file slice and reports file size', async () => {
    const fullPath = path.join(testRoot, 'model.safetensors')
    fs.writeFileSync(fullPath, Buffer.from([1, 2, 3, 4, 5]))

    await expect(service.readFileSlice({ fullPath, offset: 1, length: 3 })).resolves.toEqual({
      data: new Uint8Array([2, 3, 4]),
      filename: 'model.safetensors',
      fileSizeBytes: 5
    })
  })

  it('returns an empty slice when the offset is past the end', async () => {
    const fullPath = path.join(testRoot, 'model.safetensors')
    fs.writeFileSync(fullPath, Buffer.from([1, 2, 3]))

    await expect(service.readFileSlice({ fullPath, offset: 99, length: 4 })).resolves.toEqual({
      data: new Uint8Array(),
      filename: 'model.safetensors',
      fileSizeBytes: 3
    })
  })

  it('rejects invalid offsets and oversized lengths at the service boundary', async () => {
    const fullPath = path.join(testRoot, 'model.safetensors')
    fs.writeFileSync(fullPath, Buffer.from([1, 2, 3]))

    await expect(service.readFileSlice({ fullPath, offset: -1, length: 1 })).rejects.toThrow(
      /offset/i
    )
    await expect(service.readFileSlice({ fullPath, offset: 0, length: 0 })).rejects.toThrow(
      /length/i
    )
    await expect(
      service.readFileSlice({ fullPath, offset: 0, length: MAX_READ_FILE_SLICE_BYTES + 1 })
    ).rejects.toThrow(/length/i)
  })
})
