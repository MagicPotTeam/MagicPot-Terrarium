import { beforeEach, describe, expect, it } from 'vitest'

import {
  listProjectStyleModels,
  removeProjectStyleModel,
  upsertProjectStyleModel
} from './projectStyleModelRegistry'

describe('projectStyleModelRegistry', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('stores and lists project-scoped style models', () => {
    const result = upsertProjectStyleModel('canvas-a', {
      label: '项目 A 主视觉 LoRA',
      description: '偏赛博霓虹'
    })

    expect(result.added?.label).toBe('项目 A 主视觉 LoRA')
    expect(listProjectStyleModels('canvas-a')).toEqual([
      expect.objectContaining({
        label: '项目 A 主视觉 LoRA',
        description: '偏赛博霓虹'
      })
    ])
    expect(listProjectStyleModels('canvas-b')).toEqual([])
  })

  it('deduplicates by label and updates the existing model', () => {
    upsertProjectStyleModel('canvas-a', {
      label: '项目 A 主视觉 LoRA',
      description: '第一版'
    })
    const updated = upsertProjectStyleModel('canvas-a', {
      label: '项目 A 主视觉 LoRA',
      description: '第二版'
    })

    expect(updated.models).toHaveLength(1)
    expect(updated.models[0]).toEqual(
      expect.objectContaining({
        label: '项目 A 主视觉 LoRA',
        description: '第二版'
      })
    )
  })

  it('removes a model by id', () => {
    const created = upsertProjectStyleModel('canvas-a', {
      label: '项目 A 主视觉 LoRA'
    }).added

    expect(created).not.toBeNull()
    const next = removeProjectStyleModel('canvas-a', created!.id)

    expect(next).toEqual([])
    expect(listProjectStyleModels('canvas-a')).toEqual([])
  })
})
