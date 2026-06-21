import { describe, expect, it, vi } from 'vitest'
import { Tripo3DClient } from './tripo3dClient'

const jsonResponse = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  })

describe('Tripo3DClient', () => {
  it('submits a text-to-model task and formats the completed model link', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { task_id: 'task-text-1' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            task_id: 'task-text-1',
            type: 'text_to_model',
            status: 'success',
            progress: 100,
            output: {
              pbr_model: 'https://cdn.example.com/cat.glb',
              rendered_image: 'https://cdn.example.com/cat.png'
            }
          }
        })
      )

    const client = new Tripo3DClient('tripo-key', 'https://api.tripo3d.ai', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 0
    })

    const content = await client.generateFromMessages(
      [{ role: 'user', content: 'a small ceramic cat' }],
      'SubmitHunyuanTo3DProJob',
      {
        Model: '3.1',
        GenerateType: 'Normal',
        FaceCount: 500000,
        EnablePBR: true
      }
    )

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.tripo3d.ai/v2/openapi/task',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tripo-key',
          'Content-Type': 'application/json'
        })
      })
    )
    const submitBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(submitBody).toEqual(
      expect.objectContaining({
        type: 'text_to_model',
        prompt: 'a small ceramic cat',
        model_version: 'v3.1-20260211',
        texture: true,
        pbr: true,
        face_limit: 500000
      })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.tripo3d.ai/v2/openapi/task/task-text-1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer tripo-key'
        })
      })
    )
    expect(content).toContain('[Generated 3D Model](https://cdn.example.com/cat.glb)')
    expect(content).toContain('![Generated Preview](https://cdn.example.com/cat.png)')
    expect(content).toContain('[Tripo3D] Task ID: task-text-1')
  })

  it.each([
    ['international studio', 'https://studio.tripo3d.ai/workspace', 'https://api.tripo3d.ai'],
    ['mainland studio', 'https://studio.tripo3d.com/workspace', 'https://api.tripo3d.com']
  ])('normalizes %s URLs to matching OpenAPI hosts', async (_label, baseUrl, apiHost) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { task_id: 'task-studio-1' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            task_id: 'task-studio-1',
            type: 'text_to_model',
            status: 'success',
            progress: 100,
            output: {
              model: 'https://cdn.example.com/studio.glb'
            }
          }
        })
      )

    const client = new Tripo3DClient('tripo-key', baseUrl, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 0
    })

    await client.generateFromMessages(
      [{ role: 'user', content: 'a small ceramic cat' }],
      'SubmitHunyuanTo3DProJob'
    )

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${apiHost}/v2/openapi/task`,
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('uploads local image data before submitting an image-to-model task', async () => {
    const pngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { image_token: 'image-token-1' } }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { task_id: 'task-image-1' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            task_id: 'task-image-1',
            type: 'image_to_model',
            status: 'success',
            progress: 100,
            output: {
              model: { url: 'https://cdn.example.com/object.glb' }
            }
          }
        })
      )

    const client = new Tripo3DClient('tripo-key', 'https://api.tripo3d.ai/v2/openapi', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 0
    })

    const content = await client.generateFromMessages(
      [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: pngDataUrl,
              mimeType: 'image/png',
              fileName: 'reference.png'
            }
          ]
        }
      ],
      'SubmitHunyuanTo3DRapidJob',
      {
        Model: '3.0',
        GenerateType: 'Geometry',
        EnablePBR: false
      }
    )

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.tripo3d.ai/v2/openapi/upload/sts',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tripo-key'
        }),
        body: expect.any(FormData)
      })
    )
    const submitBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(submitBody).toEqual(
      expect.objectContaining({
        type: 'image_to_model',
        file: {
          type: 'png',
          file_token: 'image-token-1'
        },
        model_version: 'v3.0-20250812',
        texture: false,
        pbr: false
      })
    )
    expect(content).toContain('[Generated 3D Model](https://cdn.example.com/object.glb)')
  })

  it('submits texture model tasks with an original Tripo task id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { task_id: 'task-texture-1' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            task_id: 'task-texture-1',
            type: 'texture_model',
            status: 'success',
            progress: 100,
            output: {
              pbr_model: 'https://cdn.example.com/textured.glb'
            }
          }
        })
      )
    const client = new Tripo3DClient('tripo-key', 'https://api.tripo3d.ai/v2/openapi', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 0
    })

    const content = await client.generateFromMessages(
      [{ role: 'user', content: 'https://example.com/model.glb\nweathered bronze' }],
      'SubmitTextureTo3DJob',
      {
        Model: '3.0',
        EnablePBR: true,
        OriginalTaskId: 'task-text-1'
      }
    )

    const submitBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(submitBody).toEqual(
      expect.objectContaining({
        type: 'texture_model',
        original_model_task_id: 'task-text-1',
        texture_prompt: { text: 'weathered bronze' },
        model_version: 'v3.0-20250812',
        texture: true,
        pbr: true
      })
    )
    expect(content).toContain('[Generated 3D Model](https://cdn.example.com/textured.glb)')
  })

  it('submits advanced image generation tasks and formats image results', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { task_id: 'task-image-gen-1' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            task_id: 'task-image-gen-1',
            type: 'generate_image',
            status: 'success',
            progress: 100,
            output: {
              generated_image: 'https://cdn.example.com/generated.png'
            }
          }
        })
      )
    const client = new Tripo3DClient('tripo-key', 'https://api.tripo3d.ai/v2/openapi', {
      fetchImpl: fetchMock as unknown as typeof fetch,
      pollIntervalMs: 0
    })

    const content = await client.generateFromMessages(
      [{ role: 'user', content: 'a clean front view of a stylized robot' }],
      'TripoGenerateImage',
      {
        ImageModelVersion: 'gpt_4o',
        ImageTemplate: 't_pose'
      }
    )

    const submitBody = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(submitBody).toEqual(
      expect.objectContaining({
        type: 'generate_image',
        prompt: 'a clean front view of a stylized robot',
        model_version: 'gpt_4o',
        t_pose: true
      })
    )
    expect(content).toContain('![Generated Image](https://cdn.example.com/generated.png)')
    expect(content).toContain('[Tripo3D] Task ID: task-image-gen-1')
  })
})
