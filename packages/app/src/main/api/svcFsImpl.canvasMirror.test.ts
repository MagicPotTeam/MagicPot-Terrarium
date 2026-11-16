import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const roots = vi.hoisted(() => ({ base: '' }))

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => `${roots.base}/electron-${name}`)
  }
}))

vi.mock('../config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    autoSaveRoot: `${roots.base}/AutoSave`,
    projectRoot: `${roots.base}/Projects`
  })
}))

import {
  fsSvcDef,
  MAX_CANVAS_MIRROR_SOURCE_PATH_LENGTH,
  MAX_FULL_FILE_BYTES
} from '@shared/api/svcFs'
import { validateServiceValue } from '@shared/api/apiUtils/serviceValidation'
import { CANVAS_MIRROR_PRUNE_GRACE_MS, FsSvcImpl } from './svcFsImpl'
import {
  authorizeScopedLocalMediaDirectory,
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest
} from '../localMediaAccess'

const KEY_A = `b-${'a'.repeat(40)}`
const KEY_B = `f-${'b'.repeat(40)}`
const KEY_C = `u-${'c'.repeat(40)}`
const PROJECT = 'Board-1'

const supportsSymlinks = process.platform !== 'win32'

describe('FsSvcImpl canvas mirror assets', () => {
  let service: FsSvcImpl
  let autoSaveRoot: string
  let projectRoot: string
  let outsideRoot: string
  let assetDir: string

  const writeFile = (fullPath: string, content: string | Uint8Array): string => {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
    return fullPath
  }
  const writeProjectFile = (items: unknown[]): void => {
    writeFile(
      path.join(autoSaveRoot, PROJECT, 'project.mpcanvas'),
      JSON.stringify({ magic: 'MAGICPOT_CANVAS', storageMode: 'project', items })
    )
  }
  const listAssetDir = (): string[] =>
    fs.existsSync(assetDir) ? fs.readdirSync(assetDir).sort() : []
  const afterGrace = (): void => {
    const later = Date.now() + CANVAS_MIRROR_PRUNE_GRACE_MS + 60_000
    vi.spyOn(Date, 'now').mockReturnValue(later)
  }

  beforeEach(() => {
    roots.base = path.join(
      process.cwd(),
      '.magicpot-trash',
      'svc-fs-canvas-mirror',
      `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`
    )
    autoSaveRoot = path.join(roots.base, 'AutoSave')
    projectRoot = path.join(roots.base, 'Projects')
    outsideRoot = path.join(roots.base, 'Outside')
    assetDir = path.join(autoSaveRoot, PROJECT, 'assets')
    for (const dir of [autoSaveRoot, projectRoot, outsideRoot])
      fs.mkdirSync(dir, { recursive: true })
    service = new FsSvcImpl()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    clearScopedLocalMediaPathsForTest()
    fs.rmSync(roots.base, { recursive: true, force: true })
  })

  describe('writeCanvasMirrorAsset', () => {
    it('writes an asset once and never replaces it', async () => {
      const first = await service.writeCanvasMirrorAsset({
        projectDirName: PROJECT,
        assetFileName: `${KEY_A}.png`,
        data: new Uint8Array([1, 2, 3])
      })
      expect(first).toEqual({ status: 'written', sizeBytes: 3 })
      expect(listAssetDir()).toEqual([`${KEY_A}.png`])

      const second = await service.writeCanvasMirrorAsset({
        projectDirName: PROJECT,
        assetFileName: `${KEY_A}.png`,
        data: new Uint8Array([9, 9, 9, 9])
      })
      expect(second).toEqual({ status: 'exists', sizeBytes: 3 })
      expect([...fs.readFileSync(path.join(assetDir, `${KEY_A}.png`))]).toEqual([1, 2, 3])
      // No temporary file is left behind.
      expect(listAssetDir()).toEqual([`${KEY_A}.png`])
    })

    it('keeps one winner when the same asset is written concurrently', async () => {
      const results = await Promise.all(
        [1, 2, 3, 4].map((value) =>
          service.writeCanvasMirrorAsset({
            projectDirName: PROJECT,
            assetFileName: KEY_A,
            data: new Uint8Array([value])
          })
        )
      )
      expect(results.filter((result) => result.status === 'written')).toHaveLength(1)
      expect(listAssetDir()).toEqual([KEY_A])
      expect([...fs.readFileSync(path.join(assetDir, KEY_A))]).toEqual([1])
    })

    it('repairs an empty file left behind by an interrupted write', async () => {
      writeFile(path.join(assetDir, `${KEY_A}.png`), '')
      const result = await service.writeCanvasMirrorAsset({
        projectDirName: PROJECT,
        assetFileName: `${KEY_A}.png`,
        data: new Uint8Array([5, 6])
      })
      expect(result).toEqual({ status: 'written', sizeBytes: 2 })
      expect([...fs.readFileSync(path.join(assetDir, `${KEY_A}.png`))]).toEqual([5, 6])
    })

    it.each([
      ['parent traversal', '..'],
      ['current directory', '.'],
      ['nested path', 'a/b'],
      ['backslash path', 'a\\b'],
      ['absolute path', '/etc'],
      ['drive-relative name', 'C:'],
      ['surrounding whitespace', ' Board '],
      ['overlong name', 'x'.repeat(300)],
      ['empty name', '']
    ])('rejects a project directory name with %s', async (_label, projectDirName) => {
      await expect(
        service.writeCanvasMirrorAsset({
          projectDirName,
          assetFileName: KEY_A,
          data: new Uint8Array([1])
        })
      ).rejects.toThrow()
      expect(() =>
        validateServiceValue(
          { projectDirName, assetFileName: KEY_A, data: new Uint8Array([1]) },
          fsSvcDef.writeCanvasMirrorAsset.request
        )
      ).toThrow()
      expect(fs.readdirSync(autoSaveRoot)).toEqual([])
      expect(fs.readdirSync(roots.base).sort()).toEqual(['AutoSave', 'Outside', 'Projects'])
    })

    it.each([
      ['traversal', '../escape.png'],
      ['a nested path', `sub/${KEY_A}.png`],
      ['a backslash path', `sub\\${KEY_A}.png`],
      ['an absolute path', '/tmp/escape.png'],
      ['an arbitrary name', 'project.mpcanvas'],
      ['uppercase hex', `b-${'A'.repeat(40)}.png`],
      ['a short key', `b-${'a'.repeat(39)}.png`],
      ['an overlong key', `b-${'a'.repeat(300)}.png`],
      ['an overlong extension', `${KEY_A}.${'x'.repeat(17)}`],
      ['a double extension', `${KEY_A}.tar.gz`],
      ['a trailing dot', `${KEY_A}.`],
      ['an unknown key family', `z-${'a'.repeat(40)}`]
    ])('rejects an asset file name with %s', async (_label, assetFileName) => {
      await expect(
        service.writeCanvasMirrorAsset({
          projectDirName: PROJECT,
          assetFileName,
          data: new Uint8Array([1])
        })
      ).rejects.toThrow(/asset file name/)
      expect(() =>
        validateServiceValue(
          { projectDirName: PROJECT, assetFileName, data: new Uint8Array([1]) },
          fsSvcDef.writeCanvasMirrorAsset.request
        )
      ).toThrow()
      expect(fs.readdirSync(autoSaveRoot)).toEqual([])
    })

    it.runIf(supportsSymlinks)(
      'refuses a project folder, an asset folder or a destination that is a symbolic link',
      async () => {
        const write = (projectDirName: string): Promise<unknown> =>
          service.writeCanvasMirrorAsset({
            projectDirName,
            assetFileName: KEY_A,
            data: new Uint8Array([1])
          })

        fs.symlinkSync(outsideRoot, path.join(autoSaveRoot, 'LinkedProject'))
        await expect(write('LinkedProject')).rejects.toThrow(/plain directory/)

        fs.mkdirSync(path.join(autoSaveRoot, 'LinkedAssets'))
        fs.symlinkSync(outsideRoot, path.join(autoSaveRoot, 'LinkedAssets', 'assets'))
        await expect(write('LinkedAssets')).rejects.toThrow(/plain directory/)

        const victim = writeFile(path.join(outsideRoot, 'victim.bin'), 'keep me')
        fs.mkdirSync(assetDir, { recursive: true })
        fs.symlinkSync(victim, path.join(assetDir, KEY_A))
        await expect(write(PROJECT)).rejects.toThrow(/regular file/)

        expect(fs.readFileSync(victim, 'utf8')).toBe('keep me')
        expect(fs.readdirSync(outsideRoot)).toEqual(['victim.bin'])
      }
    )
  })

  describe('copyCanvasMirrorAsset', () => {
    it('copies a file under an application root file-to-file, once', async () => {
      const source = writeFile(path.join(projectRoot, 'Board-1', 'out.png'), 'pixels')
      await expect(
        service.copyCanvasMirrorAsset({
          projectDirName: PROJECT,
          assetFileName: `${KEY_B}.png`,
          sourcePath: source
        })
      ).resolves.toEqual({ status: 'written', sizeBytes: 6 })
      expect(fs.readFileSync(path.join(assetDir, `${KEY_B}.png`), 'utf8')).toBe('pixels')

      fs.writeFileSync(source, 'changed on disk')
      await expect(
        service.copyCanvasMirrorAsset({
          projectDirName: PROJECT,
          assetFileName: `${KEY_B}.png`,
          sourcePath: source
        })
      ).resolves.toEqual({ status: 'exists', sizeBytes: 6 })
      expect(fs.readFileSync(path.join(assetDir, `${KEY_B}.png`), 'utf8')).toBe('pixels')
      expect(listAssetDir()).toEqual([`${KEY_B}.png`])
    })

    it('refuses a source larger than the full-file limit and creates nothing', async () => {
      const source = path.join(projectRoot, 'Board-1', 'huge.png')
      writeFile(source, '')
      // Sparse: takes no disk space.
      fs.truncateSync(source, MAX_FULL_FILE_BYTES + 1)
      await expect(
        service.copyCanvasMirrorAsset({
          projectDirName: PROJECT,
          assetFileName: `${KEY_B}.png`,
          sourcePath: source
        })
      ).rejects.toThrow('Canvas mirror asset source is too large')
      expect(fs.readdirSync(autoSaveRoot)).toEqual([])
    })

    it('refuses a source outside the application roots until the user granted it', async () => {
      const source = writeFile(path.join(outsideRoot, 'secret.png'), 'secret')
      const copy = (): Promise<unknown> =>
        service.copyCanvasMirrorAsset({
          projectDirName: PROJECT,
          assetFileName: `${KEY_B}.png`,
          sourcePath: source
        })

      await expect(copy()).rejects.toThrow('Canvas mirror asset source is not authorized')
      // Nothing was created for the refused call.
      expect(fs.readdirSync(autoSaveRoot)).toEqual([])

      expect(authorizeScopedLocalMediaPath(source)).toBe(true)
      await expect(copy()).resolves.toMatchObject({ status: 'written' })
    })

    it('accepts a source inside a directory the user picked', async () => {
      const source = writeFile(path.join(outsideRoot, 'picked', 'a.png'), 'a')
      expect(authorizeScopedLocalMediaDirectory(path.join(outsideRoot, 'picked'))).toBe(true)
      await expect(
        service.copyCanvasMirrorAsset({
          projectDirName: PROJECT,
          assetFileName: KEY_B,
          sourcePath: source
        })
      ).resolves.toMatchObject({ status: 'written', sizeBytes: 1 })
    })

    it.each([
      ['a relative path', 'Projects/Board-1/out.png'],
      ['parent traversal out of a root', '__PROJECT_ROOT__/../Outside/secret.png'],
      ['a missing file', '__PROJECT_ROOT__/missing.png'],
      ['a directory', '__PROJECT_ROOT__'],
      ['a path with a NUL byte', '__PROJECT_ROOT__/out.png\0.png']
    ])('refuses %s as the source', async (_label, template) => {
      writeFile(path.join(projectRoot, 'out.png'), 'pixels')
      writeFile(path.join(outsideRoot, 'secret.png'), 'secret')
      const sourcePath = template.replace('__PROJECT_ROOT__', projectRoot)
      await expect(
        service.copyCanvasMirrorAsset({ projectDirName: PROJECT, assetFileName: KEY_B, sourcePath })
      ).rejects.toThrow()
      expect(fs.existsSync(path.join(assetDir, KEY_B))).toBe(false)
    })

    it.runIf(supportsSymlinks)(
      'refuses a link inside a root that points outside of it',
      async () => {
        const secret = writeFile(path.join(outsideRoot, 'secret.png'), 'secret')
        const link = path.join(projectRoot, 'innocent.png')
        fs.symlinkSync(secret, link)
        await expect(
          service.copyCanvasMirrorAsset({
            projectDirName: PROJECT,
            assetFileName: KEY_B,
            sourcePath: link
          })
        ).rejects.toThrow('Canvas mirror asset source is not authorized')
        expect(fs.readdirSync(autoSaveRoot)).toEqual([])
      }
    )

    it('rejects overlong and malformed requests at the service boundary', () => {
      const validate = (value: unknown): unknown =>
        validateServiceValue(value, fsSvcDef.copyCanvasMirrorAsset.request)
      expect(
        validate({ projectDirName: PROJECT, assetFileName: KEY_B, sourcePath: '/a/b.png' })
      ).toEqual({ projectDirName: PROJECT, assetFileName: KEY_B, sourcePath: '/a/b.png' })
      expect(() =>
        validate({
          projectDirName: PROJECT,
          assetFileName: KEY_B,
          sourcePath: `/${'a'.repeat(MAX_CANVAS_MIRROR_SOURCE_PATH_LENGTH)}`
        })
      ).toThrow()
      expect(() =>
        validate({ projectDirName: PROJECT, assetFileName: KEY_B, sourcePath: '' })
      ).toThrow()
      expect(() => validate({ projectDirName: PROJECT, assetFileName: KEY_B })).toThrow()
      expect(() =>
        validate({ projectDirName: '../x', assetFileName: KEY_B, sourcePath: '/a' })
      ).toThrow()
    })
  })

  describe('listCanvasMirrorAssets', () => {
    it('lists only non-empty content-keyed files of the board', async () => {
      await expect(service.listCanvasMirrorAssets({ projectDirName: PROJECT })).resolves.toEqual({
        assetFileNames: []
      })
      writeFile(path.join(assetDir, `${KEY_A}.png`), 'a')
      writeFile(path.join(assetDir, KEY_C), 'c')
      writeFile(path.join(assetDir, `${KEY_B}.png`), '')
      writeFile(path.join(assetDir, 'notes.txt'), 'x')
      writeFile(path.join(assetDir, 'images', `${KEY_B}.png`), 'nested')
      const { assetFileNames } = await service.listCanvasMirrorAssets({ projectDirName: PROJECT })
      expect(assetFileNames.sort()).toEqual([`${KEY_A}.png`, KEY_C].sort())
    })
  })

  describe('pruneCanvasMirrorAssets', () => {
    const SNAPSHOT_OLD = 'snapshot-11111111-2222-3333-4444-555555555555'
    const SNAPSHOT_USED = 'snapshot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const prune = (
      keepAssetKeys: string[] = [],
      keepEntryNames: string[] = []
    ): ReturnType<FsSvcImpl['pruneCanvasMirrorAssets']> =>
      service.pruneCanvasMirrorAssets({ projectDirName: PROJECT, keepAssetKeys, keepEntryNames })

    beforeEach(() => {
      writeFile(path.join(assetDir, `${KEY_A}.png`), 'referenced')
      writeFile(path.join(assetDir, `${KEY_B}.png`), 'unreferenced')
      writeFile(path.join(assetDir, KEY_C), 'kept by the caller')
      writeFile(path.join(assetDir, SNAPSHOT_OLD, 'images', 'old.png'), 'old snapshot')
      writeFile(path.join(assetDir, SNAPSHOT_USED, 'images', 'used.png'), 'used snapshot')
      writeFile(path.join(assetDir, 'images', 'legacy.png'), 'oldest layout')
      writeFile(path.join(assetDir, 'notes.txt'), 'not ours')
      writeFile(path.join(assetDir, `.${KEY_B}.png.tmp-1-2-abc`), 'stale temp')
      writeProjectFile([
        { id: '1', type: 'image', src: `assets/${KEY_A}.png` },
        { id: '2', type: 'image', src: `assets\\${SNAPSHOT_USED}\\images\\used.png` }
      ])
    })

    it('keeps everything that is younger than the grace period', async () => {
      await expect(prune()).resolves.toEqual({
        removedAssetFileNames: [],
        removedSnapshotDirNames: []
      })
      expect(listAssetDir()).toHaveLength(8)
    })

    it('removes only unreferenced keyed assets, snapshot folders and stale temporary files', async () => {
      afterGrace()
      const result = await prune([KEY_C])
      expect(result).toEqual({
        removedAssetFileNames: [`${KEY_B}.png`],
        removedSnapshotDirNames: [SNAPSHOT_OLD]
      })
      expect(listAssetDir()).toEqual(
        [`${KEY_A}.png`, KEY_C, SNAPSHOT_USED, 'images', 'notes.txt'].sort()
      )
      expect(
        fs.readFileSync(path.join(assetDir, SNAPSHOT_USED, 'images', 'used.png'), 'utf8')
      ).toBe('used snapshot')
    })

    it('keeps the entries the caller names, by key and by entry name', async () => {
      afterGrace()
      const result = await prune([KEY_B, KEY_C], [SNAPSHOT_OLD])
      expect(result).toEqual({ removedAssetFileNames: [], removedSnapshotDirNames: [] })
      expect(listAssetDir()).toContain(`${KEY_B}.png`)
      expect(listAssetDir()).toContain(SNAPSHOT_OLD)
    })

    it.each([
      ['is missing', null],
      ['is not JSON', '{ "items": ['],
      ['is not an object', '"assets/x"']
    ])('deletes nothing when the project file %s', async (_label, content) => {
      const canvasPath = path.join(autoSaveRoot, PROJECT, 'project.mpcanvas')
      if (content === null) fs.rmSync(canvasPath)
      else fs.writeFileSync(canvasPath, content)
      afterGrace()
      await expect(prune()).resolves.toEqual({
        removedAssetFileNames: [],
        removedSnapshotDirNames: []
      })
      expect(listAssetDir()).toHaveLength(8)
    })

    it('does nothing for a board without a mirror folder and rejects traversal', async () => {
      afterGrace()
      await expect(
        service.pruneCanvasMirrorAssets({
          projectDirName: 'No-Such-Board',
          keepAssetKeys: [],
          keepEntryNames: []
        })
      ).resolves.toEqual({ removedAssetFileNames: [], removedSnapshotDirNames: [] })
      await expect(
        service.pruneCanvasMirrorAssets({
          projectDirName: '..',
          keepAssetKeys: [],
          keepEntryNames: []
        })
      ).rejects.toThrow()
      expect(() =>
        validateServiceValue(
          { projectDirName: PROJECT, keepAssetKeys: ['../x'], keepEntryNames: [] },
          fsSvcDef.pruneCanvasMirrorAssets.request
        )
      ).toThrow()
      expect(() =>
        validateServiceValue(
          { projectDirName: PROJECT, keepAssetKeys: [], keepEntryNames: ['a/b'] },
          fsSvcDef.pruneCanvasMirrorAssets.request
        )
      ).toThrow()
    })

    it.runIf(supportsSymlinks)(
      'never follows or removes symbolic links, and never leaves the board folder',
      async () => {
        const outsideSnapshot = path.join(outsideRoot, 'snapshot-target')
        writeFile(path.join(outsideSnapshot, 'images', 'precious.png'), 'precious')
        const linkedSnapshot = 'snapshot-99999999-8888-7777-6666-555555555555'
        fs.symlinkSync(outsideSnapshot, path.join(assetDir, linkedSnapshot))
        const outsideAsset = writeFile(path.join(outsideRoot, 'asset.png'), 'precious asset')
        const linkedAsset = `b-${'d'.repeat(40)}.png`
        fs.symlinkSync(outsideAsset, path.join(assetDir, linkedAsset))

        afterGrace()
        const result = await prune()
        expect(result.removedSnapshotDirNames).toEqual([SNAPSHOT_OLD])
        expect(result.removedAssetFileNames.sort()).toEqual([`${KEY_B}.png`, KEY_C].sort())
        expect(fs.readFileSync(path.join(outsideSnapshot, 'images', 'precious.png'), 'utf8')).toBe(
          'precious'
        )
        expect(fs.readFileSync(outsideAsset, 'utf8')).toBe('precious asset')
        expect(listAssetDir()).toContain(linkedSnapshot)
        expect(listAssetDir()).toContain(linkedAsset)
      }
    )
  })

  describe('writeTextFile', () => {
    it('still replaces the project file atomically and leaves no temporary file', async () => {
      const outputPath = path.join(autoSaveRoot, PROJECT)
      await service.writeTextFile({ outputPath, filename: 'project.mpcanvas', content: '{"v":1}' })
      await service.writeTextFile({ outputPath, filename: 'project.mpcanvas', content: '{"v":2}' })
      expect(fs.readFileSync(path.join(outputPath, 'project.mpcanvas'), 'utf8')).toBe('{"v":2}')
      expect(fs.readdirSync(outputPath)).toEqual(['project.mpcanvas'])
    })
  })
})
