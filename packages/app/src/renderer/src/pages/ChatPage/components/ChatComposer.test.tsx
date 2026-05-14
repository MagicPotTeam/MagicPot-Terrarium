import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import ChatComposer from './ChatComposer'
import { useRef, useState } from 'react'
import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

function ControlledChatComposer({
  initialValue,
  renderNonce,
  isLoading = false,
  disabled = false,
  onSend = vi.fn()
}: {
  initialValue: string
  renderNonce?: number
  isLoading?: boolean
  disabled?: boolean
  onSend?: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)

  return (
    <ThemeProvider theme={theme}>
      <ChatComposer
        inputValue={value}
        onInputChange={setValue}
        onSend={onSend}
        onUploadFile={vi.fn()}
        pendingAttachments={[]}
        uploadProgress={{}}
        onRemoveAttachment={vi.fn()}
        isLoading={isLoading}
        onStopGenerating={vi.fn()}
        disabled={disabled}
        composerInputRef={inputRef}
        onPreviewImage={vi.fn()}
      />
      <span data-testid="render-nonce" hidden>
        {renderNonce}
      </span>
    </ThemeProvider>
  )
}

const createDataTransfer = (data: Record<string, string>) =>
  ({
    getData: (key: string) => data[key] || '',
    dropEffect: 'none'
  }) as unknown as DataTransfer

describe('ChatComposer', () => {
  const createRect = (top: number, height: number): DOMRect =>
    ({
      x: 0,
      y: top,
      width: 640,
      height,
      top,
      right: 640,
      bottom: top + height,
      left: 0,
      toJSON: () => ({})
    }) as DOMRect

  it('renders the toolbar slot inside the bottom action bar', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
          toolbarSlot={<div data-testid="skill-slot-content">skills</div>}
        />
      </ThemeProvider>
    )

    const actionBar = screen.getByTestId('chat-composer-action-bar')
    const toolbarSlot = within(actionBar).getByTestId('chat-composer-toolbar-slot')

    expect(within(toolbarSlot).getByTestId('skill-slot-content')).toBeInTheDocument()
    expect(within(actionBar).getByTitle('chat.add_file')).toBeInTheDocument()
    expect(within(actionBar).getByTitle('chat.send_message')).toBeInTheDocument()
  })

  it('renders the status slot next to the send controls', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
          statusSlot={<div data-testid="context-indicator">ctx</div>}
          toolbarSlot={<div data-testid="skill-slot-content">skills</div>}
        />
      </ThemeProvider>
    )

    const actionBar = screen.getByTestId('chat-composer-action-bar')
    const sendGroup = within(actionBar).getByTestId('chat-composer-send-group')

    expect(within(sendGroup).getByTestId('context-indicator')).toBeInTheDocument()
    expect(within(sendGroup).getByTitle('chat.send_message')).toBeInTheDocument()
    expect(within(actionBar).getByTestId('skill-slot-content')).toBeInTheDocument()
  })

  it('shows bound tool guidance and expands details in /tool mode', () => {
    const onInputChange = vi.fn()
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue="/tool workspace.inspect"
          onInputChange={onInputChange}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
          toolHelpItems={[
            {
              name: 'session.status',
              description: 'Describe the current chat session and task state.',
              inputSchema: {
                type: 'object',
                properties: {}
              }
            },
            {
              name: 'workspace.inspect',
              description: 'Inspect a recorded workspace identity by workspaceId.',
              inputSchema: {
                type: 'object',
                properties: {
                  workspaceId: {
                    type: 'string'
                  },
                  runLimit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 100
                  }
                },
                required: ['workspaceId']
              }
            }
          ]}
        />
      </ThemeProvider>
    )

    const help = screen.getByTestId('chat-composer-tool-help')
    expect(within(help).getByText(/Use \/tool <name>/)).toBeInTheDocument()
    expect(within(help).queryByText('session.status')).toBeNull()
    expect(within(help).getByText('workspace.inspect')).toBeInTheDocument()
    expect(help.textContent).toContain('Inspect a recorded workspace identity by workspaceId.')
    expect(help.textContent).toContain('expects JSON object; required: workspaceId')
    expect(help.textContent).toContain('Suggested example:')
    expect(help.textContent).toContain('/tool workspace.inspect')
    expect(help.textContent).toContain('"workspaceId": ""')

    fireEvent.click(within(help).getByText('workspace.inspect'))
    expect(onInputChange).toHaveBeenNthCalledWith(
      1,
      '/tool workspace.inspect {\n  "workspaceId": ""\n}'
    )

    fireEvent.click(screen.getByTestId('chat-composer-tool-example'))
    expect(onInputChange).toHaveBeenNthCalledWith(
      2,
      '/tool workspace.inspect {\n  "workspaceId": ""\n}'
    )
  })

  it('shows validation feedback for schema-invalid /tool commands', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue="/tool workspace.inspect show me"
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
          toolHelpItems={[
            {
              name: 'workspace.inspect',
              description: 'Inspect a recorded workspace identity by workspaceId.',
              inputSchema: {
                type: 'object',
                properties: {
                  workspaceId: {
                    type: 'string'
                  },
                  runLimit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 100
                  }
                },
                required: ['workspaceId']
              }
            }
          ]}
        />
      </ThemeProvider>
    )

    const help = screen.getByTestId('chat-composer-tool-help')

    expect(help.textContent).toContain(
      'Tool "workspace.inspect" requires JSON object; required: workspaceId. missing required field "workspaceId".'
    )
  })

  it('filters bound tool suggestions by the current /tool prefix', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue="/tool work"
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
          toolHelpItems={[
            {
              name: 'session.status',
              description: 'Describe the current chat session and task state.'
            },
            {
              name: 'workspace.inspect',
              description: 'Inspect a recorded workspace identity by workspaceId.'
            },
            {
              name: 'workspace.detach',
              description: 'Detach a workspace from the current run.'
            }
          ]}
        />
      </ThemeProvider>
    )

    const help = screen.getByTestId('chat-composer-tool-help')
    expect(help.textContent).toContain('Matching bound tools (2):')
    expect(within(help).queryByText('session.status')).toBeNull()
    expect(within(help).getByText('workspace.inspect')).toBeInTheDocument()
    expect(within(help).getByText('workspace.detach')).toBeInTheDocument()
  })

  it('keeps long multiline input in a scrollable textarea', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue={Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
        />
      </ThemeProvider>
    )

    const textarea = screen.getByTestId('chat-composer-input')

    expect(textarea).toHaveStyle({
      overflowY: 'auto',
      overflowX: 'hidden',
      resize: 'none'
    })
  })

  it('renders a single native textarea for composer input', () => {
    const { container } = render(<ControlledChatComposer initialValue="hello" />)

    const textarea = screen.getByTestId('chat-composer-input')

    expect(textarea.tagName).toBe('TEXTAREA')
    expect(container.querySelectorAll('textarea')).toHaveLength(1)
  })

  it('does not send on Enter while IME composition is active', () => {
    const onSend = vi.fn()
    render(<ControlledChatComposer initialValue="draft" onSend={onSend} />)

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement

    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', charCode: 13 })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps the input editable while generation is loading', () => {
    const onInputChange = vi.fn()
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue="draft"
          onInputChange={onInputChange}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
        />
      </ThemeProvider>
    )

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement

    expect(textarea).not.toBeDisabled()

    fireEvent.change(textarea, {
      target: {
        value: 'draft update',
        selectionStart: 12,
        selectionEnd: 12,
        selectionDirection: 'none'
      }
    })

    expect(onInputChange).toHaveBeenCalledWith('draft update')
  })

  it('keeps the caret at the edit position when typing in the middle', () => {
    render(<ControlledChatComposer initialValue="hello world" />)

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    fireEvent.focus(textarea)
    textarea.setSelectionRange(6, 6)

    fireEvent.change(textarea, {
      target: {
        value: 'hello Xworld',
        selectionStart: 7,
        selectionEnd: 7,
        selectionDirection: 'none'
      }
    })

    expect(textarea).toHaveValue('hello Xworld')
    expect(textarea.selectionStart).toBe(7)
    expect(textarea.selectionEnd).toBe(7)
  })

  it('recovers the middle edit caret when the browser reports the changed selection at the end', () => {
    render(<ControlledChatComposer initialValue="hello world" />)

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    fireEvent.focus(textarea)
    textarea.setSelectionRange(6, 6)
    fireEvent.select(textarea)

    fireEvent.change(textarea, {
      target: {
        value: 'hello Xworld',
        selectionStart: 12,
        selectionEnd: 12,
        selectionDirection: 'none'
      }
    })

    expect(textarea).toHaveValue('hello Xworld')
    expect(textarea.selectionStart).toBe(7)
    expect(textarea.selectionEnd).toBe(7)
  })

  it('infers the middle insertion caret when selection events are stale', () => {
    render(<ControlledChatComposer initialValue={'line 1\nline 2\nline 3'} />)

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    act(() => {
      textarea.focus()
    })
    textarea.setSelectionRange(7, 7)

    fireEvent.change(textarea, {
      target: {
        value: 'line 1\nXline 2\nline 3',
        selectionStart: 21,
        selectionEnd: 21,
        selectionDirection: 'none'
      }
    })

    expect(textarea).toHaveValue('line 1\nXline 2\nline 3')
    expect(textarea.selectionStart).toBe(8)
    expect(textarea.selectionEnd).toBe(8)
  })

  it('keeps the middle caret through parent rerenders before typing', () => {
    const { rerender } = render(
      <ControlledChatComposer initialValue="hello world" renderNonce={1} />
    )

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    fireEvent.focus(textarea)
    textarea.setSelectionRange(6, 6)
    fireEvent.select(textarea)

    rerender(<ControlledChatComposer initialValue="hello world" renderNonce={2} />)

    expect(textarea.selectionStart).toBe(6)
    expect(textarea.selectionEnd).toBe(6)
  })

  it('inserts dropped internal canvas text at the input caret', () => {
    const parentDragOver = vi.fn()
    const parentDrop = vi.fn()

    render(
      <div onDragOver={parentDragOver} onDrop={parentDrop}>
        <ControlledChatComposer initialValue="hello world" />
      </div>
    )

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    act(() => {
      textarea.focus()
      textarea.setSelectionRange(6, 6)
    })

    const dataTransfer = createDataTransfer({
      [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
        itemTypes: ['text'],
        textContent: 'dropped '
      })
    })

    fireEvent.dragOver(textarea, { dataTransfer })
    fireEvent.drop(textarea, { dataTransfer })

    expect(textarea).toHaveValue('hello dropped world')
    expect(textarea.selectionStart).toBe(14)
    expect(textarea.selectionEnd).toBe(14)
    expect(parentDragOver).not.toHaveBeenCalled()
    expect(parentDrop).not.toHaveBeenCalled()
  })

  it('lets non-text internal drops bubble to the chat page drop handler', () => {
    const parentDrop = vi.fn()

    render(
      <div onDrop={parentDrop}>
        <ControlledChatComposer initialValue="" />
      </div>
    )

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    const dataTransfer = createDataTransfer({
      [QAPP_IMAGE_DRAG_MIME]: JSON.stringify({
        itemTypes: ['image'],
        objectUrl: 'blob:canvas-image'
      })
    })

    fireEvent.drop(textarea, { dataTransfer })

    expect(parentDrop).toHaveBeenCalledTimes(1)
  })

  it('uses the full chat panel height budget for long input', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue={Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
        />
      </ThemeProvider>
    )

    const composerRoot = screen.getByTestId('chat-composer-root')
    const composerParent = composerRoot.parentElement as HTMLElement
    const restoreParentRect = vi
      .spyOn(composerParent, 'getBoundingClientRect')
      .mockReturnValue(createRect(0, 600))
    const restoreComposerRect = vi
      .spyOn(composerRoot, 'getBoundingClientRect')
      .mockReturnValue(createRect(480, 120))

    fireEvent(window, new Event('resize'))

    const textarea = screen.getByTestId('chat-composer-input')

    expect(textarea).toHaveStyle({
      maxHeight: '460px'
    })

    restoreComposerRect.mockRestore()
    restoreParentRect.mockRestore()
  })

  it('keeps large attachment batches in a scrollable preview tray', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={Array.from({ length: 18 }, (_, index) => ({
            type: 'image' as const,
            url: `data:image/png;base64,attachment-${index}`,
            fileName: `attachment-${index + 1}.png`
          }))}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
        />
      </ThemeProvider>
    )

    const composerRoot = screen.getByTestId('chat-composer-root')
    const composerParent = composerRoot.parentElement as HTMLElement
    const restoreParentRect = vi
      .spyOn(composerParent, 'getBoundingClientRect')
      .mockReturnValue(createRect(0, 600))

    fireEvent(window, new Event('resize'))

    const attachmentTray = screen.getByTestId('chat-composer-attachments')

    expect(attachmentTray).toHaveStyle({
      maxHeight: '192px',
      overflowY: 'auto',
      overflowX: 'hidden'
    })

    restoreParentRect.mockRestore()
  })

  it('renders local image previews through the local-media protocol', () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[
            {
              type: 'image',
              url: 'file:///C:/demo/reference.png',
              fileName: 'reference.png'
            }
          ]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
        />
      </ThemeProvider>
    )

    const image = screen.getByRole('img')

    expect(image).toHaveAttribute('src', 'local-media:///C:/demo/reference.png')
  })

  it('keeps backend-only attachments sendable while hiding them from the composer preview', () => {
    const { container } = render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[
            {
              type: 'image',
              url: 'data:image/png;base64,HIDDEN',
              fileName: 'canvas-selection.png',
              hiddenFromChatView: true
            }
          ]}
          uploadProgress={{}}
          onRemoveAttachment={vi.fn()}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={vi.fn()}
        />
      </ThemeProvider>
    )

    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(screen.getByTitle('chat.send_message')).not.toBeDisabled()
  })
})
