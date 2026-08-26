import { describe, expect, it } from 'vitest'
import { findTaskInBuckets } from './taskMemorySourceUtils'

describe('findTaskInBuckets', () => {
  it('returns the first matching task in bucket order', () => {
    const completed = { id: 'same', prompt_id: 'completed' }
    const pending = { id: 'same', prompt_id: 'pending' }
    const buckets = [
      ['completed', [completed]],
      ['pending', [pending]]
    ] as const

    expect(findTaskInBuckets(buckets, (task) => task.id === 'same')).toEqual([
      'completed',
      completed
    ])
  })

  it('returns a null tuple when no bucket matches', () => {
    const buckets: readonly (readonly [string, readonly { id: string }[]])[] = [
      ['pending', [{ id: 'pending' }]]
    ]

    expect(findTaskInBuckets(buckets, (task) => task.id === 'missing')).toEqual([null, null])
  })
})
