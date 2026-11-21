import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// node:fs is the in-memory filesystem of the node test setup.
const layout = vi.hoisted(() => ({ base: '' }))
const shellMock = vi.hoisted(() => ({ openPath: vi.fn(async () => '') }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn((name: string) => `${layout.base}/electron-${name}`) },
  clipboard: {},
  nativeImage: {},
  shell: shellMock
}))
vi.mock('../queue/taskQueue', () => ({ getQueue: vi.fn() }))
vi.mock('../comfy/http', () => ({ ComfyHttpCli: vi.fn() }))
vi.mock('../comfy/logic', () => ({ waitPromptId: vi.fn(), ComfyCliWrapper: vi.fn() }))

import { PhotoshopSvcImpl } from './svcPhotoshopImpl'

let base: string
const p = (...segments: string[]): string => path.join(base, ...segments)

beforeEach(() => {
  base = path.join(process.cwd(), '.magicpot-trash', 'svc-photoshop', `${Math.random()}`)
  layout.base = base
  fs.mkdirSync(p('electron-temp'), { recursive: true })
  shellMock.openPath.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(base, { recursive: true, force: true })
})

describe.runIf(process.platform === 'linux')('sendImageToPhotoshop', () => {
  it('reads no file the page names: only the bytes of a data URL', async () => {
    const secret = p('home', '.ssh', 'id_rsa')
    fs.mkdirSync(path.dirname(secret), { recursive: true })
    fs.writeFileSync(secret, 'PRIVATE KEY')
    const readFile = vi.spyOn(fsPromises, 'readFile')
    const service = new PhotoshopSvcImpl()

    for (const imageUrl of [`file://${secret}`, secret, 'blob:file:///x']) {
      const result = await service.sendImageToPhotoshop({ imageUrl, fileName: 'out.png' })
      expect(result).toMatchObject({ success: false, error: expect.stringMatching(/data URL/) })
    }
    expect(readFile).not.toHaveBeenCalled()
    expect(shellMock.openPath).not.toHaveBeenCalled()

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const sent = await service.sendImageToPhotoshop({
      imageUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      fileName: 'canvas-selection.png'
    })
    expect(sent.success).toBe(true)
    expect(path.basename(sent.filePath!)).toBe('canvas-selection.png')
    expect(fs.readFileSync(sent.filePath!)).toEqual(bytes)
    expect(shellMock.openPath).toHaveBeenCalledWith(sent.filePath)
  })

  it('keeps the exported file in its temp folder whatever name the page sends', async () => {
    const service = new PhotoshopSvcImpl()
    const sent = await service.sendImageToPhotoshop({
      imageUrl: 'data:image/png;base64,AAEC',
      fileName: '../../escape.png'
    })
    expect(sent.success).toBe(true)
    expect(path.basename(sent.filePath!)).toMatch(/^comfyui-image-\d+\.png$/)
    expect(fs.existsSync(p('escape.png'))).toBe(false)
    expect(sent.filePath!.startsWith(p('electron-temp'))).toBe(true)
  })
})
