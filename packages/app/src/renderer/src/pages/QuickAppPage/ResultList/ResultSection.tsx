import { Stack } from '@mui/material'
import ResultList from './ResultList'
import { normalizeQAppBatchConfig } from '@shared/qApp/batchConfig'
import SubmitWorkflowButton from '../QAppExecutePanel/SubmitWorkflowButton'
import RealtimeGenerationSwitch from '../QAppExecutePanel/RealtimeGenerationSwitch'
import BatchProcessButton from '../QAppExecutePanel/BatchProcessButton'
import { useComfyStatus } from '@renderer/store/hooks/comfyStatus'
import { useQAppContext } from '../components/QAppContext'
import { useAppSelector } from '@renderer/store'

type ResultSectionProps = {
  isDesignMode?: boolean
}

/**
 * 结果区域组件
 * 包含生成按钮和结果列表
 */
export default function ResultSection({ isDesignMode = false }: ResultSectionProps) {
  const { qAppCfg, workflow, validate, buildWorkflow } = useQAppContext()
  const objectInfos = useAppSelector((state) => state.comfyStatus.objectInfos)
  const {
    state: { isConnected }
  } = useComfyStatus()

  // Older QApps may have the image/output bindings configured but no
  // batchProcess block yet. Derive the effective bindings from the same
  // source of truth used by the designer so those apps get the default batch
  // action as well.
  const normalizedBatch =
    qAppCfg && workflow ? normalizeQAppBatchConfig(qAppCfg, workflow, objectInfos) : undefined
  const effectiveQAppCfg = normalizedBatch?.cfg ?? qAppCfg
  const effectiveOutputNodeIds = normalizedBatch?.outputNodeIds ?? effectiveQAppCfg?.outputNodeIds
  const effectiveImageInputSlot = effectiveQAppCfg?.batchProcess?.imageInputSlot

  const showButton = validate && buildWorkflow
  const showBatchProcess =
    !isDesignMode &&
    Boolean(validate && buildWorkflow) &&
    effectiveQAppCfg?.batchProcess?.enabled === true &&
    Boolean(effectiveImageInputSlot) &&
    Boolean(effectiveOutputNodeIds?.length)

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
            {showBatchProcess && effectiveImageInputSlot && (
              <BatchProcessButton
                imageInputSlot={effectiveImageInputSlot}
                outputNodeIds={effectiveOutputNodeIds}
                validate={validate}
                buildWorkflow={buildWorkflow}
              />
            )}
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
