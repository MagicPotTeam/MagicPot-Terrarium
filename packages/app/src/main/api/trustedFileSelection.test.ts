import { describe, expect, it } from 'vitest'
import {
  clearTrustedLocalFileSelectionsForTest,
  consumeTrustedLocalFileSelection,
  rememberTrustedLocalFileSelections
} from './trustedFileSelection'

describe('trustedFileSelection', () => {
  it('allows a remembered local file path once', () => {
    clearTrustedLocalFileSelectionsForTest()
    rememberTrustedLocalFileSelections([' C:/models/model.glb '], 1000)

    expect(consumeTrustedLocalFileSelection('C:/models/model.glb', 1000)).toBe(
      'C:/models/model.glb'
    )
    expect(() => consumeTrustedLocalFileSelection('C:/models/model.glb', 1000)).toThrow(
      'trusted dialog'
    )
  })

  it('expires remembered paths', () => {
    clearTrustedLocalFileSelectionsForTest()
    rememberTrustedLocalFileSelections(['C:/models/model.glb'], 1000)

    expect(() =>
      consumeTrustedLocalFileSelection('C:/models/model.glb', 1000 + 2 * 60 * 1000 + 1)
    ).toThrow('trusted dialog')
  })
})
