import { beforeEach, describe, expect, it, vi } from 'vitest'

const { webSocketCtor, testConfig, testBuildEnv } = vi.hoisted(() => ({
  webSocketCtor: vi.fn(() => ({
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null
  })),
  testConfig: {
    client_id: 'legacy-client',
    use_remote_comfyui: false,
    local_comfyui_config: {
      comfyui_port: '8188',
      comfyui_dir: '',
      python_cmd: '',
      comfyui_args: []
    },
    remote_comfyui_config: {
      comfyui_origin: 'http://remote-host:8188',
      mapping_comfyui_dir: ''
    }
  },
  testBuildEnv: {
    env: {
      buildMode: 'embedded'
    },
    pathMap: {
      file: 'C:/MagicPot',
      data: 'C:/MagicPot/data',
      resources: 'C:/MagicPot/resources'
    },
    embeddedDefaults: {
      pythonCmd: '',
      comfyuiDir: '',
      comfyuiArgs: []
    }
  }
}))

vi.mock('ws', () => ({
  WebSocket: webSocketCtor
}))

vi.mock('../config/config', () => ({
  getConfig: vi.fn(() => testConfig)
}))

vi.mock('../config/buildEnv', () => ({
  getBuildEnv: vi.fn(() => testBuildEnv)
}))

import { COMFY_PROCESS_TRANSPORT_CLIENT_ID, ComfyHttpCli } from './http'

describe('ComfyHttpCli', () => {
  beforeEach(() => {
    webSocketCtor.mockClear()
  })

  it('uses a process-scoped websocket client id by default', () => {
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never)

    cli.connect()

    const firstConnectCall = webSocketCtor.mock.calls[0] as unknown[] | undefined
    const connectUrl = String(firstConnectCall?.[0] ?? '')
    expect(connectUrl).toContain(`clientId=${COMFY_PROCESS_TRANSPORT_CLIENT_ID}`)
    expect(connectUrl).not.toContain('legacy-client')
    expect(webSocketCtor).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        perMessageDeflate: true
      })
    )
  })

  it('honors an explicit websocket client id override', () => {
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      clientId: 'renderer-session'
    })

    cli.connect()

    const firstConnectCall = webSocketCtor.mock.calls[0] as unknown[] | undefined
    expect(String(firstConnectCall?.[0] ?? '')).toContain('clientId=renderer-session')
  })
})
