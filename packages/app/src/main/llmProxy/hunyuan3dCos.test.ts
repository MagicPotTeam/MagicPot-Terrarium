import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  COSCtorMock,
  uploadFileMock,
  putObjectMock,
  getObjectUrlMock,
  getBucketMock,
  deleteMultipleObjectMock,
  statMock,
  randomUUIDMock
} = vi.hoisted(() => ({
  COSCtorMock: vi.fn(),
  uploadFileMock: vi.fn(),
  putObjectMock: vi.fn(),
  getObjectUrlMock: vi.fn(),
  getBucketMock: vi.fn(),
  deleteMultipleObjectMock: vi.fn(),
  statMock: vi.fn(),
  randomUUIDMock: vi.fn()
}))

vi.mock('cos-nodejs-sdk-v5', () => ({
  default: COSCtorMock
}))

vi.mock('fs/promises', () => ({
  default: {
    stat: statMock
  }
}))

vi.mock('crypto', () => ({
  randomUUID: randomUUIDMock
}))

import {
  clearHy3dCosPrefix,
  signHy3dCosModel,
  uploadBufferedHy3dModel,
  uploadLocalHy3dModel
} from './hunyuan3dCos'

const credentials = {
  secretId: 'secret-id',
  secretKey: 'secret-key'
}

describe('hunyuan3dCos', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-04T00:00:00.000Z'))
    randomUUIDMock.mockReturnValue('12345678-1234-1234-1234-123456789abc')
    COSCtorMock.mockImplementation(function MockCOS() {
      return {
        uploadFile: uploadFileMock,
        putObject: putObjectMock,
        getObjectUrl: getObjectUrlMock,
        getBucket: getBucketMock,
        deleteMultipleObject: deleteMultipleObjectMock
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('falls back to the safe default prefix when slash-only input would otherwise target the bucket root', async () => {
    putObjectMock.mockResolvedValue({})
    getObjectUrlMock.mockReturnValue('https://cos.example/signed-url')

    const result = await uploadBufferedHy3dModel(
      credentials,
      {
        bucket: 'magicpot-1314265479',
        region: 'ap-guangzhou',
        keyPrefix: '///'
      },
      'model.glb',
      Buffer.from('mesh-data')
    )

    expect(putObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'magicpot-1314265479',
        Region: 'ap-guangzhou',
        Key: expect.stringContaining('magicpot/hunyuan3d/2026/04/04/')
      })
    )
    expect(result.key).toContain('magicpot/hunyuan3d/2026/04/04/')
  })

  it('rejects signing objects outside the configured prefix', () => {
    expect(() =>
      signHy3dCosModel(
        credentials,
        {
          bucket: 'magicpot-1314265479',
          region: 'ap-guangzhou',
          keyPrefix: 'magicpot/hunyuan3d'
        },
        'other-prefix/model.glb'
      )
    ).toThrow('configured prefix')
  })

  it('clears only the configured prefix even when the saved prefix collapses to slash-only input', async () => {
    getBucketMock.mockResolvedValue({
      Contents: [{ Key: 'magicpot/hunyuan3d/2026/04/04/model.glb' }],
      IsTruncated: 'false'
    })
    deleteMultipleObjectMock.mockResolvedValue({
      Deleted: [{ Key: 'magicpot/hunyuan3d/2026/04/04/model.glb' }],
      Error: []
    })

    const result = await clearHy3dCosPrefix(credentials, {
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      keyPrefix: '/'
    })

    expect(getBucketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'magicpot-1314265479',
        Region: 'ap-guangzhou',
        Prefix: 'magicpot/hunyuan3d/'
      })
    )
    expect(deleteMultipleObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'magicpot-1314265479',
        Region: 'ap-guangzhou',
        Objects: [{ Key: 'magicpot/hunyuan3d/2026/04/04/model.glb' }]
      })
    )
    expect(result).toEqual({
      bucket: 'magicpot-1314265479',
      region: 'ap-guangzhou',
      keyPrefix: 'magicpot/hunyuan3d',
      matchedCount: 1,
      deletedCount: 1,
      errorCount: 0
    })
  })

  it('uploads local model files through multipart upload and returns signed metadata', async () => {
    statMock.mockResolvedValue({ isFile: () => true })
    uploadFileMock.mockResolvedValue({})
    getObjectUrlMock.mockReturnValue('https://cos.example/local-signed')

    const result = await uploadLocalHy3dModel(
      credentials,
      {
        bucket: 'magicpot-1314265479',
        region: 'ap-guangzhou',
        keyPrefix: 'magicpot/hunyuan3d'
      },
      'C:/models/spaceship.glb'
    )

    expect(uploadFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'magicpot-1314265479',
        Region: 'ap-guangzhou',
        FilePath: path.resolve('C:/models/spaceship.glb'),
        Key: expect.stringContaining('magicpot/hunyuan3d/2026/04/04/')
      })
    )
    expect(result.fileName).toBe('spaceship.glb')
    expect(result.url).toBe('https://cos.example/local-signed')
  })
})
