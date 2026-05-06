import { useCallback, useState } from 'react'
import { api } from '@renderer/utils/windowUtils'
import { extractWorkflowFromImage } from '@renderer/utils/fileUtils'
import { compareWorkflows } from '@renderer/utils/qappUtils'
import { resolveImportedWorkflow } from '@renderer/utils/resolveImportedWorkflow'
import {
  getQuickAppWorkflowImportError,
  hasRestorableHy3dQuickAppPayload,
  parseInternalImageDragPayload
} from '@renderer/utils/droppedImageUtils'
import { getBuiltinHunyuan3DQuickAppKeyForAction } from '@renderer/pages/ChatPage/hy3d/types'
import { clearCachedQAppState, useQAppContext } from '../components/QAppContext'
import {
  QUICK_APP_IMPORT_PROMPT,
  QUICK_APP_WORKFLOW_EXTRACT_ERROR,
  getUnsupportedQuickAppDropMessage,
  isQuickAppBundleFile,
  isQuickAppImportImageFile
} from './qAppDropValidation'

type UseQAppDragAndDropProps = {
  setCurrentQAppKey: (key: string) => void
  notifyError: (msg: string) => void
  notifySuccess: (msg: string) => void
  refreshTabs: () => Promise<void>
}

export function useQAppDragAndDrop({
  setCurrentQAppKey,
  notifyError,
  notifySuccess,
  refreshTabs
}: UseQAppDragAndDropProps) {
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const { setQAppCfg } = useQAppContext()

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(false)
  }, [])

  const matchAndFillQApp = useCallback(
    async (workflow: Record<string, unknown>) => {
      const embeddedQAppKey = (workflow as Record<string, unknown>).__qAppKey__ as
        | string
        | undefined
      if (embeddedQAppKey) {
        console.log(`[handleDrop] using embedded qAppKey: ${embeddedQAppKey}`)
        setCurrentQAppKey(embeddedQAppKey)
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('qapp:fillParams', { detail: { workflow } }))
        }, 300)
        notifySuccess(`已切换到快应用「${embeddedQAppKey}」并加载参数`)
        return true
      }

      try {
        const qAppList = await api().svcQApp.listQAppCfgs({})
        const findAllKeys = (items: typeof qAppList.qApps): string[] => {
          const keys: string[] = []
          for (const item of items) {
            if (!item.isDirectory) keys.push(item.key)
            if (item.children) keys.push(...findAllKeys(item.children))
          }
          return keys
        }

        const allKeys = findAllKeys(qAppList.qApps)
        for (const key of allKeys) {
          try {
            const qAppData = await api().svcQApp.getQAppCfg({ key })
            if (compareWorkflows(workflow, qAppData.workflow)) {
              console.log(`[handleDrop] matched qApp: ${key}`)
              setCurrentQAppKey(key)
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('qapp:fillParams', { detail: { workflow } }))
              }, 300)
              notifySuccess(`已匹配快应用「${key}」并加载参数`)
              return true
            }
          } catch {
            continue
          }
        }
      } catch (error) {
        console.error('[handleDrop] failed to match quick app', error)
      }

      console.warn('[handleDrop] no matching quick app found, filling current quick app')
      window.dispatchEvent(new CustomEvent('qapp:fillParams', { detail: { workflow } }))
      notifySuccess('未找到匹配的快应用，已在当前快应用中加载可用参数')
      return false
    },
    [notifySuccess, setCurrentQAppKey]
  )

  const importQAppFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text()
        const data = JSON.parse(text)
        if (data.magic !== 'MAGICPOT_QAPP') {
          notifyError('这不是有效的魔壶快应用文件')
          return
        }

        const name = data.name || file.name.replace('.mpqapp', '')
        await api().svcQApp.saveQAppCfg({
          key: name,
          cfg: data.cfg,
          workflow: data.workflow
        })
        clearCachedQAppState(name)
        await refreshTabs()
        setCurrentQAppKey(name)
        notifySuccess(`已导入快应用「${name}」`)
      } catch (err) {
        console.error('[QApp] import failed:', err)
        notifyError('导入快应用失败')
      }
    },
    [notifyError, notifySuccess, refreshTabs, setCurrentQAppKey]
  )

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDraggingOver(false)

      const internalPayload = parseInternalImageDragPayload(e.dataTransfer)
      if (internalPayload) {
        const importError = getQuickAppWorkflowImportError(internalPayload)
        if (importError) {
          notifyError(importError)
          return
        }

        if (hasRestorableHy3dQuickAppPayload(internalPayload) && internalPayload.hy3dParams) {
          const nextQAppKey =
            internalPayload.hy3dQuickAppKey ||
            getBuiltinHunyuan3DQuickAppKeyForAction(internalPayload.hy3dParams.apiAction)
          setCurrentQAppKey(nextQAppKey)
          window.dispatchEvent(new CustomEvent('qapp:switch', { detail: { qAppKey: nextQAppKey } }))
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent('hy3d:params-updated', {
                detail: {
                  params: internalPayload.hy3dParams
                }
              })
            )
            if (internalPayload.hy3dMediaState) {
              window.dispatchEvent(
                new CustomEvent('hy3d:media-state-updated', {
                  detail: {
                    mediaState: internalPayload.hy3dMediaState
                  }
                })
              )
            }
          }, 300)
          notifySuccess('已切换到对应的 Hunyuan3D 快应用并恢复生成参数')
          return
        }

        try {
          const workflowData = await extractWorkflowFromImage(
            internalPayload.objectUrl || '',
            internalPayload.promptId
          )
          if (!workflowData) {
            notifyError(QUICK_APP_WORKFLOW_EXTRACT_ERROR)
            return
          }

          const resolved = await resolveImportedWorkflow(workflowData.workflow)
          const matched = await matchAndFillQApp(resolved.workflow)
          if (!matched && resolved.isAppMode) {
            setQAppCfg(resolved.cfg)
          }
        } catch (error) {
          console.error('internal quick-app workflow drop failed:', error)
          notifyError('加载失败')
        }
        return
      }

      const files = Array.from(e.dataTransfer.files)
      const unsupportedDropMessage = getUnsupportedQuickAppDropMessage(files)
      if (unsupportedDropMessage) {
        notifyError(unsupportedDropMessage)
        return
      }

      const qappFiles = files.filter((file) => isQuickAppBundleFile(file))
      if (qappFiles.length > 0) {
        for (const file of qappFiles) {
          await importQAppFile(file)
        }
        return
      }

      const imageFiles = files.filter((file) => isQuickAppImportImageFile(file))
      if (imageFiles.length === 0) {
        notifyError(QUICK_APP_IMPORT_PROMPT)
        return
      }

      try {
        const workflowData = await extractWorkflowFromImage(imageFiles[0])
        if (!workflowData) {
          notifyError(QUICK_APP_WORKFLOW_EXTRACT_ERROR)
          return
        }

        const resolved = await resolveImportedWorkflow(workflowData.workflow)
        const matched = await matchAndFillQApp(resolved.workflow)
        if (!matched && resolved.isAppMode) {
          setQAppCfg(resolved.cfg)
        }
      } catch (error) {
        console.error('external quick-app workflow drop failed:', error)
        notifyError('加载失败')
      }
    },
    [importQAppFile, matchAndFillQApp, notifyError, notifySuccess, setCurrentQAppKey, setQAppCfg]
  )

  return { isDraggingOver, handleDragOver, handleDragLeave, handleDrop }
}
