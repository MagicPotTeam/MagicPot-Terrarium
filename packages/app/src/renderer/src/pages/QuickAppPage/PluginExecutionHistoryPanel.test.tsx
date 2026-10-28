import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import {
  FIGPLUGIN_AUDIT_TTL_MS,
  type FigPluginExecutionAuditEvent,
  type FigPluginExecutionHistory
} from '@shared/figplugin/executionAudit'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import PluginExecutionHistoryPanel from './PluginExecutionHistoryPanel'

const mocks = vi.hoisted(() => ({ history: vi.fn<FigPluginCenterSvc['executionHistory']>() }))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcFigPluginCenter: { executionHistory: mocks.history } })
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key + (values ? ` ${JSON.stringify(values)}` : '')
  })
}))
const event = (
  overrides: Partial<FigPluginExecutionAuditEvent> = {}
): FigPluginExecutionAuditEvent => ({
  schemaVersion: 1,
  at: 1000,
  executionId: '1'.repeat(32),
  callId: '2'.repeat(32),
  requestId: 'owned_request',
  pluginId: 'owned.figma',
  host: 'figma',
  projectId: 'project_1',
  state: 'completed',
  completed: 1,
  total: 1,
  effect: 'applied',
  risk: 'low',
  planSha256: 'a'.repeat(64),
  previewSha256: 'b'.repeat(64),
  adapterVersion: 'figma-native-1',
  rollback: 'verified-in-place',
  visualAudit: 'unavailable',
  durationMs: 12,
  ...overrides
})
const reply = (
  records: FigPluginExecutionAuditEvent[] = [],
  overrides: Partial<FigPluginExecutionHistory> = {}
): FigPluginExecutionHistory => ({
  records,
  truncated: false,
  recordedAt: 1000,
  retentionMs: FIGPLUGIN_AUDIT_TTL_MS,
  maxRecords: 256,
  maxBytes: 1048576,
  writeFailed: false,
  ...overrides
})
const items = [{ pluginId: 'owned.figma', name: 'Owned' }] as FigPluginManagedSummary[]
const load = () => fireEvent.click(screen.getByRole('button', { name: 'figplugin.history.load' }))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.history.mockResolvedValue(reply())
})
afterEach(cleanup)

describe('persisted history panel', () => {
  it('does no IPC on mount or StrictMode remount and has no execution/retry controls', () => {
    render(
      <StrictMode>
        <PluginExecutionHistoryPanel items={items} />
      </StrictMode>
    )
    expect(mocks.history).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByText('figplugin.history.boundary')).toBeInTheDocument()
    const plugin = screen.getByLabelText('figplugin.history.plugin') as HTMLSelectElement
    expect(plugin.labels?.[0]).toHaveAttribute('data-shrink', 'true')
  })

  it('loads persisted states and lineage only on explicit request', async () => {
    mocks.history.mockResolvedValue(
      reply([
        event({
          state: 'claimed',
          completed: 0,
          effect: 'none',
          correctionAttempt: {
            authorizationId: '3'.repeat(32),
            baselineId: '4'.repeat(32),
            sourceExecutionId: '5'.repeat(32),
            round: 2,
            maxCorrectionRounds: 3,
            targetCount: 1,
            consumed: true
          }
        })
      ])
    )
    render(<PluginExecutionHistoryPanel items={items} />)
    load()
    await screen.findByText(/figplugin.history.states.claimed/)
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith({ limit: 50 })
    expect(screen.getByText(/Source execution:/)).toHaveTextContent('5'.repeat(32))
    expect(screen.getByText(/figplugin.history.correction/)).toHaveTextContent('"round":2')
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('sends only the chosen IDs and count; ignores stale results after filter changes', async () => {
    let finish!: (value: FigPluginExecutionHistory) => void
    mocks.history.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    render(<PluginExecutionHistoryPanel items={items} />)
    load()
    fireEvent.change(screen.getByLabelText('figplugin.history.project'), {
      target: { value: 'project_2' }
    })
    await act(async () => finish(reply([event()])))
    expect(screen.queryByText(/owned_request/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('figplugin.history.plugin'), {
      target: { value: 'owned.figma' }
    })
    fireEvent.change(screen.getByLabelText('figplugin.history.limit'), { target: { value: '100' } })
    load()
    await screen.findByText('figplugin.history.empty')
    expect(mocks.history).toHaveBeenLastCalledWith({
      projectId: 'project_2',
      pluginId: 'owned.figma',
      limit: 100
    })
  })

  it('serializes rapid repeated clicks and safely ignores unmounted results', async () => {
    let finish!: (value: FigPluginExecutionHistory) => void
    mocks.history.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const view = render(<PluginExecutionHistoryPanel items={items} />)
    act(() => {
      load()
      load()
    })
    expect(mocks.history).toHaveBeenCalledTimes(1)
    view.unmount()
    await act(async () => finish(reply([event()])))
    expect(screen.queryByText(/owned_request/)).not.toBeInTheDocument()
  })

  it.each([
    () => ({ ...reply(), token: 'PRIVATE' }),
    () => reply([{ ...event(), plan: 'PRIVATE' } as FigPluginExecutionAuditEvent]),
    () => reply(Array.from({ length: 51 }, () => event())),
    () => reply([event({ errorCode: 'PRIVATE' as never })])
  ])('fails closed on corrupted, excessive or secret-bearing history', async (value) => {
    mocks.history.mockResolvedValue(value())
    render(<PluginExecutionHistoryPanel items={items} />)
    load()
    await screen.findByText('figplugin.history.error')
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('rejects a response from a different selected project', async () => {
    mocks.history.mockResolvedValue(reply([event()]))
    render(<PluginExecutionHistoryPanel items={items} />)
    fireEvent.change(screen.getByLabelText('figplugin.history.project'), {
      target: { value: 'other_project' }
    })
    load()
    await screen.findByText('figplugin.history.error')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('reports lost writes and truncated history without claiming a complete run', async () => {
    mocks.history.mockResolvedValue(reply([event()], { writeFailed: true, truncated: true }))
    render(<PluginExecutionHistoryPanel items={items} />)
    load()
    await screen.findByText('figplugin.history.writeFailed')
    expect(screen.getByText('figplugin.history.truncated')).toBeInTheDocument()
  })

  it('renders hostile labels as plain text and never shows raw failure messages', async () => {
    mocks.history.mockResolvedValueOnce(
      reply([event({ pluginId: '<img src=x onerror=alert(1)>' })])
    )
    mocks.history.mockRejectedValueOnce(new Error('PRIVATE C:/Users/token'))
    const view = render(<PluginExecutionHistoryPanel items={[]} />)
    load()
    await waitFor(() =>
      expect(screen.getByRole('article')).toHaveTextContent('<img src=x onerror=alert(1)>')
    )
    expect(view.container.querySelector('img')).toBeNull()
    load()
    await screen.findByText('figplugin.history.error')
    expect(view.container.textContent).not.toMatch(/PRIVATE|C:\/Users\/token/)
  })

  it('keeps EN/ZH keys and placeholders aligned', () => {
    const flatten = (value: object, prefix = ''): Record<string, string> =>
      Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) =>
          typeof item === 'string'
            ? [[`${prefix}${key}`, item]]
            : Object.entries(flatten(item, `${prefix}${key}.`))
        )
      )
    const left = flatten(en.figplugin.history)
    const right = flatten(zh.figplugin.history)
    expect(Object.keys(left).sort()).toEqual(Object.keys(right).sort())
    for (const key of Object.keys(left))
      expect(right[key].match(/\{\{[^}]+\}\}/g)?.sort() ?? []).toEqual(
        left[key].match(/\{\{[^}]+\}\}/g)?.sort() ?? []
      )
  })
})

it('shows task-recovery lineage in saved evidence without adding a replay action', async () => {
  mocks.history.mockResolvedValue(
    reply([
      event({
        taskRecovery: {
          baselineId: 'a'.repeat(32),
          sourceExecutionId: 'b'.repeat(32),
          round: 1,
          maxCorrectionRounds: 3,
          targetCount: 1,
          consumed: true
        }
      })
    ])
  )
  render(<PluginExecutionHistoryPanel items={items} />)
  load()
  await screen.findByText(/figplugin.bridge.taskRecoverySummary/)
  expect(screen.getAllByRole('button')).toHaveLength(1)
})
