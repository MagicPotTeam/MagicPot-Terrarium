import type { Config } from '@shared/config/config'
import { getRemoteLlmServerOrigin } from '@renderer/utils/llmProfileUtils'

export type ToolRouteDraft = {
  channel: string
  scopeType: string
  scopeId: string
  threadId?: string
}

type ToolApiClientOptions = {
  config: Config
  apiOrigin?: string
  authSecret?: string
}

type ToolCallResponse = {
  error?: string
  result?: {
    content?: string
    metadata?: Record<string, unknown>
  }
}

const cleanString = (value?: string | null): string => String(value || '').trim()

const normalizeApiOrigin = (config: Config, apiOrigin?: string): string => {
  const explicitOrigin = cleanString(apiOrigin)
  if (explicitOrigin) {
    return explicitOrigin.replace(/\/+$/, '')
  }

  const localPort = config.local_llm_server_config?.port || 3721
  if (config.local_llm_server_config?.enable_server !== false) {
    return `http://127.0.0.1:${localPort}`
  }

  return getRemoteLlmServerOrigin(config).replace(/\/+$/, '')
}

const createToolRequestHeaders = (authSecret?: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(cleanString(authSecret) ? { Authorization: `Bearer ${cleanString(authSecret)}` } : {})
})

export const callSessionTool = async (
  options: ToolApiClientOptions & {
    route: ToolRouteDraft
    toolName: string
    args: Record<string, unknown>
    allowedToolNames?: string[]
  }
): Promise<NonNullable<ToolCallResponse['result']>> => {
  const apiOrigin = normalizeApiOrigin(options.config, options.apiOrigin)
  if (!apiOrigin) {
    throw new Error('Enter a reachable tool API origin first.')
  }

  const scopeId = cleanString(options.route.scopeId)
  if (!scopeId) {
    throw new Error('Enter the session scope ID first.')
  }

  const threadId = cleanString(options.route.threadId)
  const response = await fetch(`${apiOrigin}/api/tools/call`, {
    method: 'POST',
    headers: createToolRequestHeaders(options.authSecret),
    body: JSON.stringify({
      channel: options.route.channel,
      scopeType: options.route.scopeType,
      scopeId,
      ...(threadId ? { threadId } : {}),
      toolName: options.toolName,
      args: options.args,
      ...(options.allowedToolNames ? { allowedToolNames: options.allowedToolNames } : {})
    })
  })

  let payload: ToolCallResponse | null = null
  try {
    payload = (await response.json()) as ToolCallResponse
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed (${response.status} ${response.statusText}).`)
  }

  if (!payload?.result) {
    throw new Error('The tool API returned an empty result.')
  }

  return payload.result
}
