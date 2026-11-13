import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider, createTheme } from '@mui/material'
import SqlitePreviewPanel from './SqlitePreviewPanel'
import type { AgentLocalFilesSvc } from '@shared/api/svcAgentLocalFiles'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import zh from '@shared/locales/zh-CN/renderer.json'

describe('explicit SQLite preview UI', () => {
  it('switches languages without weakening consent, including a displayed cancellation', async () => {
    const i18n = createInstance()
    await i18n.use(initReactI18next).init({ lng: 'zh-CN', fallbackLng: 'en-US', resources: { 'zh-CN': { translation: zh }, 'en-US': { translation: {} } }, interpolation: { escapeValue: false } })
    const chooseSqlitePreview = vi.fn<AgentLocalFilesSvc['chooseSqlitePreview']>().mockResolvedValue(null)
    const service = { chooseSqlitePreview, cancel: vi.fn(async () => {}) } as unknown as AgentLocalFilesSvc
    const scope = { projectId: 'project-1', paneId: 'pane-1', sessionId: 'session-1' }
    render(<I18nextProvider i18n={i18n}><ThemeProvider theme={createTheme()}><SqlitePreviewPanel scope={scope} service={service} /></ThemeProvider></I18nextProvider>)
    expect(screen.getByText(/不会读取 WAL 或 journal 文件/)).toBeVisible()
    expect(screen.getByText(/不会将数据行发送给模型/)).toBeVisible()
    fireEvent.change(screen.getByLabelText('SQLite 表名'), { target: { value: 'fixture' } })
    fireEvent.change(screen.getByLabelText('SQLite 列名（以英文逗号分隔）'), { target: { value: 'id' } })
    const choose = screen.getByRole('button', { name: '选择 SQLite 文件并预览' })
    expect(choose).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: '我同意为此次预览创建包含敏感信息的临时快照' }))
    fireEvent.click(choose)
    await waitFor(() => expect(screen.getByText('已取消选择。')).toBeVisible())
    expect(chooseSqlitePreview).toHaveBeenCalledWith(expect.objectContaining({ scope, consentTemporarySnapshot: true, table: 'fixture', columns: ['id'], limit: 100 }))
    await act(async () => { await i18n.changeLanguage('en-US') })
    expect(screen.getByText('Selection cancelled.')).toBeVisible()
    expect(screen.getByText(/No WAL\/journal files are read/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Choose SQLite file and preview' })).toBeDisabled()
  })
  it('cancels the exact pending operation when the panel closes', () => {
    const chooseSqlitePreview = vi.fn<AgentLocalFilesSvc['chooseSqlitePreview']>(()=>new Promise<null>(()=>{})), cancel=vi.fn(async()=>{})
    const service={chooseSqlitePreview,cancel} as unknown as AgentLocalFilesSvc
    const scope={projectId:'project-1',paneId:'pane-1',sessionId:'session-1'}
    const {unmount}=render(<ThemeProvider theme={createTheme()}><SqlitePreviewPanel scope={scope} service={service}/></ThemeProvider>)
    fireEvent.change(screen.getByLabelText('SQLite table'),{target:{value:'fixture'}})
    fireEvent.change(screen.getByLabelText('SQLite columns (comma separated)'),{target:{value:'id'}})
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Choose SQLite file and preview'}))
    const request=chooseSqlitePreview.mock.calls[0][0]
    unmount()
    expect(cancel).toHaveBeenCalledWith({scope,requestId:request.requestId})
  })
  it.each([
    ['scope', 'resolve'], ['scope', 'reject'], ['service', 'resolve'], ['service', 'reject']
  ] as const)('isolates pending previews after a %s change when the old request %s', async (change, outcome) => {
    type Result = Awaited<ReturnType<AgentLocalFilesSvc['chooseSqlitePreview']>>
    let finishA!: (value: Result) => void, failA!: (error: Error) => void, finishB!: (value: Result) => void
    const chooseA = vi.fn<AgentLocalFilesSvc['chooseSqlitePreview']>(() => new Promise((resolve, reject) => { finishA = resolve; failA = reject }))
    const chooseB = change === 'scope' ? chooseA : vi.fn<AgentLocalFilesSvc['chooseSqlitePreview']>(() => new Promise(resolve => { finishB = resolve }))
    if (change === 'scope') chooseA.mockImplementationOnce(() => new Promise((resolve, reject) => { finishA = resolve; failA = reject })).mockImplementationOnce(() => new Promise(resolve => { finishB = resolve }))
    const cancelA = vi.fn(async () => {}), cancelB = vi.fn(async () => {})
    const serviceA = { chooseSqlitePreview: chooseA, cancel: cancelA } as unknown as AgentLocalFilesSvc
    const serviceB = change === 'scope' ? serviceA : { chooseSqlitePreview: chooseB, cancel: cancelB } as unknown as AgentLocalFilesSvc
    const scopeA = { projectId: 'project-a', paneId: 'pane-a', sessionId: 'session-a' }
    const scopeB = { projectId: 'project-b', paneId: 'pane-b', sessionId: 'session-b' }
    const panel = (scope: typeof scopeA, service: AgentLocalFilesSvc) => <ThemeProvider theme={createTheme()}><SqlitePreviewPanel scope={scope} service={service} /></ThemeProvider>
    const { rerender, unmount } = render(panel(scopeA, serviceA))
    fireEvent.change(screen.getByLabelText('SQLite table'), { target: { value: 'fixture' } })
    fireEvent.change(screen.getByLabelText('SQLite columns (comma separated)'), { target: { value: 'id' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    const requestA = chooseA.mock.calls[0][0]
    rerender(panel(change === 'scope' ? scopeB : scopeA, serviceB))
    expect(cancelA).toHaveBeenCalledWith({ scope: scopeA, requestId: requestA.requestId })
    await waitFor(() => expect(screen.getByLabelText('SQLite table')).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    expect(chooseB).toHaveBeenCalledTimes(change === 'scope' ? 2 : 1)
    const requestB = chooseB.mock.calls[change === 'scope' ? 1 : 0][0]
    await act(async () => {
      if (outcome === 'resolve') finishA({ rows: [{ id: 'old-fixture-row' }], truncated: false, source: 'supplied-standalone-snapshot', liveDatabaseConsistency: false, nativeWorkBounded: false })
      else failA(new Error('old failure'))
    })
    expect(screen.getByLabelText('SQLite table')).toBeDisabled()
    expect(screen.queryByText(/old-fixture-row/)).not.toBeInTheDocument()
    expect(screen.queryByText('Selection cancelled.')).not.toBeInTheDocument()
    expect(screen.queryByText('SQLite preview unavailable or failed. Please try again with fresh consent.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    expect(chooseB).toHaveBeenCalledTimes(change === 'scope' ? 2 : 1)
    unmount()
    expect(change === 'scope' ? cancelA : cancelB).toHaveBeenCalledWith({ scope: change === 'scope' ? scopeB : scopeA, requestId: requestB.requestId })
    finishB(null)
  })

  it('reports a generic failure after switching scope and permits a later explicitly consented retry', async () => {
    let rejectOld!: (reason: Error) => void
    const chooseSqlitePreview = vi.fn<AgentLocalFilesSvc['chooseSqlitePreview']>()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject }))
      .mockRejectedValueOnce(new Error('transport normalized error'))
      .mockResolvedValueOnce({ rows: [{ id: 'fixture-row' }], truncated: false, source: 'supplied-standalone-snapshot', liveDatabaseConsistency: false, nativeWorkBounded: false })
    const cancel = vi.fn(async () => {})
    const service = { chooseSqlitePreview, cancel } as unknown as AgentLocalFilesSvc
    const scopeA = { projectId: 'project-a', paneId: 'pane-a', sessionId: 'session-a' }
    const scopeB = { projectId: 'project-b', paneId: 'pane-b', sessionId: 'session-b' }
    const panel = (scope: typeof scopeA) => <ThemeProvider theme={createTheme()}><SqlitePreviewPanel scope={scope} service={service} /></ThemeProvider>
    const { rerender } = render(panel(scopeA))
    fireEvent.change(screen.getByLabelText('SQLite table'), { target: { value: 'fixture' } })
    fireEvent.change(screen.getByLabelText('SQLite columns (comma separated)'), { target: { value: 'id' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    const requestA = chooseSqlitePreview.mock.calls[0][0]
    rerender(panel(scopeB))
    expect(cancel).toHaveBeenCalledWith({ scope: scopeA, requestId: requestA.requestId })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    await waitFor(() => expect(screen.getByText('SQLite preview unavailable or failed. Please try again with fresh consent.')).toBeVisible())
    await waitFor(() => expect(screen.getByLabelText('SQLite table')).toBeEnabled())
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Choose SQLite file and preview' })).toBeDisabled()
    await act(async () => rejectOld(new Error('cancelled')))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    await waitFor(() => expect(screen.getByText(/fixture-row/)).toBeVisible())
    expect(chooseSqlitePreview).toHaveBeenCalledTimes(3)
    expect(chooseSqlitePreview.mock.calls[2][0]).toMatchObject({ scope: scopeB, consentTemporarySnapshot: true })
  })

  it('recovers from a synchronous service throw and requires fresh consent before retry', async () => {
    const chooseSqlitePreview = vi.fn<AgentLocalFilesSvc['chooseSqlitePreview']>()
      .mockImplementationOnce(() => { throw new Error('disconnected') })
      .mockResolvedValueOnce(null)
    const service = { chooseSqlitePreview, cancel: vi.fn(async () => {}) } as unknown as AgentLocalFilesSvc
    render(<ThemeProvider theme={createTheme()}><SqlitePreviewPanel scope={{ projectId: 'project-1', paneId: 'pane-1', sessionId: 'session-1' }} service={service} /></ThemeProvider>)
    fireEvent.change(screen.getByLabelText('SQLite table'), { target: { value: 'fixture' } })
    fireEvent.change(screen.getByLabelText('SQLite columns (comma separated)'), { target: { value: 'id' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    await waitFor(() => expect(screen.getByLabelText('SQLite table')).toBeEnabled())
    expect(screen.getByText('SQLite preview unavailable or failed. Please try again with fresh consent.')).toBeVisible()
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'Choose SQLite file and preview' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    await waitFor(() => expect(screen.getByText('Selection cancelled.')).toBeVisible())
    expect(chooseSqlitePreview).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'reject'] as const)('ignores a pending request that %s after unmount', async outcome => {
    type Result = Awaited<ReturnType<AgentLocalFilesSvc['chooseSqlitePreview']>>
    let finish!: (value: Result) => void, fail!: (error: Error) => void
    const chooseSqlitePreview = vi.fn<AgentLocalFilesSvc['chooseSqlitePreview']>(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    const cancel = vi.fn(async () => {})
    const scope = { projectId: 'project-1', paneId: 'pane-1', sessionId: 'session-1' }
    const service = { chooseSqlitePreview, cancel } as unknown as AgentLocalFilesSvc
    const { unmount } = render(<ThemeProvider theme={createTheme()}><SqlitePreviewPanel scope={scope} service={service} /></ThemeProvider>)
    fireEvent.change(screen.getByLabelText('SQLite table'), { target: { value: 'fixture' } })
    fireEvent.change(screen.getByLabelText('SQLite columns (comma separated)'), { target: { value: 'id' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    const request = chooseSqlitePreview.mock.calls[0][0]
    unmount()
    expect(cancel).toHaveBeenCalledWith({ scope, requestId: request.requestId })
    await act(async () => { if (outcome === 'resolve') finish(null); else fail(new Error('late failure')) })
    expect(screen.queryByText('Selection cancelled.')).not.toBeInTheDocument()
    expect(screen.queryByText('SQLite preview unavailable or failed. Please try again with fresh consent.')).not.toBeInTheDocument()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not call service before consent and chooser click; does not expose file path/model attach', async () => {
    let finish!: (value: null) => void
    const chooseSqlitePreview = vi.fn<AgentLocalFilesSvc['chooseSqlitePreview']>(() => new Promise<null>(resolve => { finish = resolve }))
    const service = { chooseSqlitePreview } as unknown as AgentLocalFilesSvc
    render(<ThemeProvider theme={createTheme()}><SqlitePreviewPanel scope={{ projectId: 'project-1', paneId: 'pane-1', sessionId: 'session-1' }} service={service} /></ThemeProvider>)
    expect(chooseSqlitePreview).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('SQLite table'), { target: { value: 'fixture' } })
    fireEvent.change(screen.getByLabelText('SQLite columns (comma separated)'), { target: { value: 'id, label' } })
    expect(screen.getByRole('button', { name: 'Choose SQLite file and preview' })).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose SQLite file and preview' }))
    expect(screen.getByLabelText('SQLite table')).toBeDisabled()
    expect(screen.getByLabelText('SQLite columns (comma separated)')).toBeDisabled()
    expect(screen.getByRole('checkbox')).toBeDisabled()
    finish(null)
    await waitFor(() => expect(screen.getByText('Selection cancelled.')).toBeVisible())
    expect(chooseSqlitePreview).toHaveBeenCalledOnce()
    expect(chooseSqlitePreview.mock.calls[0][0]).toMatchObject({ table: 'fixture', columns: ['id', 'label'], consentTemporarySnapshot: true })
    expect(chooseSqlitePreview.mock.calls[0][0]).not.toHaveProperty('path')
  })
})
