import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseDeferredComfyFileInputValue } from '@shared/comfy/deferredImages'
import { runCanvasTargetQuickAppAction } from './canvasTargetQuickAppRuntime'

const fsMocks = vi.hoisted(() => ({
  saveQAppInputImage: vi.fn()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcFs: {
      saveQAppInputImage: fsMocks.saveQAppInputImage
    }
  })
}))

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
      return new Response(null, { status: 404 })
    }
    return new Response(Uint8Array.from(bytes), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })
  })

const createQuickAppApi = () => {
  const submitWorkflow = vi.fn(
    async (_request: { prompt: Record<string, { inputs: Record<string, string> }> }) => ({
      prompt_id: 'prompt-1'
    })
  )

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
              class_type: 'LoadImage',
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
        submitWorkflow
      }
    },
    submitWorkflow
  }
}

describe('canvasTargetQuickAppRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    fsMocks.saveQAppInputImage.mockReset()
    fsMocks.saveQAppInputImage.mockResolvedValue({
      success: true,
      fullPath: 'C:/cache/stage-output.png',
      filename: 'stage-output.png'
    })
  })

  it('submits resolved stage media as a deferred image value without pre-lease upload', async () => {
    const fetchMock = createImageFetch({
      'blob://source-original': [1, 2, 3],
      'blob://stage-output': [9, 8, 7]
    })
    vi.stubGlobal('fetch', fetchMock)
    const { api, submitWorkflow } = createQuickAppApi()

    await runCanvasTargetQuickAppAction({
      action: {
        type: 'quick_app',
        id: 'run-rembg',
        qAppKey: 'rembg',
        phase: 'after_model_stages',
        outputTarget: 'agent',
        inputAssignments: [{ sourceStageId: 'stage-element-split' }]
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
            fileName: 'stage-output.png',
            mimeType: 'image/png'
          }
        ]
      ]
    })

    expect(fetchMock).toHaveBeenCalledWith('blob://stage-output')
    expect(fetchMock).not.toHaveBeenCalledWith('blob://source-original')
    const submittedRequest = submitWorkflow.mock.calls[0]?.[0] as
      { prompt: Record<string, { inputs: Record<string, string> }> } | undefined
    const submittedValue = submittedRequest?.prompt['1']?.inputs.image
    expect(parseDeferredComfyFileInputValue(submittedValue)).toMatchObject({
      fileName: 'stage-output.png',
      mimeType: 'image/png',
      filePath: 'C:/cache/stage-output.png'
    })
  })

  it('does not fall back to the original source image when explicit references are unresolved', async () => {
    const fetchMock = createImageFetch({
      'blob://source-original': [1, 2, 3]
    })
    vi.stubGlobal('fetch', fetchMock)
    const { api, submitWorkflow } = createQuickAppApi()

    await expect(
      runCanvasTargetQuickAppAction({
        action: {
          type: 'quick_app',
          id: 'run-rembg',
          qAppKey: 'rembg',
          phase: 'after_model_stages',
          outputTarget: 'agent',
          inputAssignments: [{ sourceStageId: 'stage-element-split' }]
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
    expect(submitWorkflow).not.toHaveBeenCalled()
  })
})
