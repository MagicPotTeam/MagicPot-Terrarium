/* @refresh reset */
import { useCallback, useMemo, useState } from 'react'
import {
  buildCanvasGenerationTaskPack,
  buildCanvasGenerationTaskPackPrompt,
  type GenerationTaskPack
} from './canvasGenerationTaskPack'
import {
  beginGenerationTraceSession,
  createGenerationTraceSessionId
} from './generationTraceRuntime'
import {
  resolveActiveCanvasAgentSessionKey,
  resolveCanvasAgentSessionKeyForScope
} from './canvasPageLocalStateUtils'
import {
  listGenerationTraceRecords,
  updateTraceUserDecision,
  upsertGenerationTraceRecord
} from './generationTraceStorage'
import type { SendCanvasItemsToAgentOptions } from './projectCanvasPageShared'
import type { CanvasItem } from './types'

const GENERATE_FROM_SELECTION_PROMPT = [
  '请把当前画板选中的内容作为同一个美术出图任务来理解。',
  '先提炼核心需求、主体设定、风格方向和关键画面信息。',
  '直接输出候选图方向、生成要点和下一步建议。'
].join('\n')

function normalizeGenerationPromptText(value: string | undefined, limit = 280): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized
}

function buildCanvasGenerationResourceSummary(targetItems: CanvasItem[]): string {
  const labels: Array<[CanvasItem['type'], string]> = [
    ['image', 'image'],
    ['file', 'file'],
    ['video', 'video'],
    ['model3d', '3d-model'],
    ['text', 'text'],
    ['annotation', 'annotation'],
    ['html', 'html']
  ]
  const counts = new Map<CanvasItem['type'], number>()

  for (const item of targetItems) {
    counts.set(item.type, (counts.get(item.type) || 0) + 1)
  }

  return labels
    .map(([type, label]) => {
      const count = counts.get(type) || 0
      return count > 0 ? `${count} ${label}${count > 1 ? 's' : ''}` : ''
    })
    .filter(Boolean)
    .join(', ')
}

function collectTaskPackPromptTextValues(taskPack: GenerationTaskPack): Set<string> {
  const values = new Set<string>()

  for (const entries of [taskPack.requirementDocs, taskPack.referenceDocs, taskPack.taskNotes]) {
    for (const entry of entries) {
      const normalized = normalizeGenerationPromptText(entry.contentText || entry.excerpt)
      if (normalized) {
        values.add(normalized)
      }
    }
  }

  return values
}

function collectCanvasGenerationTextReferenceCues(
  targetItems: CanvasItem[],
  excludedTexts: ReadonlySet<string> = new Set()
): string[] {
  const promptLines: string[] = []
  const seenPromptLines = new Set<string>()

  for (const item of targetItems) {
    let textContent = ''

    if (item.type === 'text') {
      textContent = item.text
    } else if (item.type === 'annotation') {
      textContent = item.text || item.label
    } else if (item.type === 'html') {
      textContent = item.htmlData.replace(/<[^>]+>/g, ' ')
    }

    const normalized = normalizeGenerationPromptText(textContent)
    if (!normalized || excludedTexts.has(normalized) || seenPromptLines.has(normalized)) continue
    seenPromptLines.add(normalized)
    promptLines.push(normalized)

    if (promptLines.length >= 6) {
      break
    }
  }

  return promptLines
}

function buildCanvasGenerationResourceReferenceDirective(
  targetItems: CanvasItem[],
  excludedTexts: ReadonlySet<string> = new Set()
): string {
  const promptLines = collectCanvasGenerationTextReferenceCues(targetItems, excludedTexts)
  const resourceSummary = buildCanvasGenerationResourceSummary(targetItems)

  return [
    'Canvas resource reference note:',
    'Treat every selected canvas element as referenced execution material. Do not automatically turn any selected element into the primary chat prompt.',
    'Images, files, videos, 3D models, text blocks, annotations, and HTML snippets all belong to the same source-material pool for this run.',
    'Use the selected resources when extracting requirements, constraints, labels, copy, structure, visual style, and generation cues.',
    'Selections containing only text items, only media items, or any mixed combination are all valid automation inputs.',
    `Selected resource mix: ${resourceSummary || 'none'}.`,
    ...(promptLines.length > 0
      ? ['Text-bearing resource cues:', ...promptLines.map((line) => `- ${line}`)]
      : [])
  ].join('\n')
}

type NotifyFn = (message: string) => unknown

export type GenerationFollowUpIntent = {
  sourceSessionId: string
  decision: 'retried' | 'refined'
}

type UseCanvasGenerationWorkflowOptions = {
  canvasId: string
  projectName: string
  items: CanvasItem[]
  notifySuccess: NotifyFn
  notifyWarning: NotifyFn
  sendCanvasItemsToAgent: (
    targetItems: CanvasItem[],
    options?: SendCanvasItemsToAgentOptions
  ) => Promise<void>
}

export function useCanvasGenerationWorkflow({
  canvasId,
  projectName,
  items,
  notifySuccess,
  notifyWarning,
  sendCanvasItemsToAgent
}: UseCanvasGenerationWorkflowOptions) {
  const [generationTaskDialogOpen, setGenerationTaskDialogOpen] = useState(false)
  const [generationTargetItemIds, setGenerationTargetItemIds] = useState<string[]>([])
  const [generationTargetScope, setGenerationTargetScope] = useState<string | null>(null)
  const [generationFollowUpIntent, setGenerationFollowUpIntent] =
    useState<GenerationFollowUpIntent | null>(null)

  const generationTargetItems = useMemo(
    () => items.filter((item) => generationTargetItemIds.includes(item.id)),
    [generationTargetItemIds, items]
  )

  const generationTaskPack = useMemo(
    () =>
      generationTargetItems.length > 0
        ? buildCanvasGenerationTaskPack({
            projectId: canvasId,
            projectName,
            items: generationTargetItems
          })
        : null,
    [canvasId, generationTargetItems, projectName]
  )

  const handleCloseGenerationTaskDialog = useCallback(() => {
    setGenerationTaskDialogOpen(false)
    setGenerationTargetItemIds([])
    setGenerationTargetScope(null)
    setGenerationFollowUpIntent(null)
  }, [])

  const linkFollowUpTraceRecord = useCallback(
    (followUpSessionId: string) => {
      if (!generationFollowUpIntent) return

      const sourceRecord = listGenerationTraceRecords(canvasId).find(
        (record) => record.sessionId === generationFollowUpIntent.sourceSessionId
      )
      if (!sourceRecord) return

      const updatedSourceRecord = updateTraceUserDecision(
        sourceRecord,
        generationFollowUpIntent.decision,
        followUpSessionId
      )

      upsertGenerationTraceRecord(canvasId, updatedSourceRecord)
    },
    [canvasId, generationFollowUpIntent]
  )

  const handleConfirmGenerationTaskPack = useCallback(async () => {
    const targetItems = items.filter((item) => generationTargetItemIds.includes(item.id))
    if (targetItems.length === 0) {
      notifyWarning('当前没有可发送的出图资料')
      return
    }

    const taskPack = buildCanvasGenerationTaskPack({
      projectId: canvasId,
      projectName,
      items: targetItems
    })
    const taskPackPrompt = buildCanvasGenerationTaskPackPrompt(taskPack, { type: 'default-agent' })
    const resourceReferenceDirective = buildCanvasGenerationResourceReferenceDirective(
      targetItems,
      collectTaskPackPromptTextValues(taskPack)
    )

    const promptPrefix = [
      GENERATE_FROM_SELECTION_PROMPT,
      resourceReferenceDirective,
      taskPackPrompt
    ]
      .filter(Boolean)
      .join('\n\n')

    const generationSessionId = createGenerationTraceSessionId()
    const generationAgentSessionKey = generationTargetScope
      ? resolveCanvasAgentSessionKeyForScope(canvasId, generationTargetScope)
      : resolveActiveCanvasAgentSessionKey(canvasId)
    linkFollowUpTraceRecord(generationSessionId)
    beginGenerationTraceSession({
      canvasId,
      sessionId: generationSessionId,
      projectId: canvasId,
      projectName,
      agentScope: generationTargetScope || undefined,
      agentSessionKey: generationAgentSessionKey,
      selectedItemIds: targetItems.map((item) => item.id),
      routeChoice: { type: 'default-agent' },
      taskPack,
      notes: 'Default agent path used without a project model'
    })

    await sendCanvasItemsToAgent(targetItems, {
      targetScope: generationTargetScope || undefined,
      promptPrefix,
      includeCanvasPromptText: false,
      includeGroupCompletionPrompt: false
    })

    notifySuccess('已发送给默认 Agent 生成候选图')
    handleCloseGenerationTaskDialog()
  }, [
    canvasId,
    generationTargetItemIds,
    generationTargetScope,
    handleCloseGenerationTaskDialog,
    items,
    linkFollowUpTraceRecord,
    notifySuccess,
    notifyWarning,
    projectName,
    sendCanvasItemsToAgent
  ])

  const handleGenerateCanvasItems = useCallback(
    async (
      targetItems: CanvasItem[],
      targetScope?: string,
      followUpIntent?: GenerationFollowUpIntent | null
    ) => {
      if (targetItems.length === 0) {
        notifyWarning('请选择需要出图的资料')
        return
      }

      setGenerationTargetItemIds([...new Set(targetItems.map((item) => item.id))])
      setGenerationTargetScope(targetScope || null)
      setGenerationFollowUpIntent(followUpIntent || null)
      setGenerationTaskDialogOpen(true)
    },
    [notifyWarning]
  )

  return {
    generationTaskDialogOpen,
    generationTaskPack,
    handleCloseGenerationTaskDialog,
    handleConfirmGenerationTaskPack,
    handleGenerateCanvasItems
  }
}
