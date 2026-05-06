import React from 'react'
import { Box } from '@mui/material'
import { useTheme } from '@mui/material/styles'

import ConceptPanel from './hy3d/ConceptPanel'
import ConvertPanel from './hy3d/ConvertPanel'
import ProfilePanel from './hy3d/ProfilePanel'
import SplitPanel from './hy3d/SplitPanel'
import TexturePanel from './hy3d/TexturePanel'
import TopologyPanel from './hy3d/TopologyPanel'
import { getHy3dCssVars, hyColors } from './hy3d/theme'
import type { Hy3dApiAction, Hy3dMediaState, Hy3dParams } from './hy3d/types'
import {
  WORKFLOW_STEPS,
  getHy3dPostProcessModelCompatibility,
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
}

const Hunyuan3DPanel: React.FC<Hunyuan3DPanelProps> = ({
  params,
  mediaState,
  onParamsChange,
  onMediaStateChange,
  onGenerate,
  inline,
  stepId
}) => {
  const theme = useTheme()
  const [activeWorkflowStep, setActiveWorkflowStep] = React.useState(() =>
    getWorkflowStepIdForAction(params.apiAction)
  )
  const hy3dCssVars = React.useMemo(() => getHy3dCssVars(theme.palette.mode), [theme.palette.mode])
  const primaryTextureRefImage =
    mediaState.textureRefImages.find((item) => item.slot === 'single') ||
    mediaState.textureRefImages[0] ||
    null

  React.useEffect(() => {
    setActiveWorkflowStep((current) => {
      const next = getWorkflowStepIdForAction(params.apiAction)
      return current === next ? current : next
    })
  }, [params.apiAction])

  const handleWorkflowStepClick = React.useCallback(
    (stepId: string) => {
      if (activeWorkflowStep === stepId) {
        setActiveWorkflowStep('')
        return
      }

      setActiveWorkflowStep(stepId)
      const step = WORKFLOW_STEPS.find((item) => item.id === stepId)
      if (step?.apiAction) {
        onParamsChange({
          apiAction: step.apiAction as Hy3dApiAction
        })
      }
    },
    [activeWorkflowStep, onParamsChange]
  )

  const getStepActionMeta = React.useCallback(
    (stepId: string) => {
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
    [mediaState.profileRefImage, params, primaryTextureRefImage]
  )

  const renderPanelForStep = React.useCallback(
    (stepId: string) => {
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
    [mediaState, onGenerate, onMediaStateChange, onParamsChange, params]
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
        onStepClick={handleWorkflowStepClick}
        onRunStep={onGenerate ? handleRunStep : undefined}
        getStepActionMeta={getStepActionMeta}
        renderExpandedContent={renderPanelForStep}
      />
    </Box>
  )
}

export default Hunyuan3DPanel
