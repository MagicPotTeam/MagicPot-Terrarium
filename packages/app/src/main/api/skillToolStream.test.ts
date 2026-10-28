import { describe, expect, it, vi } from 'vitest'
import { createSkillToolStream } from './skillToolStream'

describe('skill tool stream framing', () => {
  it('forwards real prose immediately, without waiting for completion', () => {
    const emit = vi.fn()
    const stream = createSkillToolStream(emit)
    stream.onDelta({ type: 'text-delta', delta: 'Working on it' })
    expect(emit).toHaveBeenCalledWith({ type: 'text-delta', delta: 'Working on it' })
    stream.finish(false)
    expect(emit).toHaveBeenCalledTimes(1)
  })
  it('keeps split tool JSON private while allowing the separate session event', () => {
    const emit = vi.fn()
    const stream = createSkillToolStream(emit)
    for (const delta of ['  {', '"args":', '{"path":"owned"},', '"toolName":"read"}']) {
      stream.onDelta({ type: 'text-delta', delta })
      expect(emit).not.toHaveBeenCalled()
    }
    stream.onDelta({ type: 'session', sessionUrl: 'owned-session' })
    stream.onDelta({ type: 'done' })
    stream.finish(true)
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(['session'])
  })
  it('streams ordinary JSON once its first key rules out a tool invocation', () => {
    const emit = vi.fn()
    const stream = createSkillToolStream(emit)
    stream.onDelta({ type: 'text-delta', delta: '{"answer":' })
    expect(emit).toHaveBeenCalledOnce()
    stream.onDelta({ type: 'text-delta', delta: '42}' })
    stream.finish(false)
    expect(emit).toHaveBeenCalledTimes(2)
  })
  it('does not forward inner completion or post-terminal deltas', () => {
    const emit = vi.fn()
    const stream = createSkillToolStream(emit)
    stream.onDelta({ type: 'done' })
    stream.finish(false)
    stream.onDelta({ type: 'text-delta', delta: 'late' })
    expect(emit).not.toHaveBeenCalled()
  })
  it('rejects unbounded ambiguous invocation data without leaking it', () => {
    const emit = vi.fn()
    const stream = createSkillToolStream(emit)
    expect(() =>
      stream.onDelta({ type: 'text-delta', delta: '{"args":"' + 'x'.repeat(600_000) })
    ).toThrow(/bounded/)
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('tool-shaped Markdown streaming', () => {
  it('holds a split fenced invocation and its premature apology until dispatch', () => {
    const emit = vi.fn()
    const stream = createSkillToolStream(emit)
    const content =
      '```json\n{"toolName":"files.read","args":{"path":"D:/owned/test.docx"}}\n``` 抱歉无法读取'
    for (const delta of content) {
      stream.onDelta({ type: 'text-delta', delta })
      expect(emit).not.toHaveBeenCalled()
    }
    stream.finish(true)
    expect(emit).not.toHaveBeenCalled()
  })
  it('continues streaming normal code fences rather than buffering all Markdown', () => {
    const emit = vi.fn()
    const stream = createSkillToolStream(emit)
    stream.onDelta({ type: 'text-delta', delta: '```python\nprint(1)' })
    expect(emit).toHaveBeenCalledOnce()
    stream.finish(false)
    expect(emit).toHaveBeenCalledOnce()
  })
})
