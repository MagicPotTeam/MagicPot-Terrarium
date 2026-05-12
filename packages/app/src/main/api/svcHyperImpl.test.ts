import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getBuildEnvMock, getConfigMock } = vi.hoisted(() => ({
  getBuildEnvMock: vi.fn(),
  getConfigMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: vi.fn()
  }
}))

vi.mock('../config/buildEnv', () => ({
  getBuildEnv: getBuildEnvMock
}))

vi.mock('../config/config', () => ({
  getConfig: getConfigMock
}))

vi.mock('../subprocess/subprocess', () => ({
  connectSubProcess: vi.fn(),
  killSubProcess: vi.fn(),
  spawnSubProcess: vi.fn()
}))

vi.mock('../comfy/fs', () => ({
  ComfyFSCli: vi.fn()
}))

vi.mock('../config/portablePaths', () => ({
  createPortablePythonEnv: vi.fn(() => ({}))
}))

vi.mock('../system/vcRedist', () => ({
  ensureVcRedistInstalled: vi.fn()
}))

vi.mock('../config/fastSettingTemplates', () => ({
  getFastSettingValue: vi.fn(),
  listFastSettingTemplates: vi.fn()
}))

import { HyperSvcImpl } from './svcHyperImpl'

const baseConfig = {
  use_remote_comfyui: false,
  local_comfyui_config: {
    comfyui_port: '8188',
    comfyui_args: [],
    comfyui_dir: '',
    python_cmd: ''
  },
  remote_comfyui_config: {
    comfyui_origin: 'http://localhost:8188',
    mapping_comfyui_dir: ''
  }
}

const windowsBuildEnv = {
  env: {
    build: 'development',
    platform: 'windows',
    buildMode: 'embedded',
    packageVersion: 'test'
  },
  pathMap: {
    resources: 'C:/MagicPot/resources',
    file: 'C:/MagicPot',
    data: 'C:/MagicPot/data'
  },
  embeddedDefaults: {
    pythonCmd: 'vendor/comfyui/python_embeded/python.exe',
    comfyuiDir: 'vendor/comfyui/ComfyUI',
    comfyuiArgs: ['--enable-cors-header', '--listen']
  }
}

describe('HyperSvcImpl.comfyPortDetect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConfigMock.mockReturnValue(baseConfig)
    getBuildEnvMock.mockReturnValue(windowsBuildEnv)
  })

  it('ignores established Windows TCP connections that mention the ComfyUI port', async () => {
    const svc = new HyperSvcImpl()
    const runCommandSync = vi.spyOn(svc, 'runCommandSync').mockResolvedValue({
      stdOut: [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:7364         127.0.0.1:8188         ESTABLISHED     51112',
        '  TCP    198.18.0.1:8188        198.18.1.24:443        ESTABLISHED     51112'
      ].join('\n'),
      stdErr: ''
    })

    await expect(svc.comfyPortDetect({})).resolves.toEqual({ pid: 0 })
    expect(runCommandSync).toHaveBeenCalledWith({
      command: 'cmd',
      args: ['/c', 'netstat -ano -p tcp']
    })
  })

  it('returns the pid for a Windows TCP listener on the ComfyUI port', async () => {
    const svc = new HyperSvcImpl()
    vi.spyOn(svc, 'runCommandSync').mockResolvedValue({
      stdOut: [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    0.0.0.0:8188           0.0.0.0:0              LISTENING       60004'
      ].join('\n'),
      stdErr: ''
    })

    await expect(svc.comfyPortDetect({})).resolves.toEqual({ pid: 60004 })
  })
})
