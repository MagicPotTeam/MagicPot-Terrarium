import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KlingVideoAPICli,
  VolcengineSeedanceAPICli,
  createKlingJwt,
  normalizeKlingBaseUrl,
  normalizeVolcengineBaseUrl
} from './videoClients'

const jsonResponse = (
  data: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string }
) =>
  new Response(JSON.stringify(data), {
    status: init?.status ?? (init?.ok === false ? 500 : 200),
    statusText: init?.statusText,
    headers: { 'Content-Type': 'application/json' }
  })

const decodeJwtPart = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>

describe('video generation clients', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('normalizes default base URLs and task endpoints', () => {
    expect(normalizeKlingBaseUrl('')).toBe('https://api-beijing.klingai.com')
    expect(normalizeVolcengineBaseUrl('')).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(
      normalizeVolcengineBaseUrl(
        'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/'
      )
    ).toBe('https://ark.cn-beijing.volces.com/api/v3')
  })

  it('creates Kling JWTs with the official issuer and timing claims', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

    const token = await createKlingJwt('access-id', 'secret-key')
    const [headerPart, payloadPart, signaturePart] = token.split('.')

    expect(decodeJwtPart(headerPart)).toEqual({ alg: 'HS256', typ: 'JWT' })
    expect(decodeJwtPart(payloadPart)).toEqual({
      iss: 'access-id',
      exp: 1767227400,
      nbf: 1767225595
    })
    expect(signaturePart).toBeTruthy()
  })

  it('submits a Kling text-to-video task and returns a video attachment after polling', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { task_id: 'kling-task' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.example/kling.mp4' }] }
          }
        })
      )
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A cat plays piano' }] })
    ).resolves.toMatchObject({
      content: '',
      attachments: [
        {
          type: 'video',
          url: 'https://cdn.example/kling.mp4',
          mimeType: 'video/mp4',
          fileName: 'kling-kling-task.mp4'
        }
      ]
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api-beijing.klingai.com/v1/videos/text2video',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model_name: 'kling-v3',
          prompt: 'A cat plays piano',
          aspect_ratio: '16:9'
        })
      })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api-beijing.klingai.com/v1/videos/text2video/kling-task',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('builds a Kling advanced request body with callback, task id, shots, masks, voices, and simple camera control', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { task_id: 'advanced-task' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.example/advanced.mp4' }] }
          }
        })
      )
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v2.1-pro',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    const result = await client.chat({
      messages: [
        {
          role: 'user',
          content: 'Animate a product reveal',
          attachments: [{ type: 'image', url: 'https://cdn.example/product.png' }]
        }
      ],
      videoGenerationOptions: {
        duration: 5,
        negativePrompt: 'blur',
        cfgScale: 0.7,
        mode: 'pro',
        sound: 'on',
        watermark: false,
        callback_url: 'https://webhook.example/kling',
        external_task_id: 'external-123',
        shot_type: 'multi',
        multi_shot: '[{"prompt":"wide"},{"prompt":"close"}]',
        multi_prompt: [{ prompt: 'hero frame' }],
        element_list: '[{"image":"https://cdn.example/element.png"}]',
        voice_list: [{ text: 'Welcome', voice_id: 'narrator' }],
        static_mask: { mask: 'https://cdn.example/static-mask.png' },
        dynamic_masks: '[{"mask":"https://cdn.example/dynamic-mask.png","trajectories":[]}]',
        camera_control: {
          type: 'simple',
          config: {
            horizontal: 1,
            vertical: -2,
            pan: 3,
            tilt: -4,
            roll: 5,
            zoom: -6
          }
        }
      } as never
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api-beijing.klingai.com/v1/videos/image2video'
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model_name: 'kling-v2.1-pro',
      prompt: 'Animate a product reveal',
      image: 'https://cdn.example/product.png',
      duration: 5,
      negative_prompt: 'blur',
      cfg_scale: 0.7,
      mode: 'pro',
      sound: 'on',
      watermark_info: { enabled: false },
      callback_url: 'https://webhook.example/kling',
      external_task_id: 'external-123',
      shot_type: 'multi',
      multi_shot: [{ prompt: 'wide' }, { prompt: 'close' }],
      multi_prompt: [{ prompt: 'hero frame' }],
      element_list: [{ image: 'https://cdn.example/element.png' }],
      voice_list: [{ text: 'Welcome', voice_id: 'narrator' }],
      static_mask: { mask: 'https://cdn.example/static-mask.png' },
      dynamic_masks: [{ mask: 'https://cdn.example/dynamic-mask.png', trajectories: [] }],
      camera_control: {
        type: 'simple',
        config: { horizontal: 1, vertical: -2, pan: 3, tilt: -4, roll: 5, zoom: -6 }
      }
    })
    expect(result.metadata?.warnings).toEqual([
      'Kling sound generation may be unsupported for this model or action.'
    ])
  })

  it('supports Kling camelCase advanced options and reports capability warnings in metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { task_id: 'warn-task' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.example/warn.mp4' }] }
          }
        })
      )
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v1',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    const result = await client.chat({
      messages: [{ role: 'user', content: 'A cat plays piano' }],
      videoGenerationOptions: {
        mode: '4k',
        sound: 'on',
        callbackUrl: 'https://webhook.example/kling',
        externalTaskId: 'external-camel',
        multiShot: [{ prompt: 'first shot' }],
        voiceList: [{ text: 'hello' }],
        cameraControl: '{"type":"simple","horizontal":1,"zoom":2}'
      } as never
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      callback_url: 'https://webhook.example/kling',
      external_task_id: 'external-camel',
      multi_shot: [{ prompt: 'first shot' }],
      voice_list: [{ text: 'hello' }],
      camera_control: { type: 'simple', config: { horizontal: 1, zoom: 2 } }
    })
    expect(result.metadata?.warnings).toEqual(
      expect.arrayContaining([
        'Kling 4k mode is normally available only on Kling 2.1/4k-capable models.',
        'Kling sound generation may be unsupported for this model or action.',
        'Kling camera_control is intended for image-to-video requests.',
        'Kling multi_shot is intended to be used with shot_type="multi".',
        'Kling voice_list support may require newer Kling models.'
      ])
    )
  })

  it('validates Kling advanced JSON fields and public callback URLs before sending', async () => {
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      vi.fn(),
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'A cat plays piano' }],
        videoGenerationOptions: { multi_shot: '[not-json]' } as never
      })
    ).rejects.toThrow('Kling multi_shot must be valid JSON.')

    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'A cat plays piano' }],
        videoGenerationOptions: { callback_url: 'http://localhost/callback' } as never
      })
    ).rejects.toThrow('Kling callback_url must be a valid public http(s) URL.')
  })

  it('rejects private or local Kling result URLs after polling succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { task_id: 'private-result-task' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_status: 'succeed',
            task_result: { videos: [{ url: 'http://localhost/kling.mp4' }] }
          }
        })
      )
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A cat plays piano' }] })
    ).rejects.toThrow('Kling task private-result-task succeeded but did not return a video URL')
  })

  it('surfaces Kling business code errors returned with HTTP 200', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        code: 1100,
        message: 'invalid prompt Bearer secret-token',
        request_id: 'req-kling'
      })
    )
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A cat plays piano' }] })
    ).rejects.toThrow(
      /Kling create task API error: code=1100, message=invalid prompt Bearer \[REDACTED\], request_id=req-kling/
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('redacts JWTs, configured secrets, and API keys from provider errors', async () => {
    const jwt = await createKlingJwt('access-id', 'secret-key')
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        {
          message: `authorization: Bearer raw-provider-token jwt=${jwt} api_key=provider-api-key secret_key: secret-key access_key=access-id token=provider-token`,
          request_id: 'req-redaction'
        },
        { ok: false, status: 401, statusText: 'Unauthorized' }
      )
    )
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    let error: unknown
    try {
      await client.chat({ messages: [{ role: 'user', content: 'A cat plays piano' }] })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('Bearer [REDACTED]')
    expect(message).toContain('jwt=[REDACTED_JWT]')
    expect(message).toContain('api_key=[REDACTED]')
    expect(message).toContain('secret_key: [REDACTED]')
    expect(message).toContain('access_key=[REDACTED]')
    expect(message).toContain('token=[REDACTED]')
    expect(message).not.toContain(jwt)
    expect(message).not.toContain('raw-provider-token')
    expect(message).not.toContain('provider-api-key')
    expect(message).not.toContain('secret-key')
    expect(message).not.toContain('access-id')
    expect(message).not.toContain('provider-token')
  })

  it('redacts API keys in failed request endpoints and transport errors', async () => {
    const apiKey = 'ark-live-secret-key'
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'fetch failed: https://proxy.example/relay?api_key=transport-api-key& Authorization: Bearer transport-token'
        )
      )
    const client = new VolcengineSeedanceAPICli(
      apiKey,
      'https://ark.cn-beijing.volces.com/api/v3?api_key=endpoint-api-key&',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    let error: unknown
    try {
      await client.chat({ messages: [{ role: 'user', content: 'A bird flies over mountains' }] })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('api_key=[REDACTED]')
    expect(message).toContain('Bearer [REDACTED]')
    expect(message).not.toContain(apiKey)
    expect(message).not.toContain('endpoint-api-key')
    expect(message).not.toContain('transport-api-key')
    expect(message).not.toContain('transport-token')
  })

  it('surfaces Kling business code errors returned while polling', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { task_id: 'kling-task' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          code: '2001',
          data: {
            message: 'nested message must not mask top-level message',
            task_status: 'processing'
          },
          message: 'task missing',
          request_id: 'req-kling-poll'
        })
      )
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A cat plays piano' }] })
    ).rejects.toThrow(
      /Kling poll task API error: code=2001, message=task missing, request_id=req-kling-poll/
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses Kling image-to-video when the latest user message has an image attachment', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { task_id: 'image-task' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.example/image.mp4' }] }
          }
        })
      )
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await client.chat({
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [{ type: 'image', url: 'https://cdn.example/source.png' }]
        }
      ]
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api-beijing.klingai.com/v1/videos/image2video'
    )
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).toMatchObject({
      image: 'https://cdn.example/source.png'
    })
    expect(requestBody).not.toHaveProperty('prompt')
  })

  it('rejects Volcengine asset image URLs for Kling image-to-video', async () => {
    const fetchMock = vi.fn()
    const client = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({
        messages: [
          {
            role: 'user',
            content: 'Animate it',
            attachments: [{ type: 'image', url: 'asset://ark-image/source-asset' }]
          }
        ]
      })
    ).rejects.toThrow(
      /public http\(s\) image URL or a data:image base64 URL \(PNG\/JPEG, <=10MB\).*Local file\/blob\/local-media URLs/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects file/blob/local/private image URLs for both video providers', async () => {
    const klingFetch = vi.fn()
    const volcengineFetch = vi.fn()
    const klingClient = new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      klingFetch,
      { intervalMs: 1, timeoutMs: 1000 }
    )
    const volcengineClient = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      volcengineFetch,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    for (const url of [
      'local-media:///C:/tmp/image.png',
      'file:///tmp/image.png',
      'blob:https://app.example/source-image',
      'http://localhost/image.png',
      'http://studio.localhost/image.png',
      'http://printer.local/image.png',
      'http://ip6-localhost/image.png',
      'http://0.0.0.0/image.png',
      'https://127.0.0.1/image.png',
      'http://2130706433/image.png',
      'http://0x7f000001/image.png',
      'http://10.1.2.3/image.png',
      'http://100.64.0.1/image.png',
      'http://169.254.169.254/latest/meta-data',
      'http://172.16.0.10/image.png',
      'http://192.168.1.20/image.png',
      'http://198.18.0.1/image.png',
      'http://[::1]/image.png',
      'http://[::]/image.png',
      'http://[::ffff:127.0.0.1]/image.png',
      'http://[fd00::1]/image.png',
      'http://[fe80::1]/image.png',
      'data:image/png,not-base64',
      'data:image/webp;base64,aW1hZ2U='
    ]) {
      const messages = [
        {
          role: 'user' as const,
          content: 'Animate it',
          attachments: [{ type: 'image' as const, url }]
        }
      ]

      await expect(klingClient.chat({ messages })).rejects.toThrow(
        /public http\(s\) image URL.*data:image base64 URL.*Local file\/blob\/local-media URLs/
      )
      await expect(volcengineClient.chat({ messages })).rejects.toThrow(
        /public http\(s\) image URL.*data:image base64 URL.*Volcengine asset:\/\/ image URL.*Local file\/blob\/local-media URLs/
      )
    }

    expect(klingFetch).not.toHaveBeenCalled()
    expect(volcengineFetch).not.toHaveBeenCalled()
  })

  it('accepts official Volcengine asset image URLs', async () => {
    const assetUrl = 'asset://ark-image/source-asset'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-asset-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-asset-task',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/seedance-asset.mp4' }
        })
      )
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await client.chat({
      messages: [
        {
          role: 'user',
          content: 'Animate it',
          attachments: [{ type: 'image', url: assetUrl }]
        }
      ]
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      content: [
        { type: 'text', text: 'Animate it' },
        { type: 'image_url', image_url: { url: assetUrl } }
      ],
      ratio: 'adaptive'
    })
  })

  it('allows Volcengine image-to-video with an empty prompt', async () => {
    const assetUrl = 'asset://ark-image/source-asset'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-asset-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-asset-task',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/seedance-asset.mp4' }
        })
      )
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await client.chat({
      messages: [{ role: 'user', content: '   ', attachments: [{ type: 'image', url: assetUrl }] }]
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      content: [{ type: 'image_url', image_url: { url: assetUrl } }],
      ratio: 'adaptive'
    })
  })

  it('preserves Kling data:image stripping and Volcengine data:image payloads', async () => {
    const dataUrl = 'data:image/png;base64,aW1hZ2U='
    const jpgDataUrl = 'data:image/jpeg;base64,aW1hZ2U='
    const klingFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { task_id: 'image-task' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.example/image.mp4' }] }
          }
        })
      )
      .mockResolvedValueOnce(jsonResponse({ data: { task_id: 'image-tail-task' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.example/image-tail.mp4' }] }
          }
        })
      )
    const volcengineFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-data-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-data-task',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/seedance-data.mp4' }
        })
      )

    await new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      klingFetch,
      { intervalMs: 1, timeoutMs: 1000 }
    ).chat({
      messages: [
        { role: 'user', content: 'Animate it', attachments: [{ type: 'image', url: dataUrl }] }
      ]
    })

    await new KlingVideoAPICli(
      'access-id',
      'secret-key',
      'https://api-beijing.klingai.com',
      'kling-v3',
      klingFetch,
      { intervalMs: 1, timeoutMs: 1000 }
    ).chat({
      messages: [
        {
          role: 'user',
          content: 'Animate it',
          attachments: [
            { type: 'image', url: dataUrl },
            { type: 'image', url: jpgDataUrl }
          ]
        }
      ]
    })

    await new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      volcengineFetch,
      { intervalMs: 1, timeoutMs: 1000 }
    ).chat({
      messages: [
        { role: 'user', content: 'Animate it', attachments: [{ type: 'image', url: dataUrl }] }
      ]
    })

    expect(JSON.parse(String(klingFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      image: 'aW1hZ2U='
    })
    expect(JSON.parse(String(klingFetch.mock.calls[2]?.[1]?.body))).toMatchObject({
      image: 'aW1hZ2U=',
      image_tail: 'aW1hZ2U='
    })
    expect(JSON.parse(String(volcengineFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      content: [
        { type: 'text', text: 'Animate it' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ],
      ratio: 'adaptive'
    })
  })

  it('submits Seedance image, video, and audio content with per-reference roles and options', async () => {
    const imageUrl = 'https://cdn.example/source.png'
    const videoUrl = 'https://cdn.example/source.mp4'
    const audioUrl = 'https://cdn.example/source.mp3'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-multimodal-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-multimodal-task',
          status: 'succeeded',
          content: { result_url: 'https://cdn.example/seedance-multimodal.mp4' }
        })
      )
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({
        messages: [
          {
            role: 'user',
            content: 'Blend the references',
            attachments: [
              { type: 'image', url: imageUrl },
              { type: 'video', url: videoUrl, mimeType: 'video/mp4' },
              {
                type: 'file',
                url: audioUrl,
                mimeType: 'audio/mpeg',
                metadata: { videoGenerationRole: 'reference_audio' }
              }
            ]
          }
        ],
        videoGenerationOptions: {
          duration: -1,
          resolution: '1080p',
          frames: 81,
          generateAudio: true,
          returnLastFrame: true,
          callbackUrl: 'https://webhook.example/seedance',
          referenceRoles: ['last_frame', 'reference_video', 'reference_audio']
        } as never
      })
    ).resolves.toMatchObject({
      attachments: [{ url: 'https://cdn.example/seedance-multimodal.mp4' }]
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'doubao-seedance-1-0-pro-250528',
      content: [
        { type: 'text', text: 'Blend the references' },
        { type: 'image_url', image_url: { url: imageUrl }, role: 'last_frame' },
        { type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' },
        { type: 'audio_url', audio_url: { url: audioUrl }, role: 'reference_audio' }
      ],
      ratio: 'adaptive',
      duration: -1,
      watermark: false,
      resolution: '1080p',
      frames: 81,
      generate_audio: true,
      return_last_frame: true,
      callback_url: 'https://webhook.example/seedance'
    })
  })

  it('merges Seedance advanced JSON into the request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-advanced-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-advanced-task',
          status: 'succeeded',
          output: { result_url: 'https://cdn.example/seedance-advanced.mp4' }
        })
      )
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await client.chat({
      messages: [{ role: 'user', content: 'Use advanced options' }],
      videoGenerationOptions: {
        duration: 5,
        advancedJson: JSON.stringify({
          duration: 12,
          camera_fixed: true,
          content: [{ type: 'text', text: 'Override content' }]
        })
      } as never
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'doubao-seedance-1-0-pro-250528',
      content: [{ type: 'text', text: 'Override content' }],
      duration: 12,
      camera_fixed: true
    })
  })

  it('rejects invalid Seedance advanced JSON before sending requests', async () => {
    const fetchMock = vi.fn()
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    const invalidAdvancedJsonError = await client
      .chat({
        messages: [{ role: 'user', content: 'Use advanced options' }],
        videoGenerationOptions: { advancedJson: '{"api_key":"ark-key",' } as never
      })
      .catch((error: unknown) => error)
    expect(invalidAdvancedJsonError).toBeInstanceOf(Error)
    expect(String(invalidAdvancedJsonError)).toContain('advanced JSON must be valid JSON')
    expect(String(invalidAdvancedJsonError)).not.toContain('ark-key')
    await expect(
      client.chat({
        messages: [{ role: 'user', content: 'Use advanced options' }],
        videoGenerationOptions: { advancedJson: '[1,2,3]' } as never
      })
    ).rejects.toThrow('advanced JSON must be a JSON object')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects local/private Seedance video and audio reference URLs', async () => {
    const fetchMock = vi.fn()
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({
        messages: [
          {
            role: 'user',
            content: 'Use video',
            attachments: [{ type: 'video', url: 'http://169.254.169.254/source.mp4' }]
          }
        ]
      })
    ).rejects.toThrow(
      /public http\(s\) video URL.*asset:\/\/ video URL.*Local file\/blob\/local-media URLs/
    )
    await expect(
      client.chat({
        messages: [
          {
            role: 'user',
            content: 'Use audio',
            attachments: [
              { type: 'file', mimeType: 'audio/wav', url: 'file:///tmp/source.wav' } as never
            ]
          }
        ]
      })
    ).rejects.toThrow(
      /public http\(s\) audio URL.*asset:\/\/ audio URL.*Local file\/blob\/local-media URLs/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('redacts Seedance provider errors and generated result URLs are public only', async () => {
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      vi.fn().mockResolvedValueOnce(
        jsonResponse(
          {
            error: { code: 'BadKey', message: 'Authorization: Bearer ark-key' },
            request_id: 'req-seedance'
          },
          { ok: false, status: 401, statusText: 'Unauthorized' }
        )
      ),
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A bird flies over mountains' }] })
    ).rejects.toThrow('Bearer [REDACTED]')

    const privateResultFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-private-result-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-private-result-task',
          status: 'succeeded',
          content: { result_url: 'http://127.0.0.1/result.mp4' }
        })
      )
    await expect(
      new VolcengineSeedanceAPICli(
        'ark-key',
        'https://ark.cn-beijing.volces.com/api/v3',
        'doubao-seedance-1-0-pro-250528',
        privateResultFetch,
        { intervalMs: 1, timeoutMs: 1000 }
      ).chat({ messages: [{ role: 'user', content: 'A bird flies over mountains' }] })
    ).rejects.toThrow('succeeded but did not return a video URL')
  })

  it('submits and polls a Volcengine Seedance task', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-task',
          status: 'succeeded',
          content: { video_url: 'https://cdn.example/seedance.mp4' }
        })
      )
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A bird flies over mountains' }] })
    ).resolves.toMatchObject({
      attachments: [
        {
          type: 'video',
          url: 'https://cdn.example/seedance.mp4',
          fileName: 'seedance-seedance-task.mp4'
        }
      ]
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
      expect.objectContaining({ method: 'POST' })
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'doubao-seedance-1-0-pro-250528',
      content: [{ type: 'text', text: 'A bird flies over mountains' }],
      ratio: '16:9',
      duration: 5,
      watermark: false
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/seedance-task',
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('does not treat arbitrary nested urls as generated Volcengine video outputs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-task',
          status: 'succeeded',
          content: {
            image_url: 'https://cdn.example/source.png',
            thumbnail_url: 'https://cdn.example/thumbnail.jpg'
          },
          output: { url: 'https://cdn.example/not-a-video-image.png' }
        })
      )
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A bird flies over mountains' }] })
    ).rejects.toThrow('succeeded but did not return a video URL')
  })

  it('treats Volcengine expired tasks as terminal failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-expired-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-expired-task',
          status: 'expired',
          last_error: { code: 'Expired', message: 'task result expired' }
        })
      )
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A bird flies over mountains' }] })
    ).rejects.toThrow('code=Expired, message=task result expired')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces provider task failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'seedance-task' }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'seedance-task',
          status: 'failed',
          error: { message: 'quota exceeded' }
        })
      )
    const client = new VolcengineSeedanceAPICli(
      'ark-key',
      'https://ark.cn-beijing.volces.com/api/v3',
      'doubao-seedance-1-0-pro-250528',
      fetchMock,
      { intervalMs: 1, timeoutMs: 1000 }
    )

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'A bird flies over mountains' }] })
    ).rejects.toThrow('quota exceeded')
  })
})
