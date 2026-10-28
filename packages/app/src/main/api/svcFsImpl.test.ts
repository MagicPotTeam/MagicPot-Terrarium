import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => path.join(process.cwd(), '.magicpot-trash', name))
  }
}))
import {
  fsSvcDef,
  MAX_FULL_FILE_BYTES,
  MAX_READ_FILE_SLICE_BYTES,
  MAX_TEXT_FILE_BYTES
} from '@shared/api/svcFs'
import { validateServiceValue } from '@shared/api/apiUtils/serviceValidation'
import { FsSvcImpl } from './svcFsImpl'
import {
  authorizeScopedLocalMediaDirectory,
  clearScopedLocalMediaPathsForTest
} from '../localMediaAccess'

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
    vi.restoreAllMocks()
    clearScopedLocalMediaPathsForTest()
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  describe('readImageFromPath authorization', () => {
    it('rejects arbitrary renderer paths but permits images under a trusted directory selection', async () => {
      const fullPath = path.join(testRoot, 'nested', 'image.png')
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, Buffer.from([10, 20, 30]))

      await expect(service.readImageFromPath({ fullPath })).rejects.toThrow(
        'Local image path is not authorized'
      )

      expect(authorizeScopedLocalMediaDirectory(testRoot)).toBe(true)
      await expect(service.readImageFromPath({ fullPath })).resolves.toEqual({
        image: new Uint8Array([10, 20, 30]),
        filename: 'image.png'
      })
    })

    it('does not let a caller byte budget authorize an arbitrary path', async () => {
      const fullPath = path.join(testRoot, 'image.png')
      fs.writeFileSync(fullPath, Buffer.from([10, 20, 30]))
      const readFile = vi.spyOn(fsPromises, 'readFile')

      await expect(service.readImageFromPath({ fullPath, maxBytes: 3 })).rejects.toThrow(
        'Local image path is not authorized'
      )
      expect(readFile).not.toHaveBeenCalled()
    })
  })

  describe('readImageFromPath byte budgets', () => {
    const createAuthorizedImage = (): string => {
      const fullPath = path.join(testRoot, 'image.png')
      fs.writeFileSync(fullPath, Buffer.from([10, 20, 30]))
      expect(authorizeScopedLocalMediaDirectory(testRoot)).toBe(true)
      return fullPath
    }

    it('accepts an image exactly at the caller byte budget', async () => {
      const fullPath = createAuthorizedImage()
      const readFile = vi.spyOn(fsPromises, 'readFile')
      const handle = await fsPromises.open(fullPath, 'r')
      const close = vi.spyOn(handle, 'close')
      vi.spyOn(fsPromises, 'open').mockResolvedValueOnce(handle)

      await expect(service.readImageFromPath({ fullPath, maxBytes: 3 })).resolves.toEqual({
        image: new Uint8Array([10, 20, 30]),
        filename: 'image.png'
      })
      expect(readFile).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledOnce()
    })

    it('rejects a preexisting oversized image before reading its bytes', async () => {
      const fullPath = createAuthorizedImage()
      const readFile = vi.spyOn(fsPromises, 'readFile')
      const handle = await fsPromises.open(fullPath, 'r')
      const read = vi.spyOn(handle, 'read')
      const close = vi.spyOn(handle, 'close')
      vi.spyOn(fsPromises, 'open').mockResolvedValueOnce(handle)

      await expect(service.readImageFromPath({ fullPath, maxBytes: 2 })).rejects.toThrow(
        /2-byte full-file IPC limit/
      )
      expect(readFile).not.toHaveBeenCalled()
      expect(read).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledOnce()
    })

    it('preserves exact bytes when a successful read spans multiple chunks', async () => {
      const fullPath = createAuthorizedImage()
      const expected = Buffer.alloc(64 * 1024 + 17, 23)
      expected[0] = 11
      expected[expected.length - 1] = 99
      fs.writeFileSync(fullPath, expected)

      await expect(
        service.readImageFromPath({ fullPath, maxBytes: expected.length })
      ).resolves.toEqual({ image: new Uint8Array(expected), filename: 'image.png' })
    })

    it('rejects a directory through the opened handle before reading', async () => {
      expect(authorizeScopedLocalMediaDirectory(testRoot)).toBe(true)
      const handle = await fsPromises.open(testRoot, 'r')
      const read = vi.spyOn(handle, 'read')
      const close = vi.spyOn(handle, 'close')
      vi.spyOn(fsPromises, 'open').mockResolvedValueOnce(handle)

      await expect(service.readImageFromPath({ fullPath: testRoot, maxBytes: 3 })).rejects.toThrow(
        `Path is not a file: ${testRoot}`
      )
      expect(read).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledOnce()
    })

    it.each([3, 64 * 1024 + 5])(
      'reads at most the %i-byte budget plus one detection byte after a file grows',
      async (maxBytes) => {
        const fullPath = createAuthorizedImage()
        const handle = await fsPromises.open(fullPath, 'r')
        const originalStat = handle.stat.bind(handle)
        vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
          const stats = await originalStat()
          fs.writeFileSync(fullPath, Buffer.alloc(maxBytes + 1000, 7))
          return stats
        })
        const read = vi.spyOn(handle, 'read')
        const close = vi.spyOn(handle, 'close')
        vi.spyOn(fsPromises, 'open').mockResolvedValueOnce(handle)
        const readFile = vi.spyOn(fsPromises, 'readFile')

        await expect(service.readImageFromPath({ fullPath, maxBytes })).rejects.toThrow(
          `${maxBytes}-byte IPC limit`
        )
        const requests =
          maxBytes < 64 * 1024
            ? [{ length: maxBytes + 1, position: 0 }]
            : [
                { length: 64 * 1024, position: 0 },
                { length: 6, position: 64 * 1024 }
              ]
        expect(read).toHaveBeenCalledTimes(requests.length)
        requests.forEach((request, index) => {
          expect(read).toHaveBeenNthCalledWith(
            index + 1,
            expect.any(Buffer),
            0,
            request.length,
            request.position
          )
        })
        expect(readFile).not.toHaveBeenCalled()
        expect(close).toHaveBeenCalledOnce()
      }
    )

    it('closes the bounded file handle if a read fails', async () => {
      const fullPath = createAuthorizedImage()
      const handle = await fsPromises.open(fullPath, 'r')
      vi.spyOn(handle, 'read').mockRejectedValueOnce(new Error('synthetic read failed'))
      const close = vi.spyOn(handle, 'close')
      vi.spyOn(fsPromises, 'open').mockResolvedValueOnce(handle)

      await expect(service.readImageFromPath({ fullPath, maxBytes: 3 })).rejects.toThrow(
        'synthetic read failed'
      )
      expect(close).toHaveBeenCalledOnce()
    })

    it('continues to enforce the default full-file limit without a caller budget', async () => {
      const fullPath = createAuthorizedImage()
      const stats = await fsPromises.stat(fullPath)
      vi.spyOn(fsPromises, 'stat').mockResolvedValueOnce({
        ...stats,
        size: MAX_FULL_FILE_BYTES + 1,
        isFile: () => true
      })
      const readFile = vi.spyOn(fsPromises, 'readFile')

      await expect(service.readImageFromPath({ fullPath })).rejects.toThrow(/full-file IPC limit/)
      expect(readFile).not.toHaveBeenCalled()
    })

    it.each([0, -1, 1.5, NaN, Infinity, MAX_FULL_FILE_BYTES + 1])(
      'rejects invalid direct-service byte budget %s without reading',
      async (maxBytes) => {
        const fullPath = createAuthorizedImage()
        const readFile = vi.spyOn(fsPromises, 'readFile')

        await expect(service.readImageFromPath({ fullPath, maxBytes })).rejects.toThrow(/maxBytes/)
        expect(readFile).not.toHaveBeenCalled()
      }
    )
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

  describe('pruneAutoSaveProjects request validation', () => {
    it('rejects path separators in the project directory basename', () => {
      expect(() =>
        validateServiceValue(
          {
            currentProjectDirName: '../outside',
            maxProjects: 8
          },
          fsSvcDef.pruneAutoSaveProjects.request
        )
      ).toThrow(/directory basename/i)
    })

    it('accepts an ordinary project directory basename and an eight-project limit', () => {
      expect(
        validateServiceValue(
          {
            currentProjectDirName: '.scene__scene',
            maxProjects: 8
          },
          fsSvcDef.pruneAutoSaveProjects.request
        )
      ).toEqual({ currentProjectDirName: '.scene__scene', maxProjects: 8 })
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
