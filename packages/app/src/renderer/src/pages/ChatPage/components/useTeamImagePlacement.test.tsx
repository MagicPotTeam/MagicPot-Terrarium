import { StrictMode, useLayoutEffect } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import AgentTeamTree from './AgentTeamTree'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '../chatStorage'
import { useTeamImagePlacement } from './useTeamImagePlacement'

const dispatch = vi.hoisted(() => vi.fn())
vi.mock('../../ProjectCanvasPage/canvasTargetMediaDispatch', () => ({ dispatchCanvasTargetMediaAttachmentToCanvas: dispatch }))
const image = { type: 'image' as const, url: 'data:image/png;base64,AA==' }
const member = (attachments = [image]): ChatSession => ({ id: 'member', title: 'Fixture', createdAt: 1, messages: [{ role: 'assistant', content: '', attachments }] })

describe('team image placement', () => {
  beforeEach(() => { dispatch.mockReset(); dispatch.mockResolvedValue({ dispatched: true, placedCanvasItems: [] }) })
  it('baselines history, places new assistant images once, and shares manual deduplication', async () => {
    const { rerender, result } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [member()] } })
    expect(dispatch).not.toHaveBeenCalled()
    const next = { type: 'image' as const, url: 'data:image/png;base64,AQ==' }
    rerender({ members: [member([image, next, next])] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining(next), 'project', 'member', { teamImageLabel: '成员·图2' })
    await act(async () => { result.current.place('member', next) })
    rerender({ members: [member([image, next])] })
    expect(dispatch).toHaveBeenCalledTimes(1)
    act(() => result.current.place('member', image))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(dispatch).toHaveBeenLastCalledWith(image, 'project', 'member', { teamImageLabel: '成员·图1' })
  })
  it('rejects stale place callbacks after project switch and unmount without cancelling dispatched work', async () => {
    let finish!: (value: { dispatched: boolean; placedCanvasItems: never[] }) => void
    dispatch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { result, rerender, unmount } = renderHook(({ project }) => useTeamImagePlacement(project, [member()]), { initialProps: { project: 'first' } })
    const oldPlace = result.current.place
    act(() => oldPlace('member', image))
    expect(dispatch).toHaveBeenCalledTimes(1)
    rerender({ project: 'second' })
    act(() => oldPlace('member', { ...image, url: 'old-late' }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    await act(async () => finish({ dispatched: true, placedCanvasItems: [] }))
    act(() => result.current.place('member', image))
    expect(dispatch).toHaveBeenCalledTimes(2)
    const newPlace = result.current.place
    unmount()
    act(() => newPlace('member', { ...image, url: 'after-unmount' }))
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
  it('rebaselines same-project A to B to A and invalidates old placement and registration callbacks', async () => {
    const b = { ...member([{ ...image, url: 'b-history' }]), id: 'b' }
    const { result, rerender } = renderHook(({ key, members }) => useTeamImagePlacement('project', members, key), { initialProps: { key: 'a', members: [member()] } })
    const firstPlace = result.current.place, firstRegister = result.current.registerEmptyMember
    rerender({ key: 'b', members: [b] })
    act(() => { firstPlace('member', image); firstRegister('b-new') })
    expect(dispatch).not.toHaveBeenCalled()
    const bPlace = result.current.place
    rerender({ key: 'a', members: [member()] })
    act(() => { firstPlace('member', image); bPlace('b', b.messages[0].attachments![0]) })
    expect(dispatch).not.toHaveBeenCalled()
    const next = { ...image, url: 'a-new' }
    rerender({ key: 'a', members: [member([image, next])] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining(next), 'project', 'member', { teamImageLabel: '成员·图2' })
  })
  it('invalidates place during layout cleanup before passive cleanup and works in StrictMode', () => {
    let latePlace!: ReturnType<typeof useTeamImagePlacement>['place']
    const Observer = () => {
      const { place } = useTeamImagePlacement('project', [member()])
      latePlace = place
      return null
    }
    const Probe = () => {
      useLayoutEffect(() => () => { latePlace('member', { ...image, url: 'layout-cleanup' }) }, [])
      return null
    }
    const view = render(<StrictMode><Observer /><Probe /></StrictMode>)
    // StrictMode cleanup exercises the same synchronous invalidation before passive cleanup.
    expect(dispatch).not.toHaveBeenCalled()
    act(() => latePlace('member', image))
    expect(dispatch).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('creates a bounded single-line name snapshot without changing the attachment filename', async () => {
    const named = { ...member([]), teamMemberName: `甲\n${'乙'.repeat(80)}` }
    const { rerender } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [named] } })
    rerender({ members: [{ ...named, messages: member([image]).messages }] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    const label = dispatch.mock.calls[0][3].teamImageLabel as string
    expect(label).toBe(`甲 ${'乙'.repeat(46)}·图1`)
    expect(label).not.toMatch(/[\r\n]/)
  })

  it('uses the clicked historical slot for the label while retaining URL deduplication', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const lead: ChatSession = { id: 'lead', title: 'Lead', createdAt: 1, messages: [] }
    const person = { ...member([image, image]), teamMemberName: '设计师' }
    const view = render(<AgentTeamTree projectId="project" activityHost={host} lead={lead} currentId="lead" members={[person]} running={new Set()} waiting={new Set()} onSelect={vi.fn()} onCreate={vi.fn()} onStop={vi.fn()} />)
    fireEvent.click(screen.getByText('投放 设计师·图2'))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining(image), 'project', 'member', { teamImageLabel: '设计师·图2' })
    await act(async () => {})
    fireEvent.click(screen.getByText('投放 设计师·图1'))
    expect(dispatch).toHaveBeenCalledTimes(1)
    view.unmount()
    host.remove()
  })

  it('does not redispatch a pending image when autosave rewrites its URL, but places a new image', async () => {
    let resolve!: (value: {dispatched:boolean;placedCanvasItems:never[]}) => void
    dispatch.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const { rerender, result } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [member([])] } })
    rerender({ members: [member([image])] })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const saved = { ...image, url: 'file:///fixture/saved.png' }
    rerender({ members: [member([saved])] })
    act(() => result.current.place('member', saved))
    expect(dispatch).toHaveBeenCalledTimes(1)
    await act(async () => resolve({ dispatched: true, placedCanvasItems: [] }))
    act(() => result.current.place('member', saved))
    expect(dispatch).toHaveBeenCalledTimes(1)
    const fresh = { ...image, url: 'data:image/png;base64,AQ==' }
    rerender({ members: [member([saved, fresh])] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
    expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining(fresh), 'project', 'member', { teamImageLabel: '成员·图2' })
  })
  it('does not auto-place a rewritten historical URL but permits an explicit placement', async () => {
    const { rerender, result } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [member()] } })
    const saved = { ...image, url: 'file:///fixture/history.png' }
    rerender({ members: [member([saved])] })
    expect(dispatch).not.toHaveBeenCalled()
    act(() => result.current.place('member', saved))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })
  it('places a genuinely new image replacing an existing slot and after index reuse', async () => {
    const { rerender } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [member()] } })
    const replacement = { ...image, url: 'data:image/png;base64,AQ==' }
    rerender({ members: [member([replacement])] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    rerender({ members: [{ ...member([]), messages: [] }] })
    const fresh = { ...image, url: 'data:image/png;base64,Ag==' }
    rerender({ members: [member([fresh])] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  })
  it('retries a failed automatic placement manually after an autosave URL rewrite', async () => {
    dispatch.mockResolvedValueOnce({ dispatched: false, placedCanvasItems: [] })
    const { rerender, result } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [member([])] } })
    rerender({ members: [member([image])] })
    await act(async () => {})
    const saved = { ...image, url: 'file:///fixture/saved.png' }
    rerender({ members: [member([saved])] })
    act(() => result.current.place('member', saved))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2))
  })
  it('documents that identical URLs at separate positions currently share one placement identity', async () => {
    const { rerender, result } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [member([])] } })
    rerender({ members: [member([image, image])] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    act(() => result.current.place('member', image))
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('treats newly loaded members as history before watching subsequent updates', async () => {
    const { rerender } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [] as ChatSession[] } })
    rerender({ members: [member()] })
    expect(dispatch).not.toHaveBeenCalled()
    const next = { type: 'image' as const, url: 'data:image/png;base64,Ag==' }
    rerender({ members: [member([image, next])] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })
  it('places a registered empty member’s first batched image once', async () => {
    const { rerender, result } = renderHook(({ members }) => useTeamImagePlacement('project', members), { initialProps: { members: [] as ChatSession[] } })
    act(() => result.current.registerEmptyMember('member'))
    rerender({ members: [member([image, image])] })
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await act(async () => { result.current.place('member', image) })
    rerender({ members: [member()] })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('rejects registration before the passive effect mounts', () => {
    const EarlyRegistration = ({ members }: { members: ChatSession[] }) => {
      const { registerEmptyMember } = useTeamImagePlacement('project', members)
      useLayoutEffect(() => { registerEmptyMember('member') }, [])
      return null
    }
    const view = render(<EarlyRegistration members={[]} />)
    view.rerender(<EarlyRegistration members={[member()]} />)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('passes the creation callback through the tree before the first member snapshot', async () => {
    const lead: ChatSession = { id: 'lead', title: 'Lead', createdAt: 1, messages: [] }
    const onCreate = vi.fn(async (_name: string, _role: string, committed: (id: string) => void) => { committed('member') })
    const props = { projectId: 'project', activityHost: null, lead, currentId: 'lead', running: new Set<string>(), waiting: new Set<string>(), onSelect: vi.fn(), onCreate, onStop: vi.fn() }
    const view = render(<AgentTeamTree {...props} members={[]} />)
    fireEvent.click(screen.getByRole('button', { name: '组建团队 / 添加成员' }))
    fireEvent.change(screen.getByLabelText('成员名'), { target: { value: 'creator' } })
    fireEvent.change(screen.getByLabelText('角色 / 当前任务'), { target: { value: 'design' } })
    fireEvent.click(screen.getByRole('button', { name: '确认创建成员' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
    view.rerender(<AgentTeamTree {...props} members={[member()]} />)
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
  })
  it('does not reuse registration after project switch or remount, including a late callback', () => {
    const { result, rerender, unmount } = renderHook(({ project, members }) => useTeamImagePlacement(project, members), { initialProps: { project: 'a', members: [] as ChatSession[] } })
    const oldRegister = result.current.registerEmptyMember
    act(() => oldRegister('member'))
    rerender({ project: 'b', members: [] })
    act(() => oldRegister('member'))
    rerender({ project: 'b', members: [member()] })
    expect(dispatch).not.toHaveBeenCalled()
    act(() => result.current.registerEmptyMember('other'))
    const lateRegister = result.current.registerEmptyMember
    unmount()
    act(() => lateRegister('member'))
    renderHook(() => useTeamImagePlacement('a', [member()]))
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('allows manual retry after failed placement and isolates projects', async () => {
    dispatch.mockResolvedValueOnce({ dispatched: false, placedCanvasItems: [] })
    const { result, rerender } = renderHook(({ project }) => useTeamImagePlacement(project, [member()]), { initialProps: { project: 'a' } })
    await act(async () => { result.current.place('member', image) })
    await act(async () => { result.current.place('member', image) })
    expect(dispatch).toHaveBeenCalledTimes(2)
    rerender({ project: 'b' })
    await act(async () => { result.current.place('member', image) })
    expect(dispatch).toHaveBeenLastCalledWith(image, 'b', 'member', { teamImageLabel: '成员·图1' })
  })
})
