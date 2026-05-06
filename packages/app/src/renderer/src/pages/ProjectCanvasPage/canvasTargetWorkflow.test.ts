import { describe, expect, it, vi } from 'vitest'

import {
  applyCanvasTargetEvidenceModeToControlPlan,
  buildCanvasTargetAttachments,
  buildCanvasTargetAssetMetadata,
  buildCanvasTargetContextPack,
  buildCanvasTargetSchemeImageAttachments,
  buildCanvasTargetSourceAttachments,
  requestCanvasTargetAcceptanceFixActions,
  resolveCanvasTargetEvidenceAttachments,
  shouldAttachCanvasTargetSelectionSnapshot,
  requestCanvasTargetControlPlan,
  requestCanvasTargetSummaryExecution,
  requestCanvasTargetStageExecution
} from './canvasTargetWorkflow'
import { resolveCanvasTargetAcceptanceStatus } from './useCanvasTargetWorkflow'
import { CANVAS_TARGET_CANVAS_ACTIONS } from './canvasTargetCapabilities'
import type { CanvasImageItem, CanvasModel3DItem, CanvasTextItem, CanvasVideoItem } from './types'
import type { TargetScheme } from '@shared/targetScheme'

function createImageItem(): CanvasImageItem {
  return {
    id: 'image-1',
    type: 'image',
    src: 'data:image/png;base64,AAAA',
    fileName: 'hero-albedo.png',
    sizeBytes: 4096,
    hasAlpha: true,
    sourceWidth: 2048,
    sourceHeight: 1024,
    crop: { x: 12, y: 24, width: 1024, height: 768 },
    promptId: 'prompt-image-1',
    x: 10,
    y: 20,
    width: 512,
    height: 256,
    rotation: 15,
    scaleX: 1,
    scaleY: 1,
    zIndex: 1,
    locked: false,
    provenance: {
      kind: 'external',
      sourceFileName: 'scene-source.psd'
    }
  }
}

function createVideoItem(): CanvasVideoItem {
  return {
    id: 'video-1',
    type: 'video',
    src: 'blob:video-1',
    fileName: 'shot.mp4',
    promptId: 'prompt-video-1',
    playing: false,
    muted: true,
    volume: 0.35,
    x: 40,
    y: 60,
    width: 960,
    height: 540,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 2,
    locked: false
  }
}

function createModelItem(): CanvasModel3DItem {
  return {
    id: 'model-1',
    type: 'model3d',
    src: 'blob:model-1',
    fileName: 'character.glb',
    textures: {
      'albedo.png': 'blob:texture-1',
      'normal.png': 'blob:texture-2'
    },
    x: 80,
    y: 100,
    width: 320,
    height: 320,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 3,
    locked: true
  }
}

function createTextItem(
  text = 'A neon fox courier with reflective jacket under rainy city lights.'
): CanvasTextItem {
  return {
    id: 'text-1',
    type: 'text',
    text,
    fontSize: 28,
    fontFamily: 'system-ui',
    fill: '#ffffff',
    x: 24,
    y: 32,
    width: 420,
    height: 120,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: 4,
    locked: false
  }
}

function createScheme(): TargetScheme {
  return {
    id: 'scheme-1',
    name: 'Game Art Review',
    description: 'Inspect media readiness.',
    enabled: true,
    files: [
      {
        id: 'rule-1',
        name: 'rules.md',
        language: 'markdown',
        content: 'Keep layout readable and use the structured canvas payload as ground truth.'
      }
    ],
    createdAt: '2026-04-05T00:00:00.000Z',
    updatedAt: '2026-04-05T00:00:00.000Z'
  }
}

function createImageSchemeWithReferences(): TargetScheme {
  return {
    ...createScheme(),
    files: [
      {
        id: 'rule-1',
        name: 'rules.md',
        language: 'markdown',
        content: 'Keep layout readable and use the structured canvas payload as ground truth.'
      },
      {
        id: 'ref-1',
        name: 'layout-reference.png',
        language: 'image-reference',
        mimeType: 'image/png',
        attachmentUrl: 'data:image/png;base64,AAAA',
        sizeBytes: 128,
        content: 'Reference image 1'
      },
      {
        id: 'ref-2',
        name: 'style-reference.png',
        language: 'image-reference',
        mimeType: 'image/png',
        attachmentUrl: 'data:image/png;base64,BBBB',
        sizeBytes: 128,
        content: 'Reference image 2'
      }
    ]
  }
}

describe('canvasTargetWorkflow asset metadata', () => {
  it('builds image metadata with game-art-oriented inspection fields', () => {
    const metadata = buildCanvasTargetAssetMetadata(createImageItem())

    expect(metadata).toMatchObject({
      itemId: 'image-1',
      type: 'image',
      fileName: 'hero-albedo.png',
      originalFileName: 'scene-source.psd',
      mimeType: 'image/png',
      sizeBytes: 4096,
      sourceWidth: 2048,
      sourceHeight: 1024,
      sourceAspectRatio: 2,
      promptId: 'prompt-image-1',
      sourceUrl: 'data:image/png;base64,AAAA'
    })
    expect(metadata.extra).toMatchObject({
      originalFileName: 'scene-source.psd',
      localFileName: 'hero-albedo.png',
      fileFormat: 'PNG',
      resourceKind: 'data-url',
      displayWidth: 512,
      displayHeight: 256,
      displayAspectRatio: 2,
      rotation: 15,
      scaleX: 1,
      scaleY: 1,
      locked: false,
      sourceWidth: 2048,
      sourceHeight: 1024,
      sourceAspectRatio: 2,
      crop: { x: 12, y: 24, width: 1024, height: 768 },
      hasAlpha: true,
      colorSpace: null,
      textureUsage: null
    })
  })

  it('infers jpeg opacity and estimates data-url size when image metadata is missing', () => {
    const metadata = buildCanvasTargetAssetMetadata({
      ...createImageItem(),
      id: 'image-2',
      src: 'data:image/jpeg;base64,SGVsbG8=',
      fileName: 'photo.jpg',
      sizeBytes: undefined,
      hasAlpha: undefined,
      provenance: undefined
    })

    expect(metadata).toMatchObject({
      itemId: 'image-2',
      type: 'image',
      fileName: 'photo.jpg',
      originalFileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 5
    })
    expect(metadata.extra).toMatchObject({
      originalFileName: 'photo.jpg',
      localFileName: 'photo.jpg',
      fileFormat: 'JPG',
      hasAlpha: false
    })
  })

  it('merges runtime video metadata and preserves null placeholders for unavailable fields', () => {
    const metadata = buildCanvasTargetAssetMetadata(createVideoItem(), {
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceAspectRatio: 1.778,
      durationSeconds: 12.4,
      currentTimeSeconds: 2.1,
      fps: 30
    })

    expect(metadata).toMatchObject({
      itemId: 'video-1',
      type: 'video',
      fileName: 'shot.mp4',
      originalFileName: 'shot.mp4',
      mimeType: 'video/mp4',
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceAspectRatio: 1.778
    })
    expect(metadata.extra).toMatchObject({
      fileFormat: 'MP4',
      resourceKind: 'blob-url',
      displayAspectRatio: 1.778,
      sourceWidth: 1920,
      sourceHeight: 1080,
      sourceAspectRatio: 1.778,
      durationSeconds: 12.4,
      currentTimeSeconds: 2.1,
      fps: 30,
      codec: null,
      bitrateKbps: null,
      loop: true,
      playing: false,
      muted: true,
      volume: 0.35,
      colorSpace: null,
      audioChannels: null
    })
  })

  it('uses caller-provided asset metadata when building the check context pack', () => {
    const modelMetadata = buildCanvasTargetAssetMetadata(createModelItem(), {
      vertexCount: 4096,
      faceCount: 2048
    })

    const contextPack = buildCanvasTargetContextPack({
      scheme: {
        id: 'scheme-1',
        name: 'Game Art Review',
        description: 'Inspect media readiness.',
        enabled: true,
        files: [],
        createdAt: '2026-04-05T00:00:00.000Z',
        updatedAt: '2026-04-05T00:00:00.000Z'
      },
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createModelItem()],
      groups: [],
      assetMetadata: [modelMetadata]
    })

    expect(contextPack.assetMetadata).toEqual([modelMetadata])
    expect(contextPack.assetMetadata[0]).toMatchObject({
      itemId: 'model-1',
      type: 'model3d',
      mimeType: 'model/gltf-binary',
      textures: ['albedo.png', 'normal.png']
    })
    expect(contextPack.assetMetadata[0].extra).toMatchObject({
      fileFormat: 'GLB',
      resourceKind: 'blob-url',
      textureCount: 2,
      vertexCount: 4096,
      faceCount: 2048,
      materialCount: null,
      animationCount: null,
      boneCount: null,
      uvSetCount: null,
      normalData: null,
      tangentData: null,
      locked: true
    })
  })

  it('keeps inline data urls out of the control-plan prompt payload', async () => {
    const embeddedImage = 'data:image/png;base64,' + 'A'.repeat(4096)
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [
        {
          ...createImageItem(),
          src: embeddedImage
        }
      ],
      groups: [],
      snapshotDataUrl: embeddedImage
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'ok',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Stage 1',
            prompt: 'Inspect layout.',
            referenceNotes: ['Focus on hierarchy.'],
            allowedSchemeFileIds: ['rule-1']
          }
        ]
      })
    })

    await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Check layout quality.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [{ id: 'vision-1', label: 'Vision 1' }]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).not.toContain(embeddedImage)
    expect(prompt).not.toContain('"url": "data:image/png;base64,')
    expect(prompt).toContain('attached-selection-image')
    expect(prompt).toContain('source(kind=data-url')
  })

  it('allows control plans without selected auxiliary model candidates', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'control-1', model_name: 'control-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Run the selected QuickApp directly.',
        relevantSchemeFileIds: [],
        stageInstructions: [],
        capabilityActions: [
          {
            type: 'quick_app',
            id: 'rembg-action',
            qAppKey: 'rembg',
            label: 'Rembg subject extraction',
            reason: 'The user selected this runtime capability.',
            phase: 'before_model_stages',
            outputTarget: 'canvas',
            inputAssignments: [
              {
                label: 'source image',
                source: 'first_source_image'
              }
            ]
          }
        ],
        finalPresentation: {
          target: 'canvas',
          addMediaToCanvas: true
        }
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '调用 Rembg 抠出选中图片中的人物。',
      profileId: 'control-1',
      preferExactProfile: true,
      stageProfiles: [],
      runtimeCapabilities: {
        quickApps: [
          {
            key: 'rembg',
            name: 'Rembg',
            path: ['Image'],
            inputs: [],
            autoInputs: []
          }
        ],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    })

    expect(result.stageInstructions).toEqual([])
    expect(result.capabilityActions).toEqual([
      expect.objectContaining({
        type: 'quick_app',
        id: 'rembg-action',
        qAppKey: 'rembg'
      })
    ])

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Auxiliary model stages are optional.')
    expect(prompt).toContain('Candidate models:\n(none selected')
  })

  it('keeps inline data urls out of stage execution prompts', async () => {
    const embeddedImage = 'data:image/png;base64,' + 'B'.repeat(4096)
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [
        {
          ...createImageItem(),
          src: embeddedImage
        }
      ],
      groups: [],
      snapshotDataUrl: embeddedImage
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'ok',
        overview: 'ok',
        findings: []
      })
    })

    await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Check hierarchy.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: 'Stage 1',
      stagePrompt: 'Inspect hierarchy.'
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).not.toContain(embeddedImage)
    expect(prompt).not.toContain('"url": "data:image/png;base64,')
    expect(prompt).toContain('attached-selection-image')
    expect(prompt).toContain('source(kind=data-url')
  })

  it('enables image generation for auxiliary stages that request image deliverables', async () => {
    const sourceImage = 'data:image/png;base64,' + 'C'.repeat(64)
    const generatedImage = 'data:image/png;base64,' + 'D'.repeat(64)
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        {
          id: 'image-1',
          model_name: 'image-1',
          model_use: 'image',
          is_vision_model: true
        }
      ]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'Generated split sheet.',
      imageUrl: generatedImage
    })

    const result = await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      attachments: [
        {
          type: 'image',
          url: sourceImage,
          mimeType: 'image/png',
          fileName: 'selected-source.png'
        }
      ],
      userNotes: 'Split the selected image into elements and return an image sheet.',
      profileId: 'image-1',
      preferExactProfile: true,
      stageLabel: 'Element split image stage',
      stagePrompt: 'Return an actual image containing the split elements.',
      preferredOutputFormats: ['image']
    })

    const request = chat.mock.calls[0][0]
    expect(request.imageGenerationOptions).toMatchObject({
      enabled: true,
      action: 'edit',
      outputFormat: 'png',
      quality: 'high'
    })
    const prompt = request.messages[0].content as string
    expect(prompt).toContain('Requested stage output formats: Image')
    expect(prompt).toContain('This stage is in media-output mode for: Image')
    expect(prompt).toContain(
      'A text plan, crop-box list, file description, or markdown explanation is not a completed media deliverable'
    )
    expect(result.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        url: generatedImage
      })
    ])
  })

  it('does not enable image generation from stage free text without an explicit output contract', async () => {
    const sourceImage = 'data:image/png;base64,' + 'E'.repeat(64)
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        {
          id: 'vision-1',
          model_name: 'vision-1',
          is_vision_model: true
        }
      ]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'NOT_EXECUTABLE: no image media was produced.'
    })

    await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      attachments: [
        {
          type: 'image',
          url: sourceImage,
          mimeType: 'image/png',
          fileName: 'selected-source.png'
        }
      ],
      userNotes: '使用主控模型或附属模型将选中图片进行元素拆分然后返图。',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: '元素拆分返图',
      stagePrompt: '将图片拆分成元素拆分图并返回图片。'
    })

    const request = chat.mock.calls[0][0]
    expect(request.imageGenerationOptions).toBeUndefined()
    const prompt = request.messages[0].content as string
    expect(prompt).not.toContain('Requested stage output formats: Image')
    expect(prompt).not.toContain('This stage is in media-output mode for: Image')
    expect(prompt).toContain('You decide the required output form')
    expect(prompt).toContain('machine-readable manifest')
  })

  it('does not enable image generation for analysis stages that only mention images or elements', async () => {
    const sourceImage = 'data:image/png;base64,' + 'A'.repeat(64)
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: '分析完成。'
    })

    await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      attachments: [
        {
          type: 'image',
          url: sourceImage,
          mimeType: 'image/png',
          fileName: 'selected-source.png'
        }
      ],
      userNotes: '分析选中图片的游戏 PV 构图、元素拆分和分类问题，输出文字建议。',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: 'PV 分析',
      stagePrompt: '只分析当前图片的问题，不要返图，也不要生成新图片。'
    })

    const request = chat.mock.calls[0][0]
    expect(request.imageGenerationOptions).toBeUndefined()
    const prompt = request.messages[0].content as string
    expect(prompt).not.toContain('This stage is in media-output mode for: Image')
  })

  it('tells the control model to treat all selected canvas resources as referenced target input', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createTextItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'text-1', model_name: 'text-1', is_vision_model: false }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Use a text-first stage.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Draft prompt',
            modelId: 'text-1',
            prompt: 'Draft a prompt from the selected text.',
            referenceNotes: ['Treat the canvas text as the source prompt.'],
            allowedSchemeFileIds: ['rule-1']
          }
        ]
      })
    })

    await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Generate a concept image from the selected prompt text.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageProfiles: [{ id: 'text-1', label: 'Text 1' }]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Canvas resource reference note:')
    expect(prompt).toContain('Treat every selected canvas element as referenced target input.')
    expect(prompt).toContain(
      'Do not automatically promote any selected element into the main orchestration prompt.'
    )
    expect(prompt).toContain(
      'Selections containing only text items, only media items, or any mixed combination are all valid target inputs.'
    )
    expect(prompt).toContain('Selected resource mix: 1 text.')
    expect(prompt).toContain('A neon fox courier with reflective jacket')
  })

  it('keeps semantic routing in the control model instead of local software hints', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'text-1', model_name: 'text-1', is_vision_model: false }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Plan the compound canvas operation.',
        relevantSchemeFileIds: ['rule-1'],
        capabilityActions: [],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Plan',
            modelId: 'text-1',
            prompt: 'Plan the requested canvas operation.',
            referenceNotes: [],
            allowedSchemeFileIds: ['rule-1']
          }
        ]
      })
    })

    await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Duplicate two images and crop one half.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageProfiles: [{ id: 'text-1', label: 'Text 1' }]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('There is no separate software semantic router.')
    expect(prompt).toContain(
      'the software executes your explicit stageInstructions and capabilityActions'
    )
    expect(prompt).toContain(
      'When a QuickApp or canvas action must consume a prior output, cite the exact sourceStageId'
    )
    expect(prompt).toContain(
      'This plan will be shown to the user for confirmation before execution'
    )
    expect(prompt).not.toContain('Software route pre-analysis')
    expect(prompt).not.toContain('targetPlan')
  })

  it('keeps editable asset decisions with the control model instead of software intent flags', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Split source into independent assets.',
        relevantSchemeFileIds: ['rule-1'],
        capabilityActions: [],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Split assets',
            modelId: 'vision-1',
            prompt: 'Return a split sheet and manifest.',
            referenceNotes: [],
            allowedSchemeFileIds: ['rule-1']
          }
        ]
      })
    })

    await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '将选中图片进行元素拆分，裁剪出来并分类放在图片下方。',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [{ id: 'vision-1', label: 'Vision 1', isVisionModel: true }]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('You decide the required output form')
    expect(prompt).toContain(
      'When a QuickApp or canvas action must consume a prior output, cite the exact sourceStageId'
    )
    expect(prompt).not.toContain('"editableExtractedAssetsExpected"')
  })

  it('lets the control model explicitly request media deliverables without software text inference', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Return a split image sheet.',
        relevantSchemeFileIds: ['rule-1'],
        capabilityActions: [],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Split sheet',
            modelId: 'vision-1',
            prompt: 'Return a split sheet as an actual image.',
            referenceNotes: [],
            allowedSchemeFileIds: ['rule-1'],
            expectedOutputFormats: ['image']
          }
        ]
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '将选中图片进行元素拆分然后返图。',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [{ id: 'vision-1', label: 'Vision 1', isVisionModel: true }]
    })

    expect(result.stageInstructions[0].expectedOutputFormats).toEqual(['image'])
    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('stageInstructions[].expectedOutputFormats')
    expect(prompt).toContain('If you decide a stage must return a concrete deliverable format')
  })

  it('parses wrapped control-plan JSON without marking successful planning as fallback', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: [
        'Plan:',
        '```json',
        JSON.stringify({
          summary: 'Use the selected vision model to create a split sheet.',
          relevantSchemeFileIds: ['rule-1'],
          capabilityActions: [],
          stageInstructions: [
            {
              id: 'stage-1',
              label: 'Split sheet',
              modelId: 'vision-1',
              prompt: 'Return a split sheet as an actual image.',
              referenceNotes: [],
              allowedSchemeFileIds: ['rule-1'],
              includeSourceAttachments: true,
              expectedOutputFormats: ['image']
            }
          ]
        }),
        '```'
      ].join('\n')
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '将选中图片拆分成元素图。',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [
        {
          id: 'vision-1',
          label: 'Vision 1',
          isVisionModel: true,
          allowedInputs: ['source_assets'],
          outputFormats: ['image']
        }
      ]
    })

    expect(result.fallbackReason).toBeUndefined()
    expect(result.rawResponse).toContain('Plan:')
    expect(result.stageInstructions).toHaveLength(1)
    expect(result.stageInstructions[0]).toMatchObject({
      id: 'stage-1',
      includeSourceAttachments: true,
      expectedOutputFormats: ['image']
    })
  })

  it('keeps control-model output format requests in addition to user-selected stage formats', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Create an element split sheet with metadata.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Element split sheet',
            modelId: 'vision-1',
            prompt: 'Return a split sheet image and a manifest.',
            referenceNotes: [],
            allowedSchemeFileIds: [],
            includeSourceAttachments: true,
            expectedOutputFormats: ['json']
          }
        ]
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '生成整张元素拆分图，并保留每个元素的坐标清单。',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [
        {
          id: 'vision-1',
          label: 'Vision 1',
          isVisionModel: true,
          allowedInputs: ['source_assets'],
          outputFormats: ['image']
        }
      ]
    })

    expect(result.stageInstructions[0].expectedOutputFormats).toEqual(['image', 'json'])
  })

  it('asks the control model for executable actions without a software acceptance graph', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Create three final variants.',
        relevantSchemeFileIds: ['rule-1'],
        capabilityActions: [
          {
            type: 'canvas',
            id: 'crop-variant',
            action: 'crop_image',
            label: 'Crop variant',
            reason: 'User requested a cropped version.',
            phase: 'after_model_stages',
            outputTarget: 'canvas',
            itemIds: ['image-1']
          }
        ],
        stageInstructions: []
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Create a cropped copy above the selected image.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [{ id: 'vision-1', label: 'Vision 1', isVisionModel: true }],
      runtimeCapabilities: {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain(
      'There is no separate software semantic router. You are responsible for semantic planning'
    )
    expect(prompt).toContain('These ids are transport pointers only')
    expect(result.capabilityActions?.[0]).toMatchObject({
      id: 'crop-variant',
      action: 'crop_image'
    })
  })

  it('passes resource reference guidance into auxiliary stage prompts', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createTextItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'text-1', model_name: 'text-1', is_vision_model: false }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'Prompt draft ready.'
    })

    await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Generate a prompt draft from the selected text.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageLabel: 'Prompt drafting stage',
      stagePrompt: 'Turn the selected text into a polished image-generation prompt.'
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Canvas resource reference note:')
    expect(prompt).toContain(
      'Do not automatically promote any selected element into the main orchestration prompt.'
    )
    expect(prompt).toContain(
      'decide which selected resources each stage should read, cite, inspect, transform, or attach'
    )
    expect(prompt).toContain('Selected resource mix: 1 text.')
    expect(prompt).toContain('A neon fox courier with reflective jacket')
  })

  it('tells the control model when an auxiliary candidate is a user-selected local model backend', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Use the local model backend first.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Local model pass',
            candidateId: 'candidate-stage-1',
            modelId: 'agent-local:vision-1',
            prompt: 'Compare the source and snapshot images.',
            referenceNotes: ['Use the fixed local model backend.'],
            allowedSchemeFileIds: [],
            includeSourceAttachments: true,
            includeSelectionSnapshot: true
          }
        ]
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Compare the selected source against the canvas snapshot.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [
        {
          id: 'agent-local:vision-1',
          label: 'Local ONNX Vision',
          executionBackend: 'local_model',
          responsibilityType: 'visual_analysis',
          allowedInputs: ['source_assets', 'selection_snapshot'],
          outputFormats: ['markdown'],
          sourceType: 'local'
        }
      ]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('execution_backend=local_model')
    expect(prompt).toContain('source=local')
    expect(prompt).toContain('backend_contract=User-selected local model backend')
    expect(prompt).toContain('allowed_inputs=Original source assets, Selection snapshot')
    expect(result.stageInstructions[0]).toMatchObject({
      includeSourceAttachments: true,
      includeSelectionSnapshot: true
    })
  })

  it('normalizes token-limit failures into a short fallback reason', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `Error invoking remote method 'svcLLMProxy.chat': Error: OpenAI API error: 400 Bad Request {"error":{"code":"1210","message":"Input validation error: \`inputs\` tokens + \`max_new_tokens\` must be <= 65536. Given: 57572 \`inputs\` tokens and 15360 \`max_new_tokens\`"}}`
        )
      )

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Check layout quality.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [{ id: 'vision-1', label: 'Vision 1' }]
    })

    expect(result.fallbackReason).toBe(
      'Request exceeded model token limit (57572 input + 15360 output > 65536). Used fallback result.'
    )
  })

  it('filters scheme image attachments by allowed file ids', () => {
    const sourceAttachments = buildCanvasTargetSourceAttachments([createImageItem()])
    const snapshotAttachment = {
      type: 'image' as const,
      url: 'data:image/png;base64,SNAPSHOT',
      mimeType: 'image/png',
      fileName: 'snapshot.png'
    }
    const schemeImageAttachments = buildCanvasTargetSchemeImageAttachments(
      createImageSchemeWithReferences()
    )

    const attachments = buildCanvasTargetAttachments({
      sourceAttachments,
      snapshotAttachment,
      schemeImageAttachments,
      allowedSchemeFileIds: ['ref-2']
    })

    expect(attachments).toHaveLength(3)
    expect(attachments[0]).toMatchObject({
      fileName: 'hero-albedo.png',
      sizeBytes: 4096,
      sourceWidth: 2048,
      sourceHeight: 1024
    })
    expect(attachments[1]?.fileName).toBe('snapshot.png')
    expect(attachments[1]?.hiddenFromChatView).toBe(true)
    expect(attachments[2]?.fileName).toBe('style-reference.png')
    expect(attachments[2]?.hiddenFromChatView).toBe(true)
  })

  it('builds original source attachments from selected canvas assets with local file info intact', () => {
    const attachments = buildCanvasTargetSourceAttachments([createImageItem(), createVideoItem()])

    expect(attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'hero-albedo.png',
        sizeBytes: 4096,
        sourceWidth: 2048,
        sourceHeight: 1024
      }),
      expect.objectContaining({
        type: 'video',
        fileName: 'shot.mp4',
        mimeType: 'video/mp4'
      })
    ])
  })

  it('resolves target evidence attachments by the selected accuracy mode', () => {
    const sourceAttachments = buildCanvasTargetSourceAttachments([createImageItem()])
    const snapshotAttachment = {
      type: 'image' as const,
      url: 'data:image/png;base64,SNAPSHOT',
      mimeType: 'image/png',
      fileName: 'snapshot.png'
    }

    expect(
      resolveCanvasTargetEvidenceAttachments({
        evidenceMode: 'structured_only',
        sourceAttachments,
        snapshotAttachment
      })
    ).toEqual({
      sourceAttachments: [],
      snapshotAttachment: null
    })

    expect(
      resolveCanvasTargetEvidenceAttachments({
        evidenceMode: 'selection_region',
        sourceAttachments,
        snapshotAttachment
      })
    ).toEqual({
      sourceAttachments: [],
      snapshotAttachment
    })

    expect(
      resolveCanvasTargetEvidenceAttachments({
        evidenceMode: 'selected_sources',
        sourceAttachments,
        snapshotAttachment
      })
    ).toEqual({
      sourceAttachments,
      snapshotAttachment
    })
  })

  it('enforces evidence mode boundaries on control-plan attachment requests', () => {
    const plan = {
      id: 'control-1',
      generatedAt: '2026-04-12T00:00:00.000Z',
      summary: 'Use visual evidence.',
      relevantSchemeFileIds: ['rule-1'],
      stageInstructions: [
        {
          id: 'stage-1',
          label: 'Vision',
          modelId: 'vision-1',
          prompt: 'Inspect.',
          referenceNotes: [],
          allowedSchemeFileIds: ['rule-1'],
          upstreamStageIds: [],
          includeSourceAttachments: true,
          includeSelectionSnapshot: true
        }
      ]
    }

    expect(applyCanvasTargetEvidenceModeToControlPlan(plan, 'selection_region')).toMatchObject({
      stageInstructions: [
        {
          includeSourceAttachments: false,
          includeSelectionSnapshot: true
        }
      ]
    })
    expect(applyCanvasTargetEvidenceModeToControlPlan(plan, 'structured_only')).toMatchObject({
      stageInstructions: [
        {
          includeSourceAttachments: false,
          includeSelectionSnapshot: false
        }
      ]
    })
    expect(applyCanvasTargetEvidenceModeToControlPlan(plan, 'selected_sources')).toBe(plan)
  })

  it('omits the duplicate selection snapshot when only one image element is selected', () => {
    const targetItems = [createImageItem()]
    const sourceAttachments = buildCanvasTargetSourceAttachments(targetItems)

    expect(
      shouldAttachCanvasTargetSelectionSnapshot({
        targetItems,
        sourceAttachments
      })
    ).toBe(false)
  })

  it('keeps the selection snapshot when multiple elements are selected', () => {
    const targetItems = [createImageItem(), createVideoItem()]
    const sourceAttachments = buildCanvasTargetSourceAttachments(targetItems)

    expect(
      shouldAttachCanvasTargetSelectionSnapshot({
        targetItems,
        sourceAttachments
      })
    ).toBe(true)
  })

  it('includes layout relations in stage prompts so spacing can be reviewed holistically', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [
        createImageItem(),
        {
          ...createImageItem(),
          id: 'image-2',
          x: 640,
          y: 20,
          fileName: 'hero-detail.png'
        }
      ],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'ok',
        overview: 'ok',
        findings: []
      })
    })

    await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Check hierarchy.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: 'Stage 1',
      stagePrompt: 'Inspect hierarchy.'
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('"layoutRelations"')
    expect(prompt).toContain('"horizontalGap"')
    expect(prompt).toContain('"between"')
  })

  it('asks every stage model to organize plain-text feedback by local source file name', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [
        createImageItem(),
        {
          ...createImageItem(),
          id: 'image-2',
          x: 640,
          y: 20,
          fileName: 'hero-detail.png'
        }
      ],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: '## hero-albedo.png\n\nLooks good.'
    })

    await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Check hierarchy.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: 'Stage 1',
      stagePrompt: 'Inspect hierarchy.'
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Use one top-level section per original selected source asset')
    expect(prompt).toContain(
      'Even if there is only one source asset, still use its local file name'
    )
    expect(prompt).toContain('- hero-albedo.png')
    expect(prompt).toContain('- hero-detail.png')
    expect(prompt).toContain('Example heading: ## hero-albedo.png')
  })

  it('truncates oversized repeated stage model garbage before returning it', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const hugeContent = 'A'.repeat(70_000)
    const chat = vi.fn().mockResolvedValue({
      content: hugeContent
    })

    const result = await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Check hierarchy.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: 'Stage 1',
      stagePrompt: 'Inspect hierarchy.'
    })

    expect(result.content.length).toBeLessThan(hugeContent.length)
    expect(result.content).toContain('[MagicPot truncated')
    expect(result.content).toContain('repeated garbage or error text')
  })

  it('keeps large structured stage model output intact when it does not look like garbage', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const hugeStructuredContent = Array.from(
      { length: 4_500 },
      (_, index) => `Section ${index + 1}: detailed check feedback for source asset ${index % 7}.`
    ).join('\n')
    const chat = vi.fn().mockResolvedValue({
      content: hugeStructuredContent
    })

    const result = await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Check hierarchy.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: 'Stage 1',
      stagePrompt: 'Inspect hierarchy.'
    })

    expect(result.content).toBe(hugeStructuredContent)
    expect(result.content).not.toContain('[MagicPot truncated')
  })

  it('turns stage imageUrl responses into image attachments', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'Generated split sheet.',
      imageUrl: 'https://assets.example.com/split-sheet.png'
    })

    const result = await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Split image elements.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: 'Element split',
      stagePrompt: 'Return the split element sheet as an image.'
    })

    expect(result.attachments).toEqual([
      {
        type: 'image',
        url: 'https://assets.example.com/split-sheet.png'
      }
    ])
  })

  it('truncates oversized llm errors before surfacing the fallback reason', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const hugeError = 'E'.repeat(20_000)
    const chat = vi.fn().mockRejectedValue(new Error(hugeError))

    const result = await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Check hierarchy.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageLabel: 'Stage 1',
      stagePrompt: 'Inspect hierarchy.'
    })

    expect(result.fallbackReason).toBeDefined()
    expect((result.fallbackReason || '').length).toBeLessThan(hugeError.length)
    expect(result.fallbackReason).toContain('[MagicPot truncated')
  })

  it('materializes local PNG attachments for OCR models and drops unsupported formats before sending', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode('png-binary').buffer
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const listProfiles = vi.fn().mockResolvedValue({
        profiles: [
          {
            id: 'ocr-1',
            model_name: 'ocr-1',
            is_vision_model: true,
            is_ocr_model: true
          }
        ]
      })
      const chat = vi.fn().mockResolvedValue({
        content: 'OCR stage completed.'
      })

      await requestCanvasTargetStageExecution({
        scheme,
        contextPack,
        llmProxy: { listProfiles, chat },
        attachments: [
          {
            type: 'image',
            url: 'local-media:///C:/assets/layout.png',
            fileName: 'layout.png',
            mimeType: 'image/png',
            sizeBytes: 4096
          },
          {
            type: 'image',
            url: 'local-media:///C:/assets/layout.webp',
            fileName: 'layout.webp',
            mimeType: 'image/webp',
            sizeBytes: 4096
          },
          {
            type: 'file',
            url: 'file:///C:/assets/report.csv',
            fileName: 'report.csv',
            mimeType: 'text/csv'
          },
          {
            type: 'image',
            url: 'data:image/png;base64,U05BUFNIT1Q=',
            fileName: 'snapshot.png',
            mimeType: 'image/png'
          }
        ],
        userNotes: 'Check visible text.',
        profileId: 'ocr-1',
        preferExactProfile: true,
        stageLabel: 'OCR stage',
        stagePrompt: 'Extract text from the selected canvas assets.'
      })

      const sentAttachments = chat.mock.calls[0][0].messages[0].attachments
      expect(sentAttachments).toHaveLength(2)
      expect(sentAttachments[0]).toMatchObject({
        type: 'image',
        fileName: 'layout.png',
        mimeType: 'image/png'
      })
      expect(sentAttachments[0].url).toMatch(/^data:image\/png;base64,/)
      expect(sentAttachments[1]).toMatchObject({
        type: 'image',
        fileName: 'snapshot.png',
        url: 'data:image/png;base64,U05BUFNIT1Q='
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/assets/layout.png')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('materializes local image attachments before sending them to vision control planning', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const imageBlob = new Blob(['vision-binary'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => imageBlob
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const listProfiles = vi.fn().mockResolvedValue({
        profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
      })
      const chat = vi.fn().mockResolvedValue({
        content: JSON.stringify({
          summary: 'ok',
          relevantSchemeFileIds: ['rule-1'],
          stageInstructions: []
        })
      })

      await requestCanvasTargetControlPlan({
        scheme,
        contextPack,
        llmProxy: { listProfiles, chat },
        attachments: [
          {
            type: 'image',
            url: 'local-media:///C:/assets/layout.png',
            fileName: 'layout.png',
            mimeType: 'image/png',
            sizeBytes: 4096
          }
        ],
        userIntent: 'Check layout quality.',
        profileId: 'vision-1',
        preferExactProfile: true,
        stageProfiles: [{ id: 'vision-1', label: 'Vision 1' }]
      })

      const sentAttachments = chat.mock.calls[0][0].messages[0].attachments
      expect(sentAttachments).toHaveLength(1)
      expect(sentAttachments[0]).toMatchObject({
        type: 'image',
        fileName: 'layout.png',
        mimeType: 'image/png',
        sizeBytes: 4096
      })
      expect(sentAttachments[0].url).toMatch(/^data:image\/png;base64,/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/assets/layout.png')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('materializes local image attachments for non-OCR vision stage execution', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const imageBlob = new Blob(['stage-vision-binary'], { type: 'image/png' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => imageBlob
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const listProfiles = vi.fn().mockResolvedValue({
        profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
      })
      const chat = vi.fn().mockResolvedValue({
        content: 'Vision stage completed.'
      })

      await requestCanvasTargetStageExecution({
        scheme,
        contextPack,
        llmProxy: { listProfiles, chat },
        attachments: [
          {
            type: 'image',
            url: 'local-media:///C:/assets/layout.png',
            fileName: 'layout.png',
            mimeType: 'image/png',
            sizeBytes: 4096
          }
        ],
        userNotes: 'Check visible layout.',
        profileId: 'vision-1',
        preferExactProfile: true,
        stageLabel: 'Vision stage',
        stagePrompt: 'Inspect the image directly.'
      })

      const sentAttachments = chat.mock.calls[0][0].messages[0].attachments
      expect(sentAttachments).toHaveLength(1)
      expect(sentAttachments[0]).toMatchObject({
        type: 'image',
        fileName: 'layout.png',
        mimeType: 'image/png',
        sizeBytes: 4096
      })
      expect(sentAttachments[0].url).toMatch(/^data:image\/png;base64,/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('local-media:///C:/assets/layout.png')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('lets the control model choose dynamic stage order with explicit model capabilities and upstream handoff', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        {
          id: 'ocr-1',
          model_name: 'ocr-1',
          model_use: 'ocr',
          is_vision_model: true,
          is_ocr_model: true
        },
        {
          id: 'text-1',
          model_name: 'text-1',
          model_use: 'chat',
          is_vision_model: false,
          is_ocr_model: false
        }
      ]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Use OCR first, then summarize with text.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'ocr-stage',
            label: 'Extract visible copy',
            candidateId: 'candidate-ocr',
            modelId: 'ocr-1',
            prompt: 'Extract readable text from the screenshot and organize it.',
            referenceNotes: ['Focus on text-bearing areas first.'],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: [],
            includeSourceAttachments: true,
            includeSelectionSnapshot: true,
            includeSchemeImageAttachments: false
          },
          {
            id: 'text-stage',
            label: 'Summarize for planning',
            candidateId: 'candidate-text',
            modelId: 'text-1',
            prompt: 'Summarize the extracted copy into planning bullets.',
            referenceNotes: ['Use the OCR output as primary input.'],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: ['ocr-stage'],
            includeSelectionSnapshot: false,
            includeSchemeImageAttachments: false
          }
        ]
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Turn the visible UI copy into planning bullets.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageProfiles: [
        {
          candidateId: 'candidate-ocr',
          id: 'ocr-1',
          label: 'OCR 1',
          responsibilityType: 'ocr_extract',
          mustFollow: 'Only extract readable text and table data.',
          forbiddenActions: 'Do not summarize or infer.',
          allowedInputs: ['source_assets', 'selection_snapshot', 'scheme_files'],
          outputFormat: 'json',
          executionRule: 'Only extract readable text and table data.',
          modelUse: 'ocr',
          isVisionModel: true,
          isOcrModel: true
        },
        {
          candidateId: 'candidate-text',
          id: 'text-1',
          label: 'Text 1',
          responsibilityType: 'synthesis',
          mustFollow: 'Summarize the OCR result without re-reading the image.',
          forbiddenActions: 'Do not inspect visual inputs again.',
          allowedInputs: ['scheme_files', 'upstream_results'],
          outputFormat: 'markdown',
          executionRule: 'Summarize the OCR result without re-reading the image.',
          modelUse: 'chat',
          isVisionModel: false,
          isOcrModel: false
        }
      ]
    })

    expect(result.stageInstructions).toHaveLength(2)
    expect(result.stageInstructions[0]).toMatchObject({
      id: 'ocr-stage',
      candidateId: 'candidate-ocr',
      modelId: 'ocr-1',
      upstreamStageIds: [],
      includeSelectionSnapshot: true,
      includeSourceAttachments: true,
      expectedOutputFormat: 'json'
    })
    expect(result.stageInstructions[1]).toMatchObject({
      id: 'text-stage',
      candidateId: 'candidate-text',
      modelId: 'text-1',
      upstreamStageIds: ['ocr-stage'],
      includeSelectionSnapshot: false,
      includeSourceAttachments: false,
      expectedOutputFormat: 'markdown'
    })
    expect(result.stageInstructions[0].referenceNotes).toContain(
      'Must follow: Only extract readable text and table data.'
    )
    expect(result.stageInstructions[1].referenceNotes).toContain(
      'Must follow: Summarize the OCR result without re-reading the image.'
    )

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Candidate models')
    expect(prompt).toContain('candidate_id=candidate-ocr')
    expect(prompt).toContain('responsibility=OCR extraction')
    expect(prompt).toContain('must_follow=Only extract readable text and table data.')
    expect(prompt).toContain('forbidden_actions=Do not summarize or infer.')
    expect(prompt).toContain(
      'allowed_inputs=Original source assets, Selection snapshot, Scheme files'
    )
    expect(prompt).toContain('additional_output_formats=JSON')
    expect(prompt).toContain('execution_rule=Only extract readable text and table data.')
    expect(prompt).toContain('model_use=ocr')
    expect(prompt).toContain('ocr=yes')
    expect(prompt).toContain('vision=no')
  })

  it('preserves broad requested output format lists for the control model', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        { id: 'control-1', model_name: 'control-1', is_vision_model: true, is_ocr_model: false }
      ]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Return one image sheet.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'sheet-stage',
            label: 'Element split sheet',
            candidateId: 'candidate-image',
            modelId: 'image-1',
            prompt: 'Return the split image sheet.',
            referenceNotes: [],
            allowedSchemeFileIds: [],
            upstreamStageIds: [],
            includeSourceAttachments: true,
            includeSelectionSnapshot: true,
            includeSchemeImageAttachments: false
          }
        ],
        capabilityActions: [],
        finalPresentation: { target: 'auto' }
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '将选中图片进行元素拆分并返图。',
      profileId: 'control-1',
      stageProfiles: [
        {
          candidateId: 'candidate-image',
          id: 'image-1',
          label: 'Image model',
          allowedInputs: ['source_assets', 'selection_snapshot'],
          outputFormats: ['image', 'json', 'table', 'video', 'model3d'],
          outputFormat: 'image',
          isVisionModel: true
        }
      ]
    })

    expect(result.stageInstructions[0].expectedOutputFormats).toEqual([
      'image',
      'json',
      'table',
      'video',
      'model3d'
    ])
    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('additional_output_formats=Image, JSON, Table, Video, 3D')
  })

  it('keeps legacy structured media format lists explicit instead of dropping them locally', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        { id: 'control-1', model_name: 'control-1', is_vision_model: true, is_ocr_model: false }
      ]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Analyze and plan.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Analyze PV assets',
            candidateId: 'candidate-broad',
            modelId: 'vision-1',
            prompt: 'Analyze the selected image.',
            referenceNotes: [],
            allowedSchemeFileIds: [],
            upstreamStageIds: []
          }
        ],
        capabilityActions: [],
        finalPresentation: { target: 'auto' }
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '分析当前图片。',
      profileId: 'control-1',
      stageProfiles: [
        {
          candidateId: 'candidate-broad',
          id: 'vision-1',
          label: 'Vision model',
          allowedInputs: ['source_assets', 'selection_snapshot'],
          outputFormats: ['json', 'table', 'video', 'model3d'],
          isVisionModel: true
        }
      ]
    })

    expect(result.stageInstructions[0].expectedOutputFormats).toEqual([
      'json',
      'table',
      'video',
      'model3d'
    ])
    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('additional_output_formats=JSON, Table, Video, 3D')
  })

  it('enforces auxiliary input contracts when normalizing the control plan', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        { id: 'text-1', model_name: 'text-1', is_vision_model: false, is_ocr_model: false }
      ]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Use the text model only after OCR.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'text-stage',
            label: 'Summarize OCR output',
            candidateId: 'candidate-text',
            modelId: 'text-1',
            prompt: 'Summarize the OCR output into action bullets.',
            referenceNotes: ['Try to inspect the screenshot again.'],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: ['non-existent-stage'],
            includeSourceAttachments: true,
            includeSelectionSnapshot: true,
            includeSchemeImageAttachments: true
          }
        ]
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Summarize the OCR result.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageProfiles: [
        {
          candidateId: 'candidate-text',
          id: 'text-1',
          label: 'Text 1',
          responsibilityType: 'synthesis',
          mustFollow: 'Only summarize upstream OCR output.',
          forbiddenActions: 'Do not read source images directly.',
          allowedInputs: ['upstream_results'],
          outputFormat: 'markdown'
        }
      ]
    })

    expect(result.stageInstructions[0]).toMatchObject({
      modelId: 'text-1',
      allowedSchemeFileIds: [],
      upstreamStageIds: [],
      includeSourceAttachments: false,
      includeSelectionSnapshot: false,
      includeSchemeImageAttachments: false,
      expectedOutputFormat: 'markdown'
    })
    expect(result.stageInstructions[0].referenceNotes).toContain(
      'Forbidden actions: Do not read source images directly.'
    )
  })

  it('asks the control model to infer auxiliary responsibilities when none are preset', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        { id: 'text-1', model_name: 'text-1', is_vision_model: false, is_ocr_model: false }
      ]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'ok',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'text-stage',
            label: 'Text stage',
            candidateId: 'candidate-text',
            modelId: 'text-1',
            prompt: 'Summarize the selected region.',
            referenceNotes: [],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: []
          }
        ]
      })
    })

    await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Summarize the selected region for planning.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageProfiles: [
        {
          candidateId: 'candidate-text',
          id: 'text-1',
          label: 'Text 1',
          mustFollow: 'Stay grounded in the supplied canvas context.',
          forbiddenActions: 'Do not invent unseen UI details.',
          allowedInputs: ['scheme_files', 'upstream_results'],
          outputFormat: 'markdown',
          executionRule: 'Stay grounded in the supplied canvas context.',
          modelUse: 'chat',
          isVisionModel: false,
          isOcrModel: false
        }
      ]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('responsibility=infer-from-user-intent')
    expect(prompt).toContain(
      'When a candidate already carries a fixed responsibility, preserve it. Otherwise infer the stage responsibility yourself from the current user intent and the selected candidate capability.'
    )
    expect(prompt).toContain(
      'Treat additional_output_formats as explicit user-facing deliverable contracts for that stage.'
    )
  })

  it('skips remote control planning when the selected control profile is OCR-only', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        {
          id: 'ocr-1',
          model_name: 'ocr-1',
          model_use: 'ocr',
          is_vision_model: true,
          is_ocr_model: true
        }
      ]
    })
    const chat = vi.fn()

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Check visible copy.',
      profileId: 'ocr-1',
      preferExactProfile: true,
      stageProfiles: [
        {
          id: 'ocr-1',
          label: 'OCR 1',
          modelUse: 'ocr',
          isVisionModel: true,
          isOcrModel: true
        }
      ]
    })

    expect(chat).not.toHaveBeenCalled()
    expect(result.modelId).toBe('ocr-1')
    expect(result.stageInstructions).toHaveLength(0)
    expect(result.summary).toContain('No local semantic fallback plan')
  })

  it('does not generate semantic stage work in the local fallback control plan', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: null,
      userIntent: 'Check visible copy.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageProfiles: [
        {
          candidateId: 'candidate-text',
          id: 'text-1',
          label: 'Text 1',
          responsibilityType: 'synthesis',
          mustFollow: 'Only summarize upstream OCR output.',
          forbiddenActions: 'Do not read images directly.',
          allowedInputs: ['upstream_results'],
          outputFormat: 'markdown',
          executionRule: 'Only summarize upstream OCR output.'
        }
      ]
    })

    expect(result.fallbackReason).toBe('LLM service unavailable')
    expect(result.summary).toContain('No local semantic fallback plan')
    expect(result.stageInstructions).toEqual([])
    expect(result.capabilityActions).toEqual([])
  })

  it('builds a local summary when the selected summary profile is OCR-only', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        {
          id: 'ocr-1',
          model_name: 'ocr-1',
          model_use: 'ocr',
          is_vision_model: true,
          is_ocr_model: true
        }
      ]
    })
    const chat = vi.fn()

    const result = await requestCanvasTargetSummaryExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Summarize the check.',
      profileId: 'ocr-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-04-10T00:00:00.000Z',
        summary: 'Fallback control summary.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: []
      },
      stageResults: [
        {
          id: 'stage-1',
          label: 'Stage 1',
          summary: 'Detected text.',
          overview: 'OCR overview.',
          findings: []
        }
      ]
    })

    expect(chat).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      modelId: 'ocr-1'
    })
    expect(result.content).toContain('Summary fallback')
    expect(result.content).toContain('Stage 1: Detected text.')
  })

  it('asks the control summary model to preserve per-file sections by local source file name', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [
        createImageItem(),
        {
          ...createImageItem(),
          id: 'image-2',
          x: 640,
          y: 20,
          fileName: 'hero-detail.png'
        }
      ],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: '## hero-albedo.png\n\nSummary ready.'
    })

    await requestCanvasTargetSummaryExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Summarize the check.',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-04-10T00:00:00.000Z',
        summary: 'Summarize by source file.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: []
      },
      stageResults: [
        {
          id: 'stage-1',
          label: 'Stage 1',
          summary: 'Detected text.',
          overview: 'OCR overview.',
          findings: []
        }
      ]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Use one top-level section per original selected source asset')
    expect(prompt).toContain('- hero-albedo.png')
    expect(prompt).toContain('- hero-detail.png')
    expect(prompt).toContain('Only create sections for original selected source assets')
  })

  it('asks the control summary model to perform final visual acceptance without software verification', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'Summary ready.'
    })

    await requestCanvasTargetSummaryExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Check the canvas execution.',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-04-10T00:00:00.000Z',
        summary: 'Summarize execution.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: []
      },
      stageResults: [
        {
          id: 'stage-1',
          label: 'Stage 1',
          summary: 'Canvas changed.',
          overview: 'Overview.',
          findings: []
        }
      ]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('final visual acceptance')
    expect(prompt).toContain('You are the final judge')
    expect(prompt).toContain('Software receipts are execution logs only')
    expect(prompt).toContain('Start the first line exactly with ACCEPTED')
    expect(prompt).not.toContain('data:image/png;base64')
  })

  it('treats status headings as final acceptance tokens without accepting partial keywords', () => {
    expect(resolveCanvasTargetAcceptanceStatus('NEEDS_FIX ## image.png 当前结果不满足')).toBe(
      'needs_fix'
    )
    expect(resolveCanvasTargetAcceptanceStatus('ACCEPTED ## image.png 已通过')).toBe('accepted')
    expect(resolveCanvasTargetAcceptanceStatus('ACCEPTED_BUT still needs edits')).toBe('unknown')
    expect(resolveCanvasTargetAcceptanceStatus('NEEDS_FIXTURE is not a status')).toBe('unknown')
  })

  it('requires extracted assets to become separate editable canvas items during final acceptance', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'NEEDS_FIX\nOnly a composite sheet was placed.'
    })

    await requestCanvasTargetSummaryExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent:
        '将选中图片进行元素拆分，拆分完成后裁剪出来，然后按游戏 PV 图规则分类放在选中图片下方。',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-04-10T00:00:00.000Z',
        summary: 'Split classified assets from the selected source.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: []
      },
      stageResults: [
        {
          id: 'stage-1',
          label: 'Split sheet',
          summary: 'Returned one classification sheet.',
          overview: 'Overview.',
          findings: [],
          attachments: [
            {
              type: 'image',
              url: 'https://assets.example.com/split-sheet.png',
              fileName: 'split-sheet.png'
            }
          ]
        }
      ]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('You decide the required output form')
    expect(prompt).toContain('sourceStageId')
    expect(prompt).not.toContain('"editableExtractedAssetsExpected"')
  })

  it('asks the control summary model to preserve raw stage outputs and honor deliverable contracts', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'Summary ready.'
    })

    await requestCanvasTargetSummaryExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Summarize and add requested outputs.',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-04-10T00:00:00.000Z',
        summary: 'Summarize by stage.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'Stage 1',
            modelId: 'vision-1',
            prompt: 'Inspect the selected region.',
            referenceNotes: [],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: [],
            expectedOutputFormats: ['json', 'table'],
            expectedOutputFormat: 'json'
          }
        ]
      },
      stageResults: [
        {
          id: 'stage-1',
          label: 'Stage 1',
          summary: 'Detected content.',
          overview: 'Overview.',
          findings: [],
          content: 'Full raw stage output.'
        }
      ]
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain(
      'First preserve the complete raw outputs from the stage models for the user-facing answer whenever those outputs contain substantive content.'
    )
    expect(prompt).toContain(
      'If a stage includes requested output formats, treat them as stage deliverable contracts.'
    )
    expect(prompt).toContain('Requested stage deliverable formats:')
    expect(prompt).toContain('- Stage 1: JSON, Table')
    expect(prompt).toContain('final visual acceptance')
  })

  it('asks the control model for bounded fix actions after NEEDS_FIX acceptance', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Create the missing cropped asset.',
        capabilityActions: [
          {
            type: 'canvas',
            id: 'crop-hero',
            action: 'crop_image',
            label: 'Crop hero',
            reason: 'NEEDS_FIX says no cropped asset exists.',
            phase: 'before_stage',
            outputTarget: 'canvas',
            itemIds: ['image-1'],
            coordinateSpace: 'source_item_normalized',
            cropX: 0.1,
            cropY: 0.2,
            cropWidth: 0.3,
            cropHeight: 0.4
          }
        ]
      })
    })

    const result = await requestCanvasTargetAcceptanceFixActions({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Crop the selected image into classified assets.',
      profileId: 'vision-1',
      preferExactProfile: true,
      preferredLanguage: 'zh-CN',
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-05-03T00:00:00.000Z',
        summary: 'Initial plan',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: []
      },
      executionJournalDigest: {
        canvasVersion: 1,
        entryCount: 1,
        omittedEntryCount: 0,
        counters: {
          byKind: {
            control_plan: 1,
            model: 1,
            quick_app: 0,
            canvas_action: 0,
            final_presentation: 0
          },
          byStatus: {
            success: 1,
            fallback: 0
          },
          canvasMutationCount: 0
        },
        recentEntries: []
      },
      finalAcceptanceContent: 'NEEDS_FIX\nNo cropped assets were placed below the source.',
      stageResults: [
        {
          id: 'stage-1',
          label: 'Planner',
          summary: 'Produced crop boxes.',
          overview: 'Overview.',
          findings: [],
          content: 'Crop hero from normalized box x=0.1 y=0.2 w=0.3 h=0.4.'
        }
      ],
      runtimeCapabilities: {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    })

    expect(result.capabilityActions).toEqual([
      expect.objectContaining({
        id: 'acceptance-fix-1-crop-hero',
        action: 'crop_image',
        phase: 'after_summary',
        outputTarget: 'canvas'
      })
    ])
    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('after your final visual acceptance returned NEEDS_FIX')
    expect(prompt).toContain('No cropped assets were placed below the source.')
    expect(prompt).toContain('The software layer is not judging visual content')
    expect(prompt).toContain('You decide the required output form')
    expect(prompt).toContain('If a model or QuickApp should create media')
  })

  it('does not enable control-model image generation for analysis-only acceptance fixes', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: '补充文字分析。',
        capabilityActions: []
      })
    })

    await requestCanvasTargetAcceptanceFixActions({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '分析选中图片的游戏 PV 构图、元素拆分和分类问题，输出文字建议。',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-05-03T00:00:00.000Z',
        summary: 'Analyze the selected image.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'PV analysis',
            modelId: 'vision-1',
            prompt: 'Analyze the image and return text only.',
            referenceNotes: [],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: []
          }
        ]
      },
      finalAcceptanceContent: 'NEEDS_FIX\n需要补充对当前图片构图问题的文字分析，不要返图。',
      stageResults: [],
      runtimeCapabilities: {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      },
      availableCanvasSources: [
        {
          sourceStageId: 'split-sheet-stage',
          label: 'Split sheet',
          kind: 'model-check',
          modelId: 'vision-1',
          canvasItemIds: ['sheet-canvas-item'],
          artifactIds: ['sheet-artifact'],
          items: [
            {
              id: 'sheet-canvas-item',
              type: 'image',
              fileName: 'split-sheet.png',
              x: 10,
              y: 20,
              width: 640,
              height: 360
            }
          ]
        }
      ]
    })

    expect(chat.mock.calls[0][0].imageGenerationOptions).toBeUndefined()
  })

  it('does not enable image generation for correction passes even when prior stages requested images', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      imageUrl: 'data:image/png;base64,abcd'
    })

    const result = await requestCanvasTargetAcceptanceFixActions({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: '把模型返图里的元素裁出来。',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-05-03T00:00:00.000Z',
        summary: 'Generate and split image assets.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'stage-1',
            label: 'PV image split',
            modelId: 'vision-1',
            prompt: 'Return an image split sheet.',
            referenceNotes: [],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: [],
            expectedOutputFormats: ['image']
          }
        ]
      },
      finalAcceptanceContent: 'NEEDS_FIX\n需要把返图继续裁成独立元素。',
      stageResults: [],
      runtimeCapabilities: {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      },
      availableCanvasSources: [
        {
          sourceStageId: 'split-sheet-stage',
          label: 'Split sheet',
          kind: 'model-check',
          modelId: 'vision-1',
          canvasItemIds: ['sheet-canvas-item'],
          artifactIds: ['sheet-artifact'],
          items: [
            {
              id: 'sheet-canvas-item',
              type: 'image',
              fileName: 'split-sheet.png',
              x: 10,
              y: 20,
              width: 640,
              height: 360
            }
          ]
        }
      ]
    })

    expect(chat.mock.calls[0][0].imageGenerationOptions).toBeUndefined()
    expect(result.capabilityActions).toEqual([])
    expect(result.attachments?.[0]).toMatchObject({
      type: 'image',
      url: 'data:image/png;base64,abcd'
    })
    expect(result.fallbackReason).toBe('No executable correction tool calls returned')
  })

  it('parses direct control-model correction tool calls', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: [
        'Here is the executable correction package:',
        '`json',
        JSON.stringify({
          summary: 'Crop actual PV assets and arrange them below the source.',
          capabilityActions: [
            {
              type: 'canvas',
              id: 'extract-hero-half-body',
              action: 'extract_image_region',
              outputTarget: 'canvas',
              sourceStageId: 'split-sheet-stage',
              coordinateSpace: 'source_image_pixels',
              cropX: 24,
              cropY: 40,
              cropWidth: 320,
              cropHeight: 180
            },
            {
              type: 'canvas',
              id: 'arrange-cropped-assets',
              action: 'arrange_items',
              outputTarget: 'canvas',
              sourceStageIds: ['extract-hero-half-body'],
              arrangement: 'grid',
              x: 10,
              y: 20
            }
          ]
        }),
        '`'
      ].join('\\n')
    })

    const result = await requestCanvasTargetAcceptanceFixActions({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Split the selected image into PV assets below the original.',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-05-03T00:00:00.000Z',
        summary: 'Initial plan',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: []
      },
      finalAcceptanceContent: 'NEEDS_FIX\\nWhole-image copies were produced instead of assets.',
      stageResults: [],
      runtimeCapabilities: {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      },
      availableCanvasSources: [
        {
          sourceStageId: 'split-sheet-stage',
          label: 'Split sheet',
          kind: 'model-check',
          modelId: 'vision-1',
          canvasItemIds: ['sheet-canvas-item'],
          artifactIds: ['sheet-artifact'],
          items: [
            {
              id: 'sheet-canvas-item',
              type: 'image',
              fileName: 'split-sheet.png',
              x: 10,
              y: 20,
              width: 640,
              height: 360
            }
          ]
        }
      ]
    })

    expect(result.capabilityActions).toEqual([
      expect.objectContaining({
        id: 'acceptance-fix-1-extract-hero-half-body',
        action: 'extract_image_region',
        sourceStageId: 'split-sheet-stage',
        coordinateSpace: 'source_image_pixels',
        cropX: 24,
        cropY: 40,
        cropWidth: 320,
        cropHeight: 180,
        phase: 'after_summary'
      }),
      expect.objectContaining({
        id: 'acceptance-fix-2-arrange-cropped-assets',
        action: 'arrange_items',
        sourceStageIds: ['extract-hero-half-body'],
        phase: 'after_summary'
      })
    ])
    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain(
      'Return direct capabilityActions, toolCalls, canvasActions, or actions'
    )
    expect(prompt).toContain('Natural-language instructions alone are not executable')
    expect(prompt).toContain('availableCanvasSources')
    expect(prompt).toContain('split-sheet-stage')
    expect(prompt).toContain('sheet-canvas-item')
    expect(prompt).not.toContain('Prefer returning a')
  })

  it('accepts common tool-call aliases in control-model acceptance fixes', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Use aliases.',
        toolCalls: [
          {
            type: 'function',
            function: {
              name: 'extract_image_region',
              arguments: JSON.stringify({
                id: 'asset-from-sheet',
                sourceStageId: 'split-sheet-stage',
                coordinateSpace: 'sourceImagePixels',
                cropX: 24,
                cropY: 40,
                cropWidth: 320,
                cropHeight: 180
              })
            }
          },
          {
            type: 'function',
            function: {
              name: 'arrange_items',
              arguments: JSON.stringify({
                id: 'arrange-alias',
                sourceStageIds: ['asset-from-sheet'],
                arrangement: 'row',
                x: 10,
                y: 20
              })
            }
          }
        ]
      })
    })

    const result = await requestCanvasTargetAcceptanceFixActions({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Split the returned sheet into assets.',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-05-03T00:00:00.000Z',
        summary: 'Initial plan',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: []
      },
      finalAcceptanceContent: 'NEEDS_FIX\\nThe returned sheet still needs separate assets.',
      stageResults: [],
      runtimeCapabilities: {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    })

    expect(result.capabilityActions).toEqual([
      expect.objectContaining({
        id: 'acceptance-fix-1-asset-from-sheet',
        action: 'extract_image_region',
        sourceStageId: 'split-sheet-stage',
        coordinateSpace: 'source_image_pixels'
      }),
      expect.objectContaining({
        id: 'acceptance-fix-2-arrange-alias',
        action: 'arrange_items',
        sourceStageIds: ['asset-from-sheet']
      })
    ])
  })

  it('does not accept media-only acceptance fixes without executable JSON', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'vision-1', model_name: 'vision-1', is_vision_model: true }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'Here is the corrected split sheet.',
      imageUrl: 'https://assets.example.com/corrected-split-sheet.png'
    })

    const result = await requestCanvasTargetAcceptanceFixActions({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      attachments: [
        {
          type: 'image',
          url: 'data:image/png;base64,' + 'F'.repeat(64),
          mimeType: 'image/png',
          fileName: 'final-evidence.png'
        }
      ],
      userIntent: 'Split the selected image into classified assets.',
      profileId: 'vision-1',
      preferExactProfile: true,
      controlPlan: {
        id: 'control-1',
        generatedAt: '2026-05-03T00:00:00.000Z',
        summary: 'Initial plan',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: []
      },
      finalAcceptanceContent: 'NEEDS_FIX\nThe auxiliary stage did not produce a media artifact.',
      stageResults: [],
      runtimeCapabilities: {
        quickApps: [],
        canvasActions: CANVAS_TARGET_CANVAS_ACTIONS
      }
    })

    expect(result.capabilityActions).toEqual([])
    expect(result.attachments?.[0]).toMatchObject({
      type: 'image',
      url: 'https://assets.example.com/corrected-split-sheet.png'
    })
    expect(result.fallbackReason).toBe('Missing executable JSON correction package')
    expect(chat.mock.calls[0][0].imageGenerationOptions).toBeUndefined()
    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('This correction request is structured execution mode')
    expect(prompt).toContain('do not fake that missing artifact by copying the original')
  })

  it('falls back to safe stage labels when the control model returns mojibake text', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [
        { id: 'vision-1', model_name: 'vision-1', is_vision_model: true },
        { id: 'text-1', model_name: 'text-1', is_vision_model: false }
      ]
    })
    const mojibakeLabel = String.fromCharCode(0x9359, 0x95c2, 0x7f02, 0x59ab)
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: 'Control plan ready.',
        relevantSchemeFileIds: ['rule-1'],
        stageInstructions: [
          {
            id: 'vision-stage',
            label: 'Analyze image layout',
            modelId: 'vision-1',
            prompt: 'Inspect the selected layout.',
            referenceNotes: ['Use the snapshot.'],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: [],
            includeSelectionSnapshot: true,
            includeSchemeImageAttachments: true
          },
          {
            id: 'text-stage',
            label: mojibakeLabel,
            modelId: 'text-1',
            prompt: 'Summarize the findings.',
            referenceNotes: ['Use the prior stage output.'],
            allowedSchemeFileIds: ['rule-1'],
            upstreamStageIds: ['vision-stage'],
            includeSelectionSnapshot: false,
            includeSchemeImageAttachments: false
          }
        ]
      })
    })

    const result = await requestCanvasTargetControlPlan({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userIntent: 'Check layout quality.',
      profileId: 'vision-1',
      preferExactProfile: true,
      stageProfiles: [
        { id: 'vision-1', label: 'Vision 1', isVisionModel: true },
        { id: 'text-1', label: 'Text 1' }
      ]
    })

    expect(result.stageInstructions[0].label).toBe('Analyze image layout')
    expect(result.stageInstructions[1].label).toBe('Stage 2: Text 1')
  })

  it('passes upstream stage results into stage execution prompts and preserves structured outputs', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })

    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'text-1', model_name: 'text-1', is_vision_model: false }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'Planning bullets ready.',
      attachments: [
        {
          type: 'file',
          url: 'file:///C:/tmp/planning.md',
          fileName: 'planning.md',
          mimeType: 'text/markdown'
        }
      ],
      ocrResult: {
        kind: 'text',
        text: 'Main title\nSubtitle'
      }
    })

    const result = await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Summarize the extracted copy.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageLabel: 'Planning summary',
      stagePrompt: 'Turn the OCR output into concise planning bullets.',
      allowedSchemeFileIds: ['rule-1'],
      upstreamStageResults: [
        {
          id: 'ocr-stage',
          label: 'OCR stage',
          modelId: 'ocr-1',
          content: 'Detected copy: Main title / Subtitle',
          attachments: [
            {
              type: 'file',
              url: 'file:///C:/tmp/ocr.csv',
              fileName: 'ocr.csv',
              mimeType: 'text/csv'
            }
          ],
          ocrResult: {
            kind: 'table',
            text: 'Main title,Subtitle'
          }
        }
      ]
    })

    expect(result).toMatchObject({
      modelId: 'text-1',
      content: 'Planning bullets ready.'
    })
    expect(result.attachments).toEqual([
      expect.objectContaining({
        type: 'file',
        fileName: 'planning.md'
      })
    ])
    expect(result.ocrResult).toMatchObject({
      kind: 'text',
      text: 'Main title\nSubtitle'
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Upstream stage results')
    expect(prompt).toContain('OCR stage')
    expect(prompt).toContain('Detected copy')
    expect(prompt).toContain('ocr.csv')
  })

  it('passes a bounded execution journal digest into stage prompts', async () => {
    const scheme = createScheme()
    const contextPack = buildCanvasTargetContextPack({
      scheme,
      projectId: 'canvas-1',
      projectName: 'Project',
      targetItems: [createImageItem()],
      groups: []
    })
    const listProfiles = vi.fn().mockResolvedValue({
      profiles: [{ id: 'text-1', model_name: 'text-1', is_vision_model: false }]
    })
    const chat = vi.fn().mockResolvedValue({
      content: 'Ready.'
    })

    await requestCanvasTargetStageExecution({
      scheme,
      contextPack,
      llmProxy: { listProfiles, chat },
      userNotes: 'Continue after the canvas operation.',
      profileId: 'text-1',
      preferExactProfile: true,
      stageLabel: 'Follow-up stage',
      stagePrompt: 'Use only the relevant canvas delta.',
      executionJournalDigest: {
        canvasVersion: 3,
        entryCount: 2,
        omittedEntryCount: 0,
        counters: {
          byKind: {
            control_plan: 1,
            model: 0,
            quick_app: 1,
            canvas_action: 0,
            final_presentation: 0
          },
          byStatus: {
            success: 2,
            fallback: 0
          },
          canvasMutationCount: 1
        },
        recentEntries: [
          {
            stageId: 'upscale-action',
            kind: 'quick_app',
            label: 'Upscale image',
            status: 'success',
            inputCanvasVersion: 2,
            outputCanvasVersion: 3,
            inputItemIds: ['image-1'],
            outputItemIds: ['image-2'],
            affectedItemIds: ['image-2'],
            createdItemIds: ['image-2'],
            canvasMutation: true,
            summary: 'Upscaled image placed on canvas.',
            action: {
              type: 'quick_app',
              id: 'upscale-action',
              phase: 'before_stage',
              stageId: 'follow-up-stage',
              outputTarget: 'canvas',
              qAppKey: 'upscale'
            }
          }
        ]
      }
    })

    const prompt = chat.mock.calls[0][0].messages[0].content as string
    expect(prompt).toContain('Execution journal digest')
    expect(prompt).toContain('"canvasVersion": 3')
    expect(prompt).toContain('"kind": "quick_app"')
    expect(prompt).toContain('"outputItemIds"')
    expect(prompt).not.toContain('data:image/png;base64')
  })
})
