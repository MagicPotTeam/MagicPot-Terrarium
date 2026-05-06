import { beforeEach, describe, expect, it, vi } from 'vitest'

import { runCanvasTargetQuickAppAction } from './canvasTargetQuickAppRuntime'

vi.mock('../QuickAppPage/ResultList/resultTransformers', () => ({
  transformResults: vi.fn(async () => [])
}))

vi.mock('../QuickAppPage/utils/qAppCanvasDispatch', () => ({
  dispatchQAppResultsToCanvas: vi.fn(() => ({ totalCount: 0 }))
}))

vi.mock('../QuickAppPage/utils/qAppPromptResult', () => ({
  waitForQAppPromptResult: vi.fn(async () => ({
    status: {
      status_str: 'success',
      messages: []
    }
  }))
}))

const createImageFetch = (bytesByUrl: Record<string, number[]>) =>
  vi.fn(async (url: string) => {
    const bytes = bytesByUrl[url]
    if (!bytes) {
      return {
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0)
      }
    }
    return {
      ok: true,
      arrayBuffer: async () => Uint8Array.from(bytes).buffer
    }
  })

const createQuickAppApi = () => {
  const uploadImage = vi.fn(
    async ({ fileItem }: { fileItem: { filename: string }; image: Uint8Array }) => ({
      filename: fileItem.filename,
      subfolder: '',
      type: 'input'
    })
  )
  const submitWorkflow = vi.fn(async () => ({ prompt_id: 'prompt-1' }))

  return {
    api: {
      svcQApp: {
        getQAppCfg: vi.fn(async () => ({
          cfg: {
            inputs: [
              {
                component: 'InputComfyImage',
                label: 'image',
                slot: '1.inputs.image'
              }
            ],
            autoInputs: [],
            outputNodeIds: []
          },
          workflow: {
            '1': {
              inputs: {
                image: ''
              }
            }
          },
          manifest: {
            name: 'Rembg'
          }
        }))
      },
      svcComfy: {
        uploadImage,
        submitWorkflow
      }
    },
    uploadImage,
    submitWorkflow
  }
}

describe('canvasTargetQuickAppRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses resolved explicit stage media for QuickApp image input instead of the original source image', async () => {
    const fetchMock = createImageFetch({
      'blob://source-original': [1, 2, 3],
      'blob://stage-output': [9, 8, 7]
    })
    vi.stubGlobal('fetch', fetchMock)
    const { api, uploadImage } = createQuickAppApi()

    await runCanvasTargetQuickAppAction({
      action: {
        type: 'quick_app',
        id: 'run-rembg',
        qAppKey: 'rembg',
        phase: 'after_model_stages',
        outputTarget: 'agent',
        inputAssignments: [
          {
            sourceStageId: 'stage-element-split'
          }
        ]
      },
      api: api as never,
      config: {} as never,
      userIntent: 'remove background',
      sourceAttachments: [
        {
          type: 'image',
          url: 'blob://source-original',
          fileName: 'source.png'
        }
      ],
      resolvedInputAssignmentAttachments: [
        [
          {
            type: 'image',
            url: 'blob://stage-output',
            fileName: 'stage-output.png'
          }
        ]
      ]
    })

    expect(fetchMock).toHaveBeenCalledWith('blob://stage-output')
    expect(fetchMock).not.toHaveBeenCalledWith('blob://source-original')
    expect(Array.from(uploadImage.mock.calls[0][0].image)).toEqual([9, 8, 7])
  })

  it('does not fall back to the original source image when explicit QuickApp references are unresolved', async () => {
    const fetchMock = createImageFetch({
      'blob://source-original': [1, 2, 3]
    })
    vi.stubGlobal('fetch', fetchMock)
    const { api, uploadImage, submitWorkflow } = createQuickAppApi()

    await expect(
      runCanvasTargetQuickAppAction({
        action: {
          type: 'quick_app',
          id: 'run-rembg',
          qAppKey: 'rembg',
          phase: 'after_model_stages',
          outputTarget: 'agent',
          inputAssignments: [
            {
              sourceStageId: 'stage-element-split'
            }
          ]
        },
        api: api as never,
        config: {} as never,
        userIntent: 'remove background',
        sourceAttachments: [
          {
            type: 'image',
            url: 'blob://source-original',
            fileName: 'source.png'
          }
        ]
      })
    ).rejects.toThrow(/sourceStageId=stage-element-split.*no matching image attachment/)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(uploadImage).not.toHaveBeenCalled()
    expect(submitWorkflow).not.toHaveBeenCalled()
  })
})
