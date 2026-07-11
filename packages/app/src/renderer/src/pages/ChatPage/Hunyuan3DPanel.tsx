import React from 'react'
import { Box } from '@mui/material'
import { useTheme } from '@mui/material/styles'

import ConceptPanel from './hy3d/ConceptPanel'
import ConvertPanel from './hy3d/ConvertPanel'
import ProfilePanel from './hy3d/ProfilePanel'
import SplitPanel from './hy3d/SplitPanel'
import TexturePanel from './hy3d/TexturePanel'
import TopologyPanel from './hy3d/TopologyPanel'
import TripoTaskPanel from './hy3d/TripoTaskPanel'
import { getHy3dCssVars, hyColors } from './hy3d/theme'
import type { Hy3dApiAction, Hy3dMediaState, Hy3dParams } from './hy3d/types'
import {
  TRIPO_WORKFLOW_STEPS,
  WORKFLOW_STEPS,
  getHy3dPostProcessModelCompatibility,
  getTripoWorkflowStepIdForAction,
  getWorkflowStepIdForAction
} from './hy3d/types'
import UVPanel from './hy3d/UVPanel'
import WorkflowNavBar from './hy3d/WorkflowNavBar'

interface Hunyuan3DPanelProps {
  params: Hy3dParams
  mediaState: Hy3dMediaState
  onParamsChange: (params: Partial<Hy3dParams>) => void
  onMediaStateChange: (state: Partial<Hy3dMediaState>) => void
  onGenerate?: () => void
  compact?: boolean
  inline?: boolean
  stepId?: string
  provider?: 'hunyuan' | 'tripo'
}

const Hunyuan3DPanel: React.FC<Hunyuan3DPanelProps> = ({
  params,
  mediaState,
  onParamsChange,
  onMediaStateChange,
  onGenerate,
  inline,
  stepId,
  provider = 'hunyuan'
}) => {
  const theme = useTheme()
  const workflowSteps = provider === 'tripo' ? TRIPO_WORKFLOW_STEPS : WORKFLOW_STEPS
  const resolveWorkflowStepId = React.useCallback(
    (action: Hy3dApiAction) =>
      provider === 'tripo'
        ? getTripoWorkflowStepIdForAction(action)
        : getWorkflowStepIdForAction(action),
    [provider]
  )
  const [activeWorkflowStep, setActiveWorkflowStep] = React.useState(() =>
    resolveWorkflowStepId(params.apiAction)
  )
  const hy3dCssVars = React.useMemo(() => getHy3dCssVars(theme.palette.mode), [theme.palette.mode])
  const primaryTextureRefImage =
    mediaState.textureRefImages.find((item) => item.slot === 'single') ||
    mediaState.textureRefImages[0] ||
    null

  React.useEffect(() => {
    setActiveWorkflowStep((current) => {
      const next = resolveWorkflowStepId(params.apiAction)
      return current === next ? current : next
    })
  }, [params.apiAction, resolveWorkflowStepId])

  const handleWorkflowStepClick = React.useCallback(
    (stepId: string) => {
      if (activeWorkflowStep === stepId) {
        setActiveWorkflowStep('')
        return
      }

      setActiveWorkflowStep(stepId)
      const step = workflowSteps.find((item) => item.id === stepId)
      if (step?.apiAction) {
        onParamsChange({
          apiAction: step.apiAction as Hy3dApiAction
        })
      }
    },
    [activeWorkflowStep, onParamsChange, workflowSteps]
  )

  const getStepActionMeta = React.useCallback(
    (stepId: string) => {
      if (provider === 'tripo') {
        const step = workflowSteps.find((item) => item.id === stepId)
        const action =
          resolveWorkflowStepId(params.apiAction) === stepId
            ? params.apiAction
            : step?.apiAction || params.apiAction
        const hasTaskId = Boolean(params.modelTaskId.trim())

        switch (action) {
          case 'TripoStylized3DFlow':
            return {
              label: '执行',
              disabled: !params.prompt.trim() || mediaState.conceptImages.length === 0
            }
          case 'TripoTextToImage':
          case 'TripoGenerateImage':
            return { label: '执行', disabled: !params.prompt.trim() }
          case 'TripoEditMultiviewImage':
            return { label: '执行', disabled: !params.prompt.trim() || !hasTaskId }
          case 'TripoGenerateMultiviewImage':
            return { label: '执行', disabled: mediaState.conceptImages.length === 0 }
          case 'TripoImportModel':
            return { label: '导入', disabled: !params.modelUrl.trim() }
          case 'SubmitTextureTo3DJob':
            return {
              label: '执行',
              disabled:
                !hasTaskId ||
                (!params.texturePrompt.trim() && mediaState.textureRefImages.length === 0)
            }
          case 'SubmitHunyuan3DPartJob':
          case 'TripoMeshCompletion':
          case 'SubmitReduceFaceJob':
          case 'TripoPreRigCheck':
          case 'TripoRig':
          case 'TripoRetarget':
          case 'Convert3DFormat':
            return { label: '执行', disabled: !hasTaskId }
          default:
            return { label: '执行', disabled: false }
        }
      }

      switch (stepId) {
        case 'concept':
          return {
            label: '立即生成',
            disabled: false
          }
        case 'profile':
          return {
            label: '生成人物模型',
            disabled: !mediaState.profileRefImage
          }
        case 'split': {
          const compatibility = getHy3dPostProcessModelCompatibility(
            'SubmitHunyuan3DPartJob',
            params
          )
          return {
            label: '开始拆分',
            disabled: !params.modelUrl || compatibility.status === 'incompatible'
          }
        }
        case 'topology': {
          const compatibility = getHy3dPostProcessModelCompatibility('SubmitReduceFaceJob', params)
          return {
            label: '开始优化',
            disabled: !params.modelUrl || compatibility.status === 'incompatible'
          }
        }
        case 'uv': {
          const compatibility = getHy3dPostProcessModelCompatibility(
            'SubmitHunyuanTo3DUVJob',
            params
          )
          return {
            label: '开始 UV 展开',
            disabled: !params.modelUrl || compatibility.status === 'incompatible'
          }
        }
        case 'texture': {
          const compatibility = getHy3dPostProcessModelCompatibility('SubmitTextureTo3DJob', params)
          return {
            label: '开始生成纹理',
            disabled:
              !params.modelUrl ||
              (!params.texturePrompt && !primaryTextureRefImage) ||
              compatibility.status === 'incompatible'
          }
        }
        case 'convert': {
          const compatibility = getHy3dPostProcessModelCompatibility('Convert3DFormat', params)
          return {
            label: '开始转换',
            disabled: !params.modelUrl || compatibility.status === 'incompatible'
          }
        }
        default:
          return {
            label: '执行',
            disabled: false
          }
      }
    },
    [mediaState, params, primaryTextureRefImage, provider, resolveWorkflowStepId, workflowSteps]
  )

  const renderPanelForStep = React.useCallback(
    (stepId: string) => {
      if (
        provider === 'tripo' &&
        stepId !== 'concept' &&
        TRIPO_WORKFLOW_STEPS.some((item) => item.id === stepId)
      ) {
        return (
          <TripoTaskPanel
            params={params}
            mediaState={mediaState}
            onParamsChange={onParamsChange}
            onMediaStateChange={onMediaStateChange}
            onGenerate={onGenerate}
          />
        )
      }

      switch (stepId) {
        case 'concept':
          return (
            <ConceptPanel
              params={params}
              mediaState={mediaState}
              onParamsChange={onParamsChange}
              onMediaStateChange={onMediaStateChange}
              onGenerate={onGenerate}
            />
          )
        case 'profile':
          return (
            <ProfilePanel
              params={params}
              mediaState={mediaState}
              onParamsChange={onParamsChange}
              onMediaStateChange={onMediaStateChange}
              onGenerate={onGenerate}
            />
          )
        case 'split':
          return (
            <SplitPanel params={params} onParamsChange={onParamsChange} onGenerate={onGenerate} />
          )
        case 'topology':
          return (
            <TopologyPanel
              params={params}
              onParamsChange={onParamsChange}
              onGenerate={onGenerate}
            />
          )
        case 'uv':
          return <UVPanel params={params} onParamsChange={onParamsChange} onGenerate={onGenerate} />
        case 'texture':
          return (
            <TexturePanel
              params={params}
              mediaState={mediaState}
              onParamsChange={onParamsChange}
              onMediaStateChange={onMediaStateChange}
              onGenerate={onGenerate}
            />
          )
        case 'convert':
          return (
            <ConvertPanel params={params} onParamsChange={onParamsChange} onGenerate={onGenerate} />
          )
        default:
          return null
      }
    },
    [mediaState, onGenerate, onMediaStateChange, onParamsChange, params, provider]
  )

  const handleRunStep = React.useCallback(
    (_stepId: string) => {
      onGenerate?.()
    },
    [onGenerate]
  )

  if (stepId) {
    return (
      <Box
        style={hy3dCssVars as React.CSSProperties}
        sx={{
          width: '100%',
          height: '100%',
          bgcolor: inline ? undefined : hyColors.bg,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden'
        }}
      >
        {renderPanelForStep(stepId)}
      </Box>
    )
  }

  return (
    <Box
      style={hy3dCssVars as React.CSSProperties}
      sx={{
        width: '100%',
        height: '100%',
        bgcolor: inline ? undefined : hyColors.bg,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden'
      }}
    >
      <WorkflowNavBar
        activeStep={activeWorkflowStep}
        steps={workflowSteps}
        onStepClick={handleWorkflowStepClick}
        onRunStep={onGenerate ? handleRunStep : undefined}
        getStepActionMeta={getStepActionMeta}
        renderExpandedContent={renderPanelForStep}
      />
    </Box>
  )
}

export default Hunyuan3DPanel
