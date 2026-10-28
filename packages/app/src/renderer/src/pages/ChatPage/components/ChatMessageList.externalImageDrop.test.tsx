import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { useCallback, useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/llm'
import {
  getDroppedLocalImageContent,
  QAPP_IMAGE_DRAG_MIME
} from '@renderer/utils/droppedImageUtils'
import type { ChatSession } from '../chatStorage'
import ChatMessageList from './ChatMessageList'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
  })
}))
vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() })
}))

type ListProps = React.ComponentProps<typeof ChatMessageList>
const theme = createTheme()
const originalText = 'Keep the existing edit draft.'
const caption = 'Please keep this image description.'
const imageUrl = 'file:///C:/Feishu/Cache/reference%20image.png'
const attachment = (name: string): ChatAttachment => ({
  type: 'image',
  fileName: name,
  url: `local-media:///fixture/${encodeURIComponent(name)}`,
  mimeType: 'image/png'
})
const existingAttachment = attachment('existing.png')
const session: ChatSession = {
  id: 'external-edit-drop',
  title: 'External edit drop',
  messages: [{ role: 'user', content: originalText, attachments: [existingAttachment] }]
}

const transfer = (data: Record<string, string>, files: File[] = []): DataTransfer =>
  ({
    getData: (type: string) => data[type] || '',
    files: Object.assign([...files], { item: (index: number) => files[index] || null }),
    types: [...Object.keys(data), ...(files.length ? ['Files'] : [])],
    dropEffect: 'none'
  }) as unknown as DataTransfer

const renderEditingList = () => {
  const onFormImport = vi.fn<NonNullable<ListProps['onDropImageAttachments']>>()
  onFormImport.mockImplementation(async (files) => files.map((file) => attachment(file.name)))
  const onParentDrop = vi.fn<(dataTransfer: DataTransfer) => void>()
  const onParentFiles = vi.fn<(files: File[]) => void>()
  const onSendEditedMessage = vi.fn<ListProps['onSendEditedMessage']>()

  function Harness(): React.JSX.Element {
    const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null)
    const [editingContent, setEditingContent] = useState('')
    const chatContainerRef = useRef<HTMLDivElement>(null)
    const messagesEndRef = useRef<HTMLDivElement>(null)
    const receiverRef = useRef<((value: ChatAttachment) => void) | null>(null)
    const registerReceiver = useCallback((receiver: ((value: ChatAttachment) => void) | null) => {
      receiverRef.current = receiver
    }, [])

    return (
      <ThemeProvider theme={theme}>
        <div
          onDrop={(event) => {
            event.preventDefault()
            onParentDrop(event.dataTransfer)
            const content = getDroppedLocalImageContent(event.dataTransfer)
            if (!content.fileUrls.length) return
            // Exercise the parent text/receiver contract; ChatPage persistence has its own suite.
            if (content.text) setEditingContent((value) => `${value}\n${content.text}`)
            const files = Array.from(event.dataTransfer.files)
            if (files.length) {
              onParentFiles(files)
              files.forEach((file) => receiverRef.current?.(attachment(file.name)))
            }
          }}
        >
          <ChatMessageList
            currentSession={session}
            isLoading={false}
            editingMessageIndex={editingMessageIndex}
            editingContent={editingContent}
            onSetEditingIndex={setEditingMessageIndex}
            onSetEditingContent={setEditingContent}
            onDropImageAttachments={onFormImport}
            onRegisterEditingAttachmentReceiver={registerReceiver}
            onSendEditedMessage={onSendEditedMessage}
            onPreviewImage={vi.fn()}
            onImageContextMenu={vi.fn()}
            onDownloadAttachment={vi.fn()}
            onSendModelToDcc={vi.fn()}
            chatContainerRef={chatContainerRef}
            messagesEndRef={messagesEndRef}
          />
        </div>
      </ThemeProvider>
    )
  }

  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'chat.edit_message' }))
  const editor = screen.getByRole('textbox') as HTMLTextAreaElement
  expect(editor).toHaveValue(originalText)
  return { editor, onFormImport, onParentDrop, onParentFiles, onSendEditedMessage }
}

describe('ChatMessageList real edit-form external image drop routing', () => {
  it.each<[string, Record<string, string>, string]>([
    ['plain text', { 'text/plain': `${caption}\n${imageUrl}` }, 'image/png'],
    ['URI list', { 'text/plain': caption, 'text/uri-list': imageUrl }, 'image/png'],
    [
      'HTML image',
      { 'text/plain': caption, 'text/html': `<p>${caption}</p><img src="${imageUrl}">` },
      'image/png'
    ],
    ['empty native MIME', { 'text/plain': `${caption}\n${imageUrl}` }, ''],
    ['generic native MIME', { 'text/plain': `${caption}\n${imageUrl}` }, 'application/octet-stream']
  ])(
    'hands %s metadata and its native File to the parent without losing edit text',
    async (_name, data, type) => {
      const { editor, onFormImport, onParentDrop, onParentFiles, onSendEditedMessage } =
        renderEditingList()
      const file = new File(['synthetic image'], 'reference image.png', { type })
      const dataTransfer = transfer(data, [file])

      fireEvent.dragOver(editor, { dataTransfer })
      fireEvent.drop(editor, { dataTransfer })

      expect(onParentDrop).toHaveBeenCalledExactlyOnceWith(dataTransfer)
      expect(onParentFiles).toHaveBeenCalledExactlyOnceWith([file])
      expect(onFormImport).not.toHaveBeenCalled()
      expect(editor).toHaveValue(`${originalText}\n${caption}`)
      expect(editor.value).not.toContain('file:///')
      expect(await screen.findByRole('img', { name: file.name })).toBeInTheDocument()
      expect(screen.getAllByRole('img', { name: file.name })).toHaveLength(1)
      expect(screen.getByRole('img', { name: 'existing.png' })).toBeInTheDocument()
      expect(screen.getByTestId('edit-message-composer')).toHaveAttribute('aria-busy', 'false')

      fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
      expect(onSendEditedMessage).toHaveBeenCalledExactlyOnceWith(
        `${originalText}\n${caption}`,
        [existingAttachment, attachment(file.name)],
        undefined,
        []
      )
    }
  )

  it('keeps ordinary native-image drops in the existing local edit importer', async () => {
    const { editor, onFormImport, onParentDrop, onSendEditedMessage } = renderEditingList()
    const file = new File(['synthetic image'], 'ordinary.png', { type: 'image/png' })
    const dataTransfer = transfer({}, [file])

    fireEvent.dragOver(editor, { dataTransfer })
    fireEvent.drop(editor, { dataTransfer })

    expect(onFormImport).toHaveBeenCalledExactlyOnceWith([file])
    expect(onParentDrop).not.toHaveBeenCalled()
    expect(await screen.findByRole('img', { name: file.name })).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save & Rerun' })).not.toBeDisabled()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save & Rerun' }))
    expect(onSendEditedMessage).toHaveBeenCalledExactlyOnceWith(
      originalText,
      [existingAttachment, attachment(file.name)],
      undefined,
      []
    )
  })

  it('does not reinterpret an internal image payload with a native File as an external drop', async () => {
    const { editor, onFormImport, onParentDrop } = renderEditingList()
    const file = new File(['synthetic image'], 'internal.png', { type: 'image/png' })
    const dataTransfer = transfer(
      {
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
          itemTypes: ['image'],
          objectUrl: 'blob:internal-image'
        }),
        'text/plain': imageUrl
      },
      [file]
    )

    fireEvent.drop(editor, { dataTransfer })

    expect(onFormImport).toHaveBeenCalledExactlyOnceWith([file])
    expect(onParentDrop).not.toHaveBeenCalled()
    expect(await screen.findByRole('img', { name: file.name })).toBeInTheDocument()
    expect(editor).toHaveValue(originalText)
  })

  it('continues bubbling reference-only local-image drops through the real edit textarea', () => {
    const { editor, onFormImport, onParentDrop, onParentFiles } = renderEditingList()
    const dataTransfer = transfer({ 'text/plain': `${caption}\n${imageUrl}` })

    fireEvent.drop(editor, { dataTransfer })

    expect(onParentDrop).toHaveBeenCalledExactlyOnceWith(dataTransfer)
    expect(onParentFiles).not.toHaveBeenCalled()
    expect(onFormImport).not.toHaveBeenCalled()
    expect(editor).toHaveValue(`${originalText}\n${caption}`)
  })

  it('continues bubbling internal image-only payloads without native Files', () => {
    const { editor, onFormImport, onParentDrop } = renderEditingList()
    const dataTransfer = transfer({
      [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
        itemTypes: ['image'],
        objectUrl: 'blob:internal-image'
      })
    })

    fireEvent.drop(editor, { dataTransfer })

    expect(onParentDrop).toHaveBeenCalledExactlyOnceWith(dataTransfer)
    expect(onFormImport).not.toHaveBeenCalled()
    expect(editor).toHaveValue(originalText)
  })
})
