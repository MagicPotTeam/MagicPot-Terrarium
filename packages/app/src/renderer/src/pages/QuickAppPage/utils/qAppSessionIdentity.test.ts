import { describe, expect, it } from 'vitest'

import { getQAppSessionKey, resolveQAppSessionKey } from './qAppSessionIdentity'

describe('qAppSessionIdentity', () => {
  it('builds a deterministic session key from project and qapp identity', () => {
    expect(getQAppSessionKey({ projectId: 'project-1', qAppKey: 'demo.app' })).toBe(
      'quickapp:thread:project-1:thread:demo.app'
    )
    expect(getQAppSessionKey({ qAppKey: 'demo.app' })).toBe('quickapp:topic:demo.app')
  })

  it('prefers the generation session id over derived quickapp scope', () => {
    expect(
      resolveQAppSessionKey({
        projectId: 'project-1',
        qAppKey: 'demo.app',
        submitSessionKey: ' quickapp:topic:demo.app ',
        generationSessionId: ' canvas:thread:project-1:thread:agent-1 '
      })
    ).toBe('canvas:thread:project-1:thread:agent-1')
  })
})
