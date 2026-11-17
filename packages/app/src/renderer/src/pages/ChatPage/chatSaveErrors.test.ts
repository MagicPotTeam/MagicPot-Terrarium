import { describe, expect, it } from 'vitest'
import { SAVE_SUPERSEDE_STREAK_LIMIT, SaveSupersedeStreaks } from './chatSaveErrors'
import { normalizedSessionsEqual, type ChatSession } from './chatStorage'

describe('SaveSupersedeStreaks', () => {
  it('reports exhaustion only after consecutive supersedes of the same object', () => {
    const streaks = new SaveSupersedeStreaks()
    const first = { id: 'a' }
    for (let count = 1; count < SAVE_SUPERSEDE_STREAK_LIMIT; count++) expect(streaks.note(first)).toBe(false)
    expect(streaks.note(first)).toBe(true)
    expect(streaks.note(first)).toBe(true)
    // A replaced (newer) object starts its own streak.
    expect(streaks.note({ id: 'a' })).toBe(false)
    streaks.clear(first)
    expect(streaks.note(first)).toBe(false)
  })
})

describe('normalizedSessionsEqual with NaN values', () => {
  const session: ChatSession = { id: 'nan', title: 'NaN', profileId: 'p', createdAt: 1, messages: [{ role: 'user', content: 'x', ocrResult: { kind: 'text', text: 'x', boxes: [{ x: 0, y: 0, width: 1, height: 1, confidence: NaN }] } }] }
  it('treats a session holding NaN as equal to its own copy', () => {
    expect(normalizedSessionsEqual(session, structuredClone(session), 'default')).toBe(true)
  })
  it('still tells NaN apart from a number, and from a missing value', () => {
    const numbered = structuredClone(session)
    numbered.messages[0].ocrResult!.boxes![0].confidence = 0
    expect(normalizedSessionsEqual(session, numbered, 'default')).toBe(false)
    const missing = structuredClone(session)
    delete missing.messages[0].ocrResult!.boxes![0].confidence
    expect(normalizedSessionsEqual(session, missing, 'default')).toBe(false)
  })
})
