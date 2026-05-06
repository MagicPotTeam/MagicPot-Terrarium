import zlib from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  sdkClientCtorMock,
  submitRapidJobMock,
  queryRapidJobMock,
  submitTextureJobMock,
  describeTextureJobMock,
  submitReduceFaceJobMock,
  describeReduceFaceJobMock,
  submitUvJobMock,
  describeUvJobMock,
  submitPartJobMock,
  queryPartJobMock,
  submitProfileJobMock,
  describeProfileJobMock,
  convert3DFormatMock,
  fetchMock
} = vi.hoisted(() => ({
  sdkClientCtorMock: vi.fn(),
  submitRapidJobMock: vi.fn(),
  queryRapidJobMock: vi.fn(),
  submitTextureJobMock: vi.fn(),
  describeTextureJobMock: vi.fn(),
  submitReduceFaceJobMock: vi.fn(),
  describeReduceFaceJobMock: vi.fn(),
  submitUvJobMock: vi.fn(),
  describeUvJobMock: vi.fn(),
  submitPartJobMock: vi.fn(),
  queryPartJobMock: vi.fn(),
  submitProfileJobMock: vi.fn(),
  describeProfileJobMock: vi.fn(),
  convert3DFormatMock: vi.fn(),
  fetchMock: vi.fn()
}))

vi.mock('tencentcloud-sdk-nodejs-ai3d', () => ({
  ai3d: {
    v20250513: {
      Client: sdkClientCtorMock
    }
  }
}))

import { Hunyuan3DClient } from './hunyuan3dClient'

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
  text: async () => JSON.stringify(body)
})

const rangeResponse = (body: Uint8Array | Buffer, headers?: Record<string, string>) => {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return {
    ok: true,
    status: 206,
    statusText: 'Partial Content',
    headers: new Headers(headers),
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }
}

const buildCrc32Table = (): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

const CRC32_TABLE = buildCrc32Table()

const crc32 = (buffer: Buffer): number => {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

const createPngChunk = (type: string, data: Buffer): Buffer => {
  const typeBuffer = Buffer.from(type, 'ascii')
  const lengthBuffer = Buffer.alloc(4)
  lengthBuffer.writeUInt32BE(data.length, 0)
  const crcBuffer = Buffer.alloc(4)
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer])
}

const createPngBuffer = (width: number, height: number): Buffer => {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const row = Buffer.alloc(width * 4 + 1)
  const rawImage = Buffer.concat(Array.from({ length: height }, () => row))
  const compressed = zlib.deflateSync(rawImage)
  const png = Buffer.concat([
    pngSignature,
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', compressed),
    createPngChunk('IEND', Buffer.alloc(0))
  ])
  return png
}

const createPngDataUrl = (width: number, height: number): string => {
  const png = createPngBuffer(width, height)
  return `data:image/png;base64,${png.toString('base64')}`
}

describe('Hunyuan3DClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    sdkClientCtorMock.mockImplementation(() => ({
      SubmitHunyuanTo3DRapidJob: submitRapidJobMock,
      QueryHunyuanTo3DRapidJob: queryRapidJobMock,
      SubmitTextureTo3DJob: submitTextureJobMock,
      DescribeTextureTo3DJob: describeTextureJobMock,
      SubmitReduceFaceJob: submitReduceFaceJobMock,
      DescribeReduceFaceJob: describeReduceFaceJobMock,
      SubmitHunyuanTo3DUVJob: submitUvJobMock,
      DescribeHunyuanTo3DUVJob: describeUvJobMock,
      SubmitHunyuan3DPartJob: submitPartJobMock,
      QueryHunyuan3DPartJob: queryPartJobMock,
      SubmitProfileTo3DJob: submitProfileJobMock,
      DescribeProfileTo3DJob: describeProfileJobMock,
      Convert3DFormat: convert3DFormatMock
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('submits and polls a rapid Tencent job to completion using the configured region', async () => {
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-1' })
    queryRapidJobMock.mockResolvedValueOnce({ Status: 'RUN' }).mockResolvedValueOnce({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/models/cup.glb?sign=1' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key', 'ap-shanghai')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'a glossy ceramic cup' }],
      'SubmitHunyuanTo3DRapidJob',
      { TargetFormat: 'GLB', EnablePBR: true }
    )

    await vi.advanceTimersByTimeAsync(10000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/models/cup.glb?sign=1)'
    )
    expect(sdkClientCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { secretId: 'secret-id', secretKey: 'secret-key' },
        region: 'ap-shanghai'
      })
    )
    expect(submitRapidJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Prompt: 'a glossy ceramic cup',
        ResultFormat: 'GLB',
        EnablePBR: true
      })
    )
    expect(queryRapidJobMock).toHaveBeenCalledTimes(2)
    expect(queryRapidJobMock).toHaveBeenNthCalledWith(1, { JobId: 'job-rapid-1' })
  })

  it('submits and polls a Pro REST job to completion through normalized /v1/ai3d endpoints', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            JobId: 'job-pro-1'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            Status: 'DONE',
            ResultFile3Ds: [
              {
                Type: 'GLB',
                Url: 'https://example.com/download?id=job-pro-1'
              }
            ]
          }
        })
      )

    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'a polished bronze vase' }],
      'SubmitHunyuanTo3DProJob',
      { Model: '3.1', EnablePBR: true }
    )
    const expectation = expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=job-pro-1)'
    )

    await vi.advanceTimersByTimeAsync(5000)
    await expectation

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [submitUrl, submitInit] = fetchMock.mock.calls[0]
    expect(submitUrl).toBe('https://proxy.example/v1/ai3d/submit')
    expect(submitInit).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: 'Bearer hy-token',
        'Content-Type': 'application/json'
      }
    })
    expect(JSON.parse(String(submitInit?.body))).toMatchObject({
      Prompt: 'a polished bronze vase',
      Model: '3.1',
      GenerateType: 'Normal',
      EnablePBR: true
    })

    const [queryUrl, queryInit] = fetchMock.mock.calls[1]
    expect(queryUrl).toBe('https://proxy.example/v1/ai3d/query')
    expect(JSON.parse(String(queryInit?.body))).toEqual({ JobId: 'job-pro-1' })
  })

  it('surfaces Pro credit diagnostics from the REST query response without assuming structured objects', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            JobId: 'job-pro-credit-1'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            Status: 'DONE',
            ResultFile3Ds: [
              {
                Type: 'GLB',
                Url: 'https://example.com/download?id=job-pro-credit-1'
              }
            ],
            ResultCreditDetails: '{"tier":"pro","billable":true}',
            ResultCreditConsumed: 1.25
          }
        })
      )

    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'a polished bronze vase' }],
      'SubmitHunyuanTo3DProJob',
      { Model: '3.1' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=job-pro-credit-1)\n\n[Hunyuan3D] Credits consumed: 1.25\n[Hunyuan3D] Credit details: {"tier":"pro","billable":true}'
    )
  })

  it("rejects Pro prompts that exceed Tencent's 1024-byte limit before submitting", async () => {
    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')
    const longPrompt = 'a'.repeat(1025)

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: longPrompt }],
        'SubmitHunyuanTo3DProJob',
        { Model: '3.1' }
      )
    ).rejects.toThrow('1024 UTF-8 bytes')
  })

  it('rejects LowPoly generation when Pro model version 3.1 is selected', async () => {
    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'a toy airplane' }],
        'SubmitHunyuanTo3DProJob',
        { Model: '3.1', GenerateType: 'LowPoly' }
      )
    ).rejects.toThrow('LowPoly is not available')
  })

  it("rejects Pro face counts outside Tencent's documented range", async () => {
    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'a carved wooden stool' }],
        'SubmitHunyuanTo3DProJob',
        { Model: '3.0', GenerateType: 'Normal', FaceCount: 2000 }
      )
    ).rejects.toThrow('3000-1500000')
  })

  it('rejects 3.1-only multiview slots when Pro model version 3.0 is selected', async () => {
    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')

    await expect(
      client.generateFromMessages(
        [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'image',
                url: createPngDataUrl(512, 512),
                fileName: 'front.png'
              },
              {
                type: 'image',
                url: createPngDataUrl(512, 512),
                fileName: 'top-view.png'
              }
            ]
          }
        ],
        'SubmitHunyuanTo3DProJob',
        { Model: '3.0', GenerateType: 'Normal' }
      )
    ).rejects.toThrow('require Pro model version 3.1')
  })

  it('submits remote Pro multiview images through ViewImageUrl when a public https image is provided', async () => {
    const frontImage = createPngDataUrl(512, 512)
    fetchMock
      .mockResolvedValueOnce(
        rangeResponse(createPngBuffer(512, 512), {
          'content-type': 'image/png'
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            JobId: 'job-pro-multiview-url-1'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            Status: 'DONE',
            ResultFile3Ds: [
              {
                Type: 'GLB',
                Url: 'https://example.com/download?id=job-pro-multiview-url-1'
              }
            ]
          }
        })
      )

    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: frontImage,
              fileName: 'front.png'
            },
            {
              type: 'image',
              url: 'https://images.example.com/left-reference.png',
              fileName: 'left.png'
            }
          ]
        }
      ],
      'SubmitHunyuanTo3DProJob',
      { Model: '3.1', GenerateType: 'Normal' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=job-pro-multiview-url-1)'
    )

    const submitPayload = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))
    expect(submitPayload).toMatchObject({
      ImageBase64: frontImage.replace(/^data:image\/png;base64,/, ''),
      Model: '3.1',
      GenerateType: 'Normal',
      MultiViewImages: [
        { ViewType: 'left', ViewImageUrl: 'https://images.example.com/left-reference.png' }
      ]
    })
    expect(submitPayload.MultiViewImages[0]).not.toHaveProperty('ViewImageBase64')
  })

  it("rejects Rapid generate types outside Tencent's documented set", async () => {
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'a compact drone' }],
        'SubmitHunyuanTo3DRapidJob',
        { GenerateType: 'Sketch' }
      )
    ).rejects.toThrow('Rapid generate type must be Normal or Geometry')
  })

  it("rejects Rapid prompts that exceed Tencent's documented 200-character limit", async () => {
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'a'.repeat(201) }],
        'SubmitHunyuanTo3DRapidJob'
      )
    ).rejects.toThrow('200 characters')
  })

  it("rejects Rapid reference images that fall below Tencent's documented minimum edge", async () => {
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'image',
                url: createPngDataUrl(64, 64),
                fileName: 'tiny-rapid.png'
              }
            ]
          }
        ],
        'SubmitHunyuanTo3DRapidJob'
      )
    ).rejects.toThrow('128-5000px')
  })

  it('submits remote Rapid reference images through ImageUrl when a public https image is provided', async () => {
    fetchMock.mockResolvedValueOnce(
      rangeResponse(createPngBuffer(512, 512), {
        'content-type': 'image/png'
      })
    )
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-image-url-1' })
    queryRapidJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/models/rapid-image-url.glb' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'https://images.example.com/reference-rapid.png',
              fileName: 'reference-rapid.png'
            }
          ]
        }
      ],
      'SubmitHunyuanTo3DRapidJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/models/rapid-image-url.glb)'
    )
    const payload = submitRapidJobMock.mock.calls[0]?.[0]
    expect(payload.ImageUrl).toBe('https://images.example.com/reference-rapid.png')
    expect(payload).not.toHaveProperty('ImageBase64')
  })

  it('rejects Pro prompt and image mixes outside Sketch mode', async () => {
    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')

    await expect(
      client.generateFromMessages(
        [
          {
            role: 'user',
            content: 'a stylized desk lamp',
            attachments: [
              {
                type: 'image',
                url: createPngDataUrl(512, 512),
                fileName: 'lamp.png'
              }
            ]
          }
        ],
        'SubmitHunyuanTo3DProJob',
        { Model: '3.1', GenerateType: 'Normal' }
      )
    ).rejects.toThrow('Sketch')
  })

  it('allows Sketch mode to submit both a prompt and a reference image on the Pro REST path', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            JobId: 'job-pro-sketch-1'
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Response: {
            Status: 'DONE',
            ResultFile3Ds: [
              {
                Type: 'GLB',
                Url: 'https://example.com/download?id=job-pro-sketch-1'
              }
            ]
          }
        })
      )

    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: 'a pencil sketch of a desk lamp',
          attachments: [
            {
              type: 'image',
              url: createPngDataUrl(512, 512),
              fileName: 'desk-lamp-sketch.png'
            }
          ]
        }
      ],
      'SubmitHunyuanTo3DProJob',
      { Model: '3.1', GenerateType: 'Sketch' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=job-pro-sketch-1)'
    )

    const [submitUrl, submitInit] = fetchMock.mock.calls[0]
    expect(submitUrl).toBe('https://proxy.example/v1/ai3d/submit')
    const expectedSketchImageBase64 = createPngDataUrl(512, 512).split(',')[1]
    expect(JSON.parse(String(submitInit?.body))).toMatchObject({
      Prompt: 'a pencil sketch of a desk lamp',
      ImageBase64: expectedSketchImageBase64,
      Model: '3.1',
      GenerateType: 'Sketch'
    })
  })

  it('surfaces RequestId when the Pro REST submit path returns a body-level API error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        Response: {
          Error: {
            Code: 'InvalidParameter',
            Message: 'bad prompt'
          },
          RequestId: 'req-submit-1'
        }
      })
    )

    const client = new Hunyuan3DClient('hy-token', 'https://proxy.example/v1')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'broken request' }],
        'SubmitHunyuanTo3DProJob',
        { Model: '3.1' }
      )
    ).rejects.toThrow('RequestId=req-submit-1')
  })

  it('keeps the generated-model link when Tencent returns a signed download url without a file extension', async () => {
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-2' })
    queryRapidJobMock.mockResolvedValue({
      Status: 'DONE',
      DownloadUrl: 'https://example.com/download?id=job-rapid-2'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'a stylized toy robot' }],
      'SubmitHunyuanTo3DRapidJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=job-rapid-2)'
    )
  })

  it('formats OBJ package results as downloadable files instead of previewable 3D models', async () => {
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-obj-1' })
    queryRapidJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'OBJ', Url: 'https://example.com/models/cup.zip?sign=1' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'an obj-export chair' }],
      'SubmitHunyuanTo3DRapidJob',
      { TargetFormat: 'OBJ' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated OBJ Package.zip](https://example.com/models/cup.zip?sign=1)'
    )
  })

  it('formats MP4 results as generated videos even when Tencent returns extensionless signed urls', async () => {
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-mp4-1' })
    queryRapidJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'MP4', Url: 'https://example.com/download?id=turntable-1' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'an animated showcase' }],
      'SubmitHunyuanTo3DRapidJob',
      { TargetFormat: 'MP4' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated Video](https://example.com/download?id=turntable-1)'
    )
  })

  it('formats IMAGE and TEXTURE_IMAGE results as markdown images instead of generic files', async () => {
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-image-1' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [
        { Type: 'IMAGE', Url: 'https://example.com/download?id=preview-1' },
        { Type: 'TEXTURE_IMAGE', Url: 'https://example.com/download?id=texture-1' }
      ]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'polished ceramic finish https://example.com/models/cup.glb' }],
      'SubmitTextureTo3DJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '![Generated IMAGE](https://example.com/download?id=preview-1)\n![Generated TEXTURE_IMAGE](https://example.com/download?id=texture-1)'
    )
  })

  it('keeps POSTPROCESS_OBJ results as downloadable files even when the url itself ends with .obj', async () => {
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-postprocess-1' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [
        { Type: 'POSTPROCESS_OBJ', Url: 'https://example.com/download/mesh.obj?sign=1' }
      ]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'weathered bronze finish https://example.com/models/statue.glb' }],
      'SubmitTextureTo3DJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated File](https://example.com/download/mesh.obj?sign=1)'
    )
  })

  it('uses the requested Rapid target format when Tencent returns only an extensionless download url', async () => {
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-mp4-2' })
    queryRapidJobMock.mockResolvedValue({
      Status: 'DONE',
      DownloadUrl: 'https://example.com/download?id=turntable-2'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'an animated showcase' }],
      'SubmitHunyuanTo3DRapidJob',
      { TargetFormat: 'MP4' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated Video](https://example.com/download?id=turntable-2)'
    )
  })

  it('uses the requested OBJ result format when Tencent returns only an extensionless download url', async () => {
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-obj-2' })
    queryRapidJobMock.mockResolvedValue({
      Status: 'DONE',
      DownloadUrl: 'https://example.com/download?id=obj-package-1'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'an obj-export chair' }],
      'SubmitHunyuanTo3DRapidJob',
      { TargetFormat: 'OBJ' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated OBJ Package.zip](https://example.com/download?id=obj-package-1)'
    )
  })

  it('formats converted GIF results as markdown images so the renderer can preview them directly', async () => {
    convert3DFormatMock.mockResolvedValue({
      ResultFile3D: 'https://example.com/download?id=anim-1'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'https://example.com/models/chair.glb' }],
        'Convert3DFormat',
        { TargetFormat: 'GIF' }
      )
    ).resolves.toBe('![Generated GIF](https://example.com/download?id=anim-1)')
  })

  it("rejects texture reference images that do not exceed Tencent's documented 128px minimum edge", async () => {
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [
          {
            role: 'user',
            content: 'https://example.com/models/chair.obj',
            attachments: [
              {
                type: 'image',
                url: createPngDataUrl(128, 128),
                fileName: 'texture-reference.png'
              }
            ]
          }
        ],
        'SubmitTextureTo3DJob'
      )
    ).rejects.toThrow('greater than 128px and less than 4096px')
  })

  it('submits remote texture reference images through Image.Url when a public https image is provided', async () => {
    fetchMock.mockResolvedValueOnce(
      rangeResponse(createPngBuffer(512, 512), {
        'content-type': 'image/png'
      })
    )
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-image-url-1' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/download?id=textured-image-url-1' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: 'https://example.com/models/chair.glb',
          attachments: [
            {
              type: 'image',
              url: 'https://images.example.com/texture-reference.png',
              fileName: 'texture-reference.png'
            }
          ]
        }
      ],
      'SubmitTextureTo3DJob',
      { Model: '3.1' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=textured-image-url-1)'
    )
    const payload = submitTextureJobMock.mock.calls[0]?.[0]
    expect(payload.Image).toEqual({ Url: 'https://images.example.com/texture-reference.png' })
  })

  it('falls back to the input OBJ format for texture jobs when Tencent returns only an extensionless download url', async () => {
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-obj-1' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      DownloadUrl: 'https://example.com/download?id=textured-obj-1'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'brushed copper finish https://example.com/models/chair.obj' }],
      'SubmitTextureTo3DJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated OBJ Package.zip](https://example.com/download?id=textured-obj-1)'
    )
    expect(submitTextureJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        File3D: {
          Url: 'https://example.com/models/chair.obj',
          Type: 'OBJ'
        },
        Prompt: 'brushed copper finish'
      })
    )
  })

  it("rejects texture prompts that exceed Tencent's documented 200-character limit", async () => {
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [
          {
            role: 'user',
            content: `${'a'.repeat(201)} https://example.com/models/chair.glb`
          }
        ],
        'SubmitTextureTo3DJob'
      )
    ).rejects.toThrow('Texture prompt must be 200 characters or fewer')
  })

  it('submits texture multiview payloads only when model version 3.1 is selected', async () => {
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-glb-1' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/download?id=textured-glb-1' }]
    })

    const frontImage = createPngDataUrl(256, 256)
    const leftImage = createPngDataUrl(256, 256)
    const backImage = createPngDataUrl(256, 256)
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: 'https://example.com/models/chair.glb',
          attachments: [
            {
              type: 'image',
              url: frontImage,
              fileName: 'texture-front.png'
            },
            {
              type: 'image',
              url: leftImage,
              fileName: 'left.png'
            },
            {
              type: 'image',
              url: backImage,
              fileName: 'back.png'
            }
          ]
        }
      ],
      'SubmitTextureTo3DJob',
      { Model: '3.1' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=textured-glb-1)'
    )
    expect(submitTextureJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Model: '3.1',
        Image: { Base64: frontImage.replace(/^data:image\/png;base64,/, '') },
        MultiViewImages: [
          { ViewType: 'left', ViewImageBase64: leftImage.replace(/^data:image\/png;base64,/, '') },
          { ViewType: 'back', ViewImageBase64: backImage.replace(/^data:image\/png;base64,/, '') }
        ]
      })
    )
  })

  it('submits remote texture multiview images through ViewImageUrl while keeping local multiview images on Base64', async () => {
    fetchMock.mockResolvedValueOnce(
      rangeResponse(createPngBuffer(256, 256), {
        'content-type': 'image/png'
      })
    )
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-glb-url-1' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/download?id=textured-glb-url-1' }]
    })

    const frontImage = createPngDataUrl(256, 256)
    const backImage = createPngDataUrl(256, 256)
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: 'https://example.com/models/chair.glb',
          attachments: [
            {
              type: 'image',
              url: frontImage,
              fileName: 'texture-front.png'
            },
            {
              type: 'image',
              url: 'https://images.example.com/left-texture.png',
              fileName: 'left.png'
            },
            {
              type: 'image',
              url: backImage,
              fileName: 'back.png'
            }
          ]
        }
      ],
      'SubmitTextureTo3DJob',
      { Model: '3.1' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=textured-glb-url-1)'
    )
    const payload = submitTextureJobMock.mock.calls[0]?.[0]
    expect(payload).toMatchObject({
      Model: '3.1',
      Image: { Base64: frontImage.replace(/^data:image\/png;base64,/, '') },
      MultiViewImages: [
        { ViewType: 'left', ViewImageUrl: 'https://images.example.com/left-texture.png' },
        { ViewType: 'back', ViewImageBase64: backImage.replace(/^data:image\/png;base64,/, '') }
      ]
    })
    expect(payload.MultiViewImages[0]).not.toHaveProperty('ViewImageBase64')
  })

  it('rejects texture multiview inputs when model version 3.0 is selected', async () => {
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [
          {
            role: 'user',
            content: 'https://example.com/models/chair.glb',
            attachments: [
              {
                type: 'image',
                url: createPngDataUrl(256, 256),
                fileName: 'texture-front.png'
              },
              {
                type: 'image',
                url: createPngDataUrl(256, 256),
                fileName: 'left.png'
              }
            ]
          }
        ],
        'SubmitTextureTo3DJob',
        { Model: '3.0' }
      )
    ).rejects.toThrow('Texture multiview inputs require model version 3.1')
  })

  it("rejects texture multiview images that do not exceed Tencent's documented 128px minimum edge", async () => {
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [
          {
            role: 'user',
            content: 'https://example.com/models/chair.glb',
            attachments: [
              {
                type: 'image',
                url: createPngDataUrl(256, 256),
                fileName: 'texture-front.png'
              },
              {
                type: 'image',
                url: createPngDataUrl(128, 128),
                fileName: 'left.png'
              }
            ]
          }
        ],
        'SubmitTextureTo3DJob',
        { Model: '3.1' }
      )
    ).rejects.toThrow(
      'Texture multiview image dimensions must be greater than 128px and less than 5000px'
    )
  })

  it('uses the source file name hint when a post-process input url is extensionless', async () => {
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-obj-2' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      DownloadUrl: 'https://example.com/download?id=textured-obj-2'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: 'weathered brass finish https://example.com/download?id=input-obj-2'
        }
      ],
      'SubmitTextureTo3DJob',
      { SourceFileName: 'Generated OBJ Package.zip' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated OBJ Package.zip](https://example.com/download?id=textured-obj-2)'
    )
    expect(submitTextureJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        File3D: {
          Url: 'https://example.com/download?id=input-obj-2',
          Type: 'OBJ'
        },
        Prompt: 'weathered brass finish'
      })
    )
  })

  it('uses content-disposition filename hints to validate extensionless convert inputs', async () => {
    fetchMock.mockResolvedValueOnce(
      rangeResponse(Buffer.alloc(0), {
        'content-disposition': 'attachment; filename="rigged-character.fbx"'
      })
    )
    convert3DFormatMock.mockResolvedValue({
      ResultFile3D: 'https://example.com/output.stl'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'https://example.com/download?id=remote-model-1' }],
        'Convert3DFormat',
        { TargetFormat: 'STL' }
      )
    ).resolves.toBe('[Generated 3D Model](https://example.com/output.stl)')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/download?id=remote-model-1',
      expect.objectContaining({
        headers: {
          Range: 'bytes=0-1023'
        }
      })
    )
  })

  it('sniffs OBJ bytes from an extensionless model url when no local hint is available', async () => {
    fetchMock.mockResolvedValueOnce(
      rangeResponse(Buffer.from('o SmokeCube\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', 'utf8'), {
        'content-type': 'application/octet-stream'
      })
    )
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-obj-4' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'OBJ', Url: 'https://example.com/download?id=textured-obj-4' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: 'weathered brass finish https://example.com/download?id=remote-model-4'
        }
      ],
      'SubmitTextureTo3DJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated OBJ Package.zip](https://example.com/download?id=textured-obj-4)'
    )
    expect(submitTextureJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        File3D: {
          Url: 'https://example.com/download?id=remote-model-4',
          Type: 'OBJ'
        }
      })
    )
  })

  it('sniffs ASCII FBX bytes from an extensionless model url when no local hint is available', async () => {
    fetchMock.mockResolvedValueOnce(
      rangeResponse(Buffer.from('; FBX 7.4.0 project file\nFBXHeaderExtension: {\n}\n', 'utf8'), {
        'content-type': 'application/octet-stream'
      })
    )
    convert3DFormatMock.mockResolvedValue({
      ResultFile3D: 'https://example.com/output.fbx'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'https://example.com/download?id=remote-model-fbx-ascii-1' }],
        'Convert3DFormat',
        { TargetFormat: 'FBX' }
      )
    ).resolves.toBe('[Generated 3D Model](https://example.com/output.fbx)')

    expect(convert3DFormatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        File3D: 'https://example.com/download?id=remote-model-fbx-ascii-1',
        Format: 'FBX'
      })
    )
  })

  it('uses filename query hints when a post-process input url is extensionless and no separate source file name is available', async () => {
    submitTextureJobMock.mockResolvedValue({ JobId: 'job-texture-obj-3' })
    describeTextureJobMock.mockResolvedValue({
      Status: 'DONE',
      DownloadUrl: 'https://example.com/download?id=textured-obj-3'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content:
            'weathered brass finish https://example.com/download?id=input-obj-3&filename=generated-package.obj'
        }
      ],
      'SubmitTextureTo3DJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated OBJ Package.zip](https://example.com/download?id=textured-obj-3)'
    )
    expect(submitTextureJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        File3D: {
          Url: 'https://example.com/download?id=input-obj-3&filename=generated-package.obj',
          Type: 'OBJ'
        },
        Prompt: 'weathered brass finish'
      })
    )
  })

  it('formats converted MP4 results as generated videos instead of 3D model links', async () => {
    convert3DFormatMock.mockResolvedValue({
      ResultFile3D: 'https://example.com/download?id=turntable-2'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [{ role: 'user', content: 'https://example.com/models/chair.glb' }],
        'Convert3DFormat',
        { TargetFormat: 'MP4' }
      )
    ).resolves.toBe('[Generated Video](https://example.com/download?id=turntable-2)')
  })

  it("rejects profile reference images that do not exceed Tencent's documented 500px minimum edge", async () => {
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')

    await expect(
      client.generateFromMessages(
        [
          {
            role: 'user',
            content: '',
            attachments: [
              {
                type: 'image',
                url: createPngDataUrl(500, 500),
                fileName: 'profile-reference.png'
              }
            ]
          }
        ],
        'SubmitProfileTo3DJob'
      )
    ).rejects.toThrow('greater than 500px and less than 4096px')
  })

  it('submits remote profile reference images through Profile.Url when a public https image is provided', async () => {
    fetchMock.mockResolvedValueOnce(
      rangeResponse(createPngBuffer(768, 768), {
        'content-type': 'image/png'
      })
    )
    submitProfileJobMock.mockResolvedValue({ JobId: 'job-profile-url-1' })
    describeProfileJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/download?id=profile-url-1' }]
    })
    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'https://images.example.com/profile-reference.png',
              fileName: 'profile-reference.png'
            }
          ]
        }
      ],
      'SubmitProfileTo3DJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=profile-url-1)'
    )
    expect(submitProfileJobMock).toHaveBeenCalledWith({
      Profile: { Url: 'https://images.example.com/profile-reference.png' }
    })
  })

  it('submits part-generation jobs with the documented fixed model version 1.5', async () => {
    submitPartJobMock.mockResolvedValue({ JobId: 'job-part-1' })
    queryPartJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'FBX', Url: 'https://example.com/download?id=parts-1' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'https://example.com/models/robot.fbx' }],
      'SubmitHunyuan3DPartJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=parts-1)\n\n[Hunyuan3D] Result URLs may expire after 1 day.'
    )
    expect(submitPartJobMock).toHaveBeenCalledWith({
      Model: '1.5',
      File: {
        Url: 'https://example.com/models/robot.fbx',
        Type: 'FBX'
      }
    })
  })

  it('treats DEFAULT as an implicit reduce-face output format and keeps mixed preview plus model results renderable', async () => {
    submitReduceFaceJobMock.mockResolvedValue({ JobId: 'job-reduce-face-1' })
    describeReduceFaceJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [
        { Url: 'https://example.com/output/reduce-face-preview.png' },
        { Url: 'https://example.com/output/reduce-face-result.obj' },
        { Url: 'https://example.com/output/reduce-face-result.glb' }
      ]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'https://example.com/models/robot.glb' }],
      'SubmitReduceFaceJob',
      { TargetFormat: 'DEFAULT' }
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      [
        '![Generated PNG](https://example.com/output/reduce-face-preview.png)',
        '[Generated 3D Model](https://example.com/output/reduce-face-result.obj)',
        '[Generated 3D Model](https://example.com/output/reduce-face-result.glb)'
      ].join('\n')
    )
    expect(submitReduceFaceJobMock).toHaveBeenCalledWith({
      File3D: {
        Url: 'https://example.com/models/robot.glb',
        Type: 'GLB'
      },
      FaceLevel: 'low',
      PolygonType: 'triangle'
    })
  })

  it('marks UV query result urls as short-lived when the job completes successfully', async () => {
    submitUvJobMock.mockResolvedValue({ JobId: 'job-uv-1' })
    describeUvJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/download?id=uv-1' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'https://example.com/models/robot.glb' }],
      'SubmitHunyuanTo3DUVJob'
    )

    await vi.advanceTimersByTimeAsync(5000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=uv-1)\n\n[Hunyuan3D] Result URLs may expire after 1 day.'
    )
  })

  it('retries transient Tencent internal errors when submitting a UV job', async () => {
    submitUvJobMock
      .mockRejectedValueOnce(
        new Error(
          '[TencentCloudSDKException]message:An internal error has occurred. Retry your request, but if the problem persists, contact us. requestId:req-uv-submit-1 traceId:trace-uv-submit-1'
        )
      )
      .mockResolvedValueOnce({ JobId: 'job-uv-retry-1' })
    describeUvJobMock.mockResolvedValue({
      Status: 'DONE',
      ResultFile3Ds: [{ Type: 'GLB', Url: 'https://example.com/download?id=uv-retry-1' }]
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'https://example.com/models/robot.glb' }],
      'SubmitHunyuanTo3DUVJob'
    )

    await vi.advanceTimersByTimeAsync(7000)

    await expect(resultPromise).resolves.toBe(
      '[Generated 3D Model](https://example.com/download?id=uv-retry-1)\n\n[Hunyuan3D] Result URLs may expire after 1 day.'
    )
    expect(submitUvJobMock).toHaveBeenCalledTimes(2)
    expect(describeUvJobMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces a UV-specific fallback hint after Tencent internal errors exhaust submit retries', async () => {
    submitUvJobMock.mockRejectedValue(
      new Error(
        '[TencentCloudSDKException]message:An internal error has occurred. Retry your request, but if the problem persists, contact us. requestId:req-uv-submit-final traceId:trace-uv-submit-final'
      )
    )

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'https://example.com/models/robot.glb' }],
      'SubmitHunyuanTo3DUVJob'
    )
    const expectation = expect(resultPromise).rejects.toThrow('UV 展开提交在 5 次尝试后仍失败')

    await vi.advanceTimersByTimeAsync(40000)
    await expectation
    await expect(resultPromise).rejects.toThrow('当前输入是 GLB')
    await expect(resultPromise).rejects.toThrow('requestId:req-uv-submit-final')
    expect(submitUvJobMock).toHaveBeenCalledTimes(5)
  })

  it('throws when Tencent marks the job done but returns no downloadable result', async () => {
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-3' })
    queryRapidJobMock.mockResolvedValue({ Status: 'DONE' })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'a modern chair' }],
      'SubmitHunyuanTo3DRapidJob'
    )
    const expectation = expect(resultPromise).rejects.toThrow('no downloadable result file')

    await vi.advanceTimersByTimeAsync(5000)
    await expectation
  })

  it('surfaces Tencent polling failures instead of timing out silently', async () => {
    submitRapidJobMock.mockResolvedValue({ JobId: 'job-rapid-4' })
    queryRapidJobMock.mockResolvedValue({
      Status: 'FAIL',
      ErrorCode: 'InvalidInput',
      ErrorMessage: 'bad prompt',
      RequestId: 'req-rapid-1'
    })

    const client = new Hunyuan3DClient('', '', 'secret-id', 'secret-key')
    const resultPromise = client.generateFromMessages(
      [{ role: 'user', content: 'bad request' }],
      'SubmitHunyuanTo3DRapidJob'
    )
    const expectation = expect(resultPromise).rejects.toThrow('RequestId=req-rapid-1')

    await vi.advanceTimersByTimeAsync(5000)
    await expectation
  })
})
