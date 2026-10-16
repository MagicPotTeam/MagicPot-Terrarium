import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMChatResp } from '@shared/api/svcLLMProxy'
import type { ProjectDetailsDialogProps } from '../../pages/MainPage/ProjectDetailsDialog'
import ProjectOneShotPanel from './ProjectOneShotPanel'

const mocks = vi.hoisted(() => ({
  listProfiles: vi.fn(),
  config: { current: { use_remote_llm: false } },
  chat: vi.fn(),
  cancelConversation: vi.fn(),
  runTools: vi.fn(),
  createProjectRecord: vi.fn(),
  getProjectById: vi.fn(),
  updateProjectAnalysisDetails: vi.fn(),
  readRecentProjectTraceEvents: vi.fn(),
  clearRecentProjectTraceEvents: vi.fn(),
  sanitizeProjectHistory: vi.fn(),
  buildProjectComparison: vi.fn(),
  readProjectComparisons: vi.fn(),
  readProjectComparisonsState: vi.fn(),
  saveProjectComparison: vi.fn(),
  clearProjectComparisons: vi.fn()
}))
vi.mock('../../utils/windowUtils', () => ({ api: () => ({ svcLLMProxy: mocks }) }))
vi.mock('../../hooks/useConfig', () => ({ useConfig: () => ({ config: mocks.config.current }) }))
vi.mock('../../pages/MainPage/projectStore', () => ({
  ...mocks,
  PROJECTS_CHANGED_EVENT: 'projects-changed'
}))
vi.mock('./projectTraceRuntime', () => ({ ...mocks, PROJECT_TRACE_RUNTIME_EVENT: 'trace-event' }))
vi.mock('./projectOneShotTrace', () => mocks)
vi.mock('../../pages/MainPage/ProjectDetailsDialog', () => ({
  default: ({ open, onSubmit, onClose }: ProjectDetailsDialogProps) =>
    open ? (
      <div role="dialog" aria-label="Edit project details">
        <button
          onClick={() => {
            void onSubmit({
              name: 'Do not rename',
              introduction: 'Updated introduction',
              analysisProfileId: 'bound'
            })
            onClose()
          }}
        >
          Save details
        </button>
      </div>
    ) : null
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(options?.[name] ?? '')
      )
  })
}))

type TestProject = { id: string; name: string; introduction?: string; analysisProfileId?: string }
type TestResult = {
  id: string
  at: string
  profileId: string
  eventCount: number
  advice: string
  estimatedInputTokens: number
  actualTotalTokens?: number
}
let project: TestProject | undefined
let events: { action: string; id?: string; at?: string }[]
let results: TestResult[]
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const runButton = () => screen.getByRole('button', { name: 'Once trace' })
const reviewButton = () => screen.getByRole('button', { name: 'Review payload' })
const ready = async () => waitFor(() => expect(reviewButton()).toBeEnabled())
const reviewAndConsent = async () => {
  await ready()
  fireEvent.click(reviewButton())
  expect(runButton()).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox'))
}
const start = async () => {
  await reviewAndConsent()
  fireEvent.click(runButton())
}
const storedResult: TestResult = {
  id: 'result-1',
  at: '2026-06-01T00:00:00.000Z',
  profileId: 'bound',
  eventCount: 1,
  advice: 'Stored advice',
  estimatedInputTokens: 100
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.config.current = { use_remote_llm: false }
  mocks.cancelConversation.mockResolvedValue({ cancelled: true })
  mocks.clearRecentProjectTraceEvents.mockImplementation(() => {
    events = []
  })
  project = {
    id: 'p1',
    name: 'Project',
    introduction: 'Project intent',
    analysisProfileId: 'bound'
  }
  events = [{ action: 'canvas.move' }]
  results = []
  mocks.getProjectById.mockImplementation((id: string) =>
    project ? { ...project, id } : undefined
  )
  mocks.listProfiles.mockResolvedValue({
    comparisonDestination: { kind: 'local' },
    profiles: [
      {
        id: 'other',
        model_name: 'Never fallback',
        model_use: 'default',
        configurationRevision: 'a'.repeat(64)
      },
      {
        id: 'bound',
        model_name: 'Chosen model',
        model_use: 'chat',
        configurationRevision: 'b'.repeat(64)
      }
    ]
  })
  mocks.readRecentProjectTraceEvents.mockImplementation(() => events)
  mocks.sanitizeProjectHistory.mockImplementation((value: unknown[]) => value.slice(0, 120))
  mocks.readProjectComparisons.mockImplementation(() => [...results])
  mocks.readProjectComparisonsState.mockImplementation(() => ({
    results: [...results],
    unavailable: false
  }))
  mocks.saveProjectComparison.mockImplementation((_: string, result: TestResult) => {
    results = [result, ...results].slice(0, 10)
  })
  mocks.clearProjectComparisons.mockImplementation(() => {
    results = []
  })
  mocks.buildProjectComparison.mockImplementation(
    (input: TestProject, inputEvents: unknown[], profileId: string) => {
      const request = {
        profileId,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({ introduction: input.introduction, events: inputEvents })
          }
        ],
        maxOutputTokens: 1000
      }
      return {
        request,
        preview: JSON.stringify(request),
        eventCount: inputEvents.length,
        estimatedInputTokens: 100,
        payloadBytes: 400
      }
    }
  )
  mocks.chat.mockResolvedValue({ content: 'Useful advice', usage: { totalTokens: 150 } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ProjectOneShotPanel history ranges', () => {
  const rangeEvents = () => [
    { id: 'event-a', action: 'canvas.open' },
    { id: 'event-b', action: 'canvas.move' },
    { id: 'event-c', action: 'agent.reply' }
  ]
  const chooseStart = (value: string) =>
    fireEvent.change(screen.getByRole('combobox', { name: 'History start' }), { target: { value } })
  const chooseEnd = (value: string) =>
    fireEvent.change(screen.getByRole('combobox', { name: 'History end' }), { target: { value } })

  it('keeps unsaved advice when only the next analysis range changes', async () => {
    events = rangeEvents()
    mocks.saveProjectComparison.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    await screen.findByText(/SAVE_FAILED:/)
    chooseStart('event-b')
    expect(screen.getByText('Useful advice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving this advice' }))
    await waitFor(() =>
      expect(screen.getByText('Saved comparison history (1)')).toBeInTheDocument()
    )
    expect(mocks.chat).toHaveBeenCalledTimes(1)
    expect(results[0].eventCount).toBe(3)
  })

  it('defaults to all history and sends only the explicitly selected inclusive range', async () => {
    events = rangeEvents()
    const original = structuredClone(events)
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    expect(screen.getByRole('combobox', { name: 'History start' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'History end' })).toHaveValue('')
    expect(screen.getByText(/Selected 3 of 3 available events/)).toBeInTheDocument()
    chooseStart('event-b')
    chooseEnd('event-c')
    expect(screen.getByText(/Selected 2 of 3 available events/)).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
    await start()
    await waitFor(() => expect(mocks.saveProjectComparison).toHaveBeenCalledTimes(1))
    const request = mocks.chat.mock.calls[0][0]
    expect(JSON.parse(request.messages[0].content).events).toEqual(original.slice(1))
    expect(events).toEqual(original)
    expect(mocks.clearRecentProjectTraceEvents).not.toHaveBeenCalled()
    expect(mocks.updateProjectAnalysisDetails).not.toHaveBeenCalled()
    expect(mocks.runTools).not.toHaveBeenCalled()
  })

  it('changing the range invalidates consent while new events cannot alter a reviewed snapshot', async () => {
    events = rangeEvents()
    render(<ProjectOneShotPanel projectId="p1" />)
    await reviewAndConsent()
    expect(runButton()).toBeEnabled()
    chooseStart('event-b')
    expect(runButton()).toBeDisabled()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
    await reviewAndConsent()
    events.push({ id: 'event-d', action: 'later.event' })
    act(() => window.dispatchEvent(new Event('trace-event')))
    fireEvent.click(runButton())
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(1))
    expect(
      JSON.parse(mocks.chat.mock.calls[0][0].messages[0].content).events.map(
        (event: { id: string }) => event.id
      )
    ).toEqual(['event-b', 'event-c'])
  })

  it('blocks reversed ranges instead of silently including the entire history', async () => {
    events = rangeEvents()
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    chooseStart('event-c')
    chooseEnd('event-a')
    expect(reviewButton()).toBeDisabled()
    expect(runButton()).toBeDisabled()
    expect(screen.getByText(/The range is reversed/)).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.buildProjectComparison).not.toHaveBeenCalled()
    chooseEnd('')
    await ready()
    fireEvent.click(reviewButton())
    expect(mocks.buildProjectComparison.mock.calls.at(-1)?.[1]).toEqual([events[2]])
  })

  it('does not shift explicit anchors after retention removes older events', async () => {
    events = rangeEvents()
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    chooseStart('event-b')
    chooseEnd('event-c')
    events = events.slice(1)
    act(() => window.dispatchEvent(new Event('trace-event')))
    await ready()
    fireEvent.click(reviewButton())
    expect(mocks.buildProjectComparison.mock.calls.at(-1)?.[1]).toEqual(events)
    events = events.slice(1)
    act(() => window.dispatchEvent(new Event('trace-event')))
    expect(reviewButton()).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'History start' })).toHaveValue('event-b')
    expect(screen.getByText(/The range is reversed/)).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('lets the user reset expired endpoints even when no history remains', async () => {
    events = rangeEvents()
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    chooseStart('event-b')
    events = []
    act(() => window.dispatchEvent(new Event('trace-event')))
    expect(reviewButton()).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'History start' })).toBeEnabled()
    chooseStart('')
    await ready()
    expect(screen.getByText(/Selected 0 of 0 available events/)).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('resets the range when switching projects instead of carrying another project endpoints', async () => {
    events = rangeEvents()
    const { rerender } = render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    chooseStart('event-b')
    chooseEnd('event-b')
    rerender(<ProjectOneShotPanel projectId="p2" />)
    await ready()
    expect(screen.getByRole('combobox', { name: 'History start' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'History end' })).toHaveValue('')
    expect(screen.getByText(/Selected 3 of 3 available events/)).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
  })
})

describe('ProjectOneShotPanel', () => {
  it('reads metadata and history without automatic model, create, edit, tools or fetch work', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { rerender } = render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    expect(mocks.listProfiles).toHaveBeenCalledExactlyOnceWith({
      includeConfigurationRevision: true,
      comparisonRouting: 'configured'
    })
    expect(screen.getByText('Bound model: Chosen model (bound)')).toBeInTheDocument()
    expect(screen.getByText(/last 120 events within 30 days/)).toBeInTheDocument()
    expect(screen.getByText('Recent local events: 1')).toBeInTheDocument()
    rerender(<ProjectOneShotPanel projectId="p1" />)
    events.push({ action: 'qapp.run' })
    act(() => window.dispatchEvent(new Event('trace-event')))
    expect(screen.getByText('Recent local events: 2')).toBeInTheDocument()
    events.push({ action: 'agent.reply' })
    act(() => window.dispatchEvent(new Event('storage')))
    expect(screen.getByText('Recent local events: 3')).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.buildProjectComparison).not.toHaveBeenCalled()
    expect(mocks.createProjectRecord).not.toHaveBeenCalled()
    expect(mocks.updateProjectAnalysisDetails).not.toHaveBeenCalled()
    expect(mocks.runTools).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(mocks.clearProjectComparisons).not.toHaveBeenCalled()
    expect(runButton()).toBeDisabled()
  })

  it('surfaces unavailable comparison history instead of presenting it as empty', async () => {
    mocks.readProjectComparisonsState.mockReturnValue({ results: [], unavailable: true })
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    expect(screen.getByText(/HISTORY_UNAVAILABLE:/)).toBeInTheDocument()
    expect(screen.getByText('Saved comparison history unavailable')).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('retries an unavailable history read without treating it as empty', async () => {
    mocks.readProjectComparisonsState.mockReturnValue({ results: [], unavailable: true })
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    expect(screen.getByText('Saved comparison history unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry reading history' })).toBeInTheDocument()

    mocks.readProjectComparisonsState.mockReturnValue({
      results: [storedResult],
      unavailable: false
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry reading history' }))
    await waitFor(() =>
      expect(screen.getByText('Saved comparison history (1)')).toBeInTheDocument()
    )
    expect(screen.queryByText('Saved comparison history unavailable')).not.toBeInTheDocument()
    expect(screen.getByText('Stored advice')).toBeInTheDocument()
  })

  it('requires preview and consent and sends exactly the fixed bound-model snapshot once', async () => {
    const response = deferred<LLMChatResp>()
    mocks.chat.mockReturnValue(response.promise)
    render(<ProjectOneShotPanel projectId="p1" />)
    await reviewAndConsent()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.buildProjectComparison).toHaveBeenCalledWith(project, events, 'bound', 'en')
    const built = mocks.buildProjectComparison.mock.results[0].value
    const snapshot = JSON.parse(JSON.stringify(built.request))
    built.request.messages[0].content = 'mutation must not be sent'
    events.push({ action: 'target.changed' })
    act(() => window.dispatchEvent(new Event('trace-event')))
    expect(screen.getByRole('checkbox')).toBeChecked()
    const button = runButton()
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(mocks.chat).toHaveBeenCalledExactlyOnceWith(
      {
        ...snapshot,
        expectedProfileRevision: 'b'.repeat(64),
        comparisonRouting: 'configured',
        conversationId: expect.stringMatching(/^project-comparison-/)
      },
      {
        signal: expect.any(AbortSignal)
      }
    )
    expect(mocks.buildProjectComparison).toHaveBeenCalledOnce()
    await act(async () => response.resolve({ content: 'Done', usage: { totalTokens: 151 } }))
    expect(mocks.saveProjectComparison).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        eventCount: 1,
        profileId: 'bound',
        advice: 'Done',
        actualTotalTokens: 151
      })
    )
    expect(runButton()).toBeDisabled()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('invalidates consent when settings change even if the bound profile ID stays the same', async () => {
    const view = render(<ProjectOneShotPanel projectId="p1" />)
    await reviewAndConsent()
    mocks.config.current = { use_remote_llm: false }
    mocks.listProfiles.mockResolvedValue({
      comparisonDestination: { kind: 'local' },
      profiles: [
        {
          id: 'bound',
          model_name: 'Changed destination',
          model_use: 'chat',
          configurationRevision: 'c'.repeat(64)
        }
      ]
    })
    view.rerender(<ProjectOneShotPanel projectId="p1" />)
    expect(runButton()).toBeDisabled()
    expect(screen.queryByRole('checkbox')).toBeNull()
    await ready()
    expect(mocks.chat).not.toHaveBeenCalled()
    await start()
    await waitFor(() => expect(mocks.chat).toHaveBeenCalled())
    expect(mocks.chat.mock.calls[0][0].expectedProfileRevision).toBe('c'.repeat(64))
  })

  it('discloses and uses only the configured remote destination after fixed consent', async () => {
    mocks.config.current = { use_remote_llm: true }
    mocks.listProfiles.mockResolvedValue({
      comparisonDestination: { kind: 'remote', origin: 'https://proxy.fixture.invalid' },
      profiles: [
        {
          id: 'bound',
          model_name: 'Remote model',
          model_use: 'chat',
          configurationRevision: 'd'.repeat(64)
        }
      ]
    })
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    expect(
      screen.getByText(/Remote comparison server: https:\/\/proxy.fixture.invalid/)
    ).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
    await start()
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledOnce())
    expect(mocks.chat.mock.calls[0][0]).toMatchObject({
      profileId: 'bound',
      expectedProfileRevision: 'd'.repeat(64),
      comparisonRouting: 'configured'
    })
    expect(JSON.stringify(mocks.chat.mock.calls[0][0])).not.toContain('proxy.fixture.invalid')
  })

  it('does not reuse local consent when switching to remote mode with a colliding profile ID', async () => {
    const view = render(<ProjectOneShotPanel projectId="p1" />)
    await reviewAndConsent()
    mocks.config.current = { use_remote_llm: true }
    mocks.listProfiles.mockResolvedValue({
      comparisonDestination: { kind: 'remote', origin: 'https://new.fixture.invalid' },
      profiles: [
        {
          id: 'bound',
          model_name: 'Remote',
          model_use: 'chat',
          configurationRevision: 'e'.repeat(64)
        }
      ]
    })
    view.rerender(<ProjectOneShotPanel projectId="p1" />)
    expect(runButton()).toBeDisabled()
    expect(screen.queryByRole('checkbox')).toBeNull()
    await ready()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it.each(['no-revision', 'remote'])(
    'fails closed for %s rather than routing a consentless local request',
    async (kind) => {
      if (kind === 'remote') mocks.config.current = { use_remote_llm: true }
      else
        mocks.listProfiles.mockResolvedValue({
          comparisonDestination: { kind: 'local' },
          profiles: [{ id: 'bound', model_name: 'Legacy service', model_use: 'chat' }]
        })
      render(<ProjectOneShotPanel projectId="p1" />)
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
      expect(runButton()).toBeDisabled()
      expect(reviewButton()).toBeDisabled()
      expect(mocks.chat).not.toHaveBeenCalled()
    }
  )

  it('explains main revision refusal without raw error details or an automatic retry', async () => {
    mocks.chat.mockRejectedValue(
      new Error('Model configuration changed; review and confirm again.')
    )
    render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    await screen.findByText(/Model configuration changed. Refresh model metadata/)
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(mocks.saveProjectComparison).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh model metadata' }))
    await ready()
    expect(runButton()).toBeDisabled()
  })

  it('resets acknowledgement when reviewing another snapshot', async () => {
    render(<ProjectOneShotPanel projectId="p1" />)
    await reviewAndConsent()
    fireEvent.click(reviewButton())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(runButton()).toBeDisabled()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('cancels despite IPC ignoring abort, ignores late replies and never retries', async () => {
    const response = deferred<LLMChatResp>()
    mocks.chat.mockReturnValue(response.promise)
    render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    const signal = mocks.chat.mock.calls[0][1].signal as AbortSignal
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }))
    expect(signal.aborted).toBe(true)
    expect(mocks.cancelConversation).toHaveBeenCalledExactlyOnceWith({
      conversationId: mocks.chat.mock.calls[0][0].conversationId
    })
    expect(screen.getByText(/CANCELLED:.*may still run and charge tokens/)).toBeInTheDocument()
    expect(reviewButton()).toBeEnabled()
    await act(async () => response.resolve({ content: 'Late advice' }))
    expect(screen.queryByText('Late advice')).not.toBeInTheDocument()
    expect(mocks.saveProjectComparison).not.toHaveBeenCalled()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(runButton()).toBeDisabled()
  })

  it('times out at 120 seconds even if IPC never settles', async () => {
    const response = deferred<LLMChatResp>()
    mocks.chat.mockReturnValue(response.promise)
    render(<ProjectOneShotPanel projectId="p1" />)
    await reviewAndConsent()
    vi.useFakeTimers()
    fireEvent.click(runButton())
    await act(async () => vi.advanceTimersByTimeAsync(119_999))
    expect(screen.queryByText(/TIMEOUT:/)).not.toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByText(/TIMEOUT:.*120 seconds/)).toBeInTheDocument()
    expect(mocks.chat.mock.calls[0][1].signal.aborted).toBe(true)
    expect(mocks.cancelConversation).toHaveBeenCalledExactlyOnceWith({
      conversationId: mocks.chat.mock.calls[0][0].conversationId
    })
    expect(reviewButton()).toBeEnabled()
    await act(async () => response.resolve({ content: 'Too late' }))
    expect(mocks.saveProjectComparison).not.toHaveBeenCalled()
    expect(mocks.chat).toHaveBeenCalledOnce()
  })

  it.each(['project', 'profile', 'introduction', 'unmount'] as const)(
    'aborts and ignores stale replies on %s changes',
    async (change) => {
      const response = deferred<LLMChatResp>()
      mocks.chat.mockReturnValue(response.promise)
      const view = render(<ProjectOneShotPanel projectId="p1" />)
      await start()
      const signal = mocks.chat.mock.calls[0][1].signal as AbortSignal
      if (change === 'unmount') view.unmount()
      else if (change === 'project') view.rerender(<ProjectOneShotPanel projectId="p2" />)
      else {
        project = {
          ...project!,
          ...(change === 'profile'
            ? { analysisProfileId: 'other' }
            : { introduction: 'Changed intent' })
        }
        act(() => window.dispatchEvent(new Event('projects-changed')))
      }
      expect(signal.aborted).toBe(true)
      await act(async () => response.resolve({ content: 'Old scope advice' }))
      expect(mocks.saveProjectComparison).not.toHaveBeenCalled()
      expect(screen.queryByText('Old scope advice')).not.toBeInTheDocument()
      expect(mocks.chat).toHaveBeenCalledOnce()
      if (change !== 'unmount') expect(runButton()).toBeDisabled()
    }
  )

  it('ignores a reply racing an uncommitted store update', async () => {
    const response = deferred<LLMChatResp>()
    mocks.chat.mockReturnValue(response.promise)
    render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    project = { ...project!, introduction: 'Changed before the event' }
    await act(async () => response.resolve({ content: 'Stale reply' }))
    expect(mocks.saveProjectComparison).not.toHaveBeenCalled()
    expect(mocks.chat.mock.calls[0][1].signal.aborted).toBe(true)
    expect(screen.queryByText('Stale reply')).not.toBeInTheDocument()
  })

  it('invalidates confirmed previews on details changes and rechecks before sending', async () => {
    render(<ProjectOneShotPanel projectId="p1" />)
    await reviewAndConsent()
    project = { ...project!, introduction: 'Changed outside the panel' }
    fireEvent.click(runButton())
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await reviewAndConsent()
    project = { ...project!, analysisProfileId: 'other' }
    act(() => window.dispatchEvent(new Event('projects-changed')))
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(runButton()).toBeDisabled()
  })

  it.each(['absent', 'missing', 'unsupported', 'no-introduction', 'no-project'])(
    'fails closed for %s without model fallback',
    async (condition) => {
      if (condition === 'absent') project!.analysisProfileId = ''
      if (condition === 'missing') project!.analysisProfileId = 'deleted'
      if (condition === 'unsupported') {
        mocks.listProfiles.mockResolvedValue({
          comparisonDestination: { kind: 'local' },
          profiles: [{ id: 'bound', model_name: 'Image model', model_use: 'image' }]
        })
      }
      if (condition === 'no-introduction') project!.introduction = ' '
      if (condition === 'no-project') project = undefined
      render(<ProjectOneShotPanel projectId="p1" />)
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
      expect(reviewButton()).toBeDisabled()
      expect(runButton()).toBeDisabled()
      fireEvent.click(reviewButton())
      fireEvent.click(runButton())
      expect(mocks.buildProjectComparison).not.toHaveBeenCalled()
      expect(mocks.chat).not.toHaveBeenCalled()
    }
  )

  it.each(['default', 'chat', 'agent', 'multimodal', 'reasoning', 'coding'])(
    'accepts the explicitly bound %s profile',
    async (model_use) => {
      mocks.listProfiles.mockResolvedValue({
        comparisonDestination: { kind: 'local' },
        profiles: [
          { id: 'bound', model_name: 'Chosen', model_use, configurationRevision: 'b'.repeat(64) }
        ]
      })
      render(<ProjectOneShotPanel projectId="p1" />)
      await ready()
      expect(mocks.chat).not.toHaveBeenCalled()
    }
  )

  it.each(['throw', 'model-budget', 'wrong-profile'])(
    'blocks unsafe preview: %s',
    async (condition) => {
      if (condition === 'throw') {
        mocks.buildProjectComparison.mockImplementation(() => {
          throw new Error('private input/path secret')
        })
      }
      if (condition === 'model-budget') {
        mocks.listProfiles.mockResolvedValue({
          comparisonDestination: { kind: 'local' },
          profiles: [
            {
              id: 'bound',
              model_name: 'Tiny',
              model_use: 'chat',
              context_budget_tokens: 80,
              configurationRevision: 'b'.repeat(64)
            }
          ]
        })
      }
      if (condition === 'wrong-profile') {
        mocks.buildProjectComparison.mockReturnValue({
          request: { profileId: 'other', messages: [] },
          preview: '',
          estimatedInputTokens: 10,
          eventCount: 0,
          payloadBytes: 10
        })
      }
      render(<ProjectOneShotPanel projectId="p1" />)
      await ready()
      fireEvent.click(reviewButton())
      expect(screen.getByText(/INPUT_INVALID:/)).toBeInTheDocument()
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(runButton()).toBeDisabled()
      expect(mocks.chat).not.toHaveBeenCalled()
      expect(document.body.textContent).not.toContain('private input/path secret')
    }
  )

  it('shows safe metadata and request errors, not raw credentials or paths', async () => {
    mocks.listProfiles.mockRejectedValueOnce(new Error('secret-key C:/fixture-data/file'))
    const first = render(<ProjectOneShotPanel projectId="p1" />)
    await screen.findByText(/MODEL_METADATA_FAILED:/)
    expect(document.body.textContent).not.toMatch(/secret-key|C:\/fixture-data/)
    expect(reviewButton()).toBeDisabled()
    first.unmount()
    mocks.chat.mockRejectedValueOnce(new Error('secret-key C:/fixture-data/file'))
    render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    await screen.findByText(/REQUEST_FAILED:/)
    expect(document.body.textContent).not.toMatch(/secret-key|C:\/fixture-data/)
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(mocks.saveProjectComparison).not.toHaveBeenCalled()
    expect(runButton()).toBeDisabled()
  })

  it.each(['error', 'tool_call', 'cancelled'])(
    'does not persist or execute a %s response',
    async (finishReason) => {
      mocks.chat.mockResolvedValue({ content: 'Do not execute', finishReason })
      render(<ProjectOneShotPanel projectId="p1" />)
      await start()
      await screen.findByText(/INVALID_RESPONSE:/)
      expect(mocks.saveProjectComparison).not.toHaveBeenCalled()
      expect(mocks.runTools).not.toHaveBeenCalled()
    }
  )

  it('does not claim a result was saved when the post-write read cannot verify it', async () => {
    mocks.saveProjectComparison.mockImplementation(() => undefined)
    mocks.readProjectComparisons.mockReturnValue([])
    render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    await screen.findByText(/SAVE_FAILED:.*only in this session/)
    expect(screen.getByText('Useful advice')).toBeInTheDocument()
    expect(screen.getByText('Saved comparison history (0)')).toBeInTheDocument()
    expect(mocks.saveProjectComparison).toHaveBeenCalledOnce()
  })

  it('keeps failed advice pending and retries saving without sending another model request', async () => {
    mocks.saveProjectComparison.mockImplementationOnce(() => {
      throw new Error('quota secret')
    })
    render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    await screen.findByText(/SAVE_FAILED:/)
    expect(screen.getByText('Useful advice')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry saving this advice' })).toBeInTheDocument()
    expect(mocks.chat).toHaveBeenCalledOnce()

    mocks.saveProjectComparison.mockImplementation((_: string, result: TestResult) => {
      results = [result, ...results].slice(0, 10)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving this advice' }))
    await waitFor(() =>
      expect(screen.getByText('Saved comparison history (1)')).toBeInTheDocument()
    )
    expect(
      screen.queryByRole('button', { name: 'Retry saving this advice' })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/SAVE_FAILED:/)).not.toBeInTheDocument()
    expect(mocks.chat).toHaveBeenCalledOnce()
  })

  it('bounds advice to 16 KiB UTF-8, renders plain text and retains local history', async () => {
    results = [storedResult]
    const content = '<img src=x onerror=alert(1)>\n' + '界'.repeat(20_000)
    mocks.chat.mockResolvedValue({ content, usage: { totalTokens: 150 } })
    const view = render(<ProjectOneShotPanel projectId="p1" />)
    expect(screen.getByText('Stored advice')).toBeInTheDocument()
    await start()
    await waitFor(() => expect(mocks.saveProjectComparison).toHaveBeenCalledOnce())
    const saved = mocks.saveProjectComparison.mock.calls[0][1] as TestResult
    expect(new TextEncoder().encode(saved.advice).length).toBeLessThanOrEqual(16 * 1024)
    expect(new TextEncoder().encode(saved.advice).length).toBeGreaterThan(16 * 1024 - 4)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('Saved comparison history (2)')).toBeInTheDocument()
    expect(screen.getAllByText('Reported total tokens: 150')).not.toHaveLength(0)
    expect(mocks.runTools).not.toHaveBeenCalled()
    view.unmount()
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    expect(screen.getByText('Saved comparison history (2)')).toBeInTheDocument()
    expect(mocks.chat).toHaveBeenCalledOnce()
  })

  it('clears pending save when the project scope changes', async () => {
    mocks.saveProjectComparison.mockImplementationOnce(() => {
      throw new Error('quota secret')
    })
    const view = render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    await screen.findByText(/SAVE_FAILED:/)
    expect(screen.getByRole('button', { name: 'Retry saving this advice' })).toBeInTheDocument()

    view.rerender(<ProjectOneShotPanel projectId="p2" />)
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Retry saving this advice' })
      ).not.toBeInTheDocument()
    )
  })

  it('clears pending save when a newly reviewed request starts', async () => {
    mocks.saveProjectComparison.mockImplementationOnce(() => {
      throw new Error('quota secret')
    })
    const response = deferred<LLMChatResp>()
    render(<ProjectOneShotPanel projectId="p1" />)
    await start()
    await screen.findByText(/SAVE_FAILED:/)
    expect(screen.getByRole('button', { name: 'Retry saving this advice' })).toBeInTheDocument()

    mocks.chat.mockReturnValueOnce(response.promise)
    await reviewAndConsent()
    fireEvent.click(runButton())
    await waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(2))
    expect(
      screen.queryByRole('button', { name: 'Retry saving this advice' })
    ).not.toBeInTheDocument()
    await act(async () => response.resolve({ content: 'Second advice' }))
  })

  it.each(['throw', 'false'])(
    'discloses persistence failure (%s) without pretending advice was saved',
    async (mode) => {
      if (mode === 'throw') {
        mocks.saveProjectComparison.mockImplementation(() => {
          throw new Error('Quota secret C:/fixture-data')
        })
      } else mocks.saveProjectComparison.mockReturnValue(false)
      render(<ProjectOneShotPanel projectId="p1" />)
      await start()
      await screen.findByText(/SAVE_FAILED:.*only in this session/)
      expect(screen.getByText('Useful advice')).toBeInTheDocument()
      expect(screen.getByText('Saved comparison history (0)')).toBeInTheDocument()
      expect(document.body.textContent).not.toContain('Quota secret')
      expect(mocks.chat).toHaveBeenCalledOnce()
    }
  )

  it('clears only comparisons after confirmation; dismissing does not delete', async () => {
    results = [storedResult]
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Clear comparison results' }))
    expect(mocks.clearProjectComparisons).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Keep results' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.clearProjectComparisons).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Clear comparison results' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete comparison history' }))
    expect(mocks.clearProjectComparisons).toHaveBeenCalledExactlyOnceWith('p1')
    expect(screen.getByText('Saved comparison history (0)')).toBeInTheDocument()
    expect(screen.getByText('Recent local events: 1')).toBeInTheDocument()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('clears only operation events after confirmation and invalidates a reviewed snapshot', async () => {
    results = [storedResult]
    render(<ProjectOneShotPanel projectId="p1" />)
    await reviewAndConsent()
    fireEvent.click(screen.getByRole('button', { name: 'Clear recent operation events' }))
    expect(mocks.clearRecentProjectTraceEvents).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete recent events' }))
    expect(mocks.clearRecentProjectTraceEvents).toHaveBeenCalledExactlyOnceWith('p1')
    expect(mocks.clearProjectComparisons).not.toHaveBeenCalled()
    expect(screen.getByText('Recent local events: 0')).toBeInTheDocument()
    expect(screen.getByText('Stored advice')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(runButton()).toBeDisabled()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it('reports clear failure without removing visible history', async () => {
    results = [storedResult]
    mocks.clearProjectComparisons.mockImplementation(() => {
      throw new Error('secret path')
    })
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Clear comparison results' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete comparison history' }))
    expect(screen.getByText(/CLEAR_FAILED:/)).toBeInTheDocument()
    expect(screen.getByText('Stored advice')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('secret path')
  })

  it('edits only introduction and model binding, never name or model inference', async () => {
    render(<ProjectOneShotPanel projectId="p1" />)
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Edit introduction and model binding' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(mocks.updateProjectAnalysisDetails).toHaveBeenCalledExactlyOnceWith('p1', {
      introduction: 'Updated introduction',
      analysisProfileId: 'bound'
    })
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(mocks.createProjectRecord).not.toHaveBeenCalled()
    await ready()
  })
})
