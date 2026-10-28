import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SavedTaskCheckpoints from './SavedTaskCheckpoints'
import type { SavedTaskCheckpoint } from '@shared/figplugin/taskRecovery'
const mocks = vi.hoisted(() => ({ list: vi.fn<() => Promise<SavedTaskCheckpoint[]>>() }))
vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcFigPluginCenter: { listSavedCheckpoints: mocks.list } })
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const row = (): SavedTaskCheckpoint => ({
  baselineId: 'a'.repeat(32),
  pluginId: 'owned.figma',
  projectId: 'owned-project',
  host: 'figma',
  documentId: 'doc',
  scopeId: 'page',
  targetIds: ['node'],
  acceptedAt: Date.now() - 1000,
  expiresAt: Date.now() + 60000,
  correctionRoundsUsed: 2,
  maxCorrectionRounds: 3
})
const load = () =>
  fireEvent.click(screen.getByRole('button', { name: 'figplugin.checkpoints.load' }))
describe('saved checkpoint lookup', () => {
  it('does not read on mount or StrictMode remount and offers no execute button', () => {
    render(
      <StrictMode>
        <SavedTaskCheckpoints />
      </StrictMode>
    )
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it('reads explicitly, exposes selectable full IDs and never grants a write', async () => {
    mocks.list.mockResolvedValue([row()])
    render(<SavedTaskCheckpoints />)
    load()
    await waitFor(() =>
      expect(screen.getByLabelText('figplugin.checkpoints.code')).toHaveValue('a'.repeat(32))
    )
    expect(screen.getByLabelText('figplugin.checkpoints.code')).toHaveAttribute('readonly')
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({})
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
  it('suppresses duplicate reads while pending', async () => {
    let resolve!: (x: SavedTaskCheckpoint[]) => void
    mocks.list.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    render(<SavedTaskCheckpoints />)
    load()
    load()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    await act(async () => resolve([]))
    expect(screen.getByRole('status')).toHaveTextContent('figplugin.checkpoints.empty')
  })
  it('does not reuse failed or expired results', async () => {
    mocks.list.mockResolvedValue([{ ...row(), acceptedAt: 1, expiresAt: 2 }])
    render(<SavedTaskCheckpoints />)
    load()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('figplugin.checkpoints.empty')
    )
    mocks.list.mockRejectedValue(new Error('PRIVATE'))
    load()
    await waitFor(() =>
      expect(screen.getByText('figplugin.checkpoints.failed')).toBeInTheDocument()
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('PRIVATE')
  })
  it('ignores a late response after unmount', async () => {
    let resolve!: (x: SavedTaskCheckpoint[]) => void
    mocks.list.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const view = render(<SavedTaskCheckpoints />)
    load()
    view.unmount()
    await act(async () => resolve([row()]))
    expect(screen.queryByLabelText('figplugin.checkpoints.code')).not.toBeInTheDocument()
  })
  it('rejects unknown response fields rather than rendering saved design values', async () => {
    mocks.list.mockResolvedValue([{ ...row(), plan: 'PRIVATE' } as SavedTaskCheckpoint])
    render(<SavedTaskCheckpoints />)
    load()
    await waitFor(() =>
      expect(screen.getByText('figplugin.checkpoints.failed')).toBeInTheDocument()
    )
    expect(document.body).not.toHaveTextContent('PRIVATE')
  })
})
