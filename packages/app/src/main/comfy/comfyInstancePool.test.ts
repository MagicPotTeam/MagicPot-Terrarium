import { describe, expect, it, vi } from 'vitest'
import type { ComfyBatchProfile } from '@shared/api/svcComfyBatch'
import type { Workflow } from '@shared/comfy/types'
import { ComfyInstancePool } from './comfyInstancePool'

vi.mock('ws', () => ({ WebSocket: vi.fn() }))
vi.mock('../config/config', () => ({
  getConfig: vi.fn(() => ({
    remote_comfyui_config: { comfyui_origin: 'http://127.0.0.1:8188' },
    comfy_batch_profiles: []
  }))
}))
vi.mock('../config/buildEnv', () => ({
  getBuildEnv: vi.fn(() => ({
    env: { buildMode: 'pure' },
    pathMap: { file: '', data: '', resources: '' },
    embeddedDefaults: { pythonCmd: '', comfyuiDir: '', comfyuiArgs: [] }
  }))
}))

const profile = (id: string, baseUrl: string): ComfyBatchProfile => ({
  id,
  baseUrl,
  enabled: true,
  maxConcurrency: 1
})

describe('ComfyInstancePool', () => {
  it('skips unavailable instances and rotates the available instances', async () => {
    const first = {
      objectInfo: vi.fn().mockRejectedValue(new Error('offline'))
    }
    const second = {
      objectInfo: vi.fn().mockResolvedValue({ KSampler: {} })
    }
    const pool = new ComfyInstancePool({
      profiles: [
        profile('offline', 'http://offline.test'),
        profile('healthy-a', 'http://healthy-a.test'),
        profile('healthy-b', 'http://healthy-b.test')
      ],
      clients: {
        'http://offline.test/': first,
        'http://healthy-a.test/': second,
        'http://healthy-b.test/': {
          objectInfo: vi.fn().mockResolvedValue({ CheckpointLoaderSimple: {} })
        }
      } as never
    })

    const available = await pool.getAvailableInstances()
    expect(available.map((instance) => instance.profile.id)).toEqual(['healthy-a', 'healthy-b'])
    expect(await pool.nextAvailableInstance()).toMatchObject({ profile: { id: 'healthy-a' } })
    expect(await pool.nextAvailableInstance()).toMatchObject({ profile: { id: 'healthy-b' } })
  })

  it('does not consider an empty object_info response compatible', async () => {
    const pool = new ComfyInstancePool({
      profiles: [profile('empty', 'http://empty.test')],
      clients: {
        'http://empty.test/': { objectInfo: vi.fn().mockResolvedValue({}) }
      } as never
    })

    await expect(pool.getAvailableInstances()).resolves.toEqual([])
  })

  it('filters instances that do not support the submitted workflow', async () => {
    const pool = new ComfyInstancePool({
      profiles: [
        profile('missing-node', 'http://missing-node.test'),
        profile('compatible', 'http://compatible.test')
      ],
      clients: {
        'http://missing-node.test/': {
          objectInfo: vi.fn().mockResolvedValue({ KSampler: {} })
        },
        'http://compatible.test/': {
          objectInfo: vi.fn().mockResolvedValue({ KSampler: {}, CustomNode: {} })
        }
      } as never
    })

    const workflow: Workflow = {
      '1': { class_type: 'CustomNode', inputs: {} }
    }

    await expect(pool.orderedAvailableInstances(false, workflow)).resolves.toMatchObject([
      { profile: { id: 'compatible' } }
    ])
  })

  it('keeps a preferred instance through object info lookup until task selection', async () => {
    const pool = new ComfyInstancePool({
      profiles: [profile('first', 'http://first.test'), profile('second', 'http://second.test')],
      clients: {
        'http://first.test/': {
          objectInfo: vi.fn().mockResolvedValue({ FirstNode: {} })
        },
        'http://second.test/': {
          objectInfo: vi.fn().mockResolvedValue({ SecondNode: {} })
        }
      } as never
    })

    await pool.getAvailableInstances()
    pool.preferBaseUrl('http://second.test/')

    await expect(pool.getObjectInfo()).resolves.toEqual({ SecondNode: {} })
    await expect(pool.orderedAvailableInstances()).resolves.toMatchObject([
      { profile: { id: 'second' } },
      { profile: { id: 'first' } }
    ])
  })

  it('returns object info from a workflow-compatible instance when requested', async () => {
    const pool = new ComfyInstancePool({
      profiles: [
        profile('missing-node', 'http://missing-node.test'),
        profile('compatible', 'http://compatible.test')
      ],
      clients: {
        'http://missing-node.test/': {
          objectInfo: vi.fn().mockResolvedValue({ KSampler: {} })
        },
        'http://compatible.test/': {
          objectInfo: vi.fn().mockResolvedValue({ KSampler: {}, CustomNode: {} })
        }
      } as never
    })

    await expect(
      pool.getObjectInfo({ '1': { class_type: 'CustomNode', inputs: {} } })
    ).resolves.toEqual({ KSampler: {}, CustomNode: {} })
  })
})
