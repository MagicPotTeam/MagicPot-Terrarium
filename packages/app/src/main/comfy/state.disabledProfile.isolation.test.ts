import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// All process/config and transport dependencies are replaced before either real module loads.
const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  connect: vi.fn(() => ({ onopen: null, onmessage: null, onclose: null, onerror: null, close: vi.fn() }))
}))
vi.mock('../config/config', () => ({ getConfig: mocks.getConfig }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({}) }))
vi.mock('@shared/config/config', () => ({ DEFAULT_COMFYUI_ORIGIN: 'http://127.0.0.1:8188/' }))
vi.mock('@shared/config/configUtils', () => ({ ConfigUtils: class {} }))
vi.mock('@shared/comfy/funcs', () => ({ findNotInstalledNodeInfo: vi.fn() }))
vi.mock('./http', () => ({
  COMFY_PROCESS_TRANSPORT_CLIENT_ID: 'isolated-fixture',
  ComfyHttpCli: class { connect = mocks.connect }
}))

import { getConfiguredComfyProfiles } from './comfyInstancePool'
import { initComfyStateListener, stopComfyStateListener } from './state'

describe('isolated disabled Comfy profile', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getConfig.mockReset()
    mocks.connect.mockClear()
  })
  afterEach(() => {
    stopComfyStateListener()
    vi.useRealTimers()
  })

  it('preserves a valid disabled profile and does not connect on init or a timer turn', async () => {
    mocks.getConfig.mockReturnValue({ comfy_batch_profiles: [{ id: 'offline', baseUrl: 'http://127.0.0.1:8188/', enabled: false, maxConcurrency: 1 }] })
    expect(getConfiguredComfyProfiles()).toEqual([{ id: 'offline', baseUrl: 'http://127.0.0.1:8188/', enabled: false, maxConcurrency: 1 }])
    initComfyStateListener()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it.each([{ comfy_batch_profiles: [] }, {}])('shows missing/empty profiles activate the enabled fallback %#', (config) => {
    mocks.getConfig.mockReturnValue(config)
    expect(getConfiguredComfyProfiles()).toEqual([{ id: 'default', baseUrl: 'http://127.0.0.1:8188/', enabled: true, maxConcurrency: 1 }])
    initComfyStateListener()
    expect(mocks.connect).toHaveBeenCalledOnce()
  })
})
