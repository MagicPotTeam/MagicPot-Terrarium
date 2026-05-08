/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react'
import {
  Box,
  TextField,
  Typography,
  Button,
  Menu,
  MenuItem,
  Divider,
  IconButton,
  Tooltip,
  CircularProgress,
  useTheme
} from '@mui/material'
import {
  Edit as EditIcon,
  Download as DownloadIcon,
  PlayArrow as PlayArrowIcon,
  DragIndicator as DragIndicatorIcon,
  ArticleOutlined as TextFileIcon,
  DescriptionOutlined as WordFileIcon,
  FolderZipOutlined as ArchiveFileIcon,
  PictureAsPdfOutlined as PdfFileIcon,
  ViewInAr as Model3DIcon,
  InsertDriveFile as FileIcon,
  SlideshowOutlined as PowerPointFileIcon
} from '@mui/icons-material'
import { ContentCopy as ContentCopyIcon } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism } from 'react-syntax-highlighter'
import { prism, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import {
  ChatMessage,
  ChatAttachment
} from '../../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { type ChatSession } from '../chatStorage'
import { normalizeLocalMediaUrl, getDownloadFileNameFromUrl } from '../chatPageShared'
import {
  buildAssistantReplyDownloadBaseName,
  extractAssistantReplyTextContent,
  type AssistantSidecarExportEntry,
  type AssistantReplyDownloadMode,
  resolveAssistantReplyDownloadMode,
  resolveAssistantSidecarExportEntries
} from '../chatReplyDownloadUtils'
import { getVisibleChatAttachments } from '../chatAttachmentVisibility'
import {
  setAgentAttachmentDragPayload,
  setAgentImageDragPayload,
  setAgentModel3DDragPayload,
  setAgentVideoDragPayload
} from '../chatDragData'
import { formatChatLoadingStatusProgress, type ChatLoadingStatus } from '../chatLoadingStatus'
import {
  buildFileMetaLabel,
  detectDisplayFileKind,
  getFileBadgeText
} from '@renderer/utils/fileDisplay'
import { useMessage } from '@renderer/hooks/useMessage'
import { DccBridgeTarget, isSupportedDccBridgeModelSourceFormat } from '@shared/api/svcDccBridge'

interface ChatMessageListProps {
  active?: boolean
  currentSession: ChatSession | undefined
  isLoading: boolean
  loadingStatus?: ChatLoadingStatus
  pendingConfirmation?: ChatPendingConfirmation | null
  editingMessageIndex: number | null
  editingContent: string
  onSetEditingIndex: (index: number | null) => void
  onSetEditingContent: (content: string) => void
  onSendEditedMessage: (
    content: string,
    attachments: ChatAttachment[] | undefined,
    hiddenContext: string | undefined,
    baseMessages: ChatMessage[]
  ) => void
  onPreviewImage: (url: string) => void
  onImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
  onDownloadAttachment: (attachment: ChatAttachment) => void
  onSendModelToDcc: (attachment: ChatAttachment, target: DccBridgeTarget) => void
  onResolvePendingConfirmation?: (requestId: string, confirmed: boolean) => void
  chatContainerRef: React.RefObject<HTMLDivElement | null>
  messagesEndRef: React.RefObject<HTMLDivElement | null>
}

export type ChatPendingConfirmation = {
  requestId: string
  prompt: string
  confirmLabel: string
  cancelLabel: string
}

const ChatMessageList: React.FC<ChatMessageListProps> = ({
  active = true,
  currentSession,
  isLoading,
  loadingStatus,
  pendingConfirmation,
  editingMessageIndex,
  editingContent,
  onSetEditingIndex,
  onSetEditingContent,
  onSendEditedMessage,
  onPreviewImage,
  onImageContextMenu,
  onDownloadAttachment,
  onSendModelToDcc,
  onResolvePendingConfirmation,
  chatContainerRef,
  messagesEndRef
}) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isLight = theme.palette.mode === 'light'
  const { notifySuccess } = useMessage()
  const messages = React.useMemo(() => currentSession?.messages ?? [], [currentSession?.messages])
  const sidecarExportEntries = React.useMemo(
    () => resolveAssistantSidecarExportEntries(messages, currentSession?.skillId),
    [messages, currentSession?.skillId]
  )
  const batchSidecarExportAnchorIndex =
    sidecarExportEntries.length > 1
      ? (sidecarExportEntries[sidecarExportEntries.length - 1]?.assistantMessageIndex ?? null)
      : null
  return (
    <Box
      ref={chatContainerRef}
      data-testid="chat-message-list"
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        maxWidth: '900px',
        mx: 'auto',
        width: '100%'
      }}
    >
      {messages.length === 0 && (
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.secondary',
            gap: 2
          }}
        >
          <Typography variant="h6">{t('chat.welcome_message')}</Typography>
        </Box>
      )}
      {messages.map((message, index) => (
        <Box
          key={index}
          sx={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            mb: message.role === 'user' ? 0 : 2
          }}
        >
          {message.role === 'user' ? (
            editingMessageIndex === index ? (
              <UserMessageEditForm
                message={message}
                index={index}
                editingContent={editingContent}
                onSetEditingContent={onSetEditingContent}
                onCancel={() => {
                  onSetEditingIndex(null)
                  onSetEditingContent('')
                }}
                onSubmit={(content) => {
                  const truncatedMessages = currentSession?.messages.slice(0, index) || []
                  onSetEditingIndex(null)
                  onSetEditingContent('')
                  onSendEditedMessage(
                    content,
                    message.attachments,
                    message.hiddenContext,
                    truncatedMessages
                  )
                }}
                isLight={isLight}
              />
            ) : (
              <UserMessageBubble
                message={message}
                index={index}
                isLight={isLight}
                onEdit={() => {
                  onSetEditingIndex(index)
                  onSetEditingContent(message.content || '')
                }}
                onPreviewImage={onPreviewImage}
                onImageContextMenu={onImageContextMenu}
                onDownloadAttachment={onDownloadAttachment}
                onSendModelToDcc={onSendModelToDcc}
                notifySuccess={notifySuccess}
                t={t}
                theme={theme}
              />
            )
          ) : (
            <AssistantMessageBubble
              message={message}
              replyDownloadBaseName={buildAssistantReplyDownloadBaseName(messages, index)}
              replyDownloadMode={resolveAssistantReplyDownloadMode(
                messages,
                index,
                currentSession?.skillId
              )}
              batchSidecarExportEntries={
                batchSidecarExportAnchorIndex === index ? sidecarExportEntries : undefined
              }
              active={active}
              isLight={isLight}
              isLoading={isLoading && index === messages.length - 1}
              loadingStatus={isLoading && index === messages.length - 1 ? loadingStatus : undefined}
              onPreviewImage={onPreviewImage}
              onImageContextMenu={onImageContextMenu}
              onDownloadAttachment={onDownloadAttachment}
              onSendModelToDcc={onSendModelToDcc}
              notifySuccess={notifySuccess}
              t={t}
              theme={theme}
            />
          )}
        </Box>
      ))}
      {pendingConfirmation ? (
        <PendingConfirmationPanel
          confirmation={pendingConfirmation}
          active={active}
          onResolve={onResolvePendingConfirmation}
        />
      ) : null}
      <div ref={messagesEndRef} />
    </Box>
  )
}

const PendingConfirmationPanel: React.FC<{
  confirmation: ChatPendingConfirmation
  active: boolean
  onResolve?: (requestId: string, confirmed: boolean) => void
}> = ({ confirmation, active, onResolve }) => (
  <Box sx={{ px: 2, mb: 2 }}>
    <Box
      data-testid="chat-pending-confirmation"
      sx={{
        maxWidth: '85%',
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        p: 1.5,
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25
      }}
    >
      <Typography variant="body2" sx={{ color: 'text.primary', lineHeight: 1.6 }}>
        {confirmation.prompt}
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        <Button
          variant="contained"
          size="small"
          disabled={!active}
          onClick={() => onResolve?.(confirmation.requestId, true)}
          sx={{ borderRadius: '18px', textTransform: 'none' }}
        >
          {confirmation.confirmLabel}
        </Button>
        <Button
          variant="outlined"
          size="small"
          disabled={!active}
          onClick={() => onResolve?.(confirmation.requestId, false)}
          sx={{ borderRadius: '18px', textTransform: 'none' }}
        >
          {confirmation.cancelLabel}
        </Button>
      </Box>
    </Box>
  </Box>
)

const ModelAttachmentCard: React.FC<{
  attachment: ChatAttachment
  onDownloadAttachment: (attachment: ChatAttachment) => void
  onSendModelToDcc: (attachment: ChatAttachment, target: DccBridgeTarget) => void
  t: (key: string, options?: any) => string
  theme: any
}> = ({ attachment, onDownloadAttachment, onSendModelToDcc, t, theme }) => {
  const sourceUrl = attachment.url || ''
  const isBridgeable = !!sourceUrl
  const attachmentFileName =
    attachment.fileName || getDownloadFileNameFromUrl(sourceUrl, 'model.glb')
  const isSupportedFormat = isSupportedDccBridgeModelSourceFormat(attachmentFileName)

  return (
    <Box
      draggable={isBridgeable}
      onDragStart={(event) => {
        if (!sourceUrl) return
        event.stopPropagation()
        setAgentModel3DDragPayload(event.dataTransfer, sourceUrl)
      }}
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: '12px',
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        bgcolor: theme.palette.background.paper
      }}
    >
      <Model3DIcon sx={{ fontSize: 48, color: 'text.secondary' }} />
      <Typography variant="body2" color="text.secondary">
        {attachment.fileName || t('chat.model3d_file')}
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 1 }}>
        <Tooltip title={t('chat.download_attachment')}>
          <span>
            <IconButton size="small" onClick={() => onDownloadAttachment(attachment)}>
              <DownloadIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Button
          size="small"
          variant="outlined"
          disabled={!isBridgeable || !isSupportedFormat}
          title={
            isBridgeable && !isSupportedFormat
              ? `Unsupported model format: ${attachmentFileName || 'model'}`
              : undefined
          }
          onClick={() => onSendModelToDcc(attachment, 'unity')}
        >
          {t('chat.send_to_unity', { defaultValue: 'Unity' })}
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={!isBridgeable || !isSupportedFormat}
          title={
            isBridgeable && !isSupportedFormat
              ? `Unsupported model format: ${attachmentFileName || 'model'}`
              : undefined
          }
          onClick={() => onSendModelToDcc(attachment, 'unreal')}
        >
          {t('chat.send_to_unreal', { defaultValue: 'Unreal' })}
        </Button>
      </Box>
    </Box>
  )
}

const renderFileAttachmentIcon = (attachment: ChatAttachment) => {
  const kind = detectDisplayFileKind(attachment.fileName, attachment.mimeType)

  switch (kind) {
    case 'markdown':
    case 'text':
      return <TextFileIcon sx={{ fontSize: 36, color: '#38bdf8' }} />
    case 'word':
      return <WordFileIcon sx={{ fontSize: 36, color: '#60a5fa' }} />
    case 'powerpoint':
      return <PowerPointFileIcon sx={{ fontSize: 36, color: '#fb923c' }} />
    case 'pdf':
      return <PdfFileIcon sx={{ fontSize: 36, color: '#f87171' }} />
    case 'archive':
      return <ArchiveFileIcon sx={{ fontSize: 36, color: '#c084fc' }} />
    default:
      return <FileIcon sx={{ fontSize: 36, color: 'text.secondary' }} />
  }
}

const FileAttachmentCard: React.FC<{
  attachment: ChatAttachment
  ocrResult?: ChatAttachment['ocrResult']
  onDownloadAttachment: (attachment: ChatAttachment) => void
  t: (key: string, options?: any) => string
  theme: any
}> = ({ attachment, ocrResult, onDownloadAttachment, t, theme }) => {
  const folderBodyColor = theme.palette.mode === 'light' ? '#f8fafc' : '#1f2937'
  const folderTabColor = theme.palette.mode === 'light' ? '#eef2ff' : '#111827'

  return (
    <Box
      draggable={Boolean(attachment.url)}
      onDragStart={(event) => {
        if (!attachment.url) return
        event.stopPropagation()
        setAgentAttachmentDragPayload(event.dataTransfer, attachment, { ocrResult })
      }}
      sx={{
        position: 'relative',
        mt: 1.25,
        border: 1,
        borderColor: 'divider',
        borderRadius: '16px',
        p: 2,
        pt: 2.5,
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        bgcolor: folderBodyColor,
        boxShadow: '0 10px 24px rgba(15,23,42,0.14)',
        cursor: 'default',
        overflow: 'visible',
        '&::before': {
          content: '""',
          position: 'absolute',
          left: 18,
          top: -11,
          width: 76,
          height: 16,
          border: '1px solid',
          borderBottom: 'none',
          borderColor: 'divider',
          borderRadius: '12px 12px 0 0',
          bgcolor: folderTabColor
        },
        '&:active': {
          cursor: 'default'
        }
      }}
    >
      {renderFileAttachmentIcon(attachment)}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, mb: 0.25 }}>
          <Typography variant="caption" color="primary" sx={{ fontWeight: 700 }}>
            {getFileBadgeText(attachment.fileName, attachment.mimeType)}
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {buildFileMetaLabel({
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes
            })}
          </Typography>
        </Box>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {attachment.fileName || t('chat.file')}
        </Typography>
      </Box>
      <IconButton
        size="small"
        onClick={() => onDownloadAttachment(attachment)}
        title={t('chat.download_attachment')}
      >
        <DownloadIcon />
      </IconButton>
    </Box>
  )
}

const sortReportBundleAttachmentsForDisplay = (
  attachments: ChatAttachment[] | undefined
): ChatAttachment[] => {
  const visibleAttachments = getVisibleChatAttachments(attachments)
  if (!visibleAttachments.length) {
    return []
  }

  return [...visibleAttachments].sort((left, right) => {
    const leftRank =
      left.reportBundleRole === 'primary-report'
        ? 0
        : left.reportBundleRole === 'report-image'
          ? 1
          : left.reportBundleRole === 'report-ocr'
            ? 2
            : 3
    const rightRank =
      right.reportBundleRole === 'primary-report'
        ? 0
        : right.reportBundleRole === 'report-image'
          ? 1
          : right.reportBundleRole === 'report-ocr'
            ? 2
            : 3
    return leftRank - rightRank
  })
}

const TextDragHandle: React.FC<{
  content: string
  title: string
}> = ({ content, title }) => (
  <Tooltip title={title} placement="top">
    <IconButton
      size="small"
      draggable
      aria-label={title}
      onDragStart={(event) => {
        event.stopPropagation()
        event.dataTransfer.setData('text/plain', content || '')
        event.dataTransfer.effectAllowed = 'copy'
      }}
      sx={{
        color: 'text.disabled',
        width: 28,
        height: 28,
        cursor: 'default',
        '&:hover': { color: 'text.secondary' },
        '&:active': { cursor: 'default' }
      }}
    >
      <DragIndicatorIcon sx={{ fontSize: 16 }} />
    </IconButton>
  </Tooltip>
)

const downloadTextContentFile = (
  content: string,
  fileName: string,
  mimeType: 'text/markdown;charset=utf-8' | 'text/plain;charset=utf-8'
) => {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

const getAttachmentDownloadFileName = (attachment: ChatAttachment): string => {
  const explicitFileName = attachment.fileName?.trim()
  if (explicitFileName) {
    return explicitFileName
  }

  const fallback =
    attachment.type === 'image'
      ? 'image.png'
      : attachment.type === 'video'
        ? 'video.mp4'
        : attachment.type === 'model3d'
          ? 'model.glb'
          : 'download'

  return getDownloadFileNameFromUrl(attachment.url, fallback)
}

const buildAttachmentDownloadMenuLabel = (
  attachment: ChatAttachment,
  t: (key: string, options?: any) => string
): string => {
  const fileName = getAttachmentDownloadFileName(attachment)

  switch (attachment.type) {
    case 'image':
      return t('chat.download_image_option', {
        defaultValue: `Image: ${fileName}`
      })
    case 'video':
      return t('chat.download_video_option', {
        defaultValue: `Video: ${fileName}`
      })
    case 'model3d':
      return t('chat.download_model_option', {
        defaultValue: `3D model: ${fileName}`
      })
    case 'file':
    default:
      return t('chat.download_file_option', {
        defaultValue: `File: ${fileName}`
      })
  }
}

// --- 用户消息编辑表单 ---
const UserMessageEditForm: React.FC<{
  message: ChatMessage
  index: number
  editingContent: string
  onSetEditingContent: (content: string) => void
  onCancel: () => void
  onSubmit: (content: string) => void
  isLight: boolean
}> = ({ message, editingContent, onSetEditingContent, onCancel, onSubmit, isLight }) => {
  return (
    <Box sx={{ px: 2, mb: 2, display: 'flex', justifyContent: 'flex-end' }}>
      <Box sx={{ maxWidth: '85%', width: '100%' }}>
        <TextField
          fullWidth
          multiline
          autoFocus
          value={editingContent}
          onChange={(e) => onSetEditingContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
          }}
          variant="outlined"
          sx={{
            '& .MuiOutlinedInput-root': {
              borderRadius: '18px',
              bgcolor: isLight ? '#e8eaed' : '#303134'
            },
            '& .MuiInputBase-input': {
              color: isLight ? '#202124' : '#e8eaed'
            }
          }}
        />
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
          <Button
            variant="text"
            size="small"
            onClick={onCancel}
            sx={{ borderRadius: '18px', textTransform: 'none' }}
          >
            取消
          </Button>
          <Button
            variant="contained"
            size="small"
            disabled={!editingContent.trim()}
            onClick={() => {
              const newContent = editingContent.trim()
              if (!newContent) return
              onSubmit(newContent)
            }}
            sx={{ borderRadius: '18px', textTransform: 'none' }}
          >
            提交
          </Button>
        </Box>
      </Box>
    </Box>
  )
}

// --- 用户消息气泡 ---
const UserMessageBubble: React.FC<{
  message: ChatMessage
  index: number
  isLight: boolean
  onEdit: () => void
  onPreviewImage: (url: string) => void
  onImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
  onDownloadAttachment: (attachment: ChatAttachment) => void
  onSendModelToDcc: (attachment: ChatAttachment, target: DccBridgeTarget) => void
  notifySuccess: (msg: string) => void
  t: (key: string, options?: any) => string
  theme: any
}> = ({
  message,
  isLight,
  onEdit,
  onPreviewImage,
  onImageContextMenu,
  onDownloadAttachment,
  onSendModelToDcc,
  notifySuccess,
  t,
  theme
}) => {
  const visibleAttachments = sortReportBundleAttachmentsForDisplay(message.attachments)

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'flex-end',
        mb: 2,
        px: 2,
        '&:hover .user-msg-actions': {
          opacity: 1
        }
      }}
    >
      {/* 操作按钮 */}
      <Box
        className="user-msg-actions"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0,
          mr: 0.5,
          opacity: 0,
          transition: 'opacity 0.15s ease'
        }}
      >
        <Tooltip title={t('chat.copy_prompt')} placement="top">
          <IconButton
            size="small"
            onClick={() => {
              if (message.content) {
                navigator.clipboard.writeText(message.content)
                notifySuccess(t('chat.prompt_copied'))
              }
            }}
            sx={{
              color: 'text.disabled',
              width: 28,
              height: 28,
              '&:hover': { color: 'text.secondary' }
            }}
          >
            <ContentCopyIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={t('chat.edit_message')} placement="top">
          <IconButton
            size="small"
            onClick={onEdit}
            sx={{
              color: 'text.disabled',
              width: 28,
              height: 28,
              '&:hover': { color: 'text.secondary' }
            }}
          >
            <EditIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
        {message.content ? (
          <TextDragHandle
            content={message.content}
            title={t('chat.drag_prompt_to_canvas', { defaultValue: 'Drag prompt to canvas' })}
          />
        ) : null}
      </Box>
      <Box
        sx={{
          position: 'relative',
          maxWidth: '85%',
          bgcolor: isLight ? '#e8eaed' : '#303134',
          borderRadius: '18px',
          px: 3,
          py: 2,
          wordWrap: 'break-word',
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
          userSelect: 'text',
          WebkitUserSelect: 'text',
          cursor: 'text'
        }}
      >
        {visibleAttachments.length > 0 && (
          <Box sx={{ mb: message.content ? 1.5 : 0 }}>
            {visibleAttachments.map((attachment, attIdx) => (
              <Box key={attIdx} sx={{ mb: 1 }}>
                {attachment.type === 'image' ? (
                  <img
                    src={normalizeLocalMediaUrl(attachment.url)}
                    alt={`Attachment ${attIdx + 1}`}
                    style={{
                      maxWidth: '100%',
                      maxHeight: '200px',
                      borderRadius: '12px',
                      objectFit: 'contain',
                      display: 'block',
                      cursor: 'pointer'
                    }}
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation()
                      setAgentImageDragPayload(e.dataTransfer, attachment.url)
                    }}
                    onClick={() => onPreviewImage(attachment.url)}
                    onContextMenu={(e) => onImageContextMenu(e, attachment.url)}
                  />
                ) : attachment.type === 'video' ? (
                  <video
                    src={normalizeLocalMediaUrl(attachment.url)}
                    controls
                    preload="metadata"
                    style={{
                      maxWidth: '100%',
                      maxHeight: '400px',
                      borderRadius: '12px',
                      display: 'block'
                    }}
                  />
                ) : attachment.type === 'model3d' ? (
                  <ModelAttachmentCard
                    attachment={attachment}
                    onDownloadAttachment={onDownloadAttachment}
                    onSendModelToDcc={onSendModelToDcc}
                    t={t}
                    theme={theme}
                  />
                ) : attachment.type === 'file' ? (
                  <FileAttachmentCard
                    attachment={attachment}
                    ocrResult={attachment.ocrResult ?? message.ocrResult}
                    onDownloadAttachment={onDownloadAttachment}
                    t={t}
                    theme={theme}
                  />
                ) : null}
              </Box>
            ))}
          </Box>
        )}
        {/* 用户文本 */}
        {message.content && (
          <Typography
            variant="body1"
            sx={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
              color: isLight ? '#202124' : '#e8eaed',
              lineHeight: 1.6
            }}
          >
            {message.content}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

// --- AI 消息气泡 ---
const AssistantMessageBubble: React.FC<{
  message: ChatMessage
  replyDownloadBaseName: string
  replyDownloadMode: AssistantReplyDownloadMode
  batchSidecarExportEntries?: AssistantSidecarExportEntry[]
  active: boolean
  isLight: boolean
  isLoading: boolean
  loadingStatus?: ChatLoadingStatus
  onPreviewImage: (url: string) => void
  onImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
  onDownloadAttachment: (attachment: ChatAttachment) => void
  onSendModelToDcc: (attachment: ChatAttachment, target: DccBridgeTarget) => void
  notifySuccess: (msg: string) => void
  t: (key: string, options?: any) => string
  theme: any
}> = ({
  message,
  replyDownloadBaseName,
  replyDownloadMode,
  batchSidecarExportEntries,
  active,
  isLight,
  isLoading,
  loadingStatus,
  onPreviewImage,
  onImageContextMenu,
  onDownloadAttachment,
  onSendModelToDcc,
  notifySuccess,
  t,
  theme
}) => {
  const visibleAttachments = sortReportBundleAttachmentsForDisplay(message.attachments)
  const loadingProgress = formatChatLoadingStatusProgress(loadingStatus)
  const showLoadingStatus = isLoading && Boolean(loadingStatus?.label)

  return (
    <Box sx={{ px: 2 }}>
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          wordBreak: 'break-word',
          overflowWrap: 'break-word'
        }}
      >
        {/* AI 附件 */}
        {visibleAttachments.length > 0 && (
          <Box sx={{ mb: message.content ? 1.5 : 0 }}>
            {visibleAttachments.map((attachment, attIdx) => (
              <Box key={attIdx} sx={{ mb: 1 }}>
                {attachment.type === 'image' ? (
                  <img
                    src={normalizeLocalMediaUrl(attachment.url)}
                    alt={`Attachment ${attIdx + 1}`}
                    style={{
                      maxWidth: '100%',
                      maxHeight: '600px',
                      borderRadius: '12px',
                      objectFit: 'contain',
                      display: 'block',
                      cursor: 'pointer'
                    }}
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation()
                      setAgentImageDragPayload(e.dataTransfer, attachment.url)
                    }}
                    onClick={() => onPreviewImage(attachment.url)}
                    onContextMenu={(e) => onImageContextMenu(e, attachment.url)}
                  />
                ) : attachment.type === 'video' ? (
                  <AssistantVideoPlayer url={attachment.url} fileName={attachment.fileName} />
                ) : attachment.type === 'model3d' ? (
                  <ModelAttachmentCard
                    attachment={attachment}
                    onDownloadAttachment={onDownloadAttachment}
                    onSendModelToDcc={onSendModelToDcc}
                    t={t}
                    theme={theme}
                  />
                ) : attachment.type === 'file' ? (
                  <FileAttachmentCard
                    attachment={attachment}
                    ocrResult={attachment.ocrResult ?? message.ocrResult}
                    onDownloadAttachment={onDownloadAttachment}
                    t={t}
                    theme={theme}
                  />
                ) : null}
              </Box>
            ))}
          </Box>
        )}
        {/* AI 文本回复（Markdown 渲染） */}
        {message.content ? (
          <>
            <AssistantMarkdownContent
              content={message.content}
              replyDownloadBaseName={replyDownloadBaseName}
              downloadMode={replyDownloadMode}
              batchSidecarExportEntries={batchSidecarExportEntries}
              attachments={visibleAttachments}
              active={active}
              isLight={isLight}
              onPreviewImage={onPreviewImage}
              onImageContextMenu={onImageContextMenu}
              onDownloadAttachment={onDownloadAttachment}
              notifySuccess={notifySuccess}
              t={t}
            />
            {showLoadingStatus ? (
              <AssistantLoadingStatus
                label={loadingStatus?.label || ''}
                progress={loadingProgress}
                detail={loadingStatus?.detail}
                theme={theme}
              />
            ) : null}
          </>
        ) : visibleAttachments.length > 0 ? (
          showLoadingStatus ? (
            <AssistantLoadingStatus
              label={loadingStatus?.label || ''}
              progress={loadingProgress}
              detail={loadingStatus?.detail}
              theme={theme}
            />
          ) : (
            <AssistantMarkdownContent
              content=""
              replyDownloadBaseName={replyDownloadBaseName}
              downloadMode={replyDownloadMode}
              batchSidecarExportEntries={batchSidecarExportEntries}
              attachments={visibleAttachments}
              active={active}
              isLight={isLight}
              onPreviewImage={onPreviewImage}
              onImageContextMenu={onImageContextMenu}
              onDownloadAttachment={onDownloadAttachment}
              notifySuccess={notifySuccess}
              t={t}
            />
          )
        ) : isLoading ? (
          <AssistantLoadingStatus
            label={
              loadingStatus?.label || t('chat.loading_status_default', { defaultValue: '正在处理' })
            }
            progress={loadingProgress}
            detail={loadingStatus?.detail}
            theme={theme}
          />
        ) : message.content !== undefined && message.content !== '' ? null : (
          <Typography variant="body2" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>
            {t('chat.response_interrupted')}
          </Typography>
        )}
      </Box>
    </Box>
  )
}

const AssistantLoadingStatus: React.FC<{
  label: string
  progress?: string | null
  detail?: string
  theme: any
}> = ({ label, progress, detail, theme }) => (
  <Box
    data-testid="assistant-loading-status"
    sx={{
      mt: 0.75,
      display: 'inline-flex',
      alignItems: 'flex-start',
      gap: 1,
      px: 1.25,
      py: 0.9,
      borderRadius: '14px',
      bgcolor: theme.palette.mode === 'light' ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.04)',
      border: '1px solid',
      borderColor: theme.palette.mode === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)'
    }}
  >
    <CircularProgress size={16} sx={{ mt: '2px', flexShrink: 0 }} />
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 600, lineHeight: 1.4 }}>
        {progress ? `${label} ${progress}` : label}
      </Typography>
      {detail ? (
        <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.35 }}>
          {detail}
        </Typography>
      ) : null}
    </Box>
  </Box>
)

// --- AI 视频播放器 ---
const AssistantVideoPlayer: React.FC<{ url: string; fileName?: string }> = ({ url, fileName }) => {
  return (
    <Box
      draggable
      onDragStart={(event) => {
        event.stopPropagation()
        setAgentVideoDragPayload(event.dataTransfer, url, fileName)
      }}
      sx={{
        position: 'relative',
        maxWidth: '100%',
        width: 'fit-content',
        borderRadius: '16px',
        overflow: 'hidden',
        bgcolor: '#000',
        cursor: 'pointer',
        '&:hover .video-play-overlay': {
          opacity: 1
        }
      }}
      onClick={(e) => {
        const videoEl = (e.currentTarget as HTMLElement).querySelector('video')
        const overlayEl = (e.currentTarget as HTMLElement).querySelector(
          '.video-play-overlay'
        ) as HTMLElement
        if (videoEl) {
          if (videoEl.paused) {
            videoEl.play()
            if (overlayEl) overlayEl.style.display = 'none'
          } else {
            videoEl.pause()
            if (overlayEl) {
              overlayEl.style.display = 'flex'
              overlayEl.style.opacity = '1'
            }
          }
        }
      }}
    >
      <video
        src={normalizeLocalMediaUrl(url)}
        controls
        preload="metadata"
        style={{
          maxWidth: '100%',
          maxHeight: '480px',
          minWidth: '320px',
          borderRadius: '16px',
          display: 'block'
        }}
        onPlay={(e) => {
          const overlay = (e.currentTarget as HTMLVideoElement).parentElement?.querySelector(
            '.video-play-overlay'
          ) as HTMLElement
          if (overlay) overlay.style.display = 'none'
        }}
        onPause={(e) => {
          const overlay = (e.currentTarget as HTMLVideoElement).parentElement?.querySelector(
            '.video-play-overlay'
          ) as HTMLElement
          if (overlay) {
            overlay.style.display = 'flex'
            overlay.style.opacity = '1'
          }
        }}
      />
      <Box
        className="video-play-overlay"
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
          transition: 'opacity 0.2s ease'
        }}
      >
        <Box
          sx={{
            width: 64,
            height: 64,
            borderRadius: '50%',
            bgcolor: 'rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(4px)',
            border: '2px solid rgba(255, 255, 255, 0.3)'
          }}
        >
          <PlayArrowIcon sx={{ fontSize: 36, color: '#fff', ml: '3px' }} />
        </Box>
      </Box>
    </Box>
  )
}

// --- AI Markdown 文本内容 ---
const AssistantMarkdownContent: React.FC<{
  content: string
  replyDownloadBaseName: string
  downloadMode: AssistantReplyDownloadMode
  batchSidecarExportEntries?: AssistantSidecarExportEntry[]
  attachments: ChatAttachment[]
  active: boolean
  isLight: boolean
  onPreviewImage: (url: string) => void
  onImageContextMenu: (event: React.MouseEvent, imageUrl: string) => void
  onDownloadAttachment: (attachment: ChatAttachment) => void
  notifySuccess: (msg: string) => void
  t: (key: string, options?: any) => string
}> = ({
  content,
  replyDownloadBaseName,
  downloadMode,
  batchSidecarExportEntries,
  attachments,
  active,
  isLight,
  onPreviewImage,
  onImageContextMenu,
  onDownloadAttachment,
  notifySuccess,
  t
}) => {
  const videoRegex = /\[Generated Video\]\(([^)]+)\)/g
  const [downloadMenuAnchorEl, setDownloadMenuAnchorEl] = React.useState<HTMLElement | null>(null)
  const videos: string[] = []
  let match
  while ((match = videoRegex.exec(content)) !== null) {
    videos.push(match[1])
  }
  const textContent = extractAssistantReplyTextContent(content)
  const isDownloadMenuOpen = Boolean(downloadMenuAnchorEl)
  React.useEffect(() => {
    if (!active) {
      setDownloadMenuAnchorEl(null)
    }
  }, [active])
  const isSidecarDownload = downloadMode === 'sidecar'
  const hasTextContent = Boolean(textContent)
  const hasImageAttachments = attachments.some((attachment) => attachment.type === 'image')
  const canBatchExportSidecars =
    hasTextContent && isSidecarDownload && (batchSidecarExportEntries?.length ?? 0) > 1
  const textDownloadOptions = !hasTextContent
    ? []
    : isSidecarDownload
      ? [
          {
            extension: '.txt' as const,
            label: t('chat.export_sidecar_text_option', { defaultValue: 'Sidecar (.txt)' })
          },
          {
            extension: '.md' as const,
            label: t('chat.export_sidecar_markdown_option', {
              defaultValue: 'Markdown record (.md)'
            })
          }
        ]
      : [
          {
            extension: '.md' as const,
            label: t('chat.download_reply_markdown_option', { defaultValue: 'Markdown (.md)' })
          },
          {
            extension: '.txt' as const,
            label: t('chat.download_reply_text_option', { defaultValue: 'Text (.txt)' })
          }
        ]
  const attachmentDownloadOptions = attachments.map((attachment, index) => ({
    key: `${attachment.type}:${attachment.url}:${index}`,
    attachment,
    label: buildAttachmentDownloadMenuLabel(attachment, t),
    onClick: () => {
      onDownloadAttachment(attachment)
      notifySuccess(
        t('chat.attachment_downloaded', {
          defaultValue: `${getAttachmentDownloadFileName(attachment)} downloaded`
        })
      )
      setDownloadMenuAnchorEl(null)
    }
  }))
  const actionBarAttachmentOptions = hasTextContent
    ? attachmentDownloadOptions
    : attachmentDownloadOptions.filter(({ attachment }) => attachment.type === 'image')
  const showReplyActions = hasTextContent || hasImageAttachments
  const handleDownloadReply = (extension: '.md' | '.txt') => {
    const fileName = `${replyDownloadBaseName}${extension}`
    downloadTextContentFile(
      textContent,
      fileName,
      extension === '.md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
    )
    notifySuccess(
      isSidecarDownload && extension === '.txt'
        ? t('chat.sidecar_exported', {
            defaultValue: `${fileName} exported as sidecar`
          })
        : t('chat.reply_downloaded', {
            defaultValue: `${fileName} downloaded`
          })
    )
    setDownloadMenuAnchorEl(null)
  }
  const handleDownloadBatchSidecars = (extension: '.md' | '.txt') => {
    for (const entry of batchSidecarExportEntries || []) {
      downloadTextContentFile(
        entry.textContent,
        `${entry.baseName}${extension}`,
        extension === '.md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
      )
    }
    notifySuccess(
      extension === '.txt'
        ? t('chat.sidecar_batch_exported', {
            defaultValue: `${batchSidecarExportEntries?.length || 0} sidecar files exported`
          })
        : t('chat.sidecar_markdown_batch_exported', {
            defaultValue: `${batchSidecarExportEntries?.length || 0} markdown records exported`
          })
    )
    setDownloadMenuAnchorEl(null)
  }
  const downloadButtonLabel =
    hasTextContent && isSidecarDownload
      ? t('chat.export_sidecar', { defaultValue: '导出 sidecar' })
      : hasTextContent
        ? t('chat.download_reply', { defaultValue: '下载回答' })
        : t('chat.download_attachment', { defaultValue: '下载附件' })
  const handleOpenDownloadMenu = (event: React.MouseEvent<HTMLElement>) => {
    if (!active) {
      event.preventDefault()
      return
    }

    setDownloadMenuAnchorEl(event.currentTarget)
  }

  return (
    <Box
      data-testid="assistant-markdown-content"
      sx={{
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
        color: 'text.primary',
        lineHeight: 1.8,
        fontSize: '0.95rem',
        userSelect: 'text',
        WebkitUserSelect: 'text',
        cursor: 'text',
        '& p': { my: 1.2 },
        '& p:first-of-type': { mt: 0 },
        '& p:last-child': { mb: 0 },
        '& ul, & ol': {
          pl: 3,
          my: 1.5,
          '& li': {
            my: 0.6,
            '&::marker': {
              color: 'text.secondary'
            }
          }
        },
        '& li': {
          my: 0.6,
          '& p': { my: 0.3 }
        },
        '& code': {
          bgcolor: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)',
          px: 0.5,
          py: 0.25,
          borderRadius: 0.5,
          fontFamily: 'monospace',
          fontSize: '0.9em'
        },
        '& pre': {
          bgcolor: isLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.1)',
          p: 1.5,
          borderRadius: 1,
          overflow: 'auto',
          my: 1.5,
          '& code': {
            bgcolor: 'transparent',
            p: 0
          }
        },
        '& blockquote': {
          borderLeft: 'none',
          pl: 3,
          ml: 2,
          mr: 0,
          my: 1,
          color: 'text.primary',
          '& p': {
            my: 0.5
          }
        },
        '& hr': {
          border: 'none',
          borderTop: '1px solid',
          borderColor: isLight ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.15)',
          my: 3
        },
        '& a': {
          color: 'primary.main',
          textDecoration: 'none',
          '&:hover': {
            textDecoration: 'underline'
          }
        },
        '& strong': {
          fontWeight: 600
        },
        '& h1, & h2, & h3, & h4, & h5, & h6': {
          fontWeight: 600,
          mt: 2.5,
          mb: 1.5,
          lineHeight: 1.4
        }
      }}
    >
      {/*
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.5 }}>
          <TextDragHandle
            content={content}
            title={t('chat.drag_reply_to_canvas', { defaultValue: '拖拽回复到画板' })}
          />
        </Box>
      */}
      {textContent && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url) => {
            if (url.startsWith('local-media://') || url.startsWith('file://')) {
              return url
            }
            if (url.startsWith('http://') || url.startsWith('https://')) {
              return url
            }
            return url
          }}
          components={{
            p: ({ children }) => <div style={{ margin: '0.8em 0' }}>{children}</div>,
            img: ({ src, alt }) => (
              <img
                src={src}
                alt={alt || ''}
                style={{
                  maxWidth: '100%',
                  maxHeight: '600px',
                  borderRadius: '12px',
                  objectFit: 'contain',
                  display: 'block',
                  margin: '8px 0',
                  cursor: 'pointer'
                }}
                draggable
                onDragStart={(e) => {
                  e.stopPropagation()
                  if (src) {
                    setAgentImageDragPayload(e.dataTransfer, src)
                  }
                }}
                onClick={() => src && onPreviewImage(src)}
                onContextMenu={(e) => src && onImageContextMenu(e, src)}
              />
            ),
            a: ({ href, children }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault()
                  if (href) {
                    window.open(href, '_blank')
                  }
                }}
              >
                {children}
              </a>
            ),
            code({ node, inline, className, children, ...props }: any) {
              const codeMatch = /language-(\w+)/.exec(className || '')
              return !inline && codeMatch ? (
                <div style={{ position: 'relative' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      backgroundColor: isLight ? '#f6f8fa' : '#1e1e1e',
                      padding: '4px 12px',
                      borderTopLeftRadius: '8px',
                      borderTopRightRadius: '8px',
                      borderBottom: isLight ? '1px solid #e1e4e8' : '1px solid #333',
                      fontSize: '12px',
                      color: isLight ? '#24292e' : '#e1e4e8',
                      fontFamily: 'monospace'
                    }}
                  >
                    <span>{codeMatch[1]}</span>
                    <IconButton
                      size="small"
                      onClick={() => {
                        navigator.clipboard.writeText(String(children).replace(/\n$/, ''))
                        notifySuccess(t('chat.code_copied'))
                      }}
                      sx={{ color: 'inherit', padding: '2px' }}
                    >
                      <ContentCopyIcon sx={{ fontSize: '14px' }} />
                    </IconButton>
                  </div>
                  <Prism
                    style={isLight ? prism : vscDarkPlus}
                    language={codeMatch[1]}
                    PreTag="div"
                    customStyle={{
                      margin: 0,
                      borderTopLeftRadius: 0,
                      borderTopRightRadius: 0,
                      borderBottomLeftRadius: '8px',
                      borderBottomRightRadius: '8px',
                      backgroundColor: isLight ? '#ffffff' : '#1e1e1e',
                      fontSize: '14px',
                      lineHeight: 1.5,
                      padding: '16px'
                    }}
                    {...props}
                  >
                    {String(children).replace(/\n$/, '')}
                  </Prism>
                </div>
              ) : (
                <code className={className} {...props}>
                  {children}
                </code>
              )
            }
          }}
        >
          {textContent}
        </ReactMarkdown>
      )}
      {videos.map((url) => (
        <div
          key={url}
          draggable
          onDragStart={(event) => {
            event.stopPropagation()
            setAgentVideoDragPayload(event.dataTransfer, url)
          }}
          style={{
            position: 'relative',
            display: 'inline-block',
            margin: '8px 0'
          }}
          className="video-container"
        >
          <video
            src={normalizeLocalMediaUrl(url)}
            controls
            preload="metadata"
            style={{
              maxWidth: '100%',
              maxHeight: '480px',
              minWidth: '320px',
              borderRadius: '16px',
              display: 'block',
              backgroundColor: '#000'
            }}
          />
          <IconButton
            size="small"
            sx={{
              position: 'absolute',
              top: 8,
              right: 8,
              bgcolor: 'rgba(0, 0, 0, 0.6)',
              color: '#fff',
              '&:hover': {
                bgcolor: 'rgba(0, 0, 0, 0.8)'
              }
            }}
            onClick={() => {
              const a = document.createElement('a')
              a.href = normalizeLocalMediaUrl(url)
              a.download = getDownloadFileNameFromUrl(url, 'video.mp4')
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
            }}
            title="Download or reveal the file"
          >
            <DownloadIcon fontSize="small" />
          </IconButton>
        </div>
      ))}
      {showReplyActions ? (
        <Box
          data-testid="assistant-reply-actions"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            mt: 1
          }}
        >
          {hasTextContent ? (
            <Tooltip
              title={t('chat.copy_reply', { defaultValue: '\u590d\u5236\u56de\u7b54' })}
              placement="top"
            >
              <IconButton
                size="small"
                aria-label={t('chat.copy_reply', { defaultValue: '\u590d\u5236\u56de\u7b54' })}
                onClick={() => {
                  navigator.clipboard.writeText(textContent)
                  notifySuccess(
                    t('chat.reply_copied', { defaultValue: '\u56de\u7b54\u5df2\u590d\u5236' })
                  )
                }}
                sx={{
                  color: 'text.disabled',
                  width: 28,
                  height: 28,
                  '&:hover': { color: 'text.secondary' }
                }}
              >
                <ContentCopyIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          ) : null}
          <Tooltip title={downloadButtonLabel} placement="top">
            <IconButton
              size="small"
              aria-label={downloadButtonLabel}
              onClick={handleOpenDownloadMenu}
              sx={{
                color: 'text.disabled',
                width: 28,
                height: 28,
                '&:hover': { color: 'text.secondary' }
              }}
            >
              <DownloadIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
          <Menu
            anchorEl={downloadMenuAnchorEl}
            open={active && isDownloadMenuOpen}
            onClose={() => setDownloadMenuAnchorEl(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
            transformOrigin={{ vertical: 'top', horizontal: 'left' }}
          >
            {actionBarAttachmentOptions.map((option) => (
              <MenuItem key={option.key} onClick={option.onClick} aria-label={option.label}>
                {option.label}
              </MenuItem>
            ))}
            {actionBarAttachmentOptions.length > 0 && textDownloadOptions.length > 0 ? (
              <Divider />
            ) : null}
            {textDownloadOptions.map((option) => (
              <MenuItem
                key={option.extension}
                onClick={() => handleDownloadReply(option.extension)}
                aria-label={option.label}
              >
                {option.label}
              </MenuItem>
            ))}
            {canBatchExportSidecars
              ? [
                  <Divider key="batch-divider" />,
                  <MenuItem
                    key="batch-txt"
                    onClick={() => handleDownloadBatchSidecars('.txt')}
                    aria-label={t('chat.export_all_sidecar_text_option', {
                      defaultValue: 'All sidecars (.txt)'
                    })}
                  >
                    {t('chat.export_all_sidecar_text_option', {
                      defaultValue: 'All sidecars (.txt)'
                    })}
                  </MenuItem>,
                  <MenuItem
                    key="batch-md"
                    onClick={() => handleDownloadBatchSidecars('.md')}
                    aria-label={t('chat.export_all_sidecar_markdown_option', {
                      defaultValue: 'All markdown records (.md)'
                    })}
                  >
                    {t('chat.export_all_sidecar_markdown_option', {
                      defaultValue: 'All markdown records (.md)'
                    })}
                  </MenuItem>
                ]
              : null}
          </Menu>
          {hasTextContent ? (
            <TextDragHandle
              content={textContent}
              title={t('chat.drag_reply_to_canvas', {
                defaultValue: '\u62d6\u62fd\u56de\u7b54\u5230\u753b\u677f'
              })}
            />
          ) : null}
        </Box>
      ) : null}
    </Box>
  )
}

const MemoizedChatMessageList = React.memo(ChatMessageList)

MemoizedChatMessageList.displayName = 'ChatMessageList'

export default MemoizedChatMessageList
