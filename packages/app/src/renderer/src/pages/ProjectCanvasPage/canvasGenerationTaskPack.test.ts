import { describe, expect, it } from 'vitest'

import type { CanvasItem } from './types'
import {
  buildCanvasGenerationTaskPack,
  buildCanvasGenerationTaskPackPrompt
} from './canvasGenerationTaskPack'

function createItem<T extends CanvasItem>(item: T): T {
  return item
}

describe('canvasGenerationTaskPack', () => {
  it('classifies task-pack materials for generation', () => {
    const items: CanvasItem[] = [
      createItem({
        id: 'file-1',
        type: 'file',
        fileName: 'brief.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileKind: 'word',
        previewText: 'Create a cyberpunk hero poster.',
        content: 'Create a cyberpunk hero poster with dense neon atmosphere.',
        src: 'file:///brief.docx',
        x: 0,
        y: 0,
        width: 200,
        height: 120,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 0,
        locked: false
      }),
      createItem({
        id: 'image-style',
        type: 'image',
        fileName: 'style-reference-neon.png',
        src: 'file:///style.png',
        x: 0,
        y: 0,
        width: 160,
        height: 160,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 1,
        locked: false
      }),
      createItem({
        id: 'note-1',
        type: 'text',
        text: 'note: make the mood hotter and more aggressive',
        fontSize: 18,
        fontFamily: 'sans-serif',
        fill: '#fff',
        x: 0,
        y: 0,
        width: 240,
        height: 40,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 2,
        locked: false
      }),
      createItem({
        id: 'asset-1',
        type: 'image',
        fileName: 'previous-candidate.png',
        src: 'file:///prev.png',
        promptId: 'prompt-123',
        x: 0,
        y: 0,
        width: 160,
        height: 160,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 3,
        locked: false
      })
    ]

    const taskPack = buildCanvasGenerationTaskPack({
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      items
    })

    expect(taskPack.summary).toEqual({
      totalItems: 4,
      requirementDocs: 1,
      referenceDocs: 0,
      referenceImages: 0,
      styleReferenceImages: 1,
      taskNotes: 1,
      existingAssets: 1
    })
    expect(taskPack.requirementDocs[0]).toEqual(
      expect.objectContaining({
        title: 'brief.docx',
        contentText: 'Create a cyberpunk hero poster with dense neon atmosphere.'
      })
    )
    expect(taskPack.styleReferenceImages[0]?.title).toBe('style-reference-neon.png')
    expect(taskPack.taskNotes[0]?.excerpt).toContain('note:')
    expect(taskPack.existingAssets[0]).toEqual(
      expect.objectContaining({
        title: 'previous-candidate.png',
        assetType: 'image'
      })
    )
  })

  it('keeps the prompt focused on generation context instead of controller chatter', () => {
    const taskPack = buildCanvasGenerationTaskPack({
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      items: [
        createItem({
          id: 'file-1',
          type: 'file',
          fileName: 'brief.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileKind: 'word',
          previewText: 'short preview',
          content: 'Need a ragged male character throwing a Molotov cocktail.',
          src: 'file:///brief.docx',
          x: 0,
          y: 0,
          width: 200,
          height: 120,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 0,
          locked: false
        }),
        createItem({
          id: 'image-1',
          type: 'image',
          fileName: 'reference-a.png',
          src: 'file:///reference-a.png',
          x: 0,
          y: 0,
          width: 160,
          height: 160,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 1,
          locked: false
        }),
        createItem({
          id: 'note-1',
          type: 'text',
          text: 'note: keep the character between violent and street-performer energy',
          fontSize: 18,
          fontFamily: 'sans-serif',
          fill: '#fff',
          x: 0,
          y: 0,
          width: 240,
          height: 40,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 2,
          locked: false
        })
      ]
    })

    const modelPrompt = buildCanvasGenerationTaskPackPrompt(taskPack, {
      type: 'project-style-model',
      modelId: 'model-a',
      modelLabel: 'Project Hero Model'
    })
    const defaultAgentPrompt = buildCanvasGenerationTaskPackPrompt(taskPack, {
      type: 'default-agent'
    })

    expect(modelPrompt).toContain('Project Hero Model')
    expect(modelPrompt).toContain('Need a ragged male character throwing a Molotov cocktail.')
    expect(modelPrompt).toContain(
      'note: keep the character between violent and street-performer energy'
    )
    expect(modelPrompt).not.toContain('default-agent')
    expect(modelPrompt).not.toContain('do not auto-pick')
    expect(defaultAgentPrompt).not.toContain('default-agent')
  })

  it('uses extracted file content like an opened canvas document', () => {
    const taskPack = buildCanvasGenerationTaskPack({
      projectId: 'canvas-1',
      projectName: 'MagicPot Demo',
      items: [
        createItem({
          id: 'docx-1',
          type: 'file',
          fileName: 'brief.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileKind: 'word',
          previewText: 'short card preview',
          content:
            'Opened DOCX content: hero brief, silhouette direction, costume notes, and client constraints.',
          src: 'file:///brief.docx',
          x: 0,
          y: 0,
          width: 200,
          height: 120,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 0,
          locked: false
        }),
        createItem({
          id: 'xlsx-1',
          type: 'file',
          fileName: 'references.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileKind: 'excel',
          previewText: 'table snippet',
          content:
            'Opened XLSX content: material sheet, color palette, proportions, and shot references.',
          src: 'file:///references.xlsx',
          x: 0,
          y: 0,
          width: 200,
          height: 120,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 0,
          locked: false
        })
      ]
    })

    const prompt = buildCanvasGenerationTaskPackPrompt(taskPack, {
      type: 'default-agent'
    })

    expect(prompt).toContain(
      'Opened DOCX content: hero brief, silhouette direction, costume notes, and client constraints.'
    )
    expect(prompt).toContain(
      'Opened XLSX content: material sheet, color palette, proportions, and shot references.'
    )
    expect(prompt).not.toContain('- brief.docx: short card preview')
    expect(prompt).not.toContain('- references.xlsx: table snippet')
  })
})
