import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => path.join(process.cwd(), '.magicpot-trash', name))
  },
  nativeImage: {
    createFromBuffer: vi.fn((bytes: Buffer) => ({
      isEmpty: () => bytes.length === 0,
      toPNG: () => PNG_BYTES
    }))
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

  describe('batch filesystem transactions', () => {
    it('recursively scans supported images, including legitimate work/output folders', async () => {
      fs.mkdirSync(path.join(testRoot, 'nested'), { recursive: true })
      fs.mkdirSync(path.join(testRoot, 'work'), { recursive: true })
      fs.mkdirSync(path.join(testRoot, 'output'), { recursive: true })
      fs.mkdirSync(path.join(testRoot, '.magicpot-batch'), { recursive: true })
      fs.writeFileSync(path.join(testRoot, 'root.JPG'), 'jpg')
      fs.writeFileSync(path.join(testRoot, 'nested', 'child.webp'), 'webp')
      fs.writeFileSync(path.join(testRoot, 'nested', 'ignore.txt'), 'text')
      fs.writeFileSync(path.join(testRoot, 'work', 'hidden.png'), 'png')
      fs.writeFileSync(path.join(testRoot, 'output', 'hidden.png'), 'png')
      fs.writeFileSync(path.join(testRoot, '.magicpot-batch', 'hidden.png'), 'png')

      const result = await service.scanBatchImages({ sourceRoot: testRoot })
      expect(result.errors).toEqual([])
      expect(result.images.map((image) => image.relativePath)).toEqual([
        'nested/child.webp',
        'output/hidden.png',
        'root.JPG',
        'work/hidden.png'
      ])
      expect(result.images[0]).toMatchObject({
        absolutePath: path.join(testRoot, 'nested', 'child.webp'),
        size: 4,
        mtimeMs: expect.any(Number)
      })
    })

    it('rejects symbolic-link or junction source roots', async () => {
      const realSourceRoot = path.join(testRoot, 'real-photos')
      const linkedSourceRoot = path.join(testRoot, 'linked-photos')
      fs.mkdirSync(realSourceRoot, { recursive: true })
      fs.writeFileSync(path.join(realSourceRoot, 'image.jpg'), 'source')
      try {
        fs.symlinkSync(
          realSourceRoot,
          linkedSourceRoot,
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      } catch {
        return
      }

      await expect(service.scanBatchImages({ sourceRoot: linkedSourceRoot })).rejects.toThrow(
        /symbolic link|junction/i
      )
    })

    it('rejects symbolic-link source images instead of following them', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      const outsideRoot = path.join(testRoot, 'outside')
      fs.mkdirSync(sourceRoot, { recursive: true })
      fs.mkdirSync(outsideRoot, { recursive: true })
      const secretPath = path.join(outsideRoot, 'secret.jpg')
      const linkedPath = path.join(sourceRoot, 'linked.jpg')
      fs.writeFileSync(secretPath, 'secret')
      try {
        fs.symlinkSync(secretPath, linkedPath, 'file')
      } catch {
        return
      }

      await expect(service.scanBatchImages({ sourceRoot })).rejects.toThrow(
        /symbolic link|junction/i
      )
    })

    it('reads only a regular source file matching the scanned fingerprint', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      const imagePath = path.join(sourceRoot, 'image.jpg')
      fs.mkdirSync(sourceRoot, { recursive: true })
      fs.writeFileSync(imagePath, 'source')
      const scanned = await service.scanBatchImages({ sourceRoot })
      const image = scanned.images[0]

      await expect(
        service.readBatchSourceImage({
          sourceRoot,
          relativeInputPath: image.relativePath,
          sourceFingerprint: { size: image.size, mtimeMs: image.mtimeMs }
        })
      ).resolves.toEqual({ image: new Uint8Array(Buffer.from('source')), filename: 'image.jpg' })

      fs.writeFileSync(imagePath, 'changed-source')
      await expect(
        service.readBatchSourceImage({
          sourceRoot,
          relativeInputPath: image.relativePath,
          sourceFingerprint: { size: image.size, mtimeMs: image.mtimeMs }
        })
      ).rejects.toThrow(/changed after scanning/i)
    })

    it('rejects a redirected output metadata directory', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      const outputRoot = `${sourceRoot}.output`
      const outsideRoot = path.join(testRoot, 'outside-metadata')
      fs.mkdirSync(sourceRoot, { recursive: true })
      fs.writeFileSync(path.join(sourceRoot, 'image.jpg'), 'source')
      fs.mkdirSync(outputRoot, { recursive: true })
      fs.mkdirSync(outsideRoot, { recursive: true })
      try {
        fs.symlinkSync(
          outsideRoot,
          path.join(outputRoot, '.magicpot-batch'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      } catch {
        return
      }

      await expect(
        service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })
      ).rejects.toThrow(/symbolic link|junction/i)
      expect(fs.readdirSync(outsideRoot)).toEqual([])
    })

    it('rejects a symlinked aggregate errors.log without modifying its target', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      fs.mkdirSync(sourceRoot, { recursive: true })
      fs.writeFileSync(path.join(sourceRoot, 'image.jpg'), 'source')
      const prepared = await service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })
      const outsideLog = path.join(testRoot, 'outside-errors.log')
      fs.writeFileSync(outsideLog, 'sentinel')
      try {
        fs.symlinkSync(outsideLog, path.join(prepared.paths.metadataRoot, 'errors.log'), 'file')
      } catch {
        return
      }

      await expect(
        service.appendBatchAggregateError({ sourceRoot, entry: 'must-not-escape\n' })
      ).rejects.toThrow(/symbolic link|junction/i)
      expect(fs.readFileSync(outsideLog, 'utf8')).toBe('sentinel')
    })

    it('stores metadata under output, migrates legacy work metadata, and resumes succeeded items', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      fs.mkdirSync(path.join(sourceRoot, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(sourceRoot, 'nested', 'image.jpg'), 'source')

      const first = await service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })
      expect(first.paths.workRoot).toBe(first.paths.outputRoot)
      expect(first.paths.metadataRoot).toBe(path.join(first.paths.outputRoot, '.magicpot-batch'))
      expect(fs.existsSync(`${sourceRoot}.work`)).toBe(false)
      expect(fs.existsSync(path.join(first.paths.outputRoot, 'nested'))).toBe(true)
      expect(fs.existsSync(path.join(first.paths.outputRoot, 'nested', 'image.jpg'))).toBe(false)
      expect(fs.existsSync(first.paths.manifestPath)).toBe(true)

      const manifest = structuredClone(first.manifest)
      manifest.items[0].status = 'succeeded'
      fs.writeFileSync(path.join(first.paths.outputRoot, 'nested', 'image.png'), PNG_BYTES)
      await service.writeBatchManifest({ sourceRoot, manifest })
      const legacyWorkRoot = `${sourceRoot}.work`
      fs.mkdirSync(legacyWorkRoot, { recursive: true })
      fs.renameSync(first.paths.metadataRoot, path.join(legacyWorkRoot, '.magicpot-batch'))

      const resumed = await service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })
      expect(resumed.skippedRelativePaths).toEqual(['nested/image.jpg'])
      expect(resumed.manifest.items[0].status).toBe('succeeded')
      expect(fs.existsSync(legacyWorkRoot)).toBe(false)
      expect(fs.existsSync(resumed.paths.manifestPath)).toBe(true)
      expect((await service.readBatchManifest({ sourceRoot })).manifest?.version).toBe(1)
    })

    it('requeues failed items and removes stale successful PNG output during preparation', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      fs.mkdirSync(sourceRoot, { recursive: true })
      fs.writeFileSync(path.join(sourceRoot, 'image.jpg'), 'source')
      const first = await service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })
      const manifest = structuredClone(first.manifest)
      manifest.items[0].status = 'failed'
      fs.writeFileSync(path.join(first.paths.outputRoot, 'image.png'), PNG_BYTES)
      await service.writeBatchManifest({ sourceRoot, manifest })

      const resumed = await service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })

      expect(resumed.manifest.items[0].status).toBe('pending')
      expect(fs.existsSync(path.join(first.paths.outputRoot, 'image.png'))).toBe(false)
      expect(fs.existsSync(`${sourceRoot}.work`)).toBe(false)
      expect(fs.existsSync(path.join(first.paths.outputRoot, 'image.jpg'))).toBe(false)
    })

    it('atomically commits real PNG bytes beside output metadata without copying sources', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      fs.mkdirSync(path.join(sourceRoot, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(sourceRoot, 'nested', 'image.jpg'), 'source')
      const prepared = await service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })
      const fingerprint = prepared.manifest.items[0].sourceFingerprint

      const committed = await service.commitBatchPng({
        sourceRoot,
        relativeInputPath: 'nested/image.jpg',
        sourceFingerprint: fingerprint,
        image: new Uint8Array(PNG_BYTES)
      })

      expect(committed.outputRelativePath).toBe('nested/image.png')
      expect(fs.readFileSync(committed.outputPath).subarray(0, 8)).toEqual(PNG_BYTES.subarray(0, 8))
      expect(fs.existsSync(path.join(prepared.paths.outputRoot, 'nested', 'image.jpg'))).toBe(false)
      expect(fs.existsSync(`${sourceRoot}.work`)).toBe(false)
      expect(
        fs.existsSync(path.join(prepared.paths.metadataRoot, 'errors', 'nested', 'image.jpg.log'))
      ).toBe(false)
      expect(
        fs
          .readdirSync(path.join(prepared.paths.metadataRoot, 'staging'), { recursive: true })
          .filter((entry) => path.extname(entry.toString()))
      ).toEqual([])
      expect(fs.readFileSync(path.join(sourceRoot, 'nested', 'image.jpg'), 'utf8')).toBe('source')
    })

    it('stores failed-item diagnostics under output metadata without creating work', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      fs.mkdirSync(path.join(sourceRoot, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(sourceRoot, 'nested', 'image.jpg'), 'source')
      const prepared = await service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })
      fs.writeFileSync(path.join(prepared.paths.outputRoot, 'nested', 'image.png'), PNG_BYTES)

      const failed = await service.failBatchItem({
        sourceRoot,
        relativeInputPath: 'nested/image.jpg',
        errorLog: 'diagnostic error'
      })

      expect(fs.existsSync(`${sourceRoot}.work`)).toBe(false)
      expect(failed.errorLogPath).toBe(
        path.join(prepared.paths.metadataRoot, 'errors', 'nested', 'image.jpg.log')
      )
      expect(fs.readFileSync(failed.errorLogPath, 'utf8')).toBe('diagnostic error')
      expect(fs.existsSync(path.join(prepared.paths.outputRoot, 'nested', 'image.jpg'))).toBe(false)
      expect(fs.existsSync(path.join(prepared.paths.outputRoot, 'nested', 'image.png'))).toBe(false)
      expect(fs.readFileSync(path.join(sourceRoot, 'nested', 'image.jpg'), 'utf8')).toBe('source')
    })

    it('rejects output collisions and traversal at both service boundaries', async () => {
      const sourceRoot = path.join(testRoot, 'photos')
      fs.mkdirSync(sourceRoot, { recursive: true })
      fs.writeFileSync(path.join(sourceRoot, 'cat.jpg'), 'jpg')
      fs.writeFileSync(path.join(sourceRoot, 'cat.png'), PNG_BYTES)
      await expect(
        service.prepareBatchWorkspace({ sourceRoot, userAuthorized: true })
      ).rejects.toThrow(/collision/i)

      await expect(
        service.commitBatchPng({
          sourceRoot,
          relativeInputPath: '../escape.jpg',
          sourceFingerprint: { size: 3, mtimeMs: Date.now() },
          image: new Uint8Array(PNG_BYTES)
        })
      ).rejects.toThrow(/traversal|relative path/i)
      expect(() =>
        validateServiceValue(
          {
            sourceRoot,
            relativeInputPath: '..\\escape.jpg',
            sourceFingerprint: { size: 3, mtimeMs: Date.now() },
            image: new Uint8Array(PNG_BYTES)
          },
          fsSvcDef.commitBatchPng.request
        )
      ).toThrow(/relativeInputPath/)
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
