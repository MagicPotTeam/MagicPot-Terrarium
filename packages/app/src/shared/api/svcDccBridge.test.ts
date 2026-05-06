import { describe, expect, it } from 'vitest'
import {
  DCC_BRIDGE_EXPORT_ROOT_DIR,
  DCC_BRIDGE_MANIFEST_FILE_NAME,
  DCC_BRIDGE_TARGET_IMPORT_STUB_FILE_NAMES,
  DCC_BRIDGE_TARGET_RECIPE_FILE_NAMES,
  DCC_BRIDGE_VALIDATION_FILE_NAME,
  DCC_BRIDGE_SUPPORTED_MODEL_SOURCE_FORMATS,
  getDccBridgeExpectedPackageFileNames,
  getDccBridgeImportRecipeFileName,
  getDccBridgeImportStubFileName,
  getDccBridgeModelSourceFormat,
  getDccBridgeTargetLabel,
  isSupportedDccBridgeModelSourceFormat
} from './svcDccBridge'

describe('svcDccBridge helpers', () => {
  it('normalizes supported source formats', () => {
    expect(getDccBridgeModelSourceFormat('Hero Model.GLB')).toBe('.glb')
    expect(isSupportedDccBridgeModelSourceFormat('Hero Model.GLB')).toBe(true)
    expect(isSupportedDccBridgeModelSourceFormat('Hero Model.usdz')).toBe(false)
  })

  it('keeps the supported bridge source format list explicit', () => {
    expect(DCC_BRIDGE_SUPPORTED_MODEL_SOURCE_FORMATS).toEqual([
      '.glb',
      '.gltf',
      '.obj',
      '.fbx',
      '.dae',
      '.3ds',
      '.ply',
      '.stl'
    ])
  })

  it('keeps the DCC bridge artifact file names explicit', () => {
    expect(DCC_BRIDGE_EXPORT_ROOT_DIR).toBe('MagicPotImports')
    expect(DCC_BRIDGE_MANIFEST_FILE_NAME).toBe('bridge-manifest.json')
    expect(DCC_BRIDGE_VALIDATION_FILE_NAME).toBe('bridge-validation.json')
    expect(DCC_BRIDGE_TARGET_RECIPE_FILE_NAMES).toEqual({
      unity: 'unity-import-recipe.json',
      unreal: 'unreal-import-recipe.json'
    })
    expect(DCC_BRIDGE_TARGET_IMPORT_STUB_FILE_NAMES).toEqual({
      unity: 'unity-import-helper.cs',
      unreal: 'unreal-import-helper.py'
    })
    expect(getDccBridgeTargetLabel('unity')).toBe('Unity')
    expect(getDccBridgeTargetLabel('unreal')).toBe('Unreal')
  })

  it('derives the expected package file names for a sanitized model artifact', () => {
    expect(getDccBridgeExpectedPackageFileNames('Hero-Model.glb', 'unity')).toEqual([
      'Hero-Model.glb',
      'bridge-manifest.json',
      'bridge-validation.json',
      'unity-import-recipe.json',
      'unity-import-helper.cs'
    ])
    expect(getDccBridgeImportRecipeFileName('unreal')).toBe('unreal-import-recipe.json')
    expect(getDccBridgeImportStubFileName('unreal')).toBe('unreal-import-helper.py')
  })
})
