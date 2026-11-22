import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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

import { Tripo3DClient } from './tripo3dClient'
import {
  authorizeScopedLocalMediaPath,
  clearScopedLocalMediaPathsForTest
} from '../localMediaAccess'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64'
)

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })

const write = (filePath: string, content: Buffer | string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}
const localMediaUrl = (filePath: string) =>
  pathToFileURL(filePath).href.replace(/^file:/, 'local-media:')

/** A completed image-to-model run: upload, submit, poll. */
const successfulRun = () =>
  vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ code: 0, data: { image_token: 'image-token-1' } }))
    .mockResolvedValueOnce(jsonResponse({ code: 0, data: { task_id: 'task-1' } }))
    .mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        data: {
          task_id: 'task-1',
          type: 'image_to_model',
          status: 'success',
          progress: 100,
          output: { model: { url: 'https://cdn.example.com/object.glb' } }
        }
      })
    )

const generate = (fetchImpl: unknown, url: string) =>
  new Tripo3DClient('tripo-key', 'https://api.tripo3d.ai/v2/openapi', {
    fetchImpl: fetchImpl as typeof fetch,
    pollIntervalMs: 0
  }).generateFromMessages(
    [
      {
        role: 'user',
        content: '',
        attachments: [{ type: 'image', url, mimeType: 'image/png', fileName: 'reference.png' }]
      }
    ],
    'SubmitHunyuanTo3DRapidJob',
    { Model: '3.0', GenerateType: 'Geometry', EnablePBR: false }
  )

const uploadedBytes = async (fetchMock: ReturnType<typeof vi.fn>): Promise<Buffer> => {
  const form = fetchMock.mock.calls[0][1].body as FormData
  return Buffer.from(await (form.get('file') as Blob).arrayBuffer())
}

describe('Tripo3DClient local image attachments', () => {
  beforeEach(() => {
    layout.base = path.join(process.cwd(), '.magicpot-trash', 'tripo-local', `${Math.random()}`)
  })
  afterEach(() => {
    clearScopedLocalMediaPathsForTest()
    fs.rmSync(layout.base, { recursive: true, force: true })
  })

  it('uploads only a file the local-media protocol serves, never the app config', async () => {
    const userData = path.join(layout.base, 'userData')
    const config = write(path.join(userData, 'config.json'), '{"api_key":"sk-secret"}')
    const skill = write(path.join(userData, 'customSkills', 'cat', 'cat.png'), PNG)
    const elsewhere = write(path.join(layout.base, 'home', '.ssh', 'id_rsa.png'), PNG)
    for (const url of [
      localMediaUrl(config),
      pathToFileURL(config).href,
      localMediaUrl(skill),
      localMediaUrl(elsewhere)
    ]) {
      const fetchMock = successfulRun()
      await expect(generate(fetchMock, url)).rejects.toThrow(/not a file the app may read/)
      // Nothing was sent anywhere.
      expect(fetchMock).not.toHaveBeenCalled()
    }

    // A managed chat image (a generated concept image) and a file the user picked still go.
    const managed = write(path.join(userData, '.chat_media', 'task', 'concept.png'), PNG)
    const picked = write(path.join(layout.base, 'Pictures', 'picked.png'), PNG)
    expect(authorizeScopedLocalMediaPath(picked)).toBe(true)
    for (const file of [managed, picked]) {
      const fetchMock = successfulRun()
      await expect(generate(fetchMock, localMediaUrl(file))).resolves.toContain(
        'https://cdn.example.com/object.glb'
      )
      expect(await uploadedBytes(fetchMock)).toEqual(PNG)
    }
  })
})
