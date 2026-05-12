import { ConfigUtils } from '@shared/config/configUtils'
import { ResultCardComponent, ResultCardProps } from './types'
import ResultCardLayout from './components/ResultCardLayout'
import ResultIconButtonBase from './components/ResultIconButtonBase'
import { ArrowOutward, DownloadOutlined, SendOutlined } from '@mui/icons-material'
import { downloadFile, extractWorkflowFromImage } from '@renderer/utils/fileUtils'
import { api } from '@renderer/utils/windowUtils'
import { ZoomInOutlined } from '@mui/icons-material'
import { useState, useEffect } from 'react'
import ModalLayout from '@renderer/components/ModalLayout'
import ImageViewer from '@renderer/components/ImageCanvas/ImageViewer'
import { useTranslation } from 'react-i18next'
import { useMessage } from '@renderer/hooks/useMessage'
import { Menu, MenuItem } from '@mui/material'

import { useQAppContext } from '../../components/QAppContext'
import { compareWorkflows } from '@renderer/utils/qappUtils'
import { resolveImportedWorkflow } from '@renderer/utils/resolveImportedWorkflow'
import { INTERNAL_IMAGE_DRAG_PREFIX, QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import { resolveProjectResourceDir } from '@renderer/utils/projectResourcePaths'

// 记录已经自动保存过的图片，防止组件重新挂载时重复保存
const autoSavedImageTracker = new Set<string>()

const ResultCardImage: ResultCardComponent<'image'> = ({
  result,
  index,
  config,
  buildEnv,
  resultListMethods
}: ResultCardProps<'image'>) => {
  const { t } = useTranslation()
  const { notifySuccess, notifyError } = useMessage()
  const configUtils = new ConfigUtils(config, buildEnv, window.path)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number
    mouseY: number
  } | null>(null)
  const { setWorkflow, setQAppCfg, setFormStateValue, qAppCfg } = useQAppContext()
  const isDraggableResult = Boolean(result.objectUrl && result.objectUrl.trim())

  useEffect(() => {
    // 自动保存逻辑
    if (!result.objectUrl || autoSavedImageTracker.has(result.objectUrl)) return
    autoSavedImageTracker.add(result.objectUrl)

    const autoSaveImage = async () => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const fileName = `qapp_auto_${timestamp}.png`

        const response = await fetch(result.objectUrl)
        const blob = await response.blob()
        const arrayBuffer = await blob.arrayBuffer()
        const data = new Uint8Array(arrayBuffer)

        const targetDir = resolveProjectResourceDir({
          config: { download_dir: config.download_dir },
          projectId: result.projectId,
          segments: ['AutoSave', 'QuickApp', 'Images']
        })

        const res = await api().svcHyper.saveImageToDir({
          data,
          fileName,
          dir: targetDir
        })
        console.log(`[自动保存] 快应用图片已保存到 ${res.savedPath}`)
      } catch (error) {
        console.error('[自动保存] 快应用图片保存失败:', error)
      }
    }

    autoSaveImage()
  }, [result.objectUrl, result.projectId, config.download_dir])

  const handleCopyImage = async () => {
    try {
      const response = await fetch(result.objectUrl)
      const blob = await response.blob()
      const arrayBuffer = await blob.arrayBuffer()
      const res = await api().svcHyper.writeImageToClipboard({ data: new Uint8Array(arrayBuffer) })
      if (res.success) {
        notifySuccess(t('quickapp.results.copy_success'))
      } else {
        throw new Error('Native clipboard write returned false')
      }
    } catch (error) {
      console.error('Failed to copy image:', error)
      notifyError(t('quickapp.results.copy_failed'))
    }
  }

  // 比较两个工作流是否匹配（模糊匹配，跳过动态 LoRA 节点）
  const handleLoadQApp = async () => {
    try {
      setContextMenu(null)
      const workflowData = await extractWorkflowFromImage(result.objectUrl, result.promptId)

      if (!workflowData) {
        notifyError('无法从图片中提取工作流信息')
        return
      }

      const resolved = await resolveImportedWorkflow(workflowData.workflow)
      if (!resolved.workflow) {
        notifyError('提取的工作流格式无效')
        return
      }

      // Check if workflow contains embedded qAppKey (saved when generating)
      const embeddedQAppKey = (resolved.workflow as Record<string, unknown>).__qAppKey__ as
        | string
        | undefined
      if (embeddedQAppKey) {
        // Use embedded qAppKey directly
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

      // Fallback: 尝试匹配现有的快应用
      try {
        const qAppList = await api().svcQApp.listQAppCfgs({})

        // 递归查找所有快应用
        const findAllQApps = (items: typeof qAppList.qApps): string[] => {
          const keys: string[] = []
          for (const item of items) {
            if (!item.isDirectory) {
              keys.push(item.key)
            }
            if (item.children) {
              keys.push(...findAllQApps(item.children))
            }
          }
          return keys
        }

        const allQAppKeys = findAllQApps(qAppList.qApps)

        // 尝试匹配工作流
        let matchedKey: string | null = null
        for (const key of allQAppKeys) {
          try {
            const qAppData = await api().svcQApp.getQAppCfg({ key })
            if (compareWorkflows(resolved.workflow, qAppData.workflow)) {
              matchedKey = key
              break
            }
          } catch {
            // 忽略单个快应用加载失败
            continue
          }
        }

        if (matchedKey) {
          // 找到匹配的快应用，触发切换事件
          window.dispatchEvent(
            new CustomEvent('qapp:switch', {
              detail: { qAppKey: matchedKey, workflow: resolved.workflow }
            })
          )
          // 加载工作流到当前上下文（用于设计模式）
          setWorkflow(resolved.workflow)
          if (resolved.isAppMode) {
            setQAppCfg(resolved.cfg)
          }
        } else {
          // 没有找到匹配的快应用，只加载工作流
          setWorkflow(resolved.workflow)
          if (resolved.isAppMode) {
            setQAppCfg(resolved.cfg)
          }
        }
      } catch (error) {
        // 如果匹配过程失败，仍然加载工作流
        console.error('匹配快应用失败:', error)
        setWorkflow(resolved.workflow)
        if (resolved.isAppMode) {
          setQAppCfg(resolved.cfg)
        }
      }
    } catch (error) {
      console.error('加载快应用失败:', error)
      notifyError('加载快应用失败: ' + (error instanceof Error ? error.message : String(error)))
    }
  }

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault()
    setContextMenu(
      contextMenu === null
        ? {
            mouseX: event.clientX + 2,
            mouseY: event.clientY - 6
          }
        : null
    )
  }

  const handleCloseContextMenu = () => {
    setContextMenu(null)
  }

  const handleSendToPhotoshop = async () => {
    try {
      // 将 blob URL 转换为 base64
      const response = await fetch(result.objectUrl)
      const blob = await response.blob()
      const reader = new FileReader()
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = reject
        reader.readAsDataURL(blob)
      })

      const res = await api().svcPhotoshop.sendImageToPhotoshop({
        imageUrl: dataUrl,
        fileName: `comfyui-image-${index + 1}.png`
      })

      if (res.success) {
        notifySuccess('图片已发送到当前 Photoshop 文档')
      } else {
        notifyError(`发送到当前 Photoshop 文档失败: ${res.error || '未知错误'}`)
      }
    } catch (error) {
      console.error('发送到当前 Photoshop 文档失败:', error)
      notifyError(
        `发送到当前 Photoshop 文档失败: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return (
    <ResultCardLayout
      result={result}
      resultListMethods={resultListMethods}
      deleteButtonTooltip={t('quickapp.results.delete_image')}
      tr={[
        <ResultIconButtonBase
          key="download"
          tooltip={t('quickapp.results.download_image')}
          onClick={async () => {
            try {
              const DOWNLOAD_DIR_KEY = 'qapp.downloadDir'
              let downloadDir = localStorage.getItem(DOWNLOAD_DIR_KEY) || config.download_dir

              // 如果没有设置过下载目录，弹出文件夹选择器
              if (!downloadDir) {
                const result2 = await api().svcDialog.showOpenDialog({
                  title: '选择图片保存目录',
                  properties: ['openDirectory']
                })
                if (result2.canceled || !result2.filePaths?.length) return
                downloadDir = result2.filePaths[0]
                localStorage.setItem(DOWNLOAD_DIR_KEY, downloadDir)
                // 同步保存到 config
                api().svcState.saveConfig({ config: { download_dir: downloadDir } })
              }

              const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
              const fileName = `${t('quickapp.results.generated_image')}_${timestamp}.png`
              const response = await fetch(result.objectUrl)
              const blob = await response.blob()
              const arrayBuffer = await blob.arrayBuffer()
              const data = new Uint8Array(arrayBuffer)
              const res = await api().svcHyper.saveImageToDir({ data, fileName, dir: downloadDir })
              console.log(`[下载] 已保存到 ${res.savedPath}`)
            } catch (error) {
              console.error('保存图片失败:', error)
              notifyError('保存失败: ' + (error instanceof Error ? error.message : String(error)))
            }
          }}
          Icon={DownloadOutlined}
        />
      ]}
      br={[
        <ResultIconButtonBase
          key="preview"
          tooltip={t('quickapp.results.preview_image')}
          onClick={() => {
            if (resultListMethods?.openImagePreview) {
              resultListMethods.openImagePreview(result.objectUrl)
            } else {
              setPreviewOpen(true)
            }
          }}
          Icon={ZoomInOutlined}
        />,
        <ResultIconButtonBase
          key="photoshop"
          tooltip="发送到当前 Photoshop 文档"
          onClick={handleSendToPhotoshop}
          Icon={SendOutlined}
        />,
        configUtils.getOutputDir() && (
          <ResultIconButtonBase
            key="open"
            tooltip={t('quickapp.results.open_location')}
            onClick={() =>
              api().svcShell.showItemInFolder(
                window.path.join(
                  configUtils.getOutputDir(),
                  result.fileItem.subfolder ?? '',
                  result.fileItem.filename ?? ''
                )
              )
            }
            Icon={ArrowOutward}
          />
        )
      ]}
    >
      <img
        src={result.objectUrl}
        alt={`${t('quickapp.results.generated_image')} ${index + 1}`}
        draggable={isDraggableResult}
        onDragStart={(e) => {
          if (!isDraggableResult) {
            e.preventDefault()
            return
          }
          // 携带图片URL和promptId，供拖放目标提取工作流
          const sourceWidth = e.currentTarget.naturalWidth || undefined
          const sourceHeight = e.currentTarget.naturalHeight || undefined
          const payload = JSON.stringify({
            objectUrl: result.objectUrl,
            promptId: result.promptId,
            fileItem: result.fileItem,
            ...(sourceWidth ? { sourceWidth } : {}),
            ...(sourceHeight ? { sourceHeight } : {})
          })
          e.dataTransfer.setData(QAPP_IMAGE_DRAG_MIME, payload)
          e.dataTransfer.setData('text/plain', `${INTERNAL_IMAGE_DRAG_PREFIX}${payload}`)
          e.dataTransfer.setData('text/uri-list', result.objectUrl)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        style={{
          width: '100%',
          height: 'auto',
          minHeight: '100px',
          display: 'block',
          cursor: 'default'
        }}
        onContextMenu={handleContextMenu}
      />
      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null ? { top: contextMenu.mouseY, left: contextMenu.mouseX } : undefined
        }
      >
        <MenuItem onClick={handleCopyImage}>复制图片</MenuItem>
        <MenuItem onClick={handleSendToPhotoshop}>发送到当前 Photoshop 文档</MenuItem>
        <MenuItem onClick={handleLoadQApp}>加载快应用</MenuItem>
      </Menu>
      {previewOpen && (
        <ModalLayout
          open={!!previewOpen}
          setOpen={(open) => setPreviewOpen(open ? previewOpen : false)}
          buttonText=""
          noButton
        >
          <ImageViewer imageUrl={result.objectUrl} />
        </ModalLayout>
      )}
    </ResultCardLayout>
  )
}

export default ResultCardImage
