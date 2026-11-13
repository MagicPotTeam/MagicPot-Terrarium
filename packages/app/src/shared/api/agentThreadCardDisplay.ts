import { AGENT_THREAD_INTERACTION_LIMITS as LIMITS } from './agentThreadInteraction'

export const AGENT_THREAD_CARD_DISPLAY_CONTRACT = 'agent-thread-card-display/v1'
export const AGENT_THREAD_CARD_SUBTITLE_LIMIT = 200
export const AGENT_THREAD_CARD_FOOTER_LIMIT = 200
export const AGENT_THREAD_CARD_ICON_LIMIT = 64
export const AGENT_THREAD_CARD_ACCENTS = ['primary', 'info', 'success', 'warning', 'danger', 'neutral'] as const
export type AgentThreadCardAccent = typeof AGENT_THREAD_CARD_ACCENTS[number]
export const AGENT_THREAD_CARD_ACTION_STYLES = ['primary', 'secondary', 'danger'] as const
export type AgentThreadCardActionStyle = typeof AGENT_THREAD_CARD_ACTION_STYLES[number]
export type AgentThreadCardAction = { id: string; label: string; style?: AgentThreadCardActionStyle }
export const AGENT_THREAD_CARD_FIELD_LIMITS = { maximum: 8, label: 200, value: 1000, totalText: 4096 } as const
export const AGENT_THREAD_CARD_FIELDS_SCHEMA = {
  type: 'array', maxItems: AGENT_THREAD_CARD_FIELD_LIMITS.maximum,
  items: {
    type: 'object', additionalProperties: false, required: ['label', 'value'],
    properties: {
      label: { type: 'string', maxLength: AGENT_THREAD_CARD_FIELD_LIMITS.label },
      value: { type: 'string', maxLength: AGENT_THREAD_CARD_FIELD_LIMITS.value },
      inline: { type: 'boolean' }
    }
  }
}
export type AgentThreadCardField = { label: string; value: string; inline?: boolean }
export type AgentThreadChoiceCardPrompt = {
  kind: 'show_card'
  title: string
  icon?: string
  subtitle?: string
  body?: string
  footer?: string
  accent?: AgentThreadCardAccent
  fields?: AgentThreadCardField[]
  actions: AgentThreadCardAction[]
}
export type AgentThreadCardDisplay = {
  contract: typeof AGENT_THREAD_CARD_DISPLAY_CONTRACT
  status: 'provided'
  mode: 'display-only'
  card: { title: string; icon?: string; subtitle?: string; body?: string; footer?: string; accent?: AgentThreadCardAccent; fields?: AgentThreadCardField[] }
  untrustedData: true
  grantsPermission: false
}

const exactKeys = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key))

/** Validates parsed JSON field rows; caller input is never returned as authority. */
const validFields = (value: unknown): value is AgentThreadCardField[] => {
  if (!Array.isArray(value) || value.length > AGENT_THREAD_CARD_FIELD_LIMITS.maximum) return false
  let total = 0
  for (const field of value) {
    if (!exactKeys(field, ['label', 'value'], ['inline']) || typeof field.label !== 'string' || typeof field.value !== 'string' ||
      field.label.length > AGENT_THREAD_CARD_FIELD_LIMITS.label || field.value.length > AGENT_THREAD_CARD_FIELD_LIMITS.value ||
      Object.hasOwn(field, 'inline') && typeof field.inline !== 'boolean') return false
    total += field.label.length + field.value.length
    if (total > AGENT_THREAD_CARD_FIELD_LIMITS.totalText) return false
  }
  return true
}
const validCardText = (card: Record<string, unknown>) =>
  typeof card.title === 'string' && !!card.title.trim() && card.title.length <= LIMITS.title &&
  (!Object.hasOwn(card, 'icon') || typeof card.icon === 'string' && card.icon.length <= AGENT_THREAD_CARD_ICON_LIMIT) &&
  (!Object.hasOwn(card, 'subtitle') || typeof card.subtitle === 'string' && card.subtitle.length <= AGENT_THREAD_CARD_SUBTITLE_LIMIT) &&
  (!Object.hasOwn(card, 'body') || typeof card.body === 'string' && card.body.length <= LIMITS.body) &&
  (!Object.hasOwn(card, 'footer') || typeof card.footer === 'string' && card.footer.length <= AGENT_THREAD_CARD_FOOTER_LIMIT) &&
  (!Object.hasOwn(card, 'fields') || validFields(card.fields)) &&
  (!Object.hasOwn(card, 'accent') || typeof card.accent === 'string' && AGENT_THREAD_CARD_ACCENTS.some(accent => accent === card.accent))
const boundedJson = (content: unknown): unknown => {
  if (typeof content !== 'string' || content.length > 32768 || new TextEncoder().encode(content).byteLength > 32768) return undefined
  try { return JSON.parse(content) } catch { return undefined }
}

/** Parse only bounded serialized result data. This marker never supplies permissions or a renderer acknowledgement. */
export function parseAgentThreadCardDisplay(content: unknown): AgentThreadCardDisplay | undefined {
  const value = boundedJson(content)
  if (!exactKeys(value, ['contract', 'status', 'mode', 'card', 'untrustedData', 'grantsPermission']) ||
    value.contract !== AGENT_THREAD_CARD_DISPLAY_CONTRACT || value.status !== 'provided' || value.mode !== 'display-only' ||
    value.untrustedData !== true || value.grantsPermission !== false ||
    !exactKeys(value.card, ['title'], ['icon', 'subtitle', 'body', 'fields', 'footer', 'accent'])) return undefined
  if (!validCardText(value.card)) return undefined
  return value as AgentThreadCardDisplay
}

/** Choice-card prompt data, not a provided receipt, input-values form or permission. */
export function parseAgentThreadChoiceCard(content: unknown): AgentThreadChoiceCardPrompt | undefined {
  const value = boundedJson(content)
  if (!exactKeys(value, ['kind', 'title', 'actions'], ['icon', 'subtitle', 'body', 'fields', 'footer', 'accent']) || value.kind !== 'show_card' || !validCardText(value) ||
    !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 4) return undefined
  const ids = new Set<string>()
  for (const action of value.actions) {
    if (!exactKeys(action, ['id', 'label'], ['style']) || typeof action.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(action.id) ||
      typeof action.label !== 'string' || !action.label.trim() || action.label.length > LIMITS.actionLabel || ids.has(action.id) ||
      Object.hasOwn(action, 'style') && (typeof action.style !== 'string' || !AGENT_THREAD_CARD_ACTION_STYLES.some(style => style === action.style))) return undefined
    ids.add(action.id)
  }
  return value as AgentThreadChoiceCardPrompt
}
