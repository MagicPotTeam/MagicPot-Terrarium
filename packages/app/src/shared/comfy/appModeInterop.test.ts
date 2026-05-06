import { describe, expect, it } from 'vitest'
import { buildQAppCfgFromAppMode } from './appModeInterop'
import type { ObjectInfoMap, Workflow, WorkflowInputRef } from './types'

describe('buildQAppCfgFromAppMode', () => {
  it('maps video upload fields to InputComfyVideo', () => {
    const gui = {
      nodes: [
        {
          id: 1,
          type: 'VideoLoader',
          title: 'Video Loader',
          inputs: [],
          outputs: [],
          widgets_values: ['clip.mp4']
        }
      ],
      links: [],
      extra: {
        linearData: {
          inputs: [[1, 'video']],
          outputs: [1]
        }
      }
    }

    const workflow: Workflow = {
      '1': {
        class_type: 'VideoLoader',
        inputs: {
          video: 'clip.mp4'
        }
      }
    }

    const objectInfos: ObjectInfoMap = {
      VideoLoader: {
        input: {
          required: {
            video: [
              'STRING',
              {
                accept: 'video/*',
                video_upload: true
              }
            ]
          }
        },
        output: []
      }
    }

    const result = buildQAppCfgFromAppMode(gui, workflow, objectInfos)

    expect(result).not.toBeNull()
    expect(result?.cfg.outputNodeIds).toEqual(['1'])
    expect(result?.cfg.inputs).toEqual([
      {
        label: 'Video Loader',
        component: 'InputComfyVideo',
        slot: '$.1.inputs.video'
      }
    ])
    expect(result?.warnings).toEqual([])
  })

  it.each([
    {
      title: 'maps media_type video metadata to InputComfyVideo',
      fieldCfg: {
        media_type: 'video'
      }
    },
    {
      title: 'maps file_type video metadata to InputComfyVideo',
      fieldCfg: {
        file_type: ['video']
      }
    },
    {
      title: 'maps accept video metadata to InputComfyVideo',
      fieldCfg: {
        accept: 'video/*'
      }
    }
  ])('$title', ({ fieldCfg }) => {
    const gui = {
      nodes: [
        {
          id: 1,
          type: 'MediaLoader',
          title: 'Media Loader',
          inputs: [],
          outputs: []
        }
      ],
      links: [],
      extra: {
        linearData: {
          inputs: [[1, 'media_video']],
          outputs: [1]
        }
      }
    }

    const workflow: Workflow = {
      '1': {
        class_type: 'MediaLoader',
        inputs: {
          media_video: ['2', 0] as WorkflowInputRef
        }
      }
    }

    const objectInfos: ObjectInfoMap = {
      MediaLoader: {
        input: {
          required: {
            media_video: ['STRING', fieldCfg]
          }
        },
        output: []
      }
    }

    const result = buildQAppCfgFromAppMode(gui, workflow, objectInfos)

    expect(result).not.toBeNull()
    expect(result?.cfg.inputs).toEqual([
      {
        label: 'Media Loader',
        component: 'InputComfyVideo',
        slot: '$.1.inputs.media_video'
      }
    ])
  })
})
