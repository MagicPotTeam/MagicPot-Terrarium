import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DccBridgeSvcImpl } from './svcDccBridgeImpl'
import {
  DCC_BRIDGE_EXPORT_ROOT_DIR,
  DCC_BRIDGE_MANIFEST_FILE_NAME,
  getDccBridgeImportStubFileName,
  DCC_BRIDGE_VALIDATION_FILE_NAME,
  getDccBridgeExpectedPackageFileNames,
  getDccBridgeImportRecipeFileName,
  getDccBridgeTargetLabel
} from '@shared/api/svcDccBridge'
import { Config, DEFAULT_CONFIG } from '@shared/config/config'
import * as config from '../config/config'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

vi.mock(import('../config/config'), () => {
  return {
    getConfig: vi.fn()
  }
})

function mockConfig(v: Partial<Config>): void {
  vi.mocked(config.getConfig).mockReturnValue({
    ...DEFAULT_CONFIG,
    ...v,
    dcc_bridge_config: {
      ...DEFAULT_CONFIG.dcc_bridge_config,
      ...(v.dcc_bridge_config || {})
    }
  } as Config)
}

describe('DccBridgeSvcImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-23T04:05:06.789Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('writes a manifest and model package with verifiable paths', async () => {
    const targetDir = path.join(await createNodeTestArtifactDir('dcc-bridge-unity'), 'unity')
    await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    await fs.mkdir(targetDir, { recursive: true })
    try {
      mockConfig({
        dcc_bridge_config: {
          unity_export_dir: targetDir,
          unreal_export_dir: targetDir
        }
      })

      const svc = new DccBridgeSvcImpl()
      const resp = await svc.exportModel({
        target: 'unity',
        fileName: 'Hero Model.glb',
        data: new Uint8Array([1, 2, 3, 4]),
        sourceLabel: 'session-42',
        sourceContextSummary: {
          kindLabels: ['Imported file 1'],
          detailLines: ['Hero Model.glb -> Imported file / hero-model.glb'],
          totalItemCount: 1,
          hiddenDetailCount: 0
        },
        taskContext: {
          sessionId: 'design-session-42',
          contextPackId: 'design-context-42',
          proposalId: 'design-proposal-42',
          approvalId: 'design-approval-42',
          approvalStatus: 'approved',
          executionResultId: 'design-execution-42'
        }
      })

      expect(path.basename(resp.packageDir)).toBe('Hero-Model-20260323040506')
      expect(path.basename(resp.modelPath)).toBe('Hero-Model.glb')
      expect(path.basename(resp.manifestPath)).toBe(DCC_BRIDGE_MANIFEST_FILE_NAME)
      expect(path.basename(resp.validationPath)).toBe(DCC_BRIDGE_VALIDATION_FILE_NAME)
      expect(path.basename(resp.recipePath)).toBe(getDccBridgeImportRecipeFileName('unity'))
      expect(path.basename(resp.importStubPath)).toBe(getDccBridgeImportStubFileName('unity'))
      expect(resp.manifestSha256).toHaveLength(64)
      expect(resp.validationSha256).toHaveLength(64)
      expect(resp.recipeSha256).toHaveLength(64)
      expect(resp.importStubSha256).toHaveLength(64)
      expect(resp.artifactSizeBytes).toBe(4)
      expect(resp.artifactSha256).toBe(
        createHash('sha256')
          .update(Buffer.from([1, 2, 3, 4]))
          .digest('hex')
      )

      const modelBytes = await fs.readFile(resp.modelPath)
      expect([...modelBytes]).toEqual([1, 2, 3, 4])

      const manifestText = await fs.readFile(resp.manifestPath, 'utf8')
      const recipeText = await fs.readFile(resp.recipePath, 'utf8')
      const importStub = await fs.readFile(resp.importStubPath, 'utf8')
      const validationText = await fs.readFile(resp.validationPath, 'utf8')

      expect(createHash('sha256').update(manifestText, 'utf8').digest('hex')).toBe(
        resp.manifestSha256
      )
      expect(createHash('sha256').update(recipeText, 'utf8').digest('hex')).toBe(resp.recipeSha256)
      expect(createHash('sha256').update(importStub, 'utf8').digest('hex')).toBe(
        resp.importStubSha256
      )

      const manifest = JSON.parse(manifestText) as {
        package: {
          rootDir: string
          fileCount: number
          manifestFileName: string
          validationFileName: string
          importRecipeFileName: string
          importStubFileName: string
          expectedFileNames: string[]
        }
        target: string
        targetLabel: string
        source: {
          fileName: string
          sourceFormat: string
          resolutionKind: string
          sourceLabel?: string
          contextSummary?: {
            kindLabels: string[]
            detailLines: string[]
            totalItemCount: number
            hiddenDetailCount: number
          }
        }
        taskContext?: {
          sessionId: string
          contextPackId?: string
          proposalId?: string
          approvalId?: string
          approvalStatus?: string
          executionResultId?: string
        }
        asset: {
          fileName: string
          relativeModelPath: string
          sourceFormat: string
          sizeBytes: number
          sha256: string
        }
        validation: {
          supportedSourceFormats: string[]
          sourceFormat: string
          isSourceFormatSupported: true
          receiptFileName: string
          packageStructureVerified: true
        }
        importHints: {
          targetDir: string
          packageDir: string
          manifestFileName: string
          validationFileName: string
          importRecipeFileName: string
          importStubFileName: string
          notes: string[]
        }
      }

      const recipe = JSON.parse(recipeText) as {
        version: 1
        app: 'MagicPot'
        target: string
        targetLabel: string
        manualOnly: true
        dispatchMode: string
        package: {
          rootDir: string
          packageDir: string
          manifestFileName: string
          validationFileName: string
          importRecipeFileName: string
          importStubFileName: string
          expectedFileNames: string[]
        }
        source: {
          fileName: string
          sourceFormat: string
          resolutionKind: string
          sourceLabel?: string
          contextSummary?: {
            kindLabels: string[]
            detailLines: string[]
            totalItemCount: number
            hiddenDetailCount: number
          }
        }
        taskContext?: {
          sessionId: string
          contextPackId?: string
          proposalId?: string
          approvalId?: string
          approvalStatus?: string
          executionResultId?: string
        }
        asset: {
          fileName: string
          relativeModelPath: string
          sourceFormat: string
          sizeBytes: number
          sha256: string
        }
        workflow: {
          summary: string
          steps: string[]
          manualNotes: string[]
        }
        importHints: {
          targetDir: string
          packageDir: string
          importStubFileName: string
          notes: string[]
        }
      }

      expect(createHash('sha256').update(validationText, 'utf8').digest('hex')).toBe(
        resp.validationSha256
      )

      const validation = JSON.parse(validationText) as {
        target: string
        targetLabel: string
        modelPath: string
        manifestPath: string
        validationPath: string
        recipePath: string
        importStubPath: string
        artifact: {
          fileName: string
          relativeModelPath: string
          sourceFormat: string
          sizeBytes: number
          sha256: string
        }
        files: {
          manifest: {
            fileName: string
            path: string
            sizeBytes: number
            sha256: string
          }
          recipe: {
            fileName: string
            path: string
            sizeBytes: number
            sha256: string
          }
          importStub: {
            fileName: string
            path: string
            sizeBytes: number
            sha256: string
          }
        }
        packageStructure: {
          expectedFileNames: string[]
          observedFileNames: string[]
          observedFileCount: number
          missingFileNames: string[]
          unexpectedFileNames: string[]
          isExactMatch: true
        }
        checklist: {
          packageCreated: true
          modelCopied: true
          manifestWritten: true
          importRecipeWritten: true
          importStubWritten: true
          validationWritten: true
          sourceFormatSupported: true
          engineRecipePrepared: true
          packageStructureVerified: true
        }
      }

      expect(manifest.target).toBe('unity')
      expect(manifest.targetLabel).toBe(getDccBridgeTargetLabel('unity'))
      expect(manifest.package.rootDir).toBe(DCC_BRIDGE_EXPORT_ROOT_DIR)
      expect(manifest.package.fileCount).toBe(5)
      expect(manifest.package.manifestFileName).toBe(DCC_BRIDGE_MANIFEST_FILE_NAME)
      expect(manifest.package.validationFileName).toBe(DCC_BRIDGE_VALIDATION_FILE_NAME)
      expect(manifest.package.importRecipeFileName).toBe(getDccBridgeImportRecipeFileName('unity'))
      expect(manifest.package.importStubFileName).toBe(getDccBridgeImportStubFileName('unity'))
      expect(manifest.package.expectedFileNames).toEqual(
        getDccBridgeExpectedPackageFileNames('Hero-Model.glb', 'unity')
      )
      expect(manifest.source.fileName).toBe('Hero Model.glb')
      expect(manifest.source.sourceFormat).toBe('.glb')
      expect(manifest.source.resolutionKind).toBe('buffer')
      expect(manifest.source.sourceLabel).toBe('session-42')
      expect(manifest.source.contextSummary).toEqual({
        kindLabels: ['Imported file 1'],
        detailLines: ['Hero Model.glb -> Imported file / hero-model.glb'],
        totalItemCount: 1,
        hiddenDetailCount: 0
      })
      expect(manifest.taskContext).toEqual({
        sessionId: 'design-session-42',
        contextPackId: 'design-context-42',
        proposalId: 'design-proposal-42',
        approvalId: 'design-approval-42',
        approvalStatus: 'approved',
        executionResultId: 'design-execution-42'
      })
      expect(manifest.asset.fileName).toBe('Hero-Model.glb')
      expect(manifest.asset.relativeModelPath).toBe('Hero-Model.glb')
      expect(manifest.asset.sourceFormat).toBe('.glb')
      expect(manifest.asset.sizeBytes).toBe(4)
      expect(manifest.asset.sha256).toBe(resp.artifactSha256)
      expect(manifest.validation.sourceFormat).toBe('.glb')
      expect(manifest.validation.isSourceFormatSupported).toBe(true)
      expect(manifest.validation.receiptFileName).toBe(DCC_BRIDGE_VALIDATION_FILE_NAME)
      expect(manifest.validation.packageStructureVerified).toBe(true)
      expect(manifest.validation.supportedSourceFormats).toContain('.glb')
      expect(manifest.importHints.targetDir).toBe(targetDir)
      expect(manifest.importHints.packageDir).toBe(resp.packageDir)
      expect(manifest.importHints.manifestFileName).toBe(DCC_BRIDGE_MANIFEST_FILE_NAME)
      expect(manifest.importHints.validationFileName).toBe(DCC_BRIDGE_VALIDATION_FILE_NAME)
      expect(manifest.importHints.importRecipeFileName).toBe(
        getDccBridgeImportRecipeFileName('unity')
      )
      expect(manifest.importHints.importStubFileName).toBe(getDccBridgeImportStubFileName('unity'))
      expect(manifest.importHints.notes).toEqual(
        expect.arrayContaining([
          'Point this at a Unity Assets folder or a subfolder inside Assets.',
          'Open unity-import-recipe.json for the exact manual copy and refresh steps.',
          'Unity should auto-refresh after the copy, but the import settings still need a human review.',
          'Source context: Imported file 1',
          'Source detail: Hero Model.glb -> Imported file / hero-model.glb',
          'Task context: session design-session-42, approval approved',
          'Task context pack: design-context-42',
          'Task proposal: design-proposal-42',
          'Task approval: design-approval-42',
          'Task execution result: design-execution-42'
        ])
      )

      expect(recipe.target).toBe('unity')
      expect(recipe.targetLabel).toBe('Unity')
      expect(recipe.manualOnly).toBe(true)
      expect(recipe.package.rootDir).toBe(DCC_BRIDGE_EXPORT_ROOT_DIR)
      expect(recipe.package.packageDir).toBe(resp.packageDir)
      expect(recipe.package.manifestFileName).toBe(DCC_BRIDGE_MANIFEST_FILE_NAME)
      expect(recipe.package.validationFileName).toBe(DCC_BRIDGE_VALIDATION_FILE_NAME)
      expect(recipe.package.importRecipeFileName).toBe(getDccBridgeImportRecipeFileName('unity'))
      expect(recipe.package.importStubFileName).toBe(getDccBridgeImportStubFileName('unity'))
      expect(recipe.package.expectedFileNames).toEqual(
        getDccBridgeExpectedPackageFileNames('Hero-Model.glb', 'unity')
      )
      expect(recipe.asset).toEqual({
        fileName: 'Hero-Model.glb',
        relativeModelPath: 'Hero-Model.glb',
        sourceFormat: '.glb',
        sizeBytes: 4,
        sha256: resp.artifactSha256
      })
      expect(recipe.workflow.summary).toBe(
        'Copy the package into a Unity Assets folder and let Unity refresh the imported model.'
      )
      expect(recipe.workflow.steps).toEqual(
        expect.arrayContaining([
          'Copy the entire Hero-Model-20260323040506 folder into a Unity Assets folder or a subfolder under Assets.',
          'Wait for Unity to refresh, then verify the model appears in the Project window.',
          'Review import settings such as scale, materials, and mesh compression manually if needed.',
          'This package does not contain a native Unity importer.'
        ])
      )
      expect(recipe.workflow.manualNotes).toEqual([
        'Point this at a Unity Assets folder or a subfolder inside Assets.',
        'Open unity-import-recipe.json for the exact manual copy and refresh steps.',
        'Unity should auto-refresh after the copy, but the import settings still need a human review.',
        'Source context: Imported file 1',
        'Source detail: Hero Model.glb -> Imported file / hero-model.glb',
        'Task context: session design-session-42, approval approved',
        'Task context pack: design-context-42',
        'Task proposal: design-proposal-42',
        'Task approval: design-approval-42',
        'Task execution result: design-execution-42'
      ])
      expect(recipe.source.contextSummary).toEqual({
        kindLabels: ['Imported file 1'],
        detailLines: ['Hero Model.glb -> Imported file / hero-model.glb'],
        totalItemCount: 1,
        hiddenDetailCount: 0
      })
      expect(recipe.taskContext).toEqual({
        sessionId: 'design-session-42',
        contextPackId: 'design-context-42',
        proposalId: 'design-proposal-42',
        approvalId: 'design-approval-42',
        approvalStatus: 'approved',
        executionResultId: 'design-execution-42'
      })
      expect(recipe.importHints.targetDir).toBe(targetDir)
      expect(recipe.importHints.packageDir).toBe(resp.packageDir)
      expect(recipe.importHints.importStubFileName).toBe(getDccBridgeImportStubFileName('unity'))
      expect(recipe.importHints.notes).toEqual(
        expect.arrayContaining([
          'The package is a manual handoff only and must be copied into a Unity project folder by a person.',
          'Use unity-import-recipe.json as the target-specific import checklist.',
          'Use unity-import-helper.cs as the generated Unity import stub starting point.',
          'Point this at a Unity Assets folder or a subfolder inside Assets.',
          'Source context: Imported file 1',
          'Source detail: Hero Model.glb -> Imported file / hero-model.glb',
          'Task context: session design-session-42, approval approved',
          'Task context pack: design-context-42',
          'Task proposal: design-proposal-42',
          'Task approval: design-approval-42',
          'Task execution result: design-execution-42'
        ])
      )

      expect(validation.target).toBe('unity')
      expect(validation.targetLabel).toBe('Unity')
      expect(validation.modelPath).toBe(resp.modelPath)
      expect(validation.manifestPath).toBe(resp.manifestPath)
      expect(validation.validationPath).toBe(resp.validationPath)
      expect(validation.recipePath).toBe(resp.recipePath)
      expect(validation.importStubPath).toBe(resp.importStubPath)
      expect(validation.artifact.fileName).toBe('Hero-Model.glb')
      expect(validation.artifact.relativeModelPath).toBe('Hero-Model.glb')
      expect(validation.artifact.sourceFormat).toBe('.glb')
      expect(validation.artifact.sizeBytes).toBe(4)
      expect(validation.artifact.sha256).toBe(resp.artifactSha256)
      expect(validation.files.manifest.fileName).toBe(DCC_BRIDGE_MANIFEST_FILE_NAME)
      expect(validation.files.manifest.path).toBe(resp.manifestPath)
      expect(validation.files.manifest.sizeBytes).toBeGreaterThan(0)
      expect(validation.files.manifest.sha256).toBe(resp.manifestSha256)
      expect(validation.files.recipe.fileName).toBe(getDccBridgeImportRecipeFileName('unity'))
      expect(validation.files.recipe.path).toBe(resp.recipePath)
      expect(validation.files.recipe.sizeBytes).toBeGreaterThan(0)
      expect(validation.files.recipe.sha256).toBe(resp.recipeSha256)
      expect(validation.files.importStub.fileName).toBe(getDccBridgeImportStubFileName('unity'))
      expect(validation.files.importStub.path).toBe(resp.importStubPath)
      expect(validation.files.importStub.sizeBytes).toBeGreaterThan(0)
      expect(validation.files.importStub.sha256).toBe(resp.importStubSha256)
      expect(validation.packageStructure.expectedFileNames).toEqual(
        getDccBridgeExpectedPackageFileNames('Hero-Model.glb', 'unity')
      )
      expect(validation.packageStructure.observedFileNames).toEqual(
        getDccBridgeExpectedPackageFileNames('Hero-Model.glb', 'unity')
      )
      expect(validation.packageStructure.observedFileCount).toBe(5)
      expect(validation.packageStructure.missingFileNames).toEqual([])
      expect(validation.packageStructure.unexpectedFileNames).toEqual([])
      expect(validation.packageStructure.isExactMatch).toBe(true)
      expect(validation.checklist.packageCreated).toBe(true)
      expect(validation.checklist.modelCopied).toBe(true)
      expect(validation.checklist.manifestWritten).toBe(true)
      expect(validation.checklist.importRecipeWritten).toBe(true)
      expect(validation.checklist.importStubWritten).toBe(true)
      expect(validation.checklist.validationWritten).toBe(true)
      expect(validation.checklist.sourceFormatSupported).toBe(true)
      expect(validation.checklist.engineRecipePrepared).toBe(true)
      expect(validation.checklist.packageStructureVerified).toBe(true)

      expect(importStub).toContain('// MagicPot Unity import helper stub')
      expect(importStub).toContain('// Package folder: Hero-Model-20260323040506')
      expect(importStub).toContain('// Asset file: Hero-Model.glb')
      expect(importStub).toContain('MenuItem("MagicPot/Import Latest Bundle")')
      expect(importStub).toContain(
        'Directory.GetFiles(Application.dataPath, assetFileName, SearchOption.AllDirectories)'
      )
      expect(importStub).toContain('AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(assetPath)')
    } finally {
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    }
  })

  it('fails fast when the bridge target directory is not configured', async () => {
    mockConfig({
      dcc_bridge_config: {
        unity_export_dir: '',
        unreal_export_dir: ''
      }
    })

    const svc = new DccBridgeSvcImpl()
    await expect(
      svc.exportModel({
        target: 'unreal',
        fileName: 'Hero Model.glb',
        data: new Uint8Array([1, 2, 3, 4])
      })
    ).rejects.toThrow('No unreal bridge folder configured yet.')
  })

  it('rejects unsupported source formats before writing a package', async () => {
    const targetDir = path.join(await createNodeTestArtifactDir('dcc-bridge-unsupported'), 'unity')
    await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    await fs.mkdir(targetDir, { recursive: true })
    try {
      mockConfig({
        dcc_bridge_config: {
          unity_export_dir: targetDir,
          unreal_export_dir: targetDir
        }
      })

      const svc = new DccBridgeSvcImpl()
      await expect(
        svc.exportModel({
          target: 'unity',
          fileName: 'Hero Model.usdz',
          data: new Uint8Array([1, 2, 3, 4])
        })
      ).rejects.toThrow(
        'Unsupported DCC bridge model format: .usdz. Supported formats: .glb, .gltf, .obj, .fbx, .dae, .3ds, .ply, .stl.'
      )

      const packageRoot = path.join(targetDir, 'MagicPotImports')
      await expect(fs.stat(packageRoot)).rejects.toThrow()
    } finally {
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    }
  })

  it('cleans up the package folder when the validation receipt write fails', async () => {
    const targetDir = path.join(
      await createNodeTestArtifactDir('dcc-bridge-validation-cleanup'),
      'unity'
    )
    await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    await fs.mkdir(targetDir, { recursive: true })
    const realWriteFile = fs.writeFile.bind(fs)
    const writeFileSpy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      const file = String(args[0])
      if (file.endsWith(DCC_BRIDGE_VALIDATION_FILE_NAME)) {
        throw new Error('validation write failed')
      }
      return realWriteFile(args[0] as never, args[1] as never, args[2] as never)
    })
    try {
      mockConfig({
        dcc_bridge_config: {
          unity_export_dir: targetDir,
          unreal_export_dir: targetDir
        }
      })

      const svc = new DccBridgeSvcImpl()
      await expect(
        svc.exportModel({
          target: 'unity',
          fileName: 'Hero Model.glb',
          data: new Uint8Array([1, 2, 3, 4])
        })
      ).rejects.toThrow('validation write failed')

      const packageRoot = path.join(targetDir, 'MagicPotImports')
      await expect(fs.readdir(packageRoot)).resolves.toEqual([])
    } finally {
      writeFileSpy.mockRestore()
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    }
  })

  it('cleans up the package folder when the package structure contains an unexpected entry', async () => {
    const targetDir = path.join(
      await createNodeTestArtifactDir('dcc-bridge-structure-cleanup'),
      'unity'
    )
    await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    await fs.mkdir(targetDir, { recursive: true })
    const realReaddir = fs.readdir.bind(fs)
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      const dir = String(args[0])
      const options = args[1]
      const entries = await realReaddir(args[0] as never, options as never)
      if (dir.includes('MagicPotImports')) {
        return [
          ...entries,
          {
            name: 'unexpected.txt',
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => false
          }
        ] as never
      }
      return entries as never
    })
    try {
      mockConfig({
        dcc_bridge_config: {
          unity_export_dir: targetDir,
          unreal_export_dir: targetDir
        }
      })

      const svc = new DccBridgeSvcImpl()
      await expect(
        svc.exportModel({
          target: 'unity',
          fileName: 'Hero Model.glb',
          data: new Uint8Array([1, 2, 3, 4])
        })
      ).rejects.toThrow('DCC bridge package structure mismatch.')

      readdirSpy.mockRestore()
      const packageRoot = path.join(targetDir, 'MagicPotImports')
      await expect(fs.readdir(packageRoot)).resolves.toEqual([])
    } finally {
      if (vi.isMockFunction(fs.readdir)) {
        readdirSpy.mockRestore()
      }
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    }
  })
})
