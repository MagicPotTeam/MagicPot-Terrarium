import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  IconButton,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import {
  Add as AddIcon,
  DeleteOutline as DeleteOutlineIcon,
  ErrorOutline as ErrorOutlineIcon
} from '@mui/icons-material'
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type FocusEvent,
  type ReactNode
} from 'react'
import type { CanvasTargetReport, CanvasTargetReportStage } from '@shared/canvasTarget'
import type { ProjectTraceDocumentSummary } from '@shared/projectTrace'
import type { TargetHistoryEntry } from '@shared/targetHistory'
import type { TargetScheme } from '@shared/targetScheme'
import CanvasTargetHistoryDialog from './CanvasTargetHistoryDialog'
import {
  CANVAS_TARGET_AUXILIARY_INPUT_KINDS,
  CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS,
  applyCanvasTargetStageDraftProfileConstraints,
  createCanvasTargetQuickAppDraft,
  createCanvasTargetStageDraft,
  normalizeCanvasTargetStageDraft,
  resolveCanvasTargetSupportedOutputFormats,
  sanitizeCanvasTargetStageOutputFormats,
  type CanvasTargetAuxiliaryInputKind,
  type CanvasTargetAuxiliaryOutputFormat,
  type CanvasTargetQuickAppDraft,
  type CanvasTargetStageDraft
} from '../canvasTargetTypes'
import {
  CANVAS_TARGET_EVIDENCE_MODES,
  normalizeCanvasTargetEvidenceMode,
  type CanvasTargetEvidenceMode
} from '../canvasTargetEvidence'
import type { CanvasTargetQAppCapability } from '../canvasTargetCapabilityTypes'

type CanvasTargetProfileOption = {
  id: string
  label: string
  modelUse?: string
  isVisionModel?: boolean
  isOcrModel?: boolean
  sourceType?: 'api' | 'local'
  executionBackend?: 'llm' | 'local_model'
}

const EMPTY_STAGE_PROFILE = createCanvasTargetStageDraft()

type CanvasTargetDialogProps = {
  open: boolean
  isChineseUi: boolean
  loading: boolean
  error: string | null
  schemes: TargetScheme[]
  selectedSchemeId: string | null
  targetItemCount: number
  targetName: string
  userIntent: string
  controlProfileId: string
  stageProfiles: CanvasTargetStageDraft[]
  quickApps?: CanvasTargetQuickAppDraft[]
  profileOptions: CanvasTargetProfileOption[]
  controlProfileOptions?: CanvasTargetProfileOption[]
  quickAppOptions?: CanvasTargetQAppCapability[]
  historyTargets: TargetHistoryEntry[]
  selectedHistoryTargetId?: string | null
  traceDocuments?: ProjectTraceDocumentSummary[]
  selectedTraceIds?: string[]
  evidenceMode?: CanvasTargetEvidenceMode
  report: CanvasTargetReport | null
  onTargetNameChange: (value: string) => void
  onSelectedSchemeIdChange: (value: string) => void
  onUserIntentChange: (value: string) => void
  onControlProfileIdChange: (value: string) => void
  onStageProfilesChange: (value: CanvasTargetStageDraft[]) => void
  onQuickAppsChange?: (value: CanvasTargetQuickAppDraft[]) => void
  onApplyHistoryTarget: (targetId: string) => void
  onDeleteHistoryTarget: (targetId: string) => void
  onRenameHistoryTarget: (targetId: string, name: string) => void
  onSelectedTraceIdsChange?: (value: string[]) => void
  onEvidenceModeChange?: (value: CanvasTargetEvidenceMode) => void
  onOpenSchemeManager?: () => void
  onRun: () => void
  onCancelRun?: () => void
  onClose: () => void
}

function HoverHint({ ariaLabel, title }: { ariaLabel: string; title: ReactNode }) {
  return (
    <Tooltip title={title} arrow placement="top-start">
      <IconButton
        size="small"
        aria-label={ariaLabel}
        sx={{
          color: 'info.main',
          p: 0.25,
          '&:hover': {
            bgcolor: 'action.hover'
          }
        }}
      >
        <ErrorOutlineIcon sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  )
}

function ImeStableRuleTextField({
  label,
  value,
  onChange,
  placeholder,
  disabled
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled: boolean
}) {
  const [draftValue, setDraftValue] = useState(value)
  const isComposingRef = useRef(false)
  const latestDraftValueRef = useRef(draftValue)

  useEffect(() => {
    latestDraftValueRef.current = draftValue
  }, [draftValue])

  useEffect(() => {
    if (!isComposingRef.current && value !== latestDraftValueRef.current) {
      setDraftValue(value)
    }
  }, [value])

  const commitValue = (nextValue: string) => {
    if (nextValue !== value) {
      onChange(nextValue)
    }
  }

  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const nextValue = event.target.value
    const isNativeComposing = Boolean((event.nativeEvent as { isComposing?: boolean }).isComposing)
    setDraftValue(nextValue)

    if (isComposingRef.current || isNativeComposing) {
      return
    }

    commitValue(nextValue)
  }

  const handleCompositionStart = () => {
    isComposingRef.current = true
  }

  const handleCompositionEnd = (
    event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const nextValue = event.currentTarget.value
    isComposingRef.current = false
    setDraftValue(nextValue)
    commitValue(nextValue)
  }

  const handleBlur = (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!isComposingRef.current) {
      commitValue(event.currentTarget.value)
    }
  }

  return (
    <TextField
      label={label}
      value={draftValue}
      onChange={handleChange}
      placeholder={placeholder}
      disabled={disabled}
      fullWidth
      InputProps={{
        inputComponent: 'textarea',
        inputProps: {
          rows: 2,
          'data-ime-stable-textarea': 'true',
          onCompositionStart: handleCompositionStart,
          onCompositionEnd: handleCompositionEnd,
          onBlur: handleBlur
        }
      }}
      sx={{
        '& textarea.MuiInputBase-input': {
          minHeight: 48,
          resize: 'vertical'
        }
      }}
    />
  )
}

function StageDeleteButton({
  ariaLabel,
  disabled,
  onClick
}: {
  ariaLabel: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Tooltip title={ariaLabel}>
      <span>
        <IconButton
          size="small"
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={onClick}
          className="canvas-target-stage-delete-button"
          sx={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            zIndex: 2,
            opacity: disabled ? 0.35 : 1,
            transition: 'all .2s ease',
            color: disabled ? 'action.disabled' : 'error.main',
            '&:hover': disabled
              ? undefined
              : {
                  bgcolor: 'error.main',
                  color: '#fff'
                }
          }}
        >
          <DeleteOutlineIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </span>
    </Tooltip>
  )
}

const getSeverityColor = (severity: CanvasTargetReport['findings'][number]['severity']) => {
  if (severity === 'error') return 'error'
  if (severity === 'warning') return 'warning'
  return 'default'
}

const getStageStatusColor = (status: CanvasTargetReportStage['status']) =>
  status === 'success' ? 'success' : 'warning'

const getStageStatusLabel = (status: CanvasTargetReportStage['status'], isChineseUi: boolean) =>
  status === 'success'
    ? isChineseUi
      ? '\u5df2\u5b8c\u6210'
      : 'Completed'
    : isChineseUi
      ? '\u5df2\u56de\u9000'
      : 'Fallback'

const getReportStages = (
  report: CanvasTargetReport | null,
  isChineseUi: boolean
): CanvasTargetReportStage[] => {
  if (!report) return []
  if (Array.isArray(report.stages) && report.stages.length > 0) {
    return report.stages.filter(Boolean).map((stage) => ({
      ...stage,
      findings: Array.isArray(stage.findings) ? stage.findings : []
    }))
  }

  const findings = Array.isArray(report.findings) ? report.findings : []

  return [
    {
      id: 'legacy-canvas-target-stage',
      kind: 'default-vision',
      label: isChineseUi ? '\u76ee\u6807\u7ed3\u679c' : 'Target result',
      status: report.fallbackReason ? 'fallback' : 'success',
      modelId: report.modelId,
      summary: report.summary,
      overview: report.overview,
      findings,
      rawResponse: report.rawResponse,
      fallbackReason: report.fallbackReason
    }
  ]
}

const normalizeSchemes = (schemes: TargetScheme[] | undefined): TargetScheme[] =>
  Array.isArray(schemes) ? schemes.filter(Boolean) : []

const normalizeProfileOptions = (
  profileOptions: CanvasTargetProfileOption[] | undefined
): CanvasTargetProfileOption[] =>
  Array.isArray(profileOptions) ? profileOptions.filter(Boolean) : []

const normalizeQuickAppOptions = (
  options: CanvasTargetQAppCapability[] | undefined
): CanvasTargetQAppCapability[] => {
  if (!Array.isArray(options)) return []
  const seenKeys = new Set<string>()

  return options.filter((option) => {
    if (!option?.key || seenKeys.has(option.key)) return false
    seenKeys.add(option.key)
    return true
  })
}

const createCanvasTargetQuickAppUiDraft = (
  value: Partial<CanvasTargetQuickAppDraft> | null | undefined
): CanvasTargetQuickAppDraft => {
  const normalized = createCanvasTargetQuickAppDraft(value || {})

  return {
    ...normalized,
    mustFollow: typeof value?.mustFollow === 'string' ? value.mustFollow : normalized.mustFollow,
    forbiddenActions:
      typeof value?.forbiddenActions === 'string'
        ? value.forbiddenActions
        : normalized.forbiddenActions
  }
}

const normalizeQuickApps = (
  quickApps: CanvasTargetQuickAppDraft[] | undefined,
  quickAppOptions: CanvasTargetQAppCapability[]
): CanvasTargetQuickAppDraft[] => {
  if (!Array.isArray(quickApps) || quickApps.length === 0) return []
  const availableKeys = new Set(quickAppOptions.map((option) => option.key))
  const seenKeys = new Set<string>()

  return quickApps
    .filter(Boolean)
    .map((quickApp) => createCanvasTargetQuickAppUiDraft(quickApp))
    .filter((quickApp) => {
      if (
        !quickApp.qAppKey ||
        !availableKeys.has(quickApp.qAppKey) ||
        seenKeys.has(quickApp.qAppKey)
      ) {
        return false
      }
      seenKeys.add(quickApp.qAppKey)
      return true
    })
}

const normalizeHistoryTargets = (historyTargets: TargetHistoryEntry[] | undefined) =>
  Array.isArray(historyTargets) ? historyTargets.filter(Boolean) : []

const normalizeStageProfiles = (
  stageProfiles: CanvasTargetStageDraft[] | undefined
): CanvasTargetStageDraft[] => {
  if (!Array.isArray(stageProfiles) || stageProfiles.length === 0) {
    return []
  }

  const normalized = stageProfiles
    .filter(Boolean)
    .map((stageProfile) => normalizeCanvasTargetStageDraft(stageProfile))

  return normalized
}

const getSchemeFileCount = (scheme: TargetScheme | null | undefined): number =>
  Array.isArray(scheme?.files) ? scheme.files.length : 0

const hasProfileOption = (
  profileOptions: CanvasTargetProfileOption[],
  profileId: string | null | undefined
): boolean => profileOptions.some((profile) => profile.id === profileId)

const findProfileLabel = (profiles: CanvasTargetProfileOption[], profileId?: string | null) =>
  profiles.find((profile) => profile.id === profileId)?.label || profileId || ''

const findProfileOption = (
  profiles: CanvasTargetProfileOption[],
  profileId?: string | null
): CanvasTargetProfileOption | undefined => profiles.find((profile) => profile.id === profileId)

function summarizeTraceExecutableRules(trace: ProjectTraceDocumentSummary): string {
  const rules = trace.executableRules?.rules || []
  const semanticRules = trace.executableRules?.semanticRules || []
  if (rules.length === 0 && semanticRules.length === 0) return ''
  const softwareSummary = rules
    .slice(0, 2)
    .map(
      (rule) =>
        `${rule.type} ${rule.condition.operator} ${rule.condition.value}${rule.condition.unit}`
    )
    .join(' | ')
  const semanticSummary = semanticRules.length > 0 ? `${semanticRules.length} semantic` : ''
  return [softwareSummary, semanticSummary].filter(Boolean).join(' | ')
}

const getStageSourceLabel = (
  stage: CanvasTargetReportStage,
  profiles: CanvasTargetProfileOption[],
  isChineseUi: boolean
) => {
  const profileLabel = findProfileLabel(profiles, stage.modelId)
  if (profileLabel) {
    return profileLabel
  }

  return isChineseUi ? 'MagicPot 内置能力' : 'MagicPot built-in capability'
}

export default function CanvasTargetDialog({
  open,
  isChineseUi,
  loading,
  error,
  schemes,
  selectedSchemeId,
  targetItemCount,
  targetName,
  userIntent,
  controlProfileId,
  stageProfiles,
  quickApps,
  profileOptions,
  controlProfileOptions,
  quickAppOptions,
  historyTargets,
  selectedHistoryTargetId,
  traceDocuments,
  selectedTraceIds,
  evidenceMode,
  report,
  onTargetNameChange,
  onSelectedSchemeIdChange,
  onUserIntentChange,
  onControlProfileIdChange,
  onStageProfilesChange,
  onQuickAppsChange,
  onApplyHistoryTarget,
  onDeleteHistoryTarget,
  onRenameHistoryTarget,
  onSelectedTraceIdsChange,
  onEvidenceModeChange,
  onOpenSchemeManager,
  onRun,
  onCancelRun,
  onClose
}: CanvasTargetDialogProps) {
  const normalizedSchemes = normalizeSchemes(schemes)
  const normalizedHistoryTargets = normalizeHistoryTargets(historyTargets)
  const normalizedTraceDocuments = Array.isArray(traceDocuments)
    ? traceDocuments.filter(Boolean)
    : []
  const normalizedSelectedTraceIds = Array.isArray(selectedTraceIds)
    ? Array.from(new Set(selectedTraceIds.filter(Boolean)))
    : []
  const normalizedStageProfiles = normalizeStageProfiles(stageProfiles)
  const normalizedProfileOptions = normalizeProfileOptions(profileOptions)
  const normalizedQuickAppOptions = normalizeQuickAppOptions(quickAppOptions)
  const normalizedQuickApps = normalizeQuickApps(quickApps, normalizedQuickAppOptions)
  const normalizedControlProfileOptions = normalizeProfileOptions(
    controlProfileOptions && controlProfileOptions.length > 0
      ? controlProfileOptions
      : normalizedProfileOptions.filter((profile) => profile.executionBackend !== 'local_model')
  )
  const constrainedStageProfiles = normalizedStageProfiles.map((stageProfile) =>
    applyCanvasTargetStageDraftProfileConstraints(
      stageProfile,
      findProfileOption(normalizedProfileOptions, stageProfile.profileId)
    )
  )
  const reportFindings = Array.isArray(report?.findings) ? report.findings : []
  const enabledSchemes = normalizedSchemes.filter((scheme) => scheme.enabled)
  const selectedScheme =
    enabledSchemes.find((scheme) => scheme.id === selectedSchemeId) || enabledSchemes[0] || null
  const resolvedControlProfileId = hasProfileOption(
    normalizedControlProfileOptions,
    controlProfileId
  )
    ? controlProfileId
    : ''
  const validStageProfiles = constrainedStageProfiles.filter((stageProfile) =>
    hasProfileOption(normalizedProfileOptions, stageProfile.profileId)
  )
  const stages = getReportStages(report, isChineseUi)
  const copy = isChineseUi
    ? {
        title: '\u76ee\u6807\u9009\u533a',
        targetName: '\u76ee\u6807\u540d',
        targetNamePlaceholder: '\u4f8b\u5982\uff1a\u753b\u9762\u4fe1\u606f\u5c42\u7ea7\u5ba1\u9605',
        historyTargets: '\u5386\u53f2\u76ee\u6807',
        targetSummary: `${targetItemCount} \u4e2a\u753b\u5e03\u5143\u7d20\u5df2\u7eb3\u5165\u672c\u6b21\u6267\u884c\u3002\u9644\u5c5e\u6a21\u578b\u4f1a\u5728\u4e3b\u63a7\u6a21\u578b\u7f16\u6392\u4e0b\u8bfb\u53d6\u7ed3\u6784\u5316\u753b\u5e03\u6570\u636e\uff0c\u622a\u56fe\u4ec5\u4f5c\u4e3a\u8f85\u52a9\u53c2\u8003\u3002`,
        controlModelHint:
          '\u5efa\u8bae\u4e3b\u63a7\u6a21\u578b\u9009\u62e9\u591a\u6a21\u6001\u6a21\u578b\u3002',
        checkSchemeHintAria: '\u67e5\u770b\u76ee\u6807\u65b9\u6848\u8bf4\u660e',
        controlModelHintAria: '\u67e5\u770b\u4e3b\u63a7\u6a21\u578b\u63d0\u793a',
        evidenceModeHintAria: '查看增强执行准确性说明',
        evidenceModeTitle: '增强执行准确性',
        evidenceModeHint:
          '档位越高，主控模型和附属模型可读取的选区视觉证据越完整，执行更稳，但会增加 token 消耗和发送的数据量。',
        evidenceModeHelper:
          '默认按软件层目标框选区域裁图；需要识别完整素材语义时再提升到完整源素材。',
        evidenceModeOptions: {
          structured_only: {
            title: '严格隐私',
            cost: '低消耗',
            description: '仅发送结构化画布数据和脱敏回执，不发送图片证据。'
          },
          selection_region: {
            title: '选区证据',
            cost: '推荐',
            description: '发送目标框选区域裁图和结构化数据，框外内容不作为视觉附件发送。'
          },
          selected_sources: {
            title: '完整源素材',
            cost: '高精度',
            description: '发送选区裁图，并附加被选中元素的原始素材；token 与数据量最高。'
          }
        },
        checkScheme: '\u76ee\u6807\u65b9\u6848',
        openWorkshop: '\u524d\u5f80\u5de5\u574a',
        noScheme:
          '\u5f53\u524d\u8fd8\u6ca1\u6709\u542f\u7528\u7684\u76ee\u6807\u65b9\u6848\uff0c\u8bf7\u5148\u5230\u81ea\u5b9a\u4e49\u5de5\u574a\u521b\u5efa\u5e76\u542f\u7528\u3002',
        noDescription: '\u6682\u65e0\u8bf4\u660e\u3002',
        schemeFiles: '\u4efd\u65b9\u6848\u6587\u4ef6',
        traceReferences: '\u8ffd\u8e2a\u5f15\u7528',
        traceReferencesHint:
          '\u53ef\u591a\u9009\u9879\u76ee\u4e0b\u5df2\u521b\u5efa\u7684\u8ffd\u8e2a\u6587\u6863\u3002\u8fd9\u4e9b\u6587\u6863\u53ea\u4f5c\u4e3a\u7ecf\u8fc7\u8131\u654f\u7684\u5386\u53f2\u5de5\u4f5c\u6d41\u53c2\u8003\uff0c\u4e0d\u4f1a\u5199\u5165\u5168\u5c40\u76ee\u6807\u65b9\u6848\u3002',
        noTraceReferences:
          '\u5f53\u524d\u9879\u76ee\u8fd8\u6ca1\u6709\u5df2\u4fdd\u5b58\u4e14\u53ef\u5f15\u7528\u7684\u8ffd\u8e2a\u8bb0\u5f55\u3002\u8bf7\u5728\u8ffd\u8e2a\u9762\u677f\u4e3b\u52a8\u521b\u5efa\u5e76\u4fdd\u5b58\u3002',
        traceEvents: '\u4e2a\u4e8b\u4ef6',
        controlModelLabel: '\u4e3b\u63a7\u6a21\u578b',
        controlModelSource: '\u6a21\u578b\u6765\u6e90',
        stageOrder: '\u9644\u5c5e\u6a21\u578b',
        stageModel: '\u9644\u5c5e\u6a21\u578b',
        stageHint:
          '\u4e3b\u63a7\u6a21\u578b\u4f1a\u6839\u636e\u7528\u6237\u63cf\u8ff0\uff0c\u7ed3\u5408\u6bcf\u4e2a\u9644\u5c5e\u6a21\u578b\u5fc5\u987b\u9075\u5b88\u7684\u89c4\u5219\u3001\u7981\u6b62\u4e8b\u9879\u3001\u5141\u8bb8\u8f93\u5165\u548c\u989d\u5916\u589e\u52a0\u8f93\u51fa\u683c\u5f0f\uff0c\u5224\u65ad\u5404\u9636\u6bb5\u5e94\u627f\u62c5\u7684\u804c\u8d23\u4e0e\u6267\u884c\u987a\u5e8f\u3002\u7cfb\u7edf\u4f1a\u5148\u4fdd\u7559\u6a21\u578b\u5b8c\u6574\u539f\u59cb\u8f93\u51fa\uff0c\u518d\u5c3d\u91cf\u6574\u7406\u6210\u6240\u9009\u7684\u989d\u5916\u683c\u5f0f\u3002',
        stageMustFollow: '\u5fc5\u987b\u9075\u5b88',
        stageMustFollowPlaceholder:
          '\u4f8b\u5982\uff1a\u53ea\u62bd\u53d6\u6807\u9898\u3001\u6309\u94ae\u3001\u8868\u683c\u4e2d\u7684\u53ef\u89c1\u6587\u672c\uff0c\u4fdd\u6301\u539f\u6587\u4e0d\u6539\u5199\u3002',
        stageForbiddenActions: '\u7981\u6b62\u4e8b\u9879',
        stageForbiddenActionsPlaceholder:
          '\u4f8b\u5982\uff1a\u4e0d\u8981\u8f93\u51fa\u6700\u7ec8\u7ed3\u8bba\uff0c\u4e0d\u8981\u81ea\u884c\u8865\u5145\u672a\u51fa\u73b0\u7684\u5185\u5bb9\u3002',
        stageAllowedInputs: '\u5141\u8bb8\u8f93\u5165\u6765\u6e90',
        stageAllowedInputsHint:
          '\u7ed3\u6784\u5316\u753b\u5e03\u4e0a\u4e0b\u6587\u59cb\u7ec8\u4f1a\u63d0\u4f9b\u7ed9\u9644\u5c5e\u6a21\u578b\uff0c\u8fd9\u91cc\u63a7\u5236\u5176\u4ed6\u53ef\u8ffd\u52a0\u8f93\u5165\u3002',
        localVisualRestriction:
          '\u8fd9\u7c7b\u672c\u5730\u6a21\u578b\u540e\u7aef\u53ef\u4f5c\u4e3a\u7528\u6237\u663e\u5f0f\u9009\u62e9\u7684\u9644\u5c5e\u6267\u884c\u5355\u5143\uff0c\u5f53\u524d\u5185\u7f6e\u5b9e\u73b0\u4f7f\u7528 duplicateCheck.runVisualAnalysis\uff1b\u5b83\u4e0d\u4f5c\u4e3a\u4e3b\u63a7\u8bed\u4e49\u89c4\u5212\u6a21\u578b\u3002',
        stageOutputFormat: '\u589e\u52a0\u8f93\u51fa\u683c\u5f0f',
        stageOutputFormatHint:
          '\u53ef\u591a\u9009\u3002\u7cfb\u7edf\u4f1a\u6839\u636e\u9009\u62e9\u7684\u683c\u5f0f\uff0c\u5728\u4fdd\u7559\u6a21\u578b\u5b8c\u6574\u539f\u59cb\u8f93\u51fa\u7684\u57fa\u7840\u4e0a\uff0c\u5c3d\u91cf\u6574\u7406\u540e\u518d\u8f93\u51fa\u8fd9\u4e9b\u989d\u5916\u683c\u5f0f\u3002\u8bf7\u6ce8\u610f\uff0c\u82e5\u4e3b\u63a7\u6a21\u578b\u4e0d\u652f\u6301\uff0c\u5219\u53ef\u80fd\u65e0\u6cd5\u8f93\u51fa\u989d\u5916\u589e\u52a0\u7684\u683c\u5f0f\u7c7b\u578b\u3002',
        autoOutputFormat: '\u4e0d\u989d\u5916\u589e\u52a0',
        deleteModel: '\u5220\u9664\u9644\u5c5e\u6a21\u578b',
        deleteModelConfirmTitle: '\u786e\u8ba4\u5220\u9664\u9644\u5c5e\u6a21\u578b',
        deleteModelConfirmDescription:
          '\u5220\u9664\u540e\u65e0\u6cd5\u6062\u590d\uff0c\u8bf7\u786e\u8ba4\u662f\u5426\u7ee7\u7eed\u3002',
        deleteAction: '\u5220\u9664',
        addModel: '\u6dfb\u52a0\u9644\u5c5e\u6a21\u578b',
        quickAppOrder: '\u9644\u5c5e\u5feb\u5e94\u7528',
        quickAppHint:
          '\u4e3b\u63a7\u6a21\u578b\u53ea\u80fd\u8c03\u7528\u8fd9\u91cc\u9009\u4e2d\u7684\u5feb\u5e94\u7528\uff1b\u672a\u9009\u62e9\u5219\u672c\u6b21\u76ee\u6807\u4e0d\u4f7f\u7528\u5feb\u5e94\u7528\u3002\u7528\u9014\u7531\u4f60\u5199\u7684\u9075\u5b88/\u7981\u6b62\u4e8b\u9879\u548c\u4e3b\u63a7\u6a21\u578b\u5224\u65ad\u51b3\u5b9a\u3002',
        quickApp: '\u9644\u5c5e\u5feb\u5e94\u7528',
        quickAppMustFollow: '\u5feb\u5e94\u7528\u5fc5\u987b\u9075\u5b88',
        quickAppMustFollowPlaceholder:
          '\u4f8b\u5982\uff1a\u4ec5\u7528\u4e8e\u7528\u6237\u8981\u6c42\u7684\u56fe\u50cf\u5904\u7406\uff0c\u4e0d\u6539\u5199\u76ee\u6807\u8bed\u4e49\u3002',
        quickAppForbiddenActions: '\u5feb\u5e94\u7528\u7981\u6b62\u4e8b\u9879',
        quickAppForbiddenActionsPlaceholder:
          '\u4f8b\u5982\uff1a\u4e0d\u8981\u5904\u7406\u672a\u88ab\u9009\u4e2d\u6216\u672a\u88ab\u4e3b\u63a7\u6a21\u578b\u5206\u914d\u7684\u7d20\u6750\u3002',
        addQuickApp: '\u6dfb\u52a0\u9644\u5c5e\u5feb\u5e94\u7528',
        deleteQuickApp: '\u5220\u9664\u9644\u5c5e\u5feb\u5e94\u7528',
        noQuickApps:
          '\u5f53\u524d\u6ca1\u6709\u53ef\u9009\u5feb\u5e94\u7528\uff0c\u672c\u6b21\u76ee\u6807\u5c06\u4e0d\u5411\u4e3b\u63a7\u6a21\u578b\u63d0\u4f9b\u5feb\u5e94\u7528\u80fd\u529b\u3002',
        allowedInputLabels: {
          source_assets: '\u539f\u59cb\u9009\u533a\u8d44\u6e90',
          selection_snapshot: '\u9009\u533a\u622a\u56fe',
          scheme_files: '\u65b9\u6848\u6587\u4ef6',
          scheme_images: '\u65b9\u6848\u56fe\u7247',
          upstream_results: '\u4e0a\u6e38\u9636\u6bb5\u7ed3\u679c'
        },
        outputFormatLabels: {
          plain_text: '\u7eaf\u6587\u672c',
          markdown: 'Markdown',
          json: 'JSON',
          table: '\u8868\u683c',
          image: '\u56fe\u7247',
          video: '\u89c6\u9891',
          model3d: '3D'
        },
        userIntent: '\u672c\u6b21\u6267\u884c\u5185\u5bb9',
        userIntentPlaceholder:
          '\u6a21\u677f\uff1a\n\u76ee\u6807\uff1a\u9700\u8981\u5b8c\u6210\u4ec0\u4e48\u76ee\u6807\n\u8f93\u5165\u91cd\u70b9\uff1a\u4f18\u5148\u53c2\u8003\u54ea\u4e9b\u9009\u533a\u5143\u7d20/\u89c4\u5219\u6587\u4ef6/\u53c2\u8003\u56fe\n\u989d\u5916\u589e\u52a0\u8f93\u51fa\u683c\u5f0f\uff1a\u5e0c\u671b\u5728\u4fdd\u7559\u539f\u59cb\u8f93\u51fa\u540e\uff0c\u518d\u989d\u5916\u6574\u7406\u6210\u4ec0\u4e48\u683c\u5f0f\n\u7ea6\u675f\u6761\u4ef6\uff1a\u9700\u8981\u5ffd\u7565\u6216\u5f31\u5316\u4ec0\u4e48\n\n\u4f8b\u5982\uff1a\n\u76ee\u6807\uff1a\u751f\u6210\u4e00\u7248\u753b\u9762\u4fe1\u606f\u5c42\u7ea7\u5ba1\u9605\u76ee\u6807\n\u8f93\u5165\u91cd\u70b9\uff1a\u4e3b\u6807\u9898\u3001\u5356\u70b9\u6587\u6848\u3001\u89d2\u8272\u4e3b\u4f53\u3001\u89c4\u5219\u6587\u4ef6\n\u989d\u5916\u589e\u52a0\u8f93\u51fa\u683c\u5f0f\uff1a\u95ee\u9898\u6e05\u5355 + \u4fee\u6539\u52a8\u4f5c + \u6700\u7ec8\u5efa\u8bae\n\u7ea6\u675f\u6761\u4ef6\uff1a\u5f31\u5316\u80cc\u666f\u88c5\u9970\uff0c\u53ea\u5173\u6ce8\u4e3b\u4f53\u533a\u57df',
        progress: '\u6267\u884c\u8fdb\u5ea6',
        stages: '\u4e2a\u9636\u6bb5',
        findings: '\u6761\u7ed3\u679c',
        controlModelChip: '\u4e3b\u63a7\u6a21\u578b',
        stageSource: '\u6765\u6e90',
        fallbackReason: '\u56de\u9000\u539f\u56e0',
        findingSource: '\u6765\u6e90',
        cancel: '\u53d6\u6d88',
        cancelRun: '\u53d6\u6d88\u6267\u884c',
        start: '\u5f00\u59cb\u6267\u884c',
        apiSource: 'API',
        localSource: '\u672c\u5730'
      }
    : {
        title: 'Run Target on Selected Region',
        targetName: 'Target name',
        targetNamePlaceholder: 'For example: Visual hierarchy audit',
        historyTargets: 'Target history',
        targetSummary: `${targetItemCount} canvas items are included in this run. Auxiliary models will work under the control model and read the structured canvas payload, while the screenshot stays as a supporting reference.`,
        controlModelHint: 'A multimodal model is recommended for the control model.',
        checkSchemeHintAria: 'Show target scheme details',
        controlModelHintAria: 'Show control model guidance',
        evidenceModeHintAria: 'Show execution accuracy guidance',
        evidenceModeTitle: 'Enhance execution accuracy',
        evidenceModeHint:
          'Higher modes give the control and auxiliary models more visual evidence from the selected target. Accuracy improves, but token usage and transmitted data increase.',
        evidenceModeHelper:
          'Default mode crops the software target selection. Use full source assets only when the task needs complete selected-item semantics.',
        evidenceModeOptions: {
          structured_only: {
            title: 'Strict privacy',
            cost: 'Low cost',
            description: 'Only structured canvas data and redacted receipts; no visual evidence.'
          },
          selection_region: {
            title: 'Selection evidence',
            cost: 'Recommended',
            description:
              'Sends the target selection crop plus structured data; outside content is not sent as a visual attachment.'
          },
          selected_sources: {
            title: 'Full source assets',
            cost: 'High accuracy',
            description:
              'Sends the selection crop and original assets for selected items; highest token and data cost.'
          }
        },
        checkScheme: 'Target scheme',
        openWorkshop: 'Open workshop',
        noScheme:
          'No enabled target scheme is available yet. Create one in the custom target workshop first.',
        noDescription: 'No description yet.',
        schemeFiles: 'scheme files',
        traceReferences: 'Trace references',
        traceReferencesHint:
          'Select one or more project trace documents. They are redacted historical workflow references and are not written into the global target scheme.',
        noTraceReferences:
          'No saved reference-ready trace records exist in this project yet. Create and save one from the Trace panel first.',
        traceEvents: 'events',
        controlModelLabel: 'Control model',
        controlModelSource: 'Model source',
        stageOrder: 'Auxiliary models',
        stageModel: 'Auxiliary model',
        stageHint:
          'The control model decides how to use each auxiliary model from the user intent together with the must-follow rules, forbidden actions, allowed inputs, and any additional requested output formats. The software only registers returned outputs and exposes them as explicit artifacts for later tool calls.',
        stageMustFollow: 'Must follow',
        stageMustFollowPlaceholder:
          'Example: only extract visible text from titles, buttons, and tables, while preserving original wording.',
        stageForbiddenActions: 'Forbidden actions',
        stageForbiddenActionsPlaceholder:
          'Example: do not make final conclusions and do not invent content that is not present in the source.',
        stageAllowedInputs: 'Allowed input sources',
        stageAllowedInputsHint:
          'The structured canvas payload is always available. These toggles control the extra inputs that this auxiliary model may read.',
        localVisualRestriction:
          'This local model backend is available as an explicitly selected auxiliary execution unit. The current built-in implementation uses duplicateCheck.runVisualAnalysis, and it is not a control planner.',
        stageOutputFormat: 'Additional output formats',
        stageOutputFormatHint:
          'Multi-select is supported. These are explicit stage deliverable requests for the control model. The software records returned artifacts and can only validate whether the requested artifact type was actually returned.',
        autoOutputFormat: 'None',
        deleteModel: 'Delete auxiliary model',
        deleteModelConfirmTitle: 'Confirm auxiliary model deletion',
        deleteModelConfirmDescription:
          'Deleting this auxiliary model cannot be undone. Please confirm to continue.',
        deleteAction: 'Delete',
        addModel: 'Add auxiliary model',
        quickAppOrder: 'Auxiliary QuickApps',
        quickAppHint:
          'The control model can only call QuickApps selected here. If none are selected, this target run cannot use QuickApps. Their purpose is decided by your must-follow/forbidden rules and the control model.',
        quickApp: 'Auxiliary QuickApp',
        quickAppMustFollow: 'QuickApp must follow',
        quickAppMustFollowPlaceholder:
          'Example: only use this for the image processing requested by the user; do not rewrite the target semantics.',
        quickAppForbiddenActions: 'QuickApp forbidden actions',
        quickAppForbiddenActionsPlaceholder:
          'Example: do not process assets that were not selected or assigned by the control model.',
        addQuickApp: 'Add auxiliary QuickApp',
        deleteQuickApp: 'Delete auxiliary QuickApp',
        noQuickApps:
          'No QuickApps are available. This target run will not expose QuickApp capabilities to the control model.',
        allowedInputLabels: {
          source_assets: 'Original source assets',
          selection_snapshot: 'Selection snapshot',
          scheme_files: 'Scheme files',
          scheme_images: 'Scheme images',
          upstream_results: 'Upstream stage results'
        },
        outputFormatLabels: {
          plain_text: 'Plain text',
          markdown: 'Markdown',
          json: 'JSON',
          table: 'Table',
          image: 'Image',
          video: 'Video',
          model3d: '3D'
        },
        userIntent: 'What should this target run focus on?',
        userIntentPlaceholder:
          'Template:\nGoal: what this target should do\nKey inputs: which selected elements, rule files, or references to prioritize\nAdditional output formats: what concrete deliverables the control model should request\nConstraints: what to ignore or de-emphasize\n\nExample:\nGoal: create a target for reviewing visual information hierarchy\nKey inputs: main title, selling points, character subject, rule files\nAdditional output formats: issue list + action items + final recommendation\nConstraints: de-emphasize decorative background and focus on the primary content area',
        progress: 'Progress',
        stages: 'stages',
        findings: 'findings',
        controlModelChip: 'Control model',
        stageSource: 'Source',
        fallbackReason: 'Fallback reason',
        findingSource: 'From',
        cancel: 'Cancel',
        cancelRun: 'Cancel target',
        start: 'Start target',
        apiSource: 'API',
        localSource: 'Local'
      }

  const allowedInputOptions = CANVAS_TARGET_AUXILIARY_INPUT_KINDS.map((value) => ({
    value,
    label: copy.allowedInputLabels[value]
  }))
  const outputFormatOptions = CANVAS_TARGET_AUXILIARY_OUTPUT_FORMATS.map((value) => ({
    value,
    label: copy.outputFormatLabels[value]
  }))
  const resolvedEvidenceMode = normalizeCanvasTargetEvidenceMode(evidenceMode)
  const evidenceModeOptions = CANVAS_TARGET_EVIDENCE_MODES.map((value) => ({
    value,
    ...copy.evidenceModeOptions[value]
  }))
  const selectedEvidenceModeOption =
    evidenceModeOptions.find((option) => option.value === resolvedEvidenceMode) ||
    evidenceModeOptions[0]
  const evidenceModeDisabled = loading || !onEvidenceModeChange
  const [pendingStageDeleteIndex, setPendingStageDeleteIndex] = useState<number | null>(null)
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false)
  const formatStageOutputFormatLabels = (
    values: CanvasTargetAuxiliaryOutputFormat[] | undefined
  ): string => {
    const normalizedValues = Array.isArray(values) ? values.filter(Boolean) : []
    if (normalizedValues.length === 0) {
      return copy.autoOutputFormat
    }

    return normalizedValues
      .map((value) => copy.outputFormatLabels[value] || value)
      .join(isChineseUi ? '、' : ', ')
  }

  useEffect(() => {
    if (!open) {
      setPendingStageDeleteIndex(null)
      setHistoryDialogOpen(false)
    }
  }, [open])

  const updateStageProfile = (index: number, patch: Partial<CanvasTargetStageDraft>) => {
    const next = [...constrainedStageProfiles]
    const merged = createCanvasTargetStageDraft({
      ...next[index],
      ...patch
    })
    next[index] = applyCanvasTargetStageDraftProfileConstraints(
      merged,
      findProfileOption(normalizedProfileOptions, merged.profileId)
    )
    onStageProfilesChange(next)
  }

  const getSupportedOutputFormatsForProfile = (profileId?: string) => {
    const profile = findProfileOption(normalizedProfileOptions, profileId)
    return resolveCanvasTargetSupportedOutputFormats({
      profileId,
      profileLabel: profile?.label,
      modelUse: profile?.modelUse,
      isVisionModel: profile?.isVisionModel,
      isOcrModel: profile?.isOcrModel,
      executionBackend: profile?.executionBackend
    })
  }

  const removeStageProfile = (index: number) => {
    const next = constrainedStageProfiles.filter((_, currentIndex) => currentIndex !== index)
    onStageProfilesChange(next)
  }

  const requestStageProfileRemoval = (index: number) => {
    if (loading || !constrainedStageProfiles[index]) {
      return
    }
    setPendingStageDeleteIndex(index)
  }

  const handleCloseStageDeleteDialog = () => {
    setPendingStageDeleteIndex(null)
  }

  const handleConfirmStageDelete = () => {
    if (pendingStageDeleteIndex === null) {
      return
    }
    removeStageProfile(pendingStageDeleteIndex)
    setPendingStageDeleteIndex(null)
  }

  const appendStageProfile = () => {
    const fallbackProfileId =
      validStageProfiles[validStageProfiles.length - 1]?.profileId || resolvedControlProfileId || ''
    const fallbackProfile = findProfileOption(normalizedProfileOptions, fallbackProfileId)
    onStageProfilesChange([
      ...constrainedStageProfiles,
      applyCanvasTargetStageDraftProfileConstraints(
        createCanvasTargetStageDraft({
          profileId: fallbackProfileId
        }),
        fallbackProfile
      )
    ])
  }

  const updateQuickApp = (index: number, patch: Partial<CanvasTargetQuickAppDraft>) => {
    if (!onQuickAppsChange) return
    const next = [...normalizedQuickApps]
    next[index] = createCanvasTargetQuickAppUiDraft({
      ...next[index],
      ...patch
    })
    onQuickAppsChange(next)
  }

  const appendQuickApp = () => {
    if (!onQuickAppsChange || normalizedQuickAppOptions.length === 0) return
    const selectedKeys = new Set(normalizedQuickApps.map((quickApp) => quickApp.qAppKey))
    const nextOption =
      normalizedQuickAppOptions.find((option) => !selectedKeys.has(option.key)) ||
      normalizedQuickAppOptions[0]
    if (!nextOption) return
    onQuickAppsChange([
      ...normalizedQuickApps,
      createCanvasTargetQuickAppDraft({ qAppKey: nextOption.key })
    ])
  }

  const removeQuickApp = (index: number) => {
    if (!onQuickAppsChange) return
    onQuickAppsChange(normalizedQuickApps.filter((_, currentIndex) => currentIndex !== index))
  }

  const toggleStageAllowedInput = (index: number, inputKind: CanvasTargetAuxiliaryInputKind) => {
    const stageProfile = constrainedStageProfiles[index] || EMPTY_STAGE_PROFILE
    const nextAllowedInputs = stageProfile.allowedInputs.includes(inputKind)
      ? stageProfile.allowedInputs.filter((entry) => entry !== inputKind)
      : [...stageProfile.allowedInputs, inputKind]

    updateStageProfile(index, { allowedInputs: nextAllowedInputs })
  }

  const handleStageProfileModelChange = (index: number, profileId: string) => {
    const stageProfile = constrainedStageProfiles[index] || EMPTY_STAGE_PROFILE
    updateStageProfile(
      index,
      applyCanvasTargetStageDraftProfileConstraints(
        {
          ...stageProfile,
          profileId,
          outputFormats: sanitizeCanvasTargetStageOutputFormats(
            stageProfile.outputFormats,
            getSupportedOutputFormatsForProfile(profileId)
          )
        },
        findProfileOption(normalizedProfileOptions, profileId)
      )
    )
  }

  const handleStageOutputFormatsChange = (index: number, value: unknown) => {
    const stageProfile = constrainedStageProfiles[index] || EMPTY_STAGE_PROFILE
    const requestedOutputFormats = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : []
    const supportedOutputFormats = getSupportedOutputFormatsForProfile(stageProfile.profileId)

    updateStageProfile(index, {
      outputFormats: sanitizeCanvasTargetStageOutputFormats(
        requestedOutputFormats as CanvasTargetStageDraft['outputFormats'],
        supportedOutputFormats
      )
    })
  }

  const toggleTraceReference = (traceId: string) => {
    if (!onSelectedTraceIdsChange || loading) return
    const nextTraceIds = normalizedSelectedTraceIds.includes(traceId)
      ? normalizedSelectedTraceIds.filter((entry) => entry !== traceId)
      : [...normalizedSelectedTraceIds, traceId]
    onSelectedTraceIdsChange(nextTraceIds)
  }

  const handleEvidenceModeChange = (_event: unknown, nextMode: CanvasTargetEvidenceMode | null) => {
    if (!nextMode || loading || !onEvidenceModeChange) return
    onEvidenceModeChange(nextMode)
  }

  const pendingStageDeleteProfile =
    pendingStageDeleteIndex !== null
      ? constrainedStageProfiles[pendingStageDeleteIndex] || null
      : null
  const pendingStageDeleteLabel =
    pendingStageDeleteIndex !== null ? `${copy.stageModel} ${pendingStageDeleteIndex + 1}` : ''
  const pendingStageDeleteProfileLabel = pendingStageDeleteProfile?.profileId
    ? findProfileLabel(normalizedProfileOptions, pendingStageDeleteProfile.profileId)
    : ''
  const pendingStageDeleteSummary = pendingStageDeleteLabel
    ? pendingStageDeleteProfileLabel
      ? `${pendingStageDeleteLabel} (${pendingStageDeleteProfileLabel})`
      : pendingStageDeleteLabel
    : ''

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
            fontWeight: 700
          }}
        >
          <span>{copy.title}</span>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setHistoryDialogOpen(true)}
            disabled={loading}
          >
            {copy.historyTargets}
          </Button>
        </DialogTitle>

        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {loading && <LinearProgress />}

          <Typography variant="body2" color="text.secondary">
            {copy.targetSummary}
          </Typography>

          <TextField
            label={copy.targetName}
            value={targetName}
            onChange={(event) => onTargetNameChange(event.target.value)}
            placeholder={copy.targetNamePlaceholder}
            disabled={loading}
            fullWidth
          />

          {enabledSchemes.length > 0 ? (
            <Stack spacing={0.75}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {copy.checkScheme}
                </Typography>
                {selectedScheme ? (
                  <HoverHint
                    ariaLabel={copy.checkSchemeHintAria}
                    title={
                      <Box sx={{ maxWidth: 320 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                          {selectedScheme.name}
                        </Typography>
                        <Typography variant="body2" sx={{ mt: 0.5 }}>
                          {selectedScheme.description || copy.noDescription}
                        </Typography>
                        <Typography variant="caption" sx={{ display: 'block', mt: 0.75 }}>
                          {getSchemeFileCount(selectedScheme)} {copy.schemeFiles}
                        </Typography>
                      </Box>
                    }
                  />
                ) : null}
              </Box>

              <TextField
                select
                value={selectedScheme?.id || ''}
                onChange={(event) => onSelectedSchemeIdChange(event.target.value)}
                fullWidth
                disabled={loading}
              >
                {enabledSchemes.map((scheme) => (
                  <MenuItem key={scheme.id} value={scheme.id}>
                    {scheme.name}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          ) : (
            <Alert
              severity="warning"
              action={
                onOpenSchemeManager ? (
                  <Button color="inherit" size="small" onClick={onOpenSchemeManager}>
                    {copy.openWorkshop}
                  </Button>
                ) : undefined
              }
            >
              {copy.noScheme}
            </Alert>
          )}

          <Stack spacing={0.75}>
            <Typography variant="caption" color="text.secondary">
              {copy.traceReferences}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {copy.traceReferencesHint}
            </Typography>
            {normalizedTraceDocuments.length > 0 ? (
              <FormGroup
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                  gap: 0.75
                }}
              >
                {normalizedTraceDocuments.slice(0, 12).map((trace) => {
                  const ruleSummary = summarizeTraceExecutableRules(trace)
                  return (
                    <FormControlLabel
                      key={trace.id}
                      control={
                        <Checkbox
                          checked={normalizedSelectedTraceIds.includes(trace.id)}
                          onChange={() => toggleTraceReference(trace.id)}
                          disabled={loading || !onSelectedTraceIdsChange}
                        />
                      }
                      label={
                        <Box sx={{ minWidth: 0 }}>
                          <Typography variant="body2" noWrap>
                            {trace.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {trace.sourceKind} - {trace.eventCount} {copy.traceEvents}
                          </Typography>
                          {trace.skillSummary?.summary ? (
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{
                                display: '-webkit-box',
                                overflow: 'hidden',
                                WebkitBoxOrient: 'vertical',
                                WebkitLineClamp: 2,
                                whiteSpace: 'normal'
                              }}
                            >
                              {trace.skillSummary.summary}
                            </Typography>
                          ) : null}
                          {ruleSummary ? (
                            <Typography variant="caption" color="primary.main" noWrap>
                              {ruleSummary}
                            </Typography>
                          ) : null}
                        </Box>
                      }
                      sx={{
                        m: 0,
                        minWidth: 0,
                        alignItems: 'flex-start',
                        border: '1px solid',
                        borderColor: 'divider',
                        borderRadius: 1,
                        px: 1,
                        py: 0.5
                      }}
                    />
                  )
                })}
              </FormGroup>
            ) : (
              <Alert severity="info">{copy.noTraceReferences}</Alert>
            )}
          </Stack>

          <Stack spacing={0.75}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="caption" color="text.secondary">
                {copy.controlModelLabel}
              </Typography>
              <HoverHint
                ariaLabel={copy.controlModelHintAria}
                title={
                  <Typography variant="body2" sx={{ maxWidth: 280 }}>
                    {copy.controlModelHint}
                  </Typography>
                }
              />
            </Box>

            <TextField
              select
              value={resolvedControlProfileId}
              onChange={(event) => onControlProfileIdChange(event.target.value)}
              disabled={loading || normalizedControlProfileOptions.length === 0}
              fullWidth
            >
              {normalizedControlProfileOptions.map((profile) => (
                <MenuItem key={profile.id} value={profile.id}>
                  <Box
                    sx={{
                      display: 'flex',
                      width: '100%',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1
                    }}
                  >
                    <span>{profile.label}</span>
                    <Chip
                      size="small"
                      label={profile.sourceType === 'local' ? copy.localSource : copy.apiSource}
                      variant="outlined"
                    />
                  </Box>
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <TextField
            label={copy.userIntent}
            value={userIntent}
            onChange={(event) => onUserIntentChange(event.target.value)}
            multiline
            minRows={4}
            placeholder={copy.userIntentPlaceholder}
            disabled={loading}
            required
          />

          <Stack spacing={0.75}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                {copy.evidenceModeTitle}
              </Typography>
              <HoverHint
                ariaLabel={copy.evidenceModeHintAria}
                title={
                  <Typography variant="body2" sx={{ maxWidth: 320 }}>
                    {copy.evidenceModeHint}
                  </Typography>
                }
              />
            </Box>

            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={resolvedEvidenceMode}
              onChange={handleEvidenceModeChange}
              aria-label={copy.evidenceModeTitle}
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
                gap: 0.75,
                '& .MuiToggleButtonGroup-grouped': {
                  m: 0,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  justifyContent: 'flex-start',
                  px: 1,
                  py: 0.75,
                  textAlign: 'left'
                }
              }}
            >
              {evidenceModeOptions.map((option) => (
                <ToggleButton
                  key={option.value}
                  value={option.value}
                  aria-label={option.title}
                  disabled={evidenceModeDisabled}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                      {option.title}
                    </Typography>
                    <Typography
                      variant="caption"
                      color={
                        option.value === 'selected_sources' ? 'warning.main' : 'text.secondary'
                      }
                      sx={{ display: 'block', mt: 0.25, lineHeight: 1.2 }}
                    >
                      {option.cost}
                    </Typography>
                  </Box>
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            <Typography variant="caption" color="text.secondary">
              {selectedEvidenceModeOption.description}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {copy.evidenceModeHelper}
            </Typography>
          </Stack>

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
              {copy.stageOrder}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              {copy.stageHint}
            </Typography>

            <Stack spacing={1}>
              {constrainedStageProfiles.map((stageProfile, index) =>
                (() => {
                  const supportedOutputFormats = getSupportedOutputFormatsForProfile(
                    stageProfile.profileId
                  )
                  const selectedProfile = findProfileOption(
                    normalizedProfileOptions,
                    stageProfile.profileId
                  )
                  const isLocalModelProfile = selectedProfile?.executionBackend === 'local_model'
                  const selectedOutputFormats = sanitizeCanvasTargetStageOutputFormats(
                    stageProfile.outputFormats,
                    supportedOutputFormats
                  )

                  return (
                    <Stack
                      key={`stage-model-${index}`}
                      spacing={1}
                      className="canvas-target-stage-card"
                      sx={{
                        position: 'relative',
                        p: 1.25,
                        pb: 5,
                        borderRadius: 2,
                        border: '1px solid',
                        borderColor: 'divider'
                      }}
                    >
                      <Box
                        sx={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr)',
                          gap: 1,
                          alignItems: 'center'
                        }}
                      >
                        <TextField
                          select
                          label={`${copy.stageModel} ${index + 1}`}
                          value={
                            hasProfileOption(normalizedProfileOptions, stageProfile.profileId)
                              ? stageProfile.profileId
                              : ''
                          }
                          onChange={(event) =>
                            handleStageProfileModelChange(index, event.target.value)
                          }
                          disabled={loading || normalizedProfileOptions.length === 0}
                          fullWidth
                        >
                          {normalizedProfileOptions.map((profile) => (
                            <MenuItem key={`${profile.id}-${index}`} value={profile.id}>
                              <Box
                                sx={{
                                  display: 'flex',
                                  width: '100%',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  gap: 1
                                }}
                              >
                                <span>{profile.label}</span>
                                <Chip
                                  size="small"
                                  label={
                                    profile.sourceType === 'local'
                                      ? copy.localSource
                                      : copy.apiSource
                                  }
                                  variant="outlined"
                                />
                              </Box>
                            </MenuItem>
                          ))}
                        </TextField>
                      </Box>

                      {isLocalModelProfile ? (
                        <Alert severity="info">{copy.localVisualRestriction}</Alert>
                      ) : null}

                      <TextField
                        select
                        label={`${copy.stageOutputFormat} ${index + 1}`}
                        value={selectedOutputFormats}
                        onChange={(event) =>
                          handleStageOutputFormatsChange(index, event.target.value)
                        }
                        disabled={loading}
                        fullWidth
                        InputLabelProps={{
                          shrink: true
                        }}
                        helperText={copy.stageOutputFormatHint}
                        sx={{
                          '& .MuiSelect-select': {
                            whiteSpace: 'normal'
                          }
                        }}
                        SelectProps={{
                          multiple: true,
                          displayEmpty: true,
                          renderValue: (selected) => {
                            const values = (
                              Array.isArray(selected) ? selected : []
                            ) as CanvasTargetStageDraft['outputFormats']
                            return formatStageOutputFormatLabels(values)
                          }
                        }}
                      >
                        {outputFormatOptions.map((option) => (
                          <MenuItem
                            key={`${option.value}-${index}`}
                            value={option.value}
                            disabled={!supportedOutputFormats.includes(option.value)}
                          >
                            {option.label}
                          </MenuItem>
                        ))}
                      </TextField>

                      <TextField
                        label={`${copy.stageMustFollow} ${index + 1}`}
                        value={stageProfile.mustFollow}
                        onChange={(event) =>
                          updateStageProfile(index, { mustFollow: event.target.value })
                        }
                        placeholder={copy.stageMustFollowPlaceholder}
                        multiline
                        minRows={2}
                        disabled={loading}
                        fullWidth
                      />

                      <TextField
                        label={`${copy.stageForbiddenActions} ${index + 1}`}
                        value={stageProfile.forbiddenActions}
                        onChange={(event) =>
                          updateStageProfile(index, { forbiddenActions: event.target.value })
                        }
                        placeholder={copy.stageForbiddenActionsPlaceholder}
                        multiline
                        minRows={2}
                        disabled={loading}
                        fullWidth
                      />

                      <Box>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block' }}
                        >
                          {`${copy.stageAllowedInputs} ${index + 1}`}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', mt: 0.25 }}
                        >
                          {copy.stageAllowedInputsHint}
                        </Typography>

                        <FormGroup row sx={{ mt: 0.5, gap: 0.5 }}>
                          {allowedInputOptions.map((option) => (
                            <FormControlLabel
                              key={`${option.value}-${index}`}
                              control={
                                <Checkbox
                                  checked={stageProfile.allowedInputs.includes(option.value)}
                                  onChange={() => toggleStageAllowedInput(index, option.value)}
                                  disabled={
                                    loading ||
                                    (isLocalModelProfile && option.value === 'scheme_files')
                                  }
                                  size="small"
                                />
                              }
                              label={option.label}
                              sx={{
                                mr: 0,
                                '& .MuiFormControlLabel-label': {
                                  fontSize: 13
                                }
                              }}
                            />
                          ))}
                        </FormGroup>
                      </Box>

                      <StageDeleteButton
                        ariaLabel={`${copy.deleteModel} ${index + 1}`}
                        disabled={loading}
                        onClick={() => requestStageProfileRemoval(index)}
                      />
                    </Stack>
                  )
                })()
              )}

              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2
                }}
              >
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={appendStageProfile}
                  disabled={loading || normalizedProfileOptions.length === 0}
                >
                  {copy.addModel}
                </Button>
              </Box>
            </Stack>
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
              {copy.quickAppOrder}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              {copy.quickAppHint}
            </Typography>

            {normalizedQuickAppOptions.length === 0 ? (
              <Alert severity="info">{copy.noQuickApps}</Alert>
            ) : (
              <Stack spacing={1}>
                {normalizedQuickApps.map((quickApp, index) => {
                  const selectedKeys = new Set(
                    normalizedQuickApps
                      .map((entry, entryIndex) => (entryIndex === index ? '' : entry.qAppKey))
                      .filter(Boolean)
                  )

                  return (
                    <Stack
                      key={`quick-app-${quickApp.qAppKey || index}`}
                      spacing={1}
                      sx={{
                        position: 'relative',
                        p: 1.25,
                        pb: 5,
                        borderRadius: 2,
                        border: '1px solid',
                        borderColor: 'divider'
                      }}
                    >
                      <TextField
                        select
                        label={`${copy.quickApp} ${index + 1}`}
                        value={quickApp.qAppKey}
                        onChange={(event) => updateQuickApp(index, { qAppKey: event.target.value })}
                        disabled={loading || !onQuickAppsChange}
                        fullWidth
                      >
                        {normalizedQuickAppOptions.map((option) => (
                          <MenuItem
                            key={`${option.key}-${index}`}
                            value={option.key}
                            disabled={selectedKeys.has(option.key)}
                          >
                            <Box
                              sx={{
                                display: 'flex',
                                width: '100%',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 1
                              }}
                            >
                              <span>{option.name || option.key}</span>
                              {option.path.length > 0 || option.category ? (
                                <Chip
                                  size="small"
                                  label={
                                    option.path.length > 0
                                      ? option.path.join(' / ')
                                      : option.category
                                  }
                                  variant="outlined"
                                />
                              ) : null}
                            </Box>
                          </MenuItem>
                        ))}
                      </TextField>

                      <ImeStableRuleTextField
                        label={`${copy.quickAppMustFollow} ${index + 1}`}
                        value={quickApp.mustFollow}
                        onChange={(value) => updateQuickApp(index, { mustFollow: value })}
                        placeholder={copy.quickAppMustFollowPlaceholder}
                        disabled={loading || !onQuickAppsChange}
                      />

                      <ImeStableRuleTextField
                        label={`${copy.quickAppForbiddenActions} ${index + 1}`}
                        value={quickApp.forbiddenActions}
                        onChange={(value) => updateQuickApp(index, { forbiddenActions: value })}
                        placeholder={copy.quickAppForbiddenActionsPlaceholder}
                        disabled={loading || !onQuickAppsChange}
                      />

                      <Tooltip title={`${copy.deleteQuickApp} ${index + 1}`}>
                        <span>
                          <IconButton
                            size="small"
                            aria-label={`${copy.deleteQuickApp} ${index + 1}`}
                            disabled={loading || !onQuickAppsChange}
                            onClick={() => removeQuickApp(index)}
                            sx={{
                              position: 'absolute',
                              bottom: 8,
                              left: 8,
                              zIndex: 2,
                              color: 'error.main',
                              '&:hover': {
                                bgcolor: 'error.main',
                                color: '#fff'
                              }
                            }}
                          >
                            <DeleteOutlineIcon sx={{ fontSize: 18 }} />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  )
                })}

                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                  <Button
                    size="small"
                    startIcon={<AddIcon />}
                    onClick={appendQuickApp}
                    disabled={
                      loading ||
                      !onQuickAppsChange ||
                      normalizedQuickApps.length >= normalizedQuickAppOptions.length
                    }
                  >
                    {copy.addQuickApp}
                  </Button>
                </Box>
              </Stack>
            )}
          </Box>

          {report ? (
            <Stack spacing={1.5}>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {copy.progress}
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.5 }}>
                  {report.summary}
                </Typography>
                {report.overview ? (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 0.75, whiteSpace: 'pre-wrap' }}
                  >
                    {report.overview}
                  </Typography>
                ) : null}
              </Box>

              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Chip size="small" variant="outlined" label={`${stages.length} ${copy.stages}`} />
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${reportFindings.length} ${copy.findings}`}
                />
                {report.modelId ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${copy.controlModelChip}: ${findProfileLabel(normalizedProfileOptions, report.modelId)}`}
                  />
                ) : null}
              </Box>

              {stages.map((stage) => (
                <Box
                  key={stage.id}
                  sx={{
                    p: 1.5,
                    borderRadius: 2,
                    border: '1px solid',
                    borderColor: 'divider',
                    bgcolor: 'background.default'
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      flexWrap: 'wrap',
                      mb: 1
                    }}
                  >
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {stage.label}
                    </Typography>

                    <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                      <Chip
                        size="small"
                        color={getStageStatusColor(stage.status)}
                        label={getStageStatusLabel(stage.status, isChineseUi)}
                      />
                      {stage.modelId ? (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={`${copy.stageSource}: ${getStageSourceLabel(stage, normalizedProfileOptions, isChineseUi)}`}
                        />
                      ) : (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={`${copy.stageSource}: ${getStageSourceLabel(stage, normalizedProfileOptions, isChineseUi)}`}
                        />
                      )}
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`${stage.findings.length} ${copy.findings}`}
                      />
                    </Box>
                  </Box>

                  <Typography variant="body2">{stage.summary}</Typography>

                  {stage.overview ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 1, whiteSpace: 'pre-wrap' }}
                    >
                      {stage.overview}
                    </Typography>
                  ) : null}

                  {stage.fallbackReason ? (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: 'block', mt: 1 }}
                    >
                      {copy.fallbackReason}: {stage.fallbackReason}
                    </Typography>
                  ) : null}
                </Box>
              ))}

              {reportFindings.length > 0 ? (
                <Stack spacing={1}>
                  {reportFindings.slice(0, 5).map((finding) => (
                    <Box
                      key={finding.id}
                      sx={{
                        p: 1.5,
                        borderRadius: 2,
                        border: '1px solid',
                        borderColor: 'divider',
                        bgcolor: 'background.paper'
                      }}
                    >
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 1,
                          flexWrap: 'wrap'
                        }}
                      >
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                          {finding.title}
                        </Typography>
                        <Chip
                          size="small"
                          color={getSeverityColor(finding.severity)}
                          label={finding.severity}
                        />
                      </Box>

                      {finding.sourceStageLabel ? (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ display: 'block', mt: 0.5 }}
                        >
                          {copy.findingSource}: {finding.sourceStageLabel}
                        </Typography>
                      ) : null}

                      <Typography variant="body2" sx={{ mt: 0.75 }}>
                        {finding.summary}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              ) : null}
            </Stack>
          ) : null}

          {error ? <Alert severity="error">{error}</Alert> : null}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 2 }}>
          {loading && onCancelRun ? (
            <Button color="error" onClick={onCancelRun}>
              {copy.cancelRun}
            </Button>
          ) : null}
          <Button onClick={onClose}>
            {loading ? (isChineseUi ? '\u5173\u95ed' : 'Close') : copy.cancel}
          </Button>
          <Button
            variant="contained"
            onClick={onRun}
            disabled={loading || !selectedScheme || !resolvedControlProfileId || !userIntent.trim()}
          >
            {copy.start}
          </Button>
        </DialogActions>
      </Dialog>

      <CanvasTargetHistoryDialog
        open={historyDialogOpen}
        isChineseUi={isChineseUi}
        targets={normalizedHistoryTargets}
        selectedTargetId={selectedHistoryTargetId}
        busy={loading}
        onApplyTarget={(targetId) => {
          onApplyHistoryTarget(targetId)
          setHistoryDialogOpen(false)
        }}
        onDeleteTarget={onDeleteHistoryTarget}
        onRenameTarget={onRenameHistoryTarget}
        onClose={() => setHistoryDialogOpen(false)}
      />

      <Dialog
        open={open && pendingStageDeleteIndex !== null}
        onClose={handleCloseStageDeleteDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{copy.deleteModelConfirmTitle}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {pendingStageDeleteSummary}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {copy.deleteModelConfirmDescription}
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseStageDeleteDialog}>{copy.cancel}</Button>
          <Button color="error" variant="contained" onClick={handleConfirmStageDelete}>
            {copy.deleteAction}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
