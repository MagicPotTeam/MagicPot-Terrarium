import React from 'react'
import { Add as AddIcon } from '@mui/icons-material'
import { Box, Button, Card, CardContent, Chip, Stack, TextField, Typography } from '@mui/material'
import {
  DEFAULT_CONFIG,
  type McpExternalServerConfig,
  type McpExternalServerTransport
} from '@shared/config/config'
import InputSelect from '@renderer/components/inputs/InputSelect'
import { useTranslation } from 'react-i18next'
import type { PanelProps } from './PanelProps'

const DEFAULT_STARTUP_TIMEOUT_MS = 15000
const DEFAULT_REQUEST_TIMEOUT_MS = 60000

const ZH_MISSING_FALLBACKS: Record<string, string> = {
  'mcp.page_title': 'MCP 服务器',
  'mcp.page_subtitle':
    'MCP 服务器会通过 Model Context Protocol 为代理提供外部工具。代理会将发现到的工具注册为 mcp.<server>.<tool> 形式的具体工具并直接调用它们。',
  'mcp.servers_label': '服务器',
  'mcp.new_server_title': '新增 MCP 服务器',
  'mcp.server_name': '名称 *',
  'mcp.transport': '传输方式',
  'mcp.transport_stdio_child': 'stdio（子进程）',
  'mcp.command_required': '命令 *',
  'mcp.url_required': '服务器 URL *',
  'mcp.args_spaced': '参数（以空格分隔）',
  'mcp.headers': '请求头',
  'mcp.create_server': '新增服务器',
  'mcp.add_server': '添加服务器',
  'mcp.remove_server': '移除',
  'mcp.command_missing': '尚未配置启动命令。',
  'mcp.url_missing': '尚未配置服务器 URL。'
}

type QtFn = (key: string, fallback: string) => string

const parseSpaceSeparatedArgs = (value: string): string[] =>
  value
    .trim()
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)

const formatSpaceSeparatedArgs = (value?: string[]): string => (value || []).join(' ')

const parseKeyValueLines = (value: string): Record<string, string> =>
  value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, item) => {
      const separatorIndex = item.indexOf('=')
      if (separatorIndex === -1) {
        result[item] = ''
        return result
      }

      const key = item.slice(0, separatorIndex).trim()
      if (!key) {
        return result
      }

      result[key] = item.slice(separatorIndex + 1).trim()
      return result
    }, {})

const formatKeyValueLines = (value?: Record<string, string>): string =>
  Object.entries(value || {})
    .map(([key, item]) => `${key}=${item}`)
    .join('\n')

const createDefaultServerId = (servers: McpExternalServerConfig[]): string => {
  let nextIndex = servers.length + 1
  let candidate = `server-${nextIndex}`

  while (servers.some((server) => server.id === candidate)) {
    nextIndex += 1
    candidate = `server-${nextIndex}`
  }

  return candidate
}

const createExternalServer = (servers: McpExternalServerConfig[]): McpExternalServerConfig => ({
  id: createDefaultServerId(servers),
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  cwd: '',
  env: {},
  url: '',
  headers: {},
  toolPrefix: '',
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
})

const normalizeExternalServer = (server: McpExternalServerConfig): McpExternalServerConfig => ({
  ...server,
  id: server.id.trim(),
  command: server.command?.trim() || '',
  cwd: server.cwd?.trim() || '',
  url: server.url?.trim() || '',
  toolPrefix: server.toolPrefix?.trim() || '',
  transport: server.transport || 'stdio',
  args: server.args || [],
  env: server.env || {},
  headers: server.headers || {},
  startupTimeoutMs: server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
  requestTimeoutMs: server.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
})

const getServerPreview = (server: McpExternalServerConfig, qt: QtFn): string => {
  if ((server.transport || 'stdio') === 'streamable-http') {
    return server.url?.trim() || qt('mcp.url_missing', 'No server URL configured yet.')
  }

  const command = server.command?.trim()
  if (!command) {
    return qt('mcp.command_missing', 'No command configured yet.')
  }

  return server.args?.length ? `${command} ${JSON.stringify(server.args)}` : command
}

const PanelMcp: React.FC<PanelProps> = ({ settingsValue, saveSettings }) => {
  const { t, i18n } = useTranslation()
  const isChineseUi = i18n.language?.toLowerCase().startsWith('zh')
  const clientServers = React.useMemo(
    () => settingsValue.mcp_config?.client?.servers ?? [],
    [settingsValue.mcp_config?.client?.servers]
  )

  const qt = React.useCallback<QtFn>(
    (key, fallback) => {
      const value = t(key)
      if (value !== key) {
        return value
      }
      if (isChineseUi) {
        return ZH_MISSING_FALLBACKS[key] ?? fallback
      }
      return fallback
    },
    [isChineseUi, t]
  )

  const [draftServer, setDraftServer] = React.useState<McpExternalServerConfig>(() =>
    createExternalServer(clientServers)
  )

  const saveClientServers = React.useCallback(
    (servers: McpExternalServerConfig[]) => {
      saveSettings({
        mcp_config: {
          client: {
            servers
          }
        }
      })
    },
    [saveSettings]
  )

  const removeClientServer = React.useCallback(
    (index: number) => {
      saveClientServers(clientServers.filter((_, serverIndex) => serverIndex !== index))
    },
    [clientServers, saveClientServers]
  )

  const addClientServer = React.useCallback(() => {
    const nextServers = [...clientServers, normalizeExternalServer(draftServer)]
    saveClientServers(nextServers)
    setDraftServer(createExternalServer(nextServers))
  }, [clientServers, draftServer, saveClientServers])

  const draftTransport = draftServer.transport || 'stdio'
  const canCreateServer =
    draftServer.id.trim().length > 0 &&
    (draftTransport === 'streamable-http'
      ? (draftServer.url || '').trim().length > 0
      : (draftServer.command || '').trim().length > 0)

  return (
    <Box sx={{ p: 3 }}>
      <Stack spacing={3}>
        <Box>
          <Stack spacing={1.5}>
            {clientServers.map((server, index) => {
              const serverName = server.id?.trim() || `server-${index + 1}`
              const transport = server.transport || 'stdio'

              return (
                <Card
                  key={`${server.id || 'server'}-${index}`}
                  variant="outlined"
                  sx={{ borderRadius: 3 }}
                >
                  <CardContent sx={{ p: 2.5 }}>
                    <Stack spacing={1.5}>
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          gap: 2,
                          flexWrap: 'wrap'
                        }}
                      >
                        <Stack
                          direction="row"
                          spacing={1}
                          useFlexGap
                          flexWrap="wrap"
                          alignItems="center"
                        >
                          <Typography sx={{ fontSize: 18, fontWeight: 700 }}>
                            {serverName}
                          </Typography>
                          <Chip label={transport} size="small" variant="outlined" />
                        </Stack>

                        <Button
                          color="error"
                          size="small"
                          variant="outlined"
                          onClick={() => removeClientServer(index)}
                        >
                          {qt('mcp.remove_server', 'Remove')}
                        </Button>
                      </Box>

                      <Typography
                        color="text.secondary"
                        sx={{
                          fontFamily: 'monospace',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word'
                        }}
                        variant="body2"
                      >
                        {getServerPreview(server, qt)}
                      </Typography>
                    </Stack>
                  </CardContent>
                </Card>
              )
            })}
          </Stack>
        </Box>

        <Card variant="outlined" sx={{ borderRadius: 3 }}>
          <CardContent sx={{ p: 2.5 }}>
            <Stack spacing={2}>
              <Typography variant="h6" sx={{ fontSize: 18, fontWeight: 700 }}>
                {qt('mcp.new_server_title', 'New MCP Server')}
              </Typography>

              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: {
                    xs: '1fr',
                    md: 'repeat(2, minmax(0, 1fr))'
                  }
                }}
              >
                <TextField
                  fullWidth
                  label={qt('mcp.server_name', 'Name *')}
                  value={draftServer.id || ''}
                  onChange={(event) =>
                    setDraftServer((previous) => ({
                      ...previous,
                      id: event.target.value
                    }))
                  }
                  placeholder="my-server"
                />
                <InputSelect
                  label={qt('mcp.transport', 'Transport')}
                  value={draftTransport}
                  onChange={(value) =>
                    setDraftServer((previous) => ({
                      ...previous,
                      transport: value as McpExternalServerTransport
                    }))
                  }
                  items={[
                    {
                      label: qt('mcp.transport_stdio_child', 'stdio (child process)'),
                      value: 'stdio'
                    },
                    { label: 'streamable-http', value: 'streamable-http' }
                  ]}
                />

                {draftTransport === 'streamable-http' ? (
                  <>
                    <TextField
                      fullWidth
                      label={qt('mcp.url_required', 'Server URL *')}
                      value={draftServer.url || ''}
                      onChange={(event) =>
                        setDraftServer((previous) => ({
                          ...previous,
                          url: event.target.value
                        }))
                      }
                      placeholder="https://example.com/mcp"
                    />
                    <TextField
                      fullWidth
                      multiline
                      minRows={2}
                      label={qt('mcp.headers', 'HTTP Headers')}
                      value={formatKeyValueLines(draftServer.headers)}
                      onChange={(event) =>
                        setDraftServer((previous) => ({
                          ...previous,
                          headers: parseKeyValueLines(event.target.value)
                        }))
                      }
                      placeholder={'Authorization=Bearer token'}
                    />
                  </>
                ) : (
                  <>
                    <TextField
                      fullWidth
                      label={qt('mcp.command_required', 'Command *')}
                      value={draftServer.command || ''}
                      onChange={(event) =>
                        setDraftServer((previous) => ({
                          ...previous,
                          command: event.target.value
                        }))
                      }
                      placeholder="npx"
                    />
                    <TextField
                      fullWidth
                      label={qt('mcp.args_spaced', 'Arguments (space separated)')}
                      value={formatSpaceSeparatedArgs(draftServer.args)}
                      onChange={(event) =>
                        setDraftServer((previous) => ({
                          ...previous,
                          args: parseSpaceSeparatedArgs(event.target.value)
                        }))
                      }
                      placeholder="-y @modelcontextprotocol/server-filesystem /workspace"
                    />
                  </>
                )}
              </Box>

              <Box>
                <Button
                  disabled={!canCreateServer}
                  onClick={addClientServer}
                  startIcon={<AddIcon />}
                  variant="contained"
                >
                  {qt('mcp.create_server', 'Create Server')}
                </Button>
              </Box>
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    </Box>
  )
}

export default PanelMcp
