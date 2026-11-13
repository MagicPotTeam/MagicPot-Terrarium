import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { MenuItem, ThemeProvider } from '@mui/material'
import { theme } from '@renderer/theme'
import ChatComposer from './ChatComposer'
import { useRef, useState } from 'react'
import { QAPP_IMAGE_DRAG_MIME } from '@renderer/utils/droppedImageUtils'

const chatImageTranslations: Record<string, string> = {
  'chat.preview_alt_index': 'Preview {{index}}',
  'chat.image_load_failed_label': '{{name}} failed to load',
  'chat.image_unavailable': 'Image unavailable'
}

const translate = (key: string, options?: Record<string, unknown>) => {
  const template =
    chatImageTranslations[key] ?? (options?.defaultValue as string | undefined) ?? key
  return template.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate })
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
  it('offline real add menu navigates all slot items with arrows and Enter closes it', async () => {
    const upload = vi.fn()
    const preview = vi.fn()
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue="" onInputChange={vi.fn()} onSend={vi.fn()} onUploadFile={upload}
          pendingAttachments={[]} uploadProgress={{}} onRemoveAttachment={vi.fn()}
          isLoading={false} onStopGenerating={vi.fn()} disabled={false}
          composerInputRef={{ current: null }} onPreviewImage={vi.fn()}
          addMenuSlot={(closeMenu) => [
            null,
            false,
            <MenuItem key="image">Image generation</MenuItem>,
            [<MenuItem key="preview" onClick={() => { preview(); closeMenu() }}>Local preview</MenuItem>]
          ]}
        />
      </ThemeProvider>
    )
    fireEvent.click(screen.getByTitle('chat.add_file'))
    const uploadItem = await screen.findByRole('menuitem', { name: 'chat.add_file' })
    const imageItem = screen.getByRole('menuitem', { name: 'Image generation' })
    const previewItem = screen.getByRole('menuitem', { name: 'Local preview' })
    await waitFor(() => expect(uploadItem).toHaveFocus())
    fireEvent.keyDown(uploadItem, { key: 'ArrowDown' })
    expect(imageItem).toHaveFocus()
    fireEvent.keyDown(imageItem, { key: 'ArrowDown' })
    expect(previewItem).toHaveFocus()
    fireEvent.keyDown(previewItem, { key: 'ArrowUp' })
    expect(imageItem).toHaveFocus()
    fireEvent.keyDown(imageItem, { key: 'ArrowDown' })
    await userEvent.keyboard('{Enter}')
    expect(preview).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(upload).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('chat.add_file'))
    expect(await screen.findByRole('menuitem', { name: 'chat.add_file' })).toBeVisible()
    expect(upload).not.toHaveBeenCalled()
  })

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

  it('renders an async composer image thumbnail and replaces failures in its fixed slot', () => {
    const onPreviewImage = vi.fn()
    const onRemoveAttachment = vi.fn()
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[{ type: 'image', url: 'blob:thumbnail' }]}
          uploadProgress={{}}
          onRemoveAttachment={onRemoveAttachment}
          isLoading={false}
          onStopGenerating={vi.fn()}
          disabled={false}
          composerInputRef={{ current: null }}
          onPreviewImage={onPreviewImage}
        />
      </ThemeProvider>
    )

    const image = screen.getByRole('img', { name: 'Preview 1' })
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('decoding', 'async')
    expect(image).toHaveAttribute('width', '80')
    expect(image).toHaveAttribute('height', '80')
    fireEvent.click(image)
    expect(onPreviewImage).toHaveBeenCalledWith('blob:thumbnail')

    fireEvent.error(image)
    expect(screen.getByRole('img', { name: 'Preview 1 failed to load' })).toBeInTheDocument()
    expect(screen.getByTestId('chat-composer-attachments')).toBeInTheDocument()
  })

  it('keeps parent Stop and offers separate explicit /btw submission while busy without widening ordinary sends', () => {
    const onSend = vi.fn(), onStop = vi.fn()
    const renderComposer = (text: string, enabled = true) => <ThemeProvider theme={theme}><ChatComposer inputValue={text} inputSyncKey={text} onInputChange={vi.fn()} onSend={onSend} onUploadFile={vi.fn()} pendingAttachments={[]} uploadProgress={{}} onRemoveAttachment={vi.fn()} isLoading sideCommandEnabled={enabled} onStopGenerating={onStop} disabled={false} composerInputRef={{ current: null }} onPreviewImage={vi.fn()} /></ThemeProvider>
    const view = render(renderComposer('/btw question'))
    fireEvent.click(screen.getByTitle('chat.agent_side.command_send')); expect(onSend).toHaveBeenCalledOnce(); expect(onStop).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTitle('chat.stop_generating')); expect(onStop).toHaveBeenCalledOnce()
    view.rerender(renderComposer('/skill list'))
    fireEvent.click(screen.getByTitle('chat.agent_skill_session.command_send')); expect(onSend).toHaveBeenCalledTimes(2)
    expect(screen.getByTitle('chat.stop_generating')).toBeInTheDocument()
    view.rerender(renderComposer('/scratchpad'))
    fireEvent.click(screen.getByTitle('chat.agent_scratchpad.command_send')); expect(onSend).toHaveBeenCalledTimes(3)
    expect(screen.getByTitle('chat.stop_generating')).toBeInTheDocument()
    view.rerender(renderComposer('/pad'))
    fireEvent.click(screen.getByTitle('chat.agent_scratchpad.command_send')); expect(onSend).toHaveBeenCalledTimes(4)
    view.rerender(renderComposer('ordinary queued text'))
    expect(screen.queryByTitle('chat.agent_side.command_send')).not.toBeInTheDocument()
    view.rerender(renderComposer('/pad', false))
    expect(screen.queryByTitle('chat.agent_scratchpad.command_send')).not.toBeInTheDocument()
    expect(screen.getByTitle('chat.stop_generating')).toBeInTheDocument()
    view.rerender(renderComposer('/btw question', false))
    expect(screen.queryByTitle('chat.agent_side.command_send')).not.toBeInTheDocument()
    expect(screen.getByTitle('chat.stop_generating')).toBeInTheDocument()
  })
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
          modelSelectorSlot={<button type="button">model fixture</button>}
          toolbarSlot={<div data-testid="skill-slot-content">skills</div>}
        />
      </ThemeProvider>
    )

    const actionBar = screen.getByTestId('chat-composer-action-bar')
    const sendGroup = within(actionBar).getByTestId('chat-composer-send-group')

    expect(within(sendGroup).getByTestId('context-indicator')).toBeInTheDocument()
    expect(within(sendGroup).getByTitle('chat.send_message')).toBeInTheDocument()
    const modelSlot = within(sendGroup).getByTestId('chat-composer-model-selector-slot')
    expect(within(modelSlot).getByRole('button', { name: 'model fixture' })).toBeInTheDocument()
    expect(modelSlot.previousElementSibling).toBe(within(sendGroup).getByTestId('chat-composer-status-slot'))
    expect(modelSlot.nextElementSibling).toBe(within(sendGroup).getByTitle('chat.send_message'))
    expect(within(actionBar).getByTestId('skill-slot-content')).toBeInTheDocument()
  })

  it('uses the status slot as the compress context action when both are provided', () => {
    const onCompressContext = vi.fn()

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
          onCompressContext={onCompressContext}
        />
      </ThemeProvider>
    )

    const actionBar = screen.getByTestId('chat-composer-action-bar')
    const statusAction = within(actionBar).getByTestId('chat-composer-context-status-compress')

    expect(within(statusAction).getByTestId('context-indicator')).toBeInTheDocument()
    expect(within(actionBar).queryByTestId('chat-composer-compress-context')).toBeNull()

    fireEvent.click(statusAction)
    fireEvent.keyDown(statusAction, { key: 'Enter' })

    expect(onCompressContext).toHaveBeenCalledTimes(2)
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

  it('does not restore selection while Chinese IME composition is active', () => {
    const setSelectionRangeSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'setSelectionRange')
    render(<ControlledChatComposer initialValue="" />)

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    fireEvent.focus(textarea)
    fireEvent.compositionStart(textarea)

    fireEvent.change(textarea, {
      target: {
        value: 'ni',
        selectionStart: 2,
        selectionEnd: 2,
        selectionDirection: 'none'
      }
    })

    expect(textarea).toHaveValue('ni')
    expect(setSelectionRangeSpy).not.toHaveBeenCalled()

    setSelectionRangeSpy.mockRestore()
  })

  it('keeps Chinese IME draft text when the parent value is stale during composition', () => {
    const onInputChange = vi.fn()
    const inputRef = { current: null }
    const { rerender } = render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={onInputChange}
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

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    fireEvent.focus(textarea)
    fireEvent.compositionStart(textarea)
    fireEvent.change(textarea, {
      target: {
        value: 'ni',
        selectionStart: 2,
        selectionEnd: 2,
        selectionDirection: 'none'
      }
    })

    rerender(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          onInputChange={onInputChange}
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

    expect(textarea).toHaveValue('ni')

    fireEvent.change(textarea, {
      target: {
        value: '你',
        selectionStart: 1,
        selectionEnd: 1,
        selectionDirection: 'none'
      }
    })
    fireEvent.compositionEnd(textarea)

    expect(textarea).toHaveValue('你')
    expect(onInputChange).toHaveBeenLastCalledWith('你')
  })

  it('does not replace active Chinese IME text with an older parent value', () => {
    const onInputChange = vi.fn()
    const inputRef = { current: null }
    const renderComposer = (inputValue: string) => (
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue={inputValue}
          onInputChange={onInputChange}
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
    const { rerender } = render(renderComposer(''))

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    fireEvent.focus(textarea)
    fireEvent.compositionStart(textarea)
    fireEvent.change(textarea, {
      target: {
        value: 'ni',
        selectionStart: 2,
        selectionEnd: 2,
        selectionDirection: 'none'
      }
    })

    rerender(renderComposer('n'))

    expect(textarea).toHaveValue('ni')

    fireEvent.change(textarea, {
      target: {
        value: '你',
        selectionStart: 1,
        selectionEnd: 1,
        selectionDirection: 'none'
      }
    })
    fireEvent.compositionEnd(textarea)

    expect(textarea).toHaveValue('你')
    expect(onInputChange).toHaveBeenLastCalledWith('你')
  })

  it('resets the local draft when the input sync key changes with the same parent value', () => {
    const onInputChange = vi.fn()
    const inputRef = { current: null }
    const renderComposer = (inputSyncKey: string) => (
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue=""
          inputSyncKey={inputSyncKey}
          onInputChange={onInputChange}
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

    const { rerender } = render(renderComposer('session-a'))

    const textarea = screen.getByTestId('chat-composer-input') as HTMLTextAreaElement
    fireEvent.change(textarea, {
      target: {
        value: 'stale draft',
        selectionStart: 11,
        selectionEnd: 11,
        selectionDirection: 'none'
      }
    })

    expect(textarea).toHaveValue('stale draft')

    rerender(renderComposer('session-b'))

    expect(textarea).toHaveValue('')
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

  it('uses the full chat panel height budget for long input', async () => {
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

    await waitFor(() => {
      expect(textarea).toHaveStyle({
        maxHeight: '460px'
      })
    })

    restoreComposerRect.mockRestore()
    restoreParentRect.mockRestore()
  })

  it('shares the panel height budget between long input and image previews', async () => {
    render(
      <ThemeProvider theme={theme}>
        <ChatComposer
          inputValue={Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n')}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onUploadFile={vi.fn()}
          pendingAttachments={[
            {
              type: 'image',
              url: 'data:image/png;base64,attachment',
              fileName: 'attachment.png'
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

    const composerRoot = screen.getByTestId('chat-composer-root')
    const composerParent = composerRoot.parentElement as HTMLElement
    const restoreParentRect = vi
      .spyOn(composerParent, 'getBoundingClientRect')
      .mockReturnValue(createRect(0, 400))

    fireEvent(window, new Event('resize'))

    const textarea = screen.getByTestId('chat-composer-input')
    const attachmentTray = screen.getByTestId('chat-composer-attachments')

    await waitFor(() => {
      expect(textarea).toHaveStyle({ maxHeight: '120px' })
      expect(attachmentTray).toHaveStyle({ maxHeight: '128px' })
    })

    expect(120 + 128 + 140 + 12).toBeLessThanOrEqual(400)

    restoreParentRect.mockRestore()
  })

  it.each([false, true])(
    'budgets image previews from the boxed panel through display:contents wrappers (loading=%s)',
    async (isLoading) => {
      const onPreviewImage = vi.fn()
      const onRemoveAttachment = vi.fn()
      render(
        <ThemeProvider theme={theme}>
          <div data-testid="layout-panel" style={{ height: 600, width: 360 }}>
            <div style={{ display: 'contents' }}>
              <div style={{ display: 'contents' }}>
                <ChatComposer
                  inputValue={Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n')}
                  onInputChange={vi.fn()}
                  onSend={vi.fn()}
                  onUploadFile={vi.fn()}
                  pendingAttachments={[{ type: 'image', url: 'data:image/png;base64,attachment' }]}
                  uploadProgress={{}}
                  onRemoveAttachment={onRemoveAttachment}
                  isLoading={isLoading}
                  onStopGenerating={vi.fn()}
                  disabled={false}
                  composerInputRef={{ current: null }}
                  onPreviewImage={onPreviewImage}
                />
              </div>
            </div>
          </div>
        </ThemeProvider>
      )
      const panel = screen.getByTestId('layout-panel')
      const root = screen.getByTestId('chat-composer-root')
      const panelRect = vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(createRect(0, 600))
      const wrapperRect = vi
        .spyOn(root.parentElement!, 'getBoundingClientRect')
        .mockReturnValue(createRect(0, 0))
      try {
        fireEvent(window, new Event('resize'))
        await waitFor(() => {
          expect(screen.getByTestId('chat-composer-attachments')).toHaveStyle({ maxHeight: '192px' })
          expect(screen.getByTestId('chat-composer-input')).toHaveStyle({ maxHeight: '256px' })
        })
        fireEvent.click(screen.getByRole('img', { name: 'Preview 1' }))
        expect(onPreviewImage).toHaveBeenCalledWith('data:image/png;base64,attachment')
        const tray = screen.getByTestId('chat-composer-attachments')
        fireEvent.click(within(tray).getByRole('button'))
        expect(onRemoveAttachment).toHaveBeenCalledWith(0)
      } finally {
        wrapperRect.mockRestore()
        panelRect.mockRestore()
      }
    }
  )

  it('observes the boxed panel rather than a boxless composer wrapper', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const observers: Array<{
      callback: ResizeObserverCallback
      observe: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
    }> = []
    class MockResizeObserver {
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, observe: this.observe, disconnect: this.disconnect })
      }
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    try {
      const view = render(
        <div data-testid="layout-panel">
          <div style={{ display: 'contents' }}>
            <ControlledChatComposer initialValue="hello" />
          </div>
        </div>
      )
      const panel = screen.getByTestId('layout-panel')
      expect(observers[0].observe).toHaveBeenCalledWith(panel)
      const panelRect = vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(createRect(0, 400))
      try {
        act(() => observers[0].callback([], {} as ResizeObserver))
        await waitFor(() =>
          expect(screen.getByTestId('chat-composer-input')).toHaveStyle({ maxHeight: '260px' })
        )
        view.unmount()
        expect(observers[0].disconnect).toHaveBeenCalledOnce()
      } finally {
        panelRect.mockRestore()
      }
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })

  it.each(['outer', 'inner'] as const)(
    'keeps preview height across hiding, resizing and restoring the %s view wrapper',
    async (hiddenWrapper) => {
      const composer = (hidden: boolean, count = 1) => (
        <ThemeProvider theme={theme}>
          <div data-testid="layout-panel">
            <div style={{ display: hidden && hiddenWrapper === 'outer' ? 'none' : 'contents' }}>
              <div style={{ display: hidden && hiddenWrapper === 'inner' ? 'none' : 'contents' }}>
                <ChatComposer
                  inputValue="draft"
                  onInputChange={vi.fn()}
                  onSend={vi.fn()}
                  onUploadFile={vi.fn()}
                  pendingAttachments={Array.from({ length: count }, (_, index) => ({
                    type: 'image' as const,
                    url: `data:image/png;base64,attachment-${index}`
                  }))}
                  uploadProgress={{}}
                  onRemoveAttachment={vi.fn()}
                  isLoading={false}
                  onStopGenerating={vi.fn()}
                  disabled={false}
                  composerInputRef={{ current: null }}
                  onPreviewImage={vi.fn()}
                />
              </div>
            </div>
          </div>
        </ThemeProvider>
      )
      const view = render(composer(false))
      const panelRect = vi
        .spyOn(screen.getByTestId('layout-panel'), 'getBoundingClientRect')
        .mockReturnValue(createRect(0, 600))
      try {
        fireEvent(window, new Event('resize'))
        await waitFor(() =>
          expect(screen.getByTestId('chat-composer-attachments')).toHaveStyle({ maxHeight: '192px' })
        )
        view.rerender(composer(true))
        await act(async () => {
          fireEvent(window, new Event('resize'))
          await new Promise((resolve) => requestAnimationFrame(resolve))
        })
        expect(screen.getByTestId('chat-composer-attachments')).toHaveStyle({ maxHeight: '192px' })
        view.rerender(composer(true, 2))
        view.rerender(composer(false, 2))
        expect(screen.getByTestId('chat-composer-attachments')).toHaveStyle({ maxHeight: '192px' })
        expect(screen.getByTestId('chat-composer-input')).toHaveStyle({ maxHeight: '256px' })
      } finally {
        panelRect.mockRestore()
      }
    }
  )

  it('preserves the last preview budget while the whole pane has no layout height', async () => {
    render(
      <ThemeProvider theme={theme}>
        <div data-testid="layout-panel">
          <ChatComposer
            inputValue="draft"
            onInputChange={vi.fn()}
            onSend={vi.fn()}
            onUploadFile={vi.fn()}
            pendingAttachments={[{ type: 'image', url: 'data:image/png;base64,attachment' }]}
            uploadProgress={{}}
            onRemoveAttachment={vi.fn()}
            isLoading={false}
            onStopGenerating={vi.fn()}
            disabled={false}
            composerInputRef={{ current: null }}
            onPreviewImage={vi.fn()}
          />
        </div>
      </ThemeProvider>
    )
    const panelRect = vi
      .spyOn(screen.getByTestId('layout-panel'), 'getBoundingClientRect')
      .mockReturnValue(createRect(0, 600))
    try {
      fireEvent(window, new Event('resize'))
      await waitFor(() =>
        expect(screen.getByTestId('chat-composer-attachments')).toHaveStyle({ maxHeight: '192px' })
      )
      panelRect.mockReturnValue(createRect(0, 0))
      await act(async () => {
        fireEvent(window, new Event('resize'))
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
      expect(screen.getByTestId('chat-composer-attachments')).toHaveStyle({ maxHeight: '192px' })
    } finally {
      panelRect.mockRestore()
    }
  })

  it('keeps large attachment batches in a scrollable preview tray', async () => {
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

    await waitFor(() => {
      expect(attachmentTray).toHaveStyle({
        maxHeight: '192px',
        overflowY: 'auto',
        overflowX: 'hidden'
      })
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

  it('reveals an over-limit hidden image for removal without granting a count exemption', () => {
    const onRemoveAttachment = vi.fn()
    const attachments = [
      ...Array.from({ length: 50 }, (_, index) => ({ type: 'image' as const, url: `data:image/png;base64,${index}`, fileName: `image-${index}.png` })),
      { type: 'image' as const, url: 'data:image/png;base64,HIDDEN', fileName: 'canvas-selection.png', hiddenFromChatView: true }
    ]
    render(<ThemeProvider theme={theme}><ChatComposer
      inputValue="fixture" onInputChange={vi.fn()} onSend={vi.fn()} onUploadFile={vi.fn()}
      pendingAttachments={attachments} uploadProgress={{}} onRemoveAttachment={onRemoveAttachment}
      isLoading={false} onStopGenerating={vi.fn()} disabled={false}
      composerInputRef={{ current: null }} onPreviewImage={vi.fn()}
    /></ThemeProvider>)
    const tray = screen.getByTestId('chat-composer-attachments')
    expect(within(tray).getByRole('img', { name: 'Preview 51' })).toBeInTheDocument()
    expect(within(tray).getByTitle('canvas-selection.png')).toBeInTheDocument()
    const buttons = within(tray).getAllByRole('button')
    fireEvent.click(buttons[50])
    expect(onRemoveAttachment).toHaveBeenCalledWith(50)
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

  it('coalesces ResizeObserver layout recalculations without a synchronous update loop', async () => {
    const originalResizeObserver = globalThis.ResizeObserver
    const callbacks: ResizeObserverCallback[] = []
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const { container } = render(<ControlledChatComposer initialValue="hello" />)
      const root = container.querySelector('[data-testid="chat-composer-root"]')
      const parent = root?.parentElement
      expect(parent).toBeTruthy()
      vi.spyOn(parent as HTMLElement, 'getBoundingClientRect').mockReturnValue(createRect(0, 640))

      for (let index = 0; index < 20; index += 1) {
        callbacks.forEach((callback) => callback([], {} as ResizeObserver))
      }

      await new Promise((resolve) => requestAnimationFrame(resolve))

      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Maximum update depth exceeded')
      )
    } finally {
      consoleErrorSpy.mockRestore()
      globalThis.ResizeObserver = originalResizeObserver
    }
  })
})
