import type { ChatAttachment, LLMProxySvc } from '@shared/api/svcLLMProxy'
import type {
  DesignInspectionContextPack,
  DesignInspectionProposal
} from '@shared/designInspection'
import { createDesignInspectionId } from './designInspectionCommon'
import { buildDesignInspectionSelectionProvenanceNarrative } from './designInspectionProvenanceNarrative'

type RequestDesignInspectionProposalOptions = {
  contextPack: DesignInspectionContextPack
  draftProposal: DesignInspectionProposal
  llmProxy?: Pick<LLMProxySvc, 'chat' | 'listProfiles'> | null
  attachments?: ChatAttachment[]
  userNotes?: string
}

type DesignInspectionAgentContentSuggestion = {
  itemId: string
  title?: string
  summary?: string
  description?: string
  expectedImpact?: string
  evidence?: string[]
  content: string
}

type DesignInspectionAgentResponse = Partial<DesignInspectionProposal> & {
  contentActionSuggestions?: DesignInspectionAgentContentSuggestion[]
}

function buildDesignInspectionAgentPrompt(
  contextPack: DesignInspectionContextPack,
  draftProposal: DesignInspectionProposal,
  userNotes?: string
): string {
  const provenanceNarrative = buildDesignInspectionSelectionProvenanceNarrative(
    contextPack.selectionItems
  )

  return [
    'You are MagicPot’s design-inspection planner.',
    'Improve the human-facing wording of the draft proposal, but do not change any existing action id, type, executor, targetItemIds, payload, or execution step ordering.',
    'Preserve every existing issue id and its actionIds. You may only refine summary, rationale, expectedResult, issue titles, issue summaries, evidence phrasing, action titles, action descriptions, and expectedImpact for the draft proposal.',
    'If reviewer notes explicitly ask for document or file-copy changes, you may also return contentActionSuggestions for editable file nodes from contextPack.documents.',
    'Each contentActionSuggestion must target exactly one editable file node, provide a full replacement content string, and stay within MagicPot-internal execution. Do not suggest content changes for non-editable files.',
    'When provenance is present, treat it only as upstream origin context. MagicPot canvas geometry, text, grouping, and coordinates remain the runtime inspection truth.',
    'You may mention provenance in reviewer-facing narrative when it clarifies whether a node came from native canvas work, imported files, or external bridge payloads, but do not replace MagicPot-internal actions with external execution.',
    'Return JSON only.',
    JSON.stringify(
      {
        contextPack,
        draftProposal,
        provenanceOverview: provenanceNarrative?.promptOverview,
        userNotes: userNotes?.trim() || undefined
      },
      null,
      2
    )
  ].join('\n\n')
}

function stripCodeFences(value: string): string {
  return value
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim()
}

function normalizeMultilineContent(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function shouldAllowAgentContentSuggestions(userNotes?: string): boolean {
  const normalizedNotes = userNotes?.trim().toLowerCase()
  if (!normalizedNotes) return false

  const mentionsEditableFileTarget =
    /(file|files|document|documents|markdown|md|txt|copy|content|wording|text content|\u6587\u4ef6|\u6587\u6863|\u6587\u6848|\u5185\u5bb9|\u6587\u672c)/.test(
      normalizedNotes
    )
  const mentionsEditIntent =
    /(update|rewrite|revise|edit|change|replace|refresh|modify|\u4fee\u6539|\u66f4\u65b0|\u91cd\u5199|\u6539\u5199|\u66ff\u6362|\u6da6\u8272)/.test(
      normalizedNotes
    )

  return mentionsEditableFileTarget && mentionsEditIntent
}

function buildAgentSuggestedContentActions(
  contextPack: DesignInspectionContextPack,
  suggestions: DesignInspectionAgentContentSuggestion[] | undefined,
  allowContentSuggestions: boolean
): Pick<DesignInspectionProposal, 'issues' | 'actions' | 'executionPlan'> {
  if (!allowContentSuggestions || !Array.isArray(suggestions) || suggestions.length === 0) {
    return {
      issues: [],
      actions: [],
      executionPlan: []
    }
  }

  const editableDocuments = new Map(
    contextPack.documents
      .filter((document) => document.editable)
      .map((document) => [document.itemId, document] as const)
  )

  const issues: DesignInspectionProposal['issues'] = []
  const actions: DesignInspectionProposal['actions'] = []
  const executionPlan: DesignInspectionProposal['executionPlan'] = []

  for (const suggestion of suggestions) {
    if (
      !suggestion ||
      typeof suggestion.itemId !== 'string' ||
      typeof suggestion.content !== 'string'
    ) {
      continue
    }

    const targetDocument = editableDocuments.get(suggestion.itemId)
    if (!targetDocument) continue

    const nextContent = normalizeMultilineContent(suggestion.content)
    const currentContent = normalizeMultilineContent(targetDocument.previewText || '')
    if (!nextContent.trim() || nextContent === currentContent) continue

    const actionId = createDesignInspectionId('design-action')
    const issueId = createDesignInspectionId('design-issue')
    const fileLabel = targetDocument.fileName || suggestion.itemId

    actions.push({
      id: actionId,
      type: 'update-file-content',
      title:
        typeof suggestion.title === 'string' && suggestion.title.trim()
          ? suggestion.title.trim()
          : `Update editable content for ${fileLabel}`,
      description:
        typeof suggestion.description === 'string' && suggestion.description.trim()
          ? suggestion.description.trim()
          : 'Apply the approved content revision directly to the editable file node inside MagicPot.',
      executor: 'magicpot-internal',
      targetItemIds: [suggestion.itemId],
      payload: {
        content: nextContent
      },
      expectedImpact:
        typeof suggestion.expectedImpact === 'string' && suggestion.expectedImpact.trim()
          ? suggestion.expectedImpact.trim()
          : 'The editable file node will match the approved copy revision without leaving MagicPot.'
    })

    issues.push({
      id: issueId,
      category: 'content',
      severity: 'warning',
      title:
        typeof suggestion.title === 'string' && suggestion.title.trim()
          ? suggestion.title.trim()
          : `Update editable content for ${fileLabel}`,
      summary:
        typeof suggestion.summary === 'string' && suggestion.summary.trim()
          ? suggestion.summary.trim()
          : 'The agent provided a concrete content revision for an editable file node in the current selection.',
      itemIds: [suggestion.itemId],
      evidence:
        Array.isArray(suggestion.evidence) &&
        suggestion.evidence.every((entry) => typeof entry === 'string' && entry.trim())
          ? suggestion.evidence
          : [
              `${fileLabel}: editable ${targetDocument.editable ? 'yes' : 'no'}`,
              `Current preview length ${currentContent.length}; suggested content length ${nextContent.length}`
            ],
      actionIds: [actionId]
    })
  }

  executionPlan.push(
    ...actions.map((action, index) => ({
      step: index + 1,
      executor: action.executor,
      actionIds: [action.id],
      description: action.description
    }))
  )

  return {
    issues,
    actions,
    executionPlan
  }
}

function mergeDesignInspectionAgentResponse(
  contextPack: DesignInspectionContextPack,
  draftProposal: DesignInspectionProposal,
  rawResponse: string,
  userNotes?: string
): DesignInspectionProposal {
  const parsed = JSON.parse(stripCodeFences(rawResponse)) as DesignInspectionAgentResponse
  const mergedIssues = draftProposal.issues.map((issue) => {
    const candidate = parsed.issues?.find((entry) => entry.id === issue.id)
    return {
      ...issue,
      title: typeof candidate?.title === 'string' ? candidate.title : issue.title,
      summary: typeof candidate?.summary === 'string' ? candidate.summary : issue.summary,
      evidence:
        Array.isArray(candidate?.evidence) &&
        candidate.evidence.every((entry) => typeof entry === 'string')
          ? candidate.evidence
          : issue.evidence
    }
  })

  const mergedActions = draftProposal.actions.map((action) => {
    const candidate = parsed.actions?.find((entry) => entry.id === action.id)
    return {
      ...action,
      title: typeof candidate?.title === 'string' ? candidate.title : action.title,
      description:
        typeof candidate?.description === 'string' ? candidate.description : action.description,
      expectedImpact:
        typeof candidate?.expectedImpact === 'string'
          ? candidate.expectedImpact
          : action.expectedImpact
    }
  })

  const mergedExecutionPlan = draftProposal.executionPlan.map((step) => {
    const candidate = parsed.executionPlan?.find((entry) => entry.step === step.step)
    return {
      ...step,
      description:
        typeof candidate?.description === 'string' ? candidate.description : step.description
    }
  })

  const contentActionAdditions = buildAgentSuggestedContentActions(
    contextPack,
    parsed.contentActionSuggestions,
    shouldAllowAgentContentSuggestions(userNotes)
  )
  const mergedIssueList = [...mergedIssues, ...contentActionAdditions.issues]
  const mergedActionList = [...mergedActions, ...contentActionAdditions.actions]
  const mergedExecutionPlanList = [
    ...mergedExecutionPlan,
    ...contentActionAdditions.executionPlan.map((step, index) => ({
      ...step,
      step: mergedExecutionPlan.length + index + 1
    }))
  ]
  const fallbackSummary =
    mergedActionList.length > draftProposal.actions.length
      ? `Prepared ${mergedActionList.length} MagicPot internal action(s) requiring approval, including ${contentActionAdditions.actions.length} editable file content update(s).`
      : draftProposal.summary
  const fallbackRationale =
    mergedActionList.length > draftProposal.actions.length
      ? `${draftProposal.rationale} Only documents marked editable in the context accept file content suggestions, and execution still requires explicit user approval.`
      : draftProposal.rationale
  const fallbackExpectedResult =
    mergedActionList.length > draftProposal.actions.length
      ? 'After approval, the current selection will reflect both structure-first fixes and approved editable file content updates.'
      : draftProposal.expectedResult

  return {
    ...draftProposal,
    summary: typeof parsed.summary === 'string' ? parsed.summary : fallbackSummary,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : fallbackRationale,
    expectedResult:
      typeof parsed.expectedResult === 'string' ? parsed.expectedResult : fallbackExpectedResult,
    issues: mergedIssueList,
    actions: mergedActionList,
    executionPlan: mergedExecutionPlanList
  }
}

function buildAgentFallbackProposal(
  draftProposal: DesignInspectionProposal,
  reason: string
): DesignInspectionProposal {
  return {
    ...draftProposal,
    rationale: `${draftProposal.rationale} Agent copy fallback reason: ${reason}.`
  }
}

export async function requestDesignInspectionProposalFromAgent({
  contextPack,
  draftProposal,
  llmProxy,
  attachments,
  userNotes
}: RequestDesignInspectionProposalOptions): Promise<DesignInspectionProposal> {
  if (!llmProxy) {
    return buildAgentFallbackProposal(draftProposal, 'LLM proxy unavailable')
  }

  try {
    const profilesResponse = await llmProxy.listProfiles({})
    const selectedProfile =
      profilesResponse.profiles.find((profile) => profile.is_vision_model) ||
      profilesResponse.profiles[0]

    if (!selectedProfile) {
      return buildAgentFallbackProposal(draftProposal, 'No LLM profile is available')
    }

    const response = await llmProxy.chat({
      profileId: selectedProfile.id,
      messages: [
        {
          role: 'user',
          content: buildDesignInspectionAgentPrompt(contextPack, draftProposal, userNotes),
          attachments: attachments && attachments.length > 0 ? attachments : undefined
        }
      ]
    })

    if (!response?.content?.trim()) {
      return buildAgentFallbackProposal(draftProposal, 'Agent returned an empty response')
    }

    return mergeDesignInspectionAgentResponse(
      contextPack,
      draftProposal,
      response.content,
      userNotes
    )
  } catch (error) {
    return buildAgentFallbackProposal(
      draftProposal,
      error instanceof Error ? error.message : 'Unknown agent proposal error'
    )
  }
}
