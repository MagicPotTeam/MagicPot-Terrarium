import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { HyperSvcImpl, sanitizeSaveImageFileName } from './svcHyperImpl'

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

const getTestRoot = (): string =>
  path.join(
    process.cwd(),
    '.magicpot-trash',
    'svc-hyper-impl',
    `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`
  )

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

describe('HyperSvcImpl.saveImageToDir', () => {
  let testRoot: string

  beforeEach(() => {
    vi.clearAllMocks()
    testRoot = getTestRoot()
    fs.mkdirSync(testRoot, { recursive: true })
    getConfigMock.mockReturnValue(baseConfig)
    getBuildEnvMock.mockReturnValue(windowsBuildEnv)
  })

  afterEach(() => {
    if (testRoot) {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it('sanitizes simple filenames and rejects path traversal', () => {
    expect(sanitizeSaveImageFileName(' image.png ')).toBe('image.png')
    expect(() => sanitizeSaveImageFileName('../payload.js')).toThrow(/path separators|traversal/i)
    expect(() => sanitizeSaveImageFileName('folder/payload.js')).toThrow(
      /path separators|traversal/i
    )
    expect(() => sanitizeSaveImageFileName('CON')).toThrow(/reserved/i)
  })

  it('does not write outside the requested directory when saving an attachment', async () => {
    const svc = new HyperSvcImpl()
    const targetDir = path.join(testRoot, 'downloads')

    await expect(
      svc.saveImageToDir({
        data: new Uint8Array([1, 2, 3]),
        fileName: '..\\startup\\payload.js',
        dir: targetDir
      })
    ).rejects.toThrow(/path separators|traversal/i)

    expect(fs.existsSync(path.join(testRoot, 'startup', 'payload.js'))).toBe(false)
  })

  it('uses exclusive writes and suffixes conflicting filenames', async () => {
    const svc = new HyperSvcImpl()
    const targetDir = path.join(testRoot, 'downloads')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'image.png'), Buffer.from([9]))

    const response = await svc.saveImageToDir({
      data: new Uint8Array([1, 2, 3]),
      fileName: 'image.png',
      dir: targetDir
    })

    expect(response.savedPath).toBe(path.resolve(targetDir, 'image_1.png'))
    expect(fs.readFileSync(path.join(targetDir, 'image.png'))).toEqual(Buffer.from([9]))
    expect(fs.readFileSync(response.savedPath)).toEqual(Buffer.from([1, 2, 3]))
  })
})
