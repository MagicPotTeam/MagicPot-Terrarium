import { Stack } from '@mui/material'
import ResultList from './ResultList'
import SubmitWorkflowButton from '../QAppExecutePanel/SubmitWorkflowButton'
import RealtimeGenerationSwitch from '../QAppExecutePanel/RealtimeGenerationSwitch'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { useQAppContext } from '../components/QAppContext'

type ResultSectionProps = {
  isDesignMode?: boolean
}

/**
 * 结果区域组件
 * 包含生成按钮和结果列表
 */
export default function ResultSection({ isDesignMode = false }: ResultSectionProps) {
  const { qAppCfg, validate, buildWorkflow } = useQAppContext()
  const {
    state: { isConnected }
  } = useComfyStatus()

  const showButton = validate && buildWorkflow

  return (
    <Stack spacing={3}>
      {showButton && (
        <Stack
          spacing={2}
          sx={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            backgroundColor: 'background.paper',
            pt: 2,
            pb: 3,
            borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
            boxShadow: (theme) => `0 4px 8px -6px ${theme.palette.grey[500]}`,
            px: 1
          }}
        >
          <Stack direction="row" spacing={2} alignItems="center">
            <SubmitWorkflowButton
              isConnected={isConnected}
              isDesignMode={isDesignMode}
              outputNodeIds={qAppCfg?.outputNodeIds}
              validate={validate}
              buildWorkflow={buildWorkflow}
            />
          </Stack>
          {buildWorkflow && (
            <RealtimeGenerationSwitch
              isConnected={isConnected}
              isDesignMode={isDesignMode}
              buildWorkflow={buildWorkflow}
              outputNodeIds={qAppCfg?.outputNodeIds}
            />
          )}
        </Stack>
      )}
      <ResultList />
    </Stack>
  )
}
