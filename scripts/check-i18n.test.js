import { describe, expect, it } from 'vitest'
import { compareSourceHitsToBaseline, groupSourceHits } from './check-i18n.mjs'

describe('check-i18n source CJK baseline', () => {
  it('groups repeated literals by file, kind, and value', () => {
    expect(
      groupSourceHits([
        { file: 'packages/app/src/renderer/src/A.tsx', line: 3, kind: 'string', value: '中文' },
        { file: 'packages/app/src/renderer/src/A.tsx', line: 7, kind: 'string', value: '中文' },
        { file: 'packages/app/src/renderer/src/A.tsx', line: 9, kind: 'jsx-text', value: '中文' }
      ])
    ).toEqual([
      {
        file: 'packages/app/src/renderer/src/A.tsx',
        kind: 'jsx-text',
        value: '中文',
        count: 1,
        lines: [9]
      },
      {
        file: 'packages/app/src/renderer/src/A.tsx',
        kind: 'string',
        value: '中文',
        count: 2,
        lines: [3, 7]
      }
    ])
  })

  it('flags only occurrences that exceed the checked-in baseline', () => {
    const currentHits = [
      { file: 'packages/app/src/renderer/src/A.tsx', line: 3, kind: 'string', value: '旧中文' },
      { file: 'packages/app/src/renderer/src/A.tsx', line: 7, kind: 'string', value: '旧中文' },
      { file: 'packages/app/src/renderer/src/B.tsx', line: 11, kind: 'jsx-text', value: '新中文' }
    ]
    const baselineEntries = [
      {
        file: 'packages/app/src/renderer/src/A.tsx',
        kind: 'string',
        value: '旧中文',
        count: 1
      }
    ]

    expect(compareSourceHitsToBaseline(currentHits, baselineEntries)).toEqual([
      {
        file: 'packages/app/src/renderer/src/A.tsx',
        kind: 'string',
        value: '旧中文',
        count: 2,
        lines: [3, 7],
        baselineCount: 1
      },
      {
        file: 'packages/app/src/renderer/src/B.tsx',
        kind: 'jsx-text',
        value: '新中文',
        count: 1,
        lines: [11],
        baselineCount: 0
      }
    ])
  })
})
