import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// node:fs is the in-memory filesystem of the node test setup.
const layout = vi.hoisted(() => ({ base: '' }))
const spawned = vi.hoisted(() => ({ calls: [] as unknown[][] }))

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => `${layout.base}/electron-${name}`)
  }
}))
vi.mock('../config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    projectRoot: `${layout.base}/Projects`,
    autoSaveRoot: `${layout.base}/AutoSave`
  })
}))
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  const execFile = (...args: unknown[]) => {
    spawned.calls.push(args)
    const callback = args[args.length - 1] as (error: null, value: unknown) => void
    callback(null, { stdout: '{"trigger_words":"blue hair","source":"sidecar"}', stderr: '' })
  }
  return { ...actual, execFile, default: { ...actual, execFile } }
})

import { FsSvcImpl } from './svcFsImpl'
import {
  authorizeLocalMediaImportSourcePathAsync,
  authorizeScopedLocalMediaDirectory,
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest,
  setLocalMediaGrantExcludedFolders
} from '../localMediaAccess'
import { getLocalMediaAllowedRoots } from '../localMediaAllowedRoots'
import { isLocalFileNotFoundError, LOCAL_FILE_UNAVAILABLE_ERROR } from '@shared/api/svcFs'
import {
  createImportSourceGate,
  importSourceRootKey,
  runImportSourceOperation,
  type ImportSourceGate
} from '../llmProxy/managedMediaStore'

const NOT_AUTHORIZED = 'Local file path is not authorized'

let base: string
let service: FsSvcImpl
const p = (...segments: string[]): string => path.join(base, ...segments)
const write = (filePath: string, content: string | Buffer = 'x'): string => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

beforeEach(() => {
  base = path.join(process.cwd(), '.magicpot-trash', 'sec3-renderer-reads', `${Math.random()}`)
  layout.base = base
  spawned.calls.length = 0
  fs.mkdirSync(p('electron-userData'), { recursive: true })
  // The user's secrets, outside every application root and grant.
  write(p('home', '.ssh', 'id_rsa'), 'PRIVATE KEY')
  write(p('home', '.config', 'app', 'credentials.json'), '{"token":"secret"}')
  service = new FsSvcImpl({
    getConfiguredReadRoots: async () => ({
      projectDirs: [p('CustomProjects')],
      loraDirs: [p('models', 'loras')]
    })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  clearScopedLocalMediaPathsForTest()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('svcFs reads of paths the renderer names (SEC-3)', () => {
  it('refuses a file outside every root and grant, and says the same whether it exists', async () => {
    const open = vi.spyOn(fsPromises, 'open')
    for (const fullPath of [p('home', '.ssh', 'id_rsa'), p('home', '.ssh', 'missing')]) {
      await expect(service.readTextFile({ fullPath })).rejects.toThrow(NOT_AUTHORIZED)
      await expect(service.readFileFromPath({ fullPath })).rejects.toThrow(NOT_AUTHORIZED)
      await expect(service.readFileSlice({ fullPath, length: 4 })).rejects.toThrow(NOT_AUTHORIZED)
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses a link inside a granted folder or a root that points outside', async () => {
    expect(authorizeScopedLocalMediaDirectory(p('Desktop'))).toBe(false)
    fs.mkdirSync(p('Desktop'), { recursive: true })
    expect(authorizeScopedLocalMediaDirectory(p('Desktop'))).toBe(true)
    fs.symlinkSync(p('home', '.ssh', 'id_rsa'), p('Desktop', 'photo.png'))
    fs.mkdirSync(p('Projects', 'board'), { recursive: true })
    fs.symlinkSync(p('home', '.ssh', 'id_rsa'), p('Projects', 'board', 'project.mpcanvas'))

    await expect(service.readFileFromPath({ fullPath: p('Desktop', 'photo.png') })).rejects.toThrow(
      /not found|not authorized/
    )
    await expect(
      service.readTextFile({ fullPath: p('Projects', 'board', 'project.mpcanvas') })
    ).rejects.toThrow(/not found|not authorized/)
  })

  it('lists nothing outside the roots and grants, without reading the folder', async () => {
    const readdir = vi.spyOn(fsPromises, 'readdir')
    await expect(
      service.listFilesInFolder({ folderPath: p('home'), recursive: true })
    ).resolves.toEqual({ files: [] })
    await expect(service.listImagesInFolder({ folderPath: p('home', '.ssh') })).resolves.toEqual({
      images: []
    })
    expect(readdir).not.toHaveBeenCalled()
  })

  it('keeps the canvas project files readable, and reports a missing one as missing', async () => {
    // Project file, autosave mirror and the configured project folder (download_dir).
    for (const fullPath of [
      write(p('Projects', '.board__board', 'project.mpcanvas'), '{"items":[]}'),
      write(p('AutoSave', '.board__board', 'project.mpcanvas'), '{"items":[]}'),
      write(p('CustomProjects', '.board__board', 'project.mpcanvas'), '{"items":[]}')
    ]) {
      await expect(service.readTextFile({ fullPath })).resolves.toEqual({
        content: '{"items":[]}',
        filename: 'project.mpcanvas'
      })
    }
    // canvasStorage skips a missing autosave file by this message (isMissingMirrorFileError).
    const missing = p('AutoSave', '.other__other', 'project.mpcanvas')
    await expect(service.readTextFile({ fullPath: missing })).rejects.toThrow(
      `File not found: ${missing}`
    )
    // The project asset check lists the project folder.
    write(p('Projects', '.board__board', 'assets', 'b-1.png'))
    const { files } = await service.listFilesInFolder({
      folderPath: p('Projects', '.board__board'),
      recursive: true
    })
    expect(files.map((file) => file.fullPath).sort()).toEqual([
      p('Projects', '.board__board', 'assets', 'b-1.png'),
      p('Projects', '.board__board', 'project.mpcanvas')
    ])
  })

  it('reads the bytes of local-media files the app owns or the user dropped', async () => {
    const managed = write(p('electron-userData', '.chat_media', 'a.png'), 'managed')
    const dropped = write(p('Desktop', 'dropped.svg'), '<svg/>')
    expect(authorizeScopedLocalMediaPath(dropped)).toBe(true)

    await expect(service.readFileFromPath({ fullPath: managed })).resolves.toMatchObject({
      filename: 'a.png'
    })
    // The page names a file the way local-media URLs spell it on POSIX: //dir/file (on Windows
    // that spelling is a network path, and the drive form is the one the page sends).
    await expect(
      service.readFileFromPath({
        fullPath: process.platform === 'win32' ? dropped : `/${dropped}`
      })
    ).resolves.toEqual({
      data: new Uint8Array(Buffer.from('<svg/>')),
      filename: 'dropped.svg'
    })
  })

  it('reads as media only the media folders of the app data, never its config, grants, skills or profile', async () => {
    const userData = p('electron-userData')
    const media = [
      '.chat_media/task/a.png',
      '.chat_media/derivatives/b.webp',
      'project-canvas-thumbnail-cache/k/256.webp',
      'qapp-input-images/q.png',
      '.report_bundles/bundle-1/images/r.png',
      'report-bundles/0123/manifest.json'
    ].map((relative) => write(path.join(userData, relative), 'media'))
    const stored = [
      write(p('Projects', 'board', 'assets', 'p.png'), 'media'),
      write(p('AutoSave', 'board', 'assets', 's.png'), 'media')
    ]
    const secrets = [
      'config.json',
      'local-media-grants.json',
      'customSkills/cat/cat.skill.json',
      'customSkills/cat/cat.png',
      'Cookies',
      'Preferences',
      'Local Storage/leveldb/000003.log',
      'IndexedDB/file__0.indexeddb.leveldb/000003.log'
    ].map((relative) => write(path.join(userData, relative), '{"api_key":"sk-secret"}'))
    const refusesSecrets = async () => {
      for (const file of secrets) {
        await expect(service.readFileFromPath({ fullPath: file })).rejects.toThrow(NOT_AUTHORIZED)
        await expect(service.readImageFromPath({ fullPath: file })).rejects.toThrow(
          /not authorized/
        )
        // A board item naming it is never copied into the project's shared assets.
        await expect(
          service.copyCanvasMirrorAsset({
            projectDirName: 'board',
            assetFileName: `f-${'a'.repeat(40)}.png`,
            sourcePath: file
          })
        ).rejects.toThrow(/not authorized/)
        // Nor imported into managed media (serverIpc's import policy).
        await expect(
          authorizeLocalMediaImportSourcePathAsync(file, getLocalMediaAllowedRoots())
        ).resolves.toBeNull()
      }
    }
    const readsMedia = async () => {
      for (const file of [...media, ...stored]) {
        await expect(service.readFileFromPath({ fullPath: file })).resolves.toMatchObject({
          filename: path.basename(file)
        })
        await expect(
          authorizeLocalMediaImportSourcePathAsync(file, getLocalMediaAllowedRoots())
        ).resolves.toMatchObject({ canonicalPath: path.resolve(fs.realpathSync(file)) })
      }
    }
    await refusesSecrets()
    await readsMedia()
    // The user once granted a folder that holds the app data (their home folder): the grant
    // never reaches into it, as at startup.
    setLocalMediaGrantExcludedFolders([userData])
    expect(authorizeScopedLocalMediaDirectory(base)).toBe(true)
    await refusesSecrets()
    await readsMedia()
    // Nothing was copied into a project's assets.
    expect(fs.readdirSync(p('Projects', 'board', 'assets'))).toEqual(['p.png'])
    expect(fs.readdirSync(p('AutoSave', 'board', 'assets'))).toEqual(['s.png'])
  })

  it('reads in the LoRA folder only what the trigger-word lookup reads', async () => {
    const lora = p('models', 'loras')
    const model = write(path.join(lora, 'sub', 'style.safetensors'), Buffer.from([1, 0, 0, 0]))
    const text = write(path.join(lora, 'sub', 'style.txt'), 'blue hair')
    const civitai = write(path.join(lora, 'sub', 'style.civitai.info'), '{}')
    const metadata = write(path.join(lora, 'sub', 'style.metadata.json'), '{}')
    const other = write(path.join(lora, 'notes.pem'), 'KEY')
    fs.symlinkSync(p('home', '.config', 'app', 'credentials.json'), path.join(lora, 'evil.json'))
    // A link whose name fits but whose file does not: the canonical file decides.
    fs.symlinkSync(other, path.join(lora, 'notes.txt'))

    const { files } = await service.listFilesInFolder({
      folderPath: lora,
      extensions: ['.safetensors'],
      recursive: true
    })
    expect(files.map((file) => file.fullPath)).toEqual([model])
    await expect(service.readTextFile({ fullPath: text })).resolves.toMatchObject({
      content: 'blue hair'
    })
    await expect(service.readTextFile({ fullPath: civitai })).resolves.toMatchObject({
      content: '{}'
    })
    await expect(service.readTextFile({ fullPath: metadata })).resolves.toMatchObject({
      content: '{}'
    })
    await expect(service.readFileSlice({ fullPath: model, length: 8 })).resolves.toMatchObject({
      fileSizeBytes: 4
    })

    await expect(service.readTextFile({ fullPath: other })).rejects.toThrow(NOT_AUTHORIZED)
    await expect(service.readFileSlice({ fullPath: text, length: 8 })).rejects.toThrow(
      NOT_AUTHORIZED
    )
    // The bytes of a file: only what the local-media protocol serves, not the LoRA folder.
    await expect(service.readFileFromPath({ fullPath: model })).rejects.toThrow(NOT_AUTHORIZED)
    await expect(service.readFileFromPath({ fullPath: text })).rejects.toThrow(NOT_AUTHORIZED)
    await expect(service.readTextFile({ fullPath: path.join(lora, 'evil.json') })).rejects.toThrow(
      /not found|not authorized/
    )
    await expect(service.readTextFile({ fullPath: path.join(lora, 'notes.txt') })).rejects.toThrow(
      /not found|not authorized/
    )
  })

  it('runs the LoRA sidecar only on an authorized folder and a name inside it', async () => {
    const sidecar = path.join(
      process.cwd(),
      'bin',
      'lora-trigger-sidecar',
      process.platform === 'win32' ? 'lora-trigger-sidecar.exe' : 'lora-trigger-sidecar'
    )
    write(sidecar, 'binary')
    const lora = p('models', 'loras')
    write(path.join(lora, 'style.safetensors'))
    const unavailable = { triggerWords: '', source: '', nativeAvailable: false }
    try {
      await expect(
        service.readLoraTriggerWordsNative({ loraDir: p('home'), loraName: '.ssh/id_rsa' })
      ).resolves.toEqual(unavailable)
      for (const loraName of ['../../home/.ssh/id_rsa', '/etc/passwd', 'C:\\x', 'a\0b']) {
        await expect(
          service.readLoraTriggerWordsNative({ loraDir: lora, loraName })
        ).resolves.toEqual(unavailable)
      }
      expect(spawned.calls).toEqual([])

      await expect(
        service.readLoraTriggerWordsNative({ loraDir: lora, loraName: 'style.safetensors' })
      ).resolves.toEqual({ triggerWords: 'blue hair', source: 'sidecar', nativeAvailable: true })
      expect(spawned.calls[0]?.[1]).toEqual([
        '--lora-dir',
        lora,
        '--lora-name',
        'style.safetensors'
      ])
    } finally {
      fs.rmSync(path.join(process.cwd(), 'bin'), { recursive: true, force: true })
    }
  })

  it('never says "File not found" for a file it could not check: gate full, no answer', async () => {
    const autosave = write(p('AutoSave', '.board__board', 'project.mpcanvas'), '{"items":[]}')
    const missing = p('AutoSave', '.other__other', 'project.mpcanvas')
    // Every slot of the renderer path gate is held by calls on another share that never return.
    const gate = createImportSourceGate({ onSaturated: () => undefined })
    await Promise.all(
      ['/Volumes/nas/a.png', '/Volumes/nas2/b.png', '/mnt/x/c.png'].map((file) =>
        runImportSourceOperation(() => new Promise<never>(() => undefined), {
          key: importSourceRootKey(file),
          file,
          timeoutMs: 5,
          gate
        }).catch(() => undefined)
      )
    )
    expect(gate.overdue).toBe(3)
    const saturated = new FsSvcImpl({
      getConfiguredReadRoots: async () => ({ projectDirs: [], loraDirs: [] }),
      rendererPathGate: gate
    })
    for (const fullPath of [autosave, missing]) {
      const error = await saturated.readTextFile({ fullPath }).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toMatch(/file not found/i)
      expect((error as Error).message).toContain(LOCAL_FILE_UNAVAILABLE_ERROR)
      expect(isLocalFileNotFoundError(error)).toBe(false)
    }
    // A refusing gate (the shape of one that is full) reads the same.
    const refusing: ImportSourceGate = {
      acquire: (_key, _start, refuse) => {
        refuse()
        return () => false
      },
      active: 3,
      overdue: 3
    }
    await expect(
      new FsSvcImpl({
        getConfiguredReadRoots: async () => ({ projectDirs: [], loraDirs: [] }),
        rendererPathGate: refusing
      }).readTextFile({ fullPath: autosave })
    ).rejects.toThrow(LOCAL_FILE_UNAVAILABLE_ERROR)

    // With a healthy gate: the file reads, and only a file that is really not there is missing.
    await expect(service.readTextFile({ fullPath: autosave })).resolves.toMatchObject({
      content: '{"items":[]}'
    })
    const notFound = await service.readTextFile({ fullPath: missing }).catch((caught) => caught)
    expect(isLocalFileNotFoundError(notFound)).toBe(true)
    // Outside every place it may read, a refusal tells nothing about the file, whatever happens.
    await expect(saturated.readTextFile({ fullPath: p('home', '.ssh', 'id_rsa') })).rejects.toThrow(
      NOT_AUTHORIZED
    )
  })

  it('reads a skill resource only in the custom skill folder or where the user granted', async () => {
    const userData = p('electron-userData')
    const resource = write(path.join(userData, 'customSkills', 'Writing', 'guide.md'), '# guide')
    const definition = write(
      path.join(userData, 'customSkills', 'Writing', 'other.skill.json'),
      '{"apiKey":"sk-other-skill"}'
    )
    const config = write(path.join(userData, 'config.json'), '{"api_key":"sk-secret"}')
    const grants = write(path.join(userData, 'local-media-grants.json'), '{"version":1}')
    const chat = write(path.join(userData, 'chat-history', 'thread.json'), '{"messages":[]}')
    const picked = write(p('Desktop', 'notes', 'rules.md'), '# picked')

    await expect(service.readSkillResourceFile({ fullPath: resource })).resolves.toEqual({
      content: '# guide',
      filename: 'guide.md'
    })
    // Outside the skill folder (or a skill definition in it): not a place it may read at all.
    for (const fullPath of [config, grants, chat, definition, p('home', '.ssh', 'id_rsa')]) {
      await expect(service.readSkillResourceFile({ fullPath })).rejects.toThrow(NOT_AUTHORIZED)
    }
    // A file the user picked is a resource they chose.
    expect(authorizeScopedLocalMediaPath(picked)).toBe(true)
    await expect(service.readSkillResourceFile({ fullPath: picked })).resolves.toMatchObject({
      content: '# picked'
    })
    // Even a grant of a folder that holds the app's data does not open its config.
    expect(authorizeScopedLocalMediaDirectory(base)).toBe(true)
    for (const fullPath of [config, grants, chat, definition]) {
      await expect(service.readSkillResourceFile({ fullPath })).rejects.toThrow(
        /not found|not authorized/
      )
    }
    // A link in the skill folder that points at the config is refused too.
    fs.symlinkSync(config, path.join(userData, 'customSkills', 'Writing', 'config.md'))
    await expect(
      service.readSkillResourceFile({
        fullPath: path.join(userData, 'customSkills', 'Writing', 'config.md')
      })
    ).rejects.toThrow(/not found|not authorized/)
  })

  it('reads no app secret, chat data or other file through the text and slice reads', async () => {
    const userData = p('electron-userData')
    const config = write(path.join(userData, 'config.json'), '{"api_key":"sk-secret"}')
    const grants = write(path.join(userData, 'local-media-grants.json'), '{"version":1}')
    const chat = write(path.join(userData, 'chat-history', 'thread.json'), '{"messages":[]}')
    const resource = write(path.join(userData, 'customSkills', 'pkg', 'guide.md'), '# guide')
    const projectNote = write(p('CustomProjects', 'notes', 'secret.env'), 'TOKEN=1')
    const autosaveOther = write(p('AutoSave', '.board__board', 'notes.json'), '{}')
    for (const fullPath of [config, grants, chat, resource, projectNote, autosaveOther]) {
      await expect(service.readTextFile({ fullPath })).rejects.toThrow(/not found|not authorized/)
      await expect(service.readFileSlice({ fullPath, length: 64 })).rejects.toThrow(
        /not found|not authorized/
      )
    }
    // Not through a grant either: no text read needs one.
    expect(authorizeScopedLocalMediaDirectory(base)).toBe(true)
    for (const fullPath of [config, grants, chat]) {
      await expect(service.readTextFile({ fullPath })).rejects.toThrow(/not found|not authorized/)
      await expect(service.readFileSlice({ fullPath, length: 64 })).rejects.toThrow(
        /not found|not authorized/
      )
    }
    // The canvas project files stay readable.
    const project = write(p('CustomProjects', '.board__board', 'project.mpcanvas'), '{"items":[]}')
    await expect(service.readTextFile({ fullPath: project })).resolves.toMatchObject({
      content: '{"items":[]}'
    })
  })
})
