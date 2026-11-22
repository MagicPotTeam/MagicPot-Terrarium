import { describe, expect, it } from 'vitest'
import { acknowledgeSkillPreference, beginSkillPreference, pendingSkillPreference } from './skillPreferenceOperations'
const scope = (id: string) => JSON.stringify({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' }, conversationId: id })
describe('body-free session skill preference retry identities', () => {
  it('holds unknown identities across token changes and blocks silent replacement', () => {
    const first = beginSkillPreference(scope('helper'), 'one', false, 2)
    expect(beginSkillPreference(scope('helper'), 'one', false, 2)).toEqual(first)
    expect(pendingSkillPreference(JSON.stringify({ ...JSON.parse(scope('helper')), documentToken: 'new' }))).toEqual(first)
    expect(() => beginSkillPreference(scope('helper'), 'two', true, 3)).toThrow('Resolve')
    acknowledgeSkillPreference(scope('helper'), 'foreign')
    expect(pendingSkillPreference(scope('helper'))).toEqual(first)
    acknowledgeSkillPreference(scope('helper'), first.operationId)
    expect(pendingSkillPreference(scope('helper'))).toBeUndefined()
    const next = beginSkillPreference(scope('helper'), 'two', true, 3)
    expect(next.operationId).not.toBe(first.operationId)
    acknowledgeSkillPreference(scope('helper'), next.operationId)
  })
  it('releases acknowledged storage instead of counting completed operations for the renderer lifetime', () => {
    for (let revision = 0; revision < 600; revision++) {
      const attempt = beginSkillPreference(scope('completed-many'), 'one', false, revision)
      acknowledgeSkillPreference(scope('completed-many'), attempt.operationId)
    }
    expect(pendingSkillPreference(scope('completed-many'))).toBeUndefined()
    const sentinel = beginSkillPreference(scope('protected-unknown'), 'one', false, 0)
    const outstanding: Array<{ scope: string; operationId: string }> = [{ scope: scope('protected-unknown'), operationId: sentinel.operationId }]
    try {
      for (let index = 0; index < 511; index++) {
        const owned = scope(`capacity-${index}`), attempt = beginSkillPreference(owned, 'one', false, 0)
        outstanding.push({ scope: owned, operationId: attempt.operationId })
      }
      expect(() => beginSkillPreference(scope('capacity-overflow'), 'one', false, 0)).toThrow('capacity')
      acknowledgeSkillPreference(outstanding[1].scope, outstanding[1].operationId)
      const next = beginSkillPreference(scope('capacity-overflow'), 'one', false, 0)
      outstanding.push({ scope: scope('capacity-overflow'), operationId: next.operationId })
      expect(pendingSkillPreference(scope('protected-unknown'))).toEqual(sentinel)
    } finally { for (const attempt of outstanding) acknowledgeSkillPreference(attempt.scope, attempt.operationId) }
  })
})
