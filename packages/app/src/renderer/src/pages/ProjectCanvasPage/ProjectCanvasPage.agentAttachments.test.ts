import { describe, expect, it } from 'vitest'
import {
  buildCanvasAgentAttachmentManifest,
  buildCanvasAgentAttachments,
  buildCanvasAgentGroupCompletionPrompt,
  buildCanvasFileAttachment,
  buildCanvasFileContentUpdate,
  buildCanvasLayoutRequestMessages,
  expandCanvasItemsForAgentSend
} from './canvasAgentAttachmentUtils'
import { GROUP_CHIP_SEND_ACTION_ENABLED } from './canvasFeatureFlags'
import type {
  CanvasAnnotationItem,
  CanvasFileItem,
  CanvasGroup,
  CanvasImageItem,
  CanvasItem,
  CanvasModel3DItem,
  CanvasVideoItem
} from './types'

function createFileItem(overrides: Partial<CanvasFileItem> = {}): CanvasFileItem {
  return {
    id: 'file-1',
    type: 'file',
    src: 'file:///C:/magicpot/notes.md',
    fileName: 'notes.md',
    mimeType: 'text/markdown',
    fileKind: 'markdown',
    x: 24,
    y: 32,
    width: 320,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    editable: true,
    sizeBytes: 1234,
    ...overrides
  }
}

function createImageItem(overrides: Partial<CanvasImageItem> = {}): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'file:///C:/magicpot/lv1.png',
    fileName: 'lv1.png',
    sizeBytes: 2048,
    sourceWidth: 1536,
    sourceHeight: 1024,
    x: 24,
    y: 32,
    width: 160,
    height: 160,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createVideoItem(overrides: Partial<CanvasVideoItem> = {}): CanvasVideoItem {
  return {
    id: 'video-1',
    type: 'video',
    src: 'file:///C:/magicpot/clip.mp4',
    fileName: 'clip.mp4',
    playing: false,
    muted: false,
    volume: 1,
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createModelItem(overrides: Partial<CanvasModel3DItem> = {}): CanvasModel3DItem {
  return {
    id: 'model-1',
    type: 'model3d',
    src: 'file:///C:/magicpot/model.glb',
    fileName: 'model.glb',
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 0,
    locked: false,
    ...overrides
  }
}

function createAnnotationItem(
  overrides: Partial<CanvasAnnotationItem> & {
    attachedToId?: string
    attachmentPlacement?: 'bottom-center'
  } = {}
): CanvasAnnotationItem {
  return {
    id: 'annotation-1',
    type: 'annotation',
    shape: 'text-anno',
    stroke: '#ffffff',
    fillOpacity: 0,
    strokeWidth: 1,
    label: '',
    text: 'fill this gap',
    fontSize: 24,
    x: 0,
    y: 0,
    width: 120,
    height: 32,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    ...overrides
  } as CanvasAnnotationItem
}

describe('canvas agent attachments', () => {
  it('builds a normalized file attachment for file nodes', () => {
    const attachment = buildCanvasFileAttachment(
      createFileItem({
        reportBundleId: 'bundle-1',
        reportBundleRole: 'primary-report',
        reportBundleRefName: 'canvas-target-report.md',
        reportBundleManifestUrl: 'local-media:///C:/magicpot/.report_bundles/bundle-1/manifest.json'
      })
    )

    expect(attachment).toEqual({
      type: 'file',
      url: 'local-media:///C:/magicpot/notes.md',
      mimeType: 'text/markdown',
      fileName: 'notes.md',
      sizeBytes: 1234,
      reportBundleId: 'bundle-1',
      reportBundleRole: 'primary-report',
      reportBundleRefName: 'canvas-target-report.md',
      reportBundleManifestUrl: 'local-media:///C:/magicpot/.report_bundles/bundle-1/manifest.json'
    })
  })

  it('normalizes office and markdown mime types when building file attachments', () => {
    expect(
      buildCanvasFileAttachment(
        createFileItem({
          fileName: 'brief.docx',
          mimeType: 'application/octet-stream',
          fileKind: 'word'
        })
      )
    ).toEqual(
      expect.objectContaining({
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        fileName: 'brief.docx'
      })
    )

    expect(
      buildCanvasFileAttachment(
        createFileItem({
          fileName: 'budget.xlsx',
          mimeType: 'application/octet-stream',
          fileKind: 'excel'
        })
      )
    ).toEqual(
      expect.objectContaining({
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileName: 'budget.xlsx'
      })
    )

    expect(
      buildCanvasFileAttachment(
        createFileItem({
          fileName: 'slides.pptx',
          mimeType: '',
          fileKind: 'powerpoint'
        })
      )
    ).toEqual(
      expect.objectContaining({
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        fileName: 'slides.pptx'
      })
    )

    expect(
      buildCanvasFileAttachment(
        createFileItem({
          fileName: 'draft.md',
          mimeType: 'application/octet-stream',
          fileKind: 'markdown'
        })
      )
    ).toEqual(
      expect.objectContaining({
        mimeType: 'text/markdown',
        fileName: 'draft.md'
      })
    )
  })

  it('keeps image, file, video, and model nodes in the attachment list', () => {
    const items: CanvasItem[] = [
      createImageItem(),
      createFileItem(),
      createVideoItem(),
      createModelItem()
    ]

    expect(buildCanvasAgentAttachments(items)).toEqual([
      {
        type: 'image',
        url: 'local-media:///C:/magicpot/lv1.png',
        mimeType: 'image/png',
        fileName: 'lv1.png',
        sizeBytes: 2048,
        sourceWidth: 1536,
        sourceHeight: 1024
      },
      {
        type: 'file',
        url: 'local-media:///C:/magicpot/notes.md',
        mimeType: 'text/markdown',
        fileName: 'notes.md',
        sizeBytes: 1234
      },
      {
        type: 'video',
        url: 'local-media:///C:/magicpot/clip.mp4',
        fileName: 'clip.mp4',
        mimeType: 'video/mp4'
      },
      {
        type: 'model3d',
        url: 'local-media:///C:/magicpot/model.glb',
        fileName: 'model.glb',
        mimeType: 'model/gltf-binary'
      }
    ])
  })

  it('builds a manifest keyed by file name and canvas item id', () => {
    const lv3 = createImageItem({ id: 'lv3', fileName: 'lv3.png', x: 220 })
    const caption = createAnnotationItem({
      id: 'caption-lv3',
      text: 'missing LV2 between LV1 and LV3',
      attachedToId: 'lv3',
      attachmentPlacement: 'bottom-center'
    })

    const manifest = buildCanvasAgentAttachmentManifest([
      createImageItem(),
      lv3,
      caption,
      createFileItem()
    ])

    expect(manifest).toContain('Canvas asset manifest:')
    expect(manifest).toContain('type=image; order=1; fileName="lv1.png"; canvasItemId="image-1"')
    expect(manifest).toContain('type=image; order=2; fileName="lv3.png"; canvasItemId="lv3"')
    expect(manifest).toContain('attachedCaption="missing LV2 between LV1 and LV3"')
    expect(manifest).toContain('type=file; order=1; fileName="notes.md"; canvasItemId="file-1"')
    expect(manifest).toContain('Key by fileName first; if it is missing or duplicated')
  })

  it('builds editable file-node updates with normalized markdown content', () => {
    const update = buildCanvasFileContentUpdate(
      createFileItem({
        fileName: 'draft.md',
        mimeType: 'application/octet-stream'
      }),
      'line 1\r\nline 2',
      'blob:edited-file'
    )

    expect(update).toEqual({
      src: 'blob:edited-file',
      mimeType: 'text/markdown',
      content: 'line 1\nline 2',
      previewText: 'line 1\nline 2',
      sizeBytes: new Blob(['line 1\nline 2'], { type: 'text/markdown' }).size,
      editable: true
    })
  })

  it('builds attachment-bearing layout prompts for canvas AI requests', () => {
    const messages = buildCanvasLayoutRequestMessages(
      [createImageItem(), createFileItem(), createVideoItem(), createModelItem()],
      'Arrange these items.'
    )

    expect(messages).toEqual([
      {
        role: 'user',
        content: 'Arrange these items.',
        attachments: [
          {
            type: 'image',
            url: 'local-media:///C:/magicpot/lv1.png',
            mimeType: 'image/png',
            fileName: 'lv1.png',
            sizeBytes: 2048,
            sourceWidth: 1536,
            sourceHeight: 1024
          },
          {
            type: 'file',
            url: 'local-media:///C:/magicpot/notes.md',
            mimeType: 'text/markdown',
            fileName: 'notes.md',
            sizeBytes: 1234
          },
          {
            type: 'video',
            url: 'local-media:///C:/magicpot/clip.mp4',
            fileName: 'clip.mp4',
            mimeType: 'video/mp4'
          },
          {
            type: 'model3d',
            url: 'local-media:///C:/magicpot/model.glb',
            fileName: 'model.glb',
            mimeType: 'model/gltf-binary'
          }
        ]
      }
    ])
  })

  it('keeps the floating group-chip chat button enabled', () => {
    expect(GROUP_CHIP_SEND_ACTION_ENABLED).toBe(true)
  })

  it('expands agent-send selections with attached media captions', () => {
    const lv1 = createImageItem({ id: 'lv1' })
    const lv3 = createImageItem({ id: 'lv3', x: 220, fileName: 'lv3.png' })
    const caption = createAnnotationItem({
      id: 'caption-lv3',
      text: 'missing LV2',
      attachedToId: 'lv3',
      attachmentPlacement: 'bottom-center'
    })
    const unrelated = createAnnotationItem({
      id: 'caption-other',
      text: 'ignore me',
      attachedToId: 'other',
      attachmentPlacement: 'bottom-center'
    })

    expect(expandCanvasItemsForAgentSend([lv1, lv3], [lv1, lv3, caption, unrelated])).toEqual([
      lv1,
      lv3,
      caption
    ])
  })

  it('builds a completion-focused prompt for annotated groups', () => {
    const lv1 = createImageItem({ id: 'lv1', fileName: 'lv1.png' })
    const lv3 = createImageItem({ id: 'lv3', x: 220, fileName: 'lv3.png' })
    const caption = createAnnotationItem({
      id: 'caption-lv3',
      text: 'missing LV2',
      attachedToId: 'lv3',
      attachmentPlacement: 'bottom-center'
    })
    const groups: CanvasGroup[] = [
      {
        id: 'group-level-icons',
        name: 'level icons',
        itemIds: ['lv1', 'lv3'],
        createdAt: '2026-03-23T00:00:00.000Z'
      }
    ]

    const prompt = buildCanvasAgentGroupCompletionPrompt([lv1, lv3], [lv1, lv3, caption], groups)

    expect(prompt).toContain('canvas group "level icons"')
    expect(prompt).toContain('attached captions, labels, and annotations')
    expect(prompt).toContain('LV2')
  })

  it('returns an empty completion prompt for plain image-only groups', () => {
    const lv1 = createImageItem({ id: 'lv1', fileName: 'lv1.png' })
    const lv2 = createImageItem({ id: 'lv2', fileName: 'lv2.png', x: 200 })
    const groups: CanvasGroup[] = [
      {
        id: 'group-level-icons',
        name: 'level icons',
        itemIds: ['lv1', 'lv2'],
        createdAt: '2026-03-23T00:00:00.000Z'
      }
    ]

    expect(buildCanvasAgentGroupCompletionPrompt([lv1, lv2], [lv1, lv2], groups)).toBe('')
  })

  it('returns an empty completion prompt for plain non-group selections', () => {
    const image = createImageItem({ id: 'solo-image' })

    expect(buildCanvasAgentGroupCompletionPrompt([image], [image], [])).toBe('')
  })
})
