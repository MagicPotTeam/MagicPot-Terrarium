import type { TFunction } from 'i18next'
import type { LLMToolStatus } from '@shared/llm/types'
import type { ChatLoadingStatus } from './chatLoadingStatus'

/** Display only an observed tool event, never infer progress from assistant prose. */
export function getChatToolLoadingStatus(event: LLMToolStatus, t: TFunction): ChatLoadingStatus {
  const toolName =
    String(event.toolName || '')
      .replace(/[^a-zA-Z0-9_.:-]/g, '')
      .slice(0, 128) || 'tool'
  let label: string
  if (event.status === 'running') {
    label =
      toolName === 'web_search'
        ? t('chat.loading_web_search', { defaultValue: 'Searching the web' })
        : toolName === 'web_fetch'
          ? t('chat.loading_web_fetch', { defaultValue: 'Reading a web page' })
          : t('chat.loading_tool_running', { defaultValue: 'Running a tool' })
  } else if (event.status === 'completed') {
    label = t('chat.loading_tool_returned', {
      defaultValue: 'Tool returned; waiting for the model to continue'
    })
  } else if (event.status === 'cancelled') {
    label = t('chat.loading_tool_cancelled', { defaultValue: 'Tool cancelled' })
  } else {
    label = t('chat.loading_tool_failed', { defaultValue: 'Tool failed' })
  }
  // No invented step count, raw arguments, query, response body or file paths.
  return { label, detail: toolName }
}
