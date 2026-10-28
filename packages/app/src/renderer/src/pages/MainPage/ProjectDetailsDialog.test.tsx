import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProjectDetailsDialog from './ProjectDetailsDialog'

const { listProfiles, chat, runTools } = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  chat: vi.fn(),
  runTools: vi.fn()
}))
vi.mock('../../utils/windowUtils', () => ({
  api: () => ({ svcLLMProxy: { listProfiles, chat, runTools } })
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; id?: string }) =>
      options?.defaultValue?.replace('{{id}}', options.id ?? '') ?? key
  })
}))

const initialValues = { name: 'Project', introduction: '', analysisProfileId: '' }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  listProfiles.mockResolvedValue({ profiles: [] })
})
afterEach(() => vi.restoreAllMocks())

describe('ProjectDetailsDialog', () => {
  it('loads only metadata when opened, filters nonchat uses and does not select a model implicitly', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const allowed = ['chat', 'agent', 'multimodal', 'reasoning', 'coding', 'default']
    const denied = ['image', 'video', '3d', 'vision', 'ocr', 'embedding', 'audio', 'unknown']
    listProfiles.mockResolvedValue({
      profiles: [
        ...allowed.map((use) => ({ id: use, model_name: `${use} model`, model_use: use })),
        ...denied.map((use) => ({ id: use, model_name: `${use} model`, model_use: use })),
        { id: 'legacy', model_name: 'Legacy model' },
        { id: 'chat', model_name: 'Duplicate' },
        { id: 'x'.repeat(513), model_name: 'Oversize reference' }
      ]
    })
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    const { rerender } = render(
      <ProjectDetailsDialog
        open={false}
        initialValues={initialValues}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )
    expect(listProfiles).not.toHaveBeenCalled()
    rerender(
      <ProjectDetailsDialog
        open
        initialValues={initialValues}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )
    await screen.findByRole('option', { name: 'chat model (chat)' })
    expect(listProfiles).toHaveBeenCalledExactlyOnceWith({ comparisonRouting: 'configured' })
    for (const use of allowed)
      expect(screen.getByRole('option', { name: `${use} model (${use})` })).toBeInTheDocument()
    for (const use of denied)
      expect(
        screen.queryByRole('option', { name: `${use} model (${use})` })
      ).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Duplicate (chat)' })).not.toBeInTheDocument()
    expect(screen.queryByText('Oversize reference')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.getByText(/You can capture offline/)).toBeInTheDocument()
    expect(screen.getByText(/use tokens or incur charges/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    expect(runTools).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps an unavailable binding visible and submits it unchanged without substitution', async () => {
    listProfiles.mockResolvedValue({
      profiles: [{ id: 'other', model_name: 'Other', model_use: 'chat' }]
    })
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <ProjectDetailsDialog
        open
        initialValues={{ ...initialValues, analysisProfileId: 'removed-profile' }}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )
    await screen.findByText(/The saved model is unavailable/)
    expect(
      screen.getByRole('option', { name: 'Unavailable model: removed-profile' })
    ).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveValue('removed-profile')
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(onSubmit).toHaveBeenCalledWith({
      ...initialValues,
      analysisProfileId: 'removed-profile'
    })
  })

  it('allows offline saving after a bounded, credential-safe metadata error', async () => {
    listProfiles.mockRejectedValue(
      new Error('secret-key https://private.invalid ' + 'x'.repeat(10000))
    )
    const onSubmit = vi.fn()
    render(
      <ProjectDetailsDialog
        open
        initialValues={initialValues}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />
    )
    await screen.findByText(
      'Unable to load configured models. Close and reopen this dialog to retry.'
    )
    expect(document.body.textContent).not.toMatch(/secret-key|private\.invalid/)
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(initialValues))
  })

  it('ignores late profiles from a closed dialog, a previous open, and after unmount', async () => {
    const first = deferred<{ profiles: { id: string; model_name: string }[] }>()
    const third = deferred<{ profiles: { id: string; model_name: string }[] }>()
    listProfiles
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ profiles: [{ id: 'current', model_name: 'Current' }] })
      .mockReturnValueOnce(third.promise)
    const props = { initialValues, onClose: vi.fn(), onSubmit: vi.fn() }
    const { rerender, unmount } = render(<ProjectDetailsDialog {...props} open />)
    rerender(<ProjectDetailsDialog {...props} open={false} />)
    rerender(<ProjectDetailsDialog {...props} open />)
    await screen.findByRole('option', { name: 'Current (current)' })
    await act(async () => first.resolve({ profiles: [{ id: 'old', model_name: 'Old' }] }))
    expect(screen.queryByRole('option', { name: 'Old (old)' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Current (current)' })).toBeInTheDocument()
    rerender(<ProjectDetailsDialog {...props} open={false} />)
    rerender(<ProjectDetailsDialog {...props} open />)
    unmount()
    await act(async () => third.resolve({ profiles: [{ id: 'late', model_name: 'Late' }] }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it.each([
    { ...initialValues, name: '  ' },
    { ...initialValues, name: 'x'.repeat(121) },
    { ...initialValues, introduction: 'x'.repeat(4001) },
    { ...initialValues, analysisProfileId: 'x'.repeat(513) }
  ])('blocks invalid form boundaries', async (values) => {
    const onSubmit = vi.fn()
    render(
      <ProjectDetailsDialog open initialValues={values} onClose={vi.fn()} onSubmit={onSubmit} />
    )
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Save project' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('preserves maximum-length multiline input and exact references on submit', async () => {
    const values = {
      name: 'x'.repeat(120),
      introduction: 'First\n' + 'x'.repeat(3993) + '\n',
      analysisProfileId: 'x'.repeat(512)
    }
    const onSubmit = vi.fn()
    render(
      <ProjectDetailsDialog open initialValues={values} onClose={vi.fn()} onSubmit={onSubmit} />
    )
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByRole('textbox', { name: /Project name/ })).toHaveAttribute(
      'maxlength',
      '120'
    )
    expect(screen.getByRole('textbox', { name: 'Introduction' })).toHaveAttribute(
      'maxlength',
      '4000'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(values))
  })

  it('keeps the dialog open on save failure without exposing exception contents', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('secret credential'))
    const onClose = vi.fn()
    render(
      <ProjectDetailsDialog
        open
        initialValues={initialValues}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Save project' }))
    await screen.findByText(
      'Unable to save project details. Check local storage availability and try again.'
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox', { name: /Project name/ })).toHaveValue('Project')
    expect(document.body.textContent).not.toContain('secret credential')
  })
})
