import { afterEach, describe, expect, it } from 'vitest'
import {
  activateQuickAppImagePasteTarget,
  deactivateQuickAppImagePasteTarget,
  hasActiveQuickAppImagePasteTarget,
  resetQuickAppImagePasteTargetsForTest
} from './quickAppPasteTarget'

describe('quickAppPasteTarget', () => {
  afterEach(() => {
    resetQuickAppImagePasteTargetsForTest()
  })

  it('tracks active quick-app image paste targets', () => {
    const first = Symbol('first')
    const second = Symbol('second')

    expect(hasActiveQuickAppImagePasteTarget()).toBe(false)

    activateQuickAppImagePasteTarget(first)
    expect(hasActiveQuickAppImagePasteTarget()).toBe(true)

    activateQuickAppImagePasteTarget(second)
    deactivateQuickAppImagePasteTarget(first)
    expect(hasActiveQuickAppImagePasteTarget()).toBe(true)

    deactivateQuickAppImagePasteTarget(second)
    expect(hasActiveQuickAppImagePasteTarget()).toBe(false)
  })
})
