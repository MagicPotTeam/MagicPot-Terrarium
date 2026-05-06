import type {
  ProjectTraceDocument,
  ProjectTraceEventSummary,
  ProjectTraceExecutableRule,
  ProjectTraceExecutableRulesDocument,
  ProjectTraceSemanticRule,
  ProjectTraceSkillSummary
} from './projectTrace'

function normalizeMemoryText(value: string | undefined): string {
  return (value || '')
    .replace(/,/g, '')
    .replace(/[，。；;、]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactMemoryText(value: string | undefined, maxLength: number): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function parsePositiveNumber(value: string | undefined): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function extractNumberNearTerms(
  text: string | undefined,
  metricTerms: string,
  relationTerms: string,
  unitTerms = ''
): number | null {
  const source = normalizeMemoryText(text)
  if (!source) return null
  const unit = unitTerms || '(?:px|像素|度|°|%|百分比|倍)?'
  const patterns = [
    new RegExp(
      `${metricTerms}[\\s\\S]{0,96}${relationTerms}[^0-9]{0,16}(\\d+(?:\\.\\d+)?)\\s*${unit}`,
      'i'
    ),
    new RegExp(
      `${relationTerms}[^0-9]{0,16}(\\d+(?:\\.\\d+)?)\\s*${unit}[\\s\\S]{0,96}${metricTerms}`,
      'i'
    )
  ]
  for (const pattern of patterns) {
    const parsed = parsePositiveNumber(source.match(pattern)?.[1])
    if (parsed !== null) return parsed
  }
  return null
}

export function extractProjectTraceMovementLimitPx(text: string | undefined): number | null {
  return extractNumberNearTerms(
    text,
    '(?:movement_distance_px|movement_distance|move_distance|单次移动距离|移动距离|位移距离|最大位移|位移|移动|拖动|挪动|move|movement|drag)',
    '(?:不能超过|不得超过|不超过|超过|不能超出|不得超出|不超出|超出|最多|小于等于|>=|>|＞|≥|<=|≤|within|no more than|not exceed)',
    '(?:px|像素)?'
  )
}

export function extractProjectTraceScaleLimitRatio(text: string | undefined): number | null {
  const source = normalizeMemoryText(text)
  if (!source || !/(?:缩放|尺寸|大小|宽高|scale|resize)/i.test(source)) return null
  const raw = extractNumberNearTerms(
    source,
    '(?:单次缩放|缩放幅度|尺寸变化|大小变化|宽高变化|scale|resize)',
    '(?:不能超过|不得超过|不超过|超过|不能超出|不得超出|不超出|超出|最多|小于等于|>=|>|＞|≥|<=|≤|within|no more than|not exceed)',
    '(?:%|百分比|倍|ratio)?'
  )
  if (raw === null) return null
  if (source.includes('%') || source.includes('百分比')) return raw / 100
  if (source.includes('倍') || /ratio/i.test(source)) return raw > 1 ? raw - 1 : raw
  return raw > 1 ? raw / 100 : raw
}

export function extractProjectTraceRotationLimitDeg(text: string | undefined): number | null {
  return extractNumberNearTerms(
    text,
    '(?:单次旋转|旋转角度|角度变化|旋转|rotation|rotate)',
    '(?:不能超过|不得超过|不超过|超过|不能超出|不得超出|不超出|超出|最多|小于等于|>=|>|＞|≥|<=|≤|within|no more than|not exceed)',
    '(?:度|°|deg|degree)?'
  )
}

export function extractProjectTraceDeleteRule(text: string | undefined): boolean {
  const source = normalizeMemoryText(text)
  return /(?:不能|不得|不要|禁止|严禁|不允许|保留|keep|must keep|do not)\s*(?:删除|移除|删掉|delete|remove)/i.test(
    source
  )
}

export function extractProjectTraceLayerLockRule(text: string | undefined): boolean {
  const source = normalizeMemoryText(text)
  return /(?:不能|不得|不要|禁止|严禁|不允许|保持|固定|keep|lock|do not)\s*(?:调整|改变|移动|更改)?\s*(?:图层|层级|前后顺序|叠放|zIndex|z-index|z order|layer)/i.test(
    source
  )
}

export function extractProjectTraceRuleText(trace: ProjectTraceDocument): string {
  const sections = [trace.manifest.description || '']
  const intentSection = extractRuleTextFromMarkdown(trace.markdown)
  if (intentSection) sections.push(intentSection)
  return sections.filter(Boolean).join('\n')
}

function extractRuleTextFromMarkdown(markdown: string | undefined): string {
  return (
    (markdown || '')
      .split(
        /\n##\s*(?:操作摘要|Operation Summary|追踪摘要|安全|Safety|本次追踪总结|技艺摘要|可执行规则)\b/i
      )[0]
      ?.trim() || ''
  )
}

function createRule(
  input: Omit<ProjectTraceExecutableRule, 'mode' | 'source' | 'confidence'> &
    Partial<Pick<ProjectTraceExecutableRule, 'mode' | 'source' | 'confidence'>>
): ProjectTraceExecutableRule {
  return {
    ...input,
    mode: input.mode || 'software',
    source: input.source || 'trace_intent',
    confidence: input.confidence ?? 0.82
  }
}

function createSemanticRule(options: {
  requirement: string
  name: string
  rules: ProjectTraceExecutableRule[]
}): ProjectTraceSemanticRule | null {
  const requirement = compactMemoryText(options.requirement, 900)
  if (!requirement) return null
  if (options.rules.length > 0 && requirement.length < 80) return null

  return {
    id: 'semantic-rule-trace-intent',
    requirement,
    target: 'canvas workflow',
    appliesTo: ['game art workflow', 'target execution reference', 'realtime model review'],
    feedback: `Review the current operation against the trace intent "${compactMemoryText(options.name, 80)}". If the operation changes the intended composition, asset relationship, scale, position, or workflow outcome, ask the user to undo, review, or explicitly override this project memory.`,
    mode: 'model_review',
    source: 'trace_intent',
    confidence: options.rules.length > 0 ? 0.62 : 0.7
  }
}

export function buildProjectTraceSkillSummary(options: {
  name: string
  description?: string
  events?: ProjectTraceEventSummary[]
  generatedAt?: string
  source?: 'software' | 'model'
}): ProjectTraceSkillSummary {
  const events = options.events || []
  const canvasEvents = events.filter((event) => event.scope === 'canvas')
  const targetEvents = events.filter((event) => event.scope === 'target')
  const description = compactMemoryText(options.description, 260)
  const actionSummary =
    events.length > 0
      ? `本次追踪沉淀了 ${events.length} 个脱敏操作摘要，其中画布操作 ${canvasEvents.length} 个、目标执行操作 ${targetEvents.length} 个。`
      : '本次追踪尚未包含可复用操作事件。'

  return {
    version: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    summary: description ? `${description} ${actionSummary}` : `${options.name}：${actionSummary}`,
    applicableTo: Array.from(
      new Set([
        ...(canvasEvents.length ? ['画布操作', '游戏美术排版'] : []),
        ...(targetEvents.length ? ['目标执行'] : []),
        '项目操作记忆'
      ])
    ),
    notes: [
      '该摘要由脱敏后的追踪说明和操作事件生成。',
      '目标执行引用时应作为项目经验参考，不覆盖用户当前目标。'
    ],
    source: options.source || 'software'
  }
}

export function buildProjectTraceExecutableRules(options: {
  name: string
  description?: string
  markdown?: string
  events?: ProjectTraceEventSummary[]
  generatedAt?: string
}): ProjectTraceExecutableRulesDocument {
  const generatedAt = options.generatedAt || new Date().toISOString()
  const ruleText = [options.description, extractRuleTextFromMarkdown(options.markdown)]
    .filter(Boolean)
    .join('\n')
  const rules: ProjectTraceExecutableRule[] = []
  const movementLimitPx = extractProjectTraceMovementLimitPx(ruleText)
  const scaleLimitRatio = extractProjectTraceScaleLimitRatio(ruleText)
  const rotationLimitDeg = extractProjectTraceRotationLimitDeg(ruleText)

  if (movementLimitPx) {
    rules.push(
      createRule({
        id: 'rule-canvas-move-distance',
        type: 'canvas.move.distance',
        target: 'selected.image',
        condition: { operator: '>', value: movementLimitPx, unit: 'px' },
        feedback: `图片移动距离过大，请复核位置，或将单次移动控制在 ${Math.round(movementLimitPx)}px 以内。`
      })
    )
  }

  if (scaleLimitRatio) {
    rules.push(
      createRule({
        id: 'rule-canvas-resize-scale',
        type: 'canvas.resize.scale',
        target: 'selected.image',
        condition: {
          operator: '>',
          value: Math.round(scaleLimitRatio * 1000) / 1000,
          unit: 'ratio'
        },
        feedback: `图片缩放幅度过大，请复核尺寸变化，或将单次缩放变化控制在 ${Math.round(scaleLimitRatio * 100)}% 以内。`
      })
    )
  }

  if (rotationLimitDeg) {
    rules.push(
      createRule({
        id: 'rule-canvas-rotate-angle',
        type: 'canvas.rotate.angle',
        target: 'selected.image',
        condition: { operator: '>', value: rotationLimitDeg, unit: 'deg' },
        feedback: `图片旋转角度过大，请复核方向，或将单次旋转控制在 ${Math.round(rotationLimitDeg)}° 以内。`
      })
    )
  }

  if (extractProjectTraceDeleteRule(ruleText)) {
    rules.push(
      createRule({
        id: 'rule-canvas-delete-item',
        type: 'canvas.delete.item',
        target: 'selected.canvas_item',
        condition: { operator: '>', value: 0, unit: 'count' },
        feedback:
          '追踪规则要求保留相关元素。本次删除可能破坏参考流程，请撤回删除或确认这是新的目标要求。'
      })
    )
  }

  if (extractProjectTraceLayerLockRule(ruleText)) {
    rules.push(
      createRule({
        id: 'rule-canvas-layer-change',
        type: 'canvas.layer.change',
        target: 'selected.canvas_item',
        condition: { operator: '>', value: 0, unit: 'count' },
        feedback: '追踪规则要求保持图层或前后顺序。本次层级变化可能破坏参考流程，请复核叠放关系。'
      })
    )
  }

  const semanticRule = createSemanticRule({
    requirement: ruleText,
    name: options.name,
    rules
  })
  const semanticRules = semanticRule ? [semanticRule] : []

  return {
    version: 1,
    generatedAt,
    rules,
    ...(semanticRules.length ? { semanticRules } : {}),
    unsupportedNotes: rules.length
      ? []
      : [
          `未从「${options.name}」中提取到当前软件层可执行规则。当前支持：移动距离、缩放幅度、旋转角度、禁止删除、锁定图层。该追踪仍可作为技艺摘要被目标引用。`
        ]
  }
}
