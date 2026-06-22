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

describe('FsSvcImpl', () => {
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

  describe('readFileFromPath', () => {
    it('reads a normal file and returns its filename', async () => {
      const fullPath = path.join(testRoot, 'image.png')
      fs.writeFileSync(fullPath, Buffer.from([10, 20, 30]))

      await expect(service.readFileFromPath({ fullPath })).resolves.toEqual({
        data: new Uint8Array([10, 20, 30]),
        filename: 'image.png'
      })
    })

    it('rejects a missing file with the existing File not found error shape', async () => {
      const fullPath = path.join(testRoot, 'missing.bin')

      await expect(service.readFileFromPath({ fullPath })).rejects.toThrow(
        `File not found: ${fullPath}`
      )
    })
  })

  describe('readFileSlice', () => {
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

    it('rejects directories instead of reading them as files', async () => {
      await expect(
        service.readFileSlice({ fullPath: testRoot, offset: 0, length: 1 })
      ).rejects.toThrow(`Path is not a file: ${testRoot}`)
    })
  })

  describe('listFilesInFolder', () => {
    it('scans directories with extension filtering and recursive traversal', async () => {
      const nestedDir = path.join(testRoot, 'nested')
      fs.mkdirSync(nestedDir)
      fs.writeFileSync(path.join(testRoot, 'root.txt'), 'root')
      fs.writeFileSync(path.join(testRoot, 'ignore.bin'), 'ignore')
      fs.writeFileSync(path.join(nestedDir, 'child.TXT'), 'child')

      const { files } = await service.listFilesInFolder({
        folderPath: testRoot,
        extensions: ['txt'],
        recursive: true
      })

      expect(files.map((file) => path.relative(testRoot, file.fullPath)).sort()).toEqual([
        path.join('nested', 'child.TXT'),
        'root.txt'
      ])
      expect(files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            filename: 'root.txt',
            fullPath: path.join(testRoot, 'root.txt'),
            lastModifiedMs: expect.any(Number)
          }),
          expect.objectContaining({
            filename: 'child.TXT',
            fullPath: path.join(nestedDir, 'child.TXT'),
            lastModifiedMs: expect.any(Number)
          })
        ])
      )
    })

    it('returns an empty list for a missing directory', async () => {
      await expect(
        service.listFilesInFolder({ folderPath: path.join(testRoot, 'missing'), recursive: true })
      ).resolves.toEqual({ files: [] })
    })
  })

  describe('listImagesInFolder', () => {
    it('propagates directory scan errors for invalid folder paths', async () => {
      const fullPath = path.join(testRoot, 'not-a-directory')
      fs.writeFileSync(fullPath, 'content')

      await expect(service.listImagesInFolder({ folderPath: fullPath })).rejects.toThrow()
    })
  })
})
