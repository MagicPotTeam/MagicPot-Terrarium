import { FolderOpen } from '@mui/icons-material'
import { Button } from '@mui/material'
import { useMessage } from '@renderer/hooks/useMessage'
import { api } from '@renderer/utils/windowUtils'
import type { Workflow } from '@shared/comfy/types'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { QAppValidationOptions, useQAppContext } from '../components/QAppContext'
import { openComfyBatchJob, upsertComfyBatchJob } from './comfyBatchJobState'

type BatchProcessButtonProps = {
  imageInputSlot: string
  outputNodeIds?: string[]
  validate: (options?: QAppValidationOptions) => Promise<boolean> | boolean
  buildWorkflow: () => Promise<Workflow> | Workflow
}

const BatchProcessButton = ({
  imageInputSlot,
  outputNodeIds,
  validate,
  buildWorkflow
}: BatchProcessButtonProps): React.JSX.Element => {
  const { currentQAppKey } = useQAppContext()
  const { t } = useTranslation()
  const { notifyError } = useMessage()

  const start = useCallback(async () => {
    try {
      if (!(await validate({ skipImageInputSlots: [imageInputSlot] }))) return
      if (!currentQAppKey) throw new Error('Quick App key is missing')
      if (!outputNodeIds?.length) throw new Error('Quick App outputNodeIds must not be empty')
      const selection = await api().svcDialog.showOpenDialog({
        title: t('qapp.batch.select_source'),
        properties: ['openDirectory']
      })
      if (selection.canceled || !selection.filePaths[0]) return

      const result = await api().svcComfyBatch.start({
        sourceDir: selection.filePaths[0],
        qAppKey: currentQAppKey,
        workflow: await buildWorkflow(),
        imageInputSlot,
        outputNodeIds
      })
      upsertComfyBatchJob(result.status)
      openComfyBatchJob(result.status.jobId)
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
    }
  }, [buildWorkflow, currentQAppKey, imageInputSlot, notifyError, outputNodeIds, t, validate])

  return (
    <Button variant="outlined" startIcon={<FolderOpen />} onClick={() => void start()}>
      {t('qapp.batch.button')}
    </Button>
  )
}

export default BatchProcessButton
