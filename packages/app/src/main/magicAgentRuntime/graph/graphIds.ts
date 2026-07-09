import { createHash } from 'node:crypto'

export const MAGIC_AGENT_GRAPH_ID_MAX_LENGTH = 128
export const MAGIC_AGENT_GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const UNSAFE_PATH_FRAGMENT_PATTERN = /(^|[\\/])\.\.($|[\\/])|\.\./

const cleanString = (value: unknown): string => String(value || '').trim()

export const isSafeMagicAgentGraphId = (graphId: unknown): graphId is string => {
  const normalized = cleanString(graphId)
  return (
    normalized.length > 0 &&
    normalized.length <= MAGIC_AGENT_GRAPH_ID_MAX_LENGTH &&
    MAGIC_AGENT_GRAPH_ID_PATTERN.test(normalized) &&
    !normalized.includes('/') &&
    !normalized.includes('\\') &&
    !UNSAFE_PATH_FRAGMENT_PATTERN.test(normalized)
  )
}

export const assertSafeMagicAgentGraphId = (graphId: unknown, label = 'graph id'): string => {
  const normalized = cleanString(graphId)
  if (!isSafeMagicAgentGraphId(normalized)) {
    throw new Error(
      `Unsafe MagicAgentGraph ${label}: expected 1-${MAGIC_AGENT_GRAPH_ID_MAX_LENGTH} characters matching ${MAGIC_AGENT_GRAPH_ID_PATTERN.source} without path separators or '..'.`
    )
  }
  return normalized
}

export const assertSafeMagicAgentGraphRunId = (runId: unknown): string =>
  assertSafeMagicAgentGraphId(runId, 'run id')

export const createMagicAgentGraphStorageSegment = (prefix: string, value: string): string => {
  const safePrefix = cleanString(prefix).replace(/[^A-Za-z0-9_-]/g, '-') || 'item'
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32)
  return `${safePrefix}-${digest}`
}
