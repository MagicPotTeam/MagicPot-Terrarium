import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// node:fs is the in-memory filesystem of the node test setup. Here the configured folders come
// from main's own config (readConfiguredReadRootsFromConfig), not from an injected function.
const layout = vi.hoisted(() => ({ base: '', config: null as Record<string, unknown> | null }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
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
vi.mock('../config/config', () => ({
  getConfig: () => {
    if (!layout.config) throw new Error('Config not initialized')
    return layout.config
  }
}))
vi.mock('@shared/api/svcFs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/api/svcFs')>()),
  // Small enough to reach in a test.
  MAX_LISTED_FOLDER_ENTRIES: 5
}))

import { DEFAULT_CONFIG } from '@shared/config/config'
import { FsSvcImpl, resetConfiguredReadRootsFailureLogForTest } from './svcFsImpl'
import { clearScopedLocalMediaPathsForTest } from '../localMediaAccess'

let base: string
const p = (...segments: string[]): string => path.join(base, ...segments)
const write = (filePath: string, content = 'x'): string => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

beforeEach(() => {
  base = path.join(process.cwd(), '.magicpot-trash', 'svc-fs-configured-roots', `${Math.random()}`)
  layout.base = base
  layout.config = null
  fs.mkdirSync(p('electron-userData'), { recursive: true })
  resetConfiguredReadRootsFailureLogForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearScopedLocalMediaPathsForTest()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('the configured folders of renderer reads, from main config', () => {
  it('reads the configured project folder and LoRA folder named in the config', async () => {
    layout.config = {
      ...structuredClone(DEFAULT_CONFIG),
      download_dir: p('MyProjects'),
      lora_dir: p('models', 'loras')
    }
    const project = write(p('MyProjects', '.board__board', 'project.mpcanvas'), '{"items":[]}')
    const sidecar = write(p('models', 'loras', 'style.txt'), 'blue hair')
    write(p('models', 'loras', 'style.safetensors'))
    const service = new FsSvcImpl()

    await expect(service.readTextFile({ fullPath: project })).resolves.toMatchObject({
      content: '{"items":[]}'
    })
    await expect(service.readTextFile({ fullPath: sidecar })).resolves.toMatchObject({
      content: 'blue hair'
    })
    const { files } = await service.listFilesInFolder({
      folderPath: p('models', 'loras'),
      extensions: ['.safetensors'],
      recursive: true
    })
    expect(files.map((file) => file.filename)).toEqual(['style.safetensors'])
  })

  it('refuses those reads and says so once in the log when the config cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const project = write(p('MyProjects', '.board__board', 'project.mpcanvas'), '{"items":[]}')
    const service = new FsSvcImpl()

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.readTextFile({ fullPath: project })).rejects.toThrow(
        'Local file path is not authorized'
      )
    }
    const logged = warn.mock.calls.filter(([message]) =>
      String(message).includes('configured project and LoRA folders')
    )
    expect(logged).toHaveLength(1)
    // The app's own canvas files still read.
    const autosave = write(p('AutoSave', '.board__board', 'project.mpcanvas'), '{"items":[1]}')
    await expect(service.readTextFile({ fullPath: autosave })).resolves.toMatchObject({
      content: '{"items":[1]}'
    })
  })

  it('stops a listing at MAX_LISTED_FOLDER_ENTRIES entries and says it is not complete', async () => {
    layout.config = { ...structuredClone(DEFAULT_CONFIG), download_dir: p('MyProjects') }
    for (let index = 0; index < 4; index += 1) {
      write(p('MyProjects', 'board', `a${index}.png`))
      write(p('MyProjects', 'board', 'nested', `b${index}.png`))
    }
    const service = new FsSvcImpl()

    const listing = await service.listFilesInFolder({
      folderPath: p('MyProjects', 'board'),
      recursive: true
    })
    expect(listing.truncated).toBe(true)
    expect(listing.files.length).toBeLessThanOrEqual(5)
    const small = await service.listFilesInFolder({
      folderPath: p('MyProjects', 'board', 'nested')
    })
    expect(small).toEqual({ files: expect.any(Array) })
    expect(small.files).toHaveLength(4)
  })
})
