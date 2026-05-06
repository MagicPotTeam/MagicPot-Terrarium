import type { LLMProxySvc } from './api/svcLLMProxy'
import type { ProjectTraceDocumentSummary, ProjectTraceReference } from './projectTrace'

export type ProjectTraceRetrievalMatch = {
  trace: ProjectTraceDocumentSummary
  score: number
  reasons: string[]
}

export type RankProjectTraceSummariesOptions = {
  traces: ProjectTraceDocumentSummary[]
  queryText: string
  limit?: number
  now?: Date
}

export type ProjectTraceAgentRerankCandidate = {
  id: string
  name: string
  description?: string
  sourceKind: ProjectTraceDocumentSummary['sourceKind']
  tags: string[]
  updatedAt: string
  eventCount: number
  baselineScore: number
  baselineReasons: string[]
  skillSummary?: {
    summary: string
    applicableTo: string[]
    notes: string[]
    source: NonNullable<ProjectTraceDocumentSummary['skillSummary']>['source']
  }
  softwareRules: string[]
  semanticRules: string[]
}

export type ProjectTraceAgentRerankPayload = {
  task: 'magicpot.project_trace.agent_rerank'
  queryText: string
  limit: number
  baselineTraceIds: string[]
  candidates: ProjectTraceAgentRerankCandidate[]
}

export type ProjectTraceAgentRerankRequest = {
  queryText: string
  limit: number
  baselineMatches: ProjectTraceRetrievalMatch[]
  payload: ProjectTraceAgentRerankPayload
}

export type ProjectTraceAgentRerankResponse = {
  selectedTraceIds: string[]
  confidence?: number
  reasons?: Record<string, string>
}

export type ProjectTraceAgentReranker = (
  request: ProjectTraceAgentRerankRequest
) => Promise<ProjectTraceAgentRerankResponse | string | null | undefined>

export type RankProjectTraceSummariesWithAgentOptions = RankProjectTraceSummariesOptions & {
  agentReranker?: ProjectTraceAgentReranker | null
}

export type ProjectTraceRerankSelection = {
  matches: ProjectTraceRetrievalMatch[]
  source: 'baseline' | 'agent'
  baselineMatches: ProjectTraceRetrievalMatch[]
  agentResponse?: ProjectTraceAgentRerankResponse
  fallbackReason?: string
}

export type CreateProjectTraceLLMAgentRerankerOptions = {
  enabled?: boolean
  llmProxy?: Pick<LLMProxySvc, 'chat'> | null
  profileId?: string | null
  timeoutMs?: number
}

const DEFAULT_TRACE_RETRIEVAL_LIMIT = 4
const DEFAULT_TRACE_AGENT_RERANK_TIMEOUT_MS = 12_000
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'trace',
  'target',
  'canvas',
  'image',
  'project',
  'manual'
])

function truncateText(value: string | undefined, maxLength: number): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function normalizeSearchText(value: string | undefined): string {
  return (value || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function tokenizeText(value: string | undefined): string[] {
  const source = normalizeSearchText(value)
  if (!source) return []
  const tokens = new Set<string>()
  for (const word of source.match(/[a-z0-9_./-]{2,}/g) || []) {
    if (!STOP_WORDS.has(word)) tokens.add(word)
  }
  for (const run of source.match(/[\u3400-\u9fff]{2,}/g) || []) {
    tokens.add(run)
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2))
    }
  }
  return Array.from(tokens)
}

function buildTraceSearchText(trace: ProjectTraceDocumentSummary): string {
  const executableRules = trace.executableRules?.rules || []
  const semanticRules = trace.executableRules?.semanticRules || []
  return [
    trace.name,
    trace.description,
    trace.sourceKind,
    trace.tags.join(' '),
    trace.skillSummary?.summary,
    trace.skillSummary?.applicableTo.join(' '),
    trace.skillSummary?.notes.join(' '),
    executableRules
      .map(
        (rule) =>
          `${rule.type} ${rule.target} ${rule.condition.operator} ${rule.condition.value}${rule.condition.unit} ${rule.feedback}`
      )
      .join(' '),
    semanticRules
      .map(
        (rule) =>
          `${rule.requirement} ${rule.target || ''} ${rule.appliesTo.join(' ')} ${rule.feedback}`
      )
      .join(' ')
  ]
    .filter(Boolean)
    .join('\n')
}

function getProjectTraceRerankLimit(limit: number | undefined): number {
  const numericLimit = Number(limit)
  return Number.isFinite(numericLimit) && numericLimit > 0
    ? Math.floor(numericLimit)
    : DEFAULT_TRACE_RETRIEVAL_LIMIT
}

function describeSoftwareRule(
  rule: NonNullable<ProjectTraceDocumentSummary['executableRules']>['rules'][number]
): string {
  return truncateText(
    [
      rule.type,
      rule.target,
      `${rule.condition.operator} ${rule.condition.value}${rule.condition.unit}`,
      rule.feedback
    ]
      .filter(Boolean)
      .join(' | '),
    240
  )
}

function describeSemanticRule(
  rule: NonNullable<ProjectTraceDocumentSummary['executableRules']>['semanticRules'] extends
    | Array<infer Rule>
    | undefined
    ? Rule
    : never
): string {
  return truncateText(
    [rule.requirement, rule.target, rule.appliesTo.join(', '), rule.feedback]
      .filter(Boolean)
      .join(' | '),
    260
  )
}

function buildProjectTraceAgentRerankCandidate(
  match: ProjectTraceRetrievalMatch
): ProjectTraceAgentRerankCandidate {
  const trace = match.trace
  const skillSummary = trace.skillSummary
    ? {
        summary: truncateText(trace.skillSummary.summary, 420),
        applicableTo: trace.skillSummary.applicableTo
          .slice(0, 8)
          .map((value) => truncateText(value, 120)),
        notes: trace.skillSummary.notes.slice(0, 6).map((value) => truncateText(value, 180)),
        source: trace.skillSummary.source
      }
    : undefined

  return {
    id: trace.id,
    name: truncateText(trace.name, 160),
    ...(trace.description ? { description: truncateText(trace.description, 320) } : {}),
    sourceKind: trace.sourceKind,
    tags: trace.tags.slice(0, 12),
    updatedAt: trace.updatedAt,
    eventCount: trace.eventCount,
    baselineScore: match.score,
    baselineReasons: match.reasons.slice(0, 8).map((reason) => truncateText(reason, 180)),
    ...(skillSummary ? { skillSummary } : {}),
    softwareRules: (trace.executableRules?.rules || []).slice(0, 6).map(describeSoftwareRule),
    semanticRules: (trace.executableRules?.semanticRules || [])
      .slice(0, 6)
      .map(describeSemanticRule)
  }
}

function buildTraceDedupeKey(trace: ProjectTraceDocumentSummary): string {
  const executableRules = trace.executableRules?.rules || []
  const semanticRules = trace.executableRules?.semanticRules || []
  return normalizeSearchText(
    [
      trace.name,
      trace.skillSummary?.summary?.slice(0, 140),
      executableRules
        .map(
          (rule) =>
            `${rule.type}:${rule.condition.operator}:${rule.condition.value}:${rule.condition.unit}`
        )
        .join('|'),
      semanticRules.map((rule) => rule.requirement.slice(0, 160)).join('|')
    ]
      .filter(Boolean)
      .join('|')
  )
}

function scoreTraceRecency(trace: ProjectTraceDocumentSummary, now: Date): number {
  const updatedAt = Date.parse(trace.updatedAt || trace.createdAt || '')
  if (!Number.isFinite(updatedAt)) return 0
  const ageDays = Math.max(0, (now.getTime() - updatedAt) / 86_400_000)
  if (ageDays <= 7) return 2
  if (ageDays <= 30) return 1
  return 0
}

export function rankProjectTraceSummariesForTarget(
  options: RankProjectTraceSummariesOptions
): ProjectTraceRetrievalMatch[] {
  const queryTokens = tokenizeText(options.queryText)
  if (queryTokens.length === 0) return []
  const queryTokenSet = new Set(queryTokens)
  const now = options.now || new Date()
  const deduped = new Map<string, ProjectTraceRetrievalMatch>()

  for (const trace of options.traces) {
    if (trace.localTrust?.trusted === false) continue
    if (trace.runtimePolicy?.allowTargetReference === false) continue
    const searchText = buildTraceSearchText(trace)
    const traceTokens = new Set(tokenizeText(searchText))
    const overlap = queryTokens.filter((token) => traceTokens.has(token))
    if (overlap.length === 0) continue

    const reasons: string[] = []
    let score = overlap.length * 8
    reasons.push(`matched ${overlap.slice(0, 6).join(', ')}`)

    const normalizedSearchText = normalizeSearchText(searchText)
    for (const token of queryTokenSet) {
      if (token.length >= 4 && normalizedSearchText.includes(token)) {
        score += 2
      }
    }

    if (trace.tags.includes('reference-ready')) score += 4
    if ((trace.executableRules?.rules.length || 0) > 0) {
      score += 4
      reasons.push('software rules')
    }
    if ((trace.executableRules?.semanticRules?.length || 0) > 0) {
      score += 3
      reasons.push('semantic rules')
    }
    score += Math.min(3, Math.log2(Math.max(1, trace.eventCount)))
    score += scoreTraceRecency(trace, now)

    const match: ProjectTraceRetrievalMatch = {
      trace,
      score: Math.round(score * 100) / 100,
      reasons
    }
    const dedupeKey = buildTraceDedupeKey(trace) || trace.id
    const existing = deduped.get(dedupeKey)
    if (!existing || match.score > existing.score) {
      deduped.set(dedupeKey, match)
    }
  }

  return Array.from(deduped.values())
    .sort(
      (left, right) => right.score - left.score || left.trace.name.localeCompare(right.trace.name)
    )
    .slice(0, options.limit ?? DEFAULT_TRACE_RETRIEVAL_LIMIT)
}

export function buildProjectTraceAgentRerankPayload(options: {
  queryText: string
  limit?: number
  baselineMatches: ProjectTraceRetrievalMatch[]
}): ProjectTraceAgentRerankPayload {
  const limit = getProjectTraceRerankLimit(options.limit)
  const limitedMatches = options.baselineMatches.slice(0, Math.max(limit, 1))
  return {
    task: 'magicpot.project_trace.agent_rerank',
    queryText: truncateText(options.queryText, 2400),
    limit,
    baselineTraceIds: limitedMatches.map((match) => match.trace.id),
    candidates: limitedMatches.map(buildProjectTraceAgentRerankCandidate)
  }
}

export function buildProjectTraceAgentRerankPrompt(
  payload: ProjectTraceAgentRerankPayload
): string {
  return [
    'You are reranking MagicPot project trace summaries for a canvas target run.',
    'The software baseline has already done recall. You may only reorder or select from candidate IDs listed in baselineTraceIds.',
    'Do not invent trace IDs. Do not request tools, shell commands, files, or terminal access.',
    'Return strict JSON only with this shape:',
    JSON.stringify({
      selectedTraceIds: ['candidate-trace-id'],
      confidence: 0.75,
      reasons: {
        'candidate-trace-id': 'short relevance reason'
      }
    }),
    'selectedTraceIds must be non-empty when any candidate is useful and must contain at most limit IDs.',
    'Payload:',
    JSON.stringify(payload, null, 2)
  ].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stripJsonMarkdownFence(value: string): string {
  const trimmed = value.trim()
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return (fenceMatch?.[1] || trimmed).trim()
}

function parseJsonFromAgentText(value: string): unknown {
  const withoutFence = stripJsonMarkdownFence(value)
  try {
    return JSON.parse(withoutFence)
  } catch {
    const firstObject = withoutFence.indexOf('{')
    const lastObject = withoutFence.lastIndexOf('}')
    if (firstObject >= 0 && lastObject > firstObject) {
      return JSON.parse(withoutFence.slice(firstObject, lastObject + 1))
    }
    throw new Error('Project trace agent reranker response did not contain JSON.')
  }
}

function normalizeAgentReasonMap(value: unknown): Record<string, string> | undefined {
  if (isRecord(value)) {
    const reasons: Record<string, string> = {}
    for (const [id, reason] of Object.entries(value)) {
      const normalizedId = id.trim()
      const normalizedReason = typeof reason === 'string' ? truncateText(reason, 240) : ''
      if (normalizedId && normalizedReason) {
        reasons[normalizedId] = normalizedReason
      }
    }
    return Object.keys(reasons).length > 0 ? reasons : undefined
  }

  if (Array.isArray(value)) {
    const reasons: Record<string, string> = {}
    for (const entry of value) {
      if (!isRecord(entry)) continue
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      const reason = typeof entry.reason === 'string' ? truncateText(entry.reason, 240) : ''
      if (id && reason) {
        reasons[id] = reason
      }
    }
    return Object.keys(reasons).length > 0 ? reasons : undefined
  }

  return undefined
}

function normalizeProjectTraceAgentRerankResponse(
  value: unknown
): ProjectTraceAgentRerankResponse | null {
  const record = isRecord(value) ? value : null
  const selectedTraceIdsValue = Array.isArray(value)
    ? value
    : record?.selectedTraceIds || record?.traceIds || record?.selected_trace_ids
  if (!Array.isArray(selectedTraceIdsValue)) return null
  const selectedTraceIds: string[] = []
  for (const id of selectedTraceIdsValue) {
    if (typeof id !== 'string') return null
    const normalizedId = id.trim()
    if (!normalizedId) return null
    selectedTraceIds.push(normalizedId)
  }

  const confidenceValue = record?.confidence
  const confidence =
    typeof confidenceValue === 'number' && Number.isFinite(confidenceValue)
      ? Math.max(0, Math.min(1, confidenceValue))
      : undefined
  const reasons = normalizeAgentReasonMap(record?.reasons)

  return {
    selectedTraceIds,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reasons ? { reasons } : {})
  }
}

export function parseProjectTraceAgentRerankResponse(
  content: string
): ProjectTraceAgentRerankResponse | null {
  if (!content.trim()) return null
  try {
    return normalizeProjectTraceAgentRerankResponse(parseJsonFromAgentText(content))
  } catch {
    return null
  }
}

export function sanitizeProjectTraceAgentRerankSelection(options: {
  baselineMatches: ProjectTraceRetrievalMatch[]
  response: ProjectTraceAgentRerankResponse
  limit?: number
}): ProjectTraceRetrievalMatch[] | null {
  const { baselineMatches, response } = options
  const limit = getProjectTraceRerankLimit(options.limit)
  if (response.selectedTraceIds.length === 0) return null

  const candidateIds = new Set(baselineMatches.map((match) => match.trace.id))
  const matchById = new Map(baselineMatches.map((match) => [match.trace.id, match] as const))
  const dedupedSelectedIds: string[] = []

  for (const id of response.selectedTraceIds) {
    if (!candidateIds.has(id)) return null
    if (!dedupedSelectedIds.includes(id)) {
      dedupedSelectedIds.push(id)
    }
  }

  const limitedSelectedIds = dedupedSelectedIds.slice(0, limit)
  if (limitedSelectedIds.length === 0) return null

  return limitedSelectedIds.map((id) => matchById.get(id)!)
}

export async function rankProjectTraceSummariesForTargetWithAgentReranker(
  options: RankProjectTraceSummariesWithAgentOptions
): Promise<ProjectTraceRerankSelection> {
  const limit = getProjectTraceRerankLimit(options.limit)
  const baselineMatches = rankProjectTraceSummariesForTarget({
    traces: options.traces,
    queryText: options.queryText,
    limit,
    now: options.now
  })

  if (!options.agentReranker) {
    return {
      matches: baselineMatches,
      source: 'baseline',
      baselineMatches,
      fallbackReason: 'agent reranker unavailable'
    }
  }

  if (baselineMatches.length === 0) {
    return {
      matches: baselineMatches,
      source: 'baseline',
      baselineMatches,
      fallbackReason: 'baseline returned no candidates'
    }
  }

  const payload = buildProjectTraceAgentRerankPayload({
    queryText: options.queryText,
    limit,
    baselineMatches
  })

  try {
    const rawResponse = await options.agentReranker({
      queryText: options.queryText,
      limit,
      baselineMatches,
      payload
    })
    const agentResponse =
      typeof rawResponse === 'string'
        ? parseProjectTraceAgentRerankResponse(rawResponse)
        : normalizeProjectTraceAgentRerankResponse(rawResponse)
    if (!agentResponse) {
      return {
        matches: baselineMatches,
        source: 'baseline',
        baselineMatches,
        fallbackReason: 'agent reranker returned an unparsable response'
      }
    }

    const rerankedMatches = sanitizeProjectTraceAgentRerankSelection({
      baselineMatches,
      response: agentResponse,
      limit
    })
    if (!rerankedMatches) {
      return {
        matches: baselineMatches,
        source: 'baseline',
        baselineMatches,
        agentResponse,
        fallbackReason: 'agent reranker returned empty or invalid trace ids'
      }
    }

    return {
      matches: rerankedMatches,
      source: 'agent',
      baselineMatches,
      agentResponse
    }
  } catch (error) {
    return {
      matches: baselineMatches,
      source: 'baseline',
      baselineMatches,
      fallbackReason: error instanceof Error ? error.message : 'agent reranker failed'
    }
  }
}

export async function resolveProjectTraceMatchesWithOptionalReranker(
  options: RankProjectTraceSummariesWithAgentOptions
): Promise<ProjectTraceRerankSelection> {
  return rankProjectTraceSummariesForTargetWithAgentReranker(options)
}

function withProjectTraceRerankTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Project trace agent reranker timed out.')),
      timeoutMs
    )
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  })
}

export function createProjectTraceLLMAgentReranker(
  options: CreateProjectTraceLLMAgentRerankerOptions
): ProjectTraceAgentReranker | null {
  const profileId = options.profileId?.trim()
  const llmProxy = options.llmProxy
  if (!options.enabled || !llmProxy || !profileId) return null
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : DEFAULT_TRACE_AGENT_RERANK_TIMEOUT_MS

  return async (request) => {
    const response = await withProjectTraceRerankTimeout(
      llmProxy.chat({
        profileId,
        reasoningEffort: 'minimal',
        systemPrompt:
          'You rerank MagicPot project trace candidates. Return only strict JSON. Never use tools or terminal commands.',
        messages: [
          {
            role: 'user',
            content: buildProjectTraceAgentRerankPrompt(request.payload)
          }
        ]
      }),
      timeoutMs
    )
    return parseProjectTraceAgentRerankResponse(response.content)
  }
}

export function compressProjectTraceReferencesForTarget(
  references: ProjectTraceReference[],
  maxChars = 6_000
): ProjectTraceReference[] {
  if (references.length === 0) return []
  const allowedReferences = references.filter(
    (reference) =>
      reference.referencePack?.runtimePolicy.allowTargetReference !== false &&
      reference.runtimePolicy?.allowTargetReference !== false
  )
  const limitedReferences = allowedReferences.slice(0, 4)
  const budgetPerTrace = Math.max(500, Math.floor(maxChars / Math.max(1, limitedReferences.length)))
  return limitedReferences.map((reference) => {
    const referencePack = reference.referencePack
      ? {
          ...reference.referencePack,
          contentBrief: truncateText(reference.referencePack.contentBrief, budgetPerTrace),
          budget: {
            ...reference.referencePack.budget,
            maxChars: budgetPerTrace,
            contentBriefChars: truncateText(reference.referencePack.contentBrief, budgetPerTrace)
              .length
          },
          softwareRules: reference.referencePack.softwareRules.slice(0, 6).map((rule) => ({
            ...rule,
            feedback: truncateText(rule.feedback, 220)
          })),
          ...(reference.referencePack.semanticRules?.length
            ? {
                semanticRules: reference.referencePack.semanticRules.slice(0, 4).map((rule) => ({
                  ...rule,
                  requirement: truncateText(rule.requirement, 260),
                  feedback: truncateText(rule.feedback, 220)
                }))
              }
            : {}),
          unsupportedNotes: reference.referencePack.unsupportedNotes
            .slice(0, 4)
            .map((note) => truncateText(note, 140)),
          safetyNotes: reference.referencePack.safetyNotes
            .slice(0, 6)
            .map((note) => truncateText(note, 180))
        }
      : undefined
    return {
      id: reference.id,
      name: truncateText(reference.name, 160),
      ...(reference.description ? { description: truncateText(reference.description, 260) } : {}),
      sourceKind: reference.sourceKind,
      updatedAt: reference.updatedAt,
      contentPreview: truncateText(
        referencePack?.contentBrief || reference.contentPreview,
        budgetPerTrace
      ),
      ...(referencePack ? { referencePack } : {}),
      ...(reference.trust ? { trust: reference.trust } : {}),
      ...(reference.runtimePolicy ? { runtimePolicy: reference.runtimePolicy } : {}),
      ...(reference.skillSummary
        ? {
            skillSummary: {
              ...reference.skillSummary,
              summary: truncateText(reference.skillSummary.summary, 420),
              applicableTo: reference.skillSummary.applicableTo
                .slice(0, 6)
                .map((entry) => truncateText(entry, 100)),
              notes: reference.skillSummary.notes
                .slice(0, 4)
                .map((entry) => truncateText(entry, 140))
            }
          }
        : {}),
      ...(reference.executableRules
        ? {
            executableRules: {
              version: 1 as const,
              generatedAt: reference.executableRules.generatedAt,
              rules: reference.executableRules.rules.slice(0, 6),
              ...(reference.executableRules.semanticRules?.length
                ? { semanticRules: reference.executableRules.semanticRules.slice(0, 4) }
                : {}),
              unsupportedNotes: reference.executableRules.unsupportedNotes.slice(0, 4)
            }
          }
        : {}),
      eventCount: reference.eventCount,
      tags: reference.tags.slice(0, 12)
    }
  })
}
