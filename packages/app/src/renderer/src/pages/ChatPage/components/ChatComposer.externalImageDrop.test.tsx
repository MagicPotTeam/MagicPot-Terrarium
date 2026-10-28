import { act, fireEvent, render, screen } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { theme } from '@renderer/theme'
import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'
import ChatComposer from './ChatComposer'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key
  })
}))

const firstUrl = 'file:///C:/Feishu/Cache/first%20image.png'
const secondUrl = 'file:///C:/Feishu/Cache/second.jpg'
const draft = 'Keep this draft intact.'

const createDataTransfer = (data: Record<string, string>, files: File[] = []): DataTransfer =>
  ({
    getData: (type: string) => data[type] || '',
    files: Object.assign([...files], { item: (index: number) => files[index] || null }),
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => null
    })),
    types: [...Object.keys(data), ...(files.length ? ['Files'] : [])],
    dropEffect: 'none',
    effectAllowed: 'all'
  }) as unknown as DataTransfer

function ControlledComposer({
  onInputChange
}: {
  onInputChange: (value: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState(draft)
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  return (
    <ThemeProvider theme={theme}>
      <ChatComposer
        inputValue={value}
        onInputChange={(nextValue) => {
          setValue(nextValue)
          onInputChange(nextValue)
        }}
        onSend={vi.fn()}
        onUploadFile={vi.fn()}
        pendingAttachments={[]}
        uploadProgress={{}}
        onRemoveAttachment={vi.fn()}
        isLoading={false}
        onStopGenerating={vi.fn()}
        disabled={false}
        composerInputRef={inputRef}
        onPreviewImage={vi.fn()}
      />
    </ThemeProvider>
  )
}

const renderComposer = () => {
  const onInputChange = vi.fn()
  const parentDragOver = vi.fn()
  const parentDrop = vi.fn()
  render(
    <div onDragOver={parentDragOver} onDrop={parentDrop}>
      <ControlledComposer onInputChange={onInputChange} />
    </div>
  )
  const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
  act(() => {
    textarea.focus()
    textarea.setSelectionRange(5, 9)
  })
  return { textarea, onInputChange, parentDragOver, parentDrop }
}

describe('ChatComposer external image drop routing', () => {
  it.each<[string, Record<string, string>]>([
    ['plain file URL', { 'text/plain': firstUrl }],
    ['URI list', { 'text/uri-list': `# Feishu image selection\r\n${firstUrl}\r\n${secondUrl}` }],
    ['multiple plain URLs', { 'text/plain': `${firstUrl}\r\n${secondUrl}` }],
    [
      'body text with image URL',
      { 'text/plain': `Please compare this image.\n${firstUrl}\nKeep the original colors.` }
    ],
    ['HTML image', { 'text/html': `<img src="${firstUrl}" alt="image preview">` }],
    [
      'HTML image with body and plain fallback',
      {
        'text/html': `<p>Compare the details.</p><img src="${firstUrl}">`,
        'text/plain': 'Compare the details.'
      }
    ]
  ])('bubbles %s to ChatPage without inserting text or replacing the selection', (_name, data) => {
    const { textarea, onInputChange, parentDragOver, parentDrop } = renderComposer()
    const dataTransfer = createDataTransfer(data)

    fireEvent.dragOver(textarea, { dataTransfer })
    fireEvent.drop(textarea, { dataTransfer })

    expect(parentDragOver).toHaveBeenCalledTimes(1)
    expect(parentDrop).toHaveBeenCalledTimes(1)
    expect(textarea).toHaveValue(draft)
    expect(textarea.selectionStart).toBe(5)
    expect(textarea.selectionEnd).toBe(9)
    expect(onInputChange).not.toHaveBeenCalled()
  })

  it.each(['image/png', ''])(
    'bubbles a native File (%s MIME) despite a plain-text flavor',
    (type) => {
      const { textarea, onInputChange, parentDragOver, parentDrop } = renderComposer()
      const file = new File(['synthetic image'], 'native-image.png', { type })
      const dataTransfer = createDataTransfer({ 'text/plain': firstUrl }, [file])

      fireEvent.dragOver(textarea, { dataTransfer })
      fireEvent.drop(textarea, { dataTransfer })

      expect(parentDragOver).toHaveBeenCalledTimes(1)
      expect(parentDrop).toHaveBeenCalledTimes(1)
      expect(textarea).toHaveValue(draft)
      expect(onInputChange).not.toHaveBeenCalled()
    }
  )

  it.each<[string, Record<string, string>]>([
    ['plain text', { 'text/plain': 'another' }],
    ['HTML text', { 'text/html': '<p>another</p>' }],
    [
      'internal canvas text',
      {
        [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({ itemTypes: ['text'], textContent: 'another' })
      }
    ]
  ])('still inserts ordinary %s at the selection without bubbling', (_name, data) => {
    const { textarea, onInputChange, parentDragOver, parentDrop } = renderComposer()
    const dataTransfer = createDataTransfer(data)

    fireEvent.dragOver(textarea, { dataTransfer })
    fireEvent.drop(textarea, { dataTransfer })

    expect(textarea).toHaveValue('Keep another draft intact.')
    expect(onInputChange).toHaveBeenCalledWith('Keep another draft intact.')
    expect(parentDragOver).not.toHaveBeenCalled()
    expect(parentDrop).not.toHaveBeenCalled()
  })
})
