import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ConvertPanel from './ConvertPanel'
import TopologyPanel from './TopologyPanel'
import TripoTaskPanel from './TripoTaskPanel'
import UVPanel from './UVPanel'
import { DEFAULT_MEDIA_STATE, DEFAULT_PARAMS } from './types'

vi.mock('./ModelDropZone', () => ({
  default: () => <div>ModelDropZone</div>
}))

describe('Hunyuan3D post-process panels', () => {
  it('disables topology submit when the current model hint is clearly incompatible', () => {
    render(
      <TopologyPanel
        params={{
          ...DEFAULT_PARAMS,
          apiAction: 'SubmitReduceFaceJob',
          modelUrl: 'https://example.com/download?id=fbx-1',
          modelSourceFileName: 'character-rig.fbx'
        }}
        onParamsChange={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '开始优化' })).toBeDisabled()
    expect(screen.getByText(/当前模型格式看起来是 FBX/)).toBeTruthy()
  })

  it('keeps convert submit enabled for extensionless urls when the format is still unknown', () => {
    render(
      <ConvertPanel
        params={{
          ...DEFAULT_PARAMS,
          apiAction: 'Convert3DFormat',
          modelUrl: 'https://example.com/download?id=opaque-model',
          modelSourceFileName: ''
        }}
        onParamsChange={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '开始转换' })).not.toBeDisabled()
    expect(screen.queryByText(/当前模型格式看起来是/)).toBeNull()
  })

  it('shows the face-level help tooltip for topology settings', async () => {
    render(
      <TopologyPanel
        params={{
          ...DEFAULT_PARAMS,
          apiAction: 'SubmitReduceFaceJob'
        }}
        onParamsChange={vi.fn()}
      />
    )

    fireEvent.mouseOver(screen.getByLabelText('目标面数等级说明'))

    expect(await screen.findByRole('tooltip')).toHaveTextContent(/low\s*\/\s*medium\s*\/\s*high/i)
  })

  it('shows UV format constraints and the GLB fallback hint for GLB inputs', () => {
    render(
      <UVPanel
        params={{
          ...DEFAULT_PARAMS,
          apiAction: 'SubmitHunyuanTo3DUVJob',
          modelUrl: 'https://example.com/models/robot.glb',
          modelSourceFileName: 'robot.glb'
        }}
        onParamsChange={vi.fn()}
      />
    )

    expect(screen.getByText(/30000 faces/i)).toBeTruthy()
    expect(screen.getByText(/GLB[\s\S]*FBX/i)).toBeTruthy()
  })

  it('does not show a Tripo task-id field for first-step generation tasks', () => {
    render(
      <TripoTaskPanel
        params={{
          ...DEFAULT_PARAMS,
          apiAction: 'TripoTextToImage'
        }}
        mediaState={DEFAULT_MEDIA_STATE}
        onParamsChange={vi.fn()}
        onMediaStateChange={vi.fn()}
      />
    )

    expect(screen.queryByText('上一轮 Tripo 任务 ID')).toBeNull()
    expect(screen.queryByText('模型 file token / URL')).toBeNull()
  })

  it('labels Tripo post-process task ids as prior task references', () => {
    render(
      <TripoTaskPanel
        params={{
          ...DEFAULT_PARAMS,
          apiAction: 'TripoPreRigCheck'
        }}
        mediaState={DEFAULT_MEDIA_STATE}
        onParamsChange={vi.fn()}
        onMediaStateChange={vi.fn()}
      />
    )

    expect(screen.getByText('上一轮 Tripo 任务 ID')).toBeTruthy()
    expect(screen.getByText(/不是 API Key/)).toBeTruthy()
    expect(screen.queryByText('模型 URL / 备注')).toBeNull()
    expect(screen.getByRole('button', { name: '开始预检' })).toBeDisabled()
  })
})
