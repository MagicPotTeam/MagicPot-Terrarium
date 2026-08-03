import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../utils/windowUtils'
import { buildCanvasFileContentUpdate } from './canvasAgentAttachmentUtils'
import {
  buildCanvasFileExportSuggestedName,
  buildCanvasGeneratedExportFile,
  getCanvasFileExportDialogTitle,
  getCanvasFileExportExtension,
  normalizeCanvasFileExportTargetPath,
  type CanvasFileExportFormat
} from './canvasFileExportUtils'
import { normalizeOfficeFileNodeDataForCanvas, type CanvasTool } from './projectCanvasPageShared'
import {
  buildSpreadsheetWorkbookPreviewText,
  cloneCanvasFilePreviewSheets,
  resolveOfficeFileNodeData,
  saveSpreadsheetPreviewSheetsToFile
} from './officePreviewUtils'
import type {
  CanvasFileItem,
  CanvasFilePreviewImage,
  CanvasFilePreviewSheet,
  CanvasItem
} from './types'
import { isEditableSpreadsheetCanvasFile, isOfficePreviewableFile } from './types'

type SetCanvasItems = Dispatch<SetStateAction<CanvasItem[]>>
type SetSelectedIds = Dispatch<SetStateAction<Set<string>>>
type SetCanvasTool = Dispatch<SetStateAction<CanvasTool>>
type NotifyFn = (message: string) => unknown

type CanvasFileExportDraft = {
  content?: string
  sheets?: CanvasFilePreviewSheet[]
}

const isBlobObjectUrl = (url: string): boolean => url.startsWith('blob:')

const getOwnedPreviewImageUrlCounts = (
  items: CanvasItem[],
  ownedUrls: ReadonlySet<string>
): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (item.type !== 'file') continue
    for (const image of item.previewImages || []) {
      if (ownedUrls.has(image.src)) counts.set(image.src, (counts.get(image.src) || 0) + 1)
    }
  }
  return counts
}

export const createCanvasFilePreviewUrlLifecycle = (
  revokeObjectUrl: (url: string) => void = URL.revokeObjectURL.bind(URL)
) => {
  let referenceCounts = new Map<string, number>()
  const ownedUrls = new Set<string>()
  const pendingInstallUrls = new Set<string>()
  let itemReferences = new Map<string, Set<string>>()
  let disposed = false

  const revokeOwnedUrl = (url: string) => {
    if (!ownedUrls.delete(url)) return
    pendingInstallUrls.delete(url)
    revokeObjectUrl(url)
  }

  return {
    sync(items: CanvasItem[]) {
      if (disposed) return
      // Ownership is acquired only through claimProduced. Existing blob preview strings may be
      // owned elsewhere and must not be adopted merely because they appear in canvas state.
      const nextReferenceCounts = getOwnedPreviewImageUrlCounts(items, ownedUrls)
      const nextItemReferences = new Map<string, Set<string>>()
      const replacedOrDiscardedUrls = new Set<string>()
      for (const item of items) {
        if (item.type !== 'file') continue
        const nextUrls = new Set(
          (item.previewImages || []).map((image) => image.src).filter((url) => ownedUrls.has(url))
        )
        nextItemReferences.set(item.id, nextUrls)
        const previousUrls = itemReferences.get(item.id)
        if (previousUrls) {
          for (const url of previousUrls) {
            if (!nextUrls.has(url)) replacedOrDiscardedUrls.add(url)
          }
        }
      }
      for (const url of nextReferenceCounts.keys()) pendingInstallUrls.delete(url)
      // Item disappearance can be a transient history/undo state, so only an explicit preview
      // replacement/discard (or final disposal) releases an installed URL.
      for (const url of replacedOrDiscardedUrls) {
        if (!nextReferenceCounts.has(url) && !pendingInstallUrls.has(url)) revokeOwnedUrl(url)
      }
      referenceCounts = nextReferenceCounts
      itemReferences = nextItemReferences
    },
    claimProduced(images: readonly CanvasFilePreviewImage[]): boolean {
      const blobUrls = images.map((image) => image.src).filter(isBlobObjectUrl)
      if (disposed) {
        for (const url of new Set(blobUrls)) revokeObjectUrl(url)
        return false
      }
      for (const url of blobUrls) {
        ownedUrls.add(url)
        pendingInstallUrls.add(url)
      }
      return true
    },
    settleProduced(images: readonly CanvasFilePreviewImage[], installed: boolean) {
      if (installed || disposed) return
      for (const url of new Set(images.map((image) => image.src).filter(isBlobObjectUrl))) {
        pendingInstallUrls.delete(url)
        if (!referenceCounts.has(url)) revokeOwnedUrl(url)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const url of [...ownedUrls]) revokeOwnedUrl(url)
      referenceCounts.clear()
      itemReferences.clear()
    }
  }
}

type UseCanvasFilePreviewOptions = {
  items: CanvasItem[]
  setItems: SetCanvasItems
  setItemsWithHistory: SetCanvasItems
  setSelectedIds: SetSelectedIds
  setTool: SetCanvasTool
  notifySuccess: NotifyFn
  notifyError: NotifyFn
}

export function useCanvasFilePreview({
  items,
  setItems,
  setItemsWithHistory,
  setSelectedIds,
  setTool,
  notifySuccess,
  notifyError
}: UseCanvasFilePreviewOptions) {
  const { i18n } = useTranslation()
  const [activeFileDialogId, setActiveFileDialogId] = useState<string | null>(null)
  const [fileDialogDraftContent, setFileDialogDraftContent] = useState('')
  const [fileDialogDraftSheets, setFileDialogDraftSheets] = useState<CanvasFilePreviewSheet[]>([])
  const attemptedOfficePreviewHydrationsRef = useRef<Set<string>>(new Set())
  const previewUrlLifecycleRef = useRef<ReturnType<
    typeof createCanvasFilePreviewUrlLifecycle
  > | null>(null)
  const previewUrlTeardownRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentItemsRef = useRef(items)
  currentItemsRef.current = items

  useEffect(() => {
    if (previewUrlTeardownRef.current !== null) {
      clearTimeout(previewUrlTeardownRef.current)
      previewUrlTeardownRef.current = null
    }
    const lifecycle =
      previewUrlLifecycleRef.current ||
      (previewUrlLifecycleRef.current = createCanvasFilePreviewUrlLifecycle())
    lifecycle.sync(currentItemsRef.current)
    return () => {
      // StrictMode immediately replays this effect. Defer disposal so that replay can retain the
      // lifecycle, while a real unmount leaves the same disposed instance visible to async work.
      previewUrlTeardownRef.current = setTimeout(() => {
        lifecycle.dispose()
        previewUrlTeardownRef.current = null
      }, 0)
    }
  }, [])

  useEffect(() => {
    previewUrlLifecycleRef.current?.sync(items)
  }, [items])

  const activeFileDialogItem = useMemo<CanvasFileItem | null>(() => {
    if (!activeFileDialogId) return null
    const matchedItem = items.find((item) => item.id === activeFileDialogId)
    return matchedItem?.type === 'file' ? matchedItem : null
  }, [activeFileDialogId, items])

  useEffect(() => {
    if (!activeFileDialogId) {
      setFileDialogDraftContent('')
      setFileDialogDraftSheets([])
      return
    }

    if (!activeFileDialogItem) {
      setActiveFileDialogId(null)
      setFileDialogDraftContent('')
      setFileDialogDraftSheets([])
      return
    }

    setFileDialogDraftContent(
      activeFileDialogItem.content ?? activeFileDialogItem.previewText ?? ''
    )
    setFileDialogDraftSheets(cloneCanvasFilePreviewSheets(activeFileDialogItem.previewSheets))
  }, [activeFileDialogId, activeFileDialogItem])

  const hydrateCanvasOfficePreview = useCallback(
    async (fileItem: CanvasFileItem) => {
      if (fileItem.editable) return
      if (!isOfficePreviewableFile(fileItem.fileName)) return

      const hasExistingPreviewText = Boolean(fileItem.previewText?.trim())
      const hasExistingPreviewImages = (fileItem.previewImages?.length || 0) > 0
      const hasExistingPreviewSheets = (fileItem.previewSheets?.length || 0) > 0
      if (
        fileItem.fileKind === 'excel'
          ? hasExistingPreviewSheets
          : hasExistingPreviewText && hasExistingPreviewImages
      ) {
        return
      }

      if (attemptedOfficePreviewHydrationsRef.current.has(fileItem.id)) {
        return
      }
      attemptedOfficePreviewHydrationsRef.current.add(fileItem.id)
      const previewUrlLifecycle = previewUrlLifecycleRef.current
      if (!previewUrlLifecycle) return

      try {
        const response = await fetch(fileItem.src)
        if (!response.ok) return

        const blob = await response.blob()
        const hydratedFile = new File([blob], fileItem.fileName, {
          type: fileItem.mimeType
        })
        const nextPreviewData = normalizeOfficeFileNodeDataForCanvas(
          await resolveOfficeFileNodeData(hydratedFile)
        )
        const producedPreviewImages = nextPreviewData.previewImages || []
        if (!previewUrlLifecycle.claimProduced(producedPreviewImages)) return
        const hasResolvedPreviewText = Boolean(nextPreviewData.previewText?.trim())
        const hasResolvedPreviewImages = (nextPreviewData.previewImages?.length || 0) > 0
        const hasResolvedPreviewSheets = (nextPreviewData.previewSheets?.length || 0) > 0

        if (
          (!hasExistingPreviewSheets && hasResolvedPreviewSheets) ||
          (!hasExistingPreviewText && hasResolvedPreviewText) ||
          (!hasExistingPreviewImages && hasResolvedPreviewImages)
        ) {
          setItems((prev) => {
            let installed = false
            const nextItems = prev.map((item) => {
              if (item.id !== fileItem.id || item.type !== 'file') return item
              installed = true
              return { ...item, ...nextPreviewData }
            }) as CanvasItem[]
            previewUrlLifecycle.settleProduced(producedPreviewImages, installed)
            return nextItems
          })
        } else {
          previewUrlLifecycle.settleProduced(producedPreviewImages, false)
        }
      } catch (error) {
        console.warn('[ProjectCanvasPage] Failed to hydrate file preview assets:', error)
      }
    },
    [setItems]
  )

  useEffect(() => {
    const pendingOfficeFiles = items.filter((item): item is CanvasFileItem => {
      if (item.type !== 'file' || item.editable || !isOfficePreviewableFile(item.fileName)) {
        return false
      }

      if (item.fileKind === 'excel') {
        return (item.previewSheets?.length || 0) === 0
      }

      return !item.previewText?.trim() || (item.previewImages?.length || 0) === 0
    })

    for (const fileItem of pendingOfficeFiles) {
      void hydrateCanvasOfficePreview(fileItem)
    }
  }, [hydrateCanvasOfficePreview, items])

  useEffect(() => {
    if (!activeFileDialogItem) return
    void hydrateCanvasOfficePreview(activeFileDialogItem)
  }, [activeFileDialogItem, hydrateCanvasOfficePreview])

  const handleOpenFileDialog = useCallback(
    (itemId: string) => {
      setSelectedIds(new Set([itemId]))
      setTool('select')
      setActiveFileDialogId(itemId)
    },
    [setSelectedIds, setTool]
  )

  const handleCloseFileDialog = useCallback(() => {
    setActiveFileDialogId(null)
    setFileDialogDraftContent('')
    setFileDialogDraftSheets([])
  }, [])

  const resolveExportableFile = useCallback(
    async (fileItem: CanvasFileItem, draft?: CanvasFileExportDraft): Promise<File> => {
      if (isEditableSpreadsheetCanvasFile(fileItem.fileName)) {
        const normalizedDraftSheets = cloneCanvasFilePreviewSheets(
          draft?.sheets ?? fileItem.previewSheets
        )
        const currentPreviewSheets = cloneCanvasFilePreviewSheets(fileItem.previewSheets)
        const response = await fetch(fileItem.src)
        if (!response.ok) {
          throw new Error(`Failed to read spreadsheet blob: ${response.status}`)
        }

        const sourceBlob = await response.blob()
        const sourceFile = new File([sourceBlob], fileItem.fileName, {
          type: fileItem.mimeType
        })

        if (JSON.stringify(normalizedDraftSheets) === JSON.stringify(currentPreviewSheets)) {
          return sourceFile
        }

        return saveSpreadsheetPreviewSheetsToFile(
          sourceFile,
          currentPreviewSheets,
          normalizedDraftSheets
        )
      }

      if (fileItem.editable) {
        const normalizedDraft = (
          draft?.content ??
          fileItem.content ??
          fileItem.previewText ??
          ''
        ).replace(/\r\n/g, '\n')
        return new File([normalizedDraft], fileItem.fileName, {
          type: fileItem.mimeType
        })
      }

      const response = await fetch(fileItem.src)
      if (!response.ok) {
        throw new Error(`Failed to read file blob: ${response.status}`)
      }

      const sourceBlob = await response.blob()
      return new File([sourceBlob], fileItem.fileName, {
        type: fileItem.mimeType
      })
    },
    []
  )

  const exportFileToDisk = useCallback(
    async (exportFile: File) => {
      const parsedName = window.path.parse(exportFile.name)
      const suggestedName = `${parsedName.name || 'document'}-export${parsedName.ext}`
      const extension = window.path.extname(exportFile.name).replace(/^\./, '').toLowerCase()
      const result = await api().svcDialog.showSaveDialog({
        title: isEditableSpreadsheetCanvasFile(exportFile.name)
          ? i18n.resolvedLanguage?.toLowerCase().startsWith('zh')
            ? '导出表格文件'
            : 'Export spreadsheet file'
          : i18n.resolvedLanguage?.toLowerCase().startsWith('zh')
            ? '导出文件'
            : 'Export file',
        defaultPath: suggestedName,
        filters: extension
          ? [{ name: `${extension.toUpperCase()} File`, extensions: [extension] }]
          : undefined
      })

      if (result.canceled || !result.filePath) {
        return
      }

      const data = new Uint8Array(await exportFile.arrayBuffer())
      await api().svcFs.saveImageToPath({
        image: data,
        outputPath: window.path.dirname(result.filePath),
        filename: window.path.basename(result.filePath)
      })

      notifySuccess(`Exported ${window.path.basename(result.filePath)}`)
    },
    [i18n.resolvedLanguage, notifySuccess]
  )

  const resolveDocumentExportText = useCallback(
    async (fileItem: CanvasFileItem, draft?: CanvasFileExportDraft): Promise<string> => {
      if (fileItem.editable) {
        return (draft?.content ?? fileItem.content ?? fileItem.previewText ?? '').replace(
          /\r\n/g,
          '\n'
        )
      }

      const existingText = fileItem.content ?? fileItem.previewText
      if (typeof existingText === 'string' && existingText.length > 0) {
        return existingText.replace(/\r\n/g, '\n')
      }

      const response = await fetch(fileItem.src)
      if (!response.ok) {
        throw new Error(`Failed to read file blob: ${response.status}`)
      }

      const sourceBlob = await response.blob()
      const sourceFile = new File([sourceBlob], fileItem.fileName, {
        type: fileItem.mimeType
      })
      const nextPreviewData = await resolveOfficeFileNodeData(sourceFile)
      const resolvedText = nextPreviewData.content ?? nextPreviewData.previewText ?? ''

      if (!resolvedText.trim()) {
        throw new Error('No extractable document text is available for export')
      }

      return resolvedText.replace(/\r\n/g, '\n')
    },
    []
  )

  const handleExportCanvasFile = useCallback(
    async (fileItem: CanvasFileItem, format: CanvasFileExportFormat = 'original') => {
      try {
        const activeDraft =
          activeFileDialogItem?.id === fileItem.id
            ? {
                content: fileDialogDraftContent,
                sheets: fileDialogDraftSheets
              }
            : undefined

        if (format !== 'original') {
          const suggestedName = buildCanvasFileExportSuggestedName(fileItem, format)
          const extension = getCanvasFileExportExtension(format, fileItem).replace(/^\./, '')
          const result = await api().svcDialog.showSaveDialog({
            title: getCanvasFileExportDialogTitle(format, i18n.resolvedLanguage || i18n.language),
            defaultPath: suggestedName,
            filters: extension
              ? [
                  {
                    name: extension.toUpperCase(),
                    extensions: [extension]
                  }
                ]
              : undefined
          })

          if (result.canceled || !result.filePath) {
            return
          }

          const targetPath = normalizeCanvasFileExportTargetPath(result.filePath, format, fileItem)
          const exportFile = await buildCanvasGeneratedExportFile(
            await resolveDocumentExportText(fileItem, activeDraft),
            window.path.basename(targetPath),
            format
          )
          const data = new Uint8Array(await exportFile.arrayBuffer())

          await api().svcFs.saveImageToPath({
            image: data,
            outputPath: window.path.dirname(targetPath),
            filename: window.path.basename(targetPath)
          })

          notifySuccess(`Exported ${window.path.basename(targetPath)}`)
          return
        }

        const exportFile = await resolveExportableFile(fileItem, {
          content: activeDraft?.content,
          sheets: activeDraft?.sheets
        })
        await exportFileToDisk(exportFile)
      } catch (error) {
        console.error('[ProjectCanvasPage] Failed to export file preview asset:', error)
        notifyError(
          `Failed to export file: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    [
      activeFileDialogItem?.id,
      exportFileToDisk,
      fileDialogDraftContent,
      fileDialogDraftSheets,
      notifyError,
      notifySuccess,
      i18n.language,
      i18n.resolvedLanguage,
      resolveDocumentExportText,
      resolveExportableFile
    ]
  )

  const handleSaveFileDialog = useCallback(async () => {
    if (!activeFileDialogItem) {
      handleCloseFileDialog()
      return
    }

    if (isEditableSpreadsheetCanvasFile(activeFileDialogItem.fileName)) {
      const normalizedDraftSheets = cloneCanvasFilePreviewSheets(fileDialogDraftSheets)
      const currentPreviewSheets = cloneCanvasFilePreviewSheets(activeFileDialogItem.previewSheets)

      if (JSON.stringify(normalizedDraftSheets) === JSON.stringify(currentPreviewSheets)) {
        handleCloseFileDialog()
        return
      }

      try {
        const response = await fetch(activeFileDialogItem.src)
        if (!response.ok) {
          throw new Error(`Failed to read spreadsheet blob: ${response.status}`)
        }

        const sourceBlob = await response.blob()
        const sourceFile = new File([sourceBlob], activeFileDialogItem.fileName, {
          type: activeFileDialogItem.mimeType
        })
        const nextFile = await saveSpreadsheetPreviewSheetsToFile(
          sourceFile,
          currentPreviewSheets,
          normalizedDraftSheets
        )
        const previousSrc = activeFileDialogItem.src
        const nextBlobUrl = URL.createObjectURL(nextFile)

        setItemsWithHistory(
          (prev) =>
            prev.map((item) =>
              item.id === activeFileDialogItem.id && item.type === 'file'
                ? {
                    ...item,
                    src: nextBlobUrl,
                    mimeType: nextFile.type || activeFileDialogItem.mimeType,
                    sizeBytes: nextFile.size,
                    previewText:
                      buildSpreadsheetWorkbookPreviewText(normalizedDraftSheets) || undefined,
                    previewSheets:
                      normalizedDraftSheets.length > 0 ? normalizedDraftSheets : undefined,
                    content: undefined
                  }
                : item
            ) as CanvasItem[]
        )

        if (previousSrc.startsWith('blob:')) {
          URL.revokeObjectURL(previousSrc)
        }
      } catch (error) {
        console.warn('[ProjectCanvasPage] Failed to save spreadsheet preview edits:', error)
      }

      handleCloseFileDialog()
      return
    }

    if (!activeFileDialogItem.editable) {
      handleCloseFileDialog()
      return
    }

    const normalizedDraft = fileDialogDraftContent.replace(/\r\n/g, '\n')
    const currentContent = (
      activeFileDialogItem.content ??
      activeFileDialogItem.previewText ??
      ''
    ).replace(/\r\n/g, '\n')

    if (normalizedDraft === currentContent) {
      handleCloseFileDialog()
      return
    }

    const previousSrc = activeFileDialogItem.src
    const nextBlobUrl = URL.createObjectURL(
      new Blob([normalizedDraft], { type: activeFileDialogItem.mimeType })
    )
    const updates = buildCanvasFileContentUpdate(activeFileDialogItem, normalizedDraft, nextBlobUrl)

    setItemsWithHistory(
      (prev) =>
        prev.map((item) =>
          item.id === activeFileDialogItem.id && item.type === 'file'
            ? { ...item, ...updates }
            : item
        ) as CanvasItem[]
    )

    if (previousSrc.startsWith('blob:')) {
      URL.revokeObjectURL(previousSrc)
    }

    handleCloseFileDialog()
  }, [
    activeFileDialogItem,
    fileDialogDraftContent,
    fileDialogDraftSheets,
    handleCloseFileDialog,
    setItemsWithHistory
  ])

  return {
    activeFileDialogItem,
    fileDialogDraftContent,
    fileDialogDraftSheets,
    setFileDialogDraftContent,
    setFileDialogDraftSheets,
    handleOpenFileDialog,
    handleCloseFileDialog,
    handleSaveFileDialog,
    handleExportCanvasFile
  }
}
