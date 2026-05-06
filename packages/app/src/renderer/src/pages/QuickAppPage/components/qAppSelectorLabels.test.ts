import { describe, expect, it } from 'vitest'
import { buildQAppSelectorSearchText, getQAppSelectorScope } from './qAppSelectorLabels'

describe('qAppSelectorLabels', () => {
  it('derives the directory scope from the quick app key', () => {
    expect(getQAppSelectorScope({ key: 'Flux/文生图' } as never)).toBe('Flux')
    expect(getQAppSelectorScope({ key: '高清放大/柔和_SeedVR2' } as never)).toBe('高清放大')
  })

  it('ignores built-in quick apps that do not belong to user folders', () => {
    expect(getQAppSelectorScope({ key: '~builtin/hunyuan3d' } as never)).toBe('')
  })

  it('includes the scope in search text so duplicate names remain searchable by group', () => {
    const searchText = buildQAppSelectorSearchText({
      key: 'Qwen/文生图',
      name: '文生图'
    } as never)

    expect(searchText).toContain('文生图')
    expect(searchText).toContain('qwen/文生图')
    expect(searchText).toContain('qwen')
  })
})
