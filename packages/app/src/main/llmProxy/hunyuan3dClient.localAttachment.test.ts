import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// node:fs is the in-memory filesystem of the node test setup.
const layout = vi.hoisted(() => ({ base: '' }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => `${layout.base}/${name}` }
}))
vi.mock('../config/userDataDirectory', () => ({
  getCurrentUserDataDirectoryState: () => ({
    projectRoot: `${layout.base}/Projects`,
    autoSaveRoot: `${layout.base}/AutoSave`
  })
}))
vi.mock('tencentcloud-sdk-nodejs-ai3d', () => ({ ai3d: { v20250513: { Client: vi.fn() } } }))

import { Hunyuan3DClient } from './hunyuan3dClient'
import { clearScopedLocalMediaPathsForTest } from '../localMediaAccess'

/** A 512 x 512 PNG (Hunyuan reads its size from the IHDR chunk). */
const createPng = (): Buffer => {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(512, 0)
  ihdr.writeUInt32BE(512, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body)
})

const write = (filePath: string, content: Buffer | string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}
const localMediaUrl = (filePath: string) =>
  pathToFileURL(filePath).href.replace(/^file:/, 'local-media:')

describe('Hunyuan3DClient local image attachments', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    layout.base = path.join(process.cwd(), '.magicpot-trash', 'hunyuan-local', `${Math.random()}`)
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearScopedLocalMediaPathsForTest()
    fs.rmSync(layout.base, { recursive: true, force: true })
  })

  const generate = (url: string) =>
    new Hunyuan3DClient('hy-token', 'https://proxy.example').generateFromMessages(
      [
        {
          role: 'user',
          content: 'a pencil sketch of a desk lamp',
          attachments: [{ type: 'image', url, mimeType: 'image/png', fileName: 'sketch.png' }]
        }
      ],
      'SubmitHunyuanTo3DProJob',
      { Model: '3.1', GenerateType: 'Sketch' }
    )

  it('sends only a file the local-media protocol serves, never the app config', async () => {
    const png = createPng()
    const userData = path.join(layout.base, 'userData')
    const config = write(path.join(userData, 'config.json'), '{"api_key":"sk-secret"}')
    const profile = write(path.join(userData, 'Local Storage', 'leveldb', 'a.png'), png)
    const elsewhere = write(path.join(layout.base, 'home', 'secret.png'), png)
    for (const url of [
      localMediaUrl(config),
      pathToFileURL(config).href,
      localMediaUrl(profile),
      pathToFileURL(elsewhere).href
    ]) {
      await expect(generate(url)).rejects.toThrow(/not a file the app may read/)
      expect(fetchMock).not.toHaveBeenCalled()
    }

    // A managed chat image still goes.
    const managed = write(path.join(userData, '.chat_media', 'task', 'sketch.png'), png)
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ Response: { JobId: 'job-1' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            Status: 'DONE',
            ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/download?id=job-1' }]
          }
        })
      )
    const result = generate(localMediaUrl(managed))
    await vi.advanceTimersByTimeAsync(5000)
    await expect(result).resolves.toContain('https://example.com/download?id=job-1')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      ImageBase64: png.toString('base64')
    })
  })
})
