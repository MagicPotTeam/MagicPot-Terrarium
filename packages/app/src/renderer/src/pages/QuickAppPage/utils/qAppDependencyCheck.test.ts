import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigUtils } from '@shared/config/configUtils'
import {
  checkQAppDependencies,
  checkRequiredModels,
  hasBlockingQAppDependencyIssues,
  resolveRequiredModelPaths
} from './qAppDependencyCheck'
import { pathApi } from '../../../testUtils/pathApi'

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

  it('checks required model files when the unified endpoint is configured', async () => {
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

    expect(missing).toHaveLength(1)
    expect(fileExistsBatch).toHaveBeenCalled()
    expect(configUtils.getComfyUIDir).toHaveBeenCalled()
  })

  it('keeps object_info node checks with a non-local endpoint', async () => {
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

    expect(report.missingModels).toHaveLength(1)
    expect(report.missingNodeClasses).toEqual(['RemoteOnlyCustomNode'])
    expect(hasBlockingQAppDependencyIssues(report)).toBe(true)
    expect(fileExistsBatch).toHaveBeenCalled()
  })
})
