import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import {
  FIGPLUGIN_AUDIT_TTL_MS,
  type FigPluginPlanningAuditEvent,
  type FigPluginPlanningHistory
} from '@shared/figplugin/planningAudit'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import PluginPlanningHistoryPanel from './PluginPlanningHistoryPanel'

const mocks = vi.hoisted(() => ({
  history: vi.fn<FigPluginCenterSvc['planningHistory']>(),
  createPairing: vi.fn(),
  execute: vi.fn(),
  chat: vi.fn()
}))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcFigPluginCenter: {
      planningHistory: mocks.history,
      createPairing: mocks.createPairing,
      execute: mocks.execute
    },
    svcLLMProxy: { chat: mocks.chat }
  })
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key + (values ? ` ${JSON.stringify(values)}` : '')
  })
}))
const event = (
  overrides: Partial<FigPluginPlanningAuditEvent> = {}
): FigPluginPlanningAuditEvent => ({
  schemaVersion: 1,
  kind: 'planning',
  at: 1000,
  callId: '1'.repeat(32),
  correlationId: '2'.repeat(32),
  sequence: 1,
  requestId: 'owned_request',
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'project_1',
  profileId: 'profile_1',
  profileRevision: 'a'.repeat(64),
  featureId: 'read-only-analysis',
  state: 'awaiting-approval',
  durationMs: 0,
  inputBytes: 24,
  estimatedInputTokens: 6,
  nodeCount: 2,
  imageCount: 1,
  imageBytes: 10,
  ...overrides
})
const reply = (
  records: FigPluginPlanningAuditEvent[] = [],
  overrides: Partial<FigPluginPlanningHistory> = {}
): FigPluginPlanningHistory => ({
  records,
  truncated: false,
  recordedAt: 2000,
  retentionMs: FIGPLUGIN_AUDIT_TTL_MS,
  maxRecords: 256,
  maxBytes: 1048576,
  writeFailed: false,
  ...overrides
})
const items = [{ pluginId: 'owned.figma', name: 'Owned' }] as FigPluginManagedSummary[]
const key = (name: string) => `figplugin.planningHistory.${name}`
const load = () => fireEvent.click(screen.getByRole('button', { name: key('load') }))
const filter = (name: string, value: string) =>
  fireEvent.change(screen.getByLabelText(key(name)), { target: { value } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.history.mockResolvedValue(reply())
})
afterEach(cleanup)

describe('persisted planning history panel', () => {
  it('does no IPC on mount or StrictMode remount and offers only an explicit read action', () => {
    render(
      <StrictMode>
        <PluginPlanningHistoryPanel items={items} />
      </StrictMode>
    )
    expect(mocks.history).not.toHaveBeenCalled()
    expect(mocks.createPairing).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.chat).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText(key('boundary'))).toBeInTheDocument()
    expect(screen.getByText(key('dispatchBoundary'))).toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('keeps ID guidance outside bounded field labels and does not stretch the read button', () => {
    render(<PluginPlanningHistoryPanel items={items} />)
    for (const name of ['call', 'correlation']) {
      const input = screen.getByLabelText(key(name))
      expect(input).toHaveAccessibleDescription(key('hexIdHelp'))
      expect(input.closest('.MuiFormControl-root')).toHaveStyle({
        width: '320px',
        minWidth: '0',
        maxWidth: '100%',
        flexShrink: '0'
      })
    }
    expect(screen.getAllByText(key('hexIdHelp'))).toHaveLength(2)
    const button = screen.getByRole('button', { name: key('load') })
    expect(button).toHaveStyle({ height: '56px', flexShrink: '0' })
    expect(button.parentElement).toHaveStyle({ flexWrap: 'wrap', alignItems: 'flex-start' })
    expect(mocks.history).not.toHaveBeenCalled()
  })

  it('loads only metadata on explicit read without pairing, model dispatch or replay', async () => {
    mocks.history.mockResolvedValue(
      reply([
        event({
          state: 'completed',
          sequence: 4,
          featureId: 'plan-preview',
          provider: 'openai',
          modelName: 'bound-model',
          resultBytes: 0,
          reportedTotalTokens: 0,
          durationMs: 12
        })
      ])
    )
    render(<PluginPlanningHistoryPanel items={items} />)
    load()
    await screen.findByText(key('states.completed'))
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith({ limit: 50 })
    expect(screen.getByText(key('features.plan-preview'))).toBeInTheDocument()
    expect(screen.getByText(/figplugin.planningHistory.correlationId/)).toHaveTextContent(
      '2'.repeat(32)
    )
    expect(screen.getByText(/figplugin.planningHistory.input/)).toHaveTextContent('"imageBytes":10')
    expect(screen.getByText(/figplugin.planningHistory.binding/)).toHaveTextContent('bound-model')
    expect(screen.getByText(/figplugin.planningHistory.result /)).toHaveTextContent('"bytes":0')
    expect(screen.getByText(/figplugin.planningHistory.usage /)).toHaveTextContent('"tokens":0')
    expect(screen.getByText(/figplugin.planningHistory.revision/)).toHaveTextContent('a'.repeat(64))
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(mocks.createPairing).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.chat).not.toHaveBeenCalled()
  })

  it.each(['awaiting-approval', 'running', 'provider-dispatched'] as const)(
    'shows %s as historical evidence rather than a live or successful task',
    async (state) => {
      mocks.history.mockResolvedValue(reply([event({ state })]))
      render(<PluginPlanningHistoryPanel items={items} />)
      load()
      await screen.findByText(key(`states.${state}`))
      expect(screen.queryByText(key('states.completed'))).not.toBeInTheDocument()
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
      expect(screen.getByText(key('boundary'))).toBeInTheDocument()
      expect(screen.getByText(key('dispatchBoundary'))).toBeInTheDocument()
      expect(screen.getByText(/figplugin.planningHistory.binding/)).toHaveTextContent(
        key('notRecorded')
      )
    }
  )

  it('sends only validated exact filters and allows the ID of a removed plugin', async () => {
    render(<PluginPlanningHistoryPanel items={items} />)
    filter('plugin', 'removed.figma')
    filter('project', 'project_2')
    filter('call', '3'.repeat(32))
    filter('correlation', '4'.repeat(32))
    filter('limit', '100')
    expect(mocks.history).not.toHaveBeenCalled()
    load()
    await screen.findByText(key('empty'))
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith({
      pluginId: 'removed.figma',
      projectId: 'project_2',
      callId: '3'.repeat(32),
      correlationId: '4'.repeat(32),
      limit: 100
    })
  })

  it.each([
    ['call', 'invalid-id'],
    ['correlation', 'A'.repeat(32)],
    ['plugin', 'x'.repeat(129)],
    ['project', 'x'.repeat(161)],
    ['limit', '0']
  ])('rejects invalid outgoing %s before invoking IPC', async (name, value) => {
    render(<PluginPlanningHistoryPanel items={items} />)
    filter(name, value)
    load()
    await screen.findByText(key('error'))
    expect(mocks.history).not.toHaveBeenCalled()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: key('load') })).toBeEnabled()
  })

  it.each([
    ['plugin', 'removed.figma'],
    ['project', 'project_2'],
    ['call', '3'.repeat(32)],
    ['correlation', '4'.repeat(32)],
    ['limit', '100']
  ])(
    'invalidates an old response after changing %s without automatically loading',
    async (name, value) => {
      const old = deferred<FigPluginPlanningHistory>()
      mocks.history.mockReturnValueOnce(old.promise)
      render(<PluginPlanningHistoryPanel items={items} />)
      load()
      filter(name, value)
      await act(async () => old.resolve(reply([event()])))
      expect(mocks.history).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('article')).not.toBeInTheDocument()
      expect(screen.queryByText(key('error'))).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: key('load') })).toBeEnabled()
    }
  )

  it('does not let an earlier response replace a newer filtered read', async () => {
    const old = deferred<FigPluginPlanningHistory>()
    mocks.history.mockReturnValueOnce(old.promise)
    mocks.history.mockResolvedValueOnce(
      reply([event({ projectId: 'project_2', requestId: 'new_request' })])
    )
    render(<PluginPlanningHistoryPanel items={items} />)
    load()
    filter('project', 'project_2')
    load()
    await screen.findByText(/new_request/)
    await act(async () => old.resolve(reply([event()])))
    expect(screen.queryByText(/owned_request/)).not.toBeInTheDocument()
    expect(screen.getByText(/new_request/)).toBeInTheDocument()
    expect(mocks.history).toHaveBeenCalledTimes(2)
  })

  it('serializes repeated clicks and ignores a response after unmount and StrictMode remount', async () => {
    const old = deferred<FigPluginPlanningHistory>()
    mocks.history.mockReturnValueOnce(old.promise)
    const view = render(
      <StrictMode>
        <PluginPlanningHistoryPanel items={items} />
      </StrictMode>
    )
    act(() => {
      load()
      load()
    })
    expect(mocks.history).toHaveBeenCalledTimes(1)
    view.unmount()
    render(
      <StrictMode>
        <PluginPlanningHistoryPanel items={items} />
      </StrictMode>
    )
    expect(mocks.history).toHaveBeenCalledTimes(1)
    load()
    await screen.findByText(key('empty'))
    await act(async () => old.resolve(reply([event()])))
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByText(key('empty'))).toBeInTheDocument()
  })

  it.each([
    () => ({ ...reply(), endpoint: 'PRIVATE_ENDPOINT' }),
    () => reply([{ ...event(), prompt: 'PRIVATE_PROMPT' } as FigPluginPlanningAuditEvent]),
    () => reply([{ ...event(), imageBase64: 'PRIVATE_IMAGE' } as FigPluginPlanningAuditEvent]),
    () => reply([event({ errorCode: 'PRIVATE_ERROR' as never })]),
    () => reply([event({ state: 'failed' })]),
    () => reply([event({ state: 'completed' })]),
    () => reply([event({ resultBytes: 1 })]),
    () => reply(Array.from({ length: 51 }, () => event())),
    () => reply([], { retentionMs: 1 as never })
  ])('fails closed on malformed, excessive or secret-bearing responses', async (value) => {
    mocks.history.mockResolvedValue(value())
    render(<PluginPlanningHistoryPanel items={items} />)
    load()
    await screen.findByText(key('error'))
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it.each([
    ['plugin', 'other.figma'],
    ['project', 'other_project'],
    ['call', '3'.repeat(32)],
    ['correlation', '4'.repeat(32)]
  ])('rejects the entire response when a record mismatches the %s filter', async (name, value) => {
    mocks.history.mockResolvedValue(reply([event()]))
    render(<PluginPlanningHistoryPanel items={items} />)
    filter(name, value)
    load()
    await screen.findByText(key('error'))
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('sorts by descending time and sequence, then stable identities independent of response order', async () => {
    const records = [
      event({ at: 999, sequence: 4, requestId: 'oldest' }),
      event({ sequence: 2, callId: '2'.repeat(32), requestId: 'later-call' }),
      event({ sequence: 1, requestId: 'lower-sequence' }),
      event({ sequence: 2, correlationId: '3'.repeat(32), requestId: 'later-correlation' }),
      event({ sequence: 2, requestId: 'first-call-b' }),
      event({ sequence: 2, requestId: 'first-call-a' }),
      event({ at: 1001, requestId: 'newest' })
    ]
    mocks.history.mockResolvedValueOnce(reply(records))
    mocks.history.mockResolvedValueOnce(reply([...records].reverse()))
    render(<PluginPlanningHistoryPanel items={items} />)
    const displayedRequests = () =>
      screen
        .getAllByRole('article')
        .map(
          (article) => within(article).getByText(/figplugin.planningHistory.requestId /).textContent
        )
    const ordered = [
      'newest',
      'first-call-a',
      'first-call-b',
      'later-call',
      'later-correlation',
      'lower-sequence',
      'oldest'
    ].map((id) => `${key('requestId')} ${JSON.stringify({ id })}`)
    load()
    await screen.findByText(/newest/)
    expect(displayedRequests()).toEqual(ordered)
    load()
    await screen.findByText(/newest/)
    expect(displayedRequests()).toEqual(ordered)
  })

  it('uses canonical metadata as the final tie breaker when event identities match', async () => {
    mocks.history.mockResolvedValue(
      reply([event({ profileId: 'profile_z' }), event({ profileId: 'profile_a' })])
    )
    render(<PluginPlanningHistoryPanel items={items} />)
    load()
    await screen.findByText(/profile_a/)
    expect(
      screen
        .getAllByRole('article')
        .map(
          (article) => within(article).getByText(/figplugin.planningHistory.profile /).textContent
        )
    ).toEqual(['profile_a', 'profile_z'].map((id) => `${key('profile')} ${JSON.stringify({ id })}`))
  })

  it('reports bounded retention, lost writes and truncation without inferring a terminal state', async () => {
    mocks.history.mockResolvedValue(reply([event()], { writeFailed: true, truncated: true }))
    render(<PluginPlanningHistoryPanel items={items} />)
    load()
    await screen.findByText(key('writeFailed'))
    expect(screen.getByText(key('truncated'))).toBeInTheDocument()
    expect(screen.getByText(key('boundary'))).toBeInTheDocument()
    expect(screen.getByText(key('states.awaiting-approval'))).toBeInTheDocument()
    expect(screen.queryByText(key('states.completed'))).not.toBeInTheDocument()
  })

  it('shows only stable terminal error codes', async () => {
    mocks.history.mockResolvedValue(reply([event({ state: 'failed', errorCode: 'TIMEOUT' })]))
    render(<PluginPlanningHistoryPanel items={items} />)
    load()
    await screen.findByText(key('states.failed'))
    expect(screen.getByText(/figplugin.planningHistory.errorCode/)).toHaveTextContent('TIMEOUT')
  })

  it('renders hostile labels as plain text and clears prior history on a rejected read', async () => {
    mocks.history.mockResolvedValueOnce(
      reply([
        event({ pluginId: '<img src=x onerror=alert(1)>', modelName: '<svg onload=alert(1)>' })
      ])
    )
    mocks.history.mockRejectedValueOnce(new Error('PRIVATE C:/Users/token'))
    const view = render(<PluginPlanningHistoryPanel items={[]} />)
    load()
    await waitFor(() =>
      expect(screen.getByRole('article')).toHaveTextContent('<img src=x onerror=alert(1)>')
    )
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('svg[onload]')).toBeNull()
    load()
    await screen.findByText(key('error'))
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(view.container.textContent).not.toMatch(/PRIVATE|C:\/Users\/token/)
  })

  it('keeps EN/ZH keys, placeholders and historical dispatch semantics aligned', () => {
    const flatten = (value: object, prefix = ''): Record<string, string> =>
      Object.fromEntries(
        Object.entries(value).flatMap(([name, item]) =>
          typeof item === 'string'
            ? [[`${prefix}${name}`, item]]
            : Object.entries(flatten(item, `${prefix}${name}.`))
        )
      )
    const left = flatten(en.figplugin.planningHistory)
    const right = flatten(zh.figplugin.planningHistory)
    expect(Object.keys(left).sort()).toEqual(Object.keys(right).sort())
    for (const name of Object.keys(left))
      expect(right[name].match(/\{\{[^}]+\}\}/g)?.sort() ?? []).toEqual(
        left[name].match(/\{\{[^}]+\}\}/g)?.sort() ?? []
      )
    for (const state of ['awaiting-approval', 'running', 'provider-dispatched'] as const) {
      expect(en.figplugin.planningHistory.states[state]).toContain('at record time')
      expect(zh.figplugin.planningHistory.states[state]).toContain('记录时')
    }
    expect(en.figplugin.planningHistory.states.running).toContain('local planning pipeline')
    expect(en.figplugin.planningHistory.dispatchBoundary).toContain('not proof of network delivery')
    expect(zh.figplugin.planningHistory.dispatchBoundary).toContain('不证明网络已送达')
    expect(en.figplugin.planningHistory.boundary).toContain('7 days')
    expect(zh.figplugin.planningHistory.boundary).toContain('7 天')
    for (const locale of [en, zh]) {
      expect(locale.figplugin.planningHistory.call).not.toContain('32')
      expect(locale.figplugin.planningHistory.correlation).not.toContain('32')
      expect(locale.figplugin.planningHistory.hexIdHelp).toContain('32')
    }
  })
})
