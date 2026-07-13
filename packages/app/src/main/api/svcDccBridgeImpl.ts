import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DCC_BRIDGE_EXPORT_ROOT_DIR,
  DCC_BRIDGE_MANIFEST_FILE_NAME,
  DCC_BRIDGE_VALIDATION_FILE_NAME,
  DccBridgeSvc,
  DCC_BRIDGE_SUPPORTED_MODEL_SOURCE_FORMATS,
  DccBridgeTarget,
  DccBridgeSourceResolutionKind,
  ExportModelToDccReq,
  ExportModelToDccResp,
  getDccBridgeExpectedPackageFileNames,
  getDccBridgeImportRecipeFileName,
  getDccBridgeImportStubFileName,
  getDccBridgeModelSourceFormat,
  getDccBridgeTargetLabel,
  isSupportedDccBridgeModelSourceFormat
} from '@shared/api/svcDccBridge'
import type { BridgeSourceContextSummary } from '@shared/api/bridgeSourceContext'
import type { BridgeTaskContext } from '@shared/api/bridgeTaskContext'
import { getConfig } from '../config/config'
import { isLocalFileSource, normalizeLocalFilePath } from '../utils/localFileUrl'
import { safeRemoteDownload } from './safeRemoteDownload'

const DEFAULT_MODEL_FILENAME = 'model.glb'

type ResolvedModelSource = {
  buffer: Buffer
  fileName: string
  resolutionKind: DccBridgeSourceResolutionKind
}

type DccBridgeManifest = {
  version: 1
  app: 'MagicPot'
  target: DccBridgeTarget
  targetLabel: string
  createdAt: string
  dispatchMode: 'folder-copy'
  package: {
    rootDir: string
    fileCount: number
    manifestFileName: string
    validationFileName: string
    importRecipeFileName: string
    importStubFileName: string
    expectedFileNames: string[]
  }
  source: {
    fileName: string
    sourceFormat: string
    resolutionKind: DccBridgeSourceResolutionKind
    sourceUrl?: string
    sourceLabel?: string
    contextSummary?: BridgeSourceContextSummary
  }
  taskContext?: BridgeTaskContext
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

type DccBridgeImportRecipe = {
  version: 1
  app: 'MagicPot'
  target: DccBridgeTarget
  targetLabel: string
  createdAt: string
  manualOnly: true
  dispatchMode: 'folder-copy'
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
    resolutionKind: DccBridgeSourceResolutionKind
    sourceUrl?: string
    sourceLabel?: string
    contextSummary?: BridgeSourceContextSummary
  }
  taskContext?: BridgeTaskContext
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

type DccBridgeValidationReceipt = {
  version: 1
  app: 'MagicPot'
  target: DccBridgeTarget
  targetLabel: string
  createdAt: string
  packageDir: string
  manifestPath: string
  validationPath: string
  recipePath: string
  modelPath: string
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
  notes: string[]
}

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value)

const isInvalidPathChar = (char: string): boolean => {
  const code = char.charCodeAt(0)
  return code < 32 || /[<>:"/\\|?*]/.test(char)
}

const sanitizePathSegment = (value: string): string =>
  Array.from(value)
    .map((char) => (isInvalidPathChar(char) ? '-' : char))
    .join('')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

const getDownloadFileNameFromUrl = (value: string): string => {
  try {
    const normalized = normalizeLocalFilePath(value)
    if (isLocalFileSource(value)) {
      return path.basename(normalized)
    }
    return decodeURIComponent(new URL(value).pathname.split('/').pop() || DEFAULT_MODEL_FILENAME)
  } catch {
    return DEFAULT_MODEL_FILENAME
  }
}

const ensureFileExtension = (fileName: string): string => {
  const trimmed = fileName.trim()
  if (!trimmed) return DEFAULT_MODEL_FILENAME
  const ext = path.extname(trimmed)
  return ext ? trimmed : `${trimmed}.glb`
}

const decodeDataUrl = (value: string): Buffer => {
  const commaIndex = value.indexOf(',')
  if (commaIndex < 0) {
    throw new Error('Invalid data URL for DCC bridge export.')
  }
  const payload = value.slice(commaIndex + 1)
  return Buffer.from(payload, 'base64')
}

const hashText = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

const buildPackageFolderName = (fileName: string): string => {
  const baseName = path.basename(fileName, path.extname(fileName))
  const sanitizedBase = sanitizePathSegment(baseName) || 'model'
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  return `${sanitizedBase}-${timestamp}`
}

const getConfiguredTargetDir = (target: DccBridgeTarget): string => {
  const config = getConfig()
  const bridgeConfig = config.dcc_bridge_config
  if (!bridgeConfig) return ''
  return target === 'unity' ? bridgeConfig.unity_export_dir : bridgeConfig.unreal_export_dir
}

const getTargetNotes = (target: DccBridgeTarget): string[] =>
  target === 'unity'
    ? [
        'Point this at a Unity Assets folder or a subfolder inside Assets.',
        `Open ${getDccBridgeImportRecipeFileName('unity')} for the exact manual copy and refresh steps.`,
        'Unity should auto-refresh after the copy, but the import settings still need a human review.'
      ]
    : [
        'Point this at an Unreal watched source folder for Auto Reimport.',
        `Open ${getDccBridgeImportRecipeFileName('unreal')} for the exact manual copy and reimport steps.`,
        'If Auto Reimport is disabled, import the copied model package manually.'
      ]

const getTargetWorkflowSummary = (target: DccBridgeTarget): string =>
  target === 'unity'
    ? 'Copy the package into a Unity Assets folder and let Unity refresh the imported model.'
    : 'Copy the package into an Unreal watched folder and let Auto Reimport or a manual import consume it.'

const buildSourceContextNotes = (sourceContextSummary?: BridgeSourceContextSummary): string[] => {
  if (!sourceContextSummary || sourceContextSummary.kindLabels.length === 0) return []

  return [
    `Source context: ${sourceContextSummary.kindLabels.join(', ')}`,
    ...sourceContextSummary.detailLines.map((detail) => `Source detail: ${detail}`),
    ...(sourceContextSummary.hiddenDetailCount > 0
      ? [
          `Source detail: plus ${sourceContextSummary.hiddenDetailCount} more source-linked item(s).`
        ]
      : [])
  ]
}

const buildTaskContextNotes = (taskContext?: BridgeTaskContext): string[] => {
  if (!taskContext?.sessionId) return []

  return [
    `Task context: session ${taskContext.sessionId}${taskContext.approvalStatus ? `, approval ${taskContext.approvalStatus}` : ''}`,
    ...(taskContext.contextPackId ? [`Task context pack: ${taskContext.contextPackId}`] : []),
    ...(taskContext.proposalId ? [`Task proposal: ${taskContext.proposalId}`] : []),
    ...(taskContext.approvalId ? [`Task approval: ${taskContext.approvalId}`] : []),
    ...(taskContext.executionResultId
      ? [`Task execution result: ${taskContext.executionResultId}`]
      : [])
  ]
}

const getTargetWorkflowSteps = (target: DccBridgeTarget, packageFolderName: string): string[] =>
  target === 'unity'
    ? [
        `Copy the entire ${packageFolderName} folder into a Unity Assets folder or a subfolder under Assets.`,
        'Run the generated Unity import helper stub, which searches for the copied model file by name inside Assets.',
        'Wait for Unity to refresh, then verify the model appears in the Project window.',
        'Review import settings such as scale, materials, and mesh compression manually if needed.',
        'This package does not contain a native Unity importer.'
      ]
    : [
        `Copy the entire ${packageFolderName} folder into an Unreal watched source folder.`,
        'If Auto Reimport is enabled, let Unreal ingest the model from that folder.',
        'If Auto Reimport is disabled, import the model manually and verify it in the Content Browser.',
        'Run the generated Unreal import helper stub, which searches for the copied model file by name inside the project Content folder.',
        'Review the generated unreal-import-helper.py stub before you run or adapt it in the Unreal Python console.'
      ]

const buildImportStub = (
  target: DccBridgeTarget,
  packageFolderName: string,
  finalFileName: string
): string => {
  if (target === 'unity') {
    return [
      '// MagicPot Unity import helper stub',
      '// Manual-only: adapt this Editor script inside your Unity project before execution.',
      `// Package folder: ${packageFolderName}`,
      `// Asset file: ${finalFileName}`,
      '// The stub searches for the copied file by filename anywhere under Assets.',
      'using UnityEditor;',
      'using UnityEngine;',
      'using System.IO;',
      '',
      'public static class MagicPotImportHelper',
      '{',
      '    [MenuItem("MagicPot/Import Latest Bundle")]',
      '    public static void ImportLatestBundle()',
      '    {',
      `        const string assetFileName = "${finalFileName}";`,
      '        const string assetsRoot = "Assets";',
      '        var matches = Directory.GetFiles(Application.dataPath, assetFileName, SearchOption.AllDirectories);',
      '        if (matches.Length == 0)',
      '        {',
      '            Debug.LogWarning($"MagicPot asset not found. Copy the bundle into Assets first.");',
      '            return;',
      '        }',
      '',
      '        var assetPath = matches[0].Replace(Application.dataPath, assetsRoot).Replace("\\\\", "/");',
      '        var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(assetPath);',
      '        if (asset == null)',
      '        {',
      '            Debug.LogWarning($"MagicPot asset was found but could not be loaded at {assetPath}.");',
      '            return;',
      '        }',
      '',
      '        Selection.activeObject = asset;',
      '        EditorGUIUtility.PingObject(asset);',
      '        Debug.Log($"MagicPot asset ready for review: {assetPath}");',
      '    }',
      '}'
    ].join('\n')
  }

  return [
    '# MagicPot Unreal import helper stub',
    '# Manual-only: adapt this Python helper in your Unreal project before execution.',
    `# Package folder: ${packageFolderName}`,
    `# Asset file: ${finalFileName}`,
    '# The stub searches for the copied file by filename anywhere under the project Content folder.',
    'import glob',
    'import os',
    'import unreal',
    '',
    `SOURCE_FILE = r"${finalFileName}"`,
    `DESTINATION_PATH = "/Game/${packageFolderName}"`,
    '',
    'task = unreal.AssetImportTask()',
    'content_root = unreal.Paths.project_content_dir()',
    'matches = glob.glob(os.path.join(content_root, "**", SOURCE_FILE), recursive=True)',
    'if not matches:',
    '    unreal.log_error(f"MagicPot asset not found. Copy the bundle into {content_root} first.")',
    '    raise RuntimeError("MagicPot asset not found.")',
    '',
    'task.filename = matches[0]',
    'task.destination_path = DESTINATION_PATH',
    'task.automated = True',
    'task.save = True',
    '',
    'unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])',
    'unreal.log(f"MagicPot import task prepared for {matches[0]} -> {DESTINATION_PATH}")'
  ].join('\n')
}

const resolveModelSource = async (req: ExportModelToDccReq): Promise<ResolvedModelSource> => {
  if (req.data && req.data.length > 0) {
    const fileName = ensureFileExtension(req.fileName || DEFAULT_MODEL_FILENAME)
    return { buffer: Buffer.from(req.data), fileName, resolutionKind: 'buffer' }
  }

  const sourceUrl = req.sourceUrl?.trim() || ''
  if (!sourceUrl) {
    throw new Error('Missing model data for DCC bridge export.')
  }

  const requestedFileName = req.fileName?.trim()

  if (sourceUrl.startsWith('data:')) {
    return {
      buffer: decodeDataUrl(sourceUrl),
      fileName: ensureFileExtension(requestedFileName || DEFAULT_MODEL_FILENAME),
      resolutionKind: 'data-url'
    }
  }

  const localPath = normalizeLocalFilePath(sourceUrl)
  if (isLocalFileSource(sourceUrl)) {
    return {
      buffer: await fs.readFile(localPath),
      fileName: ensureFileExtension(requestedFileName || path.basename(localPath)),
      resolutionKind: 'local-file'
    }
  }

  if (isHttpUrl(sourceUrl)) {
    const download = await safeRemoteDownload(sourceUrl, {
      allowedContentTypes: [
        'model/',
        'application/octet-stream',
        'application/gltf-buffer',
        'application/gltf+json'
      ],
      errorLabel: 'model'
    })
    return {
      buffer: download.buffer,
      fileName: ensureFileExtension(
        requestedFileName || getDownloadFileNameFromUrl(download.finalUrl.toString())
      ),
      resolutionKind: 'http-url'
    }
  }

  throw new Error(`Unsupported model source for DCC bridge export: ${sourceUrl}`)
}

const getUnsupportedFormatError = (fileName: string): string => {
  const sourceFormat = getDccBridgeModelSourceFormat(fileName) || '(missing extension)'
  const supportedFormats = DCC_BRIDGE_SUPPORTED_MODEL_SOURCE_FORMATS.join(', ')
  return `Unsupported DCC bridge model format: ${sourceFormat}. Supported formats: ${supportedFormats}.`
}

const sortFileNames = (fileNames: string[]): string[] =>
  [...fileNames].sort((left, right) => left.localeCompare(right))

const listPackageEntries = async (
  packageDir: string
): Promise<{
  fileNames: string[]
  unexpectedEntryNames: string[]
}> => {
  const entries = await fs.readdir(packageDir, { withFileTypes: true })
  const fileNames: string[] = []
  const unexpectedEntryNames: string[] = []

  for (const entry of entries) {
    if (entry.isFile()) {
      fileNames.push(entry.name)
    } else {
      unexpectedEntryNames.push(entry.name)
    }
  }

  return {
    fileNames: sortFileNames(fileNames),
    unexpectedEntryNames: sortFileNames(unexpectedEntryNames)
  }
}

const buildPackageStructure = (
  expectedFileNames: string[],
  observedFileNames: string[],
  unexpectedEntryNames: string[]
): DccBridgeValidationReceipt['packageStructure'] => {
  const expectedSet = new Set(expectedFileNames)
  const observedSet = new Set(observedFileNames)
  const missingFileNames = sortFileNames(
    expectedFileNames.filter((fileName) => !observedSet.has(fileName))
  )
  const unexpectedFileNames = sortFileNames([
    ...observedFileNames.filter((fileName) => !expectedSet.has(fileName)),
    ...unexpectedEntryNames
  ])

  if (missingFileNames.length > 0 || unexpectedFileNames.length > 0) {
    throw new Error(
      `DCC bridge package structure mismatch. Missing: ${missingFileNames.join(', ') || 'none'}. Unexpected: ${unexpectedFileNames.join(', ') || 'none'}.`
    )
  }

  return {
    expectedFileNames,
    observedFileNames: expectedFileNames.filter((fileName) => observedSet.has(fileName)),
    observedFileCount: observedFileNames.length,
    missingFileNames,
    unexpectedFileNames,
    isExactMatch: true
  }
}

const buildImportRecipe = (
  req: ExportModelToDccReq,
  resolved: ResolvedModelSource,
  finalFileName: string,
  sourceFormat: string,
  artifactSizeBytes: number,
  artifactSha256: string,
  targetDir: string,
  packageDir: string,
  packageFolderName: string,
  importRecipeFileName: string,
  expectedFileNames: string[]
): DccBridgeImportRecipe => {
  const targetLabel = getDccBridgeTargetLabel(req.target)
  const importStubFileName = getDccBridgeImportStubFileName(req.target)
  return {
    version: 1,
    app: 'MagicPot',
    target: req.target,
    targetLabel,
    createdAt: new Date().toISOString(),
    manualOnly: true,
    dispatchMode: 'folder-copy',
    package: {
      rootDir: DCC_BRIDGE_EXPORT_ROOT_DIR,
      packageDir,
      manifestFileName: DCC_BRIDGE_MANIFEST_FILE_NAME,
      validationFileName: DCC_BRIDGE_VALIDATION_FILE_NAME,
      importRecipeFileName,
      importStubFileName,
      expectedFileNames
    },
    source: {
      fileName: resolved.fileName,
      sourceFormat,
      resolutionKind: resolved.resolutionKind,
      sourceUrl: req.sourceUrl,
      sourceLabel: req.sourceLabel,
      contextSummary: req.sourceContextSummary
    },
    taskContext: req.taskContext,
    asset: {
      fileName: finalFileName,
      relativeModelPath: finalFileName,
      sourceFormat,
      sizeBytes: artifactSizeBytes,
      sha256: artifactSha256
    },
    workflow: {
      summary: getTargetWorkflowSummary(req.target),
      steps: getTargetWorkflowSteps(req.target, packageFolderName),
      manualNotes: [
        ...getTargetNotes(req.target),
        ...buildSourceContextNotes(req.sourceContextSummary),
        ...buildTaskContextNotes(req.taskContext)
      ]
    },
    importHints: {
      targetDir,
      packageDir,
      importStubFileName,
      notes: [
        `The package is a manual handoff only and must be copied into a ${targetLabel} project folder by a person.`,
        `Use ${importRecipeFileName} as the target-specific import checklist.`,
        `Use ${importStubFileName} as the generated ${targetLabel} import stub starting point.`,
        ...getTargetNotes(req.target),
        ...buildSourceContextNotes(req.sourceContextSummary),
        ...buildTaskContextNotes(req.taskContext)
      ]
    }
  }
}

export class DccBridgeSvcImpl implements DccBridgeSvc {
  async exportModel(req: ExportModelToDccReq): Promise<ExportModelToDccResp> {
    const targetDir = getConfiguredTargetDir(req.target).trim()
    if (!targetDir) {
      throw new Error(`No ${req.target} bridge folder configured yet.`)
    }

    const resolved = await resolveModelSource(req)
    const safeFileName = sanitizePathSegment(
      path.basename(resolved.fileName, path.extname(resolved.fileName))
    )
    const finalFileName = `${safeFileName || 'model'}${path.extname(resolved.fileName) || '.glb'}`
    if (!isSupportedDccBridgeModelSourceFormat(finalFileName)) {
      throw new Error(getUnsupportedFormatError(finalFileName))
    }
    const sourceFormat = getDccBridgeModelSourceFormat(finalFileName)
    const artifactSizeBytes = resolved.buffer.byteLength
    const artifactSha256 = createHash('sha256').update(resolved.buffer).digest('hex')
    const packageFolderName = buildPackageFolderName(finalFileName)
    const packageDir = path.join(targetDir, DCC_BRIDGE_EXPORT_ROOT_DIR, packageFolderName)
    const modelPath = path.join(packageDir, finalFileName)
    const manifestPath = path.join(packageDir, DCC_BRIDGE_MANIFEST_FILE_NAME)
    const validationPath = path.join(packageDir, DCC_BRIDGE_VALIDATION_FILE_NAME)
    const importRecipeFileName = getDccBridgeImportRecipeFileName(req.target)
    const importStubFileName = getDccBridgeImportStubFileName(req.target)
    const recipePath = path.join(packageDir, importRecipeFileName)
    const importStubPath = path.join(packageDir, importStubFileName)
    const expectedFileNames = getDccBridgeExpectedPackageFileNames(finalFileName, req.target)
    const targetLabel = getDccBridgeTargetLabel(req.target)
    const createdAt = new Date().toISOString()
    const manifest: DccBridgeManifest = {
      version: 1,
      app: 'MagicPot',
      target: req.target,
      targetLabel,
      createdAt,
      dispatchMode: 'folder-copy',
      package: {
        rootDir: DCC_BRIDGE_EXPORT_ROOT_DIR,
        fileCount: expectedFileNames.length,
        manifestFileName: DCC_BRIDGE_MANIFEST_FILE_NAME,
        validationFileName: DCC_BRIDGE_VALIDATION_FILE_NAME,
        importRecipeFileName,
        importStubFileName,
        expectedFileNames
      },
      source: {
        fileName: resolved.fileName,
        sourceFormat,
        resolutionKind: resolved.resolutionKind,
        sourceUrl: req.sourceUrl,
        sourceLabel: req.sourceLabel,
        contextSummary: req.sourceContextSummary
      },
      taskContext: req.taskContext,
      asset: {
        fileName: finalFileName,
        relativeModelPath: finalFileName,
        sourceFormat,
        sizeBytes: artifactSizeBytes,
        sha256: artifactSha256
      },
      validation: {
        supportedSourceFormats: [...DCC_BRIDGE_SUPPORTED_MODEL_SOURCE_FORMATS],
        sourceFormat,
        isSourceFormatSupported: true,
        receiptFileName: DCC_BRIDGE_VALIDATION_FILE_NAME,
        packageStructureVerified: true
      },
      importHints: {
        targetDir,
        packageDir,
        manifestFileName: DCC_BRIDGE_MANIFEST_FILE_NAME,
        validationFileName: DCC_BRIDGE_VALIDATION_FILE_NAME,
        importRecipeFileName,
        importStubFileName,
        notes: [
          ...getTargetNotes(req.target),
          ...buildSourceContextNotes(req.sourceContextSummary),
          ...buildTaskContextNotes(req.taskContext)
        ]
      }
    }

    const importRecipe = buildImportRecipe(
      req,
      resolved,
      finalFileName,
      sourceFormat,
      artifactSizeBytes,
      artifactSha256,
      targetDir,
      packageDir,
      packageFolderName,
      importRecipeFileName,
      expectedFileNames
    )

    const manifestText = JSON.stringify(manifest, null, 2)
    const importRecipeText = JSON.stringify(importRecipe, null, 2)
    const importStubText = `${buildImportStub(req.target, packageFolderName, finalFileName)}\n`
    const manifestSha256 = hashText(manifestText)
    const recipeSha256 = hashText(importRecipeText)
    const importStubSha256 = hashText(importStubText)

    const validationReceipt: DccBridgeValidationReceipt = {
      version: 1,
      app: 'MagicPot',
      target: req.target,
      targetLabel,
      createdAt,
      packageDir,
      manifestPath,
      validationPath,
      recipePath,
      modelPath,
      importStubPath,
      artifact: {
        fileName: finalFileName,
        relativeModelPath: finalFileName,
        sourceFormat,
        sizeBytes: artifactSizeBytes,
        sha256: artifactSha256
      },
      files: {
        manifest: {
          fileName: DCC_BRIDGE_MANIFEST_FILE_NAME,
          path: manifestPath,
          sizeBytes: Buffer.byteLength(manifestText, 'utf8'),
          sha256: manifestSha256
        },
        recipe: {
          fileName: importRecipeFileName,
          path: recipePath,
          sizeBytes: Buffer.byteLength(importRecipeText, 'utf8'),
          sha256: recipeSha256
        },
        importStub: {
          fileName: importStubFileName,
          path: importStubPath,
          sizeBytes: Buffer.byteLength(importStubText, 'utf8'),
          sha256: importStubSha256
        }
      },
      packageStructure: {
        expectedFileNames,
        observedFileNames: [],
        observedFileCount: 0,
        missingFileNames: [],
        unexpectedFileNames: [],
        isExactMatch: true
      },
      checklist: {
        packageCreated: true,
        modelCopied: true,
        manifestWritten: true,
        importRecipeWritten: true,
        importStubWritten: true,
        validationWritten: true,
        sourceFormatSupported: true,
        engineRecipePrepared: true,
        packageStructureVerified: true
      },
      notes: getTargetNotes(req.target)
    }

    await fs.mkdir(packageDir, { recursive: true })
    try {
      await fs.writeFile(modelPath, resolved.buffer)
      await fs.writeFile(manifestPath, manifestText, 'utf8')
      await fs.writeFile(recipePath, importRecipeText, 'utf8')
      await fs.writeFile(importStubPath, importStubText, 'utf8')
      await fs.writeFile(validationPath, JSON.stringify(validationReceipt, null, 2), 'utf8')

      const { fileNames: observedFileNames, unexpectedEntryNames } =
        await listPackageEntries(packageDir)
      const packageStructure = buildPackageStructure(
        expectedFileNames,
        observedFileNames,
        unexpectedEntryNames
      )
      const finalValidationReceipt: DccBridgeValidationReceipt = {
        ...validationReceipt,
        packageStructure,
        checklist: {
          ...validationReceipt.checklist,
          packageStructureVerified: true,
          engineRecipePrepared: true
        }
      }
      const finalValidationText = JSON.stringify(finalValidationReceipt, null, 2)
      await fs.writeFile(validationPath, finalValidationText, 'utf8')

      return {
        target: req.target,
        targetDir,
        packageDir,
        manifestPath,
        manifestSha256,
        validationPath,
        validationSha256: hashText(finalValidationText),
        recipePath,
        recipeSha256,
        modelPath,
        importStubPath,
        importStubSha256,
        artifactSizeBytes,
        artifactSha256
      }
    } catch (error) {
      await fs.rm(packageDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
}
