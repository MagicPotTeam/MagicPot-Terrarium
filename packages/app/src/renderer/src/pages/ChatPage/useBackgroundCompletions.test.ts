import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useBackgroundCompletions } from './useBackgroundCompletions'

type Job = { id: string; done: boolean }
const renderTracker = (onFinish: (job: Job) => void) =>
  renderHook(
    ({ scope, items }: { scope: string | null; items: Job[] }) =>
      useBackgroundCompletions(
        scope,
        items,
        (job) => job.id,
        (job) => job.done,
        onFinish
      ),
    { initialProps: { scope: 'a' as string | null, items: [] as Job[] } }
  )

describe('useBackgroundCompletions', () => {
  it('announces a job once when it was seen running and then finished', () => {
    const onFinish = vi.fn()
    const view = renderTracker(onFinish)
    view.rerender({
      scope: 'a',
      items: [
        { id: '1', done: false },
        { id: 'old', done: true }
      ]
    })
    expect(onFinish).not.toHaveBeenCalled()
    // A list that is briefly empty does not lose the running job.
    view.rerender({ scope: 'a', items: [] })
    view.rerender({
      scope: 'a',
      items: [
        { id: '1', done: true },
        { id: 'old', done: true }
      ]
    })
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onFinish).toHaveBeenCalledWith({ id: '1', done: true })
    view.rerender({ scope: 'a', items: [{ id: '1', done: true }] })
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  it('forgets the jobs of a scope that was left', () => {
    const onFinish = vi.fn()
    const view = renderTracker(onFinish)
    view.rerender({ scope: 'a', items: [{ id: '1', done: false }] })
    view.rerender({ scope: 'b', items: [{ id: '1', done: true }] })
    view.rerender({ scope: null, items: [] })
    view.rerender({ scope: 'a', items: [{ id: '1', done: true }] })
    expect(onFinish).not.toHaveBeenCalled()
  })
})
