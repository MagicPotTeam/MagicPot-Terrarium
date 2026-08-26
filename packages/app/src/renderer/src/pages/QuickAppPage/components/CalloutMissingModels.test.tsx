import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUtils } from '@shared/config/configUtils'
import { CalloutMissingModels } from './CalloutMissingModels'
import { pathApi } from '../../../testUtils/pathApi'

const mockConfigState = vi.hoisted(
  (): { config: { use_remote_comfyui: boolean }; configUtils: ConfigUtils; origin: string } => ({
    config: {
      use_remote_comfyui: false
    },
    origin: 'http://127.0.0.1:8188',
    configUtils: {
      getComfyUIDir: vi.fn(),
      getComfyUIOrigin: vi.fn(() => mockConfigState.origin),
      getPortablePythonHomeDir: vi.fn()
    } as unknown as ConfigUtils
  })
)

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: mockConfigState.config,
    configUtils: mockConfigState.configUtils
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: vi.fn(),
    notifyError: vi.fn()
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.dir ? `${key}: ${String(values.dir)}` : key
  })
}))

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

describe('CalloutMissingModels', () => {
  const originalPath = window.path
  const originalApi = window.api

  beforeEach(() => {
    window.path = pathApi
    mockConfigState.origin = 'http://127.0.0.1:8188'
    mockConfigState.config = {
      use_remote_comfyui: false
    }
    mockConfigState.configUtils = {
      getComfyUIDir: vi.fn(() => ['C:\\ComfyUI', true]),
      getComfyUIOrigin: vi.fn(() => mockConfigState.origin),
      getPortablePythonHomeDir: vi.fn(() => 'C:\\MagicPot\\data\\runtime\\home')
    } as unknown as ConfigUtils
  })

  afterEach(() => {
    window.path = originalPath
    window.api = originalApi
    vi.restoreAllMocks()
  })

  it('ignores a stale result after the unified ComfyUI endpoint changes', async () => {
    const localCheck = createDeferred<boolean[]>()
    const fileExistsBatch = vi.fn(() => localCheck.promise)
    window.api = { svcShell: { fileExistsBatch } } as unknown as typeof window.api

    const requiredModels = [
      {
        name: 'ckpt_base.pth',
        size: '368 MB',
        baseDir: 'portableHome' as const,
        dir: '.transparent-background',
        url: 'https://example.test/ckpt_base.pth'
      }
    ]

    const { rerender } = render(<CalloutMissingModels requiredModels={requiredModels} />)
    await waitFor(() => expect(fileExistsBatch).toHaveBeenCalledTimes(1))

    mockConfigState.origin = 'https://comfy.example.com:9443'
    mockConfigState.configUtils = {
      ...mockConfigState.configUtils,
      getComfyUIOrigin: vi.fn(() => mockConfigState.origin)
    } as unknown as ConfigUtils
    rerender(<CalloutMissingModels requiredModels={requiredModels} />)

    await act(async () => {
      localCheck.resolve([false])
      await localCheck.promise
    })

    await waitFor(() => expect(fileExistsBatch).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('ckpt_base.pth')).toBeInTheDocument()
  })

  it('refreshes model status after the unified ComfyUI endpoint changes', async () => {
    const fileExistsBatch = vi.fn().mockResolvedValueOnce([false]).mockResolvedValueOnce([true])
    window.api = { svcShell: { fileExistsBatch } } as unknown as typeof window.api

    const requiredModels = [
      {
        name: 'ckpt_base.pth',
        size: '368 MB',
        baseDir: 'portableHome' as const,
        dir: '.transparent-background',
        url: 'https://example.test/ckpt_base.pth'
      }
    ]

    const { rerender } = render(<CalloutMissingModels requiredModels={requiredModels} />)
    await screen.findByText('ckpt_base.pth')

    mockConfigState.origin = 'https://comfy.example.com:9443'
    mockConfigState.configUtils = {
      ...mockConfigState.configUtils,
      getComfyUIOrigin: vi.fn(() => mockConfigState.origin)
    } as unknown as ConfigUtils
    rerender(<CalloutMissingModels requiredModels={requiredModels} />)

    await waitFor(() => expect(fileExistsBatch).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('ckpt_base.pth')).not.toBeInTheDocument())
  })
})
