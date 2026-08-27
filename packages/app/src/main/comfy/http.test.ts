import { beforeEach, describe, expect, it, vi } from 'vitest'

const { webSocketCtor, testConfig, testBuildEnv } = vi.hoisted(() => ({
  webSocketCtor: vi.fn(function MockWebSocket() {
    return {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null
    }
  }),
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
    vi.restoreAllMocks()
  })

  it('builds canonical view params and disables redirect following', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response())
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never)

    await cli.viewResponse(
      { filename: 'result #1.png', subfolder: 'batch/nested dir', type: 'output' },
      undefined
    )

    const [url, options] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))
    expect(parsed.pathname).toBe('/view')
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      filename: 'result #1.png',
      subfolder: 'batch/nested dir',
      type: 'output'
    })
    expect(options).toEqual({ signal: undefined, redirect: 'manual' })
  })

  it('preserves an instance profile base path for regular API calls', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({}, { status: 200 }))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, {
      baseUrl: 'https://example.test/autodl/comfy/'
    })

    await cli.objectInfo()

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://example.test/autodl/comfy/object_info'
    )
  })

  it('rejects failed GET responses instead of parsing error payloads as success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ error: 'ComfyUI unavailable' }, { status: 503 })
    )
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never)

    await expect(cli.objectInfo()).rejects.toThrow('HTTP error! status: 503')
  })

  it('does not follow redirects from ComfyUI API requests', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://untrusted.example/object_info' }
      })
    )
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never)

    await expect(cli.objectInfo()).rejects.toThrow('HTTP error! status: 302')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
  })

  it('sends a stable prompt id for admission recovery', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ prompt_id: 'server-prompt' }, { status: 200 }))
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never)

    await expect(
      cli.prompt({ prompt: {} as never, client_id: 'transport', prompt_id: 'requested-prompt' })
    ).resolves.toEqual({ prompt_id: 'server-prompt' })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt_id: 'requested-prompt' })
  })

  it.each(['file:///tmp/comfy', 'ftp://example.test', 'http://user:secret@example.test'])(
    'rejects an unsafe ComfyUI base URL %s',
    async (origin) => {
      const config = structuredClone(testConfig)
      config.use_remote_comfyui = true
      config.remote_comfyui_config.comfyui_origin = origin
      const cli = new ComfyHttpCli(config as never, testBuildEnv as never)
      const fetchMock = vi.spyOn(globalThis, 'fetch')

      await expect(
        cli.viewResponse({ filename: 'x.png', subfolder: '', type: 'output' })
      ).rejects.toThrow('Invalid ComfyUI base URL')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

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

  it('encodes special characters in websocket client ids', () => {
    const clientId = 'renderer/session?slot=1&region=cn'
    const cli = new ComfyHttpCli(testConfig as never, testBuildEnv as never, { clientId })

    cli.connect()

    const firstConnectCall = webSocketCtor.mock.calls[0] as unknown[] | undefined
    const connectUrl = new URL(String(firstConnectCall?.[0] ?? ''))
    expect(connectUrl.searchParams.get('clientId')).toBe(clientId)
  })
})
