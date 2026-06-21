import { beforeEach, describe, expect, it } from 'vitest'
import {
  CONVERT_TARGET_FORMATS,
  DEFAULT_MEDIA_STATE,
  DEFAULT_PARAMS,
  RAPID_TARGET_FORMATS,
  type Hy3dMediaState,
  buildHy3dSubmissionContent,
  buildHy3dGenerateAttachments,
  getHy3dParams,
  getHy3dMissingInputMessage,
  getHy3dSubmissionConflictMessage,
  getHy3dMediaState,
  getHy3dPostProcessModelCompatibility,
  parseHy3dModelInputValue,
  saveHy3dMediaState,
  saveHy3dParams,
  sortHy3dConceptImages
} from './types'

const mediaState: Hy3dMediaState = {
  ...DEFAULT_MEDIA_STATE,
  conceptImages: [
    {
      type: 'image',
      url: 'https://example.com/concept-front.png',
      fileName: 'concept-front.png',
      slot: 'single'
    },
    {
      type: 'image',
      url: 'https://example.com/concept-back.png',
      fileName: 'concept-back.png',
      slot: 'back'
    }
  ],
  textureRefImages: [
    {
      type: 'image',
      url: 'https://example.com/texture.png',
      fileName: 'texture.png',
      slot: 'single'
    },
    {
      type: 'image',
      url: 'https://example.com/texture-left.png',
      fileName: 'left.png',
      slot: 'left'
    }
  ],
  profileRefImage: {
    type: 'image',
    url: 'https://example.com/profile.png',
    fileName: 'profile.png'
  }
}

describe('buildHy3dGenerateAttachments', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('keeps only concept images for concept generation actions', () => {
    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitHunyuanTo3DProJob', mode: 'img2_3d' },
        mediaState
      )
    ).toEqual([
      {
        type: 'image',
        url: 'https://example.com/concept-front.png',
        fileName: 'concept-front.png'
      },
      {
        type: 'image',
        url: 'https://example.com/concept-back.png',
        fileName: 'concept-back.png'
      }
    ])

    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitHunyuanTo3DRapidJob', mode: 'img2_3d' },
        mediaState
      )
    ).toEqual([
      {
        type: 'image',
        url: 'https://example.com/concept-front.png',
        fileName: 'concept-front.png'
      },
      {
        type: 'image',
        url: 'https://example.com/concept-back.png',
        fileName: 'concept-back.png'
      }
    ])
  })

  it('keeps only the profile reference image for profile generation', () => {
    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitProfileTo3DJob', mode: 'img2_3d' },
        mediaState
      )
    ).toEqual([
      {
        type: 'image',
        url: 'https://example.com/profile.png',
        fileName: 'profile.png'
      }
    ])
  })

  it('uses source images and prompt for the Tripo stylized 3D flow', () => {
    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'TripoStylized3DFlow', mode: 'img2_3d' },
        mediaState
      )
    ).toEqual([
      {
        type: 'image',
        url: 'https://example.com/concept-front.png',
        fileName: 'concept-front.png'
      },
      {
        type: 'image',
        url: 'https://example.com/concept-back.png',
        fileName: 'concept-back.png'
      }
    ])

    expect(
      buildHy3dSubmissionContent({
        ...DEFAULT_PARAMS,
        apiAction: 'TripoStylized3DFlow',
        prompt: 'turn it into a clay toy'
      })
    ).toBe('turn it into a clay toy')
    expect(getHy3dMissingInputMessage({ apiAction: 'TripoStylized3DFlow' })).toContain('源图')
  })

  it('keeps texture primary and multiview images for texture generation in stable slot order', () => {
    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitTextureTo3DJob', mode: 'img2_3d' },
        mediaState
      )
    ).toEqual([
      {
        type: 'image',
        url: 'https://example.com/texture.png',
        fileName: 'texture.png'
      },
      {
        type: 'image',
        url: 'https://example.com/texture-left.png',
        fileName: 'left.png'
      }
    ])
  })

  it('does not leak images into model-only post-processing actions', () => {
    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitHunyuan3DPartJob', mode: 'img2_3d' },
        mediaState
      )
    ).toEqual([])
    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitReduceFaceJob', mode: 'img2_3d' },
        mediaState
      )
    ).toEqual([])
    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitHunyuanTo3DUVJob', mode: 'img2_3d' },
        mediaState
      )
    ).toEqual([])
    expect(
      buildHy3dGenerateAttachments({ apiAction: 'Convert3DFormat', mode: 'img2_3d' }, mediaState)
    ).toEqual([])
  })

  it('keeps single/front concept images ahead of extra multiview slots', () => {
    const unorderedConceptImages: Hy3dMediaState['conceptImages'] = [
      {
        type: 'image',
        url: 'https://example.com/concept-back.png',
        fileName: 'back.png',
        slot: 'back'
      },
      {
        type: 'image',
        url: 'https://example.com/concept-front.png',
        fileName: 'front.png',
        slot: 'front'
      },
      {
        type: 'image',
        url: 'https://example.com/concept-left.png',
        fileName: 'left.png',
        slot: 'left'
      }
    ]

    expect(sortHy3dConceptImages(unorderedConceptImages).map((item) => item.slot)).toEqual([
      'front',
      'left',
      'back'
    ])

    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitHunyuanTo3DProJob', mode: 'img2_3d' },
        { ...DEFAULT_MEDIA_STATE, conceptImages: unorderedConceptImages }
      ).map((item) => item.fileName)
    ).toEqual(['front.png', 'left.png', 'back.png'])
  })

  it('ignores hidden concept images when the user is in text-to-3d mode', () => {
    expect(
      buildHy3dGenerateAttachments(
        { apiAction: 'SubmitHunyuanTo3DProJob', mode: 'text2_3d' },
        mediaState
      )
    ).toEqual([])
  })

  it('only submits the visible concept prompt for text-to-3d mode', () => {
    expect(
      buildHy3dSubmissionContent({
        ...DEFAULT_PARAMS,
        apiAction: 'SubmitHunyuanTo3DProJob',
        mode: 'text2_3d',
        prompt: 'stylized desk lamp'
      })
    ).toBe('stylized desk lamp')

    expect(
      buildHy3dSubmissionContent({
        ...DEFAULT_PARAMS,
        apiAction: 'SubmitHunyuanTo3DProJob',
        mode: 'img2_3d',
        prompt: 'stale hidden prompt'
      })
    ).toBe('')
  })

  it('reports invalid prompt and image mixes before submission', () => {
    expect(
      getHy3dSubmissionConflictMessage(
        { ...DEFAULT_PARAMS, apiAction: 'SubmitHunyuanTo3DProJob', generateType: 'Normal' },
        'desk lamp',
        1
      )
    ).toContain('草图模式')

    expect(
      getHy3dSubmissionConflictMessage(
        { ...DEFAULT_PARAMS, apiAction: 'SubmitHunyuanTo3DProJob', generateType: 'Sketch' },
        'desk lamp',
        1
      )
    ).toBeNull()

    expect(
      getHy3dSubmissionConflictMessage(
        { ...DEFAULT_PARAMS, apiAction: 'SubmitHunyuanTo3DRapidJob', generateType: 'Normal' },
        'desk lamp',
        1
      )
    ).toContain('极速版')
  })

  it('returns user-facing missing-input guidance for concept generation', () => {
    expect(getHy3dMissingInputMessage({ apiAction: 'SubmitHunyuanTo3DProJob' })).toContain('提示词')
  })

  it('restores Hunyuan media state from session storage for the current renderer session', () => {
    const storedMediaState: Hy3dMediaState = {
      conceptImages: [
        {
          type: 'image',
          url: 'https://example.com/front.png',
          fileName: 'front.png',
          slot: 'single'
        }
      ],
      textureRefImages: [
        {
          type: 'image',
          url: 'https://example.com/texture.png',
          fileName: 'texture.png',
          slot: 'single'
        }
      ],
      profileRefImage: {
        type: 'image',
        url: 'https://example.com/profile.png',
        fileName: 'profile.png'
      }
    }

    saveHy3dMediaState(storedMediaState)

    expect(getHy3dMediaState()).toEqual(storedMediaState)
  })

  it('upgrades legacy single textureRefImage session state into textureRefImages', () => {
    sessionStorage.setItem(
      'hy3d.media',
      JSON.stringify({
        conceptImages: [],
        textureRefImage: {
          type: 'image',
          url: 'https://example.com/legacy-texture.png',
          fileName: 'legacy-texture.png'
        },
        profileRefImage: null
      })
    )

    expect(getHy3dMediaState()).toEqual({
      conceptImages: [],
      textureRefImages: [
        {
          type: 'image',
          url: 'https://example.com/legacy-texture.png',
          fileName: 'legacy-texture.png'
        }
      ],
      profileRefImage: null
    })
  })

  it('normalizes removed 3K face-count presets to the lowest visible preset', () => {
    localStorage.setItem('hy3d.params', JSON.stringify({ ...DEFAULT_PARAMS, faceCount: 3000 }))

    expect(getHy3dParams().faceCount).toBe(50000)

    saveHy3dParams({ ...DEFAULT_PARAMS, faceCount: 3000 })

    expect(JSON.parse(localStorage.getItem('hy3d.params') || '{}').faceCount).toBe(50000)
  })
})

describe('getHy3dPostProcessModelCompatibility', () => {
  it('extracts a signed url and source file hint when the user pastes a markdown model link', () => {
    expect(
      parseHy3dModelInputValue(
        '[Generated OBJ Package.zip](https://example.com/download?id=obj-package-1)'
      )
    ).toEqual({
      modelUrl: 'https://example.com/download?id=obj-package-1',
      modelSourceFileName: 'Generated OBJ Package.zip'
    })
  })

  it('treats matching source file name hints as compatible for extensionless signed urls', () => {
    expect(
      getHy3dPostProcessModelCompatibility('SubmitTextureTo3DJob', {
        ...DEFAULT_PARAMS,
        modelUrl: 'https://example.com/download?id=obj-1',
        modelSourceFileName: 'Generated OBJ Package.zip'
      })
    ).toEqual({
      status: 'compatible',
      inferredFormat: 'OBJ',
      acceptedFormats: ['OBJ', 'GLB']
    })
  })

  it('treats filename query hints on extensionless urls as compatible even without a separate source file name', () => {
    expect(
      getHy3dPostProcessModelCompatibility('Convert3DFormat', {
        ...DEFAULT_PARAMS,
        modelUrl: 'https://example.com/download?id=mesh-2&filename=generated-rig.fbx',
        modelSourceFileName: ''
      })
    ).toEqual({
      status: 'compatible',
      inferredFormat: 'FBX',
      acceptedFormats: ['FBX', 'OBJ', 'GLB']
    })
  })

  it('marks clearly incompatible carried-over model formats as invalid for the next action', () => {
    expect(
      getHy3dPostProcessModelCompatibility('SubmitReduceFaceJob', {
        ...DEFAULT_PARAMS,
        modelUrl: 'https://example.com/download?id=fbx-1',
        modelSourceFileName: 'character-rig.fbx'
      })
    ).toEqual({
      status: 'incompatible',
      inferredFormat: 'FBX',
      acceptedFormats: ['OBJ', 'GLB']
    })
  })

  it('keeps unknown extensionless urls submittable when no file-type hint is available', () => {
    expect(
      getHy3dPostProcessModelCompatibility('Convert3DFormat', {
        ...DEFAULT_PARAMS,
        modelUrl: 'https://example.com/download?id=opaque-model',
        modelSourceFileName: ''
      })
    ).toEqual({
      status: 'unknown',
      inferredFormat: '',
      acceptedFormats: ['FBX', 'OBJ', 'GLB']
    })
  })
})

describe('hy3d format labels', () => {
  it('marks MP4/GIF outputs as preview media instead of model formats', () => {
    expect(RAPID_TARGET_FORMATS.find((item) => item.value === 'MP4')?.label).toBe('MP4 转台视频')
    expect(CONVERT_TARGET_FORMATS.find((item) => item.value === 'MP4')?.label).toBe('MP4 转台视频')
    expect(CONVERT_TARGET_FORMATS.find((item) => item.value === 'GIF')?.label).toBe('GIF 预览动图')
  })
})
