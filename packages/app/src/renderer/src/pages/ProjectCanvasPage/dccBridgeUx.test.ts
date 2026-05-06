import { describe, expect, it } from 'vitest'
import {
  getDccBridgeDialogTitle,
  getDccBridgeFailureNotice,
  getDccBridgeMenuCopy,
  getDccBridgeMenuTriggerTitle,
  getDccBridgeSuccessNotice
} from './dccBridgeUx'

describe('dccBridgeUx', () => {
  it('keeps the menu copy explicit about manual handoff bundles', () => {
    expect(getDccBridgeMenuTriggerTitle()).toBe('Export a manual Unity / Unreal handoff bundle')

    expect(getDccBridgeMenuCopy('unity')).toEqual({
      primary: 'Export to Unity',
      secondary: 'Generate a manual Unity handoff bundle in the configured bridge folder'
    })

    expect(getDccBridgeMenuCopy('unreal')).toEqual({
      primary: 'Export to Unreal',
      secondary: 'Generate a manual Unreal handoff bundle in the configured bridge folder'
    })
  })

  it('describes the directory picker and notices as manual handoff flows', () => {
    expect(getDccBridgeDialogTitle('unity')).toBe(
      'Choose a Unity Assets folder or a subfolder for the manual handoff bundle'
    )
    expect(getDccBridgeDialogTitle('unreal')).toBe(
      'Choose an Unreal watched source folder for the manual handoff bundle'
    )

    expect(getDccBridgeSuccessNotice('unity', '/tmp/magicpot')).toBe(
      'Unity manual handoff bundle generated: /tmp/magicpot\nMagicPot only writes the package artifacts. Unity import and execution remain manual.'
    )

    expect(
      getDccBridgeSuccessNotice('unreal', '/tmp/magicpot', {
        packageDir: '/tmp/magicpot',
        manifestPath: '/tmp/magicpot/bridge-manifest.json',
        validationPath: '/tmp/magicpot/bridge-validation.json',
        recipePath: '/tmp/magicpot/unreal-import-recipe.json',
        importStubPath: '/tmp/magicpot/unreal-import-helper.py'
      })
    ).toBe(
      'Unreal manual handoff bundle generated: /tmp/magicpot\nMagicPot only writes the package artifacts. Unreal import and execution remain manual.\nManifest: /tmp/magicpot/bridge-manifest.json\nValidation: /tmp/magicpot/bridge-validation.json\nRecipe: /tmp/magicpot/unreal-import-recipe.json\nImport stub: /tmp/magicpot/unreal-import-helper.py'
    )

    expect(getDccBridgeFailureNotice('unity', 'boom')).toBe(
      'Unity manual handoff bundle failed: boom. No Unity automation or native import was launched.'
    )
  })
})
