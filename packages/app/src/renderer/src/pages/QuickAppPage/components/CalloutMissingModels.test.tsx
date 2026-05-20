import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUtils } from '@shared/config/configUtils'
import type { BuiltInPath } from '@shared/utils/utilWindow'
import { CalloutMissingModels } from './CalloutMissingModels'

const mockConfigState = vi.hoisted(
  (): { config: { use_remote_comfyui: boolean }; configUtils: ConfigUtils } => ({
    config: {
      use_remote_comfyui: false
    },
    configUtils: {
      getComfyUIDir: vi.fn(),
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

const pathApi = {
  join: (first: string, ...args: string[]) => [first, ...args].filter(Boolean).join('\\'),
  isAbsolute: (value: string) => /^[A-Z]:\\/i.test(value) || value.startsWith('/'),
  normalize: (value: string) => value,
  relative: (from: string, to: string) => to.replace(`${from}\\`, ''),
  dirname: (value: string) => value.split('\\').slice(0, -1).join('\\'),
  basename: (value: string) => value.split('\\').pop() || '',
  extname: (value: string) => {
    const base = value.split('\\').pop() || ''
    const index = base.lastIndexOf('.')
    return index >= 0 ? base.slice(index) : ''
  },
  format: () => '',
  parse: () => ({})
} satisfies BuiltInPath

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
    mockConfigState.config = {
      use_remote_comfyui: false
    }
    mockConfigState.configUtils = {
      getComfyUIDir: vi.fn(() => ['C:\\ComfyUI', true]),
      getPortablePythonHomeDir: vi.fn(() => 'C:\\MagicPot\\data\\runtime\\home')
    } as unknown as ConfigUtils
  })

  afterEach(() => {
    window.path = originalPath
    window.api = originalApi
    vi.restoreAllMocks()
  })

  it('ignores stale local missing-model checks after switching to remote ComfyUI', async () => {
    const localCheck = createDeferred<boolean[]>()
    const fileExistsBatch = vi.fn(() => localCheck.promise)
    window.api = {
      svcShell: {
        fileExistsBatch
      }
    } as unknown as typeof window.api

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

    mockConfigState.config = {
      use_remote_comfyui: true
    }
    rerender(<CalloutMissingModels requiredModels={requiredModels} />)

    await act(async () => {
      localCheck.resolve([false])
      await localCheck.promise
    })

    expect(screen.queryByText('ckpt_base.pth')).not.toBeInTheDocument()
    expect(fileExistsBatch).toHaveBeenCalledTimes(1)
  })

  it('clears an existing local missing-model card after switching to remote ComfyUI', async () => {
    const fileExistsBatch = vi.fn(async () => [false])
    window.api = {
      svcShell: {
        fileExistsBatch
      }
    } as unknown as typeof window.api

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

    mockConfigState.config = {
      use_remote_comfyui: true
    }
    rerender(<CalloutMissingModels requiredModels={requiredModels} />)

    await waitFor(() => expect(screen.queryByText('ckpt_base.pth')).not.toBeInTheDocument())
    expect(fileExistsBatch).toHaveBeenCalledTimes(1)
  })
})
