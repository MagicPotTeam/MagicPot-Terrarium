import crypto from 'crypto'
import type { SemanticMemoryChunk, SemanticMemoryScope } from '@shared/magicAgentPlatform2/memory'
import type { AssistantSessionRecord } from '../../assistantRuntime/types'

export type AssistantSessionMemorySourceOptions = {
  scopes?: Array<'session' | 'workspace' | 'agent' | 'drive'>
  agentId?: string
  driveId?: string
  now?: number
}

export class AssistantSessionMemorySource {
  createChunks(
    session: AssistantSessionRecord,
    options: AssistantSessionMemorySourceOptions = {}
  ): SemanticMemoryChunk[] {
    const scopeKinds = options.scopes ?? ['session', 'workspace']
    if (scopeKinds.includes('agent') && !options.agentId)
      throw new Error('Agent attribution unavailable')
    if (scopeKinds.includes('drive') && !options.driveId)
      throw new Error('Drive attribution unavailable')
    const now = options.now ?? session.updatedAt
    const scopes: SemanticMemoryScope[] = scopeKinds.map((kind) => ({
      kind,
      id:
        kind === 'session'
          ? session.sessionKey
          : kind === 'workspace'
            ? session.workspace.workspaceId
            : kind === 'agent'
              ? options.agentId!
              : options.driveId!
    }))
    const inputs: Array<{
      key: string
      content: string
      createdAt: number
      runId?: string
      messageIndex?: number
    }> = []
    session.messages.forEach((message, index) => {
      if (message.content.trim())
        inputs.push({
          key: `message:${index}`,
          content: `${message.role}: ${message.content}`,
          createdAt: session.createdAt,
          messageIndex: index
        })
    })
    session.runs.forEach((run) => {
      const text = [
        run.requestText && `request: ${run.requestText}`,
        run.responseText && `response: ${run.responseText}`
      ]
        .filter(Boolean)
        .join('\n')
      if (text)
        inputs.push({
          key: `run:${run.runId}`,
          content: text,
          createdAt: run.updatedAt,
          runId: run.runId
        })
    })
    const chunks: SemanticMemoryChunk[] = []
    for (const input of inputs) {
      const redacted = redactSecrets(input.content)
      if (!redacted.content.trim()) continue
      const contentHash = sha256(redacted.content)
      for (const scope of scopes)
        chunks.push({
          id: `asm:${sha256(`${session.sessionKey}:${input.key}:${scope.kind}:${scope.id}`).slice(0, 32)}`,
          scope,
          content: redacted.content,
          summary: redacted.content.slice(0, 240),
          importance: 0.5,
          lifetime: 'durable',
          visibility: 'private',
          provenance: {
            source: 'assistant-session',
            sourceId: input.key,
            sessionId: session.sessionKey,
            runId: input.runId,
            messageIndex: input.messageIndex,
            createdAt: input.createdAt,
            contentHash
          },
          sensitive: {
            sensitive: redacted.kinds.length > 0,
            redacted: redacted.kinds.length > 0,
            redactionKinds: redacted.kinds,
            allowRemoteEmbedding: false
          },
          createdAt: input.createdAt,
          updatedAt: now
        })
    }
    return chunks
  }
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['authorization', /\b(?:authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+/=-]+/gi],
  ['api-key', /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^\s,"']{6,}["']?/gi],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g]
]
function redactSecrets(value: string): { content: string; kinds: string[] } {
  let content = value
  const kinds: string[] = []
  for (const [kind, pattern] of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      kinds.push(kind)
      pattern.lastIndex = 0
      content = content.replace(pattern, `[REDACTED:${kind}]`)
    }
    pattern.lastIndex = 0
  }
  return { content, kinds }
}
const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex')
