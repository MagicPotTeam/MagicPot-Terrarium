import { StrictMode, Suspense, startTransition, useState, type Dispatch, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '@shared/api/svcLLMProxy'
import type { ChatSession } from '../chatStorage'
import { AgentTeamMemberImages } from './AgentTeamTree'

function member(attachments: ChatAttachment[]): ChatSession {
  return { id: 'member', title: 'Member', teamMemberName: 'Designer', messages: [{ role: 'assistant', content: '', attachments }] }
}

describe('member image action identity', () => {
  it('keeps the existing same-position URL reuse rules and exact callback slots', () => {
    const make = (i: number): ChatAttachment => ({ type: 'image', url: `data:image/png;base64,${String(i).repeat(4096)}`, fileName: `${i}.png` })
    const first = make(1), second = make(2), third = make(3)
    const place = vi.fn()
    const view = render(<StrictMode><AgentTeamMemberImages member={member([first, second, third])} placeImage={place} /></StrictMode>)
    const original = screen.getAllByRole('button')
    act(() => { original[0].focus() })
    view.rerender(<StrictMode><AgentTeamMemberImages member={member([structuredClone(first), structuredClone(second), structuredClone(third)])} placeImage={place} /></StrictMode>)
    expect(screen.getAllByRole('button')).toEqual(original)
    expect(original[0]).toHaveFocus()
    view.rerender(<StrictMode><AgentTeamMemberImages member={member([first, third, second])} placeImage={place} /></StrictMode>)
    const reordered = screen.getAllByRole('button')
    expect(reordered[0]).toBe(original[0])
    expect(reordered[1]).not.toBe(original[1])
    expect(reordered[2]).not.toBe(original[2])
    fireEvent.click(reordered[1])
    expect(place).toHaveBeenCalledExactlyOnceWith('member', { ...third, fileName: 'Designer·图2' }, undefined, undefined, JSON.stringify(['member', 0, 1]))
  })
  it('keeps duplicate occurrences distinct and matches old index:url identity through insertions and removals', () => {
    const a: ChatAttachment = { type: 'image', url: 'data:image/png;base64,AAA=', fileName: 'a.png' }
    const b: ChatAttachment = { type: 'image', url: 'data:image/png;base64,BBB=', fileName: 'b.png' }
    const place = vi.fn()
    const view = render(<StrictMode><AgentTeamMemberImages member={member([a, a, b])} placeImage={place} /></StrictMode>)
    const original = screen.getAllByRole('button')
    fireEvent.click(original[0]); fireEvent.click(original[1])
    expect(place.mock.calls).toEqual([
      ['member', { ...a, fileName: 'Designer·图1' }, undefined, undefined, JSON.stringify(['member', 0, 0])],
      ['member', { ...a, fileName: 'Designer·图2' }, undefined, undefined, JSON.stringify(['member', 0, 1])]
    ])
    view.rerender(<StrictMode><AgentTeamMemberImages member={member([a, b])} placeImage={place} /></StrictMode>)
    const removed = screen.getAllByRole('button')
    expect(removed[0]).toBe(original[0]); expect(removed[1]).not.toBe(original[1]); expect(removed[1]).not.toBe(original[2])
    view.rerender(<StrictMode><AgentTeamMemberImages member={member([a, a, b])} placeImage={place} /></StrictMode>)
    const inserted = screen.getAllByRole('button')
    expect(inserted[0]).toBe(original[0]); expect(inserted[1]).not.toBe(original[1]); expect(inserted[2]).not.toBe(original[2])
    fireEvent.click(inserted[2])
    expect(place.mock.calls[2]).toEqual(['member', { ...b, fileName: 'Designer·图3' }, undefined, undefined, JSON.stringify(['member', 0, 2])])
  })
  it('matches the old button identity after a suspended replacement is superseded', async () => {
    const a: ChatAttachment = { type: 'image', url: 'data:image/png;base64,AAA=' }
    const b: ChatAttachment = { type: 'image', url: 'data:image/png;base64,BBB=' }
    type Model = { source: ChatAttachment; blocked: boolean; revision: number }
    let update!: Dispatch<SetStateAction<Model>>
    let release!: () => void
    let released = false
    let reachedBlockedRender = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const place = vi.fn()
    const Old = ({ source }: { source: ChatAttachment }) => <button type="button" key={`0:${source.url}`}>old image</button>
    function Suspend({ blocked }: { blocked: boolean }) {
      if (blocked && !released) { reachedBlockedRender = true; throw gate }
      return null
    }
    function App() {
      const [model, setModel] = useState<Model>({ source: a, blocked: false, revision: 0 })
      update = setModel
      return <Suspense fallback={<span>pending replacement</span>}><div data-testid="revision" data-revision={model.revision}>
        <section data-testid="old"><Old source={model.source} /></section>
        <section data-testid="new"><AgentTeamMemberImages member={member([model.source])} placeImage={place} /></section>
        <Suspend blocked={model.blocked} />
      </div></Suspense>
    }
    const view = render(<StrictMode><App /></StrictMode>)
    try {
      const originalOld = screen.getByText('old image')
      const originalNew = screen.getByRole('button', { name: '投放 Designer·图1' })
      await act(async () => { startTransition(() => update({ source: b, blocked: true, revision: 1 })); await Promise.resolve() })
      expect(reachedBlockedRender).toBe(true)
      expect(screen.getByTestId('revision')).toHaveAttribute('data-revision', '0')
      expect(screen.getByText('old image')).toBe(originalOld)
      expect(screen.getByRole('button', { name: '投放 Designer·图1' })).toBe(originalNew)
      act(() => { flushSync(() => update({ source: { ...a }, blocked: false, revision: 2 })) })
      expect(screen.getByTestId('revision')).toHaveAttribute('data-revision', '2')
      expect(screen.getByText('old image')).toBe(originalOld)
      expect(screen.getByRole('button', { name: '投放 Designer·图1' })).toBe(originalNew)
      await act(async () => { released = true; release(); await gate })
      expect(screen.getByTestId('revision')).toHaveAttribute('data-revision', '2')
      expect(screen.getByText('old image')).toBe(originalOld)
      expect(screen.getByRole('button', { name: '投放 Designer·图1' })).toBe(originalNew)
      act(() => { flushSync(() => update({ source: b, blocked: false, revision: 3 })) })
      expect(screen.getByText('old image')).not.toBe(originalOld)
      const nextNew = screen.getByRole('button', { name: '投放 Designer·图1' })
      expect(nextNew).not.toBe(originalNew)
      fireEvent.click(nextNew)
      expect(place).toHaveBeenCalledExactlyOnceWith('member', { ...b, fileName: 'Designer·图1' }, undefined, undefined, JSON.stringify(['member', 0, 0]))
    } finally { released = true; release(); view.unmount() }
  })
  it('preserves string interpolation equivalence and detects a URL changed in place', () => {
    const raw = { type: 'image', url: undefined } as unknown as ChatAttachment
    const place = vi.fn()
    const view = render(<AgentTeamMemberImages member={member([raw])} placeImage={place} />)
    const before = screen.getByRole('button')
    raw.url = 'undefined'
    view.rerender(<AgentTeamMemberImages member={member([raw])} placeImage={place} />)
    expect(screen.getByRole('button')).toBe(before)
    raw.url = 'different'
    view.rerender(<AgentTeamMemberImages member={member([raw])} placeImage={place} />)
    expect(screen.getByRole('button')).not.toBe(before)
    fireEvent.click(screen.getByRole('button'))
    expect(place).toHaveBeenCalledExactlyOnceWith('member', { ...raw, fileName: 'Designer·图1' }, undefined, undefined, JSON.stringify(['member', 0, 0]))
  })
})
