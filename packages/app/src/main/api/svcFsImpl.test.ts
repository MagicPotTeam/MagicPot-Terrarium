import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  fsSvcDef,
  MAX_FULL_FILE_BYTES,
  MAX_READ_FILE_SLICE_BYTES,
  MAX_TEXT_FILE_BYTES
} from '@shared/api/svcFs'
import { validateServiceValue } from '@shared/api/apiUtils/serviceValidation'
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

  describe('bounded reads and writes', () => {
    it('rejects full-file reads over the limit while the slice API remains usable', async () => {
      const fullPath = path.join(testRoot, 'large.bin')
      fs.writeFileSync(fullPath, Buffer.alloc(1))
      fs.truncateSync(fullPath, MAX_FULL_FILE_BYTES + 1)

      await expect(service.readFileFromPath({ fullPath })).rejects.toThrow(/readFileSlice/)
      await expect(service.readFileSlice({ fullPath, length: 1 })).resolves.toMatchObject({
        data: new Uint8Array([0]),
        fileSizeBytes: MAX_FULL_FILE_BYTES + 1
      })
    })

    it('rejects oversized text reads and writes', async () => {
      const fullPath = path.join(testRoot, 'large.txt')
      fs.writeFileSync(fullPath, Buffer.alloc(1))
      fs.truncateSync(fullPath, MAX_TEXT_FILE_BYTES + 1)

      await expect(service.readTextFile({ fullPath })).rejects.toThrow(/full-file IPC limit/)
      await expect(
        service.writeTextFile({
          outputPath: testRoot,
          filename: 'large.txt',
          content: 'x'.repeat(MAX_TEXT_FILE_BYTES + 1)
        })
      ).rejects.toThrow(/IPC limit/)
    })
  })

  describe('safe directory-based writes', () => {
    it.each(['../escape.png', '..\\escape.png', '/absolute.png', 'nested/file.png'])(
      'rejects traversal filename %s',
      async (filename) => {
        await expect(
          service.saveImageToPath({ image: new Uint8Array([1]), outputPath: testRoot, filename })
        ).rejects.toThrow(/basename-only/)
      }
    )

    it('preserves normal basename writes', async () => {
      const response = await service.writeTextFile({
        outputPath: path.join(testRoot, 'new-dir'),
        filename: 'notes.json',
        content: '{}'
      })
      expect(response.fullPath).toBe(path.join(testRoot, 'new-dir', 'notes.json'))
      expect(fs.readFileSync(response.fullPath, 'utf8')).toBe('{}')
    })
  })

  describe('shared validators', () => {
    it('rejects traversal and oversized payloads before dispatch', () => {
      expect(() =>
        validateServiceValue(
          {
            image: new Uint8Array([1]),
            outputPath: testRoot,
            filename: '../escape.png'
          },
          fsSvcDef.saveImageToPath.request
        )
      ).toThrow(/filename/)
      expect(() =>
        validateServiceValue(
          {
            image: new Uint8Array(MAX_FULL_FILE_BYTES + 1),
            outputPath: testRoot,
            filename: 'large.png'
          },
          fsSvcDef.saveImageToPath.request
        )
      ).toThrow(/image/)
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

  describe('readLoraTriggerWordsNative', () => {
    it('returns unavailable when the native sidecar binary is not present', async () => {
      await expect(
        service.readLoraTriggerWordsNative({
          loraDir: testRoot,
          loraName: 'style.safetensors'
        })
      ).resolves.toEqual({
        triggerWords: '',
        source: '',
        nativeAvailable: false
      })
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
