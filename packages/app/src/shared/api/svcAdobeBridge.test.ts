import { describe, expect, it } from 'vitest'
import {
  ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME,
  ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME,
  ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME,
  ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME,
  ADOBE_BRIDGE_MANIFEST_FILE_NAME,
  ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME,
  adobeBridgeSvcDef
} from './svcAdobeBridge'

describe('svcAdobeBridge helpers', () => {
  it('keeps the bridge package file names explicit', () => {
    expect(ADOBE_BRIDGE_MANIFEST_FILE_NAME).toBe('bridge-manifest.json')
    expect(ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME).toBe('handoff-instructions.md')
    expect(ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME).toBe('handoff-payload.json')
    expect(ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME).toBe('handoff-recipe.json')
    expect(ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME).toBe('after-effects-handoff.jsx')
    expect(ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME).toBe('premiere-handoff.jsx')
  })

  it('exposes a unary exportAsset service definition', () => {
    expect(adobeBridgeSvcDef.exportAsset.type).toBe('unary')
  })
})
