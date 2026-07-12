import fs from 'node:fs/promises'
import path from 'node:path'
import {
  ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME,
  ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME,
  ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME,
  ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME,
  ADOBE_BRIDGE_MANIFEST_FILE_NAME,
  ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME,
  AdobeBridgeSvc,
  AdobeBridgeTarget,
  ExportAssetToAdobeReq,
  ExportAssetToAdobeResp,
  type AdobeBridgePackageContents
} from '@shared/api/svcAdobeBridge'
import type { BridgeSourceContextSummary } from '@shared/api/bridgeSourceContext'
import type { BridgeTaskContext } from '@shared/api/bridgeTaskContext'
import { getConfig } from '../config/config'
import { isLocalFileSource, normalizeLocalFilePath } from '../utils/localFileUrl'
import { safeRemoteDownload } from './safeRemoteDownload'

const MAGICPOT_IMPORTS_DIR = 'MagicPotImports'
const DEFAULT_IMAGE_FILENAME = 'asset.png'

type ResolvedAssetSource = {
  buffer: Buffer
  fileName: string
  sourceKind: 'uploaded-bytes' | 'data-url' | 'local-file' | 'http-download'
}

type AdobeBridgeManifest = {
  version: 1
  app: 'MagicPot'
  target: AdobeBridgeTarget
  targetLabel: string
  createdAt: string
  dispatchMode: 'folder-copy'
  workflow: {
    inputMode: 'image+prompt'
    handoffMode: 'manual-folder-copy'
    manualOnly: true
  }
  source: {
    fileName: string
    sourceKind: ResolvedAssetSource['sourceKind']
    sourceUrl?: string
    sourceLabel?: string
    contextSummary?: BridgeSourceContextSummary
    promptText?: string
    mimeType?: string
  }
  taskContext?: BridgeTaskContext
  packageContents: {
    assetFileName: string
    manifestFileName: string
    instructionsFileName: string
    payloadFileName: string
    recipeFileName: string
    scriptStubFileName: string
  }
  asset: {
    fileName: string
    relativeAssetPath: string
  }
  handoff: {
    instructionsFileName: string
    instructionsRelativePath: string
    payloadFileName: string
    payloadRelativePath: string
    recipeFileName: string
    recipeRelativePath: string
    purpose: 'manual-handoff'
    manualOnly: true
    summary: string[]
  }
  bundle: {
    assetFileName: string
    manifestFileName: string
    instructionsFileName: string
    payloadFileName: string
    recipeFileName: string
    scriptStubFileName?: string
  }
  importHints: {
    targetDir: string
    packageDir: string
    manifestFileName: string
    instructionsFileName: string
    payloadFileName: string
    recipeFileName: string
    scriptStubFileName?: string
    notes: string[]
  }
}

const buildSourceContextSummaryLine = (
  sourceContextSummary?: BridgeSourceContextSummary
): string | null => {
  if (!sourceContextSummary || sourceContextSummary.kindLabels.length === 0) {
    return null
  }

  return `Source context: ${sourceContextSummary.kindLabels.join(', ')}`
}

const appendSourceContextSection = (
  lines: string[],
  sourceContextSummary?: BridgeSourceContextSummary
): void => {
  if (!sourceContextSummary || sourceContextSummary.kindLabels.length === 0) return

  lines.push('', '## Source Context', `- Summary: ${sourceContextSummary.kindLabels.join(', ')}`)

  if (sourceContextSummary.detailLines.length > 0) {
    lines.push(...sourceContextSummary.detailLines.map((detail) => `- ${detail}`))
  }

  if (sourceContextSummary.hiddenDetailCount > 0) {
    lines.push(`- Plus ${sourceContextSummary.hiddenDetailCount} more source-linked item(s).`)
  }
}

const buildTaskContextSummaryLine = (taskContext?: BridgeTaskContext): string | null => {
  if (!taskContext?.sessionId) return null

  const parts = [`session ${taskContext.sessionId}`]
  if (taskContext.approvalStatus) {
    parts.push(`approval ${taskContext.approvalStatus}`)
  }

  return `Task context: ${parts.join(', ')}`
}

const appendTaskContextSection = (lines: string[], taskContext?: BridgeTaskContext): void => {
  if (!taskContext?.sessionId) return

  lines.push('', '## Task Context', `- Session: ${taskContext.sessionId}`)

  if (taskContext.contextPackId) {
    lines.push(`- Context pack: ${taskContext.contextPackId}`)
  }
  if (taskContext.proposalId) {
    lines.push(`- Proposal: ${taskContext.proposalId}`)
  }
  if (taskContext.approvalId) {
    lines.push(`- Approval: ${taskContext.approvalId}`)
  }
  if (taskContext.approvalStatus) {
    lines.push(`- Approval status: ${taskContext.approvalStatus}`)
  }
  if (taskContext.executionResultId) {
    lines.push(`- Execution result: ${taskContext.executionResultId}`)
  }
}

type AdobeBridgeInstructionPayload = {
  version: 1
  app: 'MagicPot'
  target: AdobeBridgeTarget
  targetLabel: string
  createdAt: string
  dispatchMode: 'folder-copy'
  manualOnly: true
  workbookRequirement: 'image+prompt-to-target'
  source: AdobeBridgeManifest['source']
  taskContext?: AdobeBridgeManifest['taskContext']
  packageContents: AdobeBridgeManifest['packageContents']
  asset: AdobeBridgeManifest['asset']
  handoff: {
    purpose: 'manual-handoff'
    instructionsFileName: string
    instructionsRelativePath: string
    payloadFileName: string
    payloadRelativePath: string
    recipeFileName: string
    recipeRelativePath: string
    steps: string[]
    targetNotes: string[]
  }
  bundle: AdobeBridgeManifest['bundle']
  reviewChecklist: string[]
}

type AdobeBridgeExecutionRecipe = {
  version: 1
  app: 'MagicPot'
  target: AdobeBridgeTarget
  targetLabel: string
  createdAt: string
  dispatchMode: 'folder-copy'
  manualOnly: true
  automationStatus: 'manual-sidecar'
  source: AdobeBridgeManifest['source']
  taskContext?: AdobeBridgeManifest['taskContext']
  packageContents: AdobeBridgeManifest['packageContents']
  asset: AdobeBridgeManifest['asset']
  bundle: AdobeBridgeManifest['bundle']
  execution: {
    host: string
    hostKind: AdobeBridgeTarget
    intent: 'after-effects-first' | 'premiere-manual'
    steps: string[]
    notes: string[]
    sidecarScriptStub?: {
      fileName: string
      lines: string[]
    }
  }
  reviewChecklist: string[]
  limitations: string[]
}

const isHttpUrl = (value: string): boolean => /^https?:\/\//i.test(value)

const getTargetLabel = (target: AdobeBridgeTarget): string =>
  target === 'after-effects' ? 'After Effects' : 'Premiere Pro'

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
    return decodeURIComponent(new URL(value).pathname.split('/').pop() || DEFAULT_IMAGE_FILENAME)
  } catch {
    return DEFAULT_IMAGE_FILENAME
  }
}

const decodeDataUrl = (value: string): Buffer => {
  const commaIndex = value.indexOf(',')
  if (commaIndex < 0) {
    throw new Error('Invalid data URL for Adobe bridge export.')
  }
  const payload = value.slice(commaIndex + 1)
  return Buffer.from(payload, 'base64')
}

const getExtensionFromMimeType = (mimeType?: string): string => {
  switch (mimeType?.toLowerCase()) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'video/mp4':
      return '.mp4'
    case 'video/webm':
      return '.webm'
    case 'video/quicktime':
      return '.mov'
    default:
      return '.png'
  }
}

const ensureFileExtension = (fileName: string, mimeType?: string): string => {
  const trimmed = fileName.trim()
  if (!trimmed) {
    return `asset${getExtensionFromMimeType(mimeType)}`
  }
  const ext = path.extname(trimmed)
  return ext ? trimmed : `${trimmed}${getExtensionFromMimeType(mimeType)}`
}

const buildPackageFolderName = (fileName: string): string => {
  const baseName = path.basename(fileName, path.extname(fileName))
  const sanitizedBase = sanitizePathSegment(baseName) || 'asset'
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14)
  return `${sanitizedBase}-${timestamp}`
}

const getConfiguredTargetDir = (target: AdobeBridgeTarget): string => {
  const config = getConfig()
  const bridgeConfig = config.adobe_bridge_config
  if (!bridgeConfig) return ''
  return target === 'after-effects'
    ? bridgeConfig.after_effects_export_dir
    : bridgeConfig.premiere_export_dir
}

const getTargetNotes = (target: AdobeBridgeTarget): string[] =>
  target === 'after-effects'
    ? [
        'Point this at an After Effects import inbox or a synced watch folder.',
        'Use the manifest, payload, recipe, and starter script stub as the source of truth for manual import steps.',
        'Import the copied asset into the active project if your automation does not watch this folder.'
      ]
    : [
        'Point this at a Premiere Pro import inbox or a synced watch folder.',
        'Use the manifest, payload, recipe, and starter script stub as the source of truth for manual import steps.',
        'Import the copied asset into the active project if your automation does not watch this folder.'
      ]

const getScriptStubFileName = (target: AdobeBridgeTarget): string =>
  target === 'after-effects'
    ? ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
    : ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME

const buildPackageContents = (
  target: AdobeBridgeTarget,
  assetFileName: string
): AdobeBridgePackageContents => ({
  assetFileName,
  manifestFileName: ADOBE_BRIDGE_MANIFEST_FILE_NAME,
  instructionsFileName: ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME,
  payloadFileName: ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME,
  recipeFileName: ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME,
  scriptStubFileName: getScriptStubFileName(target)
})

const buildScriptStub = (
  target: AdobeBridgeTarget,
  packageFolderName: string,
  assetFileName: string
): NonNullable<AdobeBridgeExecutionRecipe['execution']['sidecarScriptStub']> => {
  const isAfterEffects = target === 'after-effects'
  const lines = [
    `// MagicPot ${isAfterEffects ? 'After Effects' : 'Premiere Pro'} handoff starter stub`,
    '// Manual-only: MagicPot writes this starter file, but it does not execute Adobe automation.',
    `// Package folder: ${packageFolderName}`,
    `// Asset file: ${assetFileName}`,
    '// TODO: import the copied asset into the active project.',
    isAfterEffects
      ? '// TODO: place it into the comp or timeline that matches the prompt.'
      : '// TODO: place it into the sequence or project bin that matches the prompt.'
  ]

  return {
    fileName: getScriptStubFileName(target),
    lines
  }
}

const buildHandoffSummary = (
  req: ExportAssetToAdobeReq,
  sourceFileName: string,
  assetFileName: string,
  targetLabel: string
): string[] => {
  const lines = [
    `Target: ${targetLabel}`,
    'Workflow: image + prompt manual handoff',
    `Source file: ${sourceFileName}`,
    `Asset file: ${assetFileName}`,
    'This package is a manual handoff only. It does not execute scripts automatically.',
    'A structured execution recipe is included for future automation planning.'
  ]

  if (req.sourceLabel?.trim()) {
    lines.push(`Source label: ${req.sourceLabel.trim()}`)
  }

  const sourceContextLine = buildSourceContextSummaryLine(req.sourceContextSummary)
  if (sourceContextLine) {
    lines.push(sourceContextLine)
  }

  const taskContextLine = buildTaskContextSummaryLine(req.taskContext)
  if (taskContextLine) {
    lines.push(taskContextLine)
  }

  if (req.promptText?.trim()) {
    lines.push(`Prompt: ${req.promptText.trim()}`)
  }

  return lines
}

const buildExecutionRecipe = (
  req: ExportAssetToAdobeReq,
  manifest: AdobeBridgeManifest
): AdobeBridgeExecutionRecipe => {
  const isAfterEffects = req.target === 'after-effects'
  const scriptStub = buildScriptStub(
    req.target,
    path.basename(manifest.importHints.packageDir),
    manifest.asset.fileName
  )

  return {
    version: 1,
    app: 'MagicPot',
    target: req.target,
    targetLabel: manifest.targetLabel,
    createdAt: manifest.createdAt,
    dispatchMode: 'folder-copy',
    manualOnly: true,
    automationStatus: 'manual-sidecar',
    source: manifest.source,
    taskContext: manifest.taskContext,
    packageContents: manifest.packageContents,
    asset: manifest.asset,
    bundle: manifest.bundle,
    execution: {
      host: manifest.targetLabel,
      hostKind: req.target,
      intent: isAfterEffects ? 'after-effects-first' : 'premiere-manual',
      steps: [
        `Copy the full ${path.basename(manifest.importHints.packageDir)} folder into the configured Adobe inbox.`,
        'Open the structured recipe first so the target, source, and package paths stay in sync.',
        'Use the manifest, payload, and recipe as the canonical metadata source.',
        isAfterEffects
          ? 'In After Effects, import the copied asset into the active project or your own script runner.'
          : 'In Premiere Pro, import the copied asset into the active project or your own workflow.'
      ],
      notes: manifest.importHints.notes,
      sidecarScriptStub: scriptStub
    },
    reviewChecklist: [
      'Target-specific inbox path is configured.',
      'Asset file exists beside the manifest, recipe, and instruction payload.',
      'Source label, source context, prompt text, and task context are preserved when provided.',
      'Manual-only wording is present in the sidecar instructions.'
    ],
    limitations: [
      'MagicPot writes the package and recipe files, but it does not launch Adobe apps.',
      'This is a structured handoff recipe, not a native Adobe automation bridge.',
      'Any actual import or script execution still happens manually outside MagicPot.'
    ]
  }
}

const buildInstructionPayload = (
  req: ExportAssetToAdobeReq,
  manifest: AdobeBridgeManifest
): AdobeBridgeInstructionPayload => {
  const targetLabel = manifest.targetLabel
  return {
    version: 1,
    app: 'MagicPot',
    target: req.target,
    targetLabel,
    createdAt: manifest.createdAt,
    dispatchMode: 'folder-copy',
    manualOnly: true,
    workbookRequirement: 'image+prompt-to-target',
    source: manifest.source,
    taskContext: manifest.taskContext,
    packageContents: manifest.packageContents,
    asset: manifest.asset,
    handoff: {
      purpose: 'manual-handoff',
      instructionsFileName: manifest.handoff.instructionsFileName,
      instructionsRelativePath: manifest.handoff.instructionsRelativePath,
      payloadFileName: manifest.handoff.payloadFileName,
      payloadRelativePath: manifest.handoff.payloadRelativePath,
      recipeFileName: manifest.handoff.recipeFileName,
      recipeRelativePath: manifest.handoff.recipeRelativePath,
      steps: [
        `Copy the entire ${path.basename(manifest.importHints.packageDir)} folder into the chosen Adobe inbox.`,
        'Open the manifest, recipe, and instruction payload to recover the original image, prompt, target context, and package contents.',
        'Manually import the copied asset into After Effects or Premiere Pro.',
        'Treat the prompt text as creative direction, not an executable script.'
      ],
      targetNotes: manifest.importHints.notes
    },
    bundle: manifest.bundle,
    reviewChecklist: [
      'Target-specific inbox path is configured.',
      'Asset file exists beside the manifest, recipe, and instruction payload.',
      'Source label, source context, prompt text, and task context are preserved when provided.',
      'Manual-only wording is present in the sidecar instructions.'
    ]
  }
}

const buildHandoffInstructions = (
  manifest: AdobeBridgeManifest,
  payload: AdobeBridgeInstructionPayload,
  recipe: AdobeBridgeExecutionRecipe
): string => {
  const targetLabel = manifest.targetLabel
  const steps = [
    `# MagicPot ${targetLabel} Handoff`,
    '',
    'This package is a manual handoff artifact. MagicPot does not execute the target application for you.',
    '',
    '## Package Contents',
    `- Asset file: \`${manifest.packageContents.assetFileName}\``,
    `- Manifest: \`${manifest.packageContents.manifestFileName}\``,
    `- Instruction payload: \`${manifest.packageContents.payloadFileName}\``,
    `- Execution recipe: \`${manifest.packageContents.recipeFileName}\``,
    `- Instructions: \`${manifest.packageContents.instructionsFileName}\``,
    recipe.execution.sidecarScriptStub
      ? `- Starter script stub: \`${recipe.execution.sidecarScriptStub.fileName}\``
      : null,
    '',
    '## Generated Handoff Payload',
    `- Workbook requirement: \`${payload.workbookRequirement}\``,
    `- Manual-only: \`${String(payload.manualOnly)}\``,
    `- Dispatch mode: \`${payload.dispatchMode}\``,
    '- Package contents are recorded in the manifest and mirrored in the payload and recipe.',
    '',
    '## Generated Execution Recipe',
    `- Recipe file: \`${recipe.bundle.recipeFileName}\``,
    `- Recipe mode: \`${recipe.automationStatus}\``,
    `- Intent: \`${recipe.execution.intent}\``,
    `- Starter script stub: \`${recipe.execution.sidecarScriptStub?.fileName ?? 'not generated for this target'}\``,
    '',
    '## Generated Handoff Steps',
    ...payload.handoff.steps.map((step) => `- ${step}`),
    '',
    '## Suggested Next Steps',
    `1. Copy or sync the entire \`${path.basename(manifest.importHints.packageDir)}\` folder into your target import inbox.`,
    '2. Open the execution recipe first to confirm the target, source, and package paths.',
    '3. Open the instruction payload to confirm the handoff notes and review checklist.',
    '4. Import the asset into the active project or watched folder workflow.',
    recipe.execution.sidecarScriptStub
      ? `5. Review \`${recipe.execution.sidecarScriptStub.fileName}\` as the generated starter script, then adapt or run it in your own Adobe workflow.`
      : '5. Use the prompt text as creative direction or task context when you build the actual AE/PR workflow.',
    '',
    '## Notes',
    ...payload.handoff.targetNotes.map((note) => `- ${note}`)
  ].filter((step): step is string => Boolean(step))

  steps.push('', '## Recipe Limitations', ...recipe.limitations.map((note) => `- ${note}`))

  appendSourceContextSection(steps, manifest.source.contextSummary)
  appendTaskContextSection(steps, manifest.taskContext)

  if (manifest.source.sourceLabel?.trim()) {
    steps.push('', `Source label: ${manifest.source.sourceLabel.trim()}`)
  }

  if (manifest.source.promptText?.trim()) {
    steps.push('', '## Prompt Context', manifest.source.promptText.trim())
  }

  steps.push('', '## Review Checklist', ...payload.reviewChecklist.map((item) => `- ${item}`))

  return steps.join('\n')
}

const resolveAssetSource = async (req: ExportAssetToAdobeReq): Promise<ResolvedAssetSource> => {
  if (req.data && req.data.length > 0) {
    const fileName = ensureFileExtension(req.fileName || DEFAULT_IMAGE_FILENAME, req.mimeType)
    return { buffer: Buffer.from(req.data), fileName, sourceKind: 'uploaded-bytes' }
  }

  const sourceUrl = req.sourceUrl?.trim() || ''
  if (!sourceUrl) {
    throw new Error('Missing asset data for Adobe bridge export.')
  }

  const requestedFileName = req.fileName?.trim()

  if (sourceUrl.startsWith('data:')) {
    return {
      buffer: decodeDataUrl(sourceUrl),
      fileName: ensureFileExtension(requestedFileName || DEFAULT_IMAGE_FILENAME, req.mimeType),
      sourceKind: 'data-url'
    }
  }

  const localPath = normalizeLocalFilePath(sourceUrl)
  if (isLocalFileSource(sourceUrl)) {
    return {
      buffer: await fs.readFile(localPath),
      fileName: ensureFileExtension(requestedFileName || path.basename(localPath), req.mimeType),
      sourceKind: 'local-file'
    }
  }

  if (isHttpUrl(sourceUrl)) {
    const download = await safeRemoteDownload(sourceUrl, {
      allowedContentTypes: ['image/', 'video/'],
      errorLabel: 'asset'
    })
    return {
      buffer: download.buffer,
      fileName: ensureFileExtension(
        requestedFileName || getDownloadFileNameFromUrl(download.finalUrl.toString()),
        req.mimeType || download.contentType
      ),
      sourceKind: 'http-download'
    }
  }

  throw new Error(`Unsupported asset source for Adobe bridge export: ${sourceUrl}`)
}

export class AdobeBridgeSvcImpl implements AdobeBridgeSvc {
  async exportAsset(req: ExportAssetToAdobeReq): Promise<ExportAssetToAdobeResp> {
    const targetDir = getConfiguredTargetDir(req.target).trim()
    if (!targetDir) {
      throw new Error(`No ${getTargetLabel(req.target)} handoff folder configured yet.`)
    }

    const resolved = await resolveAssetSource(req)
    const safeFileName = sanitizePathSegment(
      path.basename(resolved.fileName, path.extname(resolved.fileName))
    )
    const finalFileName = `${safeFileName || 'asset'}${path.extname(resolved.fileName) || getExtensionFromMimeType(req.mimeType)}`
    const packageFolderName = buildPackageFolderName(finalFileName)
    const packageDir = path.join(targetDir, MAGICPOT_IMPORTS_DIR, packageFolderName)
    const assetPath = path.join(packageDir, finalFileName)
    const manifestPath = path.join(packageDir, ADOBE_BRIDGE_MANIFEST_FILE_NAME)
    const payloadPath = path.join(packageDir, ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME)
    const recipePath = path.join(packageDir, ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME)
    const instructionsPath = path.join(packageDir, ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME)
    const scriptStubPath = path.join(packageDir, getScriptStubFileName(req.target))
    const targetLabel = getTargetLabel(req.target)

    const manifest: AdobeBridgeManifest = {
      version: 1,
      app: 'MagicPot',
      target: req.target,
      targetLabel,
      createdAt: new Date().toISOString(),
      dispatchMode: 'folder-copy',
      workflow: {
        inputMode: 'image+prompt',
        handoffMode: 'manual-folder-copy',
        manualOnly: true
      },
      source: {
        fileName: resolved.fileName,
        sourceKind: resolved.sourceKind,
        sourceUrl: req.sourceUrl,
        sourceLabel: req.sourceLabel,
        contextSummary: req.sourceContextSummary,
        promptText: req.promptText,
        mimeType: req.mimeType
      },
      taskContext: req.taskContext,
      packageContents: buildPackageContents(req.target, finalFileName),
      asset: {
        fileName: finalFileName,
        relativeAssetPath: finalFileName
      },
      handoff: {
        instructionsFileName: ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME,
        instructionsRelativePath: ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME,
        payloadFileName: ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME,
        payloadRelativePath: ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME,
        recipeFileName: ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME,
        recipeRelativePath: ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME,
        purpose: 'manual-handoff',
        manualOnly: true,
        summary: buildHandoffSummary(req, resolved.fileName, finalFileName, targetLabel)
      },
      bundle: {
        assetFileName: finalFileName,
        manifestFileName: ADOBE_BRIDGE_MANIFEST_FILE_NAME,
        instructionsFileName: ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME,
        payloadFileName: ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME,
        recipeFileName: ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME,
        scriptStubFileName: getScriptStubFileName(req.target)
      },
      importHints: {
        targetDir,
        packageDir,
        manifestFileName: ADOBE_BRIDGE_MANIFEST_FILE_NAME,
        instructionsFileName: ADOBE_BRIDGE_HANDOFF_INSTRUCTIONS_FILE_NAME,
        payloadFileName: ADOBE_BRIDGE_HANDOFF_PAYLOAD_FILE_NAME,
        recipeFileName: ADOBE_BRIDGE_HANDOFF_RECIPE_FILE_NAME,
        scriptStubFileName: getScriptStubFileName(req.target),
        notes: getTargetNotes(req.target)
      }
    }
    const payload = buildInstructionPayload(req, manifest)
    const recipe = buildExecutionRecipe(req, manifest)

    try {
      await fs.mkdir(packageDir, { recursive: true })
      await fs.writeFile(assetPath, resolved.buffer)
      await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2), 'utf8')
      await fs.writeFile(recipePath, JSON.stringify(recipe, null, 2), 'utf8')
      if (recipe.execution.sidecarScriptStub) {
        await fs.writeFile(
          scriptStubPath,
          `${recipe.execution.sidecarScriptStub.lines.join('\n')}\n`,
          'utf8'
        )
      }
      await fs.writeFile(
        instructionsPath,
        buildHandoffInstructions(manifest, payload, recipe),
        'utf8'
      )
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    } catch (error) {
      await fs.rm(packageDir, { recursive: true, force: true })
      throw error
    }

    return {
      target: req.target,
      targetDir,
      packageDir,
      manifestPath,
      instructionsPath,
      payloadPath,
      recipePath,
      assetPath,
      scriptStubPath: recipe.execution.sidecarScriptStub ? scriptStubPath : undefined,
      packageContents: manifest.packageContents
    }
  }
}
