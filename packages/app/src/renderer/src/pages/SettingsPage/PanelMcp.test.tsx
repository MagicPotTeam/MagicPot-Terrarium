import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import { deepMerge, type DeepPartial } from '@shared/utils/utilTypes'
import PanelMcp from './PanelMcp'

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

  it('uses Chinese fallback copy in zh-CN', () => {
    mockLanguage = 'zh-CN'

    render(<PanelMcpHarness />)

    expect(screen.getByText('新增 MCP 服务器')).toBeTruthy()
    expect(screen.getByText('新增服务器')).toBeTruthy()
    expect(screen.getAllByText('传输方式').length).toBeGreaterThan(0)
  })
})
