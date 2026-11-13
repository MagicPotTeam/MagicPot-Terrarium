import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { useTranslation } from 'react-i18next'
import { api } from '../../utils/windowUtils'
import { openRightPanel } from '../../store/slices/layoutSlice'
import { extractVideoBoundaryFrameDataUrls } from '../ChatPage/chatVideoAttachmentUtils'
import { materializeInternalImageDragAttachment } from '../../utils/droppedImageUtils'
import {
  buildCanvasAgentAttachments,
  buildCanvasAgentAttachmentManifest,
  buildCanvasAgentGroupCompletionPrompt,
  expandCanvasItemsForAgentSend,
  getCanvasBlobItemMimeType
} from './canvasAgentAttachmentUtils'
import { resolveActiveAgentScope } from './canvasPageLocalStateUtils'
import { sanitizeFilePart } from './canvasExportNamingUtils'
import type { AgentTargetApp, SendCanvasItemsToAgentOptions } from './projectCanvasPageShared'
import type { CanvasGroup, CanvasItem, CanvasModel3DItem, CanvasVideoItem } from './types'
import { AdobeBridgeTarget } from '@shared/api/svcAdobeBridge'
import { DccBridgeTarget } from '@shared/api/svcDccBridge'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import { assertExplicitUserImageCount } from '../ChatPage/chatExplicitImageCount'

import { AGENT_SELECTION_RASTER_LIMITS, type CanvasRasterLimits } from './canvasExportRasterUtils'
import type { CanvasExportBounds } from './groupPlaybackUtils'

type NotifyFn = (message: string) => unknown

// Mirrors ChatPage's current duplicate rule; this only covers a single
// sender-side selection, not the destination's existing or in-flight draft.
function hasAttachmentCollision(
  previous: ChatAttachment[],
  candidate: ChatAttachment
): boolean {
  return previous.some(
    (item) =>
      item.url === candidate.url ||
      (Boolean(item.fileName) &&
        item.fileName === candidate.fileName &&
        item.sizeBytes === candidate.sizeBytes)
  )
}

type UseCanvasBridgeActionsOptions = {
  canvasId: string
  projectName: string
  items: CanvasItem[]
  groups: CanvasGroup[]
  notifySuccess: NotifyFn
  notifyError: NotifyFn
  extractPromptTextFromCanvasItems: (targetItems: CanvasItem[]) => string
  renderCanvasItemsImageDataUrl: (
    targetItems: CanvasItem[],
    includeBackground?: boolean,
    clipBounds?: CanvasExportBounds | null,
    limits?: CanvasRasterLimits
  ) => Promise<string>
  renderCanvasItemsSvgMarkup: (
    targetItems: CanvasItem[],
    includeBackground?: boolean
  ) => Promise<string>
}

function getAgentTargetAppPrompt(targetApp: AgentTargetApp): string {
  switch (targetApp) {
    case 'photoshop':
      return 'Target app: Photoshop. Prefer Photoshop-friendly instructions, scripts, and editing steps.'
    case 'figma':
      return 'Target app: Figma. Prefer Figma-friendly layout, component, and handoff guidance.'
    case 'after-effects':
      return 'Target app: After Effects. Prefer After Effects-friendly instructions, expressions, and effect-building steps.'
    case 'premiere':
      return 'Target app: Premiere Pro. Prefer Premiere Pro-friendly instructions, timeline steps, and edit guidance.'
  }
}

export function useCanvasBridgeActions({
  canvasId,
  projectName,
  items,
  groups,
  notifySuccess,
  notifyError,
  extractPromptTextFromCanvasItems,
  renderCanvasItemsImageDataUrl,
  renderCanvasItemsSvgMarkup
}: UseCanvasBridgeActionsOptions) {
  const dispatch = useDispatch()
  const { t } = useTranslation()
  const [agentSendMenuAnchor, setAgentSendMenuAnchor] = useState<HTMLElement | null>(null)
  const [agentSendMenuItemIds, setAgentSendMenuItemIds] = useState<string[]>([])
  const [dccExportMenuAnchor, setDccExportMenuAnchor] = useState<HTMLElement | null>(null)
  const [dccExportMenuItemId, setDccExportMenuItemId] = useState<string | null>(null)
  const agentDeliveryLifecycleRef = useRef({ canvasId, generation: 0, mounted: false })
  const agentDeliveryTimersRef = useRef(new Set<number>())

  useLayoutEffect(() => {
    const lifecycle = agentDeliveryLifecycleRef.current
    lifecycle.canvasId = canvasId
    lifecycle.generation += 1
    lifecycle.mounted = true
    const timers = agentDeliveryTimersRef.current
    return () => {
      lifecycle.mounted = false
      lifecycle.generation += 1
      for (const timer of timers) window.clearTimeout(timer)
      timers.clear()
    }
  }, [canvasId])

  const getActiveAgentPaneScope = useCallback(() => resolveActiveAgentScope(canvasId), [canvasId])

  const handleSendCanvasItemsToAgent = useCallback(
    async (
      targetItems: CanvasItem[],
      targetScopeOrOptions?: string | SendCanvasItemsToAgentOptions,
      targetApp?: AgentTargetApp
    ): Promise<boolean> => {
      if (targetItems.length === 0) return false
      const generation = agentDeliveryLifecycleRef.current.generation
      const isCurrentDelivery = () => {
        const lifecycle = agentDeliveryLifecycleRef.current
        return (
          lifecycle.mounted &&
          lifecycle.canvasId === canvasId &&
          lifecycle.generation === generation
        )
      }
      if (!isCurrentDelivery()) return false

      try {
        const resolvedOptions: SendCanvasItemsToAgentOptions =
          typeof targetScopeOrOptions === 'string'
            ? {
                targetScope: targetScopeOrOptions,
                targetApp
              }
            : (targetScopeOrOptions ?? {})

        const resolvedScope = resolvedOptions.targetScope ?? getActiveAgentPaneScope()
        const resolvedTargetApp = resolvedOptions.targetApp ?? targetApp
        const promptPrefix = resolvedOptions.promptPrefix?.trim() ?? ''
        const includeCanvasPromptText = resolvedOptions.includeCanvasPromptText !== false
        const includeGroupCompletionPrompt = resolvedOptions.includeGroupCompletionPrompt !== false

        const supplementalImageAttachments: ChatAttachment[] = []
        const expandedTargetItems = expandCanvasItemsForAgentSend(targetItems, items)
        // Count the selected image descriptors before crop export, overview
        // rasterization, or attachment materialization. Derived video frames and
        // overview images are not part of this explicit selection check.
        try {
          assertExplicitUserImageCount(expandedTargetItems)
        } catch (error) {
          notifyError(error instanceof Error ? error.message : String(error))
          return false
        }
        // Existing crop coordinates do not carry evidence tying them to this
        // source's pixels. Dimensions, including backfilled dimensions, cannot
        // prove that mapping. Reject the whole selection before rasterization or
        // delivery rather than exporting a potentially different region.
        if (expandedTargetItems.some((item) => item.type === 'image' && item.crop)) {
          notifyError(
            t('canvas.agent_send_cropped_image_failed', {
              defaultValue:
                'Cannot send cropped canvas images safely yet. Remove the crop to send the full original, or send another uncropped image.'
            })
          )
          return false
        }

        // The receiver currently collapses identical URLs or equal filename/size
        // pairs. Reject collisions visible within this selection before creating
        // an overview or sending any of its items; this is not a receiver ACK.
        const selectionAttachments = buildCanvasAgentAttachments(expandedTargetItems)
        const hasSelectionCollision = selectionAttachments.some((candidate, index) =>
          hasAttachmentCollision(selectionAttachments.slice(0, index), candidate)
        )
        if (hasSelectionCollision) {
          notifyError(t('canvas.agent_send_duplicate_selection'))
          return false
        }
        const attachmentItems = expandedTargetItems
        const baseAttachments = buildCanvasAgentAttachments(attachmentItems)
        const attachmentManifest = buildCanvasAgentAttachmentManifest(attachmentItems)
        // Check explicit attachments in order before creating an overview or
        // loading video frames. Materialization may read an explicit blob, so a
        // failed preparation is not a promise of zero source-side I/O.
        const materializedAttachments: ChatAttachment[] = []
        for (const attachment of baseAttachments) {
          const materialized = await materializeInternalImageDragAttachment(attachment)
          if (!isCurrentDelivery()) return false
          if (!materialized) {
            notifyError(t('canvas.send_to_agent_failed'))
            return false
          }
          if (hasAttachmentCollision(materializedAttachments, materialized)) {
            notifyError(t('canvas.agent_send_duplicate_selection'))
            return false
          }
          materializedAttachments.push(materialized)
        }
        const supplementalPromptParts: string[] = []
        const promptText = includeCanvasPromptText
          ? extractPromptTextFromCanvasItems(expandedTargetItems)
          : ''
        const completionPrompt = includeGroupCompletionPrompt
          ? buildCanvasAgentGroupCompletionPrompt(targetItems, items, groups)
          : ''
        const hasDirectImageAttachments = baseAttachments.some(
          (attachment) => attachment.type === 'image'
        )
        const shouldIncludeSelectionSnapshot =
          !hasDirectImageAttachments || targetItems.some((item) => item.type !== 'image')

        if (shouldIncludeSelectionSnapshot) {
          try {
            const snapshot = await renderCanvasItemsImageDataUrl(
              expandedTargetItems,
              false,
              undefined,
              AGENT_SELECTION_RASTER_LIMITS
            )
            if (!isCurrentDelivery()) return false
            if (!snapshot) {
              notifyError(t('canvas.agent_send_overview_failed', {
                defaultValue: 'Could not create the canvas overview. Select a smaller area or reduce the distance between items, then try again.'
              }))
              return false
            }
            supplementalImageAttachments.push({
              type: 'image',
              url: snapshot,
              mimeType: 'image/png',
              fileName: 'canvas-selection.png',
              hiddenFromChatView: true
            })
            supplementalPromptParts.push(
              'Included an overview snapshot of the selected canvas content for additional layout context.'
            )
          } catch (error) {
            if (!isCurrentDelivery()) return false
            console.warn('[SendToAgent] failed to render canvas snapshot:', error)
            notifyError(t('canvas.agent_send_overview_failed', {
              defaultValue: 'Could not create the canvas overview. Select a smaller area or reduce the distance between items, then try again.'
            }))
            return false
          }
        }

        const videoItems = expandedTargetItems.filter(
          (item): item is CanvasVideoItem => item.type === 'video'
        )
        for (const videoItem of videoItems) {
          try {
            const { firstFrameDataUrl, lastFrameDataUrl } = await extractVideoBoundaryFrameDataUrls(
              videoItem.src
            )
            if (!isCurrentDelivery()) return false

            if (firstFrameDataUrl) {
              supplementalImageAttachments.push({
                type: 'image',
                url: firstFrameDataUrl,
                mimeType: 'image/png',
                fileName: `${videoItem.fileName || 'untitled-video'}-first-frame.png`
              })
              supplementalPromptParts.push(
                `Included the first frame of video "${videoItem.fileName || 'untitled-video'}".`
              )
            }

            if (lastFrameDataUrl) {
              supplementalImageAttachments.push({
                type: 'image',
                url: lastFrameDataUrl,
                mimeType: 'image/png',
                fileName: `${videoItem.fileName || 'untitled-video'}-last-frame.png`
              })
              supplementalPromptParts.push(
                `Included the last frame of video "${videoItem.fileName || 'untitled-video'}".`
              )
            }
          } catch (error) {
            if (!isCurrentDelivery()) return false
            console.warn(
              `[SendToAgent] failed to extract boundary frames for video ${videoItem.fileName}:`,
              error
            )
          }
        }

        const hiddenPromptText = [
          promptPrefix,
          resolvedTargetApp ? getAgentTargetAppPrompt(resolvedTargetApp) : '',
          attachmentManifest,
          completionPrompt,
          supplementalPromptParts.join('\n')
        ]
          .filter(Boolean)
          .join('\n\n')
        const finalPromptText = promptText.trim()

        // Derived overview/video frames are not additional explicit selections.
        // Keep their prior event behavior even if their pixels are identical;
        // receiver deduplication remains a separate, unconfirmed boundary.
        for (const attachment of supplementalImageAttachments) {
          const materialized = await materializeInternalImageDragAttachment(attachment)
          if (!isCurrentDelivery()) return false
          if (!materialized) {
            notifyError(t('canvas.send_to_agent_failed'))
            return false
          }
          materializedAttachments.push(materialized)
        }
        if (!isCurrentDelivery()) return false

        dispatch(openRightPanel())
        if (!isCurrentDelivery()) return false
        const timer = window.setTimeout(() => {
          agentDeliveryTimersRef.current.delete(timer)
          if (!isCurrentDelivery()) return
          try {
            for (const attachment of materializedAttachments) {
              if (!isCurrentDelivery()) return
              window.dispatchEvent(
                new CustomEvent('send-to-agent', {
                  detail: { attachment, text: '', targetScope: resolvedScope }
                })
              )
            }

            if (!isCurrentDelivery()) return
            if (finalPromptText) {
              window.dispatchEvent(
                new CustomEvent('send-to-agent', {
                  detail: {
                    text: finalPromptText,
                    hiddenText: hiddenPromptText,
                    targetScope: resolvedScope
                  }
                })
              )
            } else if (hiddenPromptText) {
              window.dispatchEvent(
                new CustomEvent('send-to-agent', {
                  detail: { hiddenText: hiddenPromptText, targetScope: resolvedScope }
                })
              )
            }

            if (!isCurrentDelivery()) return
            window.dispatchEvent(
              new CustomEvent('chat:focus-composer', {
                detail: { scope: resolvedScope }
              })
            )
          } catch (error) {
            if (!isCurrentDelivery()) return
            console.error('[SendToAgent] failed to deliver canvas attachments:', error)
            notifyError(t('canvas.send_to_agent_failed'))
          }
        }, 200)
        agentDeliveryTimersRef.current.add(timer)
        // Only a local timer has been scheduled. The target has not acknowledged it.
        return true
      } catch (error) {
        if (!isCurrentDelivery()) return false
        console.error('[SendToAgent] failed to prepare canvas attachments:', error)
        notifyError(t('canvas.send_to_agent_failed'))
        return false
      }
    },
    [
      canvasId,
      dispatch,
      extractPromptTextFromCanvasItems,
      getActiveAgentPaneScope,
      groups,
      items,
      notifyError,
      renderCanvasItemsImageDataUrl,
      t
    ]
  )

  const handleOpenAgentSendMenu = useCallback(
    (anchorEl: HTMLElement, targetItems: CanvasItem[]) => {
      if (targetItems.length === 0) return
      setAgentSendMenuAnchor(anchorEl)
      setAgentSendMenuItemIds(targetItems.map((item) => item.id))
    },
    []
  )

  const handleCloseAgentSendMenu = useCallback(() => {
    setAgentSendMenuAnchor(null)
    setAgentSendMenuItemIds([])
  }, [])

  const handleOpenDccExportMenu = useCallback((anchorEl: HTMLElement, itemId: string) => {
    setDccExportMenuAnchor(anchorEl)
    setDccExportMenuItemId(itemId)
  }, [])

  const handleCloseDccExportMenu = useCallback(() => {
    setDccExportMenuAnchor(null)
    setDccExportMenuItemId(null)
  }, [])

  const rejectUnverifiedCroppedExport = useCallback(
    (targetItems: CanvasItem[]) => {
      // The crop does not identify the source version or coordinate system it
      // was created against. Do not render or hand off any part of this batch.
      if (!targetItems.some((item) => item.type === 'image' && item.crop)) return false
      notifyError(t('canvas.export_cropped_image_failed', {
        defaultValue: 'Cannot safely export or copy cropped images yet. Removing the crop exposes the full original.'
      }))
      return true
    },
    [notifyError, t]
  )

  const handleSendCanvasItemsSnapshotToPhotoshop = useCallback(
    async (targetItems: CanvasItem[]) => {
      if (rejectUnverifiedCroppedExport(targetItems)) return
      try {
        const dataUrl = await renderCanvasItemsImageDataUrl(targetItems, false)
        const fileBaseName =
          targetItems.length === 1 && 'fileName' in targetItems[0] && targetItems[0].fileName
            ? targetItems[0].fileName.replace(/\.[^.]+$/, '')
            : 'canvas-selection'

        const response = await api().svcPhotoshop.sendImageToPhotoshop({
          imageUrl: dataUrl,
          fileName: `${sanitizeFilePart(fileBaseName)}-${Date.now()}.png`
        })

        if (response.success) {
          notifySuccess(t('chat.sent_to_photoshop'))
        } else {
          notifyError(
            t('chat.send_to_photoshop_failed', {
              error: response.error || t('chat.unknown_error')
            })
          )
        }
      } catch (error) {
        console.error('Send canvas snapshot to Photoshop failed:', error)
        notifyError(
          t('chat.send_to_photoshop_failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        )
      }
    },
    [notifyError, notifySuccess, rejectUnverifiedCroppedExport, renderCanvasItemsImageDataUrl, t]
  )

  const handleSendCanvasItemsSnapshotToFigma = useCallback(
    async (targetItems: CanvasItem[]) => {
      if (rejectUnverifiedCroppedExport(targetItems)) return
      try {
        const svgMarkup = await renderCanvasItemsSvgMarkup(targetItems, false)
        const clipboardResp = await api().svcHyper.writeSvgToClipboard({
          svg: svgMarkup
        })

        if (!clipboardResp.success) {
          throw new Error('Native clipboard write returned false')
        }

        notifySuccess(t('chat.sent_to_figma_svg'))
      } catch (error) {
        console.error('Send canvas SVG to Figma failed:', error)
        notifyError(
          t('chat.send_to_figma_failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        )
      }
    },
    [notifyError, notifySuccess, rejectUnverifiedCroppedExport, renderCanvasItemsSvgMarkup, t]
  )

  const promptForAdobeBridgeDir = useCallback(
    async (target: AdobeBridgeTarget): Promise<string | null> => {
      const title =
        target === 'after-effects'
          ? 'Select an After Effects bridge folder'
          : 'Select a Premiere Pro bridge folder'

      const dialogResult = await api().svcDialog.showOpenDialog({
        title,
        properties: ['openDirectory', 'createDirectory', 'promptToCreate']
      })

      const selectedPath = dialogResult.filePaths?.[0]
      if (dialogResult.canceled || !selectedPath) {
        return null
      }

      await api().svcState.saveConfig({
        config: {
          adobe_bridge_config:
            target === 'after-effects'
              ? { after_effects_export_dir: selectedPath }
              : { premiere_export_dir: selectedPath }
        }
      })

      return selectedPath
    },
    []
  )

  const buildCanvasItemsAdobeBridgePayload = useCallback(
    async (
      targetItems: CanvasItem[]
    ): Promise<{ fileName: string; data?: Uint8Array; sourceUrl?: string; mimeType: string }> => {
      if (targetItems.length === 1) {
        const targetItem = targetItems[0]
        if (targetItem.type === 'video') {
          let data: Uint8Array | undefined
          if (targetItem.src.startsWith('blob:')) {
            const response = await fetch(targetItem.src)
            data = new Uint8Array(await response.arrayBuffer())
          }
          return {
            fileName: targetItem.fileName,
            sourceUrl: data ? undefined : targetItem.src,
            data,
            mimeType: getCanvasBlobItemMimeType(targetItem)
          }
        }
      }

      const dataUrl = await renderCanvasItemsImageDataUrl(targetItems, false)
      const response = await fetch(dataUrl)
      const data = new Uint8Array(await response.arrayBuffer())
      const fileBaseName =
        targetItems.length === 1 && 'fileName' in targetItems[0] && targetItems[0].fileName
          ? targetItems[0].fileName.replace(/\.[^.]+$/, '')
          : 'canvas-selection'

      return {
        fileName: `${sanitizeFilePart(fileBaseName) || 'canvas-selection'}.png`,
        data,
        mimeType: 'image/png'
      }
    },
    [renderCanvasItemsImageDataUrl]
  )

  const handleExportCanvasItemsToAdobe = useCallback(
    async (
      targetItems: CanvasItem[],
      target: AdobeBridgeTarget,
      promptText: string
    ): Promise<boolean> => {
      if (rejectUnverifiedCroppedExport(targetItems)) return false
      try {
        const configResp = await api().svcState.getConfig({})
        const configuredTargetDir =
          target === 'after-effects'
            ? configResp.config.adobe_bridge_config.after_effects_export_dir
            : configResp.config.adobe_bridge_config.premiere_export_dir

        const targetDir = configuredTargetDir.trim() || (await promptForAdobeBridgeDir(target))
        if (!targetDir) {
          return false
        }

        const payload = await buildCanvasItemsAdobeBridgePayload(targetItems)
        await api().svcAdobeBridge.exportAsset({
          target,
          ...payload,
          sourceLabel: projectName || canvasId || undefined,
          promptText
        })

        notifySuccess(
          `Content sent to ${target === 'after-effects' ? 'After Effects' : 'Premiere Pro'}`
        )
      } catch (error) {
        console.error('[Canvas] Adobe bridge export failed:', error)
        notifyError(
          error instanceof Error
            ? error.message
            : `Failed to send to ${target === 'after-effects' ? 'After Effects' : 'Premiere Pro'}`
        )
      }

      return true
    },
    [
      buildCanvasItemsAdobeBridgePayload,
      canvasId,
      notifyError,
      notifySuccess,
      projectName,
      promptForAdobeBridgeDir,
      rejectUnverifiedCroppedExport
    ]
  )

  const handleSelectAgentTargetApp = useCallback(
    (targetApp: AgentTargetApp) => {
      const targetItems = items.filter((item) => agentSendMenuItemIds.includes(item.id))
      handleCloseAgentSendMenu()
      if (targetItems.length === 0) return

      void (async () => {
        if (targetApp === 'photoshop') {
          await handleSendCanvasItemsSnapshotToPhotoshop(targetItems)
          return
        }

        if (targetApp === 'figma') {
          await handleSendCanvasItemsSnapshotToFigma(targetItems)
          return
        }

        const shouldContinue = await handleExportCanvasItemsToAdobe(
          targetItems,
          targetApp,
          getAgentTargetAppPrompt(targetApp)
        )
        if (!shouldContinue) {
          return
        }
      })()
    },
    [
      agentSendMenuItemIds,
      handleCloseAgentSendMenu,
      handleExportCanvasItemsToAdobe,
      handleSendCanvasItemsSnapshotToFigma,
      handleSendCanvasItemsSnapshotToPhotoshop,
      items
    ]
  )

  const promptForDccExportDir = useCallback(
    async (target: DccBridgeTarget): Promise<string | null> => {
      const title =
        target === 'unity'
          ? 'Select a Unity Assets folder or a subfolder inside Assets'
          : 'Select an Unreal watched source folder for Auto Reimport'

      const dialogResult = await api().svcDialog.showOpenDialog({
        title,
        properties: ['openDirectory', 'createDirectory', 'promptToCreate']
      })

      const selectedPath = dialogResult.filePaths?.[0]
      if (dialogResult.canceled || !selectedPath) {
        return null
      }

      await api().svcState.saveConfig({
        config: {
          dcc_bridge_config:
            target === 'unity'
              ? { unity_export_dir: selectedPath }
              : { unreal_export_dir: selectedPath }
        }
      })

      return selectedPath
    },
    []
  )

  const handleExportCanvasModelToDcc = useCallback(
    async (targetItem: CanvasModel3DItem, target: DccBridgeTarget) => {
      try {
        const configResp = await api().svcState.getConfig({})
        const configuredTargetDir =
          target === 'unity'
            ? configResp.config.dcc_bridge_config.unity_export_dir
            : configResp.config.dcc_bridge_config.unreal_export_dir

        const targetDir = configuredTargetDir.trim() || (await promptForDccExportDir(target))
        if (!targetDir) {
          return
        }

        let modelData: Uint8Array | undefined
        if (targetItem.src.startsWith('blob:')) {
          const response = await fetch(targetItem.src)
          modelData = new Uint8Array(await response.arrayBuffer())
        }

        await api().svcDccBridge.exportModel({
          target,
          fileName: targetItem.fileName,
          sourceUrl: modelData ? undefined : targetItem.src,
          data: modelData,
          sourceLabel: projectName || canvasId || undefined
        })

        notifySuccess(
          `${targetItem.fileName || 'Model'} sent to ${target === 'unity' ? 'Unity' : 'Unreal'}`
        )
      } catch (error) {
        console.error('[Canvas] DCC bridge export failed:', error)
        notifyError(
          error instanceof Error
            ? error.message
            : `Failed to send to ${target === 'unity' ? 'Unity' : 'Unreal'}`
        )
      }
    },
    [canvasId, notifyError, notifySuccess, projectName, promptForDccExportDir]
  )

  const handleSelectDccExportTarget = useCallback(
    (target: DccBridgeTarget) => {
      const targetItem = items.find(
        (item): item is CanvasModel3DItem =>
          item.id === dccExportMenuItemId && item.type === 'model3d'
      )
      handleCloseDccExportMenu()
      if (!targetItem) return
      void handleExportCanvasModelToDcc(targetItem, target)
    },
    [dccExportMenuItemId, handleCloseDccExportMenu, handleExportCanvasModelToDcc, items]
  )

  return {
    agentSendMenuAnchor,
    agentSendMenuItemIds,
    dccExportMenuAnchor,
    dccExportMenuItemId,
    handleSendCanvasItemsToAgent,
    handleOpenAgentSendMenu,
    handleCloseAgentSendMenu,
    handleSelectAgentTargetApp,
    handleSendCanvasItemsSnapshotToPhotoshop,
    handleOpenDccExportMenu,
    handleCloseDccExportMenu,
    handleSelectDccExportTarget
  }
}
