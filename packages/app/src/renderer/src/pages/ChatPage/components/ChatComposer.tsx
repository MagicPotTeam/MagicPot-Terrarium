import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Box,
  TextField,
  Typography,
  IconButton,
  CircularProgress,
  useTheme,
  Chip,
  Divider,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem
} from '@mui/material'
import {
  Send as SendIcon,
  Add as AddIcon,
  Close as CloseIcon,
  Stop as StopIcon,
  AttachFileOutlined as AttachFileIcon,
  ArticleOutlined as TextFileIcon,
  DescriptionOutlined as WordFileIcon,
  FolderZipOutlined as ArchiveFileIcon,
  PictureAsPdfOutlined as PdfFileIcon,
  Videocam as VideoIcon,
  ViewInAr as Model3DIcon,
  InsertDriveFile as FileIcon,
  SlideshowOutlined as PowerPointFileIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { ChatAttachment } from '../../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { normalizeLocalMediaUrl } from '../chatPageShared'
import {
  buildToolCommandExample,
  buildToolInputSchemaSummary,
  parseExplicitToolCommand,
  validateToolCommandArgs
} from '../chatToolExecution'
import {
  buildFileMetaLabel,
  detectDisplayFileKind,
  getFileBadgeText
} from '@renderer/utils/fileDisplay'
import { getDroppedTextContent } from '@renderer/utils/droppedImageUtils'
import { getVisibleChatAttachmentEntries } from '../chatAttachmentVisibility'
import type { MagicPotAppToolDescriptor } from '@shared/app/types'

interface ChatComposerProps {
  inputValue: string
  onInputChange: (value: string) => void
  onSend: () => void
  onUploadFile: () => void
  pendingAttachments: ChatAttachment[]
  uploadProgress: { [key: number]: number }
  onRemoveAttachment: (index: number) => void
  isLoading: boolean
  onStopGenerating: () => void
  disabled: boolean
  composerInputRef: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  onPreviewImage: (url: string) => void
  selectedSkillName?: string
  onClearSkill?: () => void
  addMenuSlot?: (closeMenu: () => void) => React.ReactNode
  modelSelectorSlot?: React.ReactNode
  toolbarSlot?: React.ReactNode
  statusSlot?: React.ReactNode
  toolHelpItems?: MagicPotAppToolDescriptor[]
  active?: boolean
}

const renderFileAttachmentIcon = (attachment: ChatAttachment) => {
  const kind = detectDisplayFileKind(attachment.fileName, attachment.mimeType)

  switch (kind) {
    case 'markdown':
    case 'text':
      return <TextFileIcon sx={{ fontSize: 24, color: '#38bdf8' }} />
    case 'word':
      return <WordFileIcon sx={{ fontSize: 24, color: '#60a5fa' }} />
    case 'powerpoint':
      return <PowerPointFileIcon sx={{ fontSize: 24, color: '#fb923c' }} />
    case 'pdf':
      return <PdfFileIcon sx={{ fontSize: 24, color: '#f87171' }} />
    case 'archive':
      return <ArchiveFileIcon sx={{ fontSize: 24, color: '#c084fc' }} />
    default:
      return <FileIcon sx={{ fontSize: 24, color: 'text.secondary' }} />
  }
}

/**
 * Minimum textarea height in px.
 */
const MIN_TEXTAREA_HEIGHT = 24
const COMPOSER_VERTICAL_OVERHEAD = 140
const MIN_ATTACHMENT_PREVIEW_HEIGHT = 88
const MAX_ATTACHMENT_PREVIEW_HEIGHT = 240
const ATTACHMENT_PREVIEW_HEIGHT_RATIO = 0.32

type InputSelectionSnapshot = {
  value: string
  start: number
  end: number
  direction: 'forward' | 'backward' | 'none'
}

const normalizeInputSelectionDirection = (
  direction: HTMLInputElement['selectionDirection']
): InputSelectionSnapshot['direction'] =>
  direction === 'forward' || direction === 'backward' ? direction : 'none'

const readInputSelectionSnapshot = (
  input: HTMLInputElement | HTMLTextAreaElement
): InputSelectionSnapshot => {
  const fallbackSelection = input.value.length
  return {
    value: input.value,
    start: input.selectionStart ?? fallbackSelection,
    end: input.selectionEnd ?? fallbackSelection,
    direction: normalizeInputSelectionDirection(input.selectionDirection)
  }
}

const inferSelectionFromValueDiff = (
  previousValue: string,
  nextValue: string
): InputSelectionSnapshot | null => {
  if (previousValue === nextValue) {
    return null
  }

  let prefixLength = 0
  while (
    prefixLength < previousValue.length &&
    prefixLength < nextValue.length &&
    previousValue[prefixLength] === nextValue[prefixLength]
  ) {
    prefixLength += 1
  }

  let previousSuffixIndex = previousValue.length
  let nextSuffixIndex = nextValue.length
  while (
    previousSuffixIndex > prefixLength &&
    nextSuffixIndex > prefixLength &&
    previousValue[previousSuffixIndex - 1] === nextValue[nextSuffixIndex - 1]
  ) {
    previousSuffixIndex -= 1
    nextSuffixIndex -= 1
  }

  const insertedLength = Math.max(0, nextSuffixIndex - prefixLength)
  const inferredPosition = prefixLength + insertedLength
  return {
    value: nextValue,
    start: inferredPosition,
    end: inferredPosition,
    direction: 'none'
  }
}

const inferSelectionAfterControlledInputChange = (
  previousValue: string,
  previousSelection: InputSelectionSnapshot | null,
  nextValue: string,
  rawSelection: InputSelectionSnapshot
): InputSelectionSnapshot => {
  const rawSelectionAtEnd =
    rawSelection.start === nextValue.length && rawSelection.end === nextValue.length
  if (!rawSelectionAtEnd || previousValue === nextValue) {
    return rawSelection
  }

  if (
    previousSelection?.value === previousValue &&
    previousSelection.start < previousValue.length
  ) {
    const prefix = previousValue.slice(0, previousSelection.start)
    const suffix = previousValue.slice(previousSelection.end)
    if (nextValue.startsWith(prefix) && nextValue.endsWith(suffix)) {
      const insertedLength = nextValue.length - prefix.length - suffix.length
      if (insertedLength >= 0) {
        const inferredPosition = prefix.length + insertedLength
        return {
          value: nextValue,
          start: inferredPosition,
          end: inferredPosition,
          direction: 'none'
        }
      }
    }
  }

  return inferSelectionFromValueDiff(previousValue, nextValue) ?? rawSelection
}

const buildToolCommandDraft = (tool: MagicPotAppToolDescriptor): string =>
  tool.inputSchema ? buildToolCommandExample(tool) : `/tool ${tool.name}`

const rankToolHelpItems = (
  items: MagicPotAppToolDescriptor[],
  requestedToolName: string | undefined
): MagicPotAppToolDescriptor[] => {
  const normalizedQuery = requestedToolName?.trim().toLowerCase() || ''
  if (!normalizedQuery) {
    return items
  }

  return [...items].sort((left, right) => {
    const leftName = left.name.toLowerCase()
    const rightName = right.name.toLowerCase()
    const leftExact = leftName === normalizedQuery ? 0 : 1
    const rightExact = rightName === normalizedQuery ? 0 : 1
    if (leftExact !== rightExact) {
      return leftExact - rightExact
    }

    const leftPrefix = leftName.startsWith(normalizedQuery) ? 0 : 1
    const rightPrefix = rightName.startsWith(normalizedQuery) ? 0 : 1
    if (leftPrefix !== rightPrefix) {
      return leftPrefix - rightPrefix
    }

    return leftName.localeCompare(rightName)
  })
}

const ChatComposer: React.FC<ChatComposerProps> = ({
  inputValue,
  onInputChange,
  onSend,
  onUploadFile,
  pendingAttachments,
  uploadProgress,
  onRemoveAttachment,
  isLoading,
  onStopGenerating,
  disabled,
  composerInputRef,
  onPreviewImage,
  selectedSkillName,
  onClearSkill,
  addMenuSlot,
  modelSelectorSlot,
  toolbarSlot,
  statusSlot,
  toolHelpItems = [],
  active = true
}) => {
  const { t } = useTranslation()
  const visiblePendingAttachmentEntries = getVisibleChatAttachmentEntries(pendingAttachments)
  const theme = useTheme()
  const resolvedToolbarSlot = modelSelectorSlot ?? toolbarSlot

  const composerRootRef = useRef<HTMLDivElement | null>(null)
  const committedInputValueRef = useRef(inputValue)
  const isComposingInputRef = useRef(false)
  const latestInputSelectionRef = useRef<InputSelectionSnapshot | null>(null)
  const pendingInputSelectionRef = useRef<InputSelectionSnapshot | null>(null)
  const beforeInputSelectionRef = useRef<InputSelectionSnapshot | null>(null)
  const [addMenuAnchorEl, setAddMenuAnchorEl] = useState<HTMLElement | null>(null)
  const [textareaMaxHeight, setTextareaMaxHeight] = useState<number | undefined>(undefined)
  const [attachmentPreviewMaxHeight, setAttachmentPreviewMaxHeight] = useState<number | undefined>(
    undefined
  )

  useEffect(() => {
    committedInputValueRef.current = inputValue
  }, [inputValue])

  useEffect(() => {
    if (active) return
    setAddMenuAnchorEl(null)
  }, [active])

  const recalcMaxHeight = useCallback(() => {
    const root = composerRootRef.current
    if (!root) return

    const flexCol = root.parentElement
    if (!flexCol) return

    const parentRect = flexCol.getBoundingClientRect()
    // The composer sits at the bottom of a flex column. When content grows, the
    // message list above can shrink, so the textarea should be capped by the
    // panel height instead of the composer's current rendered height.
    const maxHeight = Math.max(MIN_TEXTAREA_HEIGHT, parentRect.height - COMPOSER_VERTICAL_OVERHEAD)
    const nextAttachmentPreviewMaxHeight = Math.min(
      MAX_ATTACHMENT_PREVIEW_HEIGHT,
      Math.max(
        MIN_ATTACHMENT_PREVIEW_HEIGHT,
        Math.floor(parentRect.height * ATTACHMENT_PREVIEW_HEIGHT_RATIO)
      )
    )

    setTextareaMaxHeight(maxHeight)
    setAttachmentPreviewMaxHeight(nextAttachmentPreviewMaxHeight)
  }, [])

  useLayoutEffect(() => {
    recalcMaxHeight()

    window.addEventListener('resize', recalcMaxHeight)

    let observer: ResizeObserver | undefined
    const root = composerRootRef.current
    const observed = root?.parentElement
    if (observed && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(recalcMaxHeight)
      observer.observe(observed)
    }

    return () => {
      window.removeEventListener('resize', recalcMaxHeight)
      observer?.disconnect()
    }
  }, [recalcMaxHeight])

  useLayoutEffect(() => {
    recalcMaxHeight()
  }, [visiblePendingAttachmentEntries.length, recalcMaxHeight])

  const restoreInputSelection = useCallback(
    (selection: InputSelectionSnapshot) => {
      const input = composerInputRef.current
      if (!input || document.activeElement !== input || input.value !== selection.value)
        return false

      const maxPosition = input.value.length
      const nextSelection = {
        ...selection,
        start: Math.min(selection.start, maxPosition),
        end: Math.min(selection.end, maxPosition)
      }

      input.setSelectionRange(nextSelection.start, nextSelection.end, nextSelection.direction)
      latestInputSelectionRef.current = nextSelection
      return true
    },
    [composerInputRef]
  )

  useLayoutEffect(() => {
    const pendingSelection = pendingInputSelectionRef.current
    const selection = pendingSelection ?? latestInputSelectionRef.current
    if (!selection) return

    pendingInputSelectionRef.current = null
    const input = composerInputRef.current
    if (!input || document.activeElement !== input) return
    if (!pendingSelection && (isComposingInputRef.current || input.value !== selection.value))
      return

    restoreInputSelection(selection)
    if (!pendingSelection || typeof window.requestAnimationFrame !== 'function') return

    const frameId = window.requestAnimationFrame(() => {
      restoreInputSelection(selection)
    })

    return () => window.cancelAnimationFrame(frameId)
  })

  const handleInputSelectionChange = (
    event: React.SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    latestInputSelectionRef.current = readInputSelectionSnapshot(event.currentTarget)
  }

  const handleBeforeInput = (event: React.FormEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    beforeInputSelectionRef.current = readInputSelectionSnapshot(event.currentTarget)
  }

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const previousValue = committedInputValueRef.current
    const nextValue = event.target.value
    const selectionBeforeInput =
      beforeInputSelectionRef.current?.value === previousValue
        ? beforeInputSelectionRef.current
        : null
    beforeInputSelectionRef.current = null
    const nextSelection = inferSelectionAfterControlledInputChange(
      previousValue,
      selectionBeforeInput ?? latestInputSelectionRef.current,
      nextValue,
      readInputSelectionSnapshot(event.target)
    )
    committedInputValueRef.current = nextValue
    latestInputSelectionRef.current = nextSelection
    pendingInputSelectionRef.current = nextSelection
    onInputChange(nextValue)
  }

  const handleCompositionStart = () => {
    isComposingInputRef.current = true
  }

  const handleCompositionEnd = (
    event: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    isComposingInputRef.current = false
    latestInputSelectionRef.current = readInputSelectionSnapshot(event.currentTarget)
  }

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSend()
    }
  }

  const handleInputDragOver = (event: React.DragEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (disabled) return
    if (!getDroppedTextContent(event.dataTransfer)) return

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleInputDrop = (event: React.DragEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (disabled) return

    const droppedText = getDroppedTextContent(event.dataTransfer)
    if (!droppedText) return

    event.preventDefault()
    event.stopPropagation()

    const target = event.currentTarget
    const baseValue = target.value ?? committedInputValueRef.current
    const selectionStart =
      typeof target.selectionStart === 'number' ? target.selectionStart : baseValue.length
    const selectionEnd =
      typeof target.selectionEnd === 'number' ? target.selectionEnd : selectionStart
    const nextValue =
      baseValue.slice(0, selectionStart) + droppedText + baseValue.slice(selectionEnd)
    const nextSelectionPosition = selectionStart + droppedText.length
    const nextSelection: InputSelectionSnapshot = {
      value: nextValue,
      start: nextSelectionPosition,
      end: nextSelectionPosition,
      direction: 'none'
    }

    committedInputValueRef.current = nextValue
    latestInputSelectionRef.current = nextSelection
    pendingInputSelectionRef.current = nextSelection
    onInputChange(nextValue)

    const restoreDropSelection = () => {
      if (document.activeElement !== target) {
        target.focus()
      }
      if (target.value === nextValue) {
        target.setSelectionRange(nextSelectionPosition, nextSelectionPosition)
      }
    }

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(restoreDropSelection)
    } else {
      restoreDropSelection()
    }
  }

  const handleInsertToolCommand = (tool: MagicPotAppToolDescriptor) => {
    onInputChange(buildToolCommandDraft(tool))
    composerInputRef.current?.focus()
  }

  const closeAddMenu = () => {
    setAddMenuAnchorEl(null)
  }

  const handleUploadFileFromMenu = () => {
    closeAddMenu()
    onUploadFile()
  }

  const resolvedTextareaMaxHeight = textareaMaxHeight != null ? `${textareaMaxHeight}px` : '40vh'
  const resolvedAttachmentPreviewMaxHeight =
    attachmentPreviewMaxHeight != null ? `${attachmentPreviewMaxHeight}px` : '32vh'
  const isToolCommandMode = inputValue.trimStart().startsWith('/tool')
  const requestedToolName = inputValue
    .trimStart()
    .match(/^\/tool\s+([a-z0-9._-]+)/i)?.[1]
    ?.trim()
  const selectedToolHelpItem =
    requestedToolName && toolHelpItems.length > 0
      ? toolHelpItems.find((tool) => tool.name === requestedToolName) || null
      : null
  const parsedToolCommand = isToolCommandMode ? parseExplicitToolCommand(inputValue) : null
  const selectedToolInputSchemaSummary = selectedToolHelpItem
    ? buildToolInputSchemaSummary(selectedToolHelpItem)
    : undefined
  const selectedToolValidationMessage =
    isToolCommandMode && parsedToolCommand
      ? selectedToolHelpItem
        ? validateToolCommandArgs(selectedToolHelpItem, parsedToolCommand.args)
        : `No bound tool matches "${parsedToolCommand.toolName}".`
      : null
  const toolHelpSummary = toolHelpItems
    .slice(0, 3)
    .map((tool) => tool.name)
    .join(', ')
  const remainingToolHelpCount = Math.max(0, toolHelpItems.length - 3)
  const filteredToolHelpItems = isToolCommandMode
    ? rankToolHelpItems(
        toolHelpItems.filter((tool) =>
          requestedToolName
            ? tool.name.toLowerCase().includes(requestedToolName.toLowerCase())
            : true
        ),
        requestedToolName
      )
    : []

  return (
    <Box
      ref={composerRootRef}
      data-testid="chat-composer-root"
      sx={{
        bgcolor: theme.palette.mode === 'light' ? 'transparent' : undefined,
        display: 'flex',
        flexDirection: 'column',
        width: '100%'
      }}
    >
      <Box sx={{ width: '100%', px: 1.5, pb: 2 }}>
        <Box
          sx={(theme) => ({
            display: 'flex',
            flexDirection: 'column',
            bgcolor: theme.palette.mode === 'dark' ? '#252628' : '#ffffff',
            borderRadius: 3.5,
            p: { xs: 1, md: 1.5 },
            border: '1px solid',
            borderColor:
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
            boxShadow:
              theme.palette.mode === 'dark'
                ? '0 8px 32px rgba(0,0,0,0.4)'
                : '0 8px 32px rgba(0,0,0,0.08)',
            transition: 'border-color 0.2s, background-color 0.2s',
            '&:focus-within': {
              borderColor:
                theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
              bgcolor: theme.palette.mode === 'dark' ? '#2a2b2d' : '#ffffff'
            }
          })}
        >
          {/* 待上传附件预览 */}
          {visiblePendingAttachmentEntries.length > 0 && (
            <Box
              data-testid="chat-composer-attachments"
              sx={{
                mb: 1,
                display: 'flex',
                gap: 1,
                flexWrap: 'wrap',
                alignContent: 'flex-start',
                maxHeight: resolvedAttachmentPreviewMaxHeight,
                overflowY: 'auto',
                overflowX: 'hidden',
                pr: 0.5
              }}
            >
              {visiblePendingAttachmentEntries.map(({ attachment, originalIndex }, idx) => {
                const progress = uploadProgress[originalIndex]
                return (
                  <Box
                    key={idx}
                    sx={{
                      position: 'relative',
                      width: 80,
                      height: 80,
                      borderRadius: 1,
                      overflow: 'hidden',
                      border: 1,
                      borderColor: 'divider'
                    }}
                  >
                    {attachment.type === 'image' ? (
                      <img
                        src={normalizeLocalMediaUrl(attachment.url)}
                        alt={t('chat.preview_alt_index', { index: idx + 1 })}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          cursor: 'pointer'
                        }}
                        loading="lazy"
                        onClick={() => onPreviewImage(attachment.url)}
                      />
                    ) : attachment.type === 'video' ? (
                      <Box
                        sx={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          bgcolor: 'background.paper',
                          gap: 0.5
                        }}
                      >
                        <VideoIcon sx={{ fontSize: 24, color: 'text.secondary' }} />
                        {progress !== undefined && progress < 100 && <CircularProgress size={16} />}
                      </Box>
                    ) : attachment.type === 'model3d' ? (
                      <Box
                        sx={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          bgcolor: 'background.paper',
                          gap: 0.5
                        }}
                      >
                        <Model3DIcon sx={{ fontSize: 24, color: 'text.secondary' }} />
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontSize: '0.6rem' }}
                        >
                          3D
                        </Typography>
                        {progress !== undefined && progress < 100 && <CircularProgress size={16} />}
                      </Box>
                    ) : attachment.type === 'file' ? (
                      <Box
                        sx={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          bgcolor: 'background.paper',
                          gap: 0.5
                        }}
                      >
                        {renderFileAttachmentIcon(attachment)}
                        <Typography
                          variant="caption"
                          color="primary"
                          sx={{ fontSize: '0.6rem', fontWeight: 700 }}
                        >
                          {getFileBadgeText(attachment.fileName, attachment.mimeType)}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            fontSize: '0.55rem',
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            px: 0.5
                          }}
                        >
                          {attachment.fileName || 'File'}
                        </Typography>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{
                            fontSize: '0.52rem',
                            maxWidth: '100%',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            px: 0.5
                          }}
                        >
                          {buildFileMetaLabel({
                            fileName: attachment.fileName,
                            mimeType: attachment.mimeType,
                            sizeBytes: attachment.sizeBytes
                          })}
                        </Typography>
                      </Box>
                    ) : null}
                    {progress !== undefined && progress < 100 && (
                      <Box
                        sx={{
                          position: 'absolute',
                          bottom: 0,
                          left: 0,
                          right: 0,
                          height: 4,
                          bgcolor: 'rgba(0,0,0,0.2)'
                        }}
                      >
                        <Box
                          sx={{
                            height: '100%',
                            width: `${progress}%`,
                            bgcolor: 'primary.main',
                            transition: 'width 0.3s'
                          }}
                        />
                      </Box>
                    )}
                    <IconButton
                      size="small"
                      onClick={() => {
                        if (attachment.url.startsWith('blob:')) {
                          URL.revokeObjectURL(attachment.url)
                        }
                        onRemoveAttachment(originalIndex)
                      }}
                      sx={{
                        position: 'absolute',
                        top: 0,
                        right: 0,
                        bgcolor: 'rgba(0,0,0,0.5)',
                        color: 'white',
                        '&:hover': { bgcolor: 'rgba(0,0,0,0.7)' }
                      }}
                    >
                      <CloseIcon fontSize="small" />
                    </IconButton>
                  </Box>
                )
              })}
            </Box>
          )}

          {/* Deprecated Skill Picker Slot */}

          {/* Input Area */}
          <Box sx={{ width: '100%', minHeight: 0, mb: 1 }}>
            <TextField
              fullWidth
              multiline
              minRows={1}
              inputRef={composerInputRef}
              value={inputValue}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder=""
              disabled={disabled}
              variant="standard"
              InputProps={{
                disableUnderline: true,
                startAdornment: selectedSkillName ? (
                  <Box
                    contentEditable={false}
                    sx={{
                      display: 'inline-flex',
                      verticalAlign: 'middle',
                      mr: 1,
                      mt: '-2px',
                      userSelect: 'none'
                    }}
                  >
                    <Chip
                      label={`[${selectedSkillName}]`}
                      onDelete={onClearSkill}
                      deleteIcon={<CloseIcon style={{ fontSize: 14 }} />}
                      size="small"
                      color="secondary"
                      variant="filled"
                      sx={{
                        height: 22,
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        borderRadius: '6px',
                        bgcolor:
                          theme.palette.mode === 'dark'
                            ? 'rgba(168,85,247,0.2)'
                            : 'rgba(168,85,247,0.1)',
                        color: theme.palette.mode === 'dark' ? '#d8b4fe' : '#9333ea',
                        '& .MuiChip-deleteIcon': {
                          color:
                            theme.palette.mode === 'dark'
                              ? 'rgba(216,180,254,0.6)'
                              : 'rgba(147,51,234,0.6)',
                          '&:hover': {
                            color: theme.palette.mode === 'dark' ? '#d8b4fe' : '#9333ea'
                          }
                        }
                      }}
                    />
                  </Box>
                ) : undefined,
                sx: {
                  fontSize: '15px',
                  py: 0.5,
                  wordBreak: 'break-word',
                  overflowWrap: 'break-word',
                  alignItems: 'flex-start',
                  maxHeight: resolvedTextareaMaxHeight,
                  overflow: 'hidden'
                }
              }}
              inputProps={{
                'data-testid': 'chat-composer-input',
                onFocus: handleInputSelectionChange,
                onBeforeInput: handleBeforeInput,
                onKeyUp: handleInputSelectionChange,
                onMouseUp: handleInputSelectionChange,
                onClick: handleInputSelectionChange,
                onSelect: handleInputSelectionChange,
                onCompositionStart: handleCompositionStart,
                onCompositionEnd: handleCompositionEnd,
                onDragOver: handleInputDragOver,
                onDrop: handleInputDrop,
                style: {
                  minHeight: `${MIN_TEXTAREA_HEIGHT}px`,
                  maxHeight: resolvedTextareaMaxHeight,
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  resize: 'none',
                  lineHeight: '1.6',
                  scrollbarGutter: 'stable'
                }
              }}
              sx={{
                '& .MuiInputBase-root.MuiInputBase-multiline': {
                  alignItems: 'flex-start',
                  maxHeight: resolvedTextareaMaxHeight,
                  overflow: 'hidden',
                  display: 'flex',
                  flexWrap: 'wrap'
                },
                '& .MuiInputBase-input': {
                  py: 0.5,
                  wordBreak: 'break-word',
                  overflowWrap: 'break-word',
                  minHeight: `${MIN_TEXTAREA_HEIGHT}px`,
                  maxHeight: resolvedTextareaMaxHeight,
                  overflowY: 'auto !important',
                  overflowX: 'hidden',
                  resize: 'none',
                  scrollbarGutter: 'stable',
                  flex: '1 1 auto',
                  minWidth: 100,
                  '&:focus': {
                    outline: 'none',
                    boxShadow: 'none'
                  }
                },
                '& .MuiInputBase-root': {
                  '&:focus': {
                    outline: 'none',
                    boxShadow: 'none'
                  },
                  '&:focus-within': {
                    outline: 'none',
                    boxShadow: 'none'
                  }
                },
                '& .MuiInputBase-root:before': {
                  display: 'none'
                },
                '& .MuiInputBase-root:after': {
                  display: 'none'
                }
              }}
            />
          </Box>

          {toolHelpItems.length > 0 ? (
            <Box data-testid="chat-composer-tool-help" sx={{ mb: 1 }}>
              <Typography color="text.secondary" variant="caption">
                {isToolCommandMode
                  ? 'Use /tool <name> {"key":"value"} to call a bound tool directly. Click a tool or example to fill it.'
                  : 'This skill can call bound tools directly with /tool <name> {"key":"value"}.'}
              </Typography>
              {isToolCommandMode && parsedToolCommand ? (
                <Typography
                  color={selectedToolValidationMessage ? 'error.main' : 'text.secondary'}
                  variant="caption"
                  sx={{ display: 'block', mt: 0.25 }}
                >
                  {selectedToolValidationMessage ||
                    (selectedToolHelpItem
                      ? `Ready to execute ${selectedToolHelpItem.name}${selectedToolInputSchemaSummary ? `: expects ${selectedToolInputSchemaSummary}.` : '.'}`
                      : `No bound tool matches "${parsedToolCommand.toolName}".`)}
                </Typography>
              ) : null}
              {isToolCommandMode ? (
                <Box
                  sx={{
                    mt: 0.5,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.25,
                    maxHeight: 120,
                    overflowY: 'auto'
                  }}
                >
                  {filteredToolHelpItems.length > 0 ? (
                    <Typography color="text.secondary" variant="caption" sx={{ mb: 0.25 }}>
                      {requestedToolName
                        ? `Matching bound tools (${filteredToolHelpItems.length}):`
                        : 'Available bound tools:'}
                    </Typography>
                  ) : (
                    <Typography color="text.secondary" variant="caption" sx={{ mb: 0.25 }}>
                      No bound tools match the current /tool prefix.
                    </Typography>
                  )}
                  {filteredToolHelpItems.map((tool) => (
                    <Typography
                      key={tool.name}
                      color="text.secondary"
                      variant="caption"
                      sx={{ whiteSpace: 'pre-wrap', cursor: 'pointer' }}
                      onClick={() => handleInsertToolCommand(tool)}
                    >
                      <Box component="span" sx={{ fontFamily: 'monospace', color: 'text.primary' }}>
                        {tool.name}
                      </Box>
                      {tool.description ? ` - ${tool.description}` : ''}
                      {buildToolInputSchemaSummary(tool)
                        ? `\nexpects ${buildToolInputSchemaSummary(tool)}`
                        : ''}
                    </Typography>
                  ))}
                  {selectedToolHelpItem?.inputSchema ? (
                    <Box sx={{ mt: 0.5 }}>
                      <Typography
                        color="text.secondary"
                        variant="caption"
                        sx={{ display: 'block' }}
                      >
                        Suggested example:
                      </Typography>
                      <Typography
                        color="text.primary"
                        variant="caption"
                        data-testid="chat-composer-tool-example"
                        sx={{
                          display: 'block',
                          mt: 0.25,
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'monospace',
                          cursor: 'pointer'
                        }}
                        onClick={() => handleInsertToolCommand(selectedToolHelpItem)}
                      >
                        {buildToolCommandExample(selectedToolHelpItem)}
                      </Typography>
                    </Box>
                  ) : null}
                </Box>
              ) : toolHelpSummary ? (
                <Typography
                  color="text.secondary"
                  variant="caption"
                  sx={{ display: 'block', mt: 0.25 }}
                >
                  {remainingToolHelpCount > 0
                    ? `${toolHelpSummary} +${remainingToolHelpCount} more`
                    : toolHelpSummary}
                </Typography>
              ) : null}
            </Box>
          ) : null}

          {/* Bottom Action Bar: + button and Send button */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              width: '100%',
              minHeight: 0
            }}
            data-testid="chat-composer-action-bar"
          >
            <Box>
              <IconButton
                onClick={(event) => setAddMenuAnchorEl(event.currentTarget)}
                disabled={disabled}
                sx={{
                  color: 'text.secondary',
                  width: 32,
                  height: 32,
                  '&:hover': { bgcolor: 'action.hover' }
                }}
                title={t('chat.add_file')}
              >
                <AddIcon fontSize="small" />
              </IconButton>
              <Menu
                anchorEl={addMenuAnchorEl}
                open={active && Boolean(addMenuAnchorEl)}
                onClose={closeAddMenu}
                anchorOrigin={{ horizontal: 'left', vertical: 'top' }}
                transformOrigin={{ horizontal: 'left', vertical: 'bottom' }}
                slotProps={{
                  paper: {
                    sx: {
                      minWidth: 232,
                      borderRadius: 2,
                      mt: -0.5
                    }
                  }
                }}
              >
                <MenuItem onClick={handleUploadFileFromMenu}>
                  <ListItemIcon>
                    <AttachFileIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText
                    primary={t('chat.add_file')}
                    primaryTypographyProps={{ fontSize: 13, fontWeight: 600 }}
                  />
                </MenuItem>
                {addMenuSlot ? (
                  <>
                    <Divider sx={{ my: 0.5 }} />
                    {addMenuSlot(closeAddMenu)}
                  </>
                ) : null}
              </Menu>
            </Box>

            <Box
              data-testid="chat-composer-send-group"
              sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}
            >
              {resolvedToolbarSlot ? (
                <Box
                  data-testid="chat-composer-toolbar-slot"
                  sx={{ display: 'flex', alignItems: 'center', transform: 'translateY(-3px)' }}
                >
                  {resolvedToolbarSlot}
                </Box>
              ) : null}

              {statusSlot ? (
                <Box
                  data-testid="chat-composer-status-slot"
                  sx={{ display: 'flex', alignItems: 'center' }}
                >
                  {statusSlot}
                </Box>
              ) : null}

              {/* 发送/停止按钮 */}
              {isLoading ? (
                <IconButton
                  onClick={onStopGenerating}
                  sx={{
                    bgcolor: 'error.main',
                    color: 'error.contrastText',
                    width: 36,
                    height: 36,
                    '&:hover': {
                      bgcolor: 'error.dark'
                    }
                  }}
                  title={t('chat.stop_generating')}
                >
                  <StopIcon fontSize="small" />
                </IconButton>
              ) : (
                <IconButton
                  data-chat-send-btn
                  onClick={() => {
                    if (inputValue.trim() || pendingAttachments.length > 0) {
                      onSend()
                    }
                  }}
                  disabled={disabled || (!inputValue.trim() && pendingAttachments.length === 0)}
                  sx={{
                    bgcolor:
                      inputValue.trim() || pendingAttachments.length > 0
                        ? 'primary.main'
                        : 'transparent',
                    color:
                      inputValue.trim() || pendingAttachments.length > 0
                        ? 'primary.contrastText'
                        : 'text.secondary',
                    width: 36,
                    height: 36,
                    '&:hover': {
                      bgcolor:
                        inputValue.trim() || pendingAttachments.length > 0
                          ? 'primary.dark'
                          : 'action.hover'
                    },
                    '&:disabled': {
                      bgcolor: 'action.disabledBackground',
                      color: 'action.disabled'
                    }
                  }}
                  title={t('chat.send_message')}
                >
                  <SendIcon fontSize="small" />
                </IconButton>
              )}
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

export default ChatComposer
