import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME,
  ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME
} from '@shared/api/svcAdobeBridge'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'
import * as config from '../config/config'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import { AdobeBridgeSvcImpl } from './svcAdobeBridgeImpl'

vi.mock(import('../config/config'), () => {
  return {
    getConfig: vi.fn()
  }
})

function mockConfig(v: Partial<Config>): void {
  vi.mocked(config.getConfig).mockReturnValue({
    ...DEFAULT_CONFIG,
    ...v,
    adobe_bridge_config: {
      ...DEFAULT_CONFIG.adobe_bridge_config,
      ...(v.adobe_bridge_config || {})
    }
  } as Config)
}

describe('AdobeBridgeSvcImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-23T04:05:06.789Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('writes a manual-handoff package with manifest and instructions sidecar', async () => {
    const targetDir = path.join(
      await createNodeTestArtifactDir('adobe-bridge-after-effects'),
      'after-effects'
    )
    await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    await fs.mkdir(targetDir, { recursive: true })
    try {
      mockConfig({
        adobe_bridge_config: {
          after_effects_export_dir: targetDir,
          premiere_export_dir: targetDir
        }
      })

      const svc = new AdobeBridgeSvcImpl()
      const resp = await svc.exportAsset({
        target: 'after-effects',
        fileName: 'Hero Shot.png',
        data: new Uint8Array([7, 8, 9]),
        sourceLabel: 'session-17',
        sourceContextSummary: {
          kindLabels: ['Figma 1', 'Imported file 1'],
          detailLines: [
            'Hero headline -> Figma / Headline',
            'hero-card.png -> Imported file / hero-card.png'
          ],
          totalItemCount: 2,
          hiddenDetailCount: 0
        },
        taskContext: {
          sessionId: 'design-session-17',
          contextPackId: 'design-context-17',
          proposalId: 'design-proposal-17',
          approvalId: 'design-approval-17',
          approvalStatus: 'approved',
          executionResultId: 'design-execution-17'
        },
        promptText: 'Add motion blur and keep the composition centered.'
      })

      expect(path.basename(resp.packageDir)).toBe('Hero-Shot-20260323040506')
      expect(path.basename(resp.assetPath)).toBe('Hero-Shot.png')
      expect(path.basename(resp.manifestPath)).toBe('bridge-manifest.json')
      expect(path.basename(resp.instructionsPath)).toBe('handoff-instructions.md')
      expect(path.basename(resp.payloadPath)).toBe('handoff-payload.json')
      expect(path.basename(resp.recipePath)).toBe('handoff-recipe.json')
      expect(path.basename(resp.scriptStubPath || '')).toBe(
        ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
      )
      expect(resp.packageContents).toEqual({
        assetFileName: 'Hero-Shot.png',
        manifestFileName: 'bridge-manifest.json',
        instructionsFileName: 'handoff-instructions.md',
        payloadFileName: 'handoff-payload.json',
        recipeFileName: 'handoff-recipe.json',
        scriptStubFileName: ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
      })

      const assetBytes = await fs.readFile(resp.assetPath)
      expect([...assetBytes]).toEqual([7, 8, 9])

      const manifest = JSON.parse(await fs.readFile(resp.manifestPath, 'utf8')) as {
        target: string
        targetLabel: string
        workflow: {
          inputMode: string
          handoffMode: string
          manualOnly: boolean
        }
        source: {
          fileName: string
          sourceKind: string
          sourceLabel?: string
          contextSummary?: {
            kindLabels: string[]
            detailLines: string[]
            totalItemCount: number
            hiddenDetailCount: number
          }
          promptText?: string
        }
        taskContext?: {
          sessionId: string
          contextPackId?: string
          proposalId?: string
          approvalId?: string
          approvalStatus?: string
          executionResultId?: string
        }
        packageContents: {
          assetFileName: string
          manifestFileName: string
          instructionsFileName: string
          payloadFileName: string
          recipeFileName: string
          scriptStubFileName: string
        }
        asset: { fileName: string; relativeAssetPath: string }
        handoff: {
          instructionsFileName: string
          instructionsRelativePath: string
          payloadFileName: string
          payloadRelativePath: string
          recipeFileName: string
          recipeRelativePath: string
          purpose: string
          manualOnly: boolean
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

      expect(manifest.target).toBe('after-effects')
      expect(manifest.targetLabel).toBe('After Effects')
      expect(manifest.workflow).toEqual({
        inputMode: 'image+prompt',
        handoffMode: 'manual-folder-copy',
        manualOnly: true
      })
      expect(manifest.source.fileName).toBe('Hero Shot.png')
      expect(manifest.source.sourceKind).toBe('uploaded-bytes')
      expect(manifest.source.sourceLabel).toBe('session-17')
      expect(manifest.source.contextSummary).toEqual({
        kindLabels: ['Figma 1', 'Imported file 1'],
        detailLines: [
          'Hero headline -> Figma / Headline',
          'hero-card.png -> Imported file / hero-card.png'
        ],
        totalItemCount: 2,
        hiddenDetailCount: 0
      })
      expect(manifest.taskContext).toEqual({
        sessionId: 'design-session-17',
        contextPackId: 'design-context-17',
        proposalId: 'design-proposal-17',
        approvalId: 'design-approval-17',
        approvalStatus: 'approved',
        executionResultId: 'design-execution-17'
      })
      expect(manifest.source.promptText).toBe('Add motion blur and keep the composition centered.')
      expect(manifest.packageContents).toEqual({
        assetFileName: 'Hero-Shot.png',
        manifestFileName: 'bridge-manifest.json',
        instructionsFileName: 'handoff-instructions.md',
        payloadFileName: 'handoff-payload.json',
        recipeFileName: 'handoff-recipe.json',
        scriptStubFileName: ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
      })
      expect(manifest.asset.fileName).toBe('Hero-Shot.png')
      expect(manifest.asset.relativeAssetPath).toBe('Hero-Shot.png')
      expect(manifest.handoff.instructionsFileName).toBe('handoff-instructions.md')
      expect(manifest.handoff.instructionsRelativePath).toBe('handoff-instructions.md')
      expect(manifest.handoff.payloadFileName).toBe('handoff-payload.json')
      expect(manifest.handoff.payloadRelativePath).toBe('handoff-payload.json')
      expect(manifest.handoff.recipeFileName).toBe('handoff-recipe.json')
      expect(manifest.handoff.recipeRelativePath).toBe('handoff-recipe.json')
      expect(manifest.handoff.purpose).toBe('manual-handoff')
      expect(manifest.handoff.manualOnly).toBe(true)
      expect(manifest.handoff.summary).toEqual(
        expect.arrayContaining([
          'Target: After Effects',
          'Workflow: image + prompt manual handoff',
          'Source file: Hero Shot.png',
          'Asset file: Hero-Shot.png',
          'This package is a manual handoff only. It does not execute scripts automatically.',
          'A structured execution recipe is included for future automation planning.',
          'Source label: session-17',
          'Source context: Figma 1, Imported file 1',
          'Task context: session design-session-17, approval approved',
          'Prompt: Add motion blur and keep the composition centered.'
        ])
      )
      expect(manifest.bundle).toEqual({
        assetFileName: 'Hero-Shot.png',
        manifestFileName: 'bridge-manifest.json',
        instructionsFileName: 'handoff-instructions.md',
        payloadFileName: 'handoff-payload.json',
        recipeFileName: 'handoff-recipe.json',
        scriptStubFileName: ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
      })
      expect(manifest.importHints.targetDir).toBe(targetDir)
      expect(manifest.importHints.packageDir).toBe(resp.packageDir)
      expect(manifest.importHints.manifestFileName).toBe('bridge-manifest.json')
      expect(manifest.importHints.instructionsFileName).toBe('handoff-instructions.md')
      expect(manifest.importHints.payloadFileName).toBe('handoff-payload.json')
      expect(manifest.importHints.recipeFileName).toBe('handoff-recipe.json')
      expect(manifest.importHints.scriptStubFileName).toBe(
        ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
      )
      expect(manifest.importHints.notes).toEqual([
        'Point this at an After Effects import inbox or a synced watch folder.',
        'Use the manifest, payload, recipe, and starter script stub as the source of truth for manual import steps.',
        'Import the copied asset into the active project if your automation does not watch this folder.'
      ])

      const payload = JSON.parse(await fs.readFile(resp.payloadPath, 'utf8')) as {
        version: number
        target: string
        targetLabel: string
        manualOnly: boolean
        workbookRequirement: string
        source: {
          fileName: string
          sourceKind: string
          sourceLabel?: string
          contextSummary?: {
            kindLabels: string[]
            detailLines: string[]
            totalItemCount: number
            hiddenDetailCount: number
          }
          promptText?: string
        }
        taskContext?: {
          sessionId: string
          contextPackId?: string
          proposalId?: string
          approvalId?: string
          approvalStatus?: string
          executionResultId?: string
        }
        packageContents: {
          assetFileName: string
          manifestFileName: string
          instructionsFileName: string
          payloadFileName: string
          recipeFileName: string
          scriptStubFileName: string
        }
        asset: { fileName: string; relativeAssetPath: string }
        handoff: {
          purpose: string
          instructionsFileName: string
          instructionsRelativePath: string
          payloadFileName: string
          payloadRelativePath: string
          recipeFileName: string
          recipeRelativePath: string
          steps: string[]
          targetNotes: string[]
        }
        reviewChecklist: string[]
      }

      expect(payload).toMatchObject({
        version: 1,
        target: 'after-effects',
        targetLabel: 'After Effects',
        manualOnly: true,
        workbookRequirement: 'image+prompt-to-target',
        source: {
          fileName: 'Hero Shot.png',
          sourceKind: 'uploaded-bytes',
          sourceLabel: 'session-17',
          contextSummary: {
            kindLabels: ['Figma 1', 'Imported file 1'],
            detailLines: [
              'Hero headline -> Figma / Headline',
              'hero-card.png -> Imported file / hero-card.png'
            ],
            totalItemCount: 2,
            hiddenDetailCount: 0
          },
          promptText: 'Add motion blur and keep the composition centered.'
        },
        taskContext: {
          sessionId: 'design-session-17',
          contextPackId: 'design-context-17',
          proposalId: 'design-proposal-17',
          approvalId: 'design-approval-17',
          approvalStatus: 'approved',
          executionResultId: 'design-execution-17'
        },
        packageContents: {
          assetFileName: 'Hero-Shot.png',
          manifestFileName: 'bridge-manifest.json',
          instructionsFileName: 'handoff-instructions.md',
          payloadFileName: 'handoff-payload.json',
          recipeFileName: 'handoff-recipe.json',
          scriptStubFileName: ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
        },
        asset: {
          fileName: 'Hero-Shot.png',
          relativeAssetPath: 'Hero-Shot.png'
        }
      })
      expect(payload.handoff).toMatchObject({
        purpose: 'manual-handoff',
        instructionsFileName: 'handoff-instructions.md',
        instructionsRelativePath: 'handoff-instructions.md',
        payloadFileName: 'handoff-payload.json',
        payloadRelativePath: 'handoff-payload.json',
        recipeFileName: 'handoff-recipe.json',
        recipeRelativePath: 'handoff-recipe.json'
      })
      expect(payload.handoff.steps).toEqual(
        expect.arrayContaining([
          'Copy the entire Hero-Shot-20260323040506 folder into the chosen Adobe inbox.',
          'Open the manifest, recipe, and instruction payload to recover the original image, prompt, target context, and package contents.',
          'Manually import the copied asset into After Effects or Premiere Pro.',
          'Treat the prompt text as creative direction, not an executable script.'
        ])
      )
      expect(payload.handoff.targetNotes).toEqual(manifest.importHints.notes)
      expect(payload.reviewChecklist).toEqual(
        expect.arrayContaining([
          'Target-specific inbox path is configured.',
          'Asset file exists beside the manifest, recipe, and instruction payload.',
          'Source label, source context, prompt text, and task context are preserved when provided.',
          'Manual-only wording is present in the sidecar instructions.'
        ])
      )

      const recipe = JSON.parse(await fs.readFile(resp.recipePath, 'utf8')) as {
        version: number
        target: string
        targetLabel: string
        manualOnly: boolean
        automationStatus: string
        source: {
          fileName: string
          sourceKind: string
          sourceLabel?: string
          contextSummary?: {
            kindLabels: string[]
            detailLines: string[]
            totalItemCount: number
            hiddenDetailCount: number
          }
          promptText?: string
        }
        taskContext?: {
          sessionId: string
          contextPackId?: string
          proposalId?: string
          approvalId?: string
          approvalStatus?: string
          executionResultId?: string
        }
        packageContents: {
          assetFileName: string
          manifestFileName: string
          instructionsFileName: string
          payloadFileName: string
          recipeFileName: string
          scriptStubFileName: string
        }
        asset: { fileName: string; relativeAssetPath: string }
        bundle: {
          assetFileName: string
          manifestFileName: string
          instructionsFileName: string
          payloadFileName: string
          recipeFileName: string
          scriptStubFileName?: string
        }
        execution: {
          host: string
          hostKind: string
          intent: string
          steps: string[]
          notes: string[]
          sidecarScriptStub?: { fileName: string; lines: string[] }
        }
        reviewChecklist: string[]
        limitations: string[]
      }

      expect(recipe).toMatchObject({
        version: 1,
        target: 'after-effects',
        targetLabel: 'After Effects',
        manualOnly: true,
        automationStatus: 'manual-sidecar',
        source: {
          fileName: 'Hero Shot.png',
          sourceKind: 'uploaded-bytes',
          sourceLabel: 'session-17',
          contextSummary: {
            kindLabels: ['Figma 1', 'Imported file 1'],
            detailLines: [
              'Hero headline -> Figma / Headline',
              'hero-card.png -> Imported file / hero-card.png'
            ],
            totalItemCount: 2,
            hiddenDetailCount: 0
          },
          promptText: 'Add motion blur and keep the composition centered.'
        },
        taskContext: {
          sessionId: 'design-session-17',
          contextPackId: 'design-context-17',
          proposalId: 'design-proposal-17',
          approvalId: 'design-approval-17',
          approvalStatus: 'approved',
          executionResultId: 'design-execution-17'
        },
        packageContents: {
          assetFileName: 'Hero-Shot.png',
          manifestFileName: 'bridge-manifest.json',
          instructionsFileName: 'handoff-instructions.md',
          payloadFileName: 'handoff-payload.json',
          recipeFileName: 'handoff-recipe.json',
          scriptStubFileName: ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
        },
        asset: {
          fileName: 'Hero-Shot.png',
          relativeAssetPath: 'Hero-Shot.png'
        },
        bundle: {
          assetFileName: 'Hero-Shot.png',
          manifestFileName: 'bridge-manifest.json',
          instructionsFileName: 'handoff-instructions.md',
          payloadFileName: 'handoff-payload.json',
          recipeFileName: 'handoff-recipe.json',
          scriptStubFileName: ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
        }
      })
      expect(recipe.execution).toMatchObject({
        host: 'After Effects',
        hostKind: 'after-effects',
        intent: 'after-effects-first',
        notes: manifest.importHints.notes
      })
      expect(recipe.execution.steps).toEqual(
        expect.arrayContaining([
          'Copy the full Hero-Shot-20260323040506 folder into the configured Adobe inbox.',
          'Open the structured recipe first so the target, source, and package paths stay in sync.',
          'Use the manifest, payload, and recipe as the canonical metadata source.',
          'In After Effects, import the copied asset into the active project or your own script runner.'
        ])
      )
      expect(recipe.execution.sidecarScriptStub).toMatchObject({
        fileName: ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME
      })
      expect(recipe.execution.sidecarScriptStub?.lines).toEqual(
        expect.arrayContaining([
          '// MagicPot After Effects handoff starter stub',
          '// Manual-only: MagicPot writes this starter file, but it does not execute Adobe automation.',
          '// Package folder: Hero-Shot-20260323040506',
          '// Asset file: Hero-Shot.png',
          '// TODO: import the copied asset into the active project.',
          '// TODO: place it into the comp or timeline that matches the prompt.'
        ])
      )

      const scriptStub = await fs.readFile(resp.scriptStubPath!, 'utf8')
      expect(scriptStub).toContain('// MagicPot After Effects handoff starter stub')
      expect(scriptStub).toContain('// Package folder: Hero-Shot-20260323040506')
      expect(scriptStub).toContain('// Asset file: Hero-Shot.png')
      expect(scriptStub).toContain('// TODO: import the copied asset into the active project.')

      expect(recipe.reviewChecklist).toEqual(
        expect.arrayContaining([
          'Target-specific inbox path is configured.',
          'Asset file exists beside the manifest, recipe, and instruction payload.',
          'Source label, source context, prompt text, and task context are preserved when provided.',
          'Manual-only wording is present in the sidecar instructions.'
        ])
      )
      expect(recipe.limitations).toEqual(
        expect.arrayContaining([
          'MagicPot writes the package and recipe files, but it does not launch Adobe apps.',
          'This is a structured handoff recipe, not a native Adobe automation bridge.',
          'Any actual import or script execution still happens manually outside MagicPot.'
        ])
      )

      const instructions = await fs.readFile(resp.instructionsPath, 'utf8')
      expect(instructions).toContain('# MagicPot After Effects Handoff')
      expect(instructions).toContain(
        'This package is a manual handoff artifact. MagicPot does not execute the target application for you.'
      )
      expect(instructions).toContain('Asset file: `Hero-Shot.png`')
      expect(instructions).toContain('Manifest: `bridge-manifest.json`')
      expect(instructions).toContain('Instruction payload: `handoff-payload.json`')
      expect(instructions).toContain('Execution recipe: `handoff-recipe.json`')
      expect(instructions).toContain('Instructions: `handoff-instructions.md`')
      expect(instructions).toContain(
        'Package contents are recorded in the manifest and mirrored in the payload and recipe.'
      )
      expect(instructions).toContain('Copy or sync the entire `Hero-Shot-20260323040506` folder')
      expect(instructions).toContain(
        'Open the execution recipe first to confirm the target, source, and package paths.'
      )
      expect(instructions).toContain('Workbook requirement: `image+prompt-to-target`')
      expect(instructions).toContain('Manual-only: `true`')
      expect(instructions).toContain('Dispatch mode: `folder-copy`')
      expect(instructions).toContain('## Source Context')
      expect(instructions).toContain('Summary: Figma 1, Imported file 1')
      expect(instructions).toContain('Hero headline -> Figma / Headline')
      expect(instructions).toContain('hero-card.png -> Imported file / hero-card.png')
      expect(instructions).toContain('## Task Context')
      expect(instructions).toContain('Session: design-session-17')
      expect(instructions).toContain('Approval status: approved')
      expect(instructions).toContain('## Generated Execution Recipe')
      expect(instructions).toContain('Recipe file: `handoff-recipe.json`')
      expect(instructions).toContain('Recipe mode: `manual-sidecar`')
      expect(instructions).toContain('Intent: `after-effects-first`')
      expect(instructions).toContain(
        `Starter script stub: \`${ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME}\``
      )
      expect(instructions).toContain('## Generated Handoff Steps')
      expect(instructions).toContain(
        'Open the manifest, recipe, and instruction payload to recover the original image, prompt, target context, and package contents.'
      )
      expect(instructions).toContain(
        `Review \`${ADOBE_BRIDGE_AFTER_EFFECTS_STUB_FILE_NAME}\` as the generated starter script`
      )
      expect(instructions).toContain('Source label: session-17')
      expect(instructions).toContain('Add motion blur and keep the composition centered.')
      expect(instructions).toContain('## Recipe Limitations')
      expect(instructions).toContain(
        'This is a structured handoff recipe, not a native Adobe automation bridge.'
      )
      expect(instructions).toContain('## Review Checklist')
      expect(instructions).toContain('Manual-only wording is present in the sidecar instructions.')
    } finally {
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    }
  })

  it('writes a Premiere Pro sidecar stub so the handoff is executable on both targets', async () => {
    const targetDir = path.join(
      await createNodeTestArtifactDir('adobe-bridge-premiere'),
      'premiere'
    )
    await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    await fs.mkdir(targetDir, { recursive: true })
    try {
      mockConfig({
        adobe_bridge_config: {
          after_effects_export_dir: targetDir,
          premiere_export_dir: targetDir
        }
      })

      const svc = new AdobeBridgeSvcImpl()
      const resp = await svc.exportAsset({
        target: 'premiere',
        fileName: 'Cutaway Shot.jpg',
        data: new Uint8Array([1, 2, 3]),
        sourceLabel: 'session-21',
        promptText: 'Trim to the beat and keep the cutaway readable.'
      })

      expect(path.basename(resp.scriptStubPath || '')).toBe(ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME)
      expect(resp.packageContents).toEqual({
        assetFileName: 'Cutaway-Shot.jpg',
        manifestFileName: 'bridge-manifest.json',
        instructionsFileName: 'handoff-instructions.md',
        payloadFileName: 'handoff-payload.json',
        recipeFileName: 'handoff-recipe.json',
        scriptStubFileName: ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME
      })

      const recipe = JSON.parse(await fs.readFile(resp.recipePath, 'utf8')) as {
        bundle: { scriptStubFileName?: string }
        packageContents: {
          assetFileName: string
          manifestFileName: string
          instructionsFileName: string
          payloadFileName: string
          recipeFileName: string
          scriptStubFileName: string
        }
        execution: { sidecarScriptStub?: { fileName: string; lines: string[] } }
      }

      expect(recipe.bundle.scriptStubFileName).toBe(ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME)
      expect(recipe.packageContents).toEqual({
        assetFileName: 'Cutaway-Shot.jpg',
        manifestFileName: 'bridge-manifest.json',
        instructionsFileName: 'handoff-instructions.md',
        payloadFileName: 'handoff-payload.json',
        recipeFileName: 'handoff-recipe.json',
        scriptStubFileName: ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME
      })
      expect(recipe.execution.sidecarScriptStub).toMatchObject({
        fileName: ADOBE_BRIDGE_PREMIERE_STUB_FILE_NAME
      })
      expect(recipe.execution.sidecarScriptStub?.lines).toEqual(
        expect.arrayContaining([
          '// MagicPot Premiere Pro handoff starter stub',
          '// Manual-only: MagicPot writes this starter file, but it does not execute Adobe automation.',
          '// TODO: import the copied asset into the active project.',
          '// TODO: place it into the sequence or project bin that matches the prompt.'
        ])
      )

      const scriptStub = await fs.readFile(resp.scriptStubPath!, 'utf8')
      expect(scriptStub).toContain('// MagicPot Premiere Pro handoff starter stub')
      expect(scriptStub).toContain(
        '// TODO: place it into the sequence or project bin that matches the prompt.'
      )
    } finally {
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    }
  })

  it('cleans up the package directory if writing the sidecar fails', async () => {
    const targetDir = path.join(
      await createNodeTestArtifactDir('adobe-bridge-cleanup'),
      'after-effects'
    )
    await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    await fs.mkdir(targetDir, { recursive: true })
    try {
      mockConfig({
        adobe_bridge_config: {
          after_effects_export_dir: targetDir,
          premiere_export_dir: targetDir
        }
      })

      const writeFileSpy = vi.spyOn(fs, 'writeFile')
      let callCount = 0
      writeFileSpy.mockImplementation(async () => {
        callCount += 1
        if (callCount === 2) {
          throw new Error('boom')
        }
      })

      const svc = new AdobeBridgeSvcImpl()
      await expect(
        svc.exportAsset({
          target: 'after-effects',
          fileName: 'Hero Shot.png',
          data: new Uint8Array([7, 8, 9])
        })
      ).rejects.toThrow('boom')

      const packageDir = path.join(targetDir, 'MagicPotImports', 'Hero-Shot-20260323040506')
      await expect(fs.stat(packageDir)).rejects.toThrow()
    } finally {
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true })
    }
  })
})
