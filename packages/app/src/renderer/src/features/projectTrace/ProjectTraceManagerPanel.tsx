import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  IconButton,
  LinearProgress,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import {
  Close as CloseIcon,
  DeleteOutline as DeleteIcon,
  Download as DownloadIcon,
  Refresh as RefreshIcon,
  Save as SaveIcon,
  StopCircleOutlined as StopIcon,
  VerifiedUserOutlined as TrustIcon
} from '@mui/icons-material'
import {
  type ProjectTraceDocument,
  type ProjectTraceDocumentSummary,
  type ProjectTraceEventSummary,
  type ProjectTraceExecutableRule,
  type ProjectTraceExecutableRulesDocument,
  type ProjectTraceSemanticRule,
  type ProjectTraceSkillSummary,
  type ProjectTraceProjectRef
} from '@shared/projectTrace'
import type { LLMListProfilesResp } from '@shared/api/svcLLMProxy'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import { listProjects } from '../../pages/MainPage/projectStore'
import { resolveCanvasProjectTraceProjectRef } from './projectTraceProjectRef'
import {
  PROJECT_TRACE_CAPTURE_STATE_EVENT,
  PROJECT_TRACE_RUNTIME_EVENT,
  PROJECT_TRACE_TARGET_REFERENCE_EVENT,
  clearActiveProjectTraceRealtime,
  readActiveProjectTraceCapture,
  readActiveProjectTraceRealtime,
  readProjectTraceTargetReferenceState,
  readRecentProjectTraceEvents,
  writeActiveProjectTraceCapture,
  writeActiveProjectTraceRealtime,
  type ProjectTraceCaptureStateEvent,
  type ProjectTraceTargetReferenceState,
  type ProjectTraceRuntimeEvent
} from './projectTraceRuntime'
import {
  ACTIVE_CAPTURE_TRACE_TAG,
  DRAFT_TRACE_TAG,
  applyTraceReferenceReadinessTags,
  evaluateTraceReferenceReadiness,
  finalizeActiveProjectTraceCapture,
  getSavedTraceTags,
  isDraftTraceTagSet,
  isReferenceReadyTraceTagSet
} from './projectTraceCapture'

type ProjectTraceTab = 'create' | 'realtime' | 'records'

type TraceProjectOption = {
  id: string
  name: string
}

export type ProjectTraceManagerPanelProps = {
  projectId?: string
  projectName?: string
  compact?: boolean
  onClose?: () => void
}

function isChineseLanguage(): boolean {
  try {
    return navigator.language.toLowerCase().startsWith('zh')
  } catch {
    return true
  }
}

function summarizeTrace(trace: ProjectTraceDocumentSummary): string {
  return `${trace.sourceKind} - ${trace.eventCount} events`
}

function isTraceReferenceUsable(trace: ProjectTraceDocumentSummary): boolean {
  return (
    isReferenceReadyTraceTagSet(trace.tags) &&
    trace.localTrust?.trusted !== false &&
    trace.runtimePolicy?.allowRealtime !== false &&
    trace.runtimePolicy?.allowTargetReference !== false
  )
}

function formatTraceTime(value?: string): string {
  if (!value) return ''
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  return new Date(parsed).toLocaleString()
}

function truncateTraceContent(value: string | undefined, maxLength = 360): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() || ''
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function buildInitialTraceMarkdown(name: string, intent: string, isChineseUi: boolean): string {
  if (isChineseUi) {
    return [
      `# ${name}`,
      '',
      '## 用户追踪说明',
      '',
      intent || '未填写',
      '',
      '## 操作摘要',
      '',
      '追踪已创建。开启追踪后，应用会把脱敏后的操作摘要追加到这里。',
      '',
      '## 安全',
      '',
      '不保留原始提示词、原始模型回复、本地绝对路径、凭据或完整文件内容。'
    ].join('\n')
  }

  return [
    `# ${name}`,
    '',
    '## User Trace Intent',
    '',
    intent || 'Not provided',
    '',
    '## Operation Summary',
    '',
    'Trace created. While capture is active, redacted operation summaries are appended here.',
    '',
    '## Safety',
    '',
    'Raw prompts, raw model responses, absolute local paths, credentials, and full file contents are not retained.'
  ].join('\n')
}

type ProjectTraceModelMemory = {
  skillSummary?: ProjectTraceSkillSummary
  executableRules?: ProjectTraceExecutableRulesDocument
}

const MODEL_RULE_TYPES: ProjectTraceExecutableRule['type'][] = [
  'canvas.move.distance',
  'canvas.resize.scale',
  'canvas.rotate.angle',
  'canvas.delete.item',
  'canvas.layer.change'
]

const MODEL_RULE_UNITS: ProjectTraceExecutableRule['condition']['unit'][] = [
  'px',
  'ratio',
  'deg',
  'count'
]

const MODEL_RULE_OPERATORS: ProjectTraceExecutableRule['condition']['operator'][] = [
  '>',
  '>=',
  '<',
  '<=',
  '='
]

type ProjectTraceModelMemoryValidation = {
  memory: ProjectTraceModelMemory | null
  errors: string[]
}

function parseJsonObjectFromText(value: string): Record<string, unknown> | null {
  const source =
    value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || value.match(/\{[\s\S]*\}/)?.[0] || value
  try {
    const parsed = JSON.parse(source)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function redactTraceModelInput(value: string | undefined, maxLength = 3000): string {
  const normalized = (value || '')
    .replace(/\s+/g, ' ')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted-token]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^,\s;]+/gi, '$1=[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, '[redacted-local-path]')
    .replace(/\b(?:file|local-media):\/\/\/?[^\s"'<>]+/gi, '[redacted-local-media]')
    .trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function normalizeModelRule(
  value: unknown,
  index: number,
  errors: string[]
): ProjectTraceExecutableRule | null {
  if (!value || typeof value !== 'object') {
    errors.push(`executableRules.rules[${index}] must be an object.`)
    return null
  }
  const raw = value as Partial<ProjectTraceExecutableRule>
  const type = MODEL_RULE_TYPES.includes(raw.type as ProjectTraceExecutableRule['type'])
    ? (raw.type as ProjectTraceExecutableRule['type'])
    : null
  const unit = MODEL_RULE_UNITS.includes(
    raw.condition?.unit as ProjectTraceExecutableRule['condition']['unit']
  )
    ? (raw.condition?.unit as ProjectTraceExecutableRule['condition']['unit'])
    : null
  const conditionValue = Number(raw.condition?.value)
  const feedback = String(raw.feedback || '').trim()
  if (!type) errors.push(`executableRules.rules[${index}].type is unsupported.`)
  if (!unit) errors.push(`executableRules.rules[${index}].condition.unit is unsupported.`)
  if (!Number.isFinite(conditionValue) || conditionValue < 0) {
    errors.push(`executableRules.rules[${index}].condition.value must be a non-negative number.`)
  }
  if (!feedback) errors.push(`executableRules.rules[${index}].feedback is required.`)
  if (!type || !unit || !Number.isFinite(conditionValue) || conditionValue < 0 || !feedback) {
    return null
  }
  const operator = MODEL_RULE_OPERATORS.includes(
    raw.condition?.operator as ProjectTraceExecutableRule['condition']['operator']
  )
    ? (raw.condition?.operator as ProjectTraceExecutableRule['condition']['operator'])
    : '>'
  return {
    id:
      String(raw.id || `model-rule-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '-') ||
      `model-rule-${index + 1}`,
    type,
    target:
      raw.target === 'image' ||
      raw.target === 'selected.image' ||
      raw.target === 'canvas_item' ||
      raw.target === 'selected.canvas_item'
        ? raw.target
        : 'selected.canvas_item',
    condition: {
      operator,
      value: Math.round(conditionValue * 1000) / 1000,
      unit
    },
    feedback: feedback.slice(0, 500),
    mode: raw.mode === 'model_review' ? 'model_review' : 'software',
    source: 'model',
    confidence:
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.7
  }
}

function normalizeModelSemanticRule(
  value: unknown,
  index: number,
  errors: string[]
): ProjectTraceSemanticRule | null {
  if (!value || typeof value !== 'object') {
    errors.push(`executableRules.semanticRules[${index}] must be an object.`)
    return null
  }
  const raw = value as Partial<ProjectTraceSemanticRule>
  const requirement = redactTraceModelInput(raw.requirement, 1200)
  const feedback = redactTraceModelInput(raw.feedback, 600)
  if (!requirement) errors.push(`executableRules.semanticRules[${index}].requirement is required.`)
  if (!feedback) errors.push(`executableRules.semanticRules[${index}].feedback is required.`)
  if (!requirement || !feedback) return null
  return {
    id:
      String(raw.id || `model-semantic-rule-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '-') ||
      `model-semantic-rule-${index + 1}`,
    requirement,
    ...(typeof raw.target === 'string' && raw.target.trim()
      ? { target: redactTraceModelInput(raw.target, 240) }
      : {}),
    appliesTo: Array.isArray(raw.appliesTo)
      ? raw.appliesTo.map((entry) => redactTraceModelInput(String(entry), 160)).slice(0, 20)
      : ['game art workflow', 'target execution reference'],
    feedback,
    mode: 'model_review',
    source: 'model',
    confidence:
      typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0.68
  }
}

function normalizeModelTraceMemory(
  value: Record<string, unknown>
): ProjectTraceModelMemoryValidation {
  const now = new Date().toISOString()
  const errors: string[] = []
  const skill = value.skillSummary as Partial<ProjectTraceSkillSummary> | undefined
  const rulesDocument = value.executableRules as
    | Partial<ProjectTraceExecutableRulesDocument>
    | undefined
  const rules = Array.isArray(rulesDocument?.rules)
    ? rulesDocument.rules
        .map((rule, index) => normalizeModelRule(rule, index, errors))
        .filter((rule): rule is ProjectTraceExecutableRule => Boolean(rule))
    : []
  const semanticRules = Array.isArray(rulesDocument?.semanticRules)
    ? rulesDocument.semanticRules
        .map((rule, index) => normalizeModelSemanticRule(rule, index, errors))
        .filter((rule): rule is ProjectTraceSemanticRule => Boolean(rule))
    : []
  const summaryText = typeof skill?.summary === 'string' ? skill.summary.trim() : ''
  if (!summaryText && rules.length === 0 && semanticRules.length === 0) {
    errors.push(
      'Model output must include skillSummary.summary or at least one executable/semantic rule.'
    )
  }
  if (errors.length > 0) return { memory: null, errors }
  return {
    memory: {
      ...(summaryText
        ? {
            skillSummary: {
              version: 1,
              generatedAt: now,
              summary: summaryText.slice(0, 1200),
              applicableTo: Array.isArray(skill?.applicableTo)
                ? skill.applicableTo.map((entry) => String(entry).slice(0, 160)).slice(0, 20)
                : ['项目操作记忆'],
              notes: Array.isArray(skill?.notes)
                ? skill.notes.map((entry) => String(entry).slice(0, 400)).slice(0, 20)
                : ['由增强模型基于脱敏追踪内容生成。'],
              source: 'model'
            }
          }
        : {}),
      executableRules: {
        version: 1,
        generatedAt: now,
        rules,
        ...(semanticRules.length ? { semanticRules } : {}),
        unsupportedNotes: Array.isArray(rulesDocument?.unsupportedNotes)
          ? rulesDocument.unsupportedNotes.map((entry) => String(entry).slice(0, 400)).slice(0, 20)
          : []
      }
    },
    errors: []
  }
}

async function enhanceTraceMemoryWithModel(options: {
  profileId: string
  name: string
  intent: string
  markdown: string
  events?: ProjectTraceEventSummary[]
}): Promise<ProjectTraceModelMemory | null> {
  let validationErrors: string[] = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await api().svcLLMProxy.chat({
      profileId: options.profileId,
      messages: [
        {
          role: 'system',
          content:
            'You create reusable project operation memory from redacted trace data. Return strict JSON only. Do not include raw prompts, raw model responses, local paths, credentials, full file contents, or personal data. Software rules must use only the supported schema. If a requirement cannot be represented as a software rule, put it into executableRules.semanticRules for model review and target retrieval.'
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              traceName: redactTraceModelInput(options.name, 180),
              userIntent: redactTraceModelInput(options.intent, 1200),
              redactedMarkdownPreview: redactTraceModelInput(options.markdown, 3000),
              redactedEvents: (options.events || []).slice(-80).map((event) => ({
                scope: event.scope,
                action: event.action,
                status: event.status,
                safeSummary: redactTraceModelInput(event.safeSummary, 500),
                affectedItemCount: event.affectedItemCount,
                createdItemCount: event.createdItemCount,
                removedItemCount: event.removedItemCount,
                resizedItemCount: event.resizedItemCount,
                rotatedItemCount: event.rotatedItemCount,
                reorderedItemCount: event.reorderedItemCount,
                movementDistancePx: event.movementDistancePx,
                maxScaleChangeRatio: event.maxScaleChangeRatio,
                maxRotationDeltaDeg: event.maxRotationDeltaDeg,
                maxLayerDelta: event.maxLayerDelta
              })),
              supportedSoftwareRules: {
                types: MODEL_RULE_TYPES,
                operators: MODEL_RULE_OPERATORS,
                units: MODEL_RULE_UNITS,
                targetValues: ['image', 'selected.image', 'canvas_item', 'selected.canvas_item']
              },
              requiredJsonShape: {
                skillSummary: {
                  summary: 'short reusable craft memory',
                  applicableTo: ['game art workflow'],
                  notes: ['privacy and usage notes']
                },
                executableRules: {
                  rules: [
                    {
                      id: 'rule-id',
                      type: 'canvas.move.distance',
                      target: 'selected.image',
                      condition: { operator: '>', value: 500, unit: 'px' },
                      feedback: 'Chinese feedback text',
                      mode: 'software',
                      confidence: 0.8
                    }
                  ],
                  semanticRules: [
                    {
                      id: 'semantic-rule-id',
                      requirement: 'natural language requirement that needs model review',
                      target: 'selected character image',
                      appliesTo: ['game art workflow', 'target execution reference'],
                      feedback: 'Chinese feedback text',
                      mode: 'model_review',
                      confidence: 0.7
                    }
                  ],
                  unsupportedNotes: []
                }
              },
              validationErrorsFromPreviousAttempt: validationErrors
            },
            null,
            2
          )
        }
      ]
    })
    const parsed = parseJsonObjectFromText(response.content || '')
    if (!parsed) {
      validationErrors = ['Response was not a JSON object.']
      continue
    }
    const validation = normalizeModelTraceMemory(parsed)
    if (validation.memory) return validation.memory
    validationErrors = validation.errors.length
      ? validation.errors
      : ['Parsed JSON did not satisfy the trace memory schema.']
  }
  return null
}

export default function ProjectTraceManagerPanel({
  projectId,
  projectName,
  compact = false,
  onClose
}: ProjectTraceManagerPanelProps): React.JSX.Element {
  const isChineseUi = isChineseLanguage()
  const { notifySuccess, notifyError, notifyWarning, notifyInfo } = useMessage()
  const [activeTab, setActiveTab] = useState<ProjectTraceTab>('create')
  const [projects, setProjects] = useState<TraceProjectOption[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [projectRef, setProjectRef] = useState<ProjectTraceProjectRef | null>(null)
  const [traces, setTraces] = useState<ProjectTraceDocumentSummary[]>([])
  const [selectedTraceId, setSelectedTraceId] = useState('')
  const [activeTrace, setActiveTrace] = useState<ProjectTraceDocument | null>(null)
  const [newTraceName, setNewTraceName] = useState('')
  const [newTraceIntent, setNewTraceIntent] = useState('')
  const [traceIntent, setTraceIntent] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftMarkdown, setDraftMarkdown] = useState('')
  const [profiles, setProfiles] = useState<LLMListProfilesResp['profiles']>([])
  const [enhanceProfileId, setEnhanceProfileId] = useState('')
  const [recentEvents, setRecentEvents] = useState<ProjectTraceEventSummary[]>([])
  const [activeCaptureTraceId, setActiveCaptureTraceId] = useState('')
  const [activeRealtimeTraceIds, setActiveRealtimeTraceIds] = useState<string[]>([])
  const [selectedRealtimeTraceIds, setSelectedRealtimeTraceIds] = useState<string[]>([])
  const [targetReferenceTraceIds, setTargetReferenceTraceIds] = useState<string[]>([])
  const [selectedRecordTraceIds, setSelectedRecordTraceIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  )
  const selectedTrace = useMemo(
    () => traces.find((trace) => trace.id === selectedTraceId) || null,
    [traces, selectedTraceId]
  )
  const scopedProject = useMemo(
    () =>
      projectId
        ? {
            id: projectId,
            name: projectName?.trim() || projectId
          }
        : null,
    [projectId, projectName]
  )
  const activeCaptureTrace = useMemo(
    () => traces.find((trace) => trace.id === activeCaptureTraceId) || null,
    [activeCaptureTraceId, traces]
  )
  const activeRealtimeTraces = useMemo(
    () => traces.filter((trace) => activeRealtimeTraceIds.includes(trace.id)),
    [activeRealtimeTraceIds, traces]
  )
  const savedTraces = useMemo(
    () => traces.filter((trace) => !isDraftTraceTagSet(trace.tags)),
    [traces]
  )
  const draftTraces = useMemo(
    () => traces.filter((trace) => isDraftTraceTagSet(trace.tags)),
    [traces]
  )
  const referenceReadyTraces = useMemo(
    () => savedTraces.filter(isTraceReferenceUsable),
    [savedTraces]
  )
  const selectedSavedTrace = useMemo(
    () => savedTraces.find((trace) => trace.id === selectedTraceId) || null,
    [savedTraces, selectedTraceId]
  )
  const selectedReferenceTraces = useMemo(
    () => referenceReadyTraces.filter((trace) => selectedRealtimeTraceIds.includes(trace.id)),
    [referenceReadyTraces, selectedRealtimeTraceIds]
  )
  const selectedTraceIsDraft = isDraftTraceTagSet(activeTrace?.manifest.tags || selectedTrace?.tags)
  const selectedTraceIsActive =
    Boolean(activeCaptureTraceId && selectedTraceId === activeCaptureTraceId) ||
    Boolean((activeTrace?.manifest.tags || selectedTrace?.tags)?.includes(ACTIVE_CAPTURE_TRACE_TAG))
  const selectedTraceIsPendingSave = selectedTraceIsDraft && !selectedTraceIsActive
  const copy = isChineseUi
    ? {
        title: '追踪',
        project: '项目',
        refresh: '刷新',
        createTab: '添加追踪',
        realtimeTab: '实时追踪',
        recordsTab: '追踪记录',
        createAndStart: '创建并开始追踪',
        stop: '停止追踪',
        save: '保存',
        export: '导出追踪',
        traceName: '追踪名称',
        tracePicker: '选择追踪记录',
        traceReferences: '采用的追踪记录',
        selectedTraceCount: '已选追踪',
        generatedContent: '追踪内容（自动生成）',
        skillSummary: '技艺摘要',
        executableRules: '可执行规则',
        redactionReport: '脱敏报告',
        noExecutableRules: '当前追踪没有提取到软件层可执行规则，只会作为技艺摘要被引用。',
        redactionSafe:
          '本追踪记录仅保存脱敏摘要，不保留原始提示词、原始模型回复、本地绝对路径、凭据或完整文件内容。',
        traceList: '追踪文档列表',
        traceSummary: '追踪详情',
        emptyProject: '还没有项目。',
        emptyTrace: '当前项目还没有追踪记录。',
        noTraceSelected: '请选择一条追踪记录。',
        active: '正在追踪',
        inactive: '未追踪',
        enhanceModel: '增强模型',
        recentEvents: '近期操作',
        noRecentEvents: '暂无近期操作。',
        close: '关闭',
        closePanel: '关闭页面',
        storage: '存储位置',
        updatedAt: '更新时间',
        createdAt: '创建时间',
        eventCount: '事件数',
        sourceKind: '来源',
        enhanced: '已增强',
        notEnhanced: '未增强',
        draft: '草稿',
        contentPreview: '内容摘要',
        cancel: '取消',
        startRealtime: '开始实时追踪',
        traceIntent: '追踪说明',
        traceIntentHelper:
          '少写结论，多写可判断条件。当前软件层支持移动距离、缩放幅度、旋转角度、禁止删除、锁定图层；模型增强可把脱敏记录整理得更清晰，但实时触发仍先走软件规则。',
        traceIntentTemplate:
          '追踪说明模板：\n目的：这次追踪要沉淀什么项目经验。\n操作对象：图片 / 选中元素 / 画布元素。\n有效动作：移动 / 缩放 / 旋转 / 删除 / 层级调整。\n实时规则：\n- 移动：单次移动距离 > 500px 时反馈。\n- 缩放：单次尺寸变化 > 20% 时反馈。\n- 旋转：单次旋转角度 > 15° 时反馈。\n- 删除：禁止删除关键元素。\n- 图层：禁止改变关键元素前后顺序。\n反馈方式：说明应撤回、复核，还是按当前目标确认覆盖旧经验。\n可引用条件：追踪过程包含完整示例，并且规则可量化、可判断。\n不要只写：位置不要错、移动合理、保持差不多。',
        saveTrace: '保存追踪',
        deleteTrace: '删除追踪',
        referenceReady: '可引用',
        needsReview: '待复核',
        pendingSave: '待保存',
        createBlocked: '当前追踪停止后需要保存或删除，才能再次创建追踪。',
        realtimeBlocked: '添加追踪或实时追踪正在运行，不能同时开启两个追踪。',
        targetReferenceBlocked: '目标正在引用追踪记录，添加追踪和实时追踪暂不可用。',
        realtimeMechanismTitle: '当前实时追踪方式',
        realtimeMechanism:
          '用户操作 -> 软件层脱敏事件 -> 软件层规则筛选 -> 命中候选异常 -> 选择判断模型时提交脱敏摘要和引用追踪摘要给模型复核；未选择模型时直接按软件规则反馈。不会全时段把完整画布、原始图片或敏感内容发送给模型。',
        realtimeSelectedNotRunning:
          '已选择追踪记录，但实时追踪尚未开启。点击右下角“开始实时追踪”后，后续画布操作才会触发反馈。',
        realtimeRunning:
          '实时追踪已开启，正在使用已选追踪记录判断后续操作；顶部追踪按钮会显示红色停止状态。',
        intentRequired: '请先填写详细追踪说明，说明越明确，追踪越可能成为有效引用。',
        noReferenceReadyTrace: '当前项目还没有可用于实时追踪或目标执行引用的追踪记录。',
        noRecordSelected: '请先勾选追踪记录。',
        exportFolderTitle: '选择追踪导出文件夹',
        exportDone: '追踪已导出。',
        trustTrace: '信任并启用',
        trustTraceDone: '已信任并启用该追踪记录。',
        untrustedTrace: '未确认',
        changedTrace: '内容已变更',
        projectMismatchTrace: '项目不匹配',
        runtimeDisabledTrace: '引用已关闭',
        trustTraceHelp:
          '这条追踪记录不是本机已登记的可引用内容，或者文件内容已变更。确认后才会用于实时追踪和目标引用。'
      }
    : {
        title: 'Trace',
        project: 'Project',
        refresh: 'Refresh',
        createTab: 'Add Trace',
        realtimeTab: 'Realtime Trace',
        recordsTab: 'Trace Records',
        createAndStart: 'Create and start tracing',
        stop: 'Stop tracing',
        save: 'Save',
        export: 'Export traces',
        traceName: 'Trace name',
        tracePicker: 'Select trace record',
        traceReferences: 'Reference trace record',
        selectedTraceCount: 'Selected traces',
        generatedContent: 'Trace content (auto-generated)',
        skillSummary: 'Skill summary',
        executableRules: 'Executable rules',
        redactionReport: 'Redaction report',
        noExecutableRules:
          'No software-executable rules were extracted. This trace is only referenced as a skill summary.',
        redactionSafe:
          'This trace stores redacted summaries only. Raw prompts, raw model responses, absolute local paths, credentials, and full file contents are not retained.',
        traceList: 'Trace document list',
        traceSummary: 'Trace details',
        emptyProject: 'No projects yet.',
        emptyTrace: 'No trace records in this project yet.',
        noTraceSelected: 'Select a trace record.',
        active: 'Capturing',
        inactive: 'Not capturing',
        enhanceModel: 'Enhancement model',
        recentEvents: 'Recent events',
        noRecentEvents: 'No recent events.',
        close: 'Close',
        closePanel: 'Close panel',
        storage: 'Storage',
        updatedAt: 'Updated',
        createdAt: 'Created',
        eventCount: 'Events',
        sourceKind: 'Source',
        enhanced: 'Enhanced',
        notEnhanced: 'Not enhanced',
        draft: 'Draft',
        contentPreview: 'Content preview',
        cancel: 'Cancel',
        startRealtime: 'Start realtime trace',
        traceIntent: 'Trace intent',
        traceIntentHelper:
          'Write measurable conditions, not conclusions. The software layer supports move distance, resize ratio, rotation angle, deletion locks, and layer locks. Model enhancement can organize the redacted record, but realtime triggering still starts from software rules.',
        traceIntentTemplate:
          'Trace intent template:\nPurpose: what project memory this trace should capture.\nTarget object: image / selected item / canvas item.\nValid actions: move / resize / rotate / delete / layer change.\nRealtime rules:\n- Move: feedback when single movement distance > 500px.\n- Resize: feedback when single size change > 20%.\n- Rotate: feedback when single rotation angle > 15deg.\n- Delete: key elements must not be deleted.\n- Layer: key element z-order must not change.\nFeedback: say whether to undo, review, or explicitly override the old project memory.\nReference-ready condition: the trace contains a complete example and measurable rules.\nAvoid vague text: wrong position, reasonable movement, almost the same.',
        saveTrace: 'Save trace',
        deleteTrace: 'Delete trace',
        referenceReady: 'Reference ready',
        needsReview: 'Needs review',
        pendingSave: 'Pending save',
        createBlocked: 'Save or delete the stopped trace before creating another trace.',
        realtimeBlocked: 'Another trace mode is already running.',
        targetReferenceBlocked:
          'Target references are active. Add Trace and Realtime Trace are disabled.',
        realtimeMechanismTitle: 'Current realtime trace flow',
        realtimeMechanism:
          'User operation -> software-layer redacted event -> software rule screening -> candidate anomaly -> if a review model is selected, send only redacted event and reference trace summaries for review; without a model, feedback comes directly from software rules. Full canvas data, raw images, and sensitive content are not sent continuously to the model.',
        realtimeSelectedNotRunning:
          'Trace records are selected, but realtime trace is not running yet. Click "Start realtime trace" in the bottom-right before later canvas operations can trigger feedback.',
        realtimeRunning:
          'Realtime trace is running and will judge later operations using the selected trace records. The top trace button should be red while it is active.',
        intentRequired: 'Add a detailed trace intent first.',
        noReferenceReadyTrace: 'No reference-ready trace records in this project yet.',
        noRecordSelected: 'Select trace records first.',
        exportFolderTitle: 'Select trace export folder',
        exportDone: 'Trace export completed.',
        trustTrace: 'Trust and enable',
        trustTraceDone: 'Trace trusted and enabled.',
        untrustedTrace: 'Unconfirmed',
        changedTrace: 'Content changed',
        projectMismatchTrace: 'Project mismatch',
        runtimeDisabledTrace: 'Reference disabled',
        trustTraceHelp:
          'This trace is not registered as trusted on this machine, or its files changed. Confirm it before realtime tracing or target references can use it.'
      }

  const loadProjects = useCallback(() => {
    if (scopedProject) {
      setProjects([scopedProject])
      setSelectedProjectId(scopedProject.id)
      return
    }

    const nextProjects = listProjects()
    setProjects(nextProjects)
    setSelectedProjectId((current) => current || nextProjects[0]?.id || '')
  }, [scopedProject])

  const resolveProject = useCallback(async () => {
    if (!selectedProject) {
      setProjectRef(null)
      return null
    }
    const nextRef = await resolveCanvasProjectTraceProjectRef(
      selectedProject.id,
      selectedProject.name
    )
    setProjectRef(nextRef)
    setRecentEvents(readRecentProjectTraceEvents(selectedProject.id))
    setActiveCaptureTraceId(readActiveProjectTraceCapture(selectedProject.id)?.traceId || '')
    const activeRealtime = readActiveProjectTraceRealtime(selectedProject.id)
    const nextActiveRealtimeTraceIds = activeRealtime?.referenceTraceIds || []
    setActiveRealtimeTraceIds(nextActiveRealtimeTraceIds)
    if (nextActiveRealtimeTraceIds.length > 0) {
      setSelectedRealtimeTraceIds(nextActiveRealtimeTraceIds)
    }
    setTargetReferenceTraceIds(readProjectTraceTargetReferenceState(selectedProject.id).traceIds)
    return nextRef
  }, [selectedProject])

  const loadTraces = useCallback(async () => {
    const nextProjectRef = await resolveProject()
    if (!nextProjectRef) return
    setBusy(true)
    setError(null)
    try {
      const [traceResponse, profileResponse] = await Promise.all([
        api().svcProjectTrace.listProjectTraces({ project: nextProjectRef }),
        api()
          .svcLLMProxy.listProfiles({})
          .catch(() => ({ profiles: [] as LLMListProfilesResp['profiles'] }))
      ])
      setTraces(traceResponse.traces)
      setProfiles(profileResponse.profiles)
      setEnhanceProfileId((current) =>
        !current || profileResponse.profiles.some((profile) => profile.id === current)
          ? current
          : ''
      )
      setSelectedRecordTraceIds((current) =>
        current.filter((traceId) =>
          traceResponse.traces.some(
            (trace) => trace.id === traceId && !isDraftTraceTagSet(trace.tags)
          )
        )
      )
      setSelectedRealtimeTraceIds((current) =>
        current.filter((traceId) =>
          traceResponse.traces.some(
            (trace) => trace.id === traceId && isTraceReferenceUsable(trace)
          )
        )
      )
      setSelectedTraceId((current) =>
        traceResponse.traces.some((trace) => trace.id === current)
          ? current
          : traceResponse.traces[0]?.id || ''
      )
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : 'Failed to load traces.'
      setError(message)
      notifyError(message)
    } finally {
      setBusy(false)
    }
  }, [notifyError, resolveProject])

  const loadActiveTrace = useCallback(async () => {
    if (!projectRef || !selectedTraceId) {
      setActiveTrace(null)
      setDraftName('')
      setDraftMarkdown('')
      setTraceIntent('')
      return
    }
    try {
      const response = await api().svcProjectTrace.readProjectTraceDocument({
        project: projectRef,
        traceId: selectedTraceId
      })
      const trace = response.trace
      setActiveTrace(trace)
      setDraftName(trace?.manifest.name || '')
      setDraftMarkdown(trace?.markdown || '')
      setTraceIntent(trace?.manifest.description || '')
      const persistedProfileId = trace?.manifest.redaction.llmProfileId || ''
      setEnhanceProfileId(
        !persistedProfileId || profiles.some((profile) => profile.id === persistedProfileId)
          ? persistedProfileId
          : ''
      )
    } catch (readError) {
      notifyError(readError instanceof Error ? readError.message : 'Failed to read trace.')
    }
  }, [notifyError, profiles, projectRef, selectedTraceId])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    void loadTraces()
  }, [loadTraces])

  useEffect(() => {
    void loadActiveTrace()
  }, [loadActiveTrace])

  useEffect(() => {
    if (!selectedProjectId) return
    const handleRuntimeEvent = (event: Event) => {
      const detail = (event as CustomEvent<ProjectTraceRuntimeEvent>).detail
      if (detail?.projectId && detail.projectId !== selectedProjectId) return
      setRecentEvents(readRecentProjectTraceEvents(selectedProjectId))
      if (detail?.projectId === selectedProjectId && activeCaptureTraceId) {
        void loadActiveTrace()
      }
    }
    window.addEventListener(PROJECT_TRACE_RUNTIME_EVENT, handleRuntimeEvent)
    return () => window.removeEventListener(PROJECT_TRACE_RUNTIME_EVENT, handleRuntimeEvent)
  }, [activeCaptureTraceId, loadActiveTrace, selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId) return
    const handleCaptureState = (event: Event) => {
      const detail = (event as CustomEvent<ProjectTraceCaptureStateEvent>).detail
      if (detail?.projectId !== selectedProjectId) return
      if (detail.mode === 'realtime') {
        const nextTraceIds = detail.active
          ? detail.traceIds?.length
            ? detail.traceIds
            : detail.traceId
              ? [detail.traceId]
              : []
          : []
        setActiveRealtimeTraceIds(nextTraceIds)
        if (nextTraceIds.length > 0) {
          setSelectedRealtimeTraceIds(nextTraceIds)
        }
      } else {
        setActiveCaptureTraceId(detail.active ? detail.traceId || '' : '')
      }
      void loadTraces()
      void loadActiveTrace()
    }
    window.addEventListener(PROJECT_TRACE_CAPTURE_STATE_EVENT, handleCaptureState)
    return () => window.removeEventListener(PROJECT_TRACE_CAPTURE_STATE_EVENT, handleCaptureState)
  }, [loadActiveTrace, loadTraces, selectedProjectId])

  useEffect(() => {
    if (!selectedProjectId) return
    const handleTargetReferenceState = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        setTargetReferenceTraceIds(readProjectTraceTargetReferenceState(selectedProjectId).traceIds)
        return
      }
      const detail = (event as CustomEvent<ProjectTraceTargetReferenceState>).detail
      if (detail?.projectId !== selectedProjectId) return
      setTargetReferenceTraceIds(detail.traceIds || [])
    }
    window.addEventListener(PROJECT_TRACE_TARGET_REFERENCE_EVENT, handleTargetReferenceState)
    window.addEventListener('storage', handleTargetReferenceState)
    setTargetReferenceTraceIds(readProjectTraceTargetReferenceState(selectedProjectId).traceIds)
    return () => {
      window.removeEventListener(PROJECT_TRACE_TARGET_REFERENCE_EVENT, handleTargetReferenceState)
      window.removeEventListener('storage', handleTargetReferenceState)
    }
  }, [selectedProjectId])

  const saveDraft = useCallback(async () => {
    if (!projectRef || !selectedTraceId) return
    setBusy(true)
    try {
      const referenceReadiness = evaluateTraceReferenceReadiness(
        traceIntent,
        activeTrace?.eventSummaries
      )
      const selectedEnhanceProfileId =
        enhanceProfileId || activeTrace?.manifest.redaction.llmProfileId || ''
      let modelMemory: ProjectTraceModelMemory | null = null
      if (selectedEnhanceProfileId) {
        try {
          modelMemory = await enhanceTraceMemoryWithModel({
            profileId: selectedEnhanceProfileId,
            name: draftName || selectedTrace?.name || 'Project trace',
            intent: traceIntent,
            markdown: draftMarkdown,
            events: activeTrace?.eventSummaries
          })
        } catch (enhanceError) {
          console.warn(
            '[ProjectTrace] model enhancement failed; using software memory.',
            enhanceError
          )
          notifyWarning(
            isChineseUi
              ? '增强模型整理失败，已改用软件层摘要和规则保存。'
              : 'Model enhancement failed. Saved with software-generated memory.'
          )
        }
      }
      const response = await api().svcProjectTrace.saveProjectTraceDocument({
        project: projectRef,
        trace: {
          id: selectedTraceId,
          name: draftName || selectedTrace?.name || 'Project trace',
          description: traceIntent,
          sourceKind: activeTrace?.manifest.sourceKind || selectedTrace?.sourceKind || 'manual',
          projectId: projectRef.projectId,
          projectName: projectRef.projectName,
          tags: applyTraceReferenceReadinessTags(
            getSavedTraceTags(activeTrace?.manifest.tags || selectedTrace?.tags),
            referenceReadiness.referenceReady
          ),
          markdown: draftMarkdown,
          documentJson: activeTrace?.documentJson,
          ...(modelMemory?.skillSummary ? { skillSummary: modelMemory.skillSummary } : {}),
          ...(modelMemory?.executableRules ? { executableRules: modelMemory.executableRules } : {}),
          eventSummaries: activeTrace?.eventSummaries,
          llmEnhanced: Boolean(modelMemory) || activeTrace?.manifest.redaction.llmEnhanced,
          llmProfileId: selectedEnhanceProfileId || activeTrace?.manifest.redaction.llmProfileId
        }
      })
      setSelectedTraceId(response.trace.manifest.id)
      setActiveTrace(response.trace)
      setDraftName(response.trace.manifest.name)
      setDraftMarkdown(response.trace.markdown)
      setNewTraceName('')
      setNewTraceIntent('')
      notifySuccess(isChineseUi ? '追踪记录已保存。' : 'Trace saved.')
      await loadTraces()
    } catch (saveError) {
      notifyError(saveError instanceof Error ? saveError.message : 'Failed to save trace.')
    } finally {
      setBusy(false)
    }
  }, [
    activeTrace,
    draftMarkdown,
    draftName,
    enhanceProfileId,
    isChineseUi,
    loadTraces,
    notifyError,
    notifySuccess,
    notifyWarning,
    projectRef,
    selectedTrace,
    selectedTraceId,
    traceIntent
  ])

  const createAndStartTrace = useCallback(async () => {
    if (!projectRef || !selectedProjectId) return
    const name = newTraceName.trim() || (isChineseUi ? '新的追踪' : 'New trace')
    const intent = newTraceIntent.trim()
    if (intent.replace(/\s+/g, '').length < 12) {
      notifyWarning(copy.intentRequired)
      return
    }
    setBusy(true)
    try {
      const response = await api().svcProjectTrace.saveProjectTraceDocument({
        project: projectRef,
        trace: {
          name,
          description: intent,
          sourceKind: 'manual',
          projectId: projectRef.projectId,
          projectName: projectRef.projectName,
          tags: ['manual', ACTIVE_CAPTURE_TRACE_TAG, DRAFT_TRACE_TAG],
          markdown: buildInitialTraceMarkdown(name, intent, isChineseUi),
          llmProfileId: enhanceProfileId || undefined
        }
      })
      const traceId = response.trace.manifest.id
      const startedTrace = await api().svcProjectTrace.appendProjectTraceEvent({
        project: projectRef,
        traceId,
        event: {
          id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          at: new Date().toISOString(),
          scope: 'system',
          action: 'start_trace_capture',
          label: 'Start trace capture',
          status: 'success',
          safeSummary: `Trace capture started. User intent: ${intent}`
        }
      })
      writeActiveProjectTraceCapture({
        projectId: selectedProjectId,
        ...(selectedProject?.name ? { projectName: selectedProject.name } : {}),
        project: projectRef,
        traceId
      })
      setActiveCaptureTraceId(traceId)
      setSelectedTraceId(traceId)
      setActiveTrace(startedTrace.trace)
      setDraftName(startedTrace.trace.manifest.name)
      setDraftMarkdown(startedTrace.trace.markdown)
      setNewTraceName('')
      setNewTraceIntent('')
      setTraceIntent(startedTrace.trace.manifest.description || intent)
      notifySuccess(isChineseUi ? '已创建追踪并开始捕获。' : 'Trace created and capture started.')
      await loadTraces()
      setSelectedTraceId(traceId)
    } catch (createError) {
      notifyError(createError instanceof Error ? createError.message : 'Failed to create trace.')
    } finally {
      setBusy(false)
    }
  }, [
    enhanceProfileId,
    isChineseUi,
    loadTraces,
    newTraceIntent,
    newTraceName,
    notifyError,
    notifySuccess,
    notifyWarning,
    projectRef,
    selectedProject,
    selectedProjectId,
    copy.intentRequired
  ])

  const stopCapture = useCallback(async () => {
    if (!selectedProjectId) return
    setBusy(true)
    try {
      const finalized = await finalizeActiveProjectTraceCapture(selectedProjectId)
      setActiveCaptureTraceId('')
      if (finalized) {
        setSelectedTraceId(finalized.trace.manifest.id)
        setActiveTrace(finalized.trace)
        setDraftName(finalized.trace.manifest.name)
        setDraftMarkdown(finalized.trace.markdown)
        notifyInfo(
          isChineseUi
            ? `追踪草稿已生成：${finalized.trace.manifest.name}，请保存或删除后再创建新的追踪。`
            : `Trace draft generated: ${finalized.trace.manifest.name}. Save or delete it before creating another trace.`,
          6000
        )
      }
      await loadTraces()
    } catch (stopError) {
      notifyError(stopError instanceof Error ? stopError.message : 'Failed to stop trace capture.')
    } finally {
      setBusy(false)
    }
  }, [isChineseUi, loadTraces, notifyError, notifyInfo, selectedProjectId])

  const startRealtimeTrace = useCallback(() => {
    if (!selectedProjectId || selectedReferenceTraces.length === 0) return
    if (targetReferenceTraceIds.length > 0) {
      notifyWarning(copy.targetReferenceBlocked)
      return
    }
    if (activeCaptureTraceId || activeRealtimeTraceIds.length > 0) {
      notifyWarning(copy.realtimeBlocked)
      return
    }
    const referenceTraceIds = selectedReferenceTraces.map((trace) => trace.id)
    writeActiveProjectTraceRealtime({
      projectId: selectedProjectId,
      ...(selectedProject?.name ? { projectName: selectedProject.name } : {}),
      referenceTraceIds,
      ...(enhanceProfileId ? { modelProfileId: enhanceProfileId } : {})
    })
    setActiveRealtimeTraceIds(referenceTraceIds)
    notifyInfo(
      isChineseUi
        ? `实时追踪已开启：${selectedReferenceTraces.map((trace) => trace.name).join('、')}`
        : `Realtime trace started: ${selectedReferenceTraces.map((trace) => trace.name).join(', ')}`,
      6000
    )
  }, [
    activeCaptureTraceId,
    activeRealtimeTraceIds,
    copy.realtimeBlocked,
    copy.targetReferenceBlocked,
    enhanceProfileId,
    isChineseUi,
    notifyInfo,
    notifyWarning,
    selectedProject,
    selectedProjectId,
    selectedReferenceTraces,
    targetReferenceTraceIds
  ])

  const stopRealtimeTrace = useCallback(() => {
    if (!selectedProjectId) return
    clearActiveProjectTraceRealtime(selectedProjectId)
    setActiveRealtimeTraceIds([])
    notifyInfo(isChineseUi ? '实时追踪已停止。' : 'Realtime trace stopped.', 6000)
  }, [isChineseUi, notifyInfo, selectedProjectId])

  const cancelRealtimeTrace = useCallback(() => {
    onClose?.()
  }, [onClose])

  const deleteSelectedTrace = useCallback(
    async (traceIds?: string[]) => {
      const idsToDelete = traceIds?.length ? traceIds : selectedTraceId ? [selectedTraceId] : []
      if (!projectRef || idsToDelete.length === 0) return
      setBusy(true)
      try {
        for (const traceId of idsToDelete) {
          await api().svcProjectTrace.deleteProjectTraceDocument({
            project: projectRef,
            traceId
          })
        }
        setSelectedTraceId('')
        setSelectedRecordTraceIds((current) =>
          current.filter((traceId) => !idsToDelete.includes(traceId))
        )
        setActiveTrace(null)
        setDraftName('')
        setDraftMarkdown('')
        setTraceIntent('')
        setNewTraceName('')
        setNewTraceIntent('')
        notifySuccess(isChineseUi ? '追踪已删除。' : 'Trace deleted.')
        await loadTraces()
      } catch (deleteError) {
        notifyError(deleteError instanceof Error ? deleteError.message : 'Failed to delete trace.')
      } finally {
        setBusy(false)
      }
    },
    [isChineseUi, loadTraces, notifyError, notifySuccess, projectRef, selectedTraceId]
  )

  const exportSelectedTraces = useCallback(async () => {
    if (!projectRef || selectedRecordTraceIds.length === 0) {
      notifyWarning(copy.noRecordSelected)
      return
    }
    try {
      const dialogResult = await api().svcDialog.showOpenDialog({
        title: copy.exportFolderTitle,
        properties: ['openDirectory']
      })
      const outputDirectory = dialogResult.filePaths?.[0]
      if (dialogResult.canceled || !outputDirectory) return

      const response = await api().svcProjectTrace.exportProjectTraceDocumentsToDirectory({
        project: projectRef,
        traceIds: selectedRecordTraceIds,
        outputDirectory
      })
      notifySuccess(
        `${copy.exportDone}${response.savedFiles.length ? ` ${response.savedFiles.length}` : ''}`
      )
    } catch (exportError) {
      notifyError(exportError instanceof Error ? exportError.message : 'Failed to export trace.')
    }
  }, [
    copy.exportDone,
    copy.exportFolderTitle,
    copy.noRecordSelected,
    notifyError,
    notifySuccess,
    notifyWarning,
    projectRef,
    selectedRecordTraceIds
  ])

  const trustSelectedTrace = useCallback(
    async (traceId?: string) => {
      const targetTraceId = traceId || selectedSavedTrace?.id || selectedTraceId
      if (!projectRef || !targetTraceId) return
      setBusy(true)
      try {
        const response = await api().svcProjectTrace.trustProjectTraceDocument({
          project: projectRef,
          traceId: targetTraceId
        })
        if (response.trace) {
          setSelectedTraceId(response.trace.manifest.id)
          setActiveTrace(response.trace)
          setDraftName(response.trace.manifest.name)
          setDraftMarkdown(response.trace.markdown)
          setTraceIntent(response.trace.manifest.description || '')
        }
        notifySuccess(copy.trustTraceDone)
        await loadTraces()
      } catch (trustError) {
        notifyError(trustError instanceof Error ? trustError.message : 'Failed to trust trace.')
      } finally {
        setBusy(false)
      }
    },
    [
      copy.trustTraceDone,
      loadTraces,
      notifyError,
      notifySuccess,
      projectRef,
      selectedSavedTrace?.id,
      selectedTraceId
    ]
  )

  const actionDisabled = busy || !projectRef
  const hasActiveRealtimeTrace = activeRealtimeTraceIds.length > 0
  const hasActiveTraceRun = Boolean(activeCaptureTraceId || hasActiveRealtimeTrace)
  const hasTargetTraceReferences = targetReferenceTraceIds.length > 0
  const hasUnfinishedTrace = Boolean(activeCaptureTraceId || selectedTraceIsPendingSave)
  const hasBlockingDraftTrace = draftTraces.length > 0
  const canCreateTrace =
    !actionDisabled && !hasActiveTraceRun && !hasBlockingDraftTrace && !hasTargetTraceReferences
  const canStopTrace = !actionDisabled && Boolean(activeCaptureTraceId)
  const canStartRealtimeTrace =
    !actionDisabled &&
    !hasActiveTraceRun &&
    !hasTargetTraceReferences &&
    selectedReferenceTraces.length > 0
  const canStopRealtimeTrace = !actionDisabled && hasActiveRealtimeTrace
  const canSaveTrace =
    !actionDisabled &&
    selectedTraceIsPendingSave &&
    Boolean(selectedTraceId && draftMarkdown.trim())
  const canDeleteTrace = !actionDisabled && selectedTraceIsPendingSave && Boolean(selectedTraceId)
  const canDeleteSavedTrace = !actionDisabled && selectedRecordTraceIds.length > 0
  const canExportSelectedTraces = !actionDisabled && selectedRecordTraceIds.length > 0
  const selectedSavedTraceNeedsTrust = Boolean(
    selectedSavedTrace &&
    !isDraftTraceTagSet(selectedSavedTrace.tags) &&
    (!isTraceReferenceUsable(selectedSavedTrace) ||
      selectedSavedTrace.localTrust?.trusted === false ||
      selectedSavedTrace.runtimePolicy?.allowTargetReference === false ||
      selectedSavedTrace.runtimePolicy?.allowRealtime === false)
  )
  const canTrustSelectedTrace =
    !actionDisabled &&
    Boolean(selectedSavedTrace) &&
    selectedSavedTraceNeedsTrust &&
    !hasActiveTraceRun &&
    !hasTargetTraceReferences
  const createTraceDisabledReason = hasTargetTraceReferences
    ? copy.targetReferenceBlocked
    : hasBlockingDraftTrace
      ? copy.createBlocked
      : hasActiveTraceRun && !activeCaptureTraceId
        ? copy.realtimeBlocked
        : ''
  const realtimeTraceDisabledReason = hasTargetTraceReferences
    ? copy.targetReferenceBlocked
    : hasActiveTraceRun && !hasActiveRealtimeTrace
      ? copy.realtimeBlocked
      : referenceReadyTraces.length === 0
        ? copy.noReferenceReadyTrace
        : ''
  const tracePreview = truncateTraceContent(activeTrace?.markdown || draftMarkdown)

  const cancelCreateTrace = useCallback(() => {
    if (!hasUnfinishedTrace) {
      setNewTraceName('')
      setNewTraceIntent('')
    }
    onClose?.()
  }, [hasUnfinishedTrace, onClose])

  const toggleRecordTraceSelection = useCallback((traceId: string) => {
    setSelectedRecordTraceIds((current) =>
      current.includes(traceId)
        ? current.filter((entry) => entry !== traceId)
        : [...current, traceId]
    )
    setSelectedTraceId(traceId)
  }, [])

  const toggleRealtimeTraceSelection = useCallback(
    (traceId: string) => {
      if (hasActiveRealtimeTrace) return
      setSelectedRealtimeTraceIds((current) =>
        current.includes(traceId)
          ? current.filter((entry) => entry !== traceId)
          : [...current, traceId]
      )
      setSelectedTraceId(traceId)
    },
    [hasActiveRealtimeTrace]
  )

  const renderProfileSelect = () => (
    <TextField
      select
      size="small"
      label={copy.enhanceModel}
      value={enhanceProfileId}
      onChange={(event) => setEnhanceProfileId(event.target.value)}
      sx={{ minWidth: 240 }}
    >
      <MenuItem value="">{copy.notEnhanced}</MenuItem>
      {profiles.map((profile) => (
        <MenuItem key={profile.id} value={profile.id}>
          {profile.model_name || profile.id}
        </MenuItem>
      ))}
    </TextField>
  )

  const renderSaveDeleteControls = () => (
    <Stack direction="row" spacing={1} justifyContent="flex-end">
      <Button
        color="error"
        startIcon={<DeleteIcon />}
        onClick={() => void deleteSelectedTrace()}
        disabled={!canDeleteTrace}
      >
        {copy.deleteTrace}
      </Button>
      <Tooltip title={copy.saveTrace}>
        <span>
          <Button
            startIcon={<SaveIcon />}
            variant="contained"
            onClick={() => void saveDraft()}
            disabled={!canSaveTrace}
          >
            {copy.saveTrace}
          </Button>
        </span>
      </Tooltip>
    </Stack>
  )

  const renderReferenceStateChip = (tags: string[] | undefined) => {
    if (isDraftTraceTagSet(tags)) {
      return <Chip size="small" label={copy.pendingSave} />
    }
    return (
      <Chip
        size="small"
        color={isReferenceReadyTraceTagSet(tags) ? 'success' : 'warning'}
        label={isReferenceReadyTraceTagSet(tags) ? copy.referenceReady : copy.needsReview}
      />
    )
  }

  const renderLocalTrustChip = (trace: ProjectTraceDocumentSummary) => {
    if (
      trace.localTrust?.trusted !== false &&
      trace.runtimePolicy?.allowRealtime !== false &&
      trace.runtimePolicy?.allowTargetReference !== false
    ) {
      return null
    }

    const reason = trace.localTrust?.reason
    const label =
      reason === 'content_changed'
        ? copy.changedTrace
        : reason === 'project_mismatch'
          ? copy.projectMismatchTrace
          : reason === 'runtime_disabled' ||
              trace.runtimePolicy?.allowRealtime === false ||
              trace.runtimePolicy?.allowTargetReference === false
            ? copy.runtimeDisabledTrace
            : copy.untrustedTrace

    return <Chip size="small" color="warning" label={label} />
  }

  const renderTraceStateChips = (trace: ProjectTraceDocumentSummary) => (
    <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ flexShrink: 0 }}>
      {renderReferenceStateChip(trace.tags)}
      {renderLocalTrustChip(trace)}
    </Stack>
  )

  const renderTraceMemorySections = (trace: ProjectTraceDocument | null) => {
    if (!trace) {
      return <Alert severity="info">{copy.noTraceSelected}</Alert>
    }
    const softwareRules = trace.executableRules?.rules || []
    const semanticRules = trace.executableRules?.semanticRules || []

    return (
      <Stack spacing={1}>
        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            p: 1.25
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.75 }}>
            {copy.skillSummary}
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            {trace.skillSummary?.summary || truncateTraceContent(trace.markdown)}
          </Typography>
          {trace.skillSummary?.applicableTo.length ? (
            <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
              {trace.skillSummary.applicableTo.map((entry) => (
                <Chip key={entry} size="small" label={entry} />
              ))}
            </Stack>
          ) : null}
        </Box>

        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            p: 1.25
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.75 }}>
            {copy.executableRules}
          </Typography>
          {softwareRules.length || semanticRules.length ? (
            <Stack spacing={0.75}>
              {softwareRules.map((rule) => (
                <Box key={rule.id}>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {rule.type}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {rule.target} {rule.condition.operator} {rule.condition.value}
                    {rule.condition.unit} · {rule.mode}
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.25 }}>
                    {rule.feedback}
                  </Typography>
                </Box>
              ))}
              {semanticRules.map((rule) => (
                <Box key={rule.id}>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    {isChineseUi ? '模型复核规则' : 'Model-review rule'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {rule.target || 'canvas workflow'} 路 {rule.mode}
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.25, whiteSpace: 'pre-wrap' }}>
                    {rule.requirement}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                    {rule.feedback}
                  </Typography>
                </Box>
              ))}
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {copy.noExecutableRules}
            </Typography>
          )}
        </Box>

        <Box
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            p: 1.25
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.75 }}>
            {copy.redactionReport}
          </Typography>
          <Typography variant="body2">{copy.redactionSafe}</Typography>
          <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
            <Chip
              size="small"
              label={`policy v${trace.redactionReport.policyVersion}`}
              color="success"
            />
            <Chip size="small" label={`removed: ${trace.redactionReport.removedFields.length}`} />
            <Chip size="small" label={`replacements: ${trace.redactionReport.replacementCount}`} />
          </Stack>
        </Box>
      </Stack>
    )
  }

  const renderTraceDetails = (options?: {
    showContentPreview?: boolean
    savedOnly?: boolean
    referenceOnly?: boolean
  }) => {
    const trace = options?.referenceOnly
      ? selectedReferenceTraces[0] || null
      : options?.savedOnly
        ? selectedSavedTrace
        : selectedTrace
    if (!trace) {
      return <Alert severity="info">{copy.noTraceSelected}</Alert>
    }
    const traceNeedsTrust =
      trace.localTrust?.trusted === false ||
      trace.runtimePolicy?.allowRealtime === false ||
      trace.runtimePolicy?.allowTargetReference === false

    return (
      <Box
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 1,
          p: 1.25
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          {trace.name}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          <Chip size="small" label={`${copy.sourceKind}: ${trace.sourceKind}`} />
          <Chip size="small" label={`${copy.eventCount}: ${trace.eventCount}`} />
          <Chip
            size="small"
            color={trace.llmEnhanced ? 'primary' : 'default'}
            label={trace.llmEnhanced ? copy.enhanced : copy.notEnhanced}
          />
          {renderReferenceStateChip(trace.tags)}
          {renderLocalTrustChip(trace)}
          <Chip size="small" label={`${copy.updatedAt}: ${formatTraceTime(trace.updatedAt)}`} />
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {copy.storage}: {trace.storageRelativePath}
        </Typography>
        {traceNeedsTrust ? (
          <Alert
            severity="warning"
            sx={{ mt: 1.25 }}
            action={
              <Button
                color="warning"
                size="small"
                startIcon={<TrustIcon />}
                onClick={() => void trustSelectedTrace(trace.id)}
                disabled={!canTrustSelectedTrace || selectedSavedTrace?.id !== trace.id}
              >
                {copy.trustTrace}
              </Button>
            }
          >
            {copy.trustTraceHelp}
          </Alert>
        ) : null}
        {options?.showContentPreview ? (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
              {copy.contentPreview}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                mt: 0.5,
                whiteSpace: 'pre-wrap',
                color: tracePreview ? 'text.primary' : 'text.secondary'
              }}
            >
              {tracePreview || copy.noTraceSelected}
            </Typography>
          </>
        ) : null}
      </Box>
    )
  }

  const renderRealtimeTraceDetails = () => {
    if (selectedReferenceTraces.length === 0) {
      return <Alert severity="info">{copy.noTraceSelected}</Alert>
    }

    return (
      <Stack
        spacing={0.75}
        sx={{
          maxHeight: 260,
          overflowY: 'auto',
          pr: 0.5
        }}
      >
        {selectedReferenceTraces.map((trace) => {
          const isFocusedTrace = trace.id === selectedTraceId
          return (
            <Box
              key={trace.id}
              sx={{
                border: '1px solid',
                borderColor: isFocusedTrace ? 'primary.main' : 'divider',
                borderRadius: 1,
                px: 1.1,
                py: 0.9,
                cursor: 'pointer'
              }}
              onClick={() => setSelectedTraceId(trace.id)}
            >
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap>
                  {trace.name}
                </Typography>
                {renderTraceStateChips(trace)}
              </Stack>
              <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                <Chip size="small" label={`${copy.sourceKind}: ${trace.sourceKind}`} />
                <Chip size="small" label={`${copy.eventCount}: ${trace.eventCount}`} />
                <Chip
                  size="small"
                  color={trace.llmEnhanced ? 'primary' : 'default'}
                  label={trace.llmEnhanced ? copy.enhanced : copy.notEnhanced}
                />
                <Chip
                  size="small"
                  label={`${copy.updatedAt}: ${formatTraceTime(trace.updatedAt)}`}
                />
              </Stack>
              {trace.description ? (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: '-webkit-box',
                    mt: 0.75,
                    overflow: 'hidden',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: 2
                  }}
                >
                  {trace.description}
                </Typography>
              ) : null}
              {isFocusedTrace && tracePreview ? (
                <>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 1 }}
                  >
                    {copy.contentPreview}
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{
                      display: '-webkit-box',
                      mt: 0.5,
                      overflow: 'hidden',
                      WebkitBoxOrient: 'vertical',
                      WebkitLineClamp: 3,
                      whiteSpace: 'normal'
                    }}
                  >
                    {tracePreview}
                  </Typography>
                </>
              ) : null}
            </Box>
          )
        })}
      </Stack>
    )
  }

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        p: compact ? 1.25 : 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        overflow: 'hidden'
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ minHeight: 34 }}>
        <Typography variant={compact ? 'subtitle1' : 'h5'} sx={{ fontWeight: 700 }}>
          {copy.title}
        </Typography>
        {scopedProject ? (
          <Chip size="small" label={scopedProject.name} sx={{ maxWidth: 180 }} />
        ) : (
          <TextField
            select
            size="small"
            label={copy.project}
            value={selectedProjectId}
            onChange={(event) => setSelectedProjectId(event.target.value)}
            sx={{ minWidth: 260 }}
          >
            {projects.map((project) => (
              <MenuItem key={project.id} value={project.id}>
                {project.name}
              </MenuItem>
            ))}
          </TextField>
        )}
        <Chip
          size="small"
          color={activeCaptureTraceId || hasActiveRealtimeTrace ? 'success' : 'default'}
          label={
            activeCaptureTraceId
              ? `${copy.active}${activeCaptureTrace ? `: ${activeCaptureTrace.name}` : ''}`
              : hasActiveRealtimeTrace
                ? `${copy.realtimeTab}: ${
                    activeRealtimeTraces.length > 1
                      ? `${activeRealtimeTraces.length}`
                      : activeRealtimeTraces[0]?.name || activeRealtimeTraceIds[0] || ''
                  }`
                : copy.inactive
          }
          sx={{ maxWidth: 260 }}
        />
        <Tooltip title={copy.refresh}>
          <span>
            <IconButton size="small" disabled={busy} onClick={() => void loadTraces()}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        {busy ? <LinearProgress sx={{ flex: 1 }} /> : <Box sx={{ flex: 1 }} />}
        {onClose ? (
          <Tooltip title={copy.close}>
            <IconButton size="small" onClick={onClose}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Stack>

      <Tabs
        value={activeTab}
        onChange={(_event, value: ProjectTraceTab) => setActiveTab(value)}
        variant="fullWidth"
        sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, fontWeight: 700 } }}
      >
        <Tab value="create" label={copy.createTab} />
        <Tab value="realtime" label={copy.realtimeTab} />
        <Tab value="records" label={copy.recordsTab} />
      </Tabs>

      {error ? <Alert severity="error">{error}</Alert> : null}
      {projects.length === 0 ? <Alert severity="info">{copy.emptyProject}</Alert> : null}

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {activeTab === 'create' ? (
          <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <Stack
              spacing={1.25}
              sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 0.5, pt: 1.25 }}
            >
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems="flex-start">
                <TextField
                  size="small"
                  label={copy.traceName}
                  value={hasUnfinishedTrace ? draftName : newTraceName}
                  onChange={(event) =>
                    hasUnfinishedTrace
                      ? setDraftName(event.target.value)
                      : setNewTraceName(event.target.value)
                  }
                  disabled={selectedTraceIsActive}
                  sx={{
                    flex: 1,
                    minWidth: 220,
                    '& .MuiInputLabel-root': {
                      bgcolor: 'background.paper',
                      px: 0.5
                    }
                  }}
                />
                {renderProfileSelect()}
              </Stack>
              <TextField
                label={copy.traceIntent}
                value={hasUnfinishedTrace ? traceIntent : newTraceIntent}
                onChange={(event) =>
                  hasUnfinishedTrace
                    ? setTraceIntent(event.target.value)
                    : setNewTraceIntent(event.target.value)
                }
                multiline
                minRows={2}
                fullWidth
                disabled={selectedTraceIsActive}
                placeholder={copy.traceIntentTemplate}
                helperText={copy.traceIntentHelper}
              />
              <Alert severity="info" sx={{ whiteSpace: 'pre-wrap' }}>
                {copy.traceIntentTemplate}
              </Alert>
              {hasUnfinishedTrace ? renderTraceMemorySections(activeTrace) : null}
              {renderSaveDeleteControls()}
              {selectedTraceIsPendingSave ? (
                <Alert
                  severity={
                    isReferenceReadyTraceTagSet(selectedTrace?.tags) ? 'success' : 'warning'
                  }
                >
                  {isReferenceReadyTraceTagSet(selectedTrace?.tags)
                    ? copy.referenceReady
                    : copy.needsReview}
                </Alert>
              ) : null}
              <Box
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  overflow: 'hidden'
                }}
              >
                <Box sx={{ px: 1.25, py: 1 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                    {copy.traceList}
                  </Typography>
                </Box>
                <Divider />
                {draftTraces.length === 0 ? (
                  <Alert severity="info" sx={{ m: 1 }}>
                    {copy.emptyTrace}
                  </Alert>
                ) : (
                  <Stack spacing={0.5} sx={{ p: 1 }}>
                    {draftTraces.map((trace) => (
                      <ListItemButton
                        key={trace.id}
                        selected={trace.id === selectedTraceId}
                        onClick={() => setSelectedTraceId(trace.id)}
                        sx={{ borderRadius: 1 }}
                      >
                        <ListItemText
                          primary={trace.name}
                          secondary={`${summarizeTrace(trace)} · ${copy.draft}`}
                          primaryTypographyProps={{ noWrap: true }}
                          secondaryTypographyProps={{ noWrap: true }}
                        />
                      </ListItemButton>
                    ))}
                  </Stack>
                )}
              </Box>
            </Stack>
            <Divider sx={{ mt: 1 }} />
            <Stack
              direction="row"
              spacing={1.5}
              justifyContent="flex-end"
              alignItems="center"
              sx={{ pt: 1.25 }}
            >
              <Button onClick={cancelCreateTrace} disabled={busy}>
                {copy.closePanel}
              </Button>
              <Tooltip title={!canCreateTrace ? createTraceDisabledReason : ''}>
                <span>
                  <Button
                    color={activeCaptureTraceId ? 'error' : 'primary'}
                    variant="contained"
                    startIcon={activeCaptureTraceId ? <StopIcon /> : undefined}
                    onClick={() =>
                      activeCaptureTraceId ? void stopCapture() : void createAndStartTrace()
                    }
                    disabled={activeCaptureTraceId ? !canStopTrace : !canCreateTrace}
                  >
                    {activeCaptureTraceId ? copy.stop : copy.createAndStart}
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        ) : null}

        {activeTab === 'realtime' ? (
          <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <Stack spacing={1.25} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 0.5 }}>
              {hasTargetTraceReferences ? (
                <Alert severity="warning">{copy.targetReferenceBlocked}</Alert>
              ) : null}
              {hasActiveRealtimeTrace ? (
                <Alert severity="success">{copy.realtimeRunning}</Alert>
              ) : selectedRealtimeTraceIds.length > 0 ? (
                <Alert severity="warning">{copy.realtimeSelectedNotRunning}</Alert>
              ) : null}
              <Alert severity="info">
                <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                  {copy.realtimeMechanismTitle}
                </Typography>
                <Typography variant="body2">{copy.realtimeMechanism}</Typography>
              </Alert>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: '1fr',
                    md: 'minmax(280px, 0.9fr) minmax(380px, 1.35fr)'
                  },
                  gap: 1.25,
                  alignItems: 'start',
                  '& > *': { minWidth: 0 }
                }}
              >
                <Box
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    overflow: 'hidden'
                  }}
                >
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.25, py: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {copy.traceReferences}
                    </Typography>
                    <Chip
                      size="small"
                      label={`${copy.selectedTraceCount}: ${selectedRealtimeTraceIds.length}`}
                    />
                  </Stack>
                  <Divider />
                  {referenceReadyTraces.length === 0 ? (
                    <Alert severity="info" sx={{ m: 1 }}>
                      {copy.noReferenceReadyTrace}
                    </Alert>
                  ) : (
                    <Stack
                      spacing={0.25}
                      sx={{
                        maxHeight: { xs: 300, md: 420 },
                        overflowY: 'auto',
                        p: 0.75
                      }}
                    >
                      {referenceReadyTraces.map((trace) => {
                        const checked = selectedRealtimeTraceIds.includes(trace.id)
                        return (
                          <ListItemButton
                            key={trace.id}
                            selected={checked}
                            onClick={() => toggleRealtimeTraceSelection(trace.id)}
                            disabled={hasActiveRealtimeTrace}
                            sx={{
                              borderRadius: 1,
                              alignItems: 'center',
                              gap: 1,
                              minHeight: 48,
                              px: 1,
                              py: 0.5
                            }}
                          >
                            <Checkbox
                              edge="start"
                              size="small"
                              checked={checked}
                              tabIndex={-1}
                              disableRipple
                              disabled={hasActiveRealtimeTrace}
                              onClick={(event) => {
                                event.stopPropagation()
                                toggleRealtimeTraceSelection(trace.id)
                              }}
                              sx={{ p: 0.25 }}
                            />
                            <ListItemText
                              primary={trace.name}
                              secondary={summarizeTrace(trace)}
                              primaryTypographyProps={{ noWrap: true }}
                              secondaryTypographyProps={{ noWrap: true }}
                              sx={{ minWidth: 0, my: 0 }}
                            />
                            {renderTraceStateChips(trace)}
                          </ListItemButton>
                        )
                      })}
                    </Stack>
                  )}
                </Box>
                <Box
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    overflow: 'hidden'
                  }}
                >
                  <Box sx={{ px: 1.25, py: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {copy.traceSummary}
                    </Typography>
                  </Box>
                  <Divider />
                  <Box sx={{ p: 1 }}>{renderRealtimeTraceDetails()}</Box>
                </Box>
              </Box>
              {renderProfileSelect()}
              <Box
                sx={{
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  overflow: 'hidden'
                }}
              >
                <Box sx={{ px: 1.25, py: 1 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                    {copy.recentEvents}
                  </Typography>
                </Box>
                <Divider />
                <Stack spacing={0.75} sx={{ maxHeight: 180, overflowY: 'auto', p: 1 }}>
                  {recentEvents.slice(-14).map((event) => (
                    <Box key={event.id}>
                      <Chip
                        size="small"
                        label={`${event.scope}/${event.status}`}
                        sx={{ mr: 0.5 }}
                      />
                      <Typography component="span" variant="caption">
                        {event.safeSummary}
                      </Typography>
                    </Box>
                  ))}
                  {recentEvents.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      {copy.noRecentEvents}
                    </Typography>
                  ) : null}
                </Stack>
              </Box>
            </Stack>
            <Divider sx={{ mt: 1 }} />
            <Stack
              direction="row"
              spacing={1.5}
              justifyContent="flex-end"
              alignItems="center"
              sx={{ pt: 1.25 }}
            >
              <Button onClick={cancelRealtimeTrace} disabled={busy}>
                {copy.closePanel}
              </Button>
              <Tooltip
                title={
                  hasActiveRealtimeTrace
                    ? ''
                    : !canStartRealtimeTrace
                      ? realtimeTraceDisabledReason
                      : ''
                }
              >
                <span>
                  <Button
                    color={hasActiveRealtimeTrace ? 'error' : 'primary'}
                    variant="contained"
                    startIcon={hasActiveRealtimeTrace ? <StopIcon /> : undefined}
                    onClick={() =>
                      hasActiveRealtimeTrace ? stopRealtimeTrace() : startRealtimeTrace()
                    }
                    disabled={
                      hasActiveRealtimeTrace ? !canStopRealtimeTrace : !canStartRealtimeTrace
                    }
                  >
                    {hasActiveRealtimeTrace ? copy.stop : copy.startRealtime}
                  </Button>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        ) : null}

        {activeTab === 'records' ? (
          <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <Stack spacing={1.25} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 0.5 }}>
              {savedTraces.length === 0 ? <Alert severity="info">{copy.emptyTrace}</Alert> : null}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: {
                    xs: '1fr',
                    md: 'minmax(280px, 0.9fr) minmax(400px, 1.35fr)'
                  },
                  gap: 1.25,
                  alignItems: 'start',
                  '& > *': { minWidth: 0 }
                }}
              >
                <Box
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    overflow: 'hidden'
                  }}
                >
                  <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.25, py: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {copy.recordsTab}
                    </Typography>
                  </Stack>
                  <Divider />
                  {savedTraces.length === 0 ? null : (
                    <Stack
                      spacing={0.5}
                      sx={{ maxHeight: { xs: 280, md: 520 }, overflowY: 'auto', p: 1 }}
                    >
                      {savedTraces.map((trace) => {
                        const checked = selectedRecordTraceIds.includes(trace.id)
                        return (
                          <ListItemButton
                            key={trace.id}
                            selected={trace.id === selectedTraceId}
                            onClick={() => setSelectedTraceId(trace.id)}
                            sx={{ borderRadius: 1, alignItems: 'flex-start', gap: 1 }}
                          >
                            <Checkbox
                              edge="start"
                              checked={checked}
                              tabIndex={-1}
                              disableRipple
                              onClick={(event) => {
                                event.stopPropagation()
                                toggleRecordTraceSelection(trace.id)
                              }}
                              sx={{ mt: -0.5 }}
                            />
                            <ListItemText
                              primary={trace.name}
                              secondary={summarizeTrace(trace)}
                              primaryTypographyProps={{ noWrap: true }}
                              secondaryTypographyProps={{ noWrap: true }}
                            />
                            {renderTraceStateChips(trace)}
                          </ListItemButton>
                        )
                      })}
                    </Stack>
                  )}
                  <Stack direction="row" justifyContent="flex-end" sx={{ px: 1, pb: 1 }}>
                    <Button
                      color="error"
                      size="small"
                      startIcon={<DeleteIcon />}
                      onClick={() => void deleteSelectedTrace(selectedRecordTraceIds)}
                      disabled={!canDeleteSavedTrace}
                    >
                      {copy.deleteTrace}
                    </Button>
                  </Stack>
                </Box>
                <Stack spacing={1.25}>
                  <TextField
                    select
                    size="small"
                    label={copy.tracePicker}
                    value={selectedSavedTrace?.id || ''}
                    onChange={(event) => setSelectedTraceId(event.target.value)}
                    fullWidth
                    disabled={savedTraces.length === 0}
                    sx={{ display: 'none' }}
                  >
                    <MenuItem value="">{copy.noTraceSelected}</MenuItem>
                    {savedTraces.map((trace) => (
                      <MenuItem key={trace.id} value={trace.id}>
                        {trace.name} · {summarizeTrace(trace)}
                      </MenuItem>
                    ))}
                  </TextField>
                  {renderTraceDetails({ savedOnly: true })}
                  {renderTraceMemorySections(activeTrace)}
                </Stack>
              </Box>
            </Stack>
            <Divider sx={{ mt: 1 }} />
            <Stack
              direction="row"
              spacing={1.5}
              justifyContent="flex-end"
              alignItems="center"
              sx={{ pt: 1.25 }}
            >
              <Button onClick={onClose} disabled={busy}>
                {copy.closePanel}
              </Button>
              <Button
                startIcon={<DownloadIcon />}
                variant="contained"
                onClick={() => void exportSelectedTraces()}
                disabled={!canExportSelectedTraces}
              >
                {copy.export}
              </Button>
            </Stack>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}
