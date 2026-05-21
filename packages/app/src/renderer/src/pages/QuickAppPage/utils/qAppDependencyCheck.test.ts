import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUtils } from '@shared/config/configUtils'
import type { BuiltInPath } from '@shared/utils/utilWindow'
import {
  checkQAppDependencies,
  checkRequiredModels,
  hasBlockingQAppDependencyIssues,
  resolveRequiredModelPaths
} from './qAppDependencyCheck'

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

describe('qAppDependencyCheck', () => {
  const originalPath = window.path
  const originalApi = window.api

  beforeEach(() => {
    window.path = pathApi
  })

  afterEach(() => {
    window.path = originalPath
    window.api = originalApi
  })

  it('resolves portableHome models under the embedded Python home', () => {
    const resolved = resolveRequiredModelPaths(
      {
        name: 'ckpt_base.pth',
        size: '368 MB',
        baseDir: 'portableHome',
        dir: '.transparent-background',
        url: 'https://example.test/ckpt_base.pth'
      },
      'C:\\ComfyUI',
      'C:\\MagicPot\\data\\runtime\\home'
    )

    expect(resolved).toEqual({
      dirPath: 'C:\\MagicPot\\data\\runtime\\home\\.transparent-background',
      displayDir: 'C:\\MagicPot\\data\\runtime\\home\\.transparent-background',
      filePath: 'C:\\MagicPot\\data\\runtime\\home\\.transparent-background\\ckpt_base.pth'
    })
  })

  it('checks portableHome under the embedded Python home', async () => {
    const fileExistsBatch = vi.fn(async () => [false])
    window.api = {
      svcShell: {
        fileExistsBatch
      }
    } as unknown as typeof window.api

    const configUtils = {
      getComfyUIDir: () => ['C:\\ComfyUI', true],
      getPortablePythonHomeDir: () => 'C:\\MagicPot\\data\\runtime\\home'
    } as ConfigUtils

    const missing = await checkRequiredModels(
      [
        {
          name: 'ckpt_base.pth',
          size: '368 MB',
          baseDir: 'portableHome',
          dir: '.transparent-background',
          url: 'https://example.test/ckpt_base.pth'
        }
      ],
      configUtils,
      { use_remote_comfyui: false }
    )

    expect(fileExistsBatch).toHaveBeenCalledWith([
      'C:\\MagicPot\\data\\runtime\\home\\.transparent-background\\ckpt_base.pth'
    ])
    expect(missing).toHaveLength(1)
  })

  it('skips required model file checks in remote ComfyUI mode', async () => {
    const fileExistsBatch = vi.fn(async () => [false])
    window.api = {
      svcShell: {
        fileExistsBatch
      }
    } as unknown as typeof window.api

    const configUtils = {
      getComfyUIDir: vi.fn(() => ['C:\\ComfyUI', true]),
      getPortablePythonHomeDir: vi.fn(() => 'C:\\MagicPot\\data\\runtime\\home')
    } as unknown as ConfigUtils

    const missing = await checkRequiredModels(
      [
        {
          name: 'ckpt_base.pth',
          size: '368 MB',
          baseDir: 'portableHome',
          dir: '.transparent-background',
          url: 'https://example.test/ckpt_base.pth'
        }
      ],
      configUtils,
      { use_remote_comfyui: true }
    )

    expect(missing).toEqual([])
    expect(fileExistsBatch).not.toHaveBeenCalled()
    expect(configUtils.getComfyUIDir).not.toHaveBeenCalled()
  })

  it('keeps object_info node checks in remote ComfyUI mode', async () => {
    const fileExistsBatch = vi.fn(async () => [false])
    window.api = {
      svcShell: {
        fileExistsBatch
      }
    } as unknown as typeof window.api

    const configUtils = {
      getComfyUIDir: vi.fn(() => ['C:\\ComfyUI', true]),
      getPortablePythonHomeDir: vi.fn(() => 'C:\\MagicPot\\data\\runtime\\home')
    } as unknown as ConfigUtils

    const report = await checkQAppDependencies({
      cfg: {
        icon: '',
        inputs: [],
        requiredModels: [
          {
            name: 'ckpt_base.pth',
            size: '368 MB',
            baseDir: 'portableHome',
            dir: '.transparent-background',
            url: 'https://example.test/ckpt_base.pth'
          }
        ]
      },
      workflow: {
        '1': {
          class_type: 'InstalledNode',
          inputs: {}
        },
        '2': {
          class_type: 'RemoteOnlyCustomNode',
          inputs: {}
        }
      },
      objectInfos: {
        InstalledNode: {}
      },
      configUtils,
      config: { use_remote_comfyui: true }
    })

    expect(report.missingModels).toEqual([])
    expect(report.missingNodeClasses).toEqual(['RemoteOnlyCustomNode'])
    expect(hasBlockingQAppDependencyIssues(report)).toBe(true)
    expect(fileExistsBatch).not.toHaveBeenCalled()
  })
})
