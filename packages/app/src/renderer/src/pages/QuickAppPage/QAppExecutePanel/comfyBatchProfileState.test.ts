import { describe, expect, it, vi } from 'vitest'
import {
  getComfyBatchProfileSnapshot,
  setComfyBatchProfileSnapshot,
  subscribeComfyBatchProfiles
} from './comfyBatchProfileState'

describe('comfyBatchProfileState', () => {
  it('shares profile changes between settings and batch UI subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeComfyBatchProfiles(listener)
    const profiles = [
      {
        id: 'gpu-1',
        name: 'GPU 1',
        baseUrl: 'http://127.0.0.1:8188',
        enabled: true,
        maxConcurrency: 1
      }
    ]

    setComfyBatchProfileSnapshot(profiles)

    expect(getComfyBatchProfileSnapshot()).toBe(profiles)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})
