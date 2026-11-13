import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { deepMerge, type DeepPartial } from '@shared/utils/utilTypes'
import PanelMcp from './PanelMcp'

const getMcpStatus = vi.hoisted(() => vi.fn())
vi.mock('@renderer/utils/windowUtils', () => ({ api: () => ({ svcState: { getMcpStatus } }) }))
afterEach(() => getMcpStatus.mockReset())

let mockLanguage = 'en-US'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: mockLanguage },
    t: (key: string) => key
  })
}))

type HarnessProps = {
  initialSettings?: Config
  saveSpy?: (patch: DeepPartial<Config>) => void
}

const PanelMcpHarness: React.FC<HarnessProps> = ({ initialSettings = DEFAULT_CONFIG, saveSpy }) => {
  const [settings, setSettings] = React.useState<Config>(initialSettings)

  const handleSaveSettings = React.useCallback(
    (patch: DeepPartial<Config>) => {
      saveSpy?.(patch)
      setSettings((previous) => deepMerge(previous as never, patch as never) as Config)
    },
    [saveSpy]
  )

  return <PanelMcp saveSettings={handleSaveSettings} settingsValue={settings} />
}

const clickCreateServerButton = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create Server' }))
  })
}

describe('PanelMcp', () => {
  beforeEach(() => {
    mockLanguage = 'en-US'
  })

  it('adds a stdio external server card and saves core fields', async () => {
    const saveSpy = vi.fn()
    render(<PanelMcpHarness saveSpy={saveSpy} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: 'github' }
      })
    })

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Command/i), {
        target: { value: 'npx' }
      })
    })

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Arguments/i), {
        target: { value: '-y @modelcontextprotocol/server-github' }
      })
    })

    await clickCreateServerButton()

    expect(saveSpy).toHaveBeenLastCalledWith({
      mcp_config: {
        client: {
          servers: [
            expect.objectContaining({
              id: 'github',
              enabled: true,
              transport: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
              startupTimeoutMs: 15000,
              requestTimeoutMs: 60000
            })
          ]
        }
      }
    })

    expect((await screen.findAllByText('github')).length).toBeGreaterThan(0)
    expect(await screen.findByText('npx ["-y","@modelcontextprotocol/server-github"]')).toBeTruthy()
  })

  it('switches a new server to streamable-http and saves URL plus headers', async () => {
    const saveSpy = vi.fn()
    render(<PanelMcpHarness saveSpy={saveSpy} />)

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Name/i), {
        target: { value: 'github' }
      })
    })

    const transportSelect = screen.getByRole('combobox')
    await act(async () => {
      fireEvent.mouseDown(transportSelect)
    })
    await act(async () => {
      fireEvent.click(screen.getByText('streamable-http'))
    })

    expect(screen.queryByLabelText(/Command/i)).toBeNull()
    expect(await screen.findByLabelText(/Server URL/i)).toBeTruthy()

    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Server URL/i), {
        target: { value: 'https://example.com/mcp' }
      })
    })
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/HTTP Headers/i), {
        target: { value: 'Authorization=Bearer abc\nX-Test=1' }
      })
    })

    await clickCreateServerButton()

    expect(saveSpy).toHaveBeenLastCalledWith({
      mcp_config: {
        client: {
          servers: [
            expect.objectContaining({
              id: 'github',
              transport: 'streamable-http',
              url: 'https://example.com/mcp',
              headers: {
                Authorization: 'Bearer abc',
                'X-Test': '1'
              }
            })
          ]
        }
      }
    })
  })

  it('removes an existing external server card', async () => {
    const saveSpy = vi.fn()
    const initialSettings = deepMerge(
      DEFAULT_CONFIG as never,
      {
        mcp_config: {
          client: {
            servers: [
              {
                id: 'filesystem',
                enabled: true,
                transport: 'stdio',
                command: 'npx',
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
                cwd: '',
                env: {},
                url: '',
                headers: {},
                toolPrefix: '',
                startupTimeoutMs: 15000,
                requestTimeoutMs: 60000
              }
            ]
          }
        }
      } as never
    ) as Config

    render(<PanelMcpHarness initialSettings={initialSettings} saveSpy={saveSpy} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    })

    expect(saveSpy).toHaveBeenLastCalledWith({
      mcp_config: {
        client: {
          servers: []
        }
      }
    })
  })

  it('defaults legacy servers to no thread access and saves per-service discovery/call grants without changing connection secrets', async () => {
    const saveSpy = vi.fn()
    const server = { id: 'one', enabled: true, transport: 'streamable-http' as const, url: 'https://configured.example/mcp', headers: { Authorization: 'Bearer private-key' } }
    const settings = { ...DEFAULT_CONFIG, mcp_config: { ...DEFAULT_CONFIG.mcp_config, client: { servers: [server] } } }
    render(<PanelMcpHarness initialSettings={settings} saveSpy={saveSpy} />)
    const select = screen.getByRole('combobox', { name: 'mcp.thread_access' })
    expect(select).toHaveTextContent('mcp.thread_access_off')
    expect(screen.getByText('mcp.thread_access_notice')).toBeTruthy()
    fireEvent.mouseDown(select)
    fireEvent.click(screen.getByRole('option', { name: 'mcp.thread_access_discover' }))
    expect(saveSpy).toHaveBeenLastCalledWith({ mcp_config: { client: { servers: [{ ...server, agentThreadAccess: 'discover' }] } } })
    fireEvent.mouseDown(select)
    fireEvent.click(screen.getByRole('option', { name: 'mcp.thread_access_call' }))
    expect(saveSpy).toHaveBeenLastCalledWith({ mcp_config: { client: { servers: [{ ...server, agentThreadAccess: 'call' }] } } })
    expect(screen.queryByText('Bearer private-key')).toBeNull()
  })

  it('refreshes status passively, shows quarantine and does not expose raw transport error', async () => {
    const server = { id: 'one', enabled: true, transport: 'stdio' as const, command: 'configured' }
    getMcpStatus.mockResolvedValueOnce({ client: { connections: [{ id: 'one', status: 'close-unconfirmed', lastError: 'PRIVATE_ERROR' }] } })
    render(<PanelMcpHarness initialSettings={{ ...DEFAULT_CONFIG, mcp_config: { ...DEFAULT_CONFIG.mcp_config, client: { servers: [server] } } }} />)
    expect(getMcpStatus).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'mcp.refresh_passive_status' })))
    expect(getMcpStatus).toHaveBeenCalledWith({ passive: true })
    expect(screen.getByText('mcp.connection_state_close-unconfirmed')).toBeTruthy()
    expect(screen.queryByText('PRIVATE_ERROR')).toBeNull()
  })

  it('separates manual-start and connection-management opt-ins and clears manage when access is revoked', () => {
    const saveSpy = vi.fn()
    const server = { id: 'one', enabled: true, transport: 'stdio' as const, command: 'configured', agentThreadAccess: 'discover' as const }
    render(<PanelMcpHarness initialSettings={{ ...DEFAULT_CONFIG, mcp_config: { ...DEFAULT_CONFIG.mcp_config, client: { servers: [server] } } }} saveSpy={saveSpy} />)
    expect(screen.getByRole('switch', { name: 'mcp.auto_connect' })).toBeChecked()
    expect(screen.getByRole('switch', { name: 'mcp.thread_manage' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('switch', { name: 'mcp.auto_connect' }))
    expect(saveSpy).toHaveBeenLastCalledWith({ mcp_config: { client: { servers: [{ ...server, autoConnect: false }] } } })
    fireEvent.click(screen.getByRole('switch', { name: 'mcp.thread_manage' }))
    expect(saveSpy).toHaveBeenLastCalledWith({ mcp_config: { client: { servers: [{ ...server, autoConnect: false, agentThreadManage: true }] } } })
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'mcp.thread_access' }))
    fireEvent.click(screen.getByRole('option', { name: 'mcp.thread_access_off' }))
    expect(screen.getByRole('switch', { name: 'mcp.thread_manage' })).toBeDisabled()
    expect(saveSpy).toHaveBeenLastCalledWith({ mcp_config: { client: { servers: [{ ...server, autoConnect: false, agentThreadManage: false, agentThreadAccess: 'off' }] } } })
  })

  it('can create a manual-start service before any config save could launch it', async () => {
    const saveSpy = vi.fn(); render(<PanelMcpHarness saveSpy={saveSpy} />)
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: 'manual' } })
    fireEvent.change(screen.getByLabelText(/Command/i), { target: { value: 'configured' } })
    fireEvent.click(screen.getByRole('switch', { name: 'mcp.new_auto_connect' }))
    expect(saveSpy).not.toHaveBeenCalled()
    await clickCreateServerButton()
    expect(saveSpy).toHaveBeenCalledWith({ mcp_config: { client: { servers: [expect.objectContaining({ id: 'manual', autoConnect: false, agentThreadManage: false })] } } })
  })

  it('uses Chinese fallback copy in zh-CN', () => {
    mockLanguage = 'zh-CN'

    render(<PanelMcpHarness />)

    expect(screen.getByText('新增 MCP 服务器')).toBeTruthy()
    expect(screen.getByText('新增服务器')).toBeTruthy()
    expect(screen.getAllByText('传输方式').length).toBeGreaterThan(0)
  })
})
