import { describe, expect, it } from 'vitest'
import { getCustomSkillsNeedingAttention, summarizeCustomSkills } from './qAppWorkshopUtils'

describe('summarizeCustomSkills', () => {
  it('counts categories, ready skills, and agent skills', () => {
    const summary = summarizeCustomSkills([
      {
        id: 'skill-1',
        category: 'Image',
        skillName: 'Polish',
        prompt: 'Refine the image',
        type: 'normal',
        apiKey: '',
        apiAddress: ''
      },
      {
        id: 'skill-2',
        category: 'Image',
        skillName: 'Upscale',
        prompt: 'Improve the image',
        type: 'agent',
        apiKey: 'abc',
        apiAddress: 'https://example.com/api'
      },
      {
        id: 'skill-3',
        category: 'Video',
        skillName: '',
        prompt: '',
        type: 'agent',
        apiKey: '',
        apiAddress: ''
      }
    ])

    expect(summary.totalCount).toBe(3)
    expect(summary.categoryCount).toBe(2)
    expect(summary.agentCount).toBe(2)
    expect(summary.readyCount).toBe(2)
    expect(summary.needsAttentionCount).toBe(1)
    expect(summary.topCategories).toEqual(['Image', 'Video'])
  })

  it('returns an empty summary for no skills', () => {
    expect(summarizeCustomSkills([])).toEqual({
      totalCount: 0,
      categoryCount: 0,
      agentCount: 0,
      readyCount: 0,
      needsAttentionCount: 0,
      topCategories: []
    })
  })

  it('returns only incomplete skills for the attention queue', () => {
    const queue = getCustomSkillsNeedingAttention([
      {
        id: 'skill-ready',
        category: 'Image',
        skillName: 'Polish',
        prompt: 'Refine the image',
        type: 'normal',
        apiKey: '',
        apiAddress: ''
      },
      {
        id: 'skill-missing-prompt',
        category: 'Video',
        skillName: 'Storyboard',
        prompt: '',
        type: 'agent',
        apiKey: 'abc',
        apiAddress: 'https://example.com/api'
      },
      {
        id: 'skill-missing-api',
        category: 'Ops',
        skillName: 'Router',
        prompt: 'Route the request',
        type: 'agent',
        apiKey: '',
        apiAddress: ''
      }
    ])

    expect(queue.map((item) => item.skill.id)).toEqual([
      'skill-missing-prompt',
      'skill-missing-api'
    ])
    expect(queue[0].issues).toContain('Prompt is required.')
    expect(queue[1].issues).toContain('Agent type requires an API address.')
  })
})
