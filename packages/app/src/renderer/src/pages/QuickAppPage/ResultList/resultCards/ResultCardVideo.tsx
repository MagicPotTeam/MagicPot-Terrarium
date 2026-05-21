import {
  ArrowOutward,
  DownloadOutlined,
  PlayArrowOutlined,
  QueuePlayNextOutlined
} from '@mui/icons-material'
import { Box } from '@mui/material'
import { ConfigUtils } from '@shared/config/configUtils'
import { useEffect, useState } from 'react'
import ModalLayout from '@renderer/components/ModalLayout'
import { downloadFile, extractWorkflowFromImage } from '@renderer/utils/fileUtils'
import { api } from '@renderer/utils/windowUtils'
import { INTERNAL_IMAGE_DRAG_PREFIX, QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import { useQAppContext } from '../../components/QAppContext'
import { compareWorkflows } from '@renderer/utils/qappUtils'
import { resolveImportedWorkflow } from '@renderer/utils/resolveImportedWorkflow'
import ResultCardLayout from './components/ResultCardLayout'
import ResultIconButtonBase from './components/ResultIconButtonBase'
import { ResultCardComponent, ResultCardProps } from './types'
import { resolveProjectResourceDir } from '@renderer/utils/projectResourcePaths'

const autoSavedVideoTracker = new Set<string>()

const ResultCardVideo: ResultCardComponent<'video'> = ({
  result,
  index,
  config,
  buildEnv,
  resultListMethods
}: ResultCardProps<'video'>) => {
  const [previewOpen, setPreviewOpen] = useState(false)
  const { notifySuccess, notifyError } = useMessage()
  const { setWorkflow, setQAppCfg } = useQAppContext()
  const configUtils = new ConfigUtils(config, buildEnv, window.path)
  const fileName = result.fileItem.filename || `qapp_video_${index + 1}.mp4`
  const outputDir = configUtils.getOutputDir()
  const isDraggableResult = Boolean(result.objectUrl && result.objectUrl.trim())

  useEffect(() => {
    if (!result.objectUrl.trim() || autoSavedVideoTracker.has(result.objectUrl)) return
    autoSavedVideoTracker.add(result.objectUrl)

    const autoSaveVideo = async () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const extension = fileName.match(/\.[^.]+$/)?.[0] || '.mp4'
        const autoFileName = `qapp_auto_${timestamp}${extension}`
        const response = await fetch(result.objectUrl)
        const blob = await response.blob()
        const arrayBuffer = await blob.arrayBuffer()
        const targetDir = resolveProjectResourceDir({
          config: { download_dir: config.download_dir },
          projectId: result.projectId,
          segments: ['.AutoSave', 'QuickApp', 'Videos']
        })

        await api().svcHyper.saveImageToDir({
          data: new Uint8Array(arrayBuffer),
          fileName: autoFileName,
          dir: targetDir
        })
      } catch (error) {
        console.error('[.AutoSave] Failed to save quick app video:', error)
      }
    }

    autoSaveVideo()
  }, [config.download_dir, fileName, result.objectUrl, result.projectId])

  const handleLoadQApp = async () => {
    try {
      const workflowData = await extractWorkflowFromImage(result.objectUrl, result.promptId)
      if (!workflowData) {
        notifyError('无法从视频结果中提取工作流信息')
        return
      }

      const resolved = await resolveImportedWorkflow(workflowData.workflow)
      if (!resolved.workflow) {
        notifyError('提取到的工作流格式无效')
        return
      }

      const embeddedQAppKey = (resolved.workflow as Record<string, unknown>).__qAppKey__ as
        | string
        | undefined
      if (embeddedQAppKey) {
        window.dispatchEvent(
          new CustomEvent('qapp:switch', {
            detail: { qAppKey: embeddedQAppKey, workflow: resolved.workflow }
          })
        )
        setWorkflow(resolved.workflow)
        if (resolved.isAppMode) {
          setQAppCfg(resolved.cfg)
        }
        return
      }

      const qAppList = await api().svcQApp.listQAppCfgs({})
      const findAllQApps = (items: typeof qAppList.qApps): string[] => {
        const keys: string[] = []
        for (const item of items) {
          if (!item.isDirectory) keys.push(item.key)
          if (item.children) keys.push(...findAllQApps(item.children))
        }
        return keys
      }

      let matchedKey: string | null = null
      for (const key of findAllQApps(qAppList.qApps)) {
        try {
          const qAppData = await api().svcQApp.getQAppCfg({ key })
          if (compareWorkflows(resolved.workflow, qAppData.workflow)) {
            matchedKey = key
            break
          }
        } catch {
          continue
        }
      }

      if (matchedKey) {
        window.dispatchEvent(
          new CustomEvent('qapp:switch', {
            detail: { qAppKey: matchedKey, workflow: resolved.workflow }
          })
        )
        setWorkflow(resolved.workflow)
        if (resolved.isAppMode) {
          setQAppCfg(resolved.cfg)
        }
        return
      }

      setWorkflow(resolved.workflow)
      if (resolved.isAppMode) {
        setQAppCfg(resolved.cfg)
      }
    } catch (error) {
      console.error('加载快应用失败:', error)
      notifyError(`加载快应用失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <ResultCardLayout
      result={result}
      resultListMethods={resultListMethods}
      deleteButtonTooltip="删除视频"
      tr={[
        <ResultIconButtonBase
          key="download"
          tooltip="下载视频"
          onClick={() => downloadFile(result.objectUrl, fileName)}
          Icon={DownloadOutlined}
        />
      ]}
      br={[
        <ResultIconButtonBase
          key="preview"
          tooltip="预览视频"
          onClick={() => setPreviewOpen(true)}
          Icon={PlayArrowOutlined}
        />,
        outputDir && result.fileItem.filename ? (
          <ResultIconButtonBase
            key="open"
            tooltip="打开所在位置"
            onClick={() =>
              api().svcShell.showItemInFolder(
                window.path.join(
                  outputDir,
                  result.fileItem.subfolder ?? '',
                  result.fileItem.filename ?? ''
                )
              )
            }
            Icon={ArrowOutward}
          />
        ) : null,
        <ResultIconButtonBase
          key="load-qapp"
          tooltip="加载快应用"
          onClick={() => {
            void handleLoadQApp()
          }}
          Icon={QueuePlayNextOutlined}
        />
      ]}
    >
      <Box
        sx={{
          width: '100%',
          bgcolor: '#000',
          lineHeight: 0
        }}
      >
        <video
          src={result.objectUrl}
          draggable={isDraggableResult}
          onDragStart={(e) => {
            if (!isDraggableResult) {
              e.preventDefault()
              return
            }
            const payload = JSON.stringify({
              objectUrl: result.objectUrl,
              promptId: result.promptId,
              fileItem: result.fileItem,
              itemTypes: ['video']
            })
            e.dataTransfer.setData(QAPP_IMAGE_DRAG_MIME, payload)
            e.dataTransfer.setData('text/plain', `${INTERNAL_IMAGE_DRAG_PREFIX}${payload}`)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          controls
          playsInline
          preload="metadata"
          style={{
            width: '100%',
            display: 'block',
            maxHeight: 420,
            objectFit: 'contain',
            cursor: 'default'
          }}
        />
      </Box>
      {previewOpen && (
        <ModalLayout
          open={previewOpen}
          setOpen={(open) => setPreviewOpen(open)}
          buttonText=""
          noButton
        >
          <Box sx={{ width: '100%', height: '100%', p: 2, boxSizing: 'border-box' }}>
            <video
              src={result.objectUrl}
              controls
              autoPlay
              playsInline
              style={{
                width: '100%',
                height: '100%',
                maxHeight: '100%',
                objectFit: 'contain',
                background: '#000'
              }}
            />
          </Box>
        </ModalLayout>
      )}
    </ResultCardLayout>
  )
}

export default ResultCardVideo
