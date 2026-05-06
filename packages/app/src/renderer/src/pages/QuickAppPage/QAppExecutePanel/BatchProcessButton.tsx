import React, { useState, useCallback, useRef } from 'react'
import {
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  LinearProgress,
  Typography,
  Box,
  Stack
} from '@mui/material'
import { FolderOpen } from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import { useQAppContext } from '../components/QAppContext'
import { Workflow, FileItem } from '@shared/comfy/types'
import { setJsonPath } from '@shared/utils/jsonPath'
import { deepCopy } from '@shared/utils/utilTypes'
import { fileItemToValue } from '@shared/comfy/funcs'
import { buildQAppSubmitWorkflowRequest } from '../utils/qAppSubmitWorkflow'
import { resolveQAppSessionKey } from '../utils/qAppSessionIdentity'

type BatchProcessButtonProps = {
  isConnected: boolean
  imageInputSlot: string // The JSON path to the image input in the workflow
  buildWorkflow: () => Workflow
  validate: () => boolean
  /**
   * 批量处理专用工作流文件名（可选）
   * 如果指定，将加载此工作流用于批量处理
   */
  batchWorkflow?: string
  /**
   * 批量工作流中图片输入的 JSON Path（可选）
   * 如果 batchWorkflow 使用了不同的节点 ID，需要指定此字段
   */
  batchImageInputSlot?: string
}

type BatchProcessState = {
  isProcessing: boolean
  currentIndex: number
  totalCount: number
  successCount: number
  failedCount: number
  failedFiles: string[]
  currentFile: string
}

const BatchProcessButton: React.FC<BatchProcessButtonProps> = ({
  isConnected,
  imageInputSlot,
  buildWorkflow,
  validate,
  batchWorkflow,
  batchImageInputSlot
}) => {
  const { notifySuccess, notifyError, notifyInfo, notifyWarning } = useMessage()
  const { currentQAppKey, buildSubmitExtraData, submitClientId, submitSessionKey } =
    useQAppContext()
  const [showDialog, setShowDialog] = useState(false)
  const cancelRef = useRef(false) // 用于跟踪取消状态
  const [state, setState] = useState<BatchProcessState>({
    isProcessing: false,
    currentIndex: 0,
    totalCount: 0,
    successCount: 0,
    failedCount: 0,
    failedFiles: [],
    currentFile: ''
  })
  const [isCancelled, setIsCancelled] = useState(false)

  const handleBatchProcess = useCallback(async () => {
    // 1. Validate workflow
    if (!validate()) {
      return
    }

    // 2. Select input folder
    const inputFolderResult = await api().svcDialog.showOpenDialog({
      title: '选择输入文件夹',
      properties: ['openDirectory']
    })

    if (inputFolderResult.canceled || !inputFolderResult.filePaths[0]) {
      return
    }

    const inputFolder = inputFolderResult.filePaths[0]

    // 3. Get list of images
    const imagesResult = await api().svcFs.listImagesInFolder({ folderPath: inputFolder })

    if (imagesResult.images.length === 0) {
      notifyError('所选文件夹中没有找到图片')
      return
    }

    // 4. Select output folder
    const outputFolderResult = await api().svcDialog.showOpenDialog({
      title: '选择输出文件夹',
      properties: ['openDirectory', 'createDirectory']
    })

    if (outputFolderResult.canceled || !outputFolderResult.filePaths[0]) {
      return
    }

    const outputFolder = outputFolderResult.filePaths[0]

    // 5. Start batch processing
    setShowDialog(true)
    cancelRef.current = false
    setIsCancelled(false)
    setState({
      isProcessing: true,
      currentIndex: 0,
      totalCount: imagesResult.images.length,
      successCount: 0,
      failedCount: 0,
      failedFiles: [],
      currentFile: ''
    })

    // 6. Load batch workflow if specified, otherwise use default workflow builder
    let baseWorkflow: Workflow
    let effectiveImageInputSlot = imageInputSlot

    if (batchWorkflow && currentQAppKey) {
      try {
        // Load batch-specific workflow
        notifyInfo(`正在加载批量处理专用工作流...`)
        const batchWorkflowDir = currentQAppKey.substring(0, currentQAppKey.lastIndexOf('/') + 1)
        const batchWorkflowKey = batchWorkflowDir + batchWorkflow.replace('.prompt.json', '')
        const batchCfg = await api().svcQApp.getQAppCfg({ key: batchWorkflowKey })
        baseWorkflow = batchCfg.workflow
        // Use batch image input slot if specified
        effectiveImageInputSlot = batchImageInputSlot || imageInputSlot
        notifySuccess(`已加载批量处理专用工作流`)
      } catch (error) {
        console.error('Failed to load batch workflow, falling back to default:', error)
        notifyError(`加载批量工作流失败，使用默认工作流`)
        baseWorkflow = buildWorkflow()
      }
    } else {
      baseWorkflow = buildWorkflow()
    }

    for (let i = 0; i < imagesResult.images.length; i++) {
      // 检查是否已取消
      if (cancelRef.current) {
        setIsCancelled(true)
        notifyWarning('批量处理已取消')
        break
      }

      const image = imagesResult.images[i]

      setState((prev) => ({
        ...prev,
        currentIndex: i + 1,
        currentFile: image.filename
      }))

      try {
        // 6.1 Read image from disk
        const imageData = await api().svcFs.readImageFromPath({ fullPath: image.fullPath })

        // 6.2 Upload to ComfyUI
        const uploadResult: FileItem = await api().svcComfy.uploadImage({
          fileItem: { filename: image.filename, type: 'input' },
          image: imageData.image
        })

        if (!uploadResult.filename) {
          throw new Error('上传图片失败')
        }

        // 6.3 Build workflow with uploaded image
        const workflow = deepCopy(baseWorkflow) as Workflow
        const uploadedValue = fileItemToValue(uploadResult)
        setJsonPath(effectiveImageInputSlot, workflow, uploadedValue)

        // 5.4 Submit workflow
        const submitResult = await api().svcComfy.submitWorkflow(
          buildQAppSubmitWorkflowRequest({
            prompt: workflow,
            qAppKey: currentQAppKey,
            clientId: submitClientId,
            sessionKey: resolveQAppSessionKey({
              qAppKey: currentQAppKey,
              submitSessionKey
            }),
            extraData: buildSubmitExtraData?.()
          })
        )

        // 5.5 Wait for completion
        let completed = false
        while (!completed) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          const history = await api().svcComfy.getHistory({ prompt_id: submitResult.prompt_id })

          if (history[submitResult.prompt_id]) {
            const result = history[submitResult.prompt_id]
            if (result.status?.status_str === 'error') {
              throw new Error('工作流执行失败')
            }

            // 5.6 Get output image and save
            const outputs = result.outputs || {}
            for (const nodeId of Object.keys(outputs)) {
              const nodeOutput = outputs[nodeId]
              if (nodeOutput.images && nodeOutput.images.length > 0) {
                const outputImage = nodeOutput.images[0]
                const viewResult = await api().svcComfy.getView({
                  filename: outputImage.filename,
                  type: outputImage.type,
                  subfolder: outputImage.subfolder
                })

                // Save with original filename
                const ext = image.filename.includes('.')
                  ? image.filename.substring(image.filename.lastIndexOf('.'))
                  : '.png'
                const outputFilename = image.filename.replace(/\.[^/.]+$/, '') + '_upscaled' + ext

                await api().svcFs.saveImageToPath({
                  image: viewResult.result,
                  outputPath: outputFolder,
                  filename: outputFilename
                })

                completed = true
                break
              }
            }

            if (!completed) {
              // No image output found yet, check again
              completed = result.status?.completed || false
            }
          }
        }

        setState((prev) => ({
          ...prev,
          successCount: prev.successCount + 1
        }))
      } catch (error) {
        console.error(`批量处理失败: ${image.filename}`, error)
        setState((prev) => ({
          ...prev,
          failedCount: prev.failedCount + 1,
          failedFiles: [...prev.failedFiles, image.filename]
        }))
      }
    }

    setState((prev) => ({
      ...prev,
      isProcessing: false
    }))
  }, [
    validate,
    buildWorkflow,
    imageInputSlot,
    currentQAppKey,
    buildSubmitExtraData,
    notifyError,
    notifyInfo,
    notifySuccess,
    notifyWarning,
    batchWorkflow,
    batchImageInputSlot,
    submitClientId,
    submitSessionKey
  ])

  const handleCancel = useCallback(() => {
    cancelRef.current = true
  }, [])

  const handleClose = () => {
    if (!state.isProcessing) {
      setShowDialog(false)
      setIsCancelled(false)
      if (state.successCount > 0 || state.failedCount > 0) {
        if (isCancelled) {
          notifyInfo(`批量处理已取消。成功 ${state.successCount} 张，失败 ${state.failedCount} 张`)
        } else if (state.failedCount === 0) {
          notifySuccess(`批量处理完成！成功处理 ${state.successCount} 张图片`)
        } else {
          notifyInfo(`批量处理完成！成功 ${state.successCount} 张，失败 ${state.failedCount} 张`)
        }
      }
    }
  }

  const progress = state.totalCount > 0 ? (state.currentIndex / state.totalCount) * 100 : 0

  return (
    <>
      <Button
        variant="outlined"
        startIcon={<FolderOpen />}
        onClick={handleBatchProcess}
        disabled={!isConnected}
        sx={{ minWidth: 120 }}
      >
        批量处理
      </Button>

      <Dialog open={showDialog} onClose={handleClose} maxWidth="sm" fullWidth>
        <DialogTitle>批量处理进度</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Box>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                {state.isProcessing ? `正在处理: ${state.currentFile}` : '处理完成'}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={progress}
                sx={{ height: 8, borderRadius: 4 }}
              />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {state.currentIndex} / {state.totalCount}
              </Typography>
            </Box>

            <Box sx={{ display: 'flex', gap: 3 }}>
              <Typography color="success.main">成功: {state.successCount}</Typography>
              <Typography color="error.main">失败: {state.failedCount}</Typography>
            </Box>

            {state.failedFiles.length > 0 && (
              <Box>
                <Typography variant="body2" color="error" gutterBottom>
                  失败的文件:
                </Typography>
                <Box sx={{ maxHeight: 100, overflow: 'auto', fontSize: '0.875rem' }}>
                  {state.failedFiles.map((file, index) => (
                    <Typography key={index} variant="body2" color="text.secondary">
                      {file}
                    </Typography>
                  ))}
                </Box>
              </Box>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          {state.isProcessing ? (
            <Button onClick={handleCancel} color="error">
              取消处理
            </Button>
          ) : (
            <Button onClick={handleClose}>关闭</Button>
          )}
        </DialogActions>
      </Dialog>
    </>
  )
}

export default BatchProcessButton
